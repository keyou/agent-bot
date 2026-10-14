import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";
import { WebSocket } from "ws";
import { afterEach, expect, test, vi } from "vitest";
import { TerminalServer, type TerminalCardView } from "../../src/terminal/TerminalServer.js";
import { LocalFileViewerServer } from "../../src/local-files/LocalFileViewerServer.js";
import type { TerminalProcess } from "../../src/terminal/TerminalProcess.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { try { for (const cleanup of cleanups.splice(0)) await cleanup(); } finally { vi.useRealTimers(); } });
const jobId = "00000000-0000-4000-8000-000000000001";
async function fixture(publicBaseUrl?: string, host = "127.0.0.1") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbot-terminal-"));
  let now = Date.now();
  let owner = "ou_owner";
  let canStart = true;
  let startupOutput = "";
  let onData: (value: string) => void = () => {};
  let onExit: (value: { exitCode: number }) => void = () => {};
  let authorization!: TerminalCardView;
  let approvalCardId = "approval-card"; let approvals = 0;
  const pty: TerminalProcess = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData: (listener) => { onData = listener; if (startupOutput) listener(startupOutput); return { dispose() {} }; },
    onExit: (listener) => { onExit = listener; return { dispose() {} }; },
  };
  const spawn = vi.fn(async () => pty);
  const readJob = vi.fn(async () => ({ cwd: dir, contextKey: "chat_id:source:thread_id:topic", cardMessageId: "command-card" }));
  const requestApproval = vi.fn(async (value: TerminalCardView) => {
    authorization = value; approvalCardId = ++approvals === 1 ? "approval-card" : `approval-card-${approvals}`; return approvalCardId;
  });
  const updateCard = vi.fn(async (_messageId: string, _view: TerminalCardView) => {});
  const options = { stateDirectory: path.join(dir, "terminal"), ownerId: () => owner,
    readJob, requestApproval, updateCard, logger: { info: vi.fn(), warn: vi.fn() }, spawn, now: () => now, canStart: () => canStart };
  const server = new TerminalServer(options);
  const viewer = new LocalFileViewerServer({ host, port: 0, stateDirectory: path.join(dir, "viewer"), publicBaseUrl });
  const address = await viewer.start();
  const base = new URL(await server.start(viewer));
  const fetchPage = (url: string | URL, init?: RequestInit) => {
    const target = new URL(url); target.host = `127.0.0.1:${address.port}`; target.protocol = "http:";
    return new Promise<Response>((resolve, reject) => {
      const req = http.request(target, { method: init?.method, headers: { ...Object.fromEntries(new Headers(init?.headers)), Host: base.host } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode,
          headers: Object.fromEntries(Object.entries(res.headers).filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : String(value)])),
        })));
        res.on("error", reject);
      });
      req.on("error", reject); req.end(init?.body);
    });
  };
  const launch = new URL(server.createUrl(jobId)!).pathname;
  const browserKey = randomBytes(32).toString("hex");
  const post = (route: string, body: unknown, origin = base.origin) => fetchPage(new URL(base.pathname + "/api/" + route, base), {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const request = async () => {
    const response = await post("request", { launch, browserKey });
    expect(response.status).toBe(200);
    return { ...await response.json() as { requestId: string; code: string }, browserKey };
  };
  const approve = (overrides = {}) => server.resolveApproval({
    actionId: "action", contextKey: "chat_id:source:thread_id:topic", userId: "ou_owner", messageId: approvalCardId,
    value: { requestId: authorization.requestId, token: authorization.approvalToken, decision: "allow" }, ...overrides,
  });
  const clients: WebSocket[] = [];
  const connect = async (credentials: unknown, origin = base.origin) => {
    const ws = new WebSocket(new URL(base.pathname + "/socket", `http://127.0.0.1:${address.port}`).toString().replace("http:", "ws:"), { origin, headers: { Host: base.host } });
    clients.push(ws);
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ ...credentials as object, type: "auth" }));
    return { ws, messages };
  };
  cleanups.push(async () => { for (const client of clients) client.terminate(); await server.close(); await viewer.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { server, viewer, address, fetchPage, base, launch, dir, options, browserKey, post, request, approve, connect, spawn, readJob, requestApproval, pty,
    tick: (ms: number) => { now += ms; }, owner: (value: string) => { owner = value; },
    blockStart: () => { canStart = false; }, authorization: () => authorization,
    startup: (value: string) => { startupOutput = value; },
    data: (value: string) => onData(value), exit: () => onExit({ exitCode: 0 }),
  };
}

test("opening the command link only loads the page and assets; it never launches a command", async () => {
  const f = await fixture();
  expect(f.launch).toMatch(/^[/]terminal[/][A-Za-z0-9_-]{8}$/u);
  expect(new URL(f.server.createUrl(jobId)!).pathname).toBe(f.launch);
  const response = await f.fetchPage(new URL(f.launch, f.base));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(response.headers.get("content-security-policy")).toContain(`connect-src 'self' ${f.base.origin.replace(/^http/u, "ws")}`);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await response.text()).toContain("请求连接");
  for (const asset of ["xterm.js", "xterm.css", "fit.js", "terminal.js", "terminal.css"]) {
    expect((await f.fetchPage(new URL(f.base.pathname + "/assets/" + asset, f.base))).status).toBe(200);
  }
  expect(f.spawn).not.toHaveBeenCalled(); expect(f.requestApproval).not.toHaveBeenCalled();
  expect((await f.fetchPage(new URL(f.launch.slice(0, -1), f.base))).status).toBe(404);
  expect((await f.fetchPage(new URL("/preview/anything", f.base))).status).toBe(404);
});

