export function terminalPage(base: string, recovery = false): string {
  base = base.replaceAll("&", "&amp;").replaceAll(String.fromCharCode(34), "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentBot Terminal</title><link rel="stylesheet" href="${base}/assets/xterm.css"><link rel="stylesheet" href="${base}/assets/terminal.css">
<script defer src="${base}/assets/xterm.js"></script><script defer src="${base}/assets/fit.js"></script><script defer src="${base}/assets/terminal.js"></script></head>
<body data-base="${base}" data-recovery="${recovery}"><header><strong>AgentBot <span>Terminal</span></strong><div id="status" role="status">尚未连接</div><button id="connect">请求连接</button><button id="interrupt" disabled>Ctrl+C</button><button id="close" disabled>关闭终端</button></header>
<section id="welcome"><h1>在浏览器中使用本机终端</h1><p>命令在 AgentBot 所在电脑上执行，拥有其系统用户权限。不会自动执行或接管原卡片中的命令。</p><p>点击请求连接，然后返回命令所在的飞书会话或话题，由 AgentBot 所有者核对验证码并授权。不要批准非本人发起的请求。</p><button id="welcome-connect" type="button">请求连接</button><p id="code"></p></section><div id="terminal"></div>
<footer id="details">前台连接时不因空闲关闭；后台空闲 30 分钟或网页断开 3 分钟后自动关闭 Shell · 成功重连取消断开计时并重置空闲计时 · 可从原会话的终端管理卡打开或关闭终端</footer></body></html>`;
}

export const TERMINAL_CSS = `
#welcome-connect{padding:10px 20px;font:inherit}
:root{color-scheme:dark;font:14px system-ui,sans-serif;background:#10141b;color:#dbe4f1}*{box-sizing:border-box}body{margin:0;height:100dvh;display:flex;flex-direction:column}header{display:flex;gap:12px;align-items:center;padding:12px 18px;background:#191f2b;border-bottom:1px solid #303a4d;flex-wrap:wrap}header strong{font-size:17px}header strong span{font-weight:400;color:#9aacc7}#status{flex:1;color:#adbfdb;font-size:13px}button{background:#25334a;border:1px solid #415775;border-radius:7px;padding:8px 12px;color:#e5efff;cursor:pointer}button:hover{background:#304661}button:disabled{opacity:.45;cursor:default}#close{border-color:#86505a}#welcome{margin:40px auto;max-width:780px;padding:0 24px;line-height:1.8}h1{font-size:25px}#code{font-size:24px;letter-spacing:3px;color:#84c1ff}#terminal{flex:1;min-height:0;padding:12px 14px;display:none}.xterm{height:100%}footer{font-size:12px;color:#8f9eb7;padding:9px 18px;border-top:1px solid #293142}body.connected #welcome{display:none}body.connected #terminal{display:block}@media(max-width:650px){header{padding:10px;gap:8px}#status{min-width:100%}footer{padding:7px 10px}#terminal{padding:6px}}
`;

export const TERMINAL_SCRIPT = String.raw`(() => {
  const base = document.body.dataset.base;
  const status = document.getElementById('status');
  const connect = document.getElementById('connect');
  const welcomeConnect = document.getElementById('welcome-connect');
  const close = document.getElementById('close');
  const interrupt = document.getElementById('interrupt');
  const storageKey = 'agentbot-terminal:' + location.pathname;
  const recovery = document.body.dataset.recovery === 'true';
  if (recovery) document.querySelector('#welcome h1').textContent = '恢复已有终端';
  let session, ws, term, observer, retryTimer, socketTimer, checking, visibilityTimer;
  let socketReady = false;
  let epoch = 0, failures = 0, stopped = false, pageHidden = false, offline = false, busy = false;
  try { session = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch {}
  const awake = () => !pageHidden && !document.hidden && !offline;
  const post = async (route, data, controller = new AbortController()) => {
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(base + '/api/' + route, { method:'POST', credentials:'omit', cache:'no-store',
        signal:controller.signal, headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
      let value;
      try { value = await response.json(); } catch {
        throw Object.assign(new Error('服务返回了非 JSON 响应'), {httpStatus:response.status});
      }
      if (!response.ok) throw Object.assign(new Error(value.error || '请求失败'), {httpStatus:response.status});
      return value;
    } finally { clearTimeout(timer); }
  };
  function message(error) {
    if (error?.name === 'AbortError') return '请求超时';
    if (!error?.httpStatus && (error?.name === 'TypeError' || error?.message === 'Failed to fetch')) return '网络暂时不可用';
    return error?.message || String(error);
  }
  function buttons(retry = false) {
    for (const button of [connect, welcomeConnect]) {
      button.textContent = session ? '重新连接' : recovery ? '请求恢复连接' : '请求连接';
      button.disabled = busy || (!!session && !retry);
    }
    close.disabled = busy || !session;
  }
  function invalidate() {
    epoch++; clearTimeout(retryTimer); clearTimeout(socketTimer);
    clearTimeout(visibilityTimer); socketReady = false;
    checking?.abort(); checking = undefined;
    const old = ws; ws = undefined; old?.close(); interrupt.disabled = true;
    if (term) term.options.disableStdin = true;
  }
  function forget() {
    session = undefined; sessionStorage.removeItem(storageKey);
    document.getElementById('code').textContent = ''; buttons(true);
  }
  function end(text) { stopped = true; invalidate(); forget(); status.textContent = text; }
  function fail(text) { stopped = true; invalidate(); status.textContent = text; buttons(true); }
  function schedule(delay) {
    clearTimeout(retryTimer);
    if (!stopped && awake() && session) retryTimer = setTimeout(check, delay);
  }
  function retry(stage, error) {
    if (stopped || !session) return;
    const seconds = Math.min(10, Math.pow(2, Math.min(failures++, 4)));
    status.textContent = stage + '：' + message(error) + '，' + seconds + ' 秒后自动重试';
    buttons(true); schedule(seconds * 1000);
  }
  function sendSize(cols, rows) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'resize',cols:Math.max(2,Math.min(500,cols)),rows:Math.max(2,Math.min(200,rows))}));
  }
  function reportVisibility() {
    clearTimeout(visibilityTimer);
    if (stopped || !socketReady || ws?.readyState !== WebSocket.OPEN) return;
    const foreground = awake();
    ws.send(JSON.stringify({type:'visibility',foreground}));
    if (foreground) visibilityTimer = setTimeout(reportVisibility, 30000);
  }
  function openSocket() {
    if (stopped || !awake() || ws || !session) return;
    const current = session, generation = epoch;
    const url = new URL(base + '/socket', location.origin); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;
    try { socket = new WebSocket(url); } catch (error) { retry('WebSocket 连接失败', error); return; }
    ws = socket; status.textContent = '授权已通过，正在连接终端…'; buttons();
    const valid = () => ws === socket && generation === epoch && session === current && !stopped;
    socketTimer = setTimeout(() => {
      if (!valid()) return;
      invalidate(); retry('WebSocket 连接超时', new Error('请检查网络是否支持 WebSocket'));
    }, 15000);
    socket.onopen = () => { if (valid()) socket.send(JSON.stringify({type:'auth',requestId:current.requestId,browserKey:current.browserKey})); };
    socket.onmessage = (event) => {
      if (!valid()) return;
      try {
        const result = JSON.parse(event.data);
        if (result.type === 'ready') {
          clearTimeout(socketTimer);
          socketReady = true; reportVisibility();
          document.body.classList.add('connected');
          observer?.disconnect(); term?.dispose();
          const terminal = new Terminal({cursorBlink:true,fontSize:14,scrollback:5000,disableStdin:result.replay === true,theme:{background:'#10141b'}});
          term = terminal;
          const active = () => valid() && term === terminal;
          terminal.attachCustomKeyEventHandler((event) => {
            if (event.altKey || event.shiftKey || event.ctrlKey === event.metaKey) return true;
            const key = event.key.toLowerCase();
            // Let the browser dispatch native clipboard events, including on HTTP.
            // xterm handles the selected text and bracketed paste without sending ^C/^V.
            return !(key === 'v' || (key === 'c' && terminal.hasSelection()));
          });
          const fit = new FitAddon.FitAddon(); terminal.loadAddon(fit); terminal.open(document.getElementById('terminal'));
          terminal.onData((data) => {
            if (active() && !terminal.options.disableStdin && socket.readyState === WebSocket.OPEN) for (let i=0; i<data.length; i+=4096) socket.send(JSON.stringify({type:'input',data:data.slice(i,i+4096)}));
          });
          terminal.onResize(({cols,rows}) => { if (active()) sendSize(cols,rows); });
          observer = new ResizeObserver(() => { if (active()) fit.fit(); });
          observer.observe(document.getElementById('terminal'));
          fit.fit(); sendSize(terminal.cols,terminal.rows); failures = 0; interrupt.disabled = true;
          status.textContent = '正在恢复终端画面…';
          const restored = () => {
            if (!active()) return;
            terminal.options.disableStdin = false; terminal.focus();
            status.textContent = '已连接 · ' + result.cwd; interrupt.disabled = false; buttons();
          };
          // xterm parses asynchronously. Keep replay silent until its write callback,
          // before subsequently queued live output is parsed. Startup output is live.
          if (result.output) terminal.write(result.output, restored); else restored();
        } else if (result.type === 'data') term?.write(result.data);
        else if (result.type === 'exit') end(result.message || '终端已结束');
        else if (result.type === 'error') fail((result.stage === 'spawn' ? 'Shell 启动失败：' : '终端连接被拒绝：') + result.message);
      } catch (error) { fail('终端界面初始化或消息处理失败：' + message(error)); }
    };
    socket.onclose = (event) => {
      if (!valid()) return;
      if (event.reason === 'Reconnected from another page') { fail('该终端已在另一页面连接，点击重新连接可恢复。'); return; }
      invalidate(); retry('WebSocket 已断开', new Error('连接关闭' + (event.code ? '（' + event.code + '）' : '')));
    };
    socket.onerror = () => {
      if (!valid()) return;
      invalidate(); retry('WebSocket 连接失败', new Error('请检查网络是否支持 WebSocket'));
    };
  }
  async function check() {
    if (stopped || !awake() || !session || checking || ws || busy) return;
    clearTimeout(retryTimer);
    const current = session, generation = epoch, controller = new AbortController(); checking = controller;
    try {
      const result = await post('status', current, controller);
      if (generation !== epoch || current !== session || stopped || !awake()) return;
      if (result.state === 'approved' || result.state === 'running') openSocket();
      else if (result.state === 'pending') { failures = 0; status.textContent = '等待原会话中的所有者授权'; buttons(); schedule(1500); }
      else end(result.message || '授权已失效，请重新请求连接');
    } catch (error) {
      if (generation !== epoch || current !== session || stopped || !awake()) return;
      if ([400,401,404,410].includes(error.httpStatus)) end('授权状态查询失败：' + message(error) + '。请重新请求连接。');
      else if (error.httpStatus === 403) fail('授权状态查询被拒绝：' + message(error));
      else retry('暂时无法查询授权状态', error);
    } finally { if (checking === controller) checking = undefined; }
  }
  connect.onclick = welcomeConnect.onclick = async () => {
    if (busy) return;
    stopped = false; failures = 0; invalidate();
    if (session) { status.textContent = '正在恢复已有终端授权…'; buttons(); check(); return; }
    busy = true; buttons(); status.textContent = '正在请求飞书授权…';
    try {
      document.body.classList.remove('connected');
      if (!globalThis.crypto?.getRandomValues) throw new Error('浏览器不支持安全随机数，请使用新版浏览器。');
      const browserKey = Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) => n.toString(16).padStart(2,'0')).join('');
      const result = await post('request', {launch:location.pathname,browserKey});
      session = {requestId:result.requestId,browserKey,code:result.code}; sessionStorage.setItem(storageKey,JSON.stringify(session));
      document.getElementById('code').textContent = '验证码：' + result.code;
      status.textContent = awake() ? '等待原会话中的所有者授权' : '返回网页后将自动查询授权状态';
    } catch (error) { status.textContent = '请求授权失败：' + message(error); }
    finally { busy = false; buttons(!session); }
    check();
  };
  interrupt.onclick = () => { if (ws?.readyState === WebSocket.OPEN && !interrupt.disabled) ws.send(JSON.stringify({type:'input',data:String.fromCharCode(3)})); };
  close.onclick = async () => {
    if (busy || !session || !confirm('关闭该终端和 Shell？已脱离终端的后台进程可能继续运行。')) return;
    busy = true; stopped = true; invalidate(); buttons();
    try { await post('close',session); end('终端已关闭'); }
    catch (error) {
      if ([400,401,404,410].includes(error.httpStatus)) end('终端已失效或结束');
      else status.textContent = '关闭请求失败：' + message(error) + '；未确认关闭，请重试';
    } finally { busy = false; buttons(true); }
  };
  function suspend() {
    invalidate();
    if (session && !stopped) { status.textContent = '连接已暂停，返回网页或网络恢复后自动重连'; buttons(true); }
  }
  function resume() {
    if (stopped || !awake() || busy || !session) return;
    clearTimeout(retryTimer); check();
  }
  window.addEventListener('pagehide', () => { pageHidden = true; suspend(); });
  window.addEventListener('pageshow', () => { pageHidden = false; resume(); });
  document.addEventListener('visibilitychange', () => { reportVisibility(); if (document.hidden) { if (!ws) suspend(); } else resume(); });
  window.addEventListener('offline', () => { offline = true; suspend(); });
  window.addEventListener('online', () => { offline = false; resume(); });
  window.addEventListener('focus', resume);
  if (session?.code) document.getElementById('code').textContent = '验证码：' + session.code;
  buttons(); check();
})();`;
