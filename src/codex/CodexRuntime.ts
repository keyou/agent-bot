import type { Logger } from "pino";
import type {
  AgentRuntime,
  AgentProcessInfo,
  ApprovalDecision,
  CreateRuntimeSessionInput,
  ForkRuntimeSessionInput,
  ModelOption,
  ModelProviderOption,
  PermissionMode,
  RemoteSessionActivity,
  RemoteSessionPage,
  RemoteSessionSummary,
  RemoteTurnPage,
  ResumeRuntimeSessionInput,
  RuntimeGoal,
  RuntimeGoalUpdate,
  RuntimeEvent,
  RuntimeExecutionSettings,
  RuntimePrompt,
  RuntimeReleaseResult,
  RuntimeSession,
  RuntimeSessionMetadata,
} from "../runtime/types.js";
import { appendGeneratedImageMarkdown } from "../utils/generatedImageMarkdown.js";
import { normalizeTaskTitle } from "../utils/taskTitle.js";
import { AppServerRequestError } from "./AppServerConnection.js";
import { mapCodexNotification } from "./CodexEventMapper.js";
import { CodexLocalActivityDetector } from "./CodexLocalActivityDetector.js";
import { detectProjectlessWorkspace } from "./ProjectlessWorkspace.js";
import { threadWriterLockPath } from "./ThreadWriterProcess.js";
import { assertProviderSettingsApplied, PROVIDER_SWITCH_BUSY, providerSwitchFailure } from "./ProviderSwitch.js";

const WINDOWS_SCREENSHOT_DEVELOPER_INSTRUCTIONS = [
  "When capturing any screenshot on Windows, use one fresh process and make it Per-Monitor DPI Aware V2 before loading System.Windows.Forms, System.Drawing, or UI Automation, and before calling any screen, window, or bounds API.",
  "Call user32!SetProcessDpiAwarenessContext((IntPtr)-4) in that same process and verify that it succeeded or that the process is already PMv2 before continuing.",
  "For a full monitor or desktop, query the physical monitor or virtual-desktop bounds only after PMv2 is active.",
  "For a specific window, obtain its HWND after PMv2 is active and use DwmGetWindowAttribute with DWMWA_EXTENDED_FRAME_BOUNDS (9) for the physical visible window bounds; use GetWindowRect only as a fallback after PMv2 is active.",
  "Never crop a window with DPI-virtualized coordinates from an unaware process or with UI Automation BoundingRectangle coordinates.",
  "Call Graphics.CopyFromScreen with those physical coordinates and validate that the saved bitmap dimensions exactly equal the selected physical capture bounds.",
].join(" ");

const SESSION_REQUEST_TIMEOUT_MS = 60_000;
const CONTROL_REQUEST_TIMEOUT_MS = 10_000;
const SYNC_REQUEST_TIMEOUT_MS = 5_000;
const FORK_SOURCE_TURN_PAGE_SIZE = 20;
const FORK_SOURCE_REQUEST_TIMEOUT_MS = 15_000;
const USER_RESUMABLE_THREAD_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer"] as const;
const BUILT_IN_CODEX_PROVIDER_ID = "openai";
// A timed-out fork keeps running in App Server and can create an orphan thread.
// Wait for its response; connection closure still rejects the request.
const FORK_REQUEST_TIMEOUT_MS = 0;

export interface AppServerClient {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  registerRequestHandler(
    method: string,
    handler: (params: unknown, id: string | number, method: string) => Promise<unknown>,
  ): void;
  onNotification(listener: (method: string, params: unknown) => void): () => void;
}

export interface AppServerClientProvider {
  getClient(): Promise<AppServerClient>;
  getAgentFamily?(): "codex" | "traex" | undefined;
  getProcessInfo?(): AgentProcessInfo;
  getCodexHome?(): string;
  onDisconnect?(listener: (error: Error) => void): () => void;
  release?(): Promise<void>;
  close(): void;
}

interface CodexSession extends RuntimeSession {
  activeTurnStartedAt?: number;
  terminalTurnIds: Set<string>;
  finalText: string;
  generatedImagePaths: string[];
  messagePhases: Map<string, "commentary" | "final_answer">;
  needsResume: boolean;
  canReplaceEmptyThread: boolean;
  settingsRecoveryError?: string;
}

interface PendingApproval {
  sessionId: string;
  turnId: string;
  resolve: (value: { decision: ApprovalDecision }) => void;
}

export class CodexRuntime implements AgentRuntime {
  readonly kind = "codex" as const;
  private readonly sessions = new Map<string, CodexSession>();
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly approvals = new Map<string, PendingApproval>();
  private attachedClient?: AppServerClient;
  private unsubscribe?: () => void;
  private readonly unsubscribeDisconnect?: () => void;
  private readonly sessionSyncs = new Map<string, Promise<RuntimeSession>>();
  private readonly sessionOperations = new Map<string, Promise<unknown>>();
  private readonly localActivityDetector?: CodexLocalActivityDetector;
  private readonly codexHome?: string;
  private releaseInFlight?: Promise<RuntimeReleaseResult>;

  constructor(
    private readonly provider: AppServerClientProvider,
    private readonly logger: Logger,
  ) {
    this.codexHome = provider.getCodexHome?.();
    if (this.codexHome) this.localActivityDetector = new CodexLocalActivityDetector(this.codexHome);
    this.unsubscribeDisconnect = provider.onDisconnect?.((error) => this.handleDisconnect(error));
  }

  getSession(localSessionId: string): RuntimeSession | undefined {
    return this.sessions.get(localSessionId);
  }

  getProcessInfo(): AgentProcessInfo {
    return this.provider.getProcessInfo?.() ?? {};
  }

  getThreadWriterLockPath(remoteSessionId: string): string | undefined {
    return this.codexHome ? threadWriterLockPath(this.codexHome, remoteSessionId) : undefined;
  }

  async createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSession> {
    return this.runSessionOperation(input.localSessionId, () => this.createSessionNow(input));
  }

  private async createSessionNow(input: CreateRuntimeSessionInput): Promise<RuntimeSession> {
    const client = await this.client();
    const response = await client.request<ThreadResponse>("thread/start", {
      cwd: input.cwd,
      model: input.model,
      ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
      threadSource: "user",
      ...threadLifecycleParams(input.cwd),
      ...permissionParams(input.permissionMode),
    }, SESSION_REQUEST_TIMEOUT_MS);
    const requestedTitle = normalizeTaskTitle(input.title);
    if (requestedTitle) {
      await client.request("thread/name/set", {
        threadId: response.thread.id,
        name: requestedTitle,
      }, SESSION_REQUEST_TIMEOUT_MS);
    }
    const reasoningEffort = await this.resolveReasoningEffort(input, response);
    const session = this.makeSession(input, response, reasoningEffort);
    if (requestedTitle) session.title = requestedTitle;
    this.sessions.set(input.localSessionId, session);
    return session;
  }

  async resumeSession(input: ResumeRuntimeSessionInput): Promise<RuntimeSession> {
    return this.runSessionOperation(input.localSessionId, () => this.resumeSessionNow(input));
  }

