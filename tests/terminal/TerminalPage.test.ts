import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { afterEach, expect, test, vi } from "vitest";
import { terminalPage, TERMINAL_SCRIPT } from "../../src/terminal/TerminalPage.js";

const { Terminal: Xterm } = createRequire(import.meta.url)("@xterm/xterm") as typeof import("@xterm/xterm");
const terminals: InstanceType<typeof Xterm>[] = [];
afterEach(() => { for (const term of terminals.splice(0)) term.dispose(); vi.useRealTimers(); });

function page(saved = false, origin = "https://preview.example", pathname = "/proxy/terminal/A7k2M9qR", recovery = false) {
  const base = "/proxy/terminal";
  const { document } = parseHTML(terminalPage(base, recovery));
  const windowEvents = new Map<string, () => void>();
  const documentEvents = new Map<string, () => void>();
  document.addEventListener = ((name: string, listener: () => void) => { documentEvents.set(name, listener); }) as typeof document.addEventListener;
  const stored = new Map<string, string>();
  const key = "agentbot-terminal:" + pathname;
  if (saved) stored.set(key, JSON.stringify({ requestId: "saved", browserKey: "a".repeat(64) }));
  const sessionStorage = { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) };
  const fetch = vi.fn(async (url: string, _options?: RequestInit) => ({ ok: true, json: async () => url.endsWith("/request")
    ? { requestId: "request", code: "123456" } : { state: "approved" } }));
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1; readyState = 1; send = vi.fn(); close = vi.fn();
    onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: (event: { reason?: string; code?: number }) => void;
    constructor(readonly url: URL) { sockets.push(this); }
    receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  let onInput!: (data: string) => void; let onResize!: (size: { cols: number; rows: number }) => void;
  const write = vi.fn(); const reset = vi.fn();
  const instances: InstanceType<typeof Xterm>[] = [];
  const keyHandlers: Array<(event: KeyboardEvent) => boolean> = [];
  let selection = "";
  class Terminal {
    cols = 100; rows = 30; reset = reset;
    readonly emulator: InstanceType<typeof Xterm>;
    constructor(options: ConstructorParameters<typeof Xterm>[0]) {
      this.emulator = new Xterm(options); terminals.push(this.emulator); instances.push(this.emulator);
    }
    get options() { return this.emulator.options; }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { keyHandlers.push(handler); }
    hasSelection() { return selection.length > 0; }
    write(data: string, callback?: () => void) { write(data); this.emulator.write(data, callback); }
    dispose() { this.emulator.dispose(); }
    loadAddon() {} open() {} focus() {}
    onData(listener: typeof onInput) { onInput = listener; this.emulator.onData(listener); }
    onResize(listener: typeof onResize) { onResize = listener; }
  }
  runInNewContext(TERMINAL_SCRIPT, { document, window: { isSecureContext: origin.startsWith("https:"), addEventListener: (name: string, listener: () => void) => windowEvents.set(name, listener) },
    location: { pathname, origin, protocol: new URL(origin).protocol },
    sessionStorage, crypto: webcrypto, fetch, URL, WebSocket: Socket, Terminal,
    FitAddon: { FitAddon: class { fit() {} } }, ResizeObserver: class { observe() {} disconnect() {} },
    setTimeout, clearTimeout, AbortController, confirm: () => true });
  return { document, fetch, sockets, stored, key, write, reset, instances, keyHandlers, select: (text: string) => { selection = text; },
    input: (data: string) => onInput(data), resize: (cols: number, rows: number) => onResize({ cols, rows }),
    event: (name: string) => windowEvents.get(name)?.(),
    visibility: (hidden: boolean) => { Object.defineProperty(document, "hidden", { configurable: true, value: hidden }); documentEvents.get("visibilitychange")?.(); },
  };
}

