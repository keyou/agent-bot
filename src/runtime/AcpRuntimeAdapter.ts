import type { JsonValue } from "../acp/acpTypes.js";
import { AcpSessionManager } from "../acp/AcpSessionManager.js";
import { createId } from "../utils/id.js";
import type {
  AgentRuntime,
  AgentProcessInfo,
  ApprovalDecision,
  CreateRuntimeSessionInput,
  ModelOption,
  PermissionMode,
  ResumeRuntimeSessionInput,
  RuntimeSession,
  RuntimeEvent,
  RuntimePrompt,
  RuntimeSessionMetadata,
  ToolState,
} from "./types.js";

interface ActiveAcpTurn {
  turnId: string;
  finalText: string;
}

export class AcpRuntimeAdapter implements AgentRuntime {
  readonly kind = "acp" as const;
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly activeTurns = new Map<string, ActiveAcpTurn>();
  private readonly toolsBySession = new Map<string, Map<string, ToolState>>();
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly approvals = new Map<
    string,
    { sessionId: string; turnId: string; resolve: (value: JsonValue) => void; optionIds: Map<ApprovalDecision, string> }
  >();

  constructor(private readonly acp: AcpSessionManager) {}

  getSession(localSessionId: string): RuntimeSession | undefined {
    return this.sessions.get(localSessionId);
  }

  getProcessInfo(): AgentProcessInfo {
    return this.acp.getProcessInfo();
  }

  async createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSession> {
    const created = await this.acp.create({
      localSessionId: input.localSessionId,
      agentName: input.agentName,
      cwd: input.cwd,
      onUpdate: (_session, update) => this.handleUpdate(input.localSessionId, update),
      onPermissionRequest: (_session, params) =>
        new Promise<JsonValue>((resolve) => {
          const requestId = createId("approval");
          const active = this.activeTurns.get(input.localSessionId);
          const optionIds = new Map<ApprovalDecision, string>();
          for (const option of params.options) {
            if (option.kind.startsWith("allow")) optionIds.set("accept", option.optionId);
            if (option.kind.startsWith("reject") || option.kind.startsWith("deny")) {
              optionIds.set("decline", option.optionId);
            }
          }
          const turnId = active?.turnId ?? "unknown";
          this.approvals.set(requestId, { sessionId: input.localSessionId, turnId, resolve, optionIds });
          this.emit({
            type: "approval_requested",
            sessionId: input.localSessionId,
            turnId,
            request: {
              id: requestId,
              title: typeof params.toolCall.title === "string" ? params.toolCall.title : "ACP permission request",
              options: [
                { id: "accept", label: "允许" },
                { id: "decline", label: "拒绝" },
              ],
            },
          });
        }),
    });
    const session: RuntimeSession = {
      localSessionId: input.localSessionId,
      remoteSessionId: created.acpSessionId,
      runtimeKind: "acp",
      agentName: input.agentName,
      cwd: input.cwd,
      title: input.title,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      permissionMode: input.permissionMode,
    };
    this.sessions.set(input.localSessionId, session);
    return session;
  }

  async resumeSession(input: ResumeRuntimeSessionInput): Promise<RuntimeSession> {
    return this.createSession(input);
  }

  async readSessionMetadata(_remoteSessionId: string): Promise<RuntimeSessionMetadata> {
    return {};
  }

  async synchronizeSession(sessionId: string): Promise<RuntimeSession> {
    return this.requireSession(sessionId);
  }