test("only the owner, matching approval card, and private browser credential authorize a shell", async () => {
  const f = await fixture(); const credentials = await f.request();
  expect(f.spawn).not.toHaveBeenCalled();
  await expect(f.approve({ userId: "ou_other" })).rejects.toThrow("无效");
  await expect(f.approve({ messageId: "forwarded-card" })).rejects.toThrow("无效");
  const unauthorized = await f.connect(credentials);
  await vi.waitFor(() => expect(unauthorized.messages[0]?.type).toBe("error"));
  await f.approve();
  expect(f.spawn).not.toHaveBeenCalled();
  await f.post("status", credentials);
  await f.post("status", credentials);
  expect(f.options.logger.info.mock.calls.filter(([, message]) => message === "Terminal approval observed by browser.")).toHaveLength(1);
  const wrongKey = await f.connect({ ...credentials, browserKey: "0".repeat(64) });
  await vi.waitFor(() => expect(wrongKey.messages[0]?.type).toBe("error"));
  const { ws, messages } = await f.connect(credentials);
  await vi.waitFor(() => expect(messages[0]?.type).toBe("ready"));
  expect(f.spawn).toHaveBeenCalledExactlyOnceWith(f.dir, 100, 30);
  expect(f.options.logger.info).toHaveBeenCalledWith({ requestId: credentials.requestId }, "Terminal WebSocket authenticated.");
  f.data("colored output");
  await vi.waitFor(() => expect(messages.at(-1)).toMatchObject({ type: "data", data: "colored output" }));
  ws.send(JSON.stringify({ type: "input", data: "echo hello" + String.fromCharCode(13) }));
  ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
  await vi.waitFor(() => expect(f.pty.resize).toHaveBeenCalledWith(120, 40));
  expect(f.pty.write).toHaveBeenCalledWith("echo hello" + String.fromCharCode(13));
  expect(f.server.activeCount).toBe(1);
  ws.close();
  const next = await f.connect(credentials);
  await vi.waitFor(() => expect(next.messages[0]).toMatchObject({ type: "ready", output: "colored output", replay: true }));
  expect(f.spawn).toHaveBeenCalledOnce();
  expect((await f.post("close", credentials)).status).toBe(200);
  expect(f.pty.kill).toHaveBeenCalledOnce(); expect(f.server.activeCount).toBe(0);
  const logs = JSON.stringify([...f.options.logger.info.mock.calls, ...f.options.logger.warn.mock.calls]);
  expect(logs).not.toContain(f.browserKey);
  expect(logs).not.toContain(f.authorization().approvalToken);
});

test("rejects wrong origin, forged launch paths, invalid payloads and sandboxed opaque origins", async () => {
  const f = await fixture();
  expect((await f.post("request", { launch: f.launch, browserKey: f.browserKey }, "https://evil.example")).status).toBe(403);
  expect((await f.post("request", { launch: f.launch + "x", browserKey: f.browserKey })).status).toBe(400);
  await expect(f.connect({}, "https://evil.example")).rejects.toThrow();
  await expect(f.connect({}, "null")).rejects.toThrow();
  expect(f.requestApproval).not.toHaveBeenCalled();
});

test.each(["http://10.23.45.67:1423/proxy", "https://preview.example/bot"])("shares Preview origin and base path: %s", async (publicBaseUrl) => {
  const f = await fixture(publicBaseUrl);
  expect(f.base.toString()).toBe(publicBaseUrl + "/terminal");
  expect(new URL(f.launch, f.base).toString().slice(publicBaseUrl.length)).toMatch(/^[/]terminal[/][A-Za-z0-9_-]{8}$/u);
  expect(f.base.origin).toBe(new URL(f.address.publicBaseUrl).origin);
  expect((await f.fetchPage(new URL(f.launch, f.base))).status).toBe(200);
  expect((await f.fetchPage(new URL(f.base.pathname + "/assets/xterm.js", f.base))).status).toBe(200);
  const credentials = await f.request(); await f.approve();
  const c = await f.connect(credentials); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  c.ws.send(JSON.stringify({ type: "input", data: "hello" }));
  await vi.waitFor(() => expect(f.pty.write).toHaveBeenCalledWith("hello"));
  const file = path.join(f.dir, "hello.txt"); fs.writeFileSync(file, "hello preview");
  const fileUrl = f.viewer.createFileUrl(file)!;
  expect((await f.fetchPage(fileUrl)).status).toBe(200);
  expect((await f.fetchPage(fileUrl, { method: "POST" })).status).toBe(405);
  await f.server.close();
  expect((await f.fetchPage(fileUrl)).status).toBe(200);
  expect((await f.fetchPage(new URL(f.launch, f.base))).status).toBe(404);
  expect(fs.existsSync(path.join(f.options.stateDirectory, "port"))).toBe(false);
});

test("authorization expires and rejected requests cannot spawn", async () => {
  const f = await fixture(); const credentials = await f.request();
  f.tick(5 * 60_000);
  await expect(f.approve()).rejects.toThrow();
  expect(await (await f.post("status", credentials)).json()).toMatchObject({ state: "closed" });
  expect(f.spawn).not.toHaveBeenCalled();
});

test("short launch links survive service restart but recovery links cannot revive the old Shell", async () => {
  const f = await fixture(); const credentials = await f.request();
  const reopen = new URL(f.authorization().reopenUrl);
  expect(reopen.pathname).toMatch(/^[/]terminal[/][A-Za-z0-9_-]{8}$/u);
  expect(reopen.pathname.split("/").at(-1)).not.toBe(credentials.requestId);
  await f.approve();
  const c = await f.connect(credentials); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  await f.server.close();
  const replacement = new TerminalServer(f.options);
  try {
    await replacement.start(f.viewer);
    expect(new URL(replacement.createUrl(jobId)!).pathname).toBe(f.launch);
    expect((await f.fetchPage(new URL(f.launch, f.base))).status).toBe(200);
    expect((await f.fetchPage(reopen)).status).toBe(404);
    expect((await f.post("request", { launch: reopen.pathname, browserKey: f.browserKey })).status).toBe(400);
    f.tick(11_000);
    const response = await f.post("request", { launch: f.launch, browserKey: f.browserKey });
    expect(response.status).toBe(200);
    expect(f.readJob).toHaveBeenLastCalledWith(jobId);
    expect(f.spawn).toHaveBeenCalledOnce();
  } finally { await replacement.close(); }
});

test("rejects old open/resume paths even with valid tokens or signatures", async () => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  const card = f.authorization();
  const secret = fs.readFileSync(path.join(f.options.stateDirectory, "secret"));
  const sign = (value: string) => createHmac("sha256", secret).update(`terminal:${value}`).digest("hex");
  const launchToken = f.launch.split("/").at(-1)!;
  const reopenToken = new URL(card.reopenUrl).pathname.split("/").at(-1)!;
  for (const launch of [
    `${f.base.pathname}/open/${launchToken}`,
    `${f.base.pathname}/resume/${reopenToken}`,
    `${f.base.pathname}/open/${jobId}/${sign(jobId)}`,
    `${f.base.pathname}/resume/${card.requestId}/${sign(`session:${card.requestId}`)}`,
  ]) {
    for (const method of ["GET", "HEAD"]) {
      expect((await f.fetchPage(new URL(launch, f.base), { method })).status).toBe(404);
    }
    expect((await f.post("request", { launch, browserKey: f.browserKey })).status).toBe(400);
  }
  expect((await f.fetchPage(new URL(f.launch, f.base))).status).toBe(200);
  expect((await f.fetchPage(card.reopenUrl)).status).toBe(200);
  expect(await (await f.post("status", credentials)).json()).toMatchObject({ state: "approved" });
  expect(f.readJob).toHaveBeenCalledOnce(); expect(f.requestApproval).toHaveBeenCalledOnce();
  expect(f.spawn).not.toHaveBeenCalled();
});