test.each(["connect", "welcome-connect"])("%s explicitly requests approval, displays code, streams input and closes independently", async (buttonId) => {
  const f = page();
  expect(f.document.getElementById("details")!.textContent).toContain("网页断开 3 分钟后自动关闭 Shell");
  expect(f.document.getElementById("details")!.textContent).toContain("空闲 30 分钟或网页断开 3 分钟");
  expect(f.fetch).not.toHaveBeenCalled();
  f.document.getElementById(buttonId)!.click();
  await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
  expect(f.document.getElementById("code")!.textContent).toContain("123456");
  const ws = f.sockets[0]!; ws.onopen?.();
  expect(ws.url.toString()).toBe("wss://preview.example/proxy/terminal/socket");
  expect(f.document.getElementById("transport-warning")).toBeNull();
  expect(JSON.parse(ws.send.mock.calls[0]![0] as string)).toMatchObject({ type: "auth", requestId: "request" });
  expect(ws.send.mock.calls.some(([data]) => JSON.parse(data as string).type === "visibility")).toBe(false);
  ws.receive({ type: "ready", cwd: "/tmp" }); ws.receive({ type: "data", data: "hello" });
  expect(f.document.body.classList.contains("connected")).toBe(true);
  expect(f.write).toHaveBeenCalledWith("hello");
  f.input("x".repeat(10_000));
  const inputs = ws.send.mock.calls.map(([data]) => JSON.parse(data as string) as { type: string; data?: string }).filter((f) => f.type === "input");
  expect(inputs.map((f) => f.data).join("")).toHaveLength(10_000);
  expect(inputs.every((f) => f.data!.length <= 4096)).toBe(true);
  f.resize(1, 1000);
  expect(JSON.parse(ws.send.mock.lastCall![0] as string)).toEqual({ type: "resize", cols: 2, rows: 200 });
  f.document.getElementById("interrupt")!.click();
  expect(JSON.parse(ws.send.mock.lastCall![0] as string)).toEqual({ type: "input", data: String.fromCharCode(3) });
  f.document.getElementById("close")!.click();
  await vi.waitFor(() => expect(f.stored.has(f.key)).toBe(false));
  expect(ws.close).toHaveBeenCalled();
});

test.each(["http://10.23.45.67:1423", "https://preview.example"])("clipboard shortcuts use native browser events without sending control characters on %s", async (origin) => {
  const f = page(true, origin);
  await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
  const ws = f.sockets[0]!; ws.receive({ type: "ready", cwd: "/tmp" });
  const key = (value: string, modifiers = { ctrlKey: true, metaKey: false }, type = "keydown") => {
    const event = { key: value, ...modifiers, shiftKey: false, altKey: false, type, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    const handle = f.keyHandlers.at(-1)!(event as unknown as KeyboardEvent);
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(event.stopPropagation).not.toHaveBeenCalled();
    return handle;
  };
  for (const modifiers of [{ ctrlKey: true, metaKey: false }, { ctrlKey: false, metaKey: true }]) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      f.select(""); expect(key("v", modifiers, type)).toBe(false);
      f.select("selected output"); expect(key("C", modifiers, type)).toBe(false);
      expect(key("V", modifiers, type)).toBe(false);
    }
  }
  expect(ws.send.mock.calls.some(([data]) => JSON.parse(data as string).type === "input")).toBe(false);
  f.document.getElementById("interrupt")!.click();
  expect(JSON.parse(ws.send.mock.lastCall![0] as string)).toEqual({ type: "input", data: String.fromCharCode(3) });
  f.select(""); expect(key("c")).toBe(true);
  f.event("pagehide");
});

test("clipboard handling leaves other terminal shortcuts and modifier combinations unchanged", async () => {
  const f = page(true);
  await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
  f.sockets[0]!.receive({ type: "ready", cwd: "/tmp" }); f.select("selected output");
  for (const overrides of [
    { key: "a" }, { key: "d" }, { key: "c", ctrlKey: false }, { key: "v", ctrlKey: false },
    { key: "c", altKey: true }, { key: "v", altKey: true },
    { key: "c", shiftKey: true }, { key: "v", shiftKey: true },
    { key: "c", metaKey: true }, { key: "v", metaKey: true },
  ]) {
    const event = { ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, type: "keydown", ...overrides };
    expect(f.keyHandlers[0]!(event as KeyboardEvent)).toBe(true);
  }
  f.event("pagehide");
});

