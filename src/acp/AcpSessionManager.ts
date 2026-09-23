import path from "node:path";
import type { Logger } from "pino";
import type { AgentConfig } from "../config/schema.js";
import type {
  AcpInitializeResult,
  AcpPermissionRequestParams,
  AcpPromptResult,
  AcpSessionNewResult,
  AcpSessionUpdateParams,
  JsonValue,
} from "./acpTypes.js";
import { AcpProcessManager, type ManagedAcpProcess } from "./AcpProcessManager.js";

export interface RuntimeSession {
  localSessionId: string;
  agentName: string;
  cwd: string;
  acpSessionId: string;
  managed: ManagedAcpProcess;
  running: boolean;
  configOptions?: JsonValue;
  availableCommands?: JsonValue;
  onUpdate: (session: RuntimeSession, update: Record<string, JsonValue>) => void;
  onPermissionRequest: (session: RuntimeSession, params: AcpPermissionRequestParams) => Promise<JsonValue>;
}

export interface CreateRuntimeSessionInput {
  localSessionId: string;
  agentName: string;
  cwd: string;
  onUpdate: (session: RuntimeSession, update: Record<string, JsonValue>) => void;
  onPermissionRequest: (
    session: RuntimeSession,
    params: AcpPermissionRequestParams,
  ) => Promise<JsonValue>;
}

export class AcpSessionManager {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly sessionsByAcpId = new Map<string, RuntimeSession>();
  private processStart?: Promise<ManagedAcpProcess>;
  private processVersion?: string;

  constructor(
    private readonly agentName: string,
    private readonly agent: AgentConfig,
    private readonly processManager: AcpProcessManager,
    private readonly logger: Logger,
  ) {}

  get(localSessionId: string): RuntimeSession | undefined {
    return this.sessions.get(localSessionId);
  }

  getProcessInfo(): { pid?: number; version?: string } {
    const pid = this.processManager.get(this.agentName)?.child.pid;
    if (!pid) return {};
    return {
      pid,
      ...(this.processVersion ? { version: this.processVersion } : {}),
    };
  }

  async create(input: CreateRuntimeSessionInput): Promise<RuntimeSession> {
    if (input.agentName !== this.agentName) throw new Error(`Unexpected agent: ${input.agentName}`);

    const cwd = path.resolve(input.cwd);
    const managed = await this.process();
    const connection = managed.connection;

    const newSessionResult = await connection.request<AcpSessionNewResult>("session/new", {
      cwd,
      mcpServers: [],
    });

    const runtime: RuntimeSession = {
      localSessionId: input.localSessionId,
      agentName: input.agentName,
      cwd,
      acpSessionId: newSessionResult.sessionId,
      managed,
      running: false,
      configOptions: newSessionResult.configOptions,
      onUpdate: input.onUpdate,
      onPermissionRequest: input.onPermissionRequest,
    };

    this.sessions.set(input.localSessionId, runtime);
    this.sessionsByAcpId.set(runtime.acpSessionId, runtime);
    return runtime;
  }

  async prompt(localSessionId: string, text: string): Promise<AcpPromptResult> {
    const session = this.requireSession(localSessionId);
    if (session.running) {
      throw new Error(`Session is already running: ${localSessionId}`);
    }

    session.running = true;
    try {
      return await session.managed.connection.request<AcpPromptResult>("session/prompt", {
        sessionId: session.acpSessionId,
        prompt: [
          {
            type: "text",
            text,
          },
        ],
      });
    } finally {
      session.running = false;
    }
  }

  cancel(localSessionId: string): void {
    const session = this.requireSession(localSessionId);
    session.managed.connection.notify("session/cancel", {
      sessionId: session.acpSessionId,
    });
  }

  async close(localSessionId: string): Promise<void> {
    const session = this.requireSession(localSessionId);
    try {
      await session.managed.connection.request(
        "session/close",
        {
          sessionId: session.acpSessionId,
        },
        1500,
      );
    } catch (error) {
      this.logger.debug({ error, localSessionId }, "Ignoring session/close failure.");
    }

    this.sessions.delete(localSessionId);
    this.sessionsByAcpId.delete(session.acpSessionId);
  }

  shutdown(): void {
    this.sessions.clear();
    this.sessionsByAcpId.clear();
    this.processStart = undefined;
    this.processVersion = undefined;
    this.processManager.stopAll();
  }

  async setConfigOption(localSessionId: string, configId: string, value: string): Promise<JsonValue> {
    const session = this.requireSession(localSessionId);
    const result = await session.managed.connection.request<JsonValue>("session/set_config_option", {
      sessionId: session.acpSessionId,
      configId,
      value,
    });

    if (isObject(result) && "configOptions" in result) {
      session.configOptions = result.configOptions;
    }

    return result;
  }

  private requireSession(localSessionId: string): RuntimeSession {
    const session = this.sessions.get(localSessionId);
    if (!session) {
      throw new Error(`Unknown runtime session: ${localSessionId}`);
    }
    return session;
  }

  private async process(): Promise<ManagedAcpProcess> {
    const existing = this.processManager.get(this.agentName);
    if (existing) return existing;
    if (this.processStart) return this.processStart;
    const start = this.startProcess();
    this.processStart = start;
    try {
      return await start;
    } finally {
      if (this.processStart === start) this.processStart = undefined;
    }
  }

  private async startProcess(): Promise<ManagedAcpProcess> {
    this.processVersion = undefined;
    const managed = this.processManager.start(this.agentName, this.agentName, this.agent);
    try {
      const connection = managed.connection;
      connection.registerHandler("session/request_permission", async (params) => {
        const permission = params as unknown as AcpPermissionRequestParams;
        const target = this.sessionsByAcpId.get(permission.sessionId);
        if (!target) throw new Error(`Unknown ACP session requesting permission: ${permission.sessionId}`);
        return target.onPermissionRequest(target, permission);
      });
      connection.on("notification", (method, params) => {
        if (method !== "session/update") return;
        const updateParams = params as unknown as AcpSessionUpdateParams;
        const target = this.sessionsByAcpId.get(updateParams.sessionId);
        if (!target) {
          this.logger.debug({ updateParams }, "Ignoring update for unknown ACP session.");
          return;
        }
        this.applySessionUpdate(target, updateParams.update);
        target.onUpdate(target, updateParams.update);
      });
      const initializeResult = await connection.request<AcpInitializeResult>("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: {
          name: "agent-bot",
          title: "Agent Bot",
          version: "0.1.0",
        },
      });
      const version = initializeResult.agentInfo?.version?.trim();
      if (version) this.processVersion = version;
      if (initializeResult.authMethods?.length) {
        const method = initializeResult.authMethods[0];
        this.logger.info({ methodId: method.id }, "Authenticating ACP agent with first advertised method.");
        await connection.request("authenticate", { methodId: method.id });
      }
      return managed;
    } catch (error) {
      this.processManager.stop(this.agentName);
      throw error;
    }
  }

  private applySessionUpdate(session: RuntimeSession, update: Record<string, JsonValue>): void {
    const updateType = update.sessionUpdate;
    if (updateType === "config_option_update" && "configOptions" in update) {
      session.configOptions = update.configOptions;
    }

    if (updateType === "available_commands_update" && "availableCommands" in update) {
      session.availableCommands = update.availableCommands;
    }
  }
}

function isObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