test("short references cannot authorize a browser or accept extra path segments", async () => {
  const f = await fixture(); const credentials = await f.request(); const card = f.authorization();
  const launchToken = f.launch.split("/").at(-1)!;
  const reopenToken = new URL(card.reopenUrl).pathname.split("/").at(-1)!;
  expect((await f.post("request", { launch: f.launch, browserKey: launchToken })).status).toBe(400);
  const invalid = await f.connect({ requestId: reopenToken, browserKey: f.browserKey });
  await vi.waitFor(() => expect(invalid.messages[0]?.type).toBe("error"));
  for (const route of [`${f.base.pathname}/open/${reopenToken}`, `${f.base.pathname}/resume/${launchToken}`, `${f.launch}/suffix`]) {
    expect((await f.fetchPage(new URL(route, f.base))).status).toBe(404);
    expect((await f.post("request", { launch: route, browserKey: f.browserKey })).status).toBe(400);
  }
  expect(card.approvalToken).toHaveLength(64); expect(credentials.requestId).toHaveLength(32);
  expect(f.requestApproval).toHaveBeenCalledOnce(); expect(f.spawn).not.toHaveBeenCalled();
});

test("unified links select mode on the server instead of trusting the browser", async () => {
  const f = await fixture();
  expect(await (await f.fetchPage(new URL(f.launch, f.base))).text()).toContain('data-recovery="false"');
  const response = await f.post("request", { launch: f.launch, browserKey: f.browserKey, recovery: true });
  expect(response.status).toBe(200); expect(f.authorization().recovery).toBe(false);
  await f.approve();
  const terminal = f.authorization();
  const reopen = new URL(terminal.reopenUrl).pathname;
  expect(await (await f.fetchPage(new URL(reopen, f.base))).text()).toContain('data-recovery="true"');
  f.tick(11_000);
  expect((await f.post("request", { launch: reopen, browserKey: f.browserKey, recovery: false })).status).toBe(200);
  expect(f.authorization().recovery).toBe(true);
  expect(f.authorization().terminalId).toBe(terminal.terminalId);
  expect(f.readJob).toHaveBeenCalledOnce(); expect(f.spawn).not.toHaveBeenCalled();
});

test("uses Preview network selection without its own host or port and rejects Preview tokens", async () => {
  const f = await fixture(undefined, "0.0.0.0");
  expect(f.base.origin).toBe(new URL(f.address.publicBaseUrl).origin);
  expect(f.launch).toMatch(/^[/]terminal[/][A-Za-z0-9_-]{8}$/u);
  expect(f.base.port).toBe(String(f.address.port));
  expect((await f.fetchPage(new URL(f.launch, f.base))).status).toBe(200);
  const file = path.join(f.dir, "read-only.md"); fs.writeFileSync(file, "# Read only");
  const preview = new URL(f.viewer.createFileUrl(file)!);
  const response = await f.post("request", { launch: preview.pathname, browserKey: f.browserKey });
  expect(response.status).toBe(400);
  expect(f.spawn).not.toHaveBeenCalled(); expect(f.requestApproval).not.toHaveBeenCalled();
});

test("idle time and owner changes revoke sessions; polls do not keep them alive", async () => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  const c = await f.connect(credentials);
  await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  f.tick(30 * 60_000 - 1);
  expect(await (await f.post("status", credentials)).json()).toMatchObject({ state: "running" });
  expect(f.pty.kill).not.toHaveBeenCalled();
  f.tick(1);
  expect(await (await f.post("status", credentials)).json()).toMatchObject({ state: "closed", message: "连续 30 分钟无输入或输出，Shell 已自动关闭" });
  expect(f.pty.kill).toHaveBeenCalledOnce(); expect(f.server.activeCount).toBe(0);
  f.tick(11_000); const second = await f.request(); await f.approve(); f.owner("ou_new");
  expect(await (await f.post("status", second)).json()).toMatchObject({ state: "closed" });
});

async function disconnect(f: Awaited<ReturnType<typeof fixture>>, ws: WebSocket): Promise<void> {
  f.options.updateCard.mockClear();
  ws.close();
  await vi.waitFor(() => expect(f.options.updateCard).toHaveBeenCalledWith("approval-card", expect.objectContaining({ state: "running", connected: false })));
}

async function visibility(f: Awaited<ReturnType<typeof fixture>>, ws: WebSocket, foreground: boolean): Promise<void> {
  const resizeCount = vi.mocked(f.pty.resize).mock.calls.length;
  ws.send(JSON.stringify({ type: "visibility", foreground }));
  ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
  await vi.waitFor(() => expect(f.pty.resize).toHaveBeenCalledTimes(resizeCount + 1));
}

test("foreground heartbeats prevent idle closure; hiding starts thirty idle minutes without input", async () => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  const c = await f.connect(credentials); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  await visibility(f, c.ws, true);
  for (let minute = 0; minute < 35; minute++) { f.tick(60_000); await visibility(f, c.ws, true); }
  expect(await (await f.post("status", credentials)).json()).toMatchObject({ state: "running" });
  expect(f.pty.write).not.toHaveBeenCalled(); expect(f.pty.kill).not.toHaveBeenCalled();
  await visibility(f, c.ws, false);
  f.tick(29 * 60_000); await visibility(f, c.ws, false);
  f.tick(59_999);
  expect(await (await f.post("status", credentials)).json()).toMatchObject({ state: "running" });
  f.tick(1);
  expect(await (await f.post("status", credentials)).json()).toMatchObject({ state: "closed" });
  expect(f.pty.kill).toHaveBeenCalledOnce();
});

test("stale foreground status cannot keep an abandoned Shell alive indefinitely", async () => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  const c = await f.connect(credentials); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  await visibility(f, c.ws, true); f.tick(32 * 60_000);
  expect(await (await f.post("status", credentials)).json()).toMatchObject({ state: "closed" });
  expect(f.pty.kill).toHaveBeenCalledOnce();
});

test("disconnecting a foreground page still closes its Shell after three minutes", async () => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  const c = await f.connect(credentials); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  await visibility(f, c.ws, true); await disconnect(f, c.ws);
  f.tick(180_000); f.data("background output");
  expect(await (await f.post("status", credentials)).json()).toMatchObject({ state: "closed", message: "网页已断开 3 分钟，Shell 已自动关闭" });
  expect(f.pty.kill).toHaveBeenCalledOnce();
});