  private async resumeSessionNow(input: ResumeRuntimeSessionInput): Promise<RuntimeSession> {
    const client = await this.client();
    const response = await client.request<ThreadResponse>("thread/resume", {
      threadId: input.remoteSessionId,
      excludeTurns: true,
      cwd: input.cwd,
      model: input.model,
      ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
      ...threadLifecycleParams(input.cwd),
      ...permissionParams(input.permissionMode),
    }, SESSION_REQUEST_TIMEOUT_MS);
    const reasoningEffort = await this.resolveReasoningEffort(input, response);
    const session = this.makeSession(input, response, reasoningEffort);
    this.sessions.set(input.localSessionId, session);
    return session;
  }

  async forkSession(input: ForkRuntimeSessionInput): Promise<RuntimeSession> {
    return this.runSessionOperation(input.localSessionId, () => this.forkSessionNow(input));
  }

  private async forkSessionNow(input: ForkRuntimeSessionInput): Promise<RuntimeSession> {
    const client = await this.client();
    const forkParams = {
      threadId: input.remoteSessionId,
      lastTurnId: input.lastTurnId,
      cwd: input.cwd,
      model: input.model,
      ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
      threadSource: "user",
      ...threadLifecycleParams(input.cwd),
      ...permissionParams(input.permissionMode),
    };
    const response = await client.request<ThreadResponse>("thread/fork", {
      ...forkParams,
      excludeTurns: true,
    }, FORK_REQUEST_TIMEOUT_MS);
    const requestedTitle = normalizeTaskTitle(input.title);
    if (requestedTitle) {
      await client.request("thread/name/set", {
        threadId: response.thread.id,
        name: requestedTitle,
      }, SESSION_REQUEST_TIMEOUT_MS);
    }
    const reasoningEffort = await this.resolveReasoningEffort(input, response);
    const session = this.makeSession(input, response, reasoningEffort);
    if (requestedTitle) session.title = requestedTitle;
    this.sessions.set(input.localSessionId, session);
    return session;
  }

  async startTurn(sessionId: string, prompt: RuntimePrompt): Promise<string> {
    return this.runSessionOperation(sessionId, () => this.startTurnNow(sessionId, prompt));
  }

  private async startTurnNow(sessionId: string, prompt: RuntimePrompt): Promise<string> {
    const session = this.requireSession(sessionId);
    const client = await this.client();
    await this.ensureSessionResumed(session, client);
    session.canReplaceEmptyThread = false;
    const start = () => client.request<{ turn: { id: string } }>("turn/start", {
      threadId: session.remoteSessionId,
      input: codexUserInput(prompt),
      cwd: session.cwd,
      model: session.model,
      effort: session.reasoningEffort,
      summary: "auto",
      approvalPolicy: session.permissionMode === "auto" ? "never" : "on-request",
    }, SESSION_REQUEST_TIMEOUT_MS);
    let response: { turn: { id: string } };
    try {
      response = await start();
    } catch (error) {
      if (!isInvalidWorkingDirectoryError(error)) throw error;
      this.logger.warn(
        { error, sessionId: session.localSessionId, cwd: session.cwd },
        "App Server rejected the task working directory; refreshing the current thread before retrying.",
      );
      await this.resumeAppServerSession(session, client);
      session.needsResume = false;
      response = await start();
    }
    if (session.activeTurnId !== response.turn.id) {
      this.adoptTurn(session, response.turn.id, Date.now());
    }
    return response.turn.id;
  }

  async readSessionMetadata(remoteSessionId: string): Promise<RuntimeSessionMetadata> {
    const response = await (await this.client()).request<ThreadReadResponse>(
      "thread/read",
      { threadId: remoteSessionId, includeTurns: false },
      5_000,
    );
    return {
      title: normalizeTaskTitle(response.thread.name) ?? normalizeTaskTitle(response.thread.preview),
    };
  }

  async listRemoteSessions(input: {
    searchTerm?: string;
    cursor?: string;
    limit?: number;
  } = {}): Promise<RemoteSessionPage> {
    const client = await this.client();
    const response = await this.requestThreadList(client, input);
    const sessions = await Promise.all(response.data.map(async (thread) => {
      const listed = remoteSessionSummary(thread);
      if (listed.status === "active" || listed.lastTurnStatus === "inProgress") return listed;
      try {
        const turns = await this.readLatestThreadTurns(client, thread.id, "summary");
        return mergeRemoteSessionSummary(listed, remoteSessionSummary({ ...thread, turns }));
      } catch {
        return listed;
      }
    }));
    const activeThreads = await this.localActivityDetector?.activeThreads(sessions.map((session) => session.id));
    return {
      sessions: activeThreads
        ? sessions.map((session) => markLocallyDetectedActive(session, activeThreads))
        : sessions,
      nextCursor: response.nextCursor ?? undefined,
    };
  }

  private requestThreadList(
    client: AppServerClient,
    input: { searchTerm?: string; cursor?: string; limit?: number },
  ): Promise<ThreadListResponse> {
    return client.request<ThreadListResponse>(
      "thread/list",
      {
        cursor: input.cursor,
        limit: input.limit ?? 20,
        sortKey: this.provider.getAgentFamily?.() === "traex" ? "updated_at" : "recency_at",
        sortDirection: "desc",
        sourceKinds: USER_RESUMABLE_THREAD_SOURCE_KINDS,
        archived: false,
        searchTerm: input.searchTerm,
      },
      CONTROL_REQUEST_TIMEOUT_MS,
    );
  }

  async readRemoteSession(
    remoteSessionId: string,
    view: "metadata" | "latest" | "latest-full" = "latest",
  ): Promise<RemoteSessionSummary> {
    const client = await this.client();
    const response = await client.request<ThreadReadResponse>(
      "thread/read", { threadId: remoteSessionId, includeTurns: false }, SYNC_REQUEST_TIMEOUT_MS,
    );
    const turns = view === "metadata" ? []
      : await this.readLatestThreadTurns(client, remoteSessionId, view === "latest-full" ? "full" : "summary");
    return this.decorateRemoteSession(remoteSessionId, remoteSessionSummary({ ...response.thread, turns }));
  }

  async listRemoteTurnSummaries(
    remoteSessionId: string,
    input: { cursor?: string; limit: number },
  ): Promise<RemoteTurnPage> {
    const response = await this.readTurnPage(await this.client(), remoteSessionId, {
      cursor: input.cursor,
      limit: Math.max(1, Math.min(100, Math.trunc(input.limit))),
      itemsView: "summary",
    });
    return {
      turns: remoteSessionSummary({ id: remoteSessionId, turns: response.data }).completedTurns ?? [],
      nextCursor: response.nextCursor ?? undefined,
    };
  }

  async readRemoteForkSource(remoteSessionId: string): Promise<RemoteSessionSummary> {
    const client = await this.client();
    const metadata = await client.request<ThreadReadResponse>(
      "thread/read",
      { threadId: remoteSessionId, includeTurns: false },
      FORK_SOURCE_REQUEST_TIMEOUT_MS,
    );
    const turns = await this.listRecentThreadTurnsThroughCompleted(client, remoteSessionId);
    return this.decorateRemoteSession(remoteSessionId, remoteSessionSummary({
      ...metadata.thread,
      turns,
    }));
  }

  private async decorateRemoteSession(
    remoteSessionId: string,
    summary: RemoteSessionSummary,
  ): Promise<RemoteSessionSummary> {
    const activeThreads = await this.localActivityDetector?.activeThreads([remoteSessionId]);
    const activeSummary = activeThreads ? markLocallyDetectedActive(summary, activeThreads) : summary;
    const settings = await this.localActivityDetector?.threadSettings([remoteSessionId]);
    return {
      ...activeSummary,
      ...settings?.get(remoteSessionId),
    };
  }