test("reconnecting reattaches the clipboard handler and stale input cannot reach the replacement socket", async () => {
  const f = page(true);
  await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
  const first = f.sockets[0]!; first.receive({ type: "ready", cwd: "/tmp" });
  const oldInput = f.instances[0]!;
  f.event("pagehide"); f.event("pageshow");
  await vi.waitFor(() => expect(f.sockets).toHaveLength(2));
  const next = f.sockets[1]!; next.receive({ type: "ready", cwd: "/tmp" });
  expect(f.keyHandlers).toHaveLength(2);
  for (const handler of f.keyHandlers) {
    f.select("copy");
    expect(handler({ key: "c", ctrlKey: true, metaKey: false } as KeyboardEvent)).toBe(false);
    expect(handler({ key: "v", ctrlKey: true, metaKey: false } as KeyboardEvent)).toBe(false);
  }
  oldInput.input("stale paste", true);
  expect(next.send.mock.calls.some(([data]) => JSON.parse(data as string).type === "input")).toBe(false);
  f.event("pagehide");
});

test("welcome and header actions share their pending state and cannot duplicate approval requests", async () => {
  vi.useFakeTimers(); const f = page();
  const header = f.document.getElementById("connect")!;
  const welcome = f.document.querySelector<HTMLButtonElement>("#welcome #welcome-connect")!;
  let complete!: () => void;
  f.fetch.mockImplementationOnce(() => new Promise((resolve) => {
    complete = () => resolve({ ok: true, json: async () => ({ requestId: "request", code: "123456" }) });
  }));
  f.fetch.mockImplementation(async () => ({ ok: true, json: async () => ({ state: "pending" }) }));
  expect(welcome.textContent).toBe("请求连接");
  welcome.click();
  for (const button of [header, welcome]) expect(button.hasAttribute("disabled")).toBe(true);
  header.click(); welcome.click();
  expect(f.fetch).toHaveBeenCalledOnce();
  complete(); await vi.advanceTimersByTimeAsync(0);
  for (const button of [header, welcome]) {
    expect(button.textContent).toBe("重新连接");
    expect(button.hasAttribute("disabled")).toBe(true);
  }
  expect(f.document.getElementById("code")!.textContent).toContain("123456");
  expect(f.sockets).toHaveLength(0);
  expect(f.fetch.mock.calls.filter(([url]) => url.endsWith("/request"))).toHaveLength(1);
  f.event("pagehide");
});

test("a failed welcome request enables both actions and can be retried from the header", async () => {
  vi.useFakeTimers(); const f = page();
  const header = f.document.getElementById("connect")!;
  const welcome = f.document.getElementById("welcome-connect")!;
  f.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  welcome.click(); await vi.advanceTimersByTimeAsync(0);
  expect(f.document.getElementById("status")!.textContent).toContain("请求授权失败");
  for (const button of [header, welcome]) {
    expect(button.textContent).toBe("请求连接");
    expect(button.hasAttribute("disabled")).toBe(false);
  }
  header.click(); await vi.advanceTimersByTimeAsync(0);
  expect(f.sockets).toHaveLength(1);
  expect(f.fetch.mock.calls.filter(([url]) => url.endsWith("/request"))).toHaveLength(2);
  f.event("pagehide");
});

test("switching tabs preserves the connected Shell while leaving the page disconnects it", async () => {
  vi.useFakeTimers(); const f = page(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sockets).toHaveLength(1);
  const ws = f.sockets[0]!; ws.onopen?.(); ws.receive({ type: "ready", cwd: "/tmp" });
  expect(ws.send.mock.calls.map(([data]) => JSON.parse(data as string))).toContainEqual({ type: "visibility", foreground: true });
  f.visibility(true); await vi.advanceTimersByTimeAsync(181_000);
  expect(ws.send.mock.calls.filter(([data]) => JSON.parse(data as string).type === "visibility").map(([data]) => JSON.parse(data as string)))
    .toEqual([{ type: "visibility", foreground: true }, { type: "visibility", foreground: false }]);
  expect(ws.close).not.toHaveBeenCalled();
  ws.receive({ type: "data", data: "background output" });
  expect(f.write).toHaveBeenCalledWith("background output");
  f.visibility(false); await vi.advanceTimersByTimeAsync(0);
  expect(JSON.parse(ws.send.mock.lastCall![0] as string)).toEqual({ type: "visibility", foreground: true });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(ws.send.mock.calls.filter(([data]) => JSON.parse(data as string).type === "visibility")).toHaveLength(4);
  expect(f.sockets).toHaveLength(1);
  f.event("pagehide");
  const sent = ws.send.mock.calls.length;
  expect(ws.close).toHaveBeenCalledOnce();
  expect(f.fetch.mock.calls.some(([url]) => url.endsWith("/close"))).toBe(false);
  await vi.advanceTimersByTimeAsync(181_000);
  expect(ws.send).toHaveBeenCalledTimes(sent);
  expect(f.sockets).toHaveLength(1);
});