test("visibility cannot authorize a Shell or bypass manual closure", async () => {
  const f = await fixture(); const credentials = await f.request();
  const unauthorized = await f.connect({ foreground: true, browserKey: credentials.browserKey });
  await vi.waitFor(() => expect(unauthorized.messages[0]?.type).toBe("error"));
  expect(f.spawn).not.toHaveBeenCalled();
  await f.approve();
  const c = await f.connect(credentials); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  await visibility(f, c.ws, true);
  expect((await f.post("close", credentials)).status).toBe(200);
  expect(f.pty.kill).toHaveBeenCalledOnce();
});

test("a disconnected shell closes after three minutes despite output, polling and card refreshes", async () => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  const c = await f.connect(credentials); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  await disconnect(f, c.ws);
  f.tick(179_999); f.data("background command output");
  expect(await (await f.post("status", credentials)).json()).toMatchObject({ state: "running" });
  const card = f.authorization();
  await f.approve({ value: { requestId: card.requestId, token: card.approvalToken, decision: "refresh" } });
  expect(f.pty.kill).not.toHaveBeenCalled();
  f.tick(1); f.data("more output");
  expect(await (await f.post("status", credentials)).json()).toMatchObject({ state: "closed", message: "网页已断开 3 分钟，Shell 已自动关闭" });
  expect(f.pty.kill).toHaveBeenCalledOnce(); expect(f.server.activeCount).toBe(0);
  await vi.waitFor(() => expect(f.options.updateCard).toHaveBeenCalledWith("approval-card", expect.objectContaining({ state: "closed" })));
  const late = await f.connect(credentials); await vi.waitFor(() => expect(late.messages[0]?.type).toBe("error"));
  expect(f.spawn).toHaveBeenCalledOnce();
});

test("reconnection cancels expiry and a later disconnect receives its own full three minutes", async () => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  const first = await f.connect(credentials); await vi.waitFor(() => expect(first.messages[0]?.type).toBe("ready"));
  await disconnect(f, first.ws); f.tick(179_999);
  const next = await f.connect(credentials); await vi.waitFor(() => expect(next.messages[0]?.type).toBe("ready"));
  f.tick(5 * 60_000);
  expect(await (await f.post("status", credentials)).json()).toMatchObject({ state: "running" });
  expect(f.spawn).toHaveBeenCalledOnce(); expect(f.pty.kill).not.toHaveBeenCalled();
  await disconnect(f, next.ws); f.tick(179_999);
  expect(await (await f.post("status", credentials)).json()).toMatchObject({ state: "running" });
  f.tick(1);
  expect(await (await f.post("status", credentials)).json()).toMatchObject({ state: "closed" });
  expect(f.pty.kill).toHaveBeenCalledOnce();
});

test("the disconnect timer ends the Shell without waiting for another browser request", async () => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  const c = await f.connect(credentials); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await disconnect(f, c.ws);
  f.tick(179_999); await vi.advanceTimersByTimeAsync(179_999);
  expect(f.pty.kill).not.toHaveBeenCalled();
  f.data("still producing output"); f.tick(1); await vi.advanceTimersByTimeAsync(100);
  expect(f.pty.kill).toHaveBeenCalledOnce(); expect(f.server.activeCount).toBe(0);
});

test("recovery approval does not extend a disconnected Shell's deadline", async () => {
  const f = await fixture(); const original = await f.request(); const management = f.authorization(); await f.approve();
  const c = await f.connect(original); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  await disconnect(f, c.ws); f.tick(120_000);
  const browserKey = randomBytes(32).toString("hex");
  const response = await f.post("request", { launch: new URL(management.reopenUrl).pathname, browserKey });
  expect(response.status).toBe(200);
  const recovered = { ...await response.json() as { requestId: string }, browserKey };
  await f.approve(); f.tick(60_000);
  expect(await (await f.post("status", recovered)).json()).toMatchObject({ state: "closed" });
  expect(f.pty.kill).toHaveBeenCalledOnce();
});

test("recovery handoff starts the deadline if the replacement browser never connects", async () => {
  const f = await fixture(); const original = await f.request(); const management = f.authorization(); await f.approve();
  const c = await f.connect(original); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  f.tick(11_000);
  const browserKey = randomBytes(32).toString("hex");
  const response = await f.post("request", { launch: new URL(management.reopenUrl).pathname, browserKey });
  const recovered = { ...await response.json() as { requestId: string }, browserKey };
  await f.approve(); f.tick(180_000);
  expect(await (await f.post("status", recovered)).json()).toMatchObject({ state: "closed" });
  expect(f.pty.kill).toHaveBeenCalledOnce();
});

test("a connected Shell still expires at the eight-hour absolute limit", async () => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  const c = await f.connect(credentials); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  f.tick(8 * 60 * 60_000); f.data("active command output");
  expect(await (await f.post("status", credentials)).json()).toMatchObject({ state: "closed" });
  expect(f.pty.kill).toHaveBeenCalledOnce();
});

test("idle expiry can close a disconnected Shell before the three-minute deadline", async () => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  const c = await f.connect(credentials); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  f.tick(29 * 60_000); await disconnect(f, c.ws); f.tick(60_000);
  expect(await (await f.post("status", credentials)).json()).toMatchObject({ state: "closed", message: "连续 30 分钟无输入或输出，Shell 已自动关闭" });
  expect(f.pty.kill).toHaveBeenCalledOnce();
});

test.each(["same-tab", "recovery"])("successful %s reconnection resets the thirty-minute idle clock but resize does not", async (mode) => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  const first = await f.connect(credentials); await vi.waitFor(() => expect(first.messages[0]?.type).toBe("ready"));
  f.tick(28 * 60_000); await disconnect(f, first.ws); f.tick(60_000);
  let access = { requestId: credentials.requestId, browserKey: credentials.browserKey };
  if (mode === "recovery") {
    const browserKey = randomBytes(32).toString("hex");
    const response = await f.post("request", { launch: new URL(f.authorization().reopenUrl).pathname, browserKey });
    expect(response.status).toBe(200);
    access = { ...await response.json() as { requestId: string }, browserKey };
    await f.approve();
  }
  const next = await f.connect(access); await vi.waitFor(() => expect(next.messages[0]?.type).toBe("ready"));
  f.tick(29 * 60_000);
  expect(await (await f.post("status", access)).json()).toMatchObject({ state: "running" });
  expect(f.spawn).toHaveBeenCalledOnce(); expect(f.pty.kill).not.toHaveBeenCalled();
  next.ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
  await vi.waitFor(() => expect(f.pty.resize).toHaveBeenCalledWith(120, 40));
  f.tick(59_999);
  expect(await (await f.post("status", access)).json()).toMatchObject({ state: "running" });
  f.tick(1);
  await f.post("status", access);
  await vi.waitFor(() => expect(next.messages.at(-1)).toMatchObject({ type: "exit", message: "连续 30 分钟无输入或输出，Shell 已自动关闭" }));
  await vi.waitFor(() => expect(f.options.updateCard).toHaveBeenCalledWith("approval-card", expect.objectContaining({ state: "closed" })));
  expect(f.pty.kill).toHaveBeenCalledOnce();
});