  private async listRecentThreadTurnsThroughCompleted(
    client: AppServerClient,
    remoteSessionId: string,
  ): Promise<CodexTurnSnapshot[]> {
    const turns: CodexTurnSnapshot[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await this.readTurnPage(client, remoteSessionId, {
        cursor, limit: FORK_SOURCE_TURN_PAGE_SIZE, itemsView: "summary",
      }, FORK_SOURCE_REQUEST_TIMEOUT_MS);
      turns.push(...response.data);
      const completedIndex = turns.findIndex((turn) => turn.status === "completed");
      if (completedIndex >= 0) {
        turns.splice(completedIndex + 1);
        break;
      }
      const nextCursor = response.nextCursor ?? undefined;
      if (!nextCursor) break;
      if (seenCursors.has(nextCursor)) {
        this.logger.warn(
          { remoteSessionId, cursor: nextCursor },
          "App Server repeated a Fork source Turn cursor; stopping pagination.",
        );
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return turns.reverse();
  }

  private async readLatestThreadTurns(
    client: AppServerClient,
    remoteSessionId: string,
    itemsView: "summary" | "full",
  ): Promise<CodexTurnSnapshot[]> {
    const response = await this.readTurnPage(client, remoteSessionId, { limit: 1, itemsView });
    return response.data;
  }

  private async readTurnPage(
    client: AppServerClient,
    remoteSessionId: string,
    input: { cursor?: string; limit: number; itemsView: "summary" | "full" },
    timeoutMs = SYNC_REQUEST_TIMEOUT_MS,
  ): Promise<ThreadTurnsListResponse> {
    try {
      return await client.request<ThreadTurnsListResponse>("thread/turns/list", {
        threadId: remoteSessionId,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        limit: input.limit, sortDirection: "desc", itemsView: input.itemsView,
      }, timeoutMs);
    } catch (error) {
      if (error instanceof AppServerRequestError && error.method === "thread/turns/list"
        && /not materialized yet; thread\/turns\/list is unavailable before first user message/i.test(error.serverMessage)) {
        return { data: [], nextCursor: null };
      }
      throw error;
    }
  }

  async inspectRemoteSessionActivity(remoteSessionId: string): Promise<RemoteSessionActivity> {
    const [response, activeThreads] = await Promise.all([
      (await this.client()).request<ThreadReadResponse>(
        "thread/read",
        { threadId: remoteSessionId, includeTurns: false },
        SYNC_REQUEST_TIMEOUT_MS,
      ),
      this.localActivityDetector?.activeThreads([remoteSessionId]),
    ]);
    const runtimeSession = [...this.sessions.values()]
      .find((session) => session.remoteSessionId === remoteSessionId);
    const detectedTurnId = activeThreads?.get(remoteSessionId);
    const active = remoteThreadStatus(response.thread.status?.type) === "active"
      || Boolean(runtimeSession?.activeTurnId)
      || Boolean(activeThreads?.has(remoteSessionId));
    const activeTurnId = detectedTurnId ?? runtimeSession?.activeTurnId;
    return {
      active,
      ...(activeTurnId ? { activeTurnId } : {}),
    };
  }

  async synchronizeSession(sessionId: string): Promise<RuntimeSession> {
    const existing = this.sessionSyncs.get(sessionId);
    if (existing) return existing;
    const synchronization = this.runSessionOperation(sessionId, () => this.synchronizeSessionNow(sessionId));
    this.sessionSyncs.set(sessionId, synchronization);
    try {
      return await synchronization;
    } finally {
      if (this.sessionSyncs.get(sessionId) === synchronization) this.sessionSyncs.delete(sessionId);
    }
  }

  async steerTurn(sessionId: string, turnId: string, prompt: RuntimePrompt): Promise<void> {
    const session = this.requireActiveTurn(sessionId, turnId);
    await (await this.client()).request("turn/steer", {
      threadId: session.remoteSessionId,
      expectedTurnId: turnId,
      input: codexUserInput(prompt),
    }, CONTROL_REQUEST_TIMEOUT_MS);
  }

  async cancelTurn(sessionId: string, turnId: string): Promise<void> {
    const session = this.requireActiveTurn(sessionId, turnId);
    await this.interruptRemoteTurn(session.remoteSessionId, turnId, sessionId);
  }

  async interruptRemoteTurn(remoteSessionId: string, turnId: string, sessionId?: string): Promise<void> {
    await (await this.client()).request(
      "turn/interrupt",
      { threadId: remoteSessionId, turnId },
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    this.logger.info(
      { ...(sessionId ? { sessionId } : {}), threadId: remoteSessionId, turnId },
      "App Server accepted the turn interrupt request.",
    );
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.runSessionOperation(sessionId, async () => {
      const session = this.requireSession(sessionId);
      await this.archiveRemoteSession(session.remoteSessionId);
    });
  }

  async archiveRemoteSession(remoteSessionId: string): Promise<void> {
    await (await this.client()).request(
      "thread/archive",
      { threadId: remoteSessionId },
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    for (const [localSessionId, session] of this.sessions) {
      if (session.remoteSessionId === remoteSessionId) this.sessions.delete(localSessionId);
    }
  }

  async setTitle(sessionId: string, title: string): Promise<void> {
    return this.runSessionOperation(sessionId, () => this.setTitleNow(sessionId, title));
  }

  private async setTitleNow(sessionId: string, title: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const normalizedTitle = normalizeTaskTitle(title);
    if (!normalizedTitle) throw new Error("任务标题不能为空。");
    await (await this.client()).request(
      "thread/name/set",
      { threadId: session.remoteSessionId, name: normalizedTitle },
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    session.title = normalizedTitle;
  }

  async getGoal(sessionId: string): Promise<RuntimeGoal | undefined> {
    return this.runSessionOperation(sessionId, () => this.getGoalNow(sessionId));
  }

  private async getGoalNow(sessionId: string): Promise<RuntimeGoal | undefined> {
    const session = this.requireSession(sessionId);
    const client = await this.client();
    await this.ensureSessionResumed(session, client);
    const response = await client.request<{ goal?: RuntimeGoal | null }>(
      "thread/goal/get",
      { threadId: session.remoteSessionId },
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    return response.goal ?? undefined;
  }

  async setGoal(sessionId: string, update: RuntimeGoalUpdate): Promise<RuntimeGoal> {
    return this.runSessionOperation(sessionId, () => this.setGoalNow(sessionId, update));
  }

  private async setGoalNow(sessionId: string, update: RuntimeGoalUpdate): Promise<RuntimeGoal> {
    const session = this.requireSession(sessionId);
    const client = await this.client();
    await this.ensureSessionResumed(session, client);
    session.canReplaceEmptyThread = false;
    const response = await client.request<{ goal: RuntimeGoal }>(
      "thread/goal/set",
      { threadId: session.remoteSessionId, ...update },
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    return response.goal;
  }

  async clearGoal(sessionId: string): Promise<boolean> {
    return this.runSessionOperation(sessionId, () => this.clearGoalNow(sessionId));
  }

  private async clearGoalNow(sessionId: string): Promise<boolean> {
    const session = this.requireSession(sessionId);
    const client = await this.client();
    await this.ensureSessionResumed(session, client);
    const response = await client.request<{ cleared: boolean }>(
      "thread/goal/clear",
      { threadId: session.remoteSessionId },
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    return response.cleared;
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    await this.runSessionOperation(sessionId, async () => { this.requireSession(sessionId).model = model; });
  }

  async setReasoningEffort(sessionId: string, effort: string): Promise<void> {
    await this.runSessionOperation(sessionId, async () => { this.requireSession(sessionId).reasoningEffort = effort; });
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    await this.runSessionOperation(sessionId, async () => { this.requireSession(sessionId).permissionMode = mode; });
  }

  async setExecutionSettings(
    sessionId: string,
    settings: RuntimeExecutionSettings,
    persist?: (session: RuntimeSession) => Promise<void>,
  ): Promise<RuntimeSession> {
    return this.runSessionOperation(sessionId, () => this.setExecutionSettingsNow(sessionId, settings, persist));
  }

  private async setExecutionSettingsNow(
    sessionId: string,
    settings: RuntimeExecutionSettings,
    persist?: (session: RuntimeSession) => Promise<void>,
  ): Promise<RuntimeSession> {
    const session = this.requireSession(sessionId);
    if (session.activeTurnId) throw new Error(PROVIDER_SWITCH_BUSY);
    const client = await this.client();
    const metadata = await client.request<ThreadReadResponse>("thread/read", {
      threadId: session.remoteSessionId, includeTurns: false,
    }, SYNC_REQUEST_TIMEOUT_MS);
    const localActive = await this.localActivityDetector?.activeThreads([session.remoteSessionId]);
    if (metadata.thread.status?.type === "active" || localActive?.has(session.remoteSessionId) || session.activeTurnId) {
      throw new Error(PROVIDER_SWITCH_BUSY);
    }
    let empty = false;
    if (session.canReplaceEmptyThread && !metadata.thread.forkedFromId && !metadata.thread.preview?.trim()) {
      try {
        const turns = await this.readLatestThreadTurns(client, session.remoteSessionId, "summary");
        empty = turns.length === 0;
        if (!empty) session.canReplaceEmptyThread = false;
      } catch (error) {
        if (!(error instanceof AppServerRequestError) || error.method !== "thread/turns/list"
          || !/missing source rollout|no rollout found/iu.test(error.serverMessage)) throw error;
        empty = true;
      }
    }
    const previous = { ...session };
    let replacementId: string | undefined;
    let detached = false;
    try {
      const params = {
        cwd: session.cwd, modelProvider: settings.modelProvider, model: settings.model,
        ...threadLifecycleParams(session.cwd), ...permissionParams(settings.permissionMode),
      };
      if (!empty) {
        await this.detachThreadForSettings(client, session);
        detached = true;
      }
      const response = empty
        ? await client.request<ThreadResponse>("thread/start", {
            ...params, threadSource: "user", allowProviderModelFallback: false,
          }, SESSION_REQUEST_TIMEOUT_MS)
        : await client.request<ThreadResponse>("thread/resume", {
            ...params, threadId: session.remoteSessionId, excludeTurns: true,
          }, SESSION_REQUEST_TIMEOUT_MS);
      if (empty) replacementId = response.thread.id;
      assertProviderSettingsApplied(response, settings);
      if (!empty && response.thread.id !== session.remoteSessionId) throw new Error("App Server 返回了不同的任务 ID，未保存设置。");
      if (empty && session.title) await client.request("thread/name/set", {
        threadId: response.thread.id, name: session.title,
      }, SESSION_REQUEST_TIMEOUT_MS);
      const candidate = { ...session, ...settings, remoteSessionId: response.thread.id,
        needsResume: false, settingsRecoveryError: undefined };
      await persist?.(candidate);
      Object.assign(session, candidate);
    } catch (error) {
      if (replacementId) await this.discardUnusedThread(client, replacementId);
      let recovery = "原任务设置未更改。";
      if (detached) {
        try {
          await this.detachThreadForSettings(client, previous);
          const restored = await client.request<ThreadResponse>("thread/resume", {
            threadId: previous.remoteSessionId, excludeTurns: true, cwd: previous.cwd,
            modelProvider: previous.modelProvider, model: previous.model,
            ...threadLifecycleParams(previous.cwd), ...permissionParams(previous.permissionMode),
          }, SESSION_REQUEST_TIMEOUT_MS);
          if (previous.modelProvider && previous.model) assertProviderSettingsApplied(restored, {
            modelProvider: previous.modelProvider, model: previous.model,
          });
          if (restored.thread.id !== previous.remoteSessionId) throw new Error("恢复时返回了不同的任务 ID。");
          session.needsResume = false;
          session.settingsRecoveryError = undefined;
        } catch (restoreError) {
          this.logger.warn({ error: restoreError, sessionId }, "Failed to restore Provider after a rejected settings change.");
          recovery = "原设置仍保留，但远端恢复失败；请重新切换 Provider，确认成功后再发送消息。";
          session.settingsRecoveryError = recovery;
          session.needsResume = true;
        }
      }
      throw new Error(`Provider 切换失败：${providerSwitchFailure(error)} ${recovery}`, { cause: error });
    }
    if (replacementId) await this.discardUnusedThread(client, previous.remoteSessionId);
    return session;
  }

  private async detachThreadForSettings(client: AppServerClient, session: CodexSession): Promise<void> {
    const current = await client.request<ThreadReadResponse>("thread/read", {
      threadId: session.remoteSessionId, includeTurns: false,
    }, SYNC_REQUEST_TIMEOUT_MS);
    if (session.activeTurnId || current.thread.status?.type === "active") throw new Error(PROVIDER_SWITCH_BUSY);
    const result = await client.request<{ status: string }>("thread/unsubscribe", {
      threadId: session.remoteSessionId,
    }, CONTROL_REQUEST_TIMEOUT_MS);
    if (result.status !== "unsubscribed" && result.status !== "notLoaded") {
      throw new Error("当前任务仍由其他客户端加载，无法安全切换 Provider。请先在原客户端释放任务。");
    }
  }

  private async discardUnusedThread(client: AppServerClient, threadId: string): Promise<void> {
    try {
      await client.request("thread/unsubscribe", { threadId }, CONTROL_REQUEST_TIMEOUT_MS);
    } catch (error) {
      this.logger.warn({ error, threadId }, "Failed to release an unused empty Thread after changing Provider.");
    }
  }

  async respondToApproval(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const pending = this.approvals.get(requestId);
    if (!pending || pending.sessionId !== sessionId) throw new Error("Approval request is no longer pending.");
    this.approvals.delete(requestId);
    pending.resolve({ decision });
    this.emit({ type: "approval_resolved", sessionId, turnId: pending.turnId, requestId, decision });
  }

  async listModels(): Promise<ModelOption[]> {
    const response = await (await this.client()).request<{
      data: Array<{
        id: string;
        displayName?: string;
        isDefault?: boolean;
        supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>;
        defaultReasoningEffort?: string;
      }>;
    }>(
      "model/list",
      {},
    );
    return response.data.filter((model) => model.id).map((model) => ({
      id: model.id,
      displayName: model.displayName,
      isDefault: model.isDefault,
      supportedReasoningEfforts: (model.supportedReasoningEfforts ?? []).map((option) => ({
        value: option.reasoningEffort,
        description: option.description,
      })),
      defaultReasoningEffort: model.defaultReasoningEffort,
    }));
  }

  async listModelProviders(): Promise<ModelProviderOption[]> {
    const response = await (await this.client()).request<{ config?: Record<string, unknown> }>(
      "config/read",
      {},
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    const config = response.config ?? {};
    const defaultProvider = stringValue(config.model_provider)?.trim();
    const configuredProviders = isRecord(config.model_providers) ? config.model_providers : {};
    const providers = new Map<string, ModelProviderOption>();
    for (const [id, value] of Object.entries(configuredProviders)) {
      if (!id.trim()) continue;
      const displayName = isRecord(value) ? stringValue(value.name)?.trim() : undefined;
      providers.set(id, {
        id,
        ...(displayName ? { displayName } : {}),
        ...(id === defaultProvider ? { isDefault: true } : {}),
      });
    }
    if (this.provider.getAgentFamily?.() === "codex" && !providers.has(BUILT_IN_CODEX_PROVIDER_ID)) {
      providers.set(BUILT_IN_CODEX_PROVIDER_ID, {
        id: BUILT_IN_CODEX_PROVIDER_ID,
        displayName: "OpenAI",
        ...(!defaultProvider ? { isDefault: true } : {}),
      });
    }
    if (defaultProvider && !providers.has(defaultProvider)) {
      providers.set(defaultProvider, { id: defaultProvider, isDefault: true });
    }
    return [...providers.values()].sort((left, right) =>
      Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)) || left.id.localeCompare(right.id),
    );
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async release(options: { force?: boolean } = {}): Promise<RuntimeReleaseResult> {
    if (this.releaseInFlight) return this.releaseInFlight;
    const activeSessionIds = [...this.sessions.values()]
      .filter((session) => Boolean(session.activeTurnId) || this.sessionOperations.has(session.localSessionId))
      .map((session) => session.localSessionId);
    if (activeSessionIds.length > 0 && options.force !== true) {
      return { status: "busy", activeSessionIds };
    }

    const operation = (async (): Promise<RuntimeReleaseResult> => {
      this.handleDisconnect(new Error("App Server released by user."), true);
      if (this.provider.release) await this.provider.release();
      else this.provider.close();
      return { status: "released" };
    })();
    this.releaseInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.releaseInFlight === operation) this.releaseInFlight = undefined;
    }
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribeDisconnect?.();
    for (const pending of this.approvals.values()) pending.resolve({ decision: "cancel" });
    this.approvals.clear();
    this.sessionSyncs.clear();
    this.sessions.clear();
    this.provider.close();
  }

  private async client(): Promise<AppServerClient> {
    if (this.releaseInFlight) await this.releaseInFlight;
    const client = await this.provider.getClient();
    if (client !== this.attachedClient) this.attachClient(client);
    return client;
  }

  private attachClient(client: AppServerClient): void {
    this.unsubscribe?.();
    this.attachedClient = client;
    this.unsubscribe = client.onNotification((method, params) => this.handleNotification(method, params));
    for (const method of [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ]) {
      client.registerRequestHandler(method, (params, id) => this.handleApproval(params, id));
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "thread/name/updated" && isRecord(params)) {
      const threadId = stringValue(params.threadId);
      const title = normalizeTaskTitle(stringValue(params.threadName));
      if (!threadId || !title) return;
      const session = [...this.sessions.values()].find((candidate) => candidate.remoteSessionId === threadId);
      if (!session) return;
      session.title = title;
      this.emit({ type: "session_metadata_updated", sessionId: session.localSessionId, title });
      return;
    }
    if (method === "thread/status/changed" && isRecord(params)) {
      const threadId = stringValue(params.threadId);
      const status = isRecord(params.status) ? stringValue(params.status.type) : undefined;
      const session = [...this.sessions.values()].find((candidate) => candidate.remoteSessionId === threadId);
      if (session?.activeTurnId && status && status !== "active") {
        void this.synchronizeSession(session.localSessionId).catch((error: unknown) => {
          this.logger.warn({ error, sessionId: session.localSessionId, status }, "Failed to reconcile App Server thread status.");
        });
      }
      return;
    }
    const mapped = mapCodexNotification(method, params);
    if (!mapped) return;
    const session = [...this.sessions.values()].find((candidate) => candidate.remoteSessionId === mapped.threadId);
    if (!session) return;
    if (session.terminalTurnIds.has(mapped.turnId)) {
      this.logger.debug(
        { sessionId: session.localSessionId, turnId: mapped.turnId, method },
        "Ignoring a replayed terminal App Server turn event.",
      );
      return;
    }
    if (mapped.kind === "turn_started") {
      if (session.activeTurnId === mapped.turnId) return;
      if (
        session.activeTurnId
        && session.activeTurnStartedAt !== undefined
        && mapped.startedAt !== undefined
        && mapped.startedAt < session.activeTurnStartedAt
      ) {
        this.logger.debug(
          {
            sessionId: session.localSessionId,
            activeTurnId: session.activeTurnId,
            activeTurnStartedAt: session.activeTurnStartedAt,
            notificationTurnId: mapped.turnId,
            notificationStartedAt: mapped.startedAt,
          },
          "Ignoring a replayed historical App Server turn start.",
        );
        return;
      }
      if (session.activeTurnId) this.supersedeTurn(session, session.activeTurnId);
      this.adoptTurn(session, mapped.turnId, mapped.startedAt ?? Date.now());
      return;
    }
    if (!session.activeTurnId || session.activeTurnId !== mapped.turnId) {
      this.logger.debug(
        { sessionId: session.localSessionId, activeTurnId: session.activeTurnId, notificationTurnId: mapped.turnId, method },
        "Ignoring out-of-order App Server notification and scheduling reconciliation.",
      );
      void this.synchronizeSession(session.localSessionId).catch((error: unknown) => {
        this.logger.warn({ error, sessionId: session.localSessionId }, "Failed to reconcile out-of-order App Server notification.");
      });
      return;
    }
    const sessionId = session.localSessionId;
    if (mapped.kind === "token_usage") {
      this.emit({
        type: "token_usage_updated",
        sessionId,
        turnId: mapped.turnId,
        lastTokens: mapped.lastTokens,
        cumulativeTokens: mapped.cumulativeTokens,
      });
    } else if (mapped.kind === "agent_message_phase") {
      session.messagePhases.set(mapped.itemId, mapped.phase);
    } else if (mapped.kind === "agent_delta") {
      if (session.messagePhases.get(mapped.itemId) === "commentary") {
        this.emit({
          type: "progress",
          sessionId,
          turnId: mapped.turnId,
          activityId: `commentary:${mapped.itemId}`,
          text: mapped.text,
          append: true,
        });
      } else {
        session.finalText += mapped.text;
        this.emit({ type: "agent_text_delta", sessionId, turnId: mapped.turnId, text: mapped.text });
      }
    } else if (mapped.kind === "progress") {
      this.emit({
        type: "progress",
        sessionId,
        turnId: mapped.turnId,
        activityId: mapped.activityId,
        text: mapped.text,
        append: mapped.append,
      });
    } else if (mapped.kind === "plan") {
      this.emit({ type: "plan_updated", sessionId, turnId: mapped.turnId, steps: mapped.steps });
    } else if (mapped.kind === "tool") {
      if (
        mapped.phase === "updated"
        && mapped.tool.kind === "image_generation"
        && mapped.tool.status === "completed"
        && mapped.tool.imagePath
      ) {
        session.generatedImagePaths = uniqueStrings([...session.generatedImagePaths, mapped.tool.imagePath]);
      }
      this.emit({
        type: mapped.phase === "started" ? "tool_started" : "tool_updated",
        sessionId,
        turnId: mapped.turnId,
        tool: mapped.tool,
      });
    } else if (mapped.kind === "tool_output_delta") {
      this.emit({
        type: "tool_output_delta",
        sessionId,
        turnId: mapped.turnId,
        toolId: mapped.toolId,
        delta: mapped.delta,
      });
    } else if (mapped.kind === "terminal") {
      session.activeTurnId = undefined;
      session.activeTurnStartedAt = undefined;
      session.terminalTurnIds.add(mapped.turnId);
      session.messagePhases.clear();
      if (mapped.status === "cancelled") {
        this.emit({ type: "turn_cancelled", sessionId, turnId: mapped.turnId });
      } else if (mapped.status === "failed") {
        this.emit({ type: "turn_failed", sessionId, turnId: mapped.turnId, message: mapped.error ?? "App Server turn failed." });
      } else {
        const finalResponse = appendModelSwitchGuidance(
          appendGeneratedImageMarkdown(session.finalText, session.generatedImagePaths),
          session.model,
        );
        this.emit({
          type: "turn_completed",
          sessionId,
          turnId: mapped.turnId,
          finalResponse,
          durationMs: mapped.durationMs,
        });
      }
      session.generatedImagePaths = [];
    }
  }

  private handleApproval(params: unknown, id: string | number): Promise<{ decision: ApprovalDecision }> {
    if (!isRecord(params)) return Promise.resolve({ decision: "decline" });
    const threadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId);
    const session = [...this.sessions.values()].find((candidate) => candidate.remoteSessionId === threadId);
    if (!session || !turnId) return Promise.resolve({ decision: "decline" });
    if (session.permissionMode === "auto") return Promise.resolve({ decision: "accept" });
    const requestId = String(id);
    const response = new Promise<{ decision: ApprovalDecision }>((resolve) => {
      this.approvals.set(requestId, { sessionId: session.localSessionId, turnId, resolve });
    });
    this.emit({
      type: "approval_requested",
      sessionId: session.localSessionId,
      turnId,
      request: {
        id: requestId,
        title: stringValue(params.command) ?? "Agent approval request",
        command: stringValue(params.command),
        reason: stringValue(params.reason),
        options: [
          { id: "accept", label: "允许一次" },
          { id: "acceptForSession", label: "本会话允许" },
          { id: "decline", label: "拒绝" },
          { id: "cancel", label: "取消任务" },
        ],
      },
    });
    return response;
  }

  private async resolveReasoningEffort(
    input: CreateRuntimeSessionInput,
    response: ThreadResponse,
  ): Promise<string | undefined> {
    if (input.reasoningEffort) return input.reasoningEffort;
    if (response.reasoningEffort) return response.reasoningEffort;
    const model = input.model ?? response.model;
    const models = await this.listModels();
    return models.find((item) => item.id === model)?.defaultReasoningEffort
      ?? models.find((item) => item.isDefault)?.defaultReasoningEffort;
  }

  private async ensureSessionResumed(session: CodexSession, client: AppServerClient): Promise<void> {
    if (session.settingsRecoveryError) throw new Error(session.settingsRecoveryError);
    if (!session.needsResume) return;
    await this.resumeAppServerSession(session, client);
    session.needsResume = false;
  }

  private async resumeAppServerSession(session: CodexSession, client: AppServerClient): Promise<void> {
    await client.request("thread/resume", {
      threadId: session.remoteSessionId,
      excludeTurns: true,
      cwd: session.cwd,
      model: session.model,
      ...(session.modelProvider ? { modelProvider: session.modelProvider } : {}),
      ...threadLifecycleParams(session.cwd),
      ...permissionParams(session.permissionMode),
    }, SESSION_REQUEST_TIMEOUT_MS);
  }

  private async synchronizeSessionNow(sessionId: string): Promise<RuntimeSession> {
    const session = this.requireSession(sessionId);
    const client = await this.client();
    const response = await client.request<ThreadReadResponse>(
      "thread/read",
      { threadId: session.remoteSessionId, includeTurns: false },
      SYNC_REQUEST_TIMEOUT_MS,
    );
    const turns = await this.readLatestThreadTurns(client, session.remoteSessionId, "full");
    const thread = { ...response.thread, turns };
    this.reconcileThreadSnapshot(session, thread);
    return { ...session, remoteSummary: await this.decorateRemoteSession(session.remoteSessionId, remoteSessionSummary(thread)) };
  }

  private reconcileThreadSnapshot(session: CodexSession, thread: ThreadReadResponse["thread"]): void {
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const latest = turns.at(-1);
    const latestInProgress = [...turns].reverse().find((turn) => turn.status === "inProgress");
    const activeTurnId = session.activeTurnId;

    if (!activeTurnId) {
      if (latestInProgress && thread.status?.type === "active") {
        this.adoptTurn(session, latestInProgress.id, turnStartedAt(latestInProgress));
      }
      return;
    }

    if (latestInProgress?.id === activeTurnId) {
      if (thread.status?.type === "active") return;
      this.supersedeTurn(session, activeTurnId);
      return;
    }
    if (latestInProgress) {
      this.supersedeTurn(session, activeTurnId);
      this.adoptTurn(session, latestInProgress.id, turnStartedAt(latestInProgress));
      return;
    }

    if (!latest) {
      if (thread.status?.type !== "active") {
        session.activeTurnId = undefined;
        session.activeTurnStartedAt = undefined;
        session.messagePhases.clear();
        this.emit({
          type: "turn_failed",
          sessionId: session.localSessionId,
          turnId: activeTurnId,
          message: "The App Server no longer reports this execution in the thread history.",
        });
      }
      return;
    }

    if (latest.id !== activeTurnId) {
      this.supersedeTurn(session, activeTurnId);
      this.adoptTurn(session, latest.id, turnStartedAt(latest));
    }
    this.finishSnapshotTurn(session, latest);
  }

  private adoptTurn(session: CodexSession, turnId: string, startedAt: number): void {
    session.canReplaceEmptyThread = false;
    session.activeTurnId = turnId;
    session.activeTurnStartedAt = startedAt;
    session.finalText = "";
    session.generatedImagePaths = [];
    session.messagePhases.clear();
    this.emit({ type: "turn_started", sessionId: session.localSessionId, turnId, startedAt });
  }

  private supersedeTurn(session: CodexSession, turnId: string): void {
    if (session.activeTurnId === turnId) {
      session.activeTurnId = undefined;
      session.activeTurnStartedAt = undefined;
    }
    session.terminalTurnIds.add(turnId);
    session.messagePhases.clear();
    this.emit({ type: "turn_cancelled", sessionId: session.localSessionId, turnId });
  }

  private finishSnapshotTurn(session: CodexSession, turn: CodexTurnSnapshot): void {
    if (session.activeTurnId !== turn.id) return;
    session.activeTurnId = undefined;
    session.activeTurnStartedAt = undefined;
    session.terminalTurnIds.add(turn.id);
    session.messagePhases.clear();
    if (turn.status === "interrupted") {
      this.emit({ type: "turn_cancelled", sessionId: session.localSessionId, turnId: turn.id });
      return;
    }
    if (turn.status === "failed") {
      this.emit({
        type: "turn_failed",
        sessionId: session.localSessionId,
        turnId: turn.id,
        message: turn.error?.message ?? "App Server turn failed.",
      });
      return;
    }
    const generatedImagePaths = uniqueStrings([
      ...session.generatedImagePaths,
      ...extractGeneratedImagePaths(turn),
    ]);
    const finalResponse = appendModelSwitchGuidance(
      appendGeneratedImageMarkdown(
        extractFinalResponse(turn) || session.finalText,
        generatedImagePaths,
      ),
      session.model,
    );
    session.finalText = finalResponse;
    session.generatedImagePaths = [];
    this.emit({
      type: "turn_completed",
      sessionId: session.localSessionId,
      turnId: turn.id,
      finalResponse,
      durationMs: turn.durationMs ?? undefined,
    });
  }

  private makeSession(
    input: CreateRuntimeSessionInput | ResumeRuntimeSessionInput | ForkRuntimeSessionInput,
    response: ThreadResponse,
    reasoningEffort?: string,
  ): CodexSession {
    return {
      localSessionId: input.localSessionId,
      remoteSessionId: response.thread.id,
      runtimeKind: "codex",
      agentName: input.agentName,
      cwd: input.cwd,
      title: normalizeTaskTitle(response.thread.name)
        ?? normalizeTaskTitle(response.thread.preview)
        ?? input.title,
      modelProvider: input.modelProvider ?? response.modelProvider,
      model: input.model ?? response.model,
      reasoningEffort,
      permissionMode: input.permissionMode,
      activeTurnId: "activeTurnId" in input ? input.activeTurnId : undefined,
      activeTurnStartedAt: undefined,
      terminalTurnIds: new Set(
        "lastTurnStatus" in input
        && input.lastTurnId
        && input.lastTurnStatus
        && input.lastTurnStatus !== "running"
          ? [input.lastTurnId]
          : [],
      ),
      finalText: "",
      generatedImagePaths: [],
      messagePhases: new Map(),
      needsResume: false,
      canReplaceEmptyThread: !("remoteSessionId" in input),
    };
  }

  private requireSession(sessionId: string): CodexSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown App Server session: ${sessionId}`);
    return session;
  }

  private async runSessionOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperations.get(sessionId);
    const current = (previous ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.sessionOperations.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (this.sessionOperations.get(sessionId) === current) this.sessionOperations.delete(sessionId);
    }
  }

  private requireActiveTurn(sessionId: string, turnId: string): CodexSession {
    const session = this.requireSession(sessionId);
    if (session.activeTurnId !== turnId) throw new Error(`App Server turn is no longer active: ${turnId}`);
    return session;
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private handleDisconnect(error: Error, intentionalRelease = false): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.attachedClient = undefined;
    for (const session of this.sessions.values()) {
      session.needsResume = true;
      const turnId = session.activeTurnId;
      if (!turnId) continue;
      session.activeTurnId = undefined;
      session.activeTurnStartedAt = undefined;
      session.generatedImagePaths = [];
      this.emit({
        type: "turn_failed",
        sessionId: session.localSessionId,
        turnId,
        message: intentionalRelease
          ? "Task interrupted because Agent Bot released the App Server."
          : `App Server disconnected: ${error.message}`,
      });
    }
    for (const [requestId, pending] of this.approvals) {
      this.approvals.delete(requestId);
      pending.resolve({ decision: "cancel" });
    }
  }
}

interface ThreadResponse {
  thread: { id: string; name?: string | null; preview?: string };
  modelProvider?: string;
  model?: string;
  reasoningEffort?: string | null;
}

interface ThreadReadResponse {
  thread: CodexThreadSnapshot;
}

interface ThreadListResponse {
  data: CodexThreadSnapshot[];
  nextCursor?: string | null;
}

interface ThreadTurnsListResponse {
  data: CodexTurnSnapshot[];
  nextCursor?: string | null;
}

interface CodexThreadSnapshot {
  id: string;
  name?: string | null;
  preview?: string;
  cwd?: string;
  modelProvider?: string;
  source?: unknown;
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number | null;
  status?: { type?: string };
  forkedFromId?: string | null;
  turns?: CodexTurnSnapshot[];
}

interface CodexTurnSnapshot {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  items?: Array<{
    type?: string;
    text?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
    phase?: string | null;
    status?: string;
    savedPath?: string;
  }>;
  error?: { message?: string } | null;
  startedAt?: number | null;
  durationMs?: number | null;
}

function permissionParams(mode: PermissionMode): { approvalPolicy: "never" | "on-request"; sandbox: string } {
  return mode === "auto"
    ? { approvalPolicy: "never", sandbox: "danger-full-access" }
    : { approvalPolicy: "on-request", sandbox: "workspace-write" };
}

const MODEL_SWITCH_GUIDANCE = "请发送 `/model` 切换到其他模型后重试。";

function appendModelSwitchGuidance(response: string, model?: string): string {
  if (!hasKnownCodeModeFailure(response) || response.includes(MODEL_SWITCH_GUIDANCE)) return response;
  const modelLabel = model?.trim() ? ` \`${model.trim()}\`` : "";
  const guidance = `> 当前模型${modelLabel} 的本地工具执行通道异常。${MODEL_SWITCH_GUIDANCE}`;
  return response.trimEnd() ? `${response.trimEnd()}\n\n${guidance}` : guidance;
}

function hasKnownCodeModeFailure(response: string): boolean {
  return /code-mode host closed its stdout/i.test(response)
    || /exec expects an object containing raw JavaScript in [`'"]?input[`'"]?/i.test(response);
}

function threadLifecycleParams(cwd: string): {
  developerInstructions: string;
} {
  const projectless = detectProjectlessWorkspace(cwd);
  if (!projectless) return { developerInstructions: WINDOWS_SCREENSHOT_DEVELOPER_INSTRUCTIONS };
  const projectlessInstructions = [
    "### Projectless Chat",
    "This projectless thread starts in a generated directory under the user's Documents/Codex folder.",
    "Prefer answering inline in chat unless using local files would make the result more useful.",
    `Use work/ for intermediate files, scratch analysis, scripts, drafts, and temporary assets. Use ${projectless.outputDirectory} only for user-facing deliverables that should appear as outputs.`,
    `When referring to saved deliverables in the final response, link only files from ${projectless.outputDirectory}.`,
    "Do not write directly in the home directory unless the user explicitly asks.",
  ].join("\n");
  return {
    developerInstructions: `${WINDOWS_SCREENSHOT_DEVELOPER_INSTRUCTIONS}\n\n${projectlessInstructions}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function turnStartedAt(turn: CodexTurnSnapshot): number {
  return typeof turn.startedAt === "number" ? turn.startedAt * 1_000 : Date.now();
}

function extractFinalResponse(turn: CodexTurnSnapshot): string {
  const messages = (turn.items ?? []).filter(
    (item) => item.type === "agentMessage" && typeof item.text === "string" && item.text.trim(),
  );
  const finalMessages = messages.filter((item) => item.phase === "final_answer");
  return (finalMessages.length ? finalMessages : messages.slice(-1))
    .map((item) => item.text!.trim())
    .join("\n\n");
}

function extractGeneratedImagePaths(turn: CodexTurnSnapshot): string[] {
  return uniqueStrings((turn.items ?? []).flatMap((item) => {
    const savedPath = stringValue(item.savedPath)?.trim();
    return item.type === "imageGeneration" && item.status !== "failed" && savedPath ? [savedPath] : [];
  }));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isInvalidWorkingDirectoryError(error: unknown): boolean {
  return error instanceof AppServerRequestError
    && error.method === "turn/start"
    && /invalid cwd/i.test(`${error.serverMessage} ${error.data === undefined ? "" : JSON.stringify(error.data)}`);
}

function remoteSessionSummary(thread: CodexThreadSnapshot): RemoteSessionSummary {
  const lastTurn = thread.turns?.at(-1);
  const lastCompletedTurn = [...(thread.turns ?? [])]
    .reverse()
    .find((turn) => turn.status === "completed");
  const toolCounts = lastTurn ? summarizeTurnTools(lastTurn) : undefined;
  const status = remoteThreadStatus(thread.status?.type);
  // A persisted inProgress turn can outlive the CLI/Desktop app-server process
  // that owned it. Only the owning app-server's active thread status (or the
  // rollout activity detector applied below) is evidence that it is still live.
  const lastTurnStatus = lastTurn?.status === "inProgress" && status !== "active"
    ? "interrupted"
    : lastTurn?.status;
  const lastText = [...(lastTurn?.items ?? [])]
    .reverse()
    .find((item) => typeof item.text === "string" && item.text.trim())?.text?.trim();
  const completedTurns = (thread.turns ?? []).flatMap((turn) => {
    if (turn.status !== "completed") return [];
    const startedAt = remoteTurnStartedAt(turn);
    return [{
      id: turn.id,
      prompt: extractTurnUserPrompt(turn),
      startedAt,
      completedAt: startedAt === undefined
        ? undefined
        : startedAt + Math.max(0, turn.durationMs ?? 0),
    }];
  });
  return {
    id: thread.id,
    title: normalizeTaskTitle(thread.name) ?? normalizeTaskTitle(thread.preview),
    preview: normalizeTaskTitle(thread.preview),
    cwd: thread.cwd ?? "",
    source: codexSourceLabel(thread.source),
    status,
    modelProvider: thread.modelProvider,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    recencyAt: thread.recencyAt ?? undefined,
    lastTurnId: lastTurn?.id,
    lastCompletedTurnId: lastCompletedTurn?.id,
    lastTurnStatus,
    lastUserPrompt: extractLastUserPrompt(thread.turns),
    lastActivity: lastText,
    finalResponse: lastTurn && lastTurn.status !== "inProgress"
      ? appendGeneratedImageMarkdown(extractFinalResponse(lastTurn), extractGeneratedImagePaths(lastTurn)) || undefined
      : undefined,
    lastError: lastTurn?.error?.message,
    lastTurnToolCount: toolCounts?.total,
    lastTurnCompletedToolCount: toolCounts?.completed,
    lastTurnFailedToolCount: toolCounts?.failed,
    lastTurnRunningToolCount: toolCounts?.running,
    completedTurns,
  };
}

function extractLastUserPrompt(turns: CodexTurnSnapshot[] | undefined): string | undefined {
  for (const turn of [...(turns ?? [])].reverse()) {
    const prompt = extractTurnUserPrompt(turn);
    if (prompt) return prompt;
  }
  return undefined;
}

function extractTurnUserPrompt(turn: CodexTurnSnapshot): string | undefined {
  for (const item of [...(turn.items ?? [])].reverse()) {
    if (item.type !== "userMessage") continue;
    const text = item.content
      ?.filter((content) => content.type === "text" && typeof content.text === "string")
      .map((content) => content.text!.trim())
      .filter(Boolean)
      .join("\n\n")
      || item.text?.trim();
    if (text) return text;
  }
  return undefined;
}

function remoteTurnStartedAt(turn: CodexTurnSnapshot): number | undefined {
  return remoteTimestampMs(turn.startedAt ?? undefined);
}

function remoteTimestampMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return value >= 10_000_000_000 ? value : value * 1_000;
}

function summarizeTurnTools(turn: CodexTurnSnapshot): {
  total: number;
  completed: number;
  failed: number;
  running: number;
} {
  const tools = (turn.items ?? []).filter((item) => isToolItemType(item.type));
  let completed = 0;
  let failed = 0;
  let running = 0;
  for (const tool of tools) {
    if (tool.status === "failed" || tool.status === "declined") failed += 1;
    else if (tool.status === "inProgress" || tool.status === "running") running += 1;
    else completed += 1;
  }
  return { total: tools.length, completed, failed, running };
}

function isToolItemType(type: string | undefined): boolean {
  return type === "commandExecution"
    || type === "fileChange"
    || type === "mcpToolCall"
    || type === "dynamicToolCall"
    || type === "webSearch"
    || type === "imageView"
    || type === "imageGeneration";
}

function mergeRemoteSessionSummary(
  listed: RemoteSessionSummary,
  inspected: RemoteSessionSummary,
): RemoteSessionSummary {
  return {
    ...listed,
    ...inspected,
    title: inspected.title ?? listed.title,
    preview: inspected.preview ?? listed.preview,
    cwd: inspected.cwd || listed.cwd,
    source: inspected.source === "unknown" ? listed.source : inspected.source,
    createdAt: inspected.createdAt ?? listed.createdAt,
    updatedAt: inspected.updatedAt ?? listed.updatedAt,
    recencyAt: inspected.recencyAt ?? listed.recencyAt,
    lastUserPrompt: inspected.lastUserPrompt ?? listed.lastUserPrompt,
    lastActivity: inspected.lastActivity ?? listed.lastActivity,
    finalResponse: inspected.finalResponse ?? listed.finalResponse,
    lastError: inspected.lastError ?? listed.lastError,
  };
}

function markLocallyDetectedActive(
  summary: RemoteSessionSummary,
  activeThreads: Map<string, string | undefined>,
): RemoteSessionSummary {
  if (!activeThreads.has(summary.id)) return summary;
  const detectedTurnId = activeThreads.get(summary.id);
  if ((summary.status === "active" || summary.lastTurnStatus === "inProgress")
    && (!detectedTurnId || summary.lastTurnId === detectedTurnId)) return summary;
  return {
    ...summary,
    status: "active",
    lastTurnId: detectedTurnId ?? summary.lastTurnId,
    lastTurnStatus: "inProgress",
    lastActivity: undefined,
    finalResponse: undefined,
  };
}

function codexUserInput(prompt: RuntimePrompt): Array<Record<string, unknown>> {
  const normalized = typeof prompt === "string" ? { text: prompt, localImagePaths: [] } : {
    text: prompt.text,
    localImagePaths: prompt.localImagePaths ?? [],
  };
  return [
    ...(normalized.text.trim() ? [{ type: "text", text: normalized.text, text_elements: [] }] : []),
    ...normalized.localImagePaths.map((imagePath) => ({ type: "localImage", path: imagePath })),
  ];
}

function remoteThreadStatus(value: string | undefined): RemoteSessionSummary["status"] {
  if (value === "active") return "active";
  if (value === "idle") return "idle";
  if (value === "systemError") return "error";
  return "not_loaded";
}

function codexSourceLabel(source: unknown): string {
  if (typeof source === "string") return source;
  if (isRecord(source)) {
    if (typeof source.custom === "string") return source.custom;
    if (source.subAgent !== undefined) return "subAgent";
  }
  return "unknown";
}
