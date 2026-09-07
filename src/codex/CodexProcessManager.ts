import type { ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Logger } from "pino";
import { AppServerConnection } from "./AppServerConnection.js";
import type { AppServerClient, AppServerClientProvider } from "./CodexRuntime.js";
import {
  agentBotEnvironment,
  type AgentEnvironmentContext,
} from "../runtime/agentEnvironment.js";
import type { AgentProcessInfo } from "../runtime/types.js";
import { spawnStdioCommand } from "../utils/spawnCommand.js";
import { assertSupportedCodexVersion } from "./CodexVersion.js";

export class CodexProcessManager implements AppServerClientProvider {
  private static readonly RELEASE_TIMEOUT_MS = 5_000;
  private client?: AppServerConnection;
  private child?: ChildProcessWithoutNullStreams;
  private version?: string;
  private agentFamily?: "codex" | "traex";
  private initializing?: Promise<AppServerClient>;
  private readonly disconnectListeners = new Set<(error: Error) => void>();

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
    private readonly logger: Logger,
    private readonly environmentContext: () => AgentEnvironmentContext = () => ({}),
  ) {}

  async getClient(): Promise<AppServerClient> {
    if (this.initializing) return this.initializing;
    if (this.client) return this.client;
    const initialization = this.startClient();
    this.initializing = initialization;
    try {
      return await initialization;
    } finally {
      if (this.initializing === initialization) this.initializing = undefined;
    }
  }

  private async startClient(): Promise<AppServerClient> {
    this.version = undefined;
    const environmentContext = this.environmentContext();
    const child = spawnStdioCommand(
      this.command,
      this.args,
      agentBotEnvironment(process.env, this.env, environmentContext),
      environmentContext.profilePath ?? os.homedir(),
    );
    this.child = child;
    const client = new AppServerConnection(child, this.logger.child({ component: "codex-app-server" }));
    this.client = client;
    readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => {
      this.logger.debug({ line }, "App Server stderr.");
    });
    child.once("error", (error) => this.logger.error({ error }, "App Server process error."));
    child.once("exit", (code, signal) => {
      this.logger.warn({ code, signal }, "App Server process exited.");
      client.close();
      if (this.client === client) this.client = undefined;
      if (this.child === child) this.child = undefined;
      const error = new Error(`App Server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`);
      for (const listener of this.disconnectListeners) listener(error);
    });
    try {
      const initializeResult = await client.request("initialize", {
        clientInfo: { name: "agent-bot", title: "Agent Bot", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      this.version = initializedAgentVersion(initializeResult);
      const userAgent = initializeResult && typeof initializeResult === "object"
        ? (initializeResult as Record<string, unknown>).userAgent : undefined;
      if (!this.getAgentFamily() && typeof userAgent === "string") {
        if (/^codex(?:-cli)?[ /]/iu.test(userAgent)) this.agentFamily = "codex";
        else if (/^trae(?:cli|x)?[ /]/iu.test(userAgent)) this.agentFamily = "traex";
      }
      if (this.getAgentFamily() === "codex") assertSupportedCodexVersion(this.version);
      client.notify("initialized", {});
      return client;
    } catch (error) {
      if (this.client === client) this.close();
      throw error;
    }
  }

  getProcessInfo(): AgentProcessInfo {
    const pid = this.child?.pid;
    if (!pid) return {};
    return {
      pid,
      ...(this.version ? { version: this.version } : {}),
    };
  }

  getAgentFamily(): "codex" | "traex" | undefined {
    if (this.agentFamily) return this.agentFamily;
    const candidates = [this.command, this.args[0], this.environmentContext().agentName];
    for (const value of candidates) {
      const executable = value?.replaceAll("\\", "/").split("/").at(-1) ?? "";
      if (/^codex(?:\.(?:exe|cmd|bat|m?js))?$/iu.test(executable)) return "codex";
      if (/^(?:traex|traecli)(?:\.(?:exe|cmd|bat|m?js))?$/iu.test(executable)) return "traex";
    }
    return undefined;
  }

  getCodexHome(): string {
    return this.env.CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  }

  close(): void {
    this.client?.close();
    if (this.child && !this.child.killed) this.child.kill();
    this.client = undefined;
    this.child = undefined;
  }

  async release(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let forceTimer: NodeJS.Timeout | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        child.off("exit", onExit);
        child.off("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const onExit = (): void => finish();
      const onError = (error: Error): void => finish(error);
      const timer = setTimeout(() => {
        finish(new Error(`Timed out waiting for App Server process ${child.pid ?? "unknown"} to exit.`));
      }, CodexProcessManager.RELEASE_TIMEOUT_MS);
      timer.unref?.();
      child.once("exit", onExit);
      child.once("error", onError);
      try {
        child.stdin.end();
        if (!settled) {
          forceTimer = setTimeout(() => {
            if (!child.killed && !child.kill()) {
              finish(new Error(`Failed to stop App Server process ${child.pid ?? "unknown"}.`));
            }
          }, 1_000);
          forceTimer.unref?.();
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }
}

function initializedAgentVersion(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = value as Record<string, unknown>;
  const serverInfo = result.serverInfo && typeof result.serverInfo === "object"
    ? result.serverInfo as Record<string, unknown>
    : undefined;
  for (const candidate of [serverInfo?.version, result.version, result.userAgent]) {
    if (typeof candidate !== "string") continue;
    const match = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/u.exec(candidate);
    if (match?.[1]) return match[1];
  }
  return undefined;
}