test("a hung status request times out then reconnects without duplicate approval", async () => {
  vi.useFakeTimers(); const f = page();
  f.fetch.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ requestId: "request", code: "123456" }) }));
  f.fetch.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }));
  f.document.getElementById("connect")!.click();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.document.getElementById("status")!.textContent).toContain("请求超时");
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.sockets).toHaveLength(1);
  expect(f.fetch.mock.calls.filter(([url]) => url.endsWith("/request"))).toHaveLength(1);
  f.event("pagehide");
});

test("offline and stalled WebSocket retries are single-flight and never re-request approval", async () => {
  vi.useFakeTimers(); const f = page(true);
  await vi.advanceTimersByTimeAsync(0);
  f.event("offline");
  const calls = f.fetch.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.fetch).toHaveBeenCalledTimes(calls);
  f.event("online"); f.event("focus"); f.event("pageshow");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(f.document.getElementById("status")!.textContent).toContain("WebSocket 连接超时");
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.sockets).toHaveLength(3);
  expect(f.fetch.mock.calls.every(([url]) => url.endsWith("/status"))).toBe(true);
  f.event("pagehide");
});

test.each(["connect", "welcome-connect"])("manual reconnect via %s preserves the session and ignores late background request errors", async (buttonId) => {
  vi.useFakeTimers(); const f = page();
  let failOld!: (error: Error) => void;
  f.fetch.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ requestId: "request", code: "123456" }) }));
  f.fetch.mockImplementationOnce(() => new Promise((_resolve, reject) => { failOld = reject; }));
  f.document.getElementById("connect")!.click(); await vi.advanceTimersByTimeAsync(0);
  f.visibility(true); f.visibility(false); await vi.advanceTimersByTimeAsync(0);
  expect(f.sockets).toHaveLength(1);
  const ws = f.sockets[0]!; ws.receive({ type: "ready", cwd: "/tmp" });
  failOld(new TypeError("Failed to fetch")); await vi.advanceTimersByTimeAsync(0);
  expect(f.document.getElementById("status")!.textContent).toContain("已连接");
  ws.onclose?.({ code: 1006 });
  f.document.getElementById(buttonId)!.click(); await vi.advanceTimersByTimeAsync(0);
  expect(f.sockets).toHaveLength(2);
  expect(f.fetch.mock.calls.filter(([url]) => url.endsWith("/request"))).toHaveLength(1);
  expect(f.fetch.mock.calls.some(([url]) => url.endsWith("/close"))).toBe(false);
  expect(f.stored.has(f.key)).toBe(true);
  f.event("pagehide");
});

test("expired or rejected credentials do not retry forever, and close never auto-reconnects", async () => {
  vi.useFakeTimers(); const f = page(true);
  await vi.advanceTimersByTimeAsync(0);
  f.sockets[0]!.receive({ type: "error", stage: "spawn", message: "node-pty unavailable" });
  expect(f.document.getElementById("status")!.textContent).toBe("Shell 启动失败：node-pty unavailable");
  f.visibility(true); f.visibility(false); await vi.advanceTimersByTimeAsync(30_000);
  expect(f.sockets).toHaveLength(1);
  f.document.getElementById("close")!.click(); await vi.advanceTimersByTimeAsync(0);
  f.event("online"); f.event("pageshow"); await vi.advanceTimersByTimeAsync(30_000);
  expect(f.stored.has(f.key)).toBe(false); expect(f.sockets).toHaveLength(1);
  f.event("pagehide");

  const expired = page();
  expired.fetch.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ requestId: "request", code: "123456" }) }));
  expired.fetch.mockRejectedValueOnce(Object.assign(new Error("expired"), { httpStatus: 400 }));
  expired.document.getElementById("connect")!.click(); await vi.advanceTimersByTimeAsync(30_000);
  expect(expired.stored.has(expired.key)).toBe(false);
  expect(expired.fetch).toHaveBeenCalledTimes(2); expired.event("pagehide");
});