  async startTurn(sessionId: string, prompt: RuntimePrompt): Promise<string> {
    const { text, localImagePaths } = normalizeRuntimePrompt(prompt);
    if (localImagePaths.length > 0) {
      throw new Error("当前 ACP Agent 不支持图片输入，请切换到支持图片输入的 App Server Agent 后重试。");
    }
    const session = this.requireSession(sessionId);
    const turnId = createId("turn");
    session.activeTurnId = turnId;
    this.activeTurns.set(sessionId, { turnId, finalText: "" });
    this.toolsBySession.set(sessionId, new Map());
    this.emit({ type: "turn_started", sessionId, turnId, startedAt: Date.now() });
    void this.acp.prompt(sessionId, text).then(
      () => {
        const active = this.activeTurns.get(sessionId);
        if (!active || active.turnId !== turnId) return;
        session.activeTurnId = undefined;
        this.activeTurns.delete(sessionId);
        this.toolsBySession.delete(sessionId);
        this.emit({ type: "turn_completed", sessionId, turnId, finalResponse: active.finalText });
      },
      (error: unknown) => {
        session.activeTurnId = undefined;
        this.activeTurns.delete(sessionId);
        this.toolsBySession.delete(sessionId);
        this.emit({
          type: "turn_failed",
          sessionId,
          turnId,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return turnId;
  }

  async steerTurn(_sessionId: string, _turnId: string, _prompt: RuntimePrompt): Promise<void> {
    throw new Error("ACP runtime does not support steering an active turn.");
  }

  async cancelTurn(sessionId: string, turnId: string): Promise<void> {
    this.acp.cancel(sessionId);
    const session = this.requireSession(sessionId);
    session.activeTurnId = undefined;
    this.activeTurns.delete(sessionId);
    this.toolsBySession.delete(sessionId);
    this.emit({ type: "turn_cancelled", sessionId, turnId });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.acp.close(sessionId);
    this.sessions.delete(sessionId);
    this.activeTurns.delete(sessionId);
    this.toolsBySession.delete(sessionId);
  }

  async setTitle(sessionId: string, title: string): Promise<void> {
    this.requireSession(sessionId).title = title;
  }

  async setModel(): Promise<void> {
    throw new Error("ACP runtime does not expose model selection through Agent Bot.");
  }

  async setReasoningEffort(_sessionId: string, _effort: string): Promise<void> {
    throw new Error("ACP runtime does not expose reasoning effort through Agent Bot.");
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    this.requireSession(sessionId).permissionMode = mode;
  }

  async respondToApproval(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const pending = this.approvals.get(requestId);
    if (!pending || pending.sessionId !== sessionId) {
      throw new Error("Approval request is no longer pending.");
    }
    this.approvals.delete(requestId);
    const optionId = pending.optionIds.get(decision) ?? pending.optionIds.get(decision === "cancel" ? "decline" : "accept");
    pending.resolve({ outcome: { outcome: "selected", optionId: optionId ?? decision } });
    this.emit({ type: "approval_resolved", sessionId, turnId: pending.turnId, requestId, decision });
  }

  async listModels(): Promise<ModelOption[]> {
    return [];
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.acp.shutdown();
    this.sessions.clear();
    this.activeTurns.clear();
    this.toolsBySession.clear();
    this.approvals.clear();
  }

  private handleUpdate(sessionId: string, update: Record<string, JsonValue>): void {
    const active = this.activeTurns.get(sessionId);
    if (!active) return;
    const updateType = update.sessionUpdate;
    if (updateType === "agent_message_chunk" && isRecord(update.content) && typeof update.content.text === "string") {
      active.finalText += update.content.text;
      this.emit({ type: "agent_text_delta", sessionId, turnId: active.turnId, text: update.content.text });
      return;
    }
    if (updateType === "tool_call" || updateType === "tool_call_update") {
      const id = typeof update.toolCallId === "string" ? update.toolCallId : createId("tool");
      const tools = this.toolsBySession.get(sessionId) ?? new Map<string, ToolState>();
      this.toolsBySession.set(sessionId, tools);
      const previous = tools.get(id);
      const rawInput = recordField(update, "rawInput");
      const command = stringField(rawInput, "command") ?? previous?.command;
      const description = stringField(rawInput, "description");
      const status = update.status === "failed" ? "failed" : update.status === "completed" ? "completed" : "running";
      const output = extractToolOutput(update) ?? previous?.output;
      const error = extractToolError(update, status, output) ?? previous?.error;
      const tool: ToolState = {
        ...previous,
        id,
        title: description ?? (typeof update.title === "string" ? update.title : previous?.title) ?? command ?? "ACP tool",
        kind: typeof update.kind === "string" ? update.kind : previous?.kind ?? (command ? "command" : "tool"),
        status,
        command,
        output: status === "failed" ? previous?.output : output,
        error,
        exitCode: extractExitCode(update) ?? previous?.exitCode,
      };
      tools.set(id, tool);
      this.emit({
        type: updateType === "tool_call" ? "tool_started" : "tool_updated",
        sessionId,
        turnId: active.turnId,
        tool,
      });
    }
  }

  private requireSession(sessionId: string): RuntimeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown runtime session: ${sessionId}`);
    return session;
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(record: Record<string, JsonValue> | undefined, key: string): Record<string, JsonValue> | undefined {
  const value = field(record, key);
  return isRecord(value) ? value : undefined;
}

function stringField(record: Record<string, JsonValue> | undefined, key: string): string | undefined {
  const value = field(record, key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(record: Record<string, JsonValue> | undefined, key: string): number | undefined {
  const value = field(record, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function field(record: Record<string, JsonValue> | undefined, key: string): JsonValue | undefined {
  if (!record) return undefined;
  const normalizedKey = normalizeKey(key);
  const entry = Object.entries(record).find(([candidate]) => normalizeKey(candidate) === normalizedKey);
  return entry?.[1];
}

function normalizeKey(value: string): string {
  return value.replaceAll(/[_-]/g, "").toLowerCase();
}

function extractToolOutput(update: Record<string, JsonValue>): string | undefined {
  const content = update.content;
  if (Array.isArray(content)) {
    const text = content
      .flatMap((item) => {
        if (!isRecord(item)) return [];
        const nested = recordField(item, "content");
        const value = stringField(nested, "text") ?? stringField(item, "text");
        return value ? [value] : [];
      })
      .join("\n")
      .trim();
    if (text) return text;
  }

  const output = recordField(recordField(update, "rawOutput"), "output") ?? recordField(update, "rawOutput");
  const stdout = stringField(output, "stdout");
  const stderr = stringField(output, "stderr");
  const combined = [stdout, stderr].filter((value): value is string => Boolean(value)).join("\n").trim();
  return combined || undefined;
}

function extractToolError(
  update: Record<string, JsonValue>,
  status: ToolState["status"],
  output: string | undefined,
): string | undefined {
  const direct = typeof update.error === "string" ? update.error : undefined;
  if (direct) return direct;
  if (status !== "failed") return undefined;
  const outputRecord = recordField(recordField(update, "rawOutput"), "output") ?? recordField(update, "rawOutput");
  return stringField(outputRecord, "stderr") ?? output;
}

function extractExitCode(update: Record<string, JsonValue>): number | undefined {
  const output = recordField(recordField(update, "rawOutput"), "output") ?? recordField(update, "rawOutput");
  return numberField(output, "exitCode") ?? numberField(output, "code");
}

function normalizeRuntimePrompt(prompt: RuntimePrompt): { text: string; localImagePaths: string[] } {
  return typeof prompt === "string"
    ? { text: prompt, localImagePaths: [] }
    : { text: prompt.text, localImagePaths: prompt.localImagePaths ?? [] };
}