test.each(["invalid-key", "approval-only"])("%s does not reset the idle clock without a successful connection", async (mode) => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  const first = await f.connect(credentials); await vi.waitFor(() => expect(first.messages[0]?.type).toBe("ready"));
  f.tick(29 * 60_000);
  let access = { requestId: credentials.requestId, browserKey: credentials.browserKey };
  if (mode === "invalid-key") {
    const rejected = await f.connect({ ...access, browserKey: "0".repeat(64) });
    await vi.waitFor(() => expect(rejected.messages[0]?.type).toBe("error"));
  } else {
    const browserKey = randomBytes(32).toString("hex");
    const response = await f.post("request", { launch: new URL(f.authorization().reopenUrl).pathname, browserKey });
    expect(response.status).toBe(200);
    access = { ...await response.json() as { requestId: string }, browserKey };
    await f.approve();
  }
  f.tick(60_000);
  expect(await (await f.post("status", access)).json()).toMatchObject({ state: "closed", message: "连续 30 分钟无输入或输出，Shell 已自动关闭" });
  expect(f.pty.kill).toHaveBeenCalledOnce();
  const expired = await f.connect(access); await vi.waitFor(() => expect(expired.messages[0]?.type).toBe("error"));
  expect(f.spawn).toHaveBeenCalledOnce();
});

test.each(["input", "output"])("%s refreshes the idle clock while the browser remains connected", async (activity) => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  const c = await f.connect(credentials); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  f.tick(29 * 60_000);
  if (activity === "output") f.data("command progress");
  else {
    c.ws.send(JSON.stringify({ type: "input", data: "echo hello" }));
    await vi.waitFor(() => expect(f.pty.write).toHaveBeenCalledWith("echo hello"));
  }
  f.tick(30 * 60_000 - 1);
  expect(await (await f.post("status", credentials)).json()).toMatchObject({ state: "running" });
  f.tick(1);
  expect(await (await f.post("status", credentials)).json()).toMatchObject({ state: "closed" });
  expect(f.pty.kill).toHaveBeenCalledOnce();
});

test("limits approval spam and fails closed when the authorization card cannot be sent", async () => {
  const f = await fixture(); await f.request();
  expect((await f.post("request", { launch: f.launch, browserKey: f.browserKey })).status).toBe(429);
  f.tick(11_000); f.requestApproval.mockRejectedValueOnce(new Error("private chat failed"));
  expect((await f.post("request", { launch: f.launch, browserKey: f.browserKey })).status).toBe(400);
  expect(f.spawn).not.toHaveBeenCalled();
});

test("invalid dimensions cannot reach the PTY and closing AgentBot terminates terminal sessions", async () => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  const c = await f.connect(credentials); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  c.ws.send(JSON.stringify({ type: "resize", cols: 1e9, rows: -1 }));
  await vi.waitFor(() => expect(c.messages.at(-1)?.type).toBe("error"));
  expect(f.pty.resize).not.toHaveBeenCalled();
  await f.server.close(); expect(f.pty.kill).toHaveBeenCalledOnce();
});

test("closing while a PTY is starting kills the late process instead of leaking it", async () => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  let finish!: (p: TerminalProcess) => void;
  f.spawn.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await f.connect(credentials); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(f.server.activeCount).toBe(1);
  await f.post("close", credentials); finish(f.pty);
  await vi.waitFor(() => expect(f.pty.kill).toHaveBeenCalledOnce());
  expect(f.server.activeCount).toBe(1);
  f.exit(); expect(f.server.activeCount).toBe(0);
});

test("restart blockers distinguish foreground, recent I/O, shell execution and idle state", async () => {
  const f = await fixture(); const credentials = await f.request();
  expect(f.server.listActiveTerminals()).toEqual([]); await f.approve();
  expect(f.server.listActiveTerminals()).toEqual([]);
  const commandState = vi.fn<NonNullable<TerminalProcess["commandState"]>>(() => ({ status: "idle", source: "shell" }));
  f.pty.commandState = commandState;
  const c = await f.connect(credentials); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  const view = f.authorization();
  expect(f.server.listActiveTerminals()).toEqual([{
    terminalId: credentials.requestId, token: view.reopenToken, cwd: f.dir, state: "running",
    connected: true, active: true, foreground: false, command: { status: "idle", source: "shell" },
  }]);
  f.tick(31_000); expect(f.server.listActiveTerminals()[0]?.active).toBe(false);
  await visibility(f, c.ws, true);
  expect(f.server.listActiveTerminals()[0]).toMatchObject({ active: true, foreground: true });
  await visibility(f, c.ws, false); f.tick(31_000);
  commandState.mockReturnValue({ status: "running", command: "Start-Sleep -Seconds 60", source: "shell" });
  expect(f.server.listActiveTerminals()[0]).toMatchObject({ active: true, foreground: false, command: { status: "running", command: "Start-Sleep -Seconds 60" } });
  commandState.mockReturnValue({ status: "unknown" }); await disconnect(f, c.ws); f.tick(31_000);
  expect(f.server.listActiveTerminals()[0]).toMatchObject({ active: false, connected: false, command: { status: "unknown" } });
  commandState.mockImplementationOnce(() => { throw new Error("PTY exited while inspecting"); });
  expect(f.server.listActiveTerminals()[0]?.command.status).toBe("unknown");
  f.data("progress"); expect(f.server.listActiveTerminals()[0]?.active).toBe(true);
});

test("restart closure is owner-only, closes only the selected Shell and waits for its exit", async () => {
  const f = await fixture(); const first = await f.request(); await f.approve();
  const c = await f.connect(first); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  f.tick(11_000); const second = await f.request(); await f.approve();
  const secondPty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(() => ({ dispose() {} })), onExit: vi.fn(() => ({ dispose() {} })) };
  f.spawn.mockResolvedValueOnce(secondPty);
  const other = await f.connect(second); await vi.waitFor(() => expect(other.messages[0]?.type).toBe("ready"));
  f.blockStart();
  await expect(f.server.stopActiveTerminal(first.requestId, "other")).rejects.toThrow("所有者");
  expect(f.pty.kill).not.toHaveBeenCalled();
  expect(await f.server.stopActiveTerminal(first.requestId, "ou_owner")).toBe(true);
  expect(f.pty.kill).toHaveBeenCalledOnce(); expect(secondPty.kill).not.toHaveBeenCalled();
  expect(f.server.activeCount).toBe(2);
  expect(f.server.listActiveTerminals().find(t => t.terminalId === first.requestId)).toMatchObject({ state: "closing", active: false });
  expect(await f.server.stopActiveTerminal(first.requestId, "ou_owner")).toBe(false);
  expect(await f.server.stopActiveTerminal("0".repeat(32), "ou_owner")).toBe(false);
  f.exit(); expect(f.server.activeCount).toBe(1);
  expect(f.server.listActiveTerminals().map(t => t.terminalId)).toEqual([second.requestId]);
});

