import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { LocalFileViewerServer } from "../local-files/LocalFileViewerServer.js";
import { createRequire } from "node:module";
import path from "node:path";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { CardAction } from "../feishu/types.js";
import { spawnTerminal, type TerminalProcess, type TerminalSpawner } from "./TerminalProcess.js";
import { terminalPage, TERMINAL_CSS, TERMINAL_SCRIPT } from "./TerminalPage.js";
import { TerminalLinks } from "./TerminalLinks.js";

const require = createRequire(import.meta.url);
const AUTH_TTL = 5 * 60_000;
const IDLE_TTL = 30 * 60_000;
const DISCONNECT_TTL = 3 * 60_000;
const FOREGROUND_TTL = 90_000;
const MAX_TTL = 8 * 60 * 60_000;
const KEY = z.string().regex(/^[a-f0-9]{64}$/u);
const credentials = z.object({ requestId: z.string().regex(/^[a-f0-9]{32}$/u), browserKey: KEY });
const frame = z.discriminatedUnion("type", [
  credentials.extend({ type: z.literal("auth") }),
  z.object({ type: z.literal("input"), data: z.string().max(32_768) }),
  z.object({ type: z.literal("resize"), cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(200) }),
  z.object({ type: z.literal("visibility"), foreground: z.boolean() }),
]);

export interface TerminalAuthorization {
  requestId: string; approvalToken: string; code: string; cwd: string; expiresAt: number;
}
export interface TerminalCardView extends TerminalAuthorization {
  contextKey: string; commandCardMessageId: string; shellStarted: boolean;
  terminalId: string; reopenToken: string; reopenUrl: string; recovery: boolean; state: "pending" | "approved" | "running" | "closed";
  connected: boolean; message?: string;
}
export interface TerminalServerOptions {
  stateDirectory: string;
  ownerId(): string | undefined;
  canStart?(): boolean;
  readJob(jobId: string): Promise<{ cwd: string; contextKey: string; cardMessageId?: string }>;
  requestApproval(authorization: TerminalCardView): Promise<string | undefined>;
  updateCard?(messageId: string, view: TerminalCardView): Promise<void>;
  logger: Pick<Logger, "info" | "warn">;
  spawn?: TerminalSpawner;
  now?: () => number;
}
interface TerminalSession extends TerminalAuthorization {
  reopenToken: string;
  contextKey: string; commandCardMessageId: string;
  ownerId: string; keyHash: Buffer; createdAt: number; lastActivity: number;
  activeAccessId: string;
  state: "pending" | "approved" | "running" | "closed";
  message?: string; cardId?: string; pty?: TerminalProcess; socket?: WebSocket;
  starting?: Promise<void>; output: string;
  attached?: boolean;
  disconnectedAt?: number;
  disconnectTimer?: NodeJS.Timeout;
  foregroundUntil?: number;
  approvalObserved?: boolean;
}
interface TerminalRecovery extends TerminalAuthorization {
  targetId: string; ownerId: string; keyHash: Buffer; cardId?: string;
  state: "pending" | "approved" | "closed"; message?: string;
}

export class TerminalServer {
  private unmount?: () => void;
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly recoveries = new Map<string, TerminalRecovery>();
  private cardUpdates = Promise.resolve();
  private readonly requests: number[] = [];
  private timer?: NodeJS.Timeout;
  private links?: TerminalLinks;
  private base?: URL;
  private closed = false;
  private lastUpgradeWarning = -Infinity;
  private readonly now: () => number;

  constructor(private readonly options: TerminalServerOptions) { this.now = options.now ?? Date.now; }