test("refresh resumes existing credentials without requesting another shell; exit clears them", async () => {
  const f = page(true);
  await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
  expect(f.fetch.mock.calls.every(([url]) => url === "/proxy/terminal/api/status")).toBe(true);
  const ws = f.sockets[0]!; ws.onopen?.();
  expect(JSON.parse(ws.send.mock.lastCall![0] as string)).toMatchObject({ type: "auth", requestId: "saved" });
  ws.receive({ type: "exit", message: "Shell 已退出" });
  expect(f.stored.has(f.key)).toBe(false);
  expect(f.document.getElementById("status")!.textContent).toBe("Shell 已退出");
});

test("LAN HTTP uses the same Preview address without a transport warning banner", async () => {
  const f = page(false, "http://10.23.45.67:1423");
  expect(f.document.getElementById("transport-warning")).toBeNull();
  expect(f.document.body.textContent).not.toContain("当前连接为 HTTP");
  f.document.getElementById("welcome-connect")!.click();
  await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
  expect(f.sockets[0]!.url.toString()).toBe("ws://10.23.45.67:1423/proxy/terminal/socket");
  f.event("pagehide");
});

test("a transient status fetch failure retries the existing authorization, not another request", async () => {
  vi.useFakeTimers();
  const f = page();
  f.fetch.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ requestId: "request", code: "123456" }) }));
  f.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  f.document.getElementById("connect")!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.stored.has(f.key)).toBe(true);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(f.sockets.length).toBeGreaterThan(0);
  expect(f.fetch.mock.calls.filter(([url]) => url.endsWith("/request"))).toHaveLength(1);
  expect(f.fetch.mock.calls.some(([url]) => url.endsWith("/close"))).toBe(false);
  f.event("pagehide");
});

test("returning from Feishu or bfcache resumes polling without revoking owner approval", async () => {
  vi.useFakeTimers();
  const f = page(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sockets).toHaveLength(1);
  f.event("pagehide"); f.visibility(true);
  const calls = f.fetch.mock.calls.length;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(f.fetch).toHaveBeenCalledTimes(calls);
  f.visibility(false); f.event("pageshow"); f.event("online");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sockets).toHaveLength(2);
  expect(f.fetch.mock.calls.every(([url]) => url.endsWith("/status"))).toBe(true);
  expect(f.stored.has(f.key)).toBe(true);
  f.event("pagehide");
});

const esc = String.fromCharCode(27);

test("real xterm reproduces duplicate device responses when raw history is replayed", async () => {
  const term = new Xterm(); terminals.push(term);
  const responses: string[] = []; term.onData((data) => responses.push(data));
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => term.write(esc + "[c", resolve));
  expect(responses).toEqual(Array(3).fill(esc + "[?1;2c"));
});

test("refresh restores history silently before parsing queued live queries and accepting input", async () => {
  const f = page(true);
  await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
  const ws = f.sockets[0]!;
  const history = esc + "[31mhistory" + esc + "[0m" + esc + "[c" + esc + "[6n";
  ws.receive({ type: "ready", cwd: "/tmp", output: history, replay: true });
  expect(f.instances[0]!.options.disableStdin).toBe(true);
  expect(f.document.getElementById("interrupt")!.hasAttribute("disabled")).toBe(true);
  ws.receive({ type: "data", data: "live" + esc + "[" });
  ws.receive({ type: "data", data: "c" + esc + "[6n" });
  const inputs = () => ws.send.mock.calls.map(([data]) => JSON.parse(data as string) as { type: string; data: string }).filter((m) => m.type === "input").map((m) => m.data);
  await vi.waitFor(() => expect(inputs()).toEqual([esc + "[?1;2c", esc + "[1;12R"]));
  expect(f.instances[0]!.buffer.active.getLine(0)?.translateToString(true)).toBe("historylive");
  expect(f.instances[0]!.buffer.active.getLine(0)?.getCell(0)?.isFgPalette()).toBeTruthy();
  f.input("echo ?1;2c"); f.document.getElementById("interrupt")!.click();
  expect(inputs().slice(-2)).toEqual(["echo ?1;2c", String.fromCharCode(3)]);
  expect(f.instances[0]!.options.disableStdin).toBe(false);
  f.event("pagehide");
});