test("a failed OS termination keeps the terminal blocking and allows retry", async () => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  const c = await f.connect(credentials); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  vi.mocked(f.pty.kill).mockImplementationOnce(() => { throw new Error("kill failed"); });
  await expect(f.server.stopActiveTerminal(credentials.requestId, "ou_owner")).rejects.toThrow("kill failed");
  expect(f.server.listActiveTerminals()[0]?.state).toBe("running");
  expect(await f.server.stopActiveTerminal(credentials.requestId, "ou_owner")).toBe(true);
  expect(f.server.activeCount).toBe(1); f.exit(); expect(f.server.activeCount).toBe(0);
});

test("restart closure during startup retains the blocker until the late PTY exits", async () => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  let finish!: (pty: TerminalProcess) => void;
  f.spawn.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await f.connect(credentials); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(f.server.listActiveTerminals()[0]?.state).toBe("starting");
  await f.server.stopActiveTerminal(credentials.requestId, "ou_owner");
  expect(f.server.activeCount).toBe(1); expect(f.server.listActiveTerminals()[0]?.state).toBe("closing");
  finish(f.pty); await vi.waitFor(() => expect(f.pty.kill).toHaveBeenCalledOnce());
  expect(f.server.activeCount).toBe(1); f.exit(); expect(f.server.activeCount).toBe(0);
});

test("denial, session caps and restart gating prevent new shells", async () => {
  const f = await fixture(); const credentials = await f.request();
  await f.approve({ value: { requestId: f.authorization().requestId, token: f.authorization().approvalToken, decision: "deny" } });
  const denied = await f.connect(credentials);
  await vi.waitFor(() => expect(denied.messages[0]?.type).toBe("error"));
  expect(f.spawn).not.toHaveBeenCalled();
  for (let i = 0; i < 3; i++) { f.tick(11_000); await f.request(); }
  f.tick(11_000);
  expect((await f.post("request", { launch: f.launch, browserKey: f.browserKey })).status).toBe(429);
  await f.approve(); f.blockStart();
  const blocked = await f.connect({ requestId: f.authorization().requestId, browserKey: f.browserKey });
  await vi.waitFor(() => expect(blocked.messages[0]?.message).toContain("重启"));
  expect((await f.post("request", { launch: f.launch, browserKey: f.browserKey })).status).toBe(400);
  expect(f.spawn).not.toHaveBeenCalled();
});

test("concurrent reconnects launch one PTY and output replay is bounded", async () => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  let finish!: (p: TerminalProcess) => void;
  f.spawn.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const first = await f.connect(credentials);
  const second = await f.connect(credentials);
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
  finish(f.pty);
  await vi.waitFor(() => expect(second.messages[0]?.type).toBe("ready"));
  f.data("x".repeat(300_000)); second.ws.close();
  const third = await f.connect(credentials);
  await vi.waitFor(() => expect(third.messages[0]?.type).toBe("ready"));
  expect(third.messages[0]?.replay).toBe(true);
  expect(String(third.messages[0]?.output).length).toBe(256 * 1024);
  expect(f.spawn).toHaveBeenCalledOnce();
  first.ws.close();
});

test("Preview shutdown closes active terminal sessions", async () => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  const c = await f.connect(credentials); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  await f.viewer.close();
  expect(f.pty.kill).toHaveBeenCalledOnce();
  expect(f.server.activeCount).toBe(0);
  expect(f.server.createUrl(jobId)).toBeUndefined();
});

test("reports a real Shell startup rejection separately from browser network failures", async () => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  f.spawn.mockRejectedValueOnce(new Error("node-pty unavailable"));
  const c = await f.connect(credentials);
  await vi.waitFor(() => expect(c.messages[0]).toMatchObject({ type: "error", stage: "spawn", message: "node-pty unavailable" }));
  expect(f.server.activeCount).toBe(0);
  expect(f.options.logger.warn).toHaveBeenCalledWith({ requestId: credentials.requestId, stage: "spawn" }, "Terminal WebSocket request failed.");
});

test("startup output is live only on first attachment; reconnect snapshots precede live data", async () => {
  const f = await fixture(); const credentials = await f.request(); await f.approve();
  const query = String.fromCharCode(27) + "[c";
  f.startup(query);
  for (let i = 0; i < 3; i++) {
    const c = await f.connect(credentials);
    await vi.waitFor(() => expect(c.messages[0]).toMatchObject({ type: "ready", output: query + "live".repeat(i), replay: i > 0 }));
    f.data("live");
    await vi.waitFor(() => expect(c.messages[1]).toEqual({ type: "data", data: "live" }));
    expect(f.pty.write).not.toHaveBeenCalled(); c.ws.close();
  }
  expect(f.spawn).toHaveBeenCalledOnce();
});

test("terminals created from one command display distinct recovery tokens matching their URLs", async () => {
  const f = await fixture("https://preview.example/bot");
  await f.request(); const first = f.authorization(); await f.approve();
  f.tick(11_000); await f.request(); const second = f.authorization();
  for (const view of [first, second]) {
    expect(view.reopenToken).toMatch(/^[A-Za-z0-9_-]{8}$/u);
    expect(view.reopenUrl).toBe(`${f.base.origin}${f.base.pathname}/${view.reopenToken}`);
    expect(view.reopenToken).not.toBe(f.launch.split("/").at(-1));
    expect(view.terminalId).toBe(view.requestId);
    expect(view.terminalId).toHaveLength(32);
    expect(view.approvalToken).toHaveLength(64);
  }
  expect(second.reopenToken).not.toBe(first.reopenToken);
  expect(f.readJob).toHaveBeenNthCalledWith(1, jobId);
  expect(f.readJob).toHaveBeenNthCalledWith(2, jobId);
  expect(f.spawn).not.toHaveBeenCalled();
});