  async start(viewer: LocalFileViewerServer): Promise<string> {
    if (this.closed) throw new Error("Terminal server is closed.");
    if (this.base) return this.base.toString();
    fs.mkdirSync(this.options.stateDirectory, { recursive: true });
    const secretPath = path.join(this.options.stateDirectory, "secret");
    if (!fs.existsSync(secretPath)) fs.writeFileSync(secretPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    const secret = fs.readFileSync(secretPath);
    if (secret.length !== 32) throw new Error("Invalid terminal link secret.");
    this.links = new TerminalLinks(path.join(this.options.stateDirectory, "open-links"), secret);
    const mounted = viewer.mountService("terminal", {
      handleRequest: (req, res) => {
        void this.handleRequest(req, res).catch((error: unknown) => {
          this.options.logger.warn({ error: error instanceof Error ? error.message : String(error) }, "Terminal HTTP request failed.");
          if (res.headersSent) res.destroy();
          else this.json(res, 400, { error: error instanceof Error ? error.message : "Terminal request failed." });
        });
      },
      handleUpgrade: (req, socket, head) => this.handleUpgrade(req, socket, head),
      close: () => this.close(),
    });
    this.base = new URL(mounted.publicBaseUrl);
    this.unmount = mounted.unmount;
    this.timer = setInterval(() => this.sweep(), 30_000); this.timer.unref();
    return this.base.toString();
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.closed || !this.validOrigin(req) || req.url !== `${this.basePath}/socket` || this.sockets.clients.size >= 20) {
      if (this.now() - this.lastUpgradeWarning >= 10_000) {
        this.lastUpgradeWarning = this.now();
        this.options.logger.warn({ stage: "upgrade", hostMatches: req.headers.host === this.base?.host,
          originMatches: req.headers.origin === this.base?.origin }, "Terminal WebSocket upgrade rejected.");
      }
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    this.sockets.handleUpgrade(req, socket, head, (ws) => this.connect(ws));
  }

  createUrl(jobId: string): string | undefined {
    if (this.closed || !this.base || !this.links || !this.options.ownerId() || !/^[a-f0-9-]{36}$/u.test(jobId)) return undefined;
    try { return `${this.base.origin}${this.basePath}/${this.links.create(jobId)}`; }
    catch (error) {
      this.options.logger.warn({ code: (error as NodeJS.ErrnoException).code }, "Failed to create terminal short link.");
      return undefined;
    }
  }

  get activeCount(): number {
    return [...this.sessions.values()].filter((s) => s.pty || s.starting).length;
  }

  async resolveApproval(action: CardAction): Promise<string> {
    this.sweep();
    const id = String(action.value.requestId ?? "");
    const recovery = this.recoveries.get(id);
    const authorization = recovery ?? this.sessions.get(id);
    if (!authorization || action.userId !== this.options.ownerId() || action.userId !== authorization.ownerId
      || !authorization.cardId || action.messageId !== authorization.cardId
      || !equalText(authorization.approvalToken, String(action.value.token ?? ""))) throw new Error("终端授权无效或已过期。");
    const session = this.sessions.get(recovery?.targetId ?? id);
    if (!session) throw new Error("终端已结束或服务已重启，请从命令卡片创建新终端。");
    if (action.value.decision === "refresh") {
      this.publishCards(session); await this.cardUpdates; return "已刷新终端管理卡。";
    }
    if (action.value.decision === "close") {
      if (recovery && recovery.state !== "approved") this.closeRecovery(recovery, "恢复连接请求已取消");
      else this.disposeSession(session, "所有者已在飞书关闭终端");
      this.publishCards(session); await this.cardUpdates;
      return recovery?.state === "closed" && session.state !== "closed" ? "恢复连接请求已取消，原终端不受影响。" : "终端已关闭。";
    }
    if (authorization.state !== "pending") throw new Error("该终端授权已处理或过期，请查看原会话中的终端管理卡。");
    if (action.value.decision === "allow") {
      if (recovery) {
        if (!this.canReopen(session)) throw new Error("原终端已结束，不能恢复。");
        if (session.state === "approved") {
          this.assertCanStart();
          session.expiresAt = this.now() + AUTH_TTL;
        }
        for (const other of this.recoveries.values()) {
          if (other.targetId === session.requestId && other !== recovery && other.state !== "closed") this.closeRecovery(other, "已由另一网页恢复连接");
        }
        recovery.state = "approved"; session.activeAccessId = recovery.requestId;
        session.socket?.close(1000, "Reconnected from another page"); session.socket = undefined;
        this.markDisconnected(session);
      } else session.state = "approved";
      this.publishCards(session); await this.cardUpdates;
      this.options.logger.info({ requestId: session.requestId }, "Terminal authorized by owner.");
      return session.state === "approved"
        ? "已授权，请返回网页连接；若原网页已关闭，点击本卡片的“打开终端”。"
        : "已授权，请返回网页；也可点击本卡片的“重新打开终端”或“关闭终端”。";
    }
    if (action.value.decision !== "deny") throw new Error("无效的终端授权操作。");
    if (recovery) this.closeRecovery(recovery, "恢复连接已拒绝，原终端不受影响");
    else this.disposeSession(session, "终端授权已拒绝");
    this.publishCards(session); await this.cardUpdates;
    return "已拒绝终端连接。";
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer);
    this.unmount?.(); this.unmount = undefined;
    for (const s of this.sessions.values()) this.disposeSession(s, "AgentBot 正在关闭，终端已结束");
    for (const ws of this.sockets.clients) ws.terminate();
    await Promise.all([...this.sessions.values()].map((s) => s.starting?.catch(() => undefined)));
    await this.cardUpdates;
    this.sockets.close();
    this.base = undefined;
  }