test("first attachment answers startup queries but repeated reconnects never answer them again", async () => {
  const f = page(true);
  for (let i = 0; i < 3; i++) {
    await vi.waitFor(() => expect(f.sockets).toHaveLength(i + 1));
    const ws = f.sockets[i]!;
    ws.receive({ type: "ready", cwd: "/tmp", output: esc + "[c" + esc + "[6n", replay: i > 0 });
    await vi.waitFor(() => expect(f.document.getElementById("status")!.textContent).toContain("已连接"));
    const inputs = ws.send.mock.calls.map(([data]) => JSON.parse(data as string) as { type: string; data: string }).filter((m) => m.type === "input");
    expect(inputs.map((m) => m.data)).toEqual(i ? [] : [esc + "[?1;2c", esc + "[1;1R"]);
    f.event("pagehide"); if (i < 2) f.event("pageshow");
  }
});

test("late xterm parsing from a replaced socket cannot send input or enable the new terminal", async () => {
  const f = page(true);
  await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
  const ws = f.sockets[0]!;
  const callbacks: Array<() => void> = [];
  const pending = vi.spyOn(Xterm.prototype, "write").mockImplementationOnce((_data, callback) => { if (callback) callbacks.push(callback); });
  ws.receive({ type: "ready", cwd: "/old", output: esc + "[c", replay: true });
  pending.mockRestore();
  expect(callbacks).toHaveLength(1);
  const old = f.instances[0]!;
  f.event("pagehide"); f.event("pageshow");
  await vi.waitFor(() => expect(f.sockets).toHaveLength(2));
  const next = f.sockets[1]!;
  next.receive({ type: "ready", cwd: "/new", output: "restored" + esc + "[c", replay: true });
  old.input(esc + "[?1;2c", false); callbacks.forEach((callback) => callback());
  expect(f.instances.at(-1)!.options.disableStdin).toBe(true);
  await vi.waitFor(() => expect(f.document.getElementById("status")!.textContent).toBe("已连接 · /new"));
  expect(next.send.mock.calls.some(([data]) => (JSON.parse(data as string) as { type: string }).type === "input")).toBe(false);
  expect(f.instances).toHaveLength(2);
  f.event("pagehide");
});

test("a query split at the replay/live boundary is answered only when its live suffix arrives", async () => {
  const f = page(true);
  await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
  const ws = f.sockets[0]!;
  ws.receive({ type: "ready", cwd: "/tmp", output: esc + "[c" + esc + "[", replay: true });
  ws.receive({ type: "data", data: "c" });
  const inputs = () => ws.send.mock.calls.map(([data]) => JSON.parse(data as string) as { type: string; data: string }).filter((m) => m.type === "input").map((m) => m.data);
  await vi.waitFor(() => expect(inputs()).toEqual([esc + "[?1;2c"]));
  f.event("pagehide");
});

test("server-selected recovery mode requests approval for the exact terminal", async () => {
  const pathname = "/proxy/terminal/B8j3N2pS";
  const f = page(false, "https://preview.example", pathname, true);
  expect(f.document.querySelector("#welcome h1")!.textContent).toBe("恢复已有终端");
  expect(f.document.getElementById("connect")!.textContent).toBe("请求恢复连接");
  expect(f.document.getElementById("welcome-connect")!.textContent).toBe("请求恢复连接");
  expect(f.document.getElementById("details")!.textContent).toContain("原会话的终端管理卡");
  expect(f.document.getElementById("welcome")!.textContent).toContain("命令所在的飞书会话或话题");
  expect(f.fetch).not.toHaveBeenCalled();
  f.document.getElementById("welcome-connect")!.click();
  await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
  expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string)).toMatchObject({ launch: pathname });
  expect(f.fetch.mock.calls[0]![0]).toBe("/proxy/terminal/api/request");
  expect(f.stored.has(f.key)).toBe(true);
  f.event("pagehide");
});