test("source routing is captured from the command and retained for recovery, never supplied by the browser", async () => {
  const f = await fixture();
  const response = await f.post("request", { launch: f.launch, browserKey: f.browserKey, contextKey: "open_id:intruder" });
  expect(response.status).toBe(200);
  expect(f.authorization()).toMatchObject({ contextKey: "chat_id:source:thread_id:topic", commandCardMessageId: "command-card" });
  const management = f.authorization(); await f.approve(); f.tick(11_000);
  f.readJob.mockResolvedValue({ cwd: f.dir, cardMessageId: "unrelated-card", contextKey: "chat_id:unrelated" });
  const recovered = await f.post("request", { launch: new URL(management.reopenUrl).pathname, browserKey: randomBytes(32).toString("hex") });
  expect(recovered.status).toBe(200);
  expect(f.authorization()).toMatchObject({ contextKey: management.contextKey, commandCardMessageId: management.commandCardMessageId });
  expect(f.readJob).toHaveBeenCalledOnce();
});

test("an approved terminal can reopen before its first connection without creating a second session or Shell", async () => {
  const f = await fixture(); const original = await f.request(); const management = f.authorization();
  expect(await f.approve()).toContain("打开终端");
  expect(f.options.updateCard.mock.lastCall?.[1]).toMatchObject({ state: "approved", shellStarted: false, reopenUrl: management.reopenUrl });
  expect(f.spawn).not.toHaveBeenCalled(); f.tick(11_000);
  const browserKey = randomBytes(32).toString("hex");
  const response = await f.post("request", { launch: new URL(management.reopenUrl).pathname, browserKey });
  expect(response.status).toBe(200);
  const recovered = { ...await response.json() as { requestId: string }, browserKey };
  expect(f.authorization()).toMatchObject({ terminalId: original.requestId, state: "pending", recovery: true, shellStarted: false });
  expect(await (await f.post("status", original)).json()).toMatchObject({ state: "approved" });
  const unauthorized = await f.connect(recovered);
  await vi.waitFor(() => expect(unauthorized.messages[0]?.type).toBe("error"));
  expect(f.spawn).not.toHaveBeenCalled();
  await expect(f.approve({ userId: "ou_other" })).rejects.toThrow("无效");
  await f.approve();
  expect((await f.post("status", original)).status).toBe(400);
  const next = await f.connect(recovered);
  await vi.waitFor(() => expect(next.messages[0]).toMatchObject({ type: "ready", replay: false }));
  expect(f.spawn).toHaveBeenCalledOnce(); expect(f.pty.kill).not.toHaveBeenCalled();
  expect(f.options.updateCard.mock.lastCall?.[1]).toMatchObject({ state: "running", terminalId: original.requestId });
});

test.each(["deny", "browser-close"])("unstarted terminal recovery %s preserves original authorization", async (decision) => {
  const f = await fixture(); const original = await f.request(); const management = f.authorization(); await f.approve(); f.tick(11_000);
  const browserKey = randomBytes(32).toString("hex");
  const response = await f.post("request", { launch: new URL(management.reopenUrl).pathname, browserKey });
  const recovered = { ...await response.json() as { requestId: string }, browserKey };
  if (decision === "deny") await f.approve({ value: { requestId: recovered.requestId, token: f.authorization().approvalToken, decision } });
  else await f.post("close", recovered);
  expect(await (await f.post("status", original)).json()).toMatchObject({ state: "approved" });
  expect(await (await f.post("status", recovered)).json()).toMatchObject({ state: "closed" });
  const next = await f.connect(original); await vi.waitFor(() => expect(next.messages[0]?.type).toBe("ready"));
  expect(f.spawn).toHaveBeenCalledOnce();
});

test("unstarted recovery cannot bypass restart gating at request or approval time", async () => {
  const f = await fixture(); await f.request(); const management = f.authorization(); await f.approve(); f.tick(11_000);
  const launch = new URL(management.reopenUrl).pathname;
  expect((await f.post("request", { launch, browserKey: f.browserKey })).status).toBe(200);
  f.blockStart();
  await expect(f.approve()).rejects.toThrow("重启");
  f.tick(11_000);
  expect((await f.post("request", { launch, browserKey: f.browserKey })).status).toBe(400);
  expect(f.spawn).not.toHaveBeenCalled();
});

test.each(["close", "expire"])("an unstarted terminal that ends before recovery approval cannot respawn: %s", async (reason) => {
  const f = await fixture(); const original = await f.request(); const management = f.authorization(); await f.approve(); f.tick(11_000);
  const response = await f.post("request", { launch: new URL(management.reopenUrl).pathname, browserKey: f.browserKey });
  const recovered = { ...await response.json() as { requestId: string }, browserKey: f.browserKey };
  if (reason === "close") await f.post("close", original);
  else f.tick(300_000);
  await expect(f.approve()).rejects.toThrow();
  const next = await f.connect(recovered); await vi.waitFor(() => expect(next.messages[0]?.type).toBe("error"));
  expect(f.spawn).not.toHaveBeenCalled();
});

test("a missing source conversation fails closed rather than delivering elsewhere", async () => {
  const f = await fixture();
  f.readJob.mockResolvedValue({ cwd: f.dir, cardMessageId: "command-card", contextKey: "" });
  expect((await f.post("request", { launch: f.launch, browserKey: f.browserKey })).status).toBe(400);
  expect(f.requestApproval).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
});

test("owner can reopen a lost tab with new approval and close its original Shell from Feishu", async () => {
  const f = await fixture(); const original = await f.request(); const management = f.authorization(); await f.approve();
  const first = await f.connect(original); await vi.waitFor(() => expect(first.messages[0]?.type).toBe("ready"));
  first.ws.close(); f.data("keep my shell"); f.tick(11_000); f.blockStart();
  const launch = new URL(management.reopenUrl).pathname;
  expect((await f.fetchPage(management.reopenUrl)).status).toBe(200);
  const browserKey = randomBytes(32).toString("hex");
  const response = await f.post("request", { launch, browserKey });
  expect(response.status).toBe(200);
  const recovered = { ...await response.json() as { requestId: string }, browserKey };
  expect(await (await f.post("status", recovered)).json()).toMatchObject({ state: "pending" });
  expect(f.authorization().recovery).toBe(true);
  expect(f.authorization().reopenUrl).toBe(management.reopenUrl);
  const unauthorized = await f.connect(recovered);
  await vi.waitFor(() => expect(unauthorized.messages[0]?.type).toBe("error"));
  await f.approve();
  const next = await f.connect(recovered);
  await vi.waitFor(() => expect(next.messages[0]).toMatchObject({ type: "ready", output: "keep my shell", replay: true }));
  expect(f.spawn).toHaveBeenCalledOnce(); expect(f.pty.kill).not.toHaveBeenCalled();
  expect((await f.post("status", original)).status).toBe(400);
  await expect(f.approve({ userId: "other", value: { requestId: management.requestId, token: management.approvalToken, decision: "close" } })).rejects.toThrow();
  await expect(f.approve({ messageId: "forwarded", value: { requestId: management.requestId, token: management.approvalToken, decision: "close" } })).rejects.toThrow();
  await f.approve({ messageId: "approval-card", value: { requestId: management.requestId, token: management.approvalToken, decision: "close" } });
  expect(f.pty.kill).toHaveBeenCalledOnce(); expect(f.server.activeCount).toBe(0);
  await vi.waitFor(() => expect(f.options.updateCard).toHaveBeenCalledWith("approval-card", expect.objectContaining({ requestId: management.requestId, state: "closed" })));
  f.tick(11_000);
  expect((await f.post("request", { launch, browserKey })).status).toBe(400);
  expect(f.spawn).toHaveBeenCalledOnce();
});