  private get basePath(): string { return this.base?.pathname.replace(/[/]$/u, "") ?? ""; }
  private reopenUrl(session: TerminalSession): string {
    return `${this.base!.origin}${this.basePath}/${session.reopenToken}`;
  }
  private canReopen(session: TerminalSession): boolean {
    return session.state === "approved" || (session.state === "running" && Boolean(session.pty));
  }
  private markDisconnected(session: TerminalSession): void {
    if (session.state !== "running" || session.socket || session.disconnectedAt !== undefined) return;
    this.leaveForeground(session);
    session.disconnectedAt = this.now();
    const expire = () => {
      if (session.state !== "running" || session.socket || session.disconnectedAt === undefined) return;
      const remaining = DISCONNECT_TTL - (this.now() - session.disconnectedAt);
      if (remaining <= 0) this.disposeSession(session, "网页已断开 3 分钟，Shell 已自动关闭");
      else { session.disconnectTimer = setTimeout(expire, remaining); session.disconnectTimer.unref(); }
    };
    session.disconnectTimer = setTimeout(expire, DISCONNECT_TTL); session.disconnectTimer.unref();
  }
  private clearDisconnectTimer(session: TerminalSession): void {
    clearTimeout(session.disconnectTimer); session.disconnectTimer = undefined; session.disconnectedAt = undefined;
  }
  private leaveForeground(session: TerminalSession): void {
    if (session.foregroundUntil !== undefined) {
      session.lastActivity = Math.max(session.lastActivity, Math.min(this.now(), session.foregroundUntil));
      session.foregroundUntil = undefined;
    }
  }
  private resumeId(launch: string): string | undefined {
    if (!launch.startsWith(`${this.basePath}/`)) return undefined;
    const token = /^[/]([A-Za-z0-9_-]{8})$/u.exec(launch.slice(this.basePath.length));
    return token ? [...this.sessions.values()].find((session) => session.reopenToken === token[1])?.requestId : undefined;
  }
  private cardView(session: TerminalSession, recovery?: TerminalRecovery): TerminalCardView {
    const auth = recovery ?? session;
    const state = recovery && recovery.state !== "approved" ? recovery.state : session.state;
    return { requestId: auth.requestId, approvalToken: auth.approvalToken, code: auth.code, cwd: session.cwd,
      contextKey: session.contextKey, commandCardMessageId: session.commandCardMessageId, shellStarted: Boolean(session.pty),
      expiresAt: auth.expiresAt, terminalId: session.requestId, reopenToken: session.reopenToken, reopenUrl: this.reopenUrl(session), recovery: Boolean(recovery), state,
      connected: session.socket?.readyState === WebSocket.OPEN, message: recovery?.message ?? session.message };
  }
  private publishCards(session: TerminalSession): void {
    if (!this.options.updateCard || !this.base) return;
    for (const auth of [session, ...[...this.recoveries.values()].filter((r) => r.targetId === session.requestId)]) {
      const cardId = auth.cardId; if (!cardId) continue;
      const view = this.cardView(session, "targetId" in auth ? auth : undefined);
      this.cardUpdates = this.cardUpdates.then(() => this.options.updateCard!(cardId, view)).catch(() => {
        this.options.logger.warn({ requestId: auth.requestId }, "Failed to update terminal management card.");
      });
    }
  }
  private closeRecovery(recovery: TerminalRecovery, message: string): void {
    recovery.state = "closed"; recovery.message = message;
  }
  private validOrigin(req: IncomingMessage): boolean {
    return Boolean(this.base && req.headers.host === this.base.host && req.headers.origin === this.base.origin);
  }
  private launchJob(launch: string): string | undefined {
    if (!launch.startsWith(`${this.basePath}/`)) return undefined;
    const token = /^[/]([A-Za-z0-9_-]{8})$/u.exec(launch.slice(this.basePath.length));
    return token ? this.links?.resolve(token[1]!) : undefined;
  }
  private access(value: unknown): { authorization: TerminalSession | TerminalRecovery; session: TerminalSession } {
    const parsed = credentials.parse(value);
    this.sweep();
    const recovery = this.recoveries.get(parsed.requestId);
    const authorization = recovery ?? this.sessions.get(parsed.requestId);
    const session = this.sessions.get(recovery?.targetId ?? parsed.requestId);
    if (!authorization || !session || !timingSafeEqual(authorization.keyHash, hash(parsed.browserKey))
      || (!recovery && session.activeAccessId !== parsed.requestId)) throw new Error("终端凭证无效或已由其他网页恢复，请从原会话的终端管理卡重新打开。");
    return { authorization, session };
  }
  private authenticated(value: unknown): TerminalSession {
    const { authorization, session } = this.access(value);
    if (authorization.state === "pending" || authorization.state === "closed" || session.activeAccessId !== authorization.requestId) {
      throw new Error("终端尚未授权、已结束或已由其他网页恢复。");
    }
    return session;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.base || req.headers.host !== this.base.host) { this.json(res, 403, { error: "Invalid Host." }); return; }
    const url = new URL(req.url ?? "/", this.base);
    if (url.search || !url.pathname.startsWith(`${this.basePath}/`)) { this.json(res, 404, { error: "Not found." }); return; }
    const route = url.pathname.slice(this.basePath.length);
    this.sweep();
    if (req.method === "GET" || req.method === "HEAD") {
      let body: string | undefined; let type = "text/javascript; charset=utf-8";
      if (route === "/assets/terminal.js") body = TERMINAL_SCRIPT;
      else if (route === "/assets/terminal.css") { body = TERMINAL_CSS; type = "text/css"; }
      else if (route === "/assets/xterm.js") body = fs.readFileSync(require.resolve("@xterm/xterm"), "utf8");
      else if (route === "/assets/fit.js") body = fs.readFileSync(require.resolve("@xterm/addon-fit"), "utf8");
      else if (route === "/assets/xterm.css") {
        body = fs.readFileSync(path.join(path.dirname(require.resolve("@xterm/xterm")), "../css/xterm.css"), "utf8"); type = "text/css";
      } else {
        const resumeId = this.resumeId(url.pathname);
        if (this.launchJob(url.pathname) || resumeId) { body = terminalPage(this.basePath, Boolean(resumeId)); type = "text/html; charset=utf-8"; }
      }
      this.headers(res); res.statusCode = body === undefined ? 404 : 200; res.setHeader("Content-Type", type);
      res.end(req.method === "HEAD" ? undefined : body ?? "Not found."); return;
    }
    if (req.method !== "POST" || !this.validOrigin(req) || req.headers["content-type"] !== "application/json") {
      this.json(res, 403, { error: "Origin or request method rejected." }); return;
    }
    const data = await readJson(req);
    if (route === "/api/request") {
      const parsed = z.object({ launch: z.string().max(300), browserKey: KEY }).parse(data);
      const resumeId = this.resumeId(parsed.launch);
      const jobId = this.launchJob(parsed.launch);
      const ownerId = this.options.ownerId();
      if ((!jobId && !resumeId) || !ownerId) throw new Error("终端链接无效，或尚未配置飞书所有者。");
      const existing = resumeId ? this.sessions.get(resumeId) : undefined;
      if (resumeId && (!existing || !this.canReopen(existing) || existing.ownerId !== ownerId)) {
        throw new Error("原终端尚未授权、已结束或服务已重启；请从原命令卡片创建新终端。");
      }
      if (!existing || existing.state === "approved") this.assertCanStart();
      const now = this.now();
      while (this.requests[0] !== undefined && this.requests[0] < now - 3600_000) this.requests.shift();
      if (this.requests.length >= 20 || (this.requests.length > 0 && now - this.requests.at(-1)! < 10_000)
        || (existing ? [...this.recoveries.values()].filter((r) => r.state === "pending").length >= 3
          : [...this.sessions.values()].filter((s) => s.state !== "closed").length >= 3)) {
        this.json(res, 429, { error: "终端请求过于频繁或已达 3 个会话上限，请稍后重试。" }); return;
      }
      this.requests.push(now);
      if (existing) {
        const recovery: TerminalRecovery = { requestId: randomBytes(16).toString("hex"), targetId: existing.requestId, ownerId,
          keyHash: hash(parsed.browserKey), approvalToken: randomBytes(32).toString("hex"), code: String(randomInt(100000, 1000000)),
          cwd: existing.cwd, expiresAt: now + AUTH_TTL, state: "pending" };
        this.recoveries.set(recovery.requestId, recovery);
        try {
          recovery.cardId = await this.options.requestApproval(this.cardView(existing, recovery));
          if (!recovery.cardId) throw new Error("无法发送飞书授权卡片。");
        } catch (error) { this.closeRecovery(recovery, "恢复授权通知失败"); throw error; }
        if (existing.state !== "running" || recovery.state !== "pending") this.publishCards(existing);
        this.json(res, 200, { requestId: recovery.requestId, code: recovery.code }); return;
      }
      const job = await this.options.readJob(jobId!);
      this.assertCanStart();
      if (!job.cardMessageId || !job.contextKey?.trim()) throw new Error("命令卡片或原始会话信息尚未就绪。");
      const requestId = randomBytes(16).toString("hex");
      const session: TerminalSession = { requestId, reopenToken: this.links!.createRecovery(), activeAccessId: requestId, ownerId, cwd: job.cwd, keyHash: hash(parsed.browserKey),
        contextKey: job.contextKey, commandCardMessageId: job.cardMessageId,
        approvalToken: randomBytes(32).toString("hex"), code: String(randomInt(100000, 1000000)),
        createdAt: now, lastActivity: now, expiresAt: now + AUTH_TTL, state: "pending", output: "" };
      this.sessions.set(requestId, session);
      try {
        session.cardId = await this.options.requestApproval(this.cardView(session));
        if (!session.cardId) throw new Error("无法发送飞书授权卡片。");
        if (session.state !== "pending") this.publishCards(session);
      } catch (error) { this.disposeSession(session, "授权通知失败"); throw error; }
      this.json(res, 200, { requestId, code: session.code }); return;
    }
    if (route !== "/api/status" && route !== "/api/close") { this.json(res, 404, { error: "Not found." }); return; }
    const { authorization, session } = this.access(data);
    if ("targetId" in authorization && authorization.state !== "approved") {
      if (route === "/api/close") { this.closeRecovery(authorization, "恢复连接请求已取消"); this.publishCards(session); }
      this.json(res, 200, { state: authorization.state, message: authorization.message }); return;
    }
    if (route === "/api/status" && session.state === "approved" && !session.approvalObserved) {
      session.approvalObserved = true;
      this.options.logger.info({ requestId: session.requestId }, "Terminal approval observed by browser.");
    }
    if (route === "/api/close") this.disposeSession(session, "终端已关闭");
    this.json(res, 200, { state: session.state, message: session.message });
  }

  private connect(ws: WebSocket): void {
    let session: TerminalSession | undefined; let authenticating = false; let accessId: string | undefined;
    const timeout = setTimeout(() => {
      this.options.logger.warn({ stage: "auth_timeout" }, "Terminal WebSocket authentication timed out.");
      this.send(ws, { type: "error", stage: "auth", message: "终端连接鉴权超时，请重新连接。" });
      ws.close(1008, "Authentication required");
    }, 5000); timeout.unref();
    ws.on("error", () => ws.terminate());
    ws.on("close", () => {
      clearTimeout(timeout);
      if (session?.socket === ws) { session.socket = undefined; this.markDisconnected(session); this.publishCards(session); }
    });
    ws.on("message", (data, binary) => {
      let stage = "protocol";
      let requestId: string | undefined;
      void (async () => {
        if (binary) throw new Error("Binary input rejected.");
        let parsed: unknown;
        try { parsed = JSON.parse(data.toString()) as unknown; } catch { throw new Error("Invalid terminal JSON frame."); }
        const value = frame.parse(parsed);
        if (!session) {
          stage = "auth";
          if (authenticating || value.type !== "auth") throw new Error("Authentication required.");
          authenticating = true; const target = this.authenticated(value);
          if (target.state !== "approved" && target.state !== "running") throw new Error("终端尚未授权或已结束。");
          requestId = target.requestId;
          clearTimeout(timeout);
          this.options.logger.info({ requestId }, "Terminal WebSocket authenticated.");
          stage = "spawn";
          await this.ensureProcess(target);
          if (ws.readyState !== WebSocket.OPEN) return;
          if (target.activeAccessId !== value.requestId) throw new Error("终端已由其他网页恢复。");
          if (target.state !== "running") throw new Error(target.message ?? "终端已结束。");
          target.socket?.close(1000, "Reconnected from another page");
          session = target; session.socket = ws; accessId = value.requestId; clearTimeout(timeout);
          this.clearDisconnectTimer(session);
          session.lastActivity = this.now();
          session.foregroundUntil = undefined;
          // Only the first attachment may answer buffered Shell startup queries.
          this.send(ws, { type: "ready", cwd: session.cwd, output: session.output, replay: session.attached === true });
          session.attached = true;
          this.publishCards(session);
          return;
        }
        if (session.state !== "running" || session.socket !== ws || session.activeAccessId !== accessId) throw new Error("Terminal is closed.");
        if (value.type === "input") { session.lastActivity = this.now(); session.pty?.write(value.data); }
        else if (value.type === "resize") session.pty?.resize(value.cols, value.rows);
        else if (value.type === "visibility") {
          if (value.foreground) session.foregroundUntil = this.now() + FOREGROUND_TTL;
          else this.leaveForeground(session);
        }
        else throw new Error("Already authenticated.");
      })().catch((error: unknown) => {
        clearTimeout(timeout);
        this.options.logger.warn({ requestId, stage }, "Terminal WebSocket request failed.");
        this.send(ws, { type: "error", stage, message: error instanceof Error ? error.message : "Terminal error" });
        ws.close(1008, "Terminal request rejected");
      });
    });
  }

  private async ensureProcess(session: TerminalSession): Promise<void> {
    if (session.pty) return;
    if (session.starting) return session.starting;
    this.assertCanStart();
    const starting = (async () => {
      const pty = await (this.options.spawn ?? spawnTerminal)(session.cwd, 100, 30);
      if (this.closed || this.options.canStart?.() === false || session.state === "closed"
        || session.ownerId !== this.options.ownerId() || this.now() >= session.expiresAt) {
        pty.kill(); this.disposeSession(session, "服务正在重启或授权已失效"); return;
      }
      session.pty = pty; session.state = "running"; session.lastActivity = this.now();
      this.markDisconnected(session);
      pty.onData((data) => {
        if (session.state !== "running") return;
        session.lastActivity = this.now();
        session.output = (session.output + data).slice(-256 * 1024);
        if (session.socket) this.send(session.socket, { type: "data", data });
      });
      pty.onExit(({ exitCode }) => { session.pty = undefined; this.disposeSession(session, `Shell 已退出（${exitCode}）`); });
      this.options.logger.info({ requestId: session.requestId }, "Interactive terminal started.");
    })();
    session.starting = starting;
    try { await starting; } catch (error) { this.disposeSession(session, "终端启动失败"); throw error; }
    finally { session.starting = undefined; }
  }
  private assertCanStart(): void {
    if (this.closed || this.options.canStart?.() === false) throw new Error("AgentBot 正在等待重启或关闭，暂时不能创建新终端。");
  }

  private sweep(): void {
    const now = this.now();
    for (const recovery of this.recoveries.values()) {
      const target = this.sessions.get(recovery.targetId);
      if (recovery.state === "pending" && now >= recovery.expiresAt) {
        this.closeRecovery(recovery, "恢复授权已过期，原终端不受影响");
        if (target) this.publishCards(target);
      }
      if (!target || (recovery.state === "closed" && now >= recovery.expiresAt + AUTH_TTL)) this.recoveries.delete(recovery.requestId);
    }
    for (const s of this.sessions.values()) {
      if (s.ownerId !== this.options.ownerId() || now - s.createdAt >= MAX_TTL
        || (s.state !== "running" && s.state !== "closed" && now >= s.expiresAt)) {
        this.disposeSession(s, "终端已超时或授权已失效，请重新连接");
      }
      if (s.state === "running" && s.disconnectedAt !== undefined && now - s.disconnectedAt >= DISCONNECT_TTL) {
        this.disposeSession(s, "网页已断开 3 分钟，Shell 已自动关闭");
      }
      if (s.state === "running" && now - Math.max(s.lastActivity, s.foregroundUntil ?? 0) >= IDLE_TTL) {
        this.disposeSession(s, "连续 30 分钟无输入或输出，Shell 已自动关闭");
      }
      if (s.state === "closed" && !s.starting && now - s.lastActivity >= AUTH_TTL) this.sessions.delete(s.requestId);
    }
  }
  private disposeSession(s: TerminalSession, message: string): void {
    if (s.state === "closed") return;
    this.clearDisconnectTimer(s);
    s.state = "closed"; s.message = message; s.lastActivity = this.now();
    const pty = s.pty; s.pty = undefined;
    if (s.socket) { this.send(s.socket, { type: "exit", message }); s.socket.close(); s.socket = undefined; }
    try { pty?.kill(); } catch (error) { this.options.logger.warn({ error, requestId: s.requestId }, "Failed to close terminal process."); }
    s.output = "";
    for (const recovery of this.recoveries.values()) {
      if (recovery.targetId === s.requestId) this.closeRecovery(recovery, message);
    }
    this.publishCards(s);
  }
  private send(ws: WebSocket, value: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) { ws.close(1013, "Slow consumer"); return; }
    ws.send(JSON.stringify(value));
  }
  private headers(res: ServerResponse): void {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY");
    const socketOrigin = this.base?.origin.replace(/^http/u, "ws") ?? "";
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${socketOrigin}; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  }
  private json(res: ServerResponse, status: number, value: unknown): void {
    this.headers(res); res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(value));
  }
}

function hash(value: string): Buffer { return createHash("sha256").update(value).digest(); }
function equalText(a: string, b: string): boolean { return timingSafeEqual(hash(a), hash(b)); }
async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk); if (Buffer.byteLength(body) > 8192) throw new Error("Request too large.");
  }
  try { return JSON.parse(body) as unknown; }
  catch { throw new Error("Invalid JSON request."); }
}