test("denied, expired and browser-cancelled recovery requests never close or revoke the original Shell", async () => {
  const f = await fixture(); const original = await f.request(); const management = f.authorization(); await f.approve();
  const first = await f.connect(original); await vi.waitFor(() => expect(first.messages[0]?.type).toBe("ready"));
  const launch = new URL(management.reopenUrl).pathname;
  for (const decision of ["deny", "expire", "browser-close"] as const) {
    f.tick(11_000);
    const browserKey = randomBytes(32).toString("hex");
    const response = await f.post("request", { launch, browserKey });
    expect(response.status).toBe(200);
    const pending = { ...await response.json() as { requestId: string }, browserKey };
    if (decision === "deny") await f.approve({ value: { requestId: pending.requestId, token: f.authorization().approvalToken, decision: "deny" } });
    else if (decision === "expire") { f.tick(300_000); await expect(f.approve()).rejects.toThrow(); }
    else await f.post("close", pending);
    expect(await (await f.post("status", original)).json()).toMatchObject({ state: "running" });
    expect(await (await f.post("status", pending)).json()).toMatchObject({ state: "closed" });
    expect(f.pty.kill).not.toHaveBeenCalled();
  }
});

test("recovery keeps the displayed terminal token while rotating browser access and superseding older grants", async () => {
  const f = await fixture(); const original = await f.request(); const management = f.authorization(); await f.approve();
  const first = await f.connect(original); await vi.waitFor(() => expect(first.messages[0]?.type).toBe("ready"));
  let previous = original;
  for (let i = 0; i < 2; i++) {
    f.tick(11_000); const browserKey = randomBytes(32).toString("hex");
    const response = await f.post("request", { launch: new URL(management.reopenUrl).pathname, browserKey });
    const current = { ...await response.json() as { requestId: string; code: string }, browserKey };
    expect(current.requestId).not.toBe(previous.requestId);
    expect(f.authorization()).toMatchObject({ terminalId: management.terminalId, reopenToken: management.reopenToken, reopenUrl: management.reopenUrl });
    expect(await (await f.post("status", previous)).json()).toMatchObject({ state: "running" });
    await f.approve();
    const client = await f.connect(current); await vi.waitFor(() => expect(client.messages[0]?.type).toBe("ready"));
    const rejected = await f.connect(previous); await vi.waitFor(() => expect(rejected.messages[0]?.type).toBe("error"));
    previous = current;
  }
  expect((await f.post("close", previous)).status).toBe(200);
  await vi.waitFor(() => expect(f.options.updateCard.mock.lastCall?.[1].state).toBe("closed"));
  for (const view of [...f.requestApproval.mock.calls.map(([view]) => view), ...f.options.updateCard.mock.calls.map(([, view]) => view)]) {
    expect(view).toMatchObject({ terminalId: management.terminalId, reopenToken: management.reopenToken, reopenUrl: management.reopenUrl });
  }
  expect(f.spawn).toHaveBeenCalledOnce(); expect(f.pty.kill).toHaveBeenCalledOnce();
});

test("failed recovery notifications, invalid links and wrong cards cannot disturb the running Shell", async () => {
  const f = await fixture(); const original = await f.request(); const management = f.authorization(); await f.approve();
  const first = await f.connect(original); await vi.waitFor(() => expect(first.messages[0]?.type).toBe("ready"));
  f.tick(11_000); const launch = new URL(management.reopenUrl).pathname;
  const forged = launch.slice(0, -1);
  expect((await f.post("request", { launch: forged, browserKey: f.browserKey })).status).toBe(400);
  expect((await f.fetchPage(new URL(forged, f.base))).status).toBe(404);
  f.requestApproval.mockRejectedValueOnce(new Error("private chat unavailable"));
  expect((await f.post("request", { launch, browserKey: f.browserKey })).status).toBe(400);
  expect(await (await f.post("status", original)).json()).toMatchObject({ state: "running" });
  f.tick(11_000);
  const response = await f.post("request", { launch, browserKey: f.browserKey });
  expect(response.status).toBe(200);
  await expect(f.approve({ messageId: "approval-card" })).rejects.toThrow();
  await expect(f.approve({ userId: "ou_intruder" })).rejects.toThrow();
  const closePending = { requestId: f.authorization().requestId, token: f.authorization().approvalToken, decision: "close" };
  await f.approve({ value: closePending });
  expect(f.pty.kill).not.toHaveBeenCalled(); expect(f.server.activeCount).toBe(1);
});

test("terminal close invalidates pending recovery and late approvals never respawn it", async () => {
  const f = await fixture(); const original = await f.request(); const management = f.authorization(); await f.approve();
  const first = await f.connect(original); await vi.waitFor(() => expect(first.messages[0]?.type).toBe("ready"));
  f.tick(11_000);
  const response = await f.post("request", { launch: new URL(management.reopenUrl).pathname, browserKey: f.browserKey });
  const recovery = { ...await response.json() as { requestId: string }, browserKey: f.browserKey };
  await f.post("close", original);
  await expect(f.approve()).rejects.toThrow();
  expect(await (await f.post("status", recovery)).json()).toMatchObject({ state: "closed" });
  const c = await f.connect(recovery); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("error"));
  expect(f.spawn).toHaveBeenCalledOnce();
});

test("failed management-card updates can be retried and never prevent owner closure", async () => {
  const f = await fixture(); const original = await f.request(); await f.approve();
  const c = await f.connect(original); await vi.waitFor(() => expect(c.messages[0]?.type).toBe("ready"));
  f.options.updateCard.mockRejectedValueOnce(new Error("temporary network failure"));
  await f.approve({ value: { requestId: f.authorization().requestId, token: f.authorization().approvalToken, decision: "refresh" } });
  expect(f.options.logger.warn).toHaveBeenCalledWith({ requestId: original.requestId }, "Failed to update terminal management card.");
  await f.approve({ value: { requestId: f.authorization().requestId, token: f.authorization().approvalToken, decision: "close" } });
  expect(f.pty.kill).toHaveBeenCalledOnce();
  expect(f.options.updateCard.mock.lastCall?.[1].state).toBe("closed");
});
