import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { CodexVersionError } from "../../src/codex/CodexVersion.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  ThreadWriterProcess,
  ThreadWriterProcessController,
} from "../../src/codex/ThreadWriterProcess.js";
import type { AppConfig } from "../../src/config/schema.js";
import { generateGroupAvatarPng, resolveGroupAvatarProjectName } from "../../src/feishu/GroupAvatarGenerator.js";
import type { FeishuOutbound, IncomingMessage } from "../../src/feishu/types.js";
import type { TurnPresenter } from "../../src/presentation/OutboundRouter.js";
import { OutboundRouter } from "../../src/presentation/OutboundRouter.js";
import { ProxySessionController } from "../../src/proxy/ProxySessionController.js";
import { AgentRuntimeRegistry } from "../../src/runtime/AgentRuntimeRegistry.js";
import type { AgentRuntime, RemoteSessionSummary, RemoteTurnPage, RuntimeEvent, RuntimeGoal, RuntimeSession } from "../../src/runtime/types.js";
import type {
  ShellCommandJobManagerLike,
  ShellCommandJobSnapshot,
} from "../../src/shell/ShellCommandJobManager.js";
import { StateStore } from "../../src/state/StateStore.js";
import type {
  ShellCommandOptions,
  ShellCommandResult,
} from "../../src/utils/executeShellCommand.js";

vi.mock("../../src/feishu/GroupAvatarGenerator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/feishu/GroupAvatarGenerator.js")>();
  return {
    ...actual,
    generateGroupAvatarPng: vi.fn(() => Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])),
  };
});

const tempDirs: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function message(text: string): IncomingMessage {
  return { messageId: `m-${text}`, contextKey: "chat_id:c1", text };
}

function threadWriterOwner(): ThreadWriterProcess {
  return {
    writerPid: 53704,
    writerProcessName: "codex.exe",
    writerStartedAt: "2026-09-05T10:00:00.000Z",
    applicationPid: 81552,
    applicationProcessName: "ChatGPT.exe",
    applicationStartedAt: "2026-09-05T09:00:00.000Z",
    displayName: "Codex Desktop",
    canClose: true,
  };
}

class FakeShellCommandJobManager implements ShellCommandJobManagerLike {
  private sequence = 0;
  private readonly jobs = new Map<string, ShellCommandJobSnapshot>();
  private readonly presented = new Set<string>();
  readonly requestCancellation = vi.fn(async (jobId: string) => {
    const job = this.requireJob(jobId);
    if (!["starting", "running", "cancelling"].includes(job.status)) return false;
    this.jobs.set(jobId, { ...job, status: "cancelled", completedAt: Date.now(), updatedAt: Date.now() });
    return true;
  });

  constructor(private readonly executor: (
    command: string,
    cwd: string,
    options?: ShellCommandOptions,
  ) => Promise<ShellCommandResult>) {}

  async createJob(input: {
    contextKey: string;
    sourceMessageId?: string;
    command: string;
    cwd: string;
  }): Promise<ShellCommandJobSnapshot> {
    const id = `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, "0")}`;
    const createdAt = Date.now();
    const job: ShellCommandJobSnapshot = {
      version: 1,
      id,
      ...input,
      createdAt,
      startedAt: createdAt,
      updatedAt: createdAt,
      status: "starting",
      output: "",
      outputTruncated: false,
    };
    this.jobs.set(id, job);
    return job;
  }

  async bindCard(jobId: string, cardMessageId: string): Promise<ShellCommandJobSnapshot> {
    const job = { ...this.requireJob(jobId), cardMessageId };
    this.jobs.set(jobId, job);
    return job;
  }

  async findJobByCardMessageId(cardMessageId: string): Promise<ShellCommandJobSnapshot | undefined> {
    const job = [...this.jobs.values()].find((candidate) => candidate.cardMessageId === cardMessageId);
    return job ? { ...job } : undefined;
  }

  async startJob(jobId: string): Promise<void> {
    const job = this.requireJob(jobId);
    this.jobs.set(jobId, { ...job, status: "running", updatedAt: Date.now() });
    void this.executor(job.command, job.cwd, {
      onOutput: (output) => {
        const current = this.requireJob(jobId);
        this.jobs.set(jobId, {
          ...current,
          output: `${output.stdout}${output.stderr}`,
          outputTruncated: output.outputTruncated,
          updatedAt: Date.now(),
        });
      },
    }).then((result) => {
      const current = this.requireJob(jobId);
      if (current.status === "cancelled") return;
      const now = Date.now();
      this.jobs.set(jobId, {
        ...current,
        output: `${result.stdout}${result.stderr}`,
        outputTruncated: result.outputTruncated,
        status: result.timedOut ? "failed" : result.exitCode === 0 ? "completed" : "failed",
        exitCode: result.exitCode,
        updatedAt: now,
        completedAt: now,
      });
    }).catch((error: unknown) => void this.failJob(jobId, String(error)));
  }

  async failJob(jobId: string, error: string): Promise<void> {
    const job = this.requireJob(jobId);
    const now = Date.now();
    this.jobs.set(jobId, { ...job, status: "failed", error, updatedAt: now, completedAt: now });
  }

  async readJob(jobId: string): Promise<ShellCommandJobSnapshot> {
    return { ...this.requireJob(jobId) };
  }

  async listRecoverableJobs(): Promise<ShellCommandJobSnapshot[]> {
    return [...this.jobs.values()]
      .filter((job) => ["starting", "running", "cancelling"].includes(job.status) || !this.presented.has(job.id))
      .map((job) => ({ ...job }));
  }

  async markPresented(jobId: string): Promise<void> {
    this.presented.add(jobId);
  }

  seedJob(job: ShellCommandJobSnapshot): void {
    this.jobs.set(job.id, { ...job });
  }

  private requireJob(jobId: string): ShellCommandJobSnapshot {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Missing fake shell command job: ${jobId}`);
    return job;
  }
}

function sessionOverflowActions(
  card: unknown,
  store?: StateStore,
  messageId = "card",
): Array<Record<string, unknown>> {
  const actions: Array<Record<string, unknown>> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.tag === "overflow" && Array.isArray(record.options)) {
      for (const option of record.options) {
        if (!option || typeof option !== "object") continue;
        const encoded = (option as Record<string, unknown>).value;
        if (typeof encoded !== "string") continue;
        try {
          const parsed = JSON.parse(encoded) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const value = parsed as Record<string, unknown>;
            const token = typeof value.t === "string" ? value.t : undefined;
            const resolved = token && store ? store.getCardActionBinding(messageId, token) : undefined;
            actions.push(resolved ?? value);
          }
        } catch {
          // Ignore unrelated overflow options.
        }
      }
    }
    if (record.type === "callback" && record.value && typeof record.value === "object" && !Array.isArray(record.value)) {
      const value = record.value as Record<string, unknown>;
      const token = typeof value.t === "string" ? value.t : undefined;
      const resolved = token && store ? store.getCardActionBinding(messageId, token) : undefined;
      actions.push(resolved ?? value);
    }
    Object.values(record).forEach(visit);
  };
  visit(card);
  return actions;
}

function sessionOverflowToken(card: unknown, label: string): string | undefined {
  let token: string | undefined;
  const visit = (value: unknown): void => {
    if (token) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.tag === "overflow" && Array.isArray(record.options)) {
      for (const option of record.options) {
        if (!option || typeof option !== "object") continue;
        const candidate = option as Record<string, unknown>;
        const text = candidate.text as Record<string, unknown> | undefined;
        if (text?.content !== label || typeof candidate.value !== "string") continue;
        const parsed = JSON.parse(candidate.value) as Record<string, unknown>;
        if (typeof parsed.t === "string") {
          token = parsed.t;
          return;
        }
      }
    }
    Object.values(record).forEach(visit);
  };
  visit(card);
  return token;
}

function groupMessage(chatId: string, text: string): IncomingMessage {
  return {
    messageId: `m-${chatId}-${text}`,
    contextKey: `chat_id:${chatId}`,
    chatId,
    chatType: "group",
    text,
  };
}

function threadMessage(
  chatId: string,
  chatType: "p2p" | "group",
  threadId: string,
  rootMessageId: string,
  text: string,
): IncomingMessage {
  return {
    messageId: `m-${threadId}-${text}`,
    contextKey: `chat_id:${chatId}:thread_id:${threadId}`,
    chatId,
    chatType,
    replyInThread: true,
    threadContext: true,
    threadId,
    rootMessageId,
    parentMessageId: rootMessageId,
    text,
  };
}

function fixture(
  extraRuntimes: Record<string, AgentRuntime> = {},
  threadWriterProcesses: ThreadWriterProcessController = {
    inspect: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
  },
) {
  const sessions = new Map<string, RuntimeSession>();
  const remoteSessions: RemoteSessionSummary[] = [];
  let nextRemoteSessionNumber = 1;
  const goals = new Map<string, RuntimeGoal>();
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const runtime: AgentRuntime = {
    kind: "codex",
    getThreadWriterLockPath: vi.fn((remoteSessionId) => path.join("C:\\codex-home", `${remoteSessionId}.lock`)),
    createSession: vi.fn(async (input) => {
      const session: RuntimeSession = {
        ...input,
        remoteSessionId: `thr_${nextRemoteSessionNumber++}`,
        runtimeKind: "codex",
        modelProvider: input.modelProvider ?? "openai",
        model: input.model ?? "gpt-test",
        reasoningEffort: input.reasoningEffort ?? "high",
      };
      sessions.set(input.localSessionId, session);
      const existingRemote = remoteSessions.find((candidate) => candidate.id === session.remoteSessionId);
      if (!existingRemote) {
        remoteSessions.push({
          id: session.remoteSessionId,
          title: input.title,
          cwd: input.cwd,
          source: "agent-bot",
          status: "idle",
        });
      }
      return session;
    }),
    resumeSession: vi.fn(async (input) => {
      const session: RuntimeSession = {
        ...input,
        runtimeKind: "codex",
        modelProvider: input.modelProvider ?? "openai",
        model: input.model ?? "gpt-test",
        reasoningEffort: input.reasoningEffort ?? "high",
      };
      sessions.set(input.localSessionId, session);
      return session;
    }),
    forkSession: vi.fn(async (input) => {
      const remoteSessionId = `${input.remoteSessionId}_fork`;
      const session: RuntimeSession = {
        ...input,
        remoteSessionId,
        runtimeKind: "codex",
        modelProvider: input.modelProvider ?? "openai",
        model: input.model ?? "gpt-test",
        reasoningEffort: input.reasoningEffort ?? "high",
      };
      sessions.set(input.localSessionId, session);
      remoteSessions.push({
        id: remoteSessionId,
        title: input.title,
        cwd: input.cwd,
        source: "agent-bot",
        status: "idle",
        lastTurnId: input.lastTurnId,
        lastTurnStatus: "completed",
      });
      return session;
    }),
    getSession: vi.fn((id) => sessions.get(id)),
    readSessionMetadata: vi.fn(async () => ({})),
    listRemoteSessions: vi.fn(async ({
      searchTerm,
      cursor,
      limit = 20,
    }: { searchTerm?: string; cursor?: string; limit?: number } = {}) => {
      const matches = remoteSessions.filter((session) => !searchTerm || session.title?.includes(searchTerm));
      const offset = cursor ? Number.parseInt(cursor, 10) : 0;
      const nextOffset = offset + limit;
      return {
        sessions: matches.slice(offset, nextOffset),
        nextCursor: matches.length > nextOffset ? String(nextOffset) : undefined,
      };
    }),
    readRemoteSession: vi.fn(async (id: string) => {
      const session = remoteSessions.find((candidate) => candidate.id === id);
      if (!session) throw new Error(`Unknown remote session: ${id}`);
      return session;
    }),
    readRemoteForkSource: vi.fn(async (id: string) => {
      const session = remoteSessions.find((candidate) => candidate.id === id);
      if (!session) throw new Error(`Unknown remote session: ${id}`);
      return session;
    }),
    listRemoteTurnSummaries: vi.fn(async (id, { cursor, limit }) => {
      const session = remoteSessions.find((candidate) => candidate.id === id);
      if (!session) throw new Error(`Unknown remote session: ${id}`);
      const turns = (session.completedTurns ?? []).slice().reverse();
      const offset = Number(cursor ?? 0);
      return {
        turns: turns.slice(offset, offset + limit),
        nextCursor: offset + limit < turns.length ? String(offset + limit) : undefined,
      };
    }),
    inspectRemoteSessionActivity: vi.fn(async (id: string) => {
      const session = remoteSessions.find((candidate) => candidate.id === id);
      if (!session) throw new Error(`Unknown remote session: ${id}`);
      const active = session.status === "active" || session.lastTurnStatus === "inProgress";
      return {
        active,
        ...(active && session.lastTurnId ? { activeTurnId: session.lastTurnId } : {}),
      };
    }),
    synchronizeSession: vi.fn(async (id) => sessions.get(id)!),
    startTurn: vi.fn(async (sessionId) => {
      const session = sessions.get(sessionId)!;
      session.activeTurnId = "turn_1";
      const remote = remoteSessions.find((candidate) => candidate.id === session.remoteSessionId);
      if (remote) {
        remote.status = "active";
        remote.lastTurnId = "turn_1";
        remote.lastTurnStatus = "inProgress";
      }
      for (const listener of listeners) listener({ type: "turn_started", sessionId, turnId: "turn_1", startedAt: 1 });
      return "turn_1";
    }),
    steerTurn: vi.fn(async () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    interruptRemoteTurn: vi.fn(async () => undefined),
    archiveRemoteSession: vi.fn(async (remoteSessionId) => {
      const index = remoteSessions.findIndex((candidate) => candidate.id === remoteSessionId);
      if (index >= 0) remoteSessions.splice(index, 1);
      for (const [localSessionId, session] of sessions) {
        if (session.remoteSessionId === remoteSessionId) sessions.delete(localSessionId);
      }
    }),
    closeSession: vi.fn(async () => undefined),
    setTitle: vi.fn(async (sessionId, title) => {
      sessions.get(sessionId)!.title = title;
    }),
    getGoal: vi.fn(async (sessionId) => goals.get(sessionId)),
    setGoal: vi.fn(async (sessionId, update) => {
      const current = goals.get(sessionId);
      const goal: RuntimeGoal = {
        threadId: sessions.get(sessionId)!.remoteSessionId,
        objective: update.objective ?? current?.objective ?? "",
        status: update.status ?? current?.status ?? "active",
        tokenBudget: update.tokenBudget ?? current?.tokenBudget ?? null,
        tokensUsed: current?.tokensUsed ?? 0,
        timeUsedSeconds: current?.timeUsedSeconds ?? 0,
        createdAt: current?.createdAt ?? 1_776_272_400,
        updatedAt: 1_776_272_460,
      };
      goals.set(sessionId, goal);
      return goal;
    }),
    clearGoal: vi.fn(async (sessionId) => goals.delete(sessionId)),
    setModel: vi.fn(async (sessionId, model) => {
      sessions.get(sessionId)!.model = model;
    }),
    setReasoningEffort: vi.fn(async (sessionId, effort) => {
      sessions.get(sessionId)!.reasoningEffort = effort;
    }),
    setPermissionMode: vi.fn(async () => undefined),
    setExecutionSettings: vi.fn(async (sessionId, settings, persist) => {
      const session = sessions.get(sessionId)!;
      const candidate = { ...session, ...settings };
      await persist?.(candidate);
      Object.assign(session, candidate);
      return session;
    }),
    respondToApproval: vi.fn(async () => undefined),
    listModels: vi.fn(async () => [
      {
        id: "gpt-test",
        displayName: "GPT Test",
        isDefault: true,
        supportedReasoningEfforts: [
          { value: "low", description: "Fast" },
          { value: "high", description: "Deep" },
        ],
        defaultReasoningEffort: "low",
      },
      {
        id: "gpt-next",
        displayName: "GPT Next",
        supportedReasoningEfforts: [
          { value: "medium", description: "Balanced" },
          { value: "xhigh", description: "Deep" },
        ],
        defaultReasoningEffort: "medium",
      },
    ]),
    listModelProviders: vi.fn(async () => [
      { id: "openai", displayName: "OpenAI", isDefault: true },
      { id: "azure", displayName: "Azure OpenAI" },
    ]),
    release: vi.fn(async ({ force = false }: { force?: boolean } = {}) => {
      const activeSessionIds = [...sessions.values()]
        .filter((session) => Boolean(session.activeTurnId))
        .map((session) => session.localSessionId);
      if (activeSessionIds.length > 0 && !force) return { status: "busy" as const, activeSessionIds };
      for (const session of sessions.values()) session.activeTurnId = undefined;
      return { status: "released" as const };
    }),
    onEvent: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    close: vi.fn(),
  };
  const acp = { ...runtime, kind: "acp" as const } as AgentRuntime;
  const outbound: FeishuOutbound = {
    createGroup: vi.fn(async (input) => ({ chatId: "oc_new_group", name: input.name })),
    deleteGroup: vi.fn(async () => undefined),
    addReaction: vi.fn(async () => undefined),
    deleteReaction: vi.fn(async () => undefined),
    downloadImage: vi.fn(async (_messageId, imageKey) => path.join(process.cwd(), `${imageKey}.png`)),
    downloadFile: vi.fn(async (_messageId, _fileKey, fileName) => path.join(process.cwd(), fileName)),
    readMergedForward: vi.fn(async () => ({
      text: "resolved merged-forward transcript",
      messageCount: 2,
      truncated: false,
      images: [],
      files: [],
    })),
    readReferencedMessage: vi.fn(async () => ({
      text: "[消息类型：文本]\nquoted message",
      messageType: "text",
      images: [],
      files: [],
    })),
    sendText: vi.fn(async () => "text"),
    sendFile: vi.fn(async () => "file"),
    sendMarkdown: vi.fn(async () => "markdown"),
    sendInteractiveCard: vi.fn(async () => "card"),
    replyText: vi.fn(async () => "thread_text"),
    replyFile: vi.fn(async () => "thread_file"),
    replyMarkdown: vi.fn(async () => "thread_markdown"),
    replyInteractiveCard: vi.fn(async () => "thread_card"),
    updateInteractiveCard: vi.fn(async () => undefined),
  };
  const presenter: TurnPresenter = {
    registerSession: vi.fn(),
    updateSessionTitle: vi.fn(),
    unregisterSession: vi.fn(),
    startPendingTurn: vi.fn(async () => undefined),
    failPendingTurn: vi.fn(async () => false),
    interruptTurnForRecovery: vi.fn(async () => undefined),
    appendSteerMessage: vi.fn(async () => undefined),
    onEvent: vi.fn(async () => undefined),
    showDetails: vi.fn(async () => undefined),
    showActivityPage: vi.fn(async () => undefined),
    resumeDelivery: vi.fn(async () => undefined),
    flushAll: vi.fn(async () => undefined),
  };
  const outboundRouter = new OutboundRouter([{ matches: () => true, outbound, presenter }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-controller-"));
  tempDirs.push(dir);
  const store = new StateStore(path.join(dir, "state.sqlite"));
  const config = {
    feishu: {
      groupNameFormat: {
        project: "[{agent}] [{project}] {taskname}",
        projectless: "[{agent}] {taskname}",
        dateFormat: "MM-dd",
      },
    },
    agents: {
      codex: { kind: "app-server", title: "Codex", command: "codex", args: [], env: {} },
      acp: { kind: "acp", title: "ACP", command: "acp", args: [], env: {} },
      ...Object.fromEntries(Object.keys(extraRuntimes).map((agentName) => [
        agentName,
        {
          kind: extraRuntimes[agentName]!.kind === "codex" ? "app-server" : "acp",
          title: agentName,
          command: agentName,
          args: [],
          env: {},
        },
      ])),
    },
    defaults: { agent: "codex", cwd: process.cwd() },
    storage: { sqlitePath: path.join(dir, "state.sqlite") },
  } as unknown as AppConfig;
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const restart = vi.fn(async () => undefined);
  const cancelSafeRestart = vi.fn(async () => true);
  const rememberFeishuUserOpenId = vi.fn(async () => undefined);
  const persistAgentExecutionDefaults = vi.fn(async () => undefined);
  const shellCommandExecutor = vi.fn(async () => ({
    stdout: "README.md\nsrc\ntests\n",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    outputTruncated: false,
  }));
  const windowsDriveLister = vi.fn(async () => [
    { root: "C:\\", label: "Windows", driveType: "Fixed" },
    { root: "D:\\", driveType: "Fixed" },
  ]);
  const shellCommandJobs = new FakeShellCommandJobManager(shellCommandExecutor);
  const controller = new ProxySessionController(
    config,
    store,
    new AgentRuntimeRegistry({ acp, codex: runtime, ...extraRuntimes }),
    outboundRouter,
    logger,
    {
      restart,
      supervised: true,
      cancelSafeRestart,
      rememberFeishuUserOpenId,
      persistAgentExecutionDefaults,
    },
    shellCommandExecutor,
    windowsDriveLister,
    shellCommandJobs,
    threadWriterProcesses,
  );
  cleanups.push(() => {
    controller.close();
    store.close();
  });
  return {
    controller,
    runtime,
    sessions,
    goals,
    remoteSessions,
    outbound,
    outboundRouter,
    presenter,
    store,
    logger,
    listeners,
    restart,
    cancelSafeRestart,
    rememberFeishuUserOpenId,
    persistAgentExecutionDefaults,
    shellCommandExecutor,
    shellCommandJobs,
    windowsDriveLister,
    threadWriterProcesses,
    config,
  };
}

describe("ProxySessionController", () => {
  test("recovers an interrupted turn in its original topic with a fresh thinking card", async () => {
    const { controller, runtime, remoteSessions, outbound, presenter, store } = fixture();
    const contextKey = "chat_id:c1:thread_id:t1";
    const recentAt = new Date(Date.now() - 6 * 60 * 1_000).toISOString();
    remoteSessions.push({
      id: "thr_recovery",
      cwd: process.cwd(),
      source: "agent-bot",
      status: "not_loaded",
      lastTurnId: "turn_interrupted",
      lastTurnStatus: "interrupted",
    });
    store.getOrCreateUserContext(contextKey, "codex");
    store.createSession({
      localSessionId: "session_recovery",
      contextKey,
      agentName: "codex",
      cwd: process.cwd(),
      status: "running",
    });
    store.updateRuntimeSession("session_recovery", {
      runtimeKind: "codex",
      remoteSessionId: "thr_recovery",
      lastTurnId: "turn_interrupted",
      lastTurnStatus: "running",
      title: "Interrupted work",
    });
    store.saveTurnSnapshot("turn_interrupted", "session_recovery", {
      sessionId: "session_recovery",
      turnId: "turn_interrupted",
      status: "running",
      startedAt: 1,
      prompt: "finish the original task",
      replyTarget: { messageId: "om_original", replyInThread: true },
      assistantText: "",
      plan: [],
      activities: [],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
    }, contextKey);
    store.createTurnAttempt({
      attemptId: "attempt_recovery",
      localSessionId: "session_recovery",
      contextKey,
      promptText: "finish the original task",
      messageId: "om_user",
      replyMessageId: "om_original",
      turnId: "turn_interrupted",
      status: "running",
      createdAt: recentAt,
      updatedAt: recentAt,
    });

    await controller.recoverInterruptedTasks();

    expect(outbound.replyText).toHaveBeenCalledWith(
      contextKey,
      { messageId: "om_original", replyInThread: true },
      "检测到任务在 Agent Bot 重启前尚未完成，正在自动恢复。",
    );
    expect(presenter.interruptTurnForRecovery).toHaveBeenCalledWith(
      "session_recovery",
      contextKey,
      "turn_interrupted",
      expect.stringContaining("新的思考卡片"),
    );
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      "session_recovery",
      contextKey,
      "Interrupted work",
      { messageId: "om_original", replyInThread: true },
      "恢复重启前的任务：finish the original task",
    );
    expect(runtime.startTurn).toHaveBeenCalledWith(
      "session_recovery",
      expect.stringContaining("Finish the original request:\n\nfinish the original task"),
    );
    expect(store.getTurnAttempt("attempt_recovery")).toMatchObject({
      turnId: "turn_1",
      recoveredFromTurnId: "turn_interrupted",
      recoveryCount: 1,
      status: "running",
    });
  });

  test("keeps a recovered turn in the attached group when the task was created in a private chat", async () => {
    const { controller, runtime, remoteSessions, outbound, outboundRouter, presenter, store } = fixture();
    const privateContextKey = "chat_id:private";
    const groupContextKey = "chat_id:group";
    remoteSessions.push({
      id: "thr_shared_recovery",
      cwd: process.cwd(),
      source: "agent-bot",
      status: "not_loaded",
      lastTurnId: "turn_shared_interrupted",
      lastTurnStatus: "interrupted",
    });
    store.getOrCreateUserContext(privateContextKey, "codex");
    store.getOrCreateUserContext(groupContextKey, "codex");
    store.createSession({
      localSessionId: "session_shared_recovery",
      contextKey: privateContextKey,
      agentName: "codex",
      cwd: process.cwd(),
      status: "running",
    });
    store.attachSessionToContext(groupContextKey, "session_shared_recovery");
    store.setCurrentSession(groupContextKey, "session_shared_recovery");
    store.updateRuntimeSession("session_shared_recovery", {
      runtimeKind: "codex",
      remoteSessionId: "thr_shared_recovery",
      lastTurnId: "turn_shared_interrupted",
      lastTurnStatus: "running",
      title: "Shared interrupted work",
    });
    store.saveTurnSnapshot("turn_shared_interrupted", "session_shared_recovery", {
      sessionId: "session_shared_recovery",
      turnId: "turn_shared_interrupted",
      status: "running",
      startedAt: 1,
      prompt: "finish the shared task",
      assistantText: "",
      plan: [],
      activities: [],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
    }, groupContextKey);
    store.createTurnAttempt({
      attemptId: "attempt_shared_recovery",
      localSessionId: "session_shared_recovery",
      contextKey: groupContextKey,
      promptText: "finish the shared task",
      turnId: "turn_shared_interrupted",
      status: "running",
    });

    await controller.recoverInterruptedTasks();

    expect(outbound.sendText).toHaveBeenCalledWith(
      groupContextKey,
      "检测到任务在 Agent Bot 重启前尚未完成，正在自动恢复。",
    );
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      "session_shared_recovery",
      groupContextKey,
      "Shared interrupted work",
      undefined,
      "恢复重启前的任务：finish the shared task",
    );
    expect(runtime.startTurn).toHaveBeenCalledWith(
      "session_shared_recovery",
      expect.stringContaining("Finish the original request:\n\nfinish the shared task"),
    );
    expect(outboundRouter.getSessionContextKey("session_shared_recovery")).toBe(groupContextKey);
    expect(store.getSession("session_shared_recovery")?.contextKey).toBe(privateContextKey);
  });

  test("expires an interrupted turn inactive for more than ten minutes without recovering it", async () => {
    const { controller, runtime, outbound, presenter, store } = fixture();
    const staleAt = new Date(Date.now() - 11 * 60 * 1_000).toISOString();
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({
      localSessionId: "session_stale_recovery",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: process.cwd(),
      status: "running",
    });
    store.updateRuntimeSession("session_stale_recovery", {
      runtimeKind: "codex",
      remoteSessionId: "thr_stale_recovery",
      lastTurnId: "turn_stale_recovery",
      lastTurnStatus: "running",
      title: "Old interrupted work",
    });
    store.createTurnAttempt({
      attemptId: "attempt_stale_recovery",
      localSessionId: "session_stale_recovery",
      contextKey: "chat_id:c1",
      promptText: "do not revive old work",
      turnId: "turn_stale_recovery",
      status: "running",
      createdAt: staleAt,
      updatedAt: staleAt,
    });

    await controller.recoverInterruptedTasks();

    expect(runtime.startTurn).not.toHaveBeenCalled();
    expect(outbound.sendText).not.toHaveBeenCalled();
    expect(outbound.replyText).not.toHaveBeenCalled();
    expect(presenter.interruptTurnForRecovery).toHaveBeenCalledWith(
      "session_stale_recovery",
      "chat_id:c1",
      "turn_stale_recovery",
      "执行中断已超过 10 分钟，未自动恢复。",
    );
    expect(store.getTurnAttempt("attempt_stale_recovery")?.status).toBe("interrupted");
    expect(store.getSession("session_stale_recovery")).toMatchObject({
      status: "ready",
      lastTurnStatus: "cancelled",
    });
  });

  test("finishes a persisted user-requested cancellation without recovering the task", async () => {
    const { controller, runtime, presenter, store } = fixture();
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({
      localSessionId: "session_user_cancelled",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: process.cwd(),
      status: "running",
    });
    store.updateRuntimeSession("session_user_cancelled", {
      runtimeKind: "codex",
      remoteSessionId: "thr_user_cancelled",
      lastTurnId: "turn_user_cancelled",
      lastTurnStatus: "running",
    });
    store.createTurnAttempt({
      attemptId: "attempt_user_cancelled",
      localSessionId: "session_user_cancelled",
      contextKey: "chat_id:c1",
      promptText: "do not resume this",
      turnId: "turn_user_cancelled",
      status: "running",
    });
    store.requestTurnAttemptCancellation("turn_user_cancelled");

    await controller.recoverInterruptedTasks();

    expect(runtime.startTurn).not.toHaveBeenCalled();
    expect(presenter.onEvent).toHaveBeenCalledWith({
      type: "turn_cancelled",
      sessionId: "session_user_cancelled",
      turnId: "turn_user_cancelled",
    });
    expect(store.getTurnAttempt("attempt_user_cancelled")?.status).toBe("cancelled");
    expect(store.getSession("session_user_cancelled")).toMatchObject({
      status: "ready",
      lastTurnStatus: "cancelled",
    });
  });

  test("reconciles a remotely completed turn after restart without starting it again", async () => {
    const { controller, runtime, sessions, remoteSessions, presenter, store, listeners } = fixture();
    remoteSessions.push({
      id: "thr_completed_offline",
      cwd: process.cwd(),
      source: "agent-bot",
      status: "idle",
      lastTurnId: "turn_completed_offline",
      lastTurnStatus: "completed",
      finalResponse: "completed while Agent Bot was restarting",
    });
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({
      localSessionId: "session_completed_offline",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: process.cwd(),
      status: "running",
    });
    store.updateRuntimeSession("session_completed_offline", {
      runtimeKind: "codex",
      remoteSessionId: "thr_completed_offline",
      lastTurnId: "turn_completed_offline",
      lastTurnStatus: "running",
    });
    store.createTurnAttempt({
      attemptId: "attempt_completed_offline",
      localSessionId: "session_completed_offline",
      contextKey: "chat_id:c1",
      promptText: "do not repeat this",
      turnId: "turn_completed_offline",
      status: "running",
    });
    (runtime.synchronizeSession as ReturnType<typeof vi.fn>).mockImplementationOnce(async (sessionId: string) => {
      const session = sessions.get(sessionId)!;
      session.activeTurnId = undefined;
      for (const listener of listeners) {
        listener({
          type: "turn_completed",
          sessionId,
          turnId: "turn_completed_offline",
          finalResponse: "completed while Agent Bot was restarting",
        });
      }
      return session;
    });

    await controller.recoverInterruptedTasks();
    await vi.waitFor(() => {
      expect(store.getTurnAttempt("attempt_completed_offline")?.status).toBe("completed");
    });

    expect(runtime.startTurn).not.toHaveBeenCalled();
    expect(presenter.onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "turn_completed",
      turnId: "turn_completed_offline",
    }));
  });

  test("reattaches a remotely active turn to a new thinking card without duplicating execution", async () => {
    const { controller, runtime, remoteSessions, presenter, store } = fixture();
    remoteSessions.push({
      id: "thr_still_active",
      cwd: process.cwd(),
      source: "agent-bot",
      status: "active",
      lastTurnId: "turn_still_active",
      lastTurnStatus: "inProgress",
    });
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({
      localSessionId: "session_still_active",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: process.cwd(),
      status: "running",
    });
    store.updateRuntimeSession("session_still_active", {
      runtimeKind: "codex",
      remoteSessionId: "thr_still_active",
      lastTurnId: "turn_still_active",
      lastTurnStatus: "running",
      title: "Still active",
    });
    store.saveTurnSnapshot("turn_still_active", "session_still_active", {
      sessionId: "session_still_active",
      turnId: "turn_still_active",
      status: "running",
      startedAt: 1,
      prompt: "keep monitoring",
      assistantText: "",
      plan: [],
      activities: [],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
    }, "chat_id:c1");
    store.createTurnAttempt({
      attemptId: "attempt_still_active",
      localSessionId: "session_still_active",
      contextKey: "chat_id:c1",
      promptText: "keep monitoring",
      turnId: "turn_still_active",
      status: "running",
    });

    await controller.recoverInterruptedTasks();

    expect(runtime.startTurn).not.toHaveBeenCalled();
    expect(presenter.interruptTurnForRecovery).toHaveBeenCalledWith(
      "session_still_active",
      "chat_id:c1",
      "turn_still_active",
      expect.stringContaining("进度已转移"),
    );
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      "session_still_active",
      "chat_id:c1",
      "Still active",
      undefined,
      "恢复重启前的任务：keep monitoring",
    );
    expect(presenter.onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "turn_started",
      turnId: "turn_still_active",
    }));
  });

  test("backfills and recovers a pending card created before the turn id was persisted", async () => {
    const { controller, runtime, remoteSessions, presenter, store } = fixture();
    remoteSessions.push({
      id: "thr_pending_window",
      cwd: process.cwd(),
      source: "agent-bot",
      status: "idle",
    });
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({
      localSessionId: "session_pending_window",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: process.cwd(),
      status: "ready",
    });
    store.updateRuntimeSession("session_pending_window", {
      runtimeKind: "codex",
      remoteSessionId: "thr_pending_window",
      title: "Pending window",
    });
    store.saveTurnSnapshot("pending_before_crash", "session_pending_window", {
      sessionId: "session_pending_window",
      turnId: "pending_before_crash",
      status: "starting",
      startedAt: Date.now(),
      prompt: "start after reconnect",
      assistantText: "",
      plan: [],
      activities: [],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
    }, "chat_id:c1");

    await controller.recoverInterruptedTasks();

    expect(presenter.interruptTurnForRecovery).toHaveBeenCalledWith(
      "session_pending_window",
      "chat_id:c1",
      "pending_before_crash",
      expect.any(String),
    );
    expect(runtime.startTurn).toHaveBeenCalledWith(
      "session_pending_window",
      expect.stringContaining("start after reconnect"),
    );
    expect(store.findIncompleteTurnAttemptForSession("session_pending_window")).toMatchObject({
      turnId: "turn_1",
      recoveredFromTurnId: "pending_before_crash",
      recoveryCount: 1,
    });
  });

  test("retries transient LLM turn failures three times before making the task terminal", async () => {
    const { controller, runtime, sessions, outbound, presenter, store, listeners } = fixture();
    (outbound.addReaction as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("reaction_on_it")
      .mockResolvedValue("reaction_terminal");

    await controller.onMessage(message("finish despite provider overload"));
    const session = store.listSessions("chat_id:c1")[0]!;
    const attemptId = store.findIncompleteTurnAttemptForSession(session.localSessionId)!.attemptId;
    let failedTurnId = "turn_1";

    for (let retryNumber = 1; retryNumber <= 3; retryNumber += 1) {
      const retryTurnId = `turn_retry_${retryNumber}`;
      (runtime.startTurn as ReturnType<typeof vi.fn>).mockImplementationOnce(async (sessionId: string) => {
        sessions.get(sessionId)!.activeTurnId = retryTurnId;
        for (const listener of listeners) {
          listener({ type: "turn_started", sessionId, turnId: retryTurnId, startedAt: Date.now() });
        }
        return retryTurnId;
      });
      sessions.get(session.localSessionId)!.activeTurnId = undefined;
      for (const listener of listeners) {
        listener({
          type: "turn_failed",
          sessionId: session.localSessionId,
          turnId: failedTurnId,
          message: "503 Service Unavailable: model provider overloaded",
        });
      }

      await vi.waitFor(() => expect(store.findIncompleteTurnAttemptForSession(session.localSessionId)).toMatchObject({
        turnId: retryTurnId,
        retryCount: retryNumber,
        status: "running",
      }));
      expect(store.getMessageReaction("m-finish despite provider overload")).toMatchObject({
        turnId: retryTurnId,
        status: "pending",
        emojiType: "OnIt",
      });
      failedTurnId = retryTurnId;
    }

    sessions.get(session.localSessionId)!.activeTurnId = undefined;
    for (const listener of listeners) {
      listener({
        type: "turn_failed",
        sessionId: session.localSessionId,
        turnId: failedTurnId,
        message: "503 Service Unavailable: model provider overloaded",
      });
    }

    await vi.waitFor(() => expect(store.getSession(session.localSessionId)).toMatchObject({
      status: "failed",
      lastTurnId: failedTurnId,
      lastTurnStatus: "failed",
    }));
    expect(store.getTurnAttempt(attemptId)).toMatchObject({
      turnId: failedTurnId,
      retryCount: 3,
      status: "failed",
    });
    expect(runtime.startTurn).toHaveBeenCalledTimes(4);
    expect(store.getMessageReaction("m-finish despite provider overload")).toMatchObject({
      turnId: failedTurnId,
      status: "failed",
      emojiType: "ERROR",
    });
    expect(presenter.onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "turn_failed",
      turnId: failedTurnId,
      message: expect.stringContaining("已自动重试 3 次"),
    }));
  });

  test("retries App Server connection failures before turn/start returns a turn id", async () => {
    const { controller, runtime, store } = fixture();
    const startTurn = runtime.startTurn as ReturnType<typeof vi.fn>;
    startTurn
      .mockRejectedValueOnce(new Error("App Server connection closed."))
      .mockRejectedValueOnce(new Error("App Server connection closed."))
      .mockRejectedValueOnce(new Error("App Server connection closed."));

    await controller.onMessage(message("survive App Server startup crashes"));

    expect(startTurn).toHaveBeenCalledTimes(4);
    const session = store.listSessions("chat_id:c1")[0]!;
    expect(store.findIncompleteTurnAttemptForSession(session.localSessionId)).toMatchObject({
      retryCount: 3,
      status: "running",
      turnId: "turn_1",
    });
  });

  test("retries an active turn when the App Server process disconnects", async () => {
    const { controller, runtime, sessions, store, listeners } = fixture();
    await controller.onMessage(message("continue after an App Server crash"));
    const session = store.listSessions("chat_id:c1")[0]!;
    (runtime.startTurn as ReturnType<typeof vi.fn>).mockImplementationOnce(async (sessionId: string) => {
      sessions.get(sessionId)!.activeTurnId = "turn_after_disconnect";
      for (const listener of listeners) {
        listener({ type: "turn_started", sessionId, turnId: "turn_after_disconnect", startedAt: Date.now() });
      }
      return "turn_after_disconnect";
    });
    sessions.get(session.localSessionId)!.activeTurnId = undefined;

    for (const listener of listeners) {
      listener({
        type: "turn_failed",
        sessionId: session.localSessionId,
        turnId: "turn_1",
        message: "App Server disconnected: App Server exited (code=3221226505, signal=null).",
      });
    }

    await vi.waitFor(() => expect(store.findIncompleteTurnAttemptForSession(session.localSessionId)).toMatchObject({
      retryCount: 1,
      status: "running",
      turnId: "turn_after_disconnect",
    }));
  });

  test("does not retry a permanent LLM request failure", async () => {
    const { controller, runtime, sessions, store, listeners } = fixture();

    await controller.onMessage(message("request beyond the context window"));
    const session = store.listSessions("chat_id:c1")[0]!;
    sessions.get(session.localSessionId)!.activeTurnId = undefined;
    for (const listener of listeners) {
      listener({
        type: "turn_failed",
        sessionId: session.localSessionId,
        turnId: "turn_1",
        message: "Maximum context length exceeded for this model",
      });
    }

    await vi.waitFor(() => expect(store.getSession(session.localSessionId)).toMatchObject({
      status: "failed",
      lastTurnStatus: "failed",
    }));
    expect(runtime.startTurn).toHaveBeenCalledTimes(1);
  });

  test("uses a completed snapshot as the next turn parent after stale crash state", async () => {
    const { controller, store, listeners } = fixture();

    await controller.onMessage(message("before crash"));
    const task = store.listSessions("chat_id:c1")[0]!;
    store.saveTurnSnapshot("turn_1", task.localSessionId, {
      turnId: "turn_1",
      status: "completed",
      startedAt: 1_000,
      completedAt: 2_000,
    }, "chat_id:c1");
    store.updateRuntimeSession(task.localSessionId, {
      lastTurnId: "turn_1",
      lastTurnStatus: "running",
    });
    const saveTurnParent = vi.spyOn(store, "saveTurnParent");

    for (const listener of listeners) {
      listener({
        type: "turn_started",
        sessionId: task.localSessionId,
        turnId: "turn_2",
        startedAt: 3_000,
      });
    }

    await vi.waitFor(() => expect(saveTurnParent).toHaveBeenCalledWith(
      "turn_2",
      task.localSessionId,
      "turn_1",
    ));
  });

  test("records an Open ID from private chat after acknowledging the message", async () => {
    const { controller, outbound, rememberFeishuUserOpenId } = fixture();

    await controller.onMessage({
      messageId: "m-private-owner",
      contextKey: "chat_id:p2p-owner",
      chatId: "p2p-owner",
      chatType: "p2p",
      userId: "ou_owner",
      text: "/help",
    });
    await controller.onMessage({
      messageId: "m-group-member",
      contextKey: "chat_id:group",
      chatId: "group",
      chatType: "group",
      userId: "ou_group_member",
      text: "/help",
    });
    await controller.onMessage({
      messageId: "m-private-union",
      contextKey: "chat_id:p2p-union",
      chatId: "p2p-union",
      chatType: "p2p",
      userId: "on_union_id",
      text: "/help",
    });

    expect(rememberFeishuUserOpenId).toHaveBeenCalledOnce();
    expect(rememberFeishuUserOpenId).toHaveBeenCalledWith("ou_owner");
    expect(vi.mocked(outbound.addReaction!).mock.invocationCallOrder[0]).toBeLessThan(
      rememberFeishuUserOpenId.mock.invocationCallOrder[0]!,
    );
  });

  test("cancels a safe restart from its card action once", async () => {
    const { controller, cancelSafeRestart, outbound } = fixture();
    const action = {
      actionId: "cancel-safe-restart",
      contextKey: "chat_id:c1",
      messageId: "om_restart",
      value: {
        action: "safe_restart_cancel",
        scheduleId: "7",
      },
    };

    await controller.onCardAction(action);
    await controller.onCardAction(action);

    expect(cancelSafeRestart).toHaveBeenCalledOnce();
    expect(cancelSafeRestart).toHaveBeenCalledWith(7);
    expect(outbound.sendText).not.toHaveBeenCalled();
  });

  test("reports a stale safe restart card without affecting another schedule", async () => {
    const { controller, cancelSafeRestart, outbound } = fixture();
    cancelSafeRestart.mockResolvedValueOnce(false);

    await controller.onCardAction({
      actionId: "cancel-stale-safe-restart",
      contextKey: "chat_id:c1",
      messageId: "om_restart_old",
      value: {
        action: "safe_restart_cancel",
        scheduleId: "3",
      },
    });

    expect(cancelSafeRestart).toHaveBeenCalledWith(3);
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "该安全重启计划已失效，请查看最新状态卡片。",
    );
  });

  test("resets the current task in place and keeps historical card origins usable", async () => {
    const { controller, runtime, sessions, remoteSessions, outbound, store } = fixture();
    await controller.onMessage(message("build reset history"));
    const task = store.listSessions("chat_id:c1")[0]!;
    const sourceRemoteSessionId = task.remoteSessionId!;
    const sourceRemote = remoteSessions.find((remote) => remote.id === sourceRemoteSessionId)!;
    sessions.get(task.localSessionId)!.activeTurnId = undefined;
    sourceRemote.status = "idle";
    sourceRemote.lastTurnId = "turn_2";
    sourceRemote.lastTurnStatus = "completed";
    store.updateSession(task.localSessionId, { status: "ready" });
    store.updateRuntimeSession(task.localSessionId, { lastTurnId: "turn_2", lastTurnStatus: "completed" });
    store.saveTurnSnapshot("turn_1", task.localSessionId, {
      sessionId: task.localSessionId,
      turnId: "turn_1",
      prompt: "Review the reset implementation",
      status: "completed",
      startedAt: 1,
      completedAt: 1_000,
      assistantText: "",
      plan: [],
      activities: [],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
    }, "chat_id:c1");
    store.saveTurnSnapshot("turn_2", task.localSessionId, {
      sessionId: task.localSessionId,
      turnId: "turn_2",
      status: "completed",
      startedAt: 2,
      assistantText: "",
      plan: [],
      activities: [],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
    }, "chat_id:c1");
    store.saveTurnRuntimeOrigin("turn_1", task.localSessionId, task.agentName, sourceRemoteSessionId);
    store.saveTurnRuntimeOrigin("turn_2", task.localSessionId, task.agentName, sourceRemoteSessionId);

    await controller.onCardAction({
      actionId: "reset-to-turn-1",
      contextKey: "chat_id:c1",
      messageId: "om_turn_1",
      value: { action: "turn_reset", sessionId: task.localSessionId, turnId: "turn_1" },
    });

    expect(runtime.forkSession).toHaveBeenLastCalledWith(expect.objectContaining({
      localSessionId: task.localSessionId,
      remoteSessionId: sourceRemoteSessionId,
      lastTurnId: "turn_1",
      title: task.title,
    }));
    expect(store.getUserContext("chat_id:c1")?.currentSessionId).toBe(task.localSessionId);
    expect(store.getSession(task.localSessionId)).toMatchObject({
      remoteSessionId: `${sourceRemoteSessionId}_fork`,
      lastTurnId: "turn_1",
      lastTurnStatus: "completed",
      status: "ready",
    });
    expect(outbound.sendText).toHaveBeenLastCalledWith("chat_id:c1", expect.any(String));
    const resetNotice = String(vi.mocked(outbound.sendText).mock.calls.at(-1)?.[1]);
    expect(resetNotice).toContain("已将当前任务重置到：\nReview the reset implementation\n");
    expect(resetNotice).toContain("完成时间：");
    expect(resetNotice).toContain("\nTurn ID：turn_1\n");
    expect(resetNotice).toContain("后续对话将从该轮完成后的状态继续；本地文件没有回退。");

    await controller.onCardAction({
      actionId: "reset-back-to-old-turn-2",
      contextKey: "chat_id:c1",
      messageId: "om_turn_2",
      value: { action: "turn_reset", sessionId: task.localSessionId, turnId: "turn_2" },
    });
    expect(runtime.forkSession).toHaveBeenLastCalledWith(expect.objectContaining({
      localSessionId: task.localSessionId,
      remoteSessionId: sourceRemoteSessionId,
      lastTurnId: "turn_2",
    }));
  });

  test("queues messages received while Reset is replacing the current App Server task", async () => {
    const { controller, runtime, sessions, remoteSessions, outbound, store, listeners } = fixture();
    await controller.onMessage(message("build reset history"));
    const task = store.listSessions("chat_id:c1")[0]!;
    const sourceRemoteSessionId = task.remoteSessionId!;
    const sourceRemote = remoteSessions.find((remote) => remote.id === sourceRemoteSessionId)!;
    sessions.get(task.localSessionId)!.activeTurnId = undefined;
    sourceRemote.status = "idle";
    sourceRemote.lastTurnId = "turn_latest";
    sourceRemote.lastTurnStatus = "completed";
    store.updateSession(task.localSessionId, { status: "ready" });
    store.updateRuntimeSession(task.localSessionId, {
      lastTurnId: "turn_latest",
      lastTurnStatus: "completed",
    });
    store.saveTurnSnapshot("turn_target", task.localSessionId, {
      sessionId: task.localSessionId,
      turnId: "turn_target",
      prompt: "Reset target",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
    }, "chat_id:c1");
    store.saveTurnRuntimeOrigin("turn_target", task.localSessionId, task.agentName, sourceRemoteSessionId);

    const forkSession = vi.mocked(runtime.forkSession!);
    const originalForkSession = forkSession.getMockImplementation()!;
    let releaseReset!: () => void;
    const resetGate = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    let resetStarted!: () => void;
    const resetStartedPromise = new Promise<void>((resolve) => {
      resetStarted = resolve;
    });
    forkSession.mockImplementationOnce(async (input) => {
      resetStarted();
      await resetGate;
      return originalForkSession(input);
    });

    const startTurn = vi.mocked(runtime.startTurn);
    startTurn.mockClear();
    vi.mocked(outbound.downloadImage!).mockClear();
    let startedRemoteSessionId: string | undefined;
    startTurn.mockImplementationOnce(async (sessionId) => {
      startedRemoteSessionId = sessions.get(sessionId)?.remoteSessionId;
      const turnId = "turn_after_reset";
      for (const listener of listeners) listener({ type: "turn_started", sessionId, turnId, startedAt: 3 });
      return turnId;
    });

    const resetAction = controller.onCardAction({
      actionId: "reset-before-new-message",
      contextKey: "chat_id:c1",
      messageId: "om_turn_target",
      value: { action: "turn_reset", sessionId: task.localSessionId, turnId: "turn_target" },
    });
    await resetStartedPromise;
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "Reset 正在进行，请稍后。期间发送的消息会自动排队。",
    );

    const queuedMessage = controller.onMessage({
      messageId: "message-during-reset",
      contextKey: "chat_id:c1",
      text: "continue after Reset",
      images: [{ imageKey: "image-during-reset" }],
    });
    await vi.waitFor(() => expect(outbound.addReaction).toHaveBeenCalledWith(
      "message-during-reset",
      expect.any(String),
    ));
    expect(outbound.downloadImage).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();

    releaseReset();
    await Promise.all([resetAction, queuedMessage]);

    expect(startTurn).toHaveBeenCalledOnce();
    expect(outbound.downloadImage).toHaveBeenCalledWith(
      "message-during-reset",
      "image-during-reset",
    );
    expect(startedRemoteSessionId).toBe(`${sourceRemoteSessionId}_fork`);
    expect(store.getTurnRuntimeOrigin("turn_after_reset")?.remoteSessionId)
      .toBe(`${sourceRemoteSessionId}_fork`);
  });

  test("shows ten completed turns per Turns card page and keeps later turns after Reset", async () => {
    const { controller, runtime, sessions, remoteSessions, outbound, store } = fixture();
    await controller.onMessage(message("build reset card history"));
    const task = store.listSessions("chat_id:c1")[0]!;
    sessions.get(task.localSessionId)!.activeTurnId = undefined;
    const remote = remoteSessions.find((candidate) => candidate.id === task.remoteSessionId)!;
    remote.status = "idle";
    remote.lastTurnId = "history_turn_12";
    remote.lastTurnStatus = "completed";
    store.updateSession(task.localSessionId, { status: "ready" });
    store.updateRuntimeSession(task.localSessionId, {
      lastTurnId: "history_turn_12",
      lastTurnStatus: "completed",
    });
    for (let index = 1; index <= 12; index += 1) {
      store.saveTurnSnapshot(`history_turn_${index}`, task.localSessionId, {
        sessionId: task.localSessionId,
        turnId: `history_turn_${index}`,
        prompt: `Prompt ${index}`,
        status: "completed",
        startedAt: index * 1_000,
        completedAt: index * 1_000,
        assistantText: "",
        plan: [],
        activities: [],
        completedTools: [],
        failedTools: [],
        fileSummary: [],
      }, "chat_id:c1");
    }

    await controller.onMessage(message("/turns"));
    const firstCard = vi.mocked(outbound.sendInteractiveCard).mock.calls.at(-1)?.[1];
    const firstSerialized = JSON.stringify(firstCard);
    expect(firstSerialized.match(/"action":"turn_reset"/g)).toHaveLength(9);
    expect(firstSerialized).toContain("✅ 当前");
    expect(firstSerialized).toContain("Prompt 12");
    expect(firstSerialized).toContain("Prompt 3");
    expect(firstSerialized).toContain("<font color='green'>●</font>");
    expect(firstSerialized).toContain("<font color='green'>1</font>");
    expect(firstSerialized).toContain("<font color='blue'>●</font>");
    expect(firstSerialized).toContain("<font color='blue'>2</font>");
    expect(firstSerialized).not.toContain("**1. Prompt 12**");
    expect(firstSerialized).not.toContain("Prompt 2");
    expect(firstSerialized).toContain('"action":"turn_reset_page"');
    expect(firstSerialized).toContain("<font color='blue'>Next</font>");
    expect(firstSerialized).not.toContain("<font color='blue'>Previous</font>");

    await controller.onCardAction({
      actionId: "reset-history-page-2",
      contextKey: "chat_id:c1",
      messageId: "om_reset_history",
      value: {
        action: "turn_reset_page",
        sessionId: task.localSessionId,
        contextKey: "chat_id:c1",
        page: "1",
      },
    });
    expect(outbound.updateInteractiveCard).toHaveBeenLastCalledWith(
      "om_reset_history",
      expect.any(Object),
    );
    const secondCard = vi.mocked(outbound.updateInteractiveCard).mock.calls.at(-1)?.[1];
    const secondSerialized = JSON.stringify(secondCard);
    expect(secondSerialized.match(/"action":"turn_reset"/g)).toHaveLength(2);
    expect(secondSerialized).toContain("Prompt 2");
    expect(secondSerialized).toContain("Prompt 1");
    expect(secondSerialized).toContain("<font color='blue'>Previous</font>");
    expect(secondSerialized).not.toContain("<font color='blue'>Next</font>");

    vi.mocked(outbound.updateInteractiveCard).mockClear();
    const forkSession = vi.mocked(runtime.forkSession!);
    const originalForkSession = forkSession.getMockImplementation()!;
    let releaseResetCard!: () => void;
    const resetCardGate = new Promise<void>((resolve) => {
      releaseResetCard = resolve;
    });
    let resetCardStarted!: () => void;
    const resetCardStartedPromise = new Promise<void>((resolve) => {
      resetCardStarted = resolve;
    });
    vi.mocked(outbound.updateInteractiveCard).mockImplementationOnce(async () => {
      resetCardStarted();
      await resetCardGate;
    });
    let releaseReset!: () => void;
    const resetGate = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    forkSession.mockImplementationOnce(async (input) => {
      await resetGate;
      return originalForkSession(input);
    });

    const resetAction = controller.onCardAction({
      actionId: "reset-history-to-turn-1",
      contextKey: "chat_id:c1",
      messageId: "om_reset_history",
      value: {
        action: "turn_reset",
        cardView: "reset_history",
        sessionId: task.localSessionId,
        turnId: "history_turn_1",
        contextKey: "chat_id:c1",
        page: "1",
      },
    });
    await resetCardStartedPromise;
    const resetStartNoticeCall = vi.mocked(outbound.sendText).mock.calls.findIndex((call) =>
      call[1] === "Reset 正在进行，请稍后。期间发送的消息会自动排队。");
    expect(resetStartNoticeCall).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(outbound.sendText).mock.invocationCallOrder[resetStartNoticeCall])
      .toBeLessThan(vi.mocked(outbound.updateInteractiveCard).mock.invocationCallOrder[0]!);

    const interactiveCardCount = vi.mocked(outbound.sendInteractiveCard).mock.calls.length;
    const queuedHelp = controller.onMessage({
      messageId: "help-during-history-reset",
      contextKey: "chat_id:c1",
      text: "/help",
    });
    await vi.waitFor(() => expect(outbound.addReaction).toHaveBeenCalledWith(
      "help-during-history-reset",
      expect.any(String),
    ));
    expect(outbound.sendInteractiveCard).toHaveBeenCalledTimes(interactiveCardCount);

    await vi.waitFor(() => expect(outbound.updateInteractiveCard).toHaveBeenCalledTimes(1));
    const resettingCard = vi.mocked(outbound.updateInteractiveCard).mock.calls[0]?.[1];
    const resettingSerialized = JSON.stringify(resettingCard);
    expect(resettingSerialized).toContain("⏳ 正在 Reset");
    expect(resettingSerialized).toContain("正在 Reset 到所选轮次，请稍候…");
    expect(resettingSerialized).not.toContain('"action":"turn_reset"');
    expect(resettingSerialized).toContain('"action":"turn_reset_page"');

    releaseResetCard();
    await vi.waitFor(() => expect(forkSession).toHaveBeenCalledWith(expect.objectContaining({
      lastTurnId: "history_turn_1",
    })));
    expect(outbound.sendInteractiveCard).toHaveBeenCalledTimes(interactiveCardCount);
    releaseReset();
    await Promise.all([resetAction, queuedHelp]);
    expect(outbound.sendInteractiveCard).toHaveBeenCalledTimes(interactiveCardCount + 1);
    expect(runtime.forkSession).toHaveBeenLastCalledWith(expect.objectContaining({
      localSessionId: task.localSessionId,
      lastTurnId: "history_turn_1",
    }));
    expect(outbound.updateInteractiveCard).toHaveBeenCalledTimes(2);
    const resetCard = vi.mocked(outbound.updateInteractiveCard).mock.calls.at(-1)?.[1];
    const resetSerialized = JSON.stringify(resetCard);
    expect(resetSerialized).toContain("✅ 当前");
    expect(resetSerialized).toContain("Prompt 2");
    expect(resetSerialized.match(/"action":"turn_reset"/g)).toHaveLength(1);
    expect(resetSerialized).not.toContain('"turnId":"history_turn_1","contextKey"');

    vi.mocked(outbound.updateInteractiveCard).mockClear();
    forkSession.mockRejectedValueOnce(new Error("reset failed"));
    await controller.onCardAction({
      actionId: "reset-history-failure",
      contextKey: "chat_id:c1",
      messageId: "om_reset_history",
      value: {
        action: "turn_reset",
        cardView: "reset_history",
        sessionId: task.localSessionId,
        turnId: "history_turn_2",
        contextKey: "chat_id:c1",
        page: "1",
      },
    });
    expect(outbound.updateInteractiveCard).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(outbound.updateInteractiveCard).mock.calls[0]?.[1]))
      .toContain("⏳ 正在 Reset");
    const restoredCard = JSON.stringify(vi.mocked(outbound.updateInteractiveCard).mock.calls.at(-1)?.[1]);
    expect(restoredCard).not.toContain("⏳ 正在 Reset");
    expect(restoredCard).not.toContain("正在 Reset 到所选轮次，请稍候…");
    expect(restoredCard).toContain('"action":"turn_reset"');
    expect(restoredCard).toContain('"turnId":"history_turn_2"');
  });

  test("hydrates missing completed Turns from App Server before rendering the Turns card", async () => {
    const { controller, runtime, remoteSessions, outbound, store } = fixture();
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({
      localSessionId: "partial_turn_history",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: "D:\\work\\partial-history",
      status: "ready",
    });
    store.updateRuntimeSession("partial_turn_history", {
      runtimeKind: "codex",
      remoteSessionId: "remote_partial_history",
      lastTurnId: "remote_turn_3",
      lastTurnStatus: "completed",
    });
    store.setCurrentSession("chat_id:c1", "partial_turn_history");
    store.saveTurnSnapshot("remote_turn_3", "partial_turn_history", {
      sessionId: "partial_turn_history",
      turnId: "remote_turn_3",
      prompt: "Locally preserved latest Prompt",
      status: "completed",
      startedAt: 3_000,
      completedAt: 3_100,
      assistantText: "Rich local response",
      plan: [],
      activities: [],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
    }, "chat_id:c1");
    remoteSessions.push({
      id: "remote_partial_history",
      title: "Partially indexed task",
      cwd: "D:\\work\\partial-history",
      source: "appServer",
      status: "idle",
      lastTurnId: "remote_turn_3",
      lastTurnStatus: "completed",
      completedTurns: [
        { id: "remote_turn_1", prompt: "Missing first Prompt", startedAt: 1_000, completedAt: 1_100 },
        { id: "remote_turn_2", prompt: "Missing second Prompt", startedAt: 2_000, completedAt: 2_100 },
        { id: "remote_turn_3", prompt: "Remote replacement Prompt", startedAt: 3_000, completedAt: 3_100 },
      ],
    });

    await controller.onMessage(message("/turns"));

    expect(runtime.listRemoteTurnSummaries).toHaveBeenCalledWith("remote_partial_history", { cursor: undefined, limit: 10 });
    expect(runtime.readRemoteSession).not.toHaveBeenCalled();
    const card = vi.mocked(outbound.sendInteractiveCard).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("Missing first Prompt");
    expect(serialized).toContain("Missing second Prompt");
    expect(serialized).toContain("Locally preserved latest Prompt");
    expect(serialized).not.toContain("Remote replacement Prompt");
    expect(store.listTaskTurnGraph("partial_turn_history").map((turn) => turn.turnId)).toEqual([
      "remote_turn_3",
      "remote_turn_2",
      "remote_turn_1",
    ]);
  });

  test("reuses the status reconciliation result instead of reading the remote task twice", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(message("/new Status reuse"));
    const id = store.getUserContext("chat_id:c1")!.currentSessionId!;
    store.updateSession(id, { status: "running" });
    vi.mocked(runtime.synchronizeSession).mockImplementation(async () => ({
      ...runtime.getSession(id)!, remoteSummary: {
        id: runtime.getSession(id)!.remoteSessionId, cwd: process.cwd(), source: "appServer", status: "idle",
        lastTurnId: "finished", lastTurnStatus: "completed", finalResponse: "Recovered final result",
      },
    }));
    vi.mocked(runtime.readRemoteSession!).mockClear();
    await controller.onMessage({ ...message("/status"), messageId: "status-reuse" });
    expect(runtime.synchronizeSession).toHaveBeenCalledOnce();
    expect(runtime.readRemoteSession).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(outbound.sendInteractiveCard).mock.calls.at(-1)?.[1])).toContain("Recovered final result");
    controller.close();
  });

  test("shows an unsupported Codex version instead of silently displaying cached status", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("/new Version check"));
    vi.mocked(runtime.readRemoteSession!).mockRejectedValue(new CodexVersionError("Codex >= 0.153.4; run codex update"));
    await controller.onMessage({ ...message("/status"), messageId: "old-codex-status" });
    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", expect.stringContaining("codex update"));
    controller.close();
  });

  test("paginates ordinary task history and reads only current-page prompts locally", async () => {
    const { controller, runtime, remoteSessions, outbound, store } = fixture();
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({ localSessionId: "large_plain", contextKey: "chat_id:c1", agentName: "codex", cwd: process.cwd(), status: "ready" });
    store.updateRuntimeSession("large_plain", { runtimeKind: "codex", remoteSessionId: "plain_remote", lastTurnId: "plain_40", lastTurnStatus: "completed" });
    store.setCurrentSession("chat_id:c1", "large_plain");
    remoteSessions.push({
      id: "plain_remote", cwd: process.cwd(), source: "appServer", status: "idle",
      completedTurns: Array.from({ length: 40 }, (_, i) => ({
        id: `plain_${i + 1}`, prompt: `Plain prompt ${i + 1}`, startedAt: i * 10, completedAt: i * 10 + 1,
      })),
    });
    const summaries = vi.spyOn(store, "getTurnPromptSummary");
    const fullGraph = vi.spyOn(store, "listTaskTurnGraph");
    await controller.onMessage(message("/turns"));
    expect(runtime.readRemoteSession).not.toHaveBeenCalled();
    expect(runtime.listRemoteTurnSummaries).toHaveBeenCalledExactlyOnceWith("plain_remote", { cursor: undefined, limit: 10 });
    expect(summaries).toHaveBeenCalledTimes(10);
    expect(fullGraph).not.toHaveBeenCalled();
    expect(store.getTurnSnapshot("plain_30")).toBeUndefined();
    summaries.mockClear();
    await controller.onCardAction({
      actionId: "plain-page-2", contextKey: "chat_id:c1", messageId: "plain-card",
      value: { action: "turn_reset_page", sessionId: "large_plain", contextKey: "chat_id:c1", page: "1" },
    });
    expect(runtime.listRemoteTurnSummaries).toHaveBeenLastCalledWith("plain_remote", { cursor: "10", limit: 10 });
    expect(summaries).toHaveBeenCalledTimes(10);
    expect(summaries.mock.calls.map(([id]) => id)).toEqual(Array.from({ length: 10 }, (_, i) => `plain_${30 - i}`));
    expect(JSON.stringify(vi.mocked(outbound.updateInteractiveCard).mock.calls.at(-1)?.[1])).toContain("Plain prompt 30");
    await controller.onMessage({ ...message("/turns"), messageId: "plain-again" });
    expect(runtime.listRemoteTurnSummaries).toHaveBeenCalledTimes(2);
    expect(store.getTurnSnapshot("plain_20")).toBeUndefined();
    controller.close();
  });


  test("shows the currently running turn at the top of the Turns card without Reset", async () => {
    const { controller, outbound, store } = fixture();
    await controller.onMessage(message("complete the parent turn"));
    const task = store.listSessions("chat_id:c1")[0]!;
    const parentTurnId = task.lastTurnId!;
    store.saveTurnSnapshot(parentTurnId, task.localSessionId, {
      sessionId: task.localSessionId,
      turnId: parentTurnId,
      prompt: "complete the parent turn",
      status: "completed",
      startedAt: Date.now() - 1_000,
      completedAt: Date.now() - 500,
      assistantText: "done",
      plan: [],
      activities: [],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
    }, "chat_id:c1");
    const runningTurnId = "turn_running";
    store.saveTurnParent(runningTurnId, task.localSessionId, parentTurnId);
    store.saveTurnSnapshot(runningTurnId, task.localSessionId, {
      sessionId: task.localSessionId,
      turnId: runningTurnId,
      prompt: "keep working on the active turn",
      status: "tool_running",
      startedAt: Date.now(),
      assistantText: "",
      plan: [],
      activities: [],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
    }, "chat_id:c1");
    store.updateSession(task.localSessionId, { status: "running" });
    store.updateRuntimeSession(task.localSessionId, {
      lastTurnId: runningTurnId,
      lastTurnStatus: "running",
    });

    await controller.onMessage(message("/turns"));
    const card = vi.mocked(outbound.sendInteractiveCard).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("keep working on the active turn");
    expect(serialized).toContain("⏳ 运行中");
    expect(serialized).toContain("1 个已完成，1 个运行中");
    expect(serialized.match(/"action":"turn_reset"/g)).toHaveLength(1);
    expect(serialized.indexOf(runningTurnId)).toBeLessThan(serialized.indexOf(parentTurnId));
  });

  test("creates, displays, edits, pauses, resumes, and clears a Codex goal", async () => {
    const { controller, runtime, outbound, store, listeners, presenter } = fixture();

    await controller.onMessage(message("/goal 完成迁移并通过全部测试"));

    const currentId = store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId!;
    expect(runtime.setGoal).toHaveBeenCalledWith(currentId, {
      objective: "完成迁移并通过全部测试",
      status: "active",
    });
    expect(runtime.startTurn).not.toHaveBeenCalled();
    let card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("Goal 已启动");
    expect(JSON.stringify(card)).toContain("完成迁移并通过全部测试");
    expect(store.getGoalCardDelivery(currentId, "chat_id:c1")).toMatchObject({ messageId: "card" });

    await controller.onMessage(message("/goal"));
    card = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("当前 Goal");
    expect(JSON.stringify(card)).toContain("执行中");

    await controller.onMessage(message("/goal pause"));
    expect(runtime.setGoal).toHaveBeenLastCalledWith(currentId, { status: "paused" });
    await controller.onMessage(message("/goal resume"));
    expect(runtime.setGoal).toHaveBeenLastCalledWith(currentId, { status: "active" });
    await controller.onMessage(message("/goal edit 完成迁移、文档和回归测试"));
    expect(runtime.setGoal).toHaveBeenLastCalledWith(currentId, expect.objectContaining({
      objective: "完成迁移、文档和回归测试",
      status: "active",
    }));

    await controller.onMessage(message("/status"));
    card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("完成迁移、文档和回归测试");

    for (const listener of listeners) {
      listener({ type: "turn_started", sessionId: currentId, turnId: "goal_turn_1", startedAt: 42 });
    }
    await vi.waitFor(() => expect(presenter.onEvent).toHaveBeenCalledWith({
      type: "turn_started",
      sessionId: currentId,
      turnId: "goal_turn_1",
      startedAt: 42,
    }));
    expect(store.getSession(currentId)).toMatchObject({ status: "running", lastTurnId: "goal_turn_1" });

    await controller.onMessage(message("/goal clear"));
    expect(runtime.clearGoal).toHaveBeenCalledWith(currentId);
    card = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("Goal 已清除");
    expect(outbound.sendInteractiveCard).toHaveBeenCalledTimes(2);
  });

  test("refreshes the persisted Goal card when the App Server completes the Goal", async () => {
    const { controller, runtime, outbound, store, goals, listeners } = fixture();
    await controller.onMessage(message("/goal 完成自动化迁移"));
    const currentId = store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId!;
    const current = goals.get(currentId)!;
    goals.set(currentId, {
      ...current,
      status: "complete",
      tokensUsed: 12_345,
      timeUsedSeconds: 78,
      updatedAt: 1_776_272_520,
    });
    (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mockClear();

    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: currentId,
        turnId: "goal_turn_final",
        finalResponse: "Goal complete",
      });
    }

    await vi.waitFor(() => expect(outbound.updateInteractiveCard).toHaveBeenCalledWith(
      "card",
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({ content: "Agent Goal · 已完成" }),
        }),
      }),
    ));
    const card = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("**状态**：已完成");
    expect(JSON.stringify(card)).toContain("12.3K tokens / 01:18");
    expect(runtime.getGoal).toHaveBeenCalledWith(currentId);
  });

  test("pauses an active goal before stopping its Codex turn", async () => {
    const { controller, runtime, store, remoteSessions } = fixture();
    await controller.onMessage(message("/goal 持续优化测试覆盖率"));
    const currentId = store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId!;
    const session = runtime.getSession(currentId)!;
    session.activeTurnId = "goal_turn_active";
    Object.assign(remoteSessions.find((remote) => remote.id === "thr_1")!, {
      status: "active",
      lastTurnId: "goal_turn_active",
      lastTurnStatus: "inProgress",
    });

    await controller.onMessage(message("/stop"));

    expect(runtime.setGoal).toHaveBeenLastCalledWith(currentId, { status: "paused" });
    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("thr_1", "goal_turn_active");
  });

  test("rejects oversized goals before creating a task", async () => {
    const { controller, runtime, store, outbound } = fixture();
    await controller.onMessage(message(`/goal ${"长".repeat(4_001)}`));

    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(store.listSessions("chat_id:c1")).toHaveLength(0);
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("最多 4000 个字符"),
    );
  });

  test("executes bang commands in the current task directory and returns their output", async () => {
    const { controller, outbound, shellCommandExecutor } = fixture();
    const cwd = path.resolve("test-workspaces", "work space", "shell-project");
    await controller.onMessage(message(`/new --dir "${cwd}"`));

    await controller.onMessage(message("! ls"));

    expect(shellCommandExecutor).toHaveBeenCalledWith(
      "ls",
      cwd,
      expect.objectContaining({ onOutput: expect.any(Function) }),
    );
    expect(outbound.sendInteractiveCard).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({ content: "正在执行命令" }),
        }),
      }),
    );
    await vi.waitFor(() => {
      const latest = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
      expect(latest).toMatchObject({ header: { title: { content: "命令执行完成" } } });
    }, { timeout: 3_500 });
    const card = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(card).toMatchObject({ header: { title: { content: "命令执行完成" } } });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("$  ls\\nREADME.md\\nsrc\\ntests");
    expect(serialized).toContain(cwd.replaceAll("\\", "\\\\"));
    expect(serialized).toContain("退出码 0");
  });

  test("updates a bang-command card while the command is still running", async () => {
    const { controller, outbound, shellCommandExecutor } = fixture();
    let finishCommand!: () => void;
    const commandPending = new Promise<void>((resolve) => { finishCommand = resolve; });
    (shellCommandExecutor as ReturnType<typeof vi.fn>).mockImplementationOnce(async (
      _command: string,
      _cwd: string,
      options?: { onOutput?: (snapshot: { stdout: string; stderr: string; outputTruncated: boolean }) => void },
    ) => {
      options?.onOutput?.({ stdout: "first chunk\n", stderr: "", outputTruncated: false });
      await commandPending;
      return {
        stdout: "first chunk\nlast chunk\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        outputTruncated: false,
      };
    });

    const processing = controller.onMessage(message("! stream-output"));
    await vi.waitFor(() => {
      const updates = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls;
      expect(updates.some((call) => JSON.stringify(call[1]).includes("first chunk"))).toBe(true);
    }, { timeout: 3_500 });

    const runningCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[1])
      .find((card) => JSON.stringify(card).includes("first chunk"));
    expect(runningCard).toMatchObject({ header: { title: { content: "正在执行命令" } } });

    finishCommand();
    await processing;
    await vi.waitFor(() => {
      const latest = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
      expect(latest).toMatchObject({ header: { title: { content: "命令执行完成" } } });
    }, { timeout: 3_500 });
    const finalCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(finalCard).toMatchObject({ header: { title: { content: "命令执行完成" } } });
    expect(JSON.stringify(finalCard)).toContain("last chunk");
  });

  test("keeps the original bang-command reaction pending until the command reaches a terminal state", async () => {
    const { controller, outbound, shellCommandExecutor } = fixture();
    vi.mocked(outbound.addReaction!).mockResolvedValueOnce("reaction_on_it").mockResolvedValueOnce("reaction_done");
    let finishCommand!: () => void;
    (shellCommandExecutor as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishCommand = resolve; });
      return {
        stdout: "finished\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        outputTruncated: false,
      };
    });

    await controller.onMessage(message("! long-reaction"));

    expect(outbound.addReaction).toHaveBeenCalledWith("m-! long-reaction", "OnIt");
    expect(outbound.addReaction).not.toHaveBeenCalledWith("m-! long-reaction", "DONE");

    finishCommand();
    await vi.waitFor(() => {
      expect(outbound.addReaction).toHaveBeenCalledWith("m-! long-reaction", "DONE");
    }, { timeout: 3_500 });
  });

  test("uses the configured default directory for bang commands without a current task", async () => {
    const { controller, shellCommandExecutor } = fixture();

    await controller.onMessage(message("！ Get-ChildItem"));

    expect(shellCommandExecutor).toHaveBeenCalledWith(
      "Get-ChildItem",
      process.cwd(),
      expect.objectContaining({ onOutput: expect.any(Function) }),
    );
  });

  test("uses the source task directory for bang commands in an unbound anchored topic", async () => {
    const { controller, runtime, store, listeners, shellCommandExecutor } = fixture();
    const cwd = path.resolve("test-workspaces", "topic-shell-project");
    await controller.onMessage(message(`/new --dir "${cwd}"`));
    await controller.onMessage({
      messageId: "om_topic_shell_source",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      text: "prepare the source task",
    });
    const sourceSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId!,
        turnId: "turn_1",
        finalResponse: "source complete",
      });
    }

    const topicContextKey = "chat_id:c1:thread_id:omt_topic_shell";
    await controller.onMessage(threadMessage(
      "c1",
      "p2p",
      "omt_topic_shell",
      "om_topic_shell_source",
      "! git status",
    ));

    expect(runtime.forkSession).not.toHaveBeenCalled();
    expect(store.getUserContext(topicContextKey)?.currentSessionId).toBeUndefined();
    expect(shellCommandExecutor).toHaveBeenCalledWith(
      "git status",
      cwd,
      expect.objectContaining({ onOutput: expect.any(Function) }),
    );
  });

  test("uses the source command directory for bang commands replying to a command card", async () => {
    const { controller, shellCommandExecutor } = fixture();
    const cwd = path.resolve("test-workspaces", "topic-shell-command-project");
    await controller.onMessage(message(`/new --dir "${cwd}"`));
    await controller.onMessage(message("! git stash"));

    await controller.onMessage(threadMessage(
      "c1",
      "p2p",
      "omt_topic_shell_command",
      "card",
      "! git status",
    ));

    expect(shellCommandExecutor).toHaveBeenLastCalledWith(
      "git status",
      cwd,
      expect.objectContaining({ onOutput: expect.any(Function) }),
    );
  });

  test("browses the current task directory and navigates into a child directory in place", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-dir-browser-"));
    tempDirs.push(root);
    const child = path.join(root, "child");
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(root, "root.txt"), "root");
    fs.writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    fs.writeFileSync(path.join(root, "agentbot.exe"), Buffer.from([0x4d, 0x5a, 0x00, 0x01]));
    fs.writeFileSync(path.join(child, "nested.txt"), "nested");
    const { controller, outbound } = fixture();
    await controller.onMessage(message(`/new --dir "${root}"`));

    await controller.onMessage(message("/dir"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(card).toMatchObject({ header: { title: { content: "文件浏览" } } });
    expect(serialized).toContain("child");
    expect(serialized).toContain("root.txt");
    expect(serialized).toContain("🖼️ logo.png");
    expect(serialized).toContain("📦 agentbot.exe");
    expect(serialized).toContain('"action":"directory_send_file"');
    expect(serialized).toContain("NewFolder");
    expect(serialized).toContain("NewTask");
    expect(serialized).toContain("NewGroupTask");
    expect(serialized.match(/"action":"directory_new_folder_prompt"/g)).toHaveLength(1);
    expect(serialized.match(/"action":"directory_new"/g)).toHaveLength(1);
    expect(serialized.match(/"action":"directory_new_group"/g)).toHaveLength(1);

    await controller.onCardAction({
      actionId: "directory-open-child",
      contextKey: "chat_id:c1",
      messageId: "om_directory",
      value: {
        action: "directory_open",
        directory: child,
        contextKey: "chat_id:c1",
      },
    });

    const updated = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const updatedSerialized = JSON.stringify(updated);
    expect(outbound.updateInteractiveCard).toHaveBeenLastCalledWith("om_directory", expect.any(Object));
    expect(updatedSerialized).toContain("nested.txt");
    expect(updatedSerialized).not.toContain("root.txt");
    expect(updatedSerialized).toContain("📁 ..");
    expect(updatedSerialized).not.toContain("Parent");
  });

  test("creates a named child directory from the browser card form", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-dir-new-folder-"));
    tempDirs.push(root);
    const { controller, outbound } = fixture();

    await controller.onCardAction({
      actionId: "directory-new-folder-prompt",
      contextKey: "chat_id:c1",
      messageId: "om_directory",
      value: {
        action: "directory_new_folder_prompt",
        directory: root,
        contextKey: "chat_id:c1",
        page: "0",
      },
    });

    const promptCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(promptCard).toMatchObject({ header: { title: { content: "新建目录" } } });
    expect(JSON.stringify(promptCard)).toContain('"name":"folderName"');

    await controller.onCardAction({
      actionId: "directory-new-folder-submit",
      contextKey: "chat_id:c1",
      messageId: "om_directory",
      value: {
        action: "directory_new_folder_submit",
        directory: root,
        contextKey: "chat_id:c1",
        page: "0",
        formValue: { folderName: "new-child" },
      },
    });

    expect(fs.statSync(path.join(root, "new-child")).isDirectory()).toBe(true);
    const browserCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(browserCard).toMatchObject({ header: { title: { content: "文件浏览" } } });
    expect(JSON.stringify(browserCard)).toContain("new-child");
    expect(outbound.sendText).toHaveBeenLastCalledWith(
      "chat_id:c1",
      `已创建目录：${path.join(root, "new-child")}`,
    );
  });

  test("rejects path traversal in a new-folder card submission", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-dir-invalid-folder-"));
    tempDirs.push(root);
    const escapedName = `escape-${path.basename(root)}`;
    const { controller, outbound } = fixture();

    await controller.onCardAction({
      actionId: "directory-new-folder-invalid",
      contextKey: "chat_id:c1",
      messageId: "om_directory",
      value: {
        action: "directory_new_folder_submit",
        directory: root,
        contextKey: "chat_id:c1",
        page: "0",
        formValue: { folderName: `../${escapedName}` },
      },
    });

    expect(fs.existsSync(path.join(root, "..", escapedName))).toBe(false);
    expect(outbound.sendText).toHaveBeenLastCalledWith(
      "chat_id:c1",
      expect.stringContaining("目录名不能包含路径分隔符"),
    );
  });

  test("sends a selected file to the chat or topic containing the browser card", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-dir-send-file-"));
    tempDirs.push(root);
    const filePath = path.join(root, "report.txt");
    fs.writeFileSync(filePath, "report");
    const { controller, outbound } = fixture();

    await controller.onCardAction({
      actionId: "directory-send-file-chat",
      contextKey: "chat_id:c1",
      messageId: "om_directory",
      value: {
        action: "directory_send_file",
        filePath,
        contextKey: "chat_id:c1",
      },
    });

    expect(outbound.sendFile).toHaveBeenLastCalledWith("chat_id:c1", filePath);

    const topicContextKey = "chat_id:c1:thread_id:omt_directory";
    await controller.onCardAction({
      actionId: "directory-send-file-topic",
      contextKey: topicContextKey,
      messageId: "om_topic_directory",
      value: {
        action: "directory_send_file",
        filePath,
        contextKey: topicContextKey,
      },
    });

    expect(outbound.replyFile).toHaveBeenLastCalledWith(
      topicContextKey,
      { messageId: "om_topic_directory", replyInThread: true },
      filePath,
    );
  });

  test("resolves a relative dir path from the current task directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-dir-relative-"));
    tempDirs.push(root);
    const child = path.join(root, "child");
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(child, "inside.txt"), "inside");
    const { controller, outbound } = fixture();
    await controller.onMessage(message(`/new --dir "${root}"`));

    await controller.onMessage(message("/dir child"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("inside.txt");
  });

  test("sends relative, absolute, and home-relative files from the current task", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-file-command-"));
    const reports = path.join(root, "reports");
    fs.mkdirSync(reports);
    const relativeFile = path.join(reports, "daily report.txt");
    fs.writeFileSync(relativeFile, "relative");
    tempDirs.push(root);

    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-file-absolute-"));
    const absoluteFile = path.join(externalRoot, "absolute.txt");
    fs.writeFileSync(absoluteFile, "absolute");
    tempDirs.push(externalRoot);

    const homeRoot = fs.mkdtempSync(path.join(os.homedir(), ".agent-bot-file-command-"));
    const homeFile = path.join(homeRoot, "home.txt");
    fs.writeFileSync(homeFile, "home");
    tempDirs.push(homeRoot);

    const { controller, outbound } = fixture();
    await controller.onMessage(message(`/new --dir "${root}"`));

    await controller.onMessage(message('/file "reports/daily report.txt"'));
    expect(outbound.sendFile).toHaveBeenLastCalledWith("chat_id:c1", relativeFile);

    await controller.onMessage(message(`/file "${absoluteFile}"`));
    expect(outbound.sendFile).toHaveBeenLastCalledWith("chat_id:c1", absoluteFile);

    await controller.onMessage(message(`/file ~/${path.basename(homeRoot)}/home.txt`));
    expect(outbound.sendFile).toHaveBeenLastCalledWith("chat_id:c1", homeFile);
  });

  test("rejects file commands without a current task or a sendable file", async () => {
    const { controller, outbound } = fixture();

    await controller.onMessage(message("/file report.txt"));
    expect(outbound.sendText).toHaveBeenLastCalledWith(
      "chat_id:c1",
      expect.stringContaining("当前没有任务"),
    );
    expect(outbound.sendFile).not.toHaveBeenCalled();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-file-command-errors-"));
    tempDirs.push(root);
    await controller.onMessage(message(`/new --dir "${root}"`));
    await controller.onMessage(message("/file missing.txt"));
    expect(outbound.sendText).toHaveBeenLastCalledWith(
      "chat_id:c1",
      expect.stringContaining("文件不存在或无法访问"),
    );

    await controller.onMessage(message("/file ."));
    expect(outbound.sendText).toHaveBeenLastCalledWith(
      "chat_id:c1",
      expect.stringContaining("这不是普通文件"),
    );
  });

  test("renders the Windows drive selector as a virtual directory", async () => {
    const { controller, outbound, windowsDriveLister } = fixture();

    await controller.onCardAction({
      actionId: "directory-open-windows-drives",
      contextKey: "chat_id:c1",
      messageId: "om_directory",
      value: {
        action: "directory_open",
        directory: "agentbot://windows-drives",
        contextKey: "chat_id:c1",
      },
    });

    expect(windowsDriveLister).toHaveBeenCalledOnce();
    const card = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("**当前目录**：`此电脑`");
    expect(serialized).toContain("💽 Windows (C:)");
    expect(serialized).toContain("💽 本地磁盘 (D:)");
    expect(serialized).not.toContain("📁 ..");
    expect(serialized).not.toContain('"action":"directory_new"');
    expect(serialized).not.toContain('"action":"directory_new_group"');
  });

  test.skipIf(process.platform !== "win32")("opens the Windows drive selector from a drive root", async () => {
    const { controller, outbound } = fixture();
    const driveRoot = path.parse(process.cwd()).root;

    await controller.onMessage(message(`/dir "${driveRoot}"`));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("📁 ..");
    expect(serialized).toContain('"directory":"agentbot://windows-drives"');
  });

  test("creates a task or group in a directory selected from the browser", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-dir-create-"));
    tempDirs.push(root);
    const child = path.join(root, "project");
    fs.mkdirSync(child);
    const { controller, runtime, outbound, store } = fixture();

    await controller.onCardAction({
      actionId: "directory-create-task",
      contextKey: "chat_id:c1",
      messageId: "om_directory",
      value: {
        action: "directory_new",
        directory: child,
        contextKey: "chat_id:c1",
      },
    });

    const createdSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(runtime.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      localSessionId: createdSessionId,
      agentName: "codex",
      cwd: child,
    }));

    await controller.onCardAction({
      actionId: "directory-create-group",
      contextKey: "chat_id:c1",
      userId: "ou_current_user",
      messageId: "om_directory",
      value: {
        action: "directory_new_group",
        directory: child,
        contextKey: "chat_id:c1",
      },
    });

    expect(outbound.createGroup).toHaveBeenLastCalledWith(expect.objectContaining({
      name: expect.stringContaining("[project]"),
      userOpenId: "ou_current_user",
    }));
    const groupSessionId = store.getUserContext("chat_id:oc_new_group")?.currentSessionId;
    expect(store.getSession(groupSessionId!)).toMatchObject({ cwd: child });
  });

  test("paginates large directories and rejects missing paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-dir-page-"));
    tempDirs.push(root);
    for (let index = 0; index < 17; index += 1) {
      fs.writeFileSync(path.join(root, `file-${String(index).padStart(2, "0")}.txt`), String(index));
    }
    const { controller, outbound } = fixture();
    await controller.onMessage(message(`/dir "${root}"`));
    const firstCard = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(firstCard)).toContain("📁 ..");
    expect(JSON.stringify(firstCard)).toContain("file-14.txt");
    expect(JSON.stringify(firstCard)).not.toContain("file-15.txt");

    await controller.onCardAction({
      actionId: "directory-page-2",
      contextKey: "chat_id:c1",
      messageId: "om_directory",
      value: {
        action: "directory_page",
        directory: root,
        page: "1",
        contextKey: "chat_id:c1",
      },
    });
    const secondCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(secondCard)).toContain("📁 ..");
    expect(JSON.stringify(secondCard)).toContain("file-15.txt");
    expect(JSON.stringify(secondCard)).toContain("file-16.txt");
    expect(JSON.stringify(secondCard)).not.toContain("file-14.txt");

    await controller.onMessage(message(`/dir "${path.join(root, "missing")}"`));
    expect(outbound.sendText).toHaveBeenLastCalledWith(
      "chat_id:c1",
      expect.stringContaining("目录不存在或无法访问"),
    );
  });

  test("plain text creates the default Codex session and starts a turn", async () => {
    const { controller, runtime, store, presenter, outbound } = fixture();
    await controller.onMessage(message("inspect this repo"));

    expect(outbound.addReaction).toHaveBeenCalledWith("m-inspect this repo", "OnIt");
    expect(runtime.createSession).toHaveBeenCalledOnce();
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      expect.any(String),
      "chat_id:c1",
      "inspect this repo",
      undefined,
      "inspect this repo",
    );
    expect((presenter.startPendingTurn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (runtime.createSession as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect((outbound.addReaction as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (runtime.createSession as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect(runtime.startTurn).toHaveBeenCalledWith(expect.any(String), "inspect this repo");
    expect(presenter.registerSession).toHaveBeenCalledWith(
      expect.any(String),
      "chat_id:c1",
      "inspect this repo",
      expect.any(String),
      "Codex",
    );
    expect(store.listSessions("chat_id:c1")[0]).toMatchObject({ runtimeKind: "codex", remoteSessionId: "thr_1" });
  });

  test("ignores non-owner Feishu messages before adding a reaction", async () => {
    const { controller, config, outbound, runtime, store } = fixture();
    config.feishu = {
      respondToOwnerOnly: true,
      userOpenId: "ou_owner",
    } as AppConfig["feishu"];

    await controller.onMessage({
      ...message("ignore this"),
      chatType: "p2p",
      userId: "ou_other",
    });

    expect(outbound.addReaction).not.toHaveBeenCalled();
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(store.listSessions("chat_id:c1")).toEqual([]);
  });

  test("waits for the received reaction before chat persistence, image download, and command execution", async () => {
    const { controller, runtime, outbound, store } = fixture();
    let releaseReaction!: (reactionId: string) => void;
    const reactionVisible = new Promise<string>((resolve) => { releaseReaction = resolve; });
    (outbound.addReaction as ReturnType<typeof vi.fn>).mockReturnValueOnce(reactionVisible);
    const recordChatContext = vi.spyOn(store, "recordChatContext");
    const incoming = {
      ...groupMessage("reaction_barrier", "/sessions"),
      images: [{ imageKey: "img_barrier" }],
    };

    const processing = controller.onMessage(incoming);
    await vi.waitFor(() => expect(outbound.addReaction).toHaveBeenCalledWith(
      incoming.messageId,
      "OnIt",
    ));

    expect(recordChatContext).not.toHaveBeenCalled();
    expect(outbound.downloadImage).not.toHaveBeenCalled();
    expect(runtime.listRemoteSessions).not.toHaveBeenCalled();

    releaseReaction("reaction_visible");
    await processing;

    expect(recordChatContext).toHaveBeenCalledWith("chat_id:reaction_barrier", "group");
    expect(outbound.downloadImage).toHaveBeenCalledWith(incoming.messageId, "img_barrier");
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:reaction_barrier",
      "正在读取任务列表，请稍后。",
    );
    const noticeCall = vi.mocked(outbound.sendText).mock.calls.findIndex((call) =>
      call[0] === "chat_id:reaction_barrier" && call[1] === "正在读取任务列表，请稍后。");
    expect(vi.mocked(outbound.sendText).mock.invocationCallOrder[noticeCall])
      .toBeLessThan(vi.mocked(runtime.listRemoteSessions!).mock.invocationCallOrder[0]!);
    expect(runtime.listRemoteSessions).toHaveBeenCalled();
  });

  test("acknowledges and submits a merged-forward message with the default instruction", async () => {
    const { controller, runtime, outbound, presenter } = fixture();
    let releaseReaction!: () => void;
    const reactionVisible = new Promise<string>((resolve) => {
      releaseReaction = () => resolve("reaction_visible");
    });
    vi.mocked(outbound.addReaction!).mockReturnValueOnce(reactionVisible);

    const processing = controller.onMessage({
      messageId: "om_merged",
      contextKey: "chat_id:c1",
      chatType: "p2p",
      userId: "ou_owner",
      text: "",
      mergedForwardMessageId: "om_merged",
    });

    await vi.waitFor(() => expect(outbound.addReaction).toHaveBeenCalledWith("om_merged", "OnIt"));
    expect(outbound.readMergedForward).not.toHaveBeenCalled();

    releaseReaction();
    await processing;

    expect(outbound.readMergedForward).toHaveBeenCalledWith("om_merged");
    expect((outbound.addReaction as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (outbound.readMergedForward as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect(runtime.startTurn).toHaveBeenCalledWith(
      expect.any(String),
      "请参考以下内容回复用户\n\n参考聊天记录：\nresolved merged-forward transcript",
    );
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      expect.any(String),
      "chat_id:c1",
      "请参考以下内容回复用户",
      undefined,
      "请参考以下内容回复用户",
    );
  });

  test("combines a merged-forward message and its attached instruction into one Agent turn", async () => {
    const { controller, runtime, outbound, presenter, store } = fixture();
    vi.mocked(outbound.addReaction!).mockImplementation(async (messageId) => `reaction-${messageId}`);

    const mergedProcessing = controller.onMessage({
      messageId: "om_merged_with_instruction",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_owner",
      text: "",
      mergedForwardMessageId: "om_merged_with_instruction",
    });
    await vi.waitFor(() => expect(outbound.readMergedForward).toHaveBeenCalledWith("om_merged_with_instruction"));

    const instructionProcessing = controller.onMessage({
      messageId: "om_merged_instruction",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_owner",
      parentMessageId: "om_merged_with_instruction",
      text: "<p>查一下这个问题</p>",
    });
    await Promise.all([mergedProcessing, instructionProcessing]);

    expect(runtime.createSession).toHaveBeenCalledOnce();
    expect(runtime.startTurn).toHaveBeenCalledOnce();
    expect(runtime.startTurn).toHaveBeenCalledWith(
      expect.any(String),
      "查一下这个问题\n\n参考聊天记录：\nresolved merged-forward transcript",
    );
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      expect.any(String),
      "chat_id:c1",
      "查一下这个问题",
      undefined,
      "查一下这个问题",
    );
    expect(store.listSessions("chat_id:c1")[0]).toMatchObject({ title: "查一下这个问题" });
    expect(store.getMessageReaction("om_merged_with_instruction")).toMatchObject({
      turnId: "turn_1",
      status: "pending",
    });
    expect(store.getMessageReaction("om_merged_instruction")).toMatchObject({
      turnId: "turn_1",
      status: "pending",
    });
  });

  test("downloads merged-forward child images and submits them to the Agent in transcript order", async () => {
    const { controller, runtime, outbound } = fixture();
    vi.mocked(outbound.readMergedForward!).mockResolvedValueOnce({
      text: "[消息 1 · 成员 1]\n[图片 1]\n\n[消息 2 · 成员 2]\n说明[图片 2]",
      messageCount: 2,
      truncated: false,
      images: [
        { messageId: "om_child_image", imageKey: "img_direct" },
        { messageId: "om_child_post", imageKey: "img_post" },
      ],
      files: [],
    });

    await controller.onMessage({
      messageId: "om_merged_images",
      contextKey: "chat_id:c1",
      chatType: "p2p",
      userId: "ou_owner",
      text: "",
      mergedForwardMessageId: "om_merged_images",
    });

    expect(outbound.downloadImage).toHaveBeenNthCalledWith(1, "om_child_image", "img_direct");
    expect(outbound.downloadImage).toHaveBeenNthCalledWith(2, "om_child_post", "img_post");
    expect(runtime.startTurn).toHaveBeenCalledWith(
      expect.any(String),
      {
        text: "请参考以下内容回复用户\n\n参考聊天记录：\n[消息 1 · 成员 1]\n[图片 1]\n\n[消息 2 · 成员 2]\n说明[图片 2]",
        localImagePaths: [
          path.join(process.cwd(), "img_direct.png"),
          path.join(process.cwd(), "img_post.png"),
        ],
      },
    );
  });

  test("downloads merged-forward files and appends their local paths to the Agent prompt", async () => {
    const { controller, runtime, outbound } = fixture();
    vi.mocked(outbound.readMergedForward!).mockResolvedValueOnce({
      text: "[消息 1 · 成员 1]\n[文件 1：error.log]",
      messageCount: 1,
      truncated: false,
      images: [],
      files: [{ messageId: "om_child_file", fileKey: "file_error", fileName: "error.log" }],
    });

    await controller.onMessage({
      messageId: "om_merged_file",
      contextKey: "chat_id:c1",
      chatType: "p2p",
      userId: "ou_owner",
      text: "",
      mergedForwardMessageId: "om_merged_file",
    });

    expect(outbound.downloadFile).toHaveBeenCalledWith("om_child_file", "file_error", "error.log");
    expect(runtime.startTurn).toHaveBeenCalledWith(
      expect.any(String),
      `请参考以下内容回复用户\n\n参考聊天记录：\n[消息 1 · 成员 1]\n[文件 1：error.log]\n\n参考文件（已下载到本地）：\n[文件 1：error.log] ${path.join(process.cwd(), "error.log")}`,
    );
  });

  test("reports a merged-forward read failure without starting an Agent turn", async () => {
    const { controller, runtime, outbound, store } = fixture();
    vi.mocked(outbound.addReaction!)
      .mockResolvedValueOnce("reaction_pending")
      .mockResolvedValueOnce("reaction_failed");
    vi.mocked(outbound.readMergedForward!).mockRejectedValueOnce(new Error("permission denied"));

    await controller.onMessage({
      messageId: "om_merged_failed",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_owner",
      text: "",
      mergedForwardMessageId: "om_merged_failed",
    });

    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.startTurn).not.toHaveBeenCalled();
    expect(outbound.addReaction).toHaveBeenNthCalledWith(2, "om_merged_failed", "ERROR");
    expect(outbound.deleteReaction).toHaveBeenCalledWith("om_merged_failed", "reaction_pending");
    expect(store.getChatContext("chat_id:c1")).toMatchObject({ chatType: "p2p" });
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("无法读取合并转发消息：permission denied"),
    );
  });

  test("waits for the received reaction before shell execution", async () => {
    const { controller, outbound, shellCommandExecutor } = fixture();
    let releaseReaction!: (reactionId: string) => void;
    const reactionVisible = new Promise<string>((resolve) => { releaseReaction = resolve; });
    (outbound.addReaction as ReturnType<typeof vi.fn>).mockReturnValueOnce(reactionVisible);

    const processing = controller.onMessage(message("! Get-ChildItem"));
    await vi.waitFor(() => expect(outbound.addReaction).toHaveBeenCalledOnce());

    expect(shellCommandExecutor).not.toHaveBeenCalled();

    releaseReaction("reaction_visible");
    await processing;

    expect(shellCommandExecutor).toHaveBeenCalledWith(
      "Get-ChildItem",
      process.cwd(),
      expect.objectContaining({ onOutput: expect.any(Function) }),
    );
  });

  test("starts another bang command without waiting for the previous command", async () => {
    const { controller, outbound, shellCommandExecutor } = fixture();
    let finishFirstCommand!: () => void;
    const firstCommand = new Promise<void>((resolve) => { finishFirstCommand = resolve; });
    (shellCommandExecutor as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => {
        await firstCommand;
        return {
          stdout: "first complete",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          outputTruncated: false,
        };
      });

    const first = controller.onMessage(message("! first-slow-command"));
    await vi.waitFor(() => expect(shellCommandExecutor).toHaveBeenCalledTimes(1));

    const second = controller.onMessage(message("! second-queued-command"));
    await vi.waitFor(() => expect(outbound.addReaction).toHaveBeenCalledTimes(2));

    expect(outbound.addReaction).toHaveBeenNthCalledWith(
      2,
      "m-! second-queued-command",
      "OnIt",
    );
    await vi.waitFor(() => expect(shellCommandExecutor).toHaveBeenCalledTimes(2));
    await Promise.all([first, second]);

    finishFirstCommand();
  });

  test("cancels a background shell command from its card", async () => {
    const { controller, outbound, shellCommandExecutor, shellCommandJobs } = fixture();
    (shellCommandExecutor as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(() => undefined));

    await controller.onMessage(message("! long-running"));
    const initialCard = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(initialCard)).toContain('"action":"shell_command_cancel"');
    expect(JSON.stringify(initialCard)).toContain("Cancel");

    await controller.onCardAction({
      actionId: "cancel-shell-command",
      contextKey: "chat_id:c1",
      messageId: "card",
      value: {
        action: "shell_command_cancel",
        jobId: "00000000-0000-4000-8000-000000000001",
        contextKey: "chat_id:c1",
      },
    });

    expect(shellCommandJobs.requestCancellation).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
    );
    const finalCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(finalCard).toMatchObject({ header: { title: { content: "命令已取消" } } });
  });

  test("reattaches to a running shell command card after Worker restart", async () => {
    const { controller, outbound, shellCommandJobs } = fixture();
    const startedAt = Date.now() - 5_000;
    shellCommandJobs.seedJob({
      version: 1,
      id: "00000000-0000-4000-8000-000000000099",
      contextKey: "chat_id:c1",
      cardMessageId: "card_recovered_shell",
      command: "long-command",
      cwd: process.cwd(),
      createdAt: startedAt,
      startedAt,
      updatedAt: Date.now(),
      runnerPid: process.pid,
      status: "running",
      output: "recovered output",
      outputTruncated: false,
    });

    await controller.recoverInterruptedTasks();

    await vi.waitFor(() => {
      const latest = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1);
      expect(latest?.[0]).toBe("card_recovered_shell");
      expect(latest?.[1]).toMatchObject({ header: { title: { content: "正在执行命令" } } });
    }, { timeout: 3_500 });
    expect(JSON.stringify((outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]))
      .toContain("recovered output");
  });

  test("finalizes the shell command card when the background runner cannot start", async () => {
    const { controller, outbound, shellCommandJobs } = fixture();
    vi.spyOn(shellCommandJobs, "startJob").mockRejectedValueOnce(new Error("runner unavailable"));

    await controller.onMessage(message("! cannot-start"));

    await vi.waitFor(() => {
      const latest = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
      expect(latest).toMatchObject({ header: { title: { content: "命令执行失败" } } });
      expect(JSON.stringify(latest)).toContain("runner unavailable");
    });
  });

  test("records base Feishu chats and treats every incoming message as activity", async () => {
    const { controller, store } = fixture();

    await controller.onMessage({
      ...message("private prompt"),
      chatId: "private",
      chatType: "p2p",
      contextKey: "chat_id:private:thread_id:topic",
      threadContext: true,
      threadId: "topic",
    });
    await controller.onMessage(groupMessage("group", "! ls"));
    await controller.onMessage(groupMessage("slash", "/status"));

    expect(store.listChatContexts("p2p").map((context) => context.contextKey)).toEqual(["chat_id:private"]);
    expect(store.listChatContexts("group").map((context) => context.contextKey)).toEqual([
      "chat_id:slash",
      "chat_id:group",
    ]);
    const activeContexts = store.listRecentlyActiveChatContexts(new Date(0)).map((context) => context.contextKey);
    expect(activeContexts).toEqual(expect.arrayContaining([
      "chat_id:group",
      "chat_id:private",
      "chat_id:slash",
    ]));
  });

  test("mutes a whole group until the bot is mentioned and supports /mute off", async () => {
    const { controller, outbound, store } = fixture();

    await controller.onMessage(groupMessage("muted", "/mute"));

    expect(store.getChatContext("chat_id:muted")).toMatchObject({
      chatType: "group",
      requiresMention: true,
    });
    expect(outbound.sendText).toHaveBeenLastCalledWith(
      "chat_id:muted",
      expect.stringContaining("只有 @ 机器人的消息会被处理"),
    );

    vi.mocked(outbound.addReaction!).mockClear();
    vi.mocked(outbound.sendInteractiveCard).mockClear();
    await controller.onMessage(groupMessage("muted", "/status"));
    expect(outbound.addReaction).not.toHaveBeenCalled();
    expect(outbound.sendInteractiveCard).not.toHaveBeenCalled();

    await controller.onMessage({
      ...groupMessage("muted", "/mute off"),
      mentionedBot: true,
    });
    expect(store.chatRequiresMention("chat_id:muted")).toBe(false);
    expect(outbound.addReaction).toHaveBeenCalledOnce();
    expect(outbound.sendText).toHaveBeenLastCalledWith(
      "chat_id:muted",
      expect.stringContaining("恢复自动响应群消息"),
    );
  });

  test("applies a group's mute setting to all of its topic routes", async () => {
    const { controller, outbound, store } = fixture();
    store.recordChatContext("chat_id:topic_group", "group");
    store.setChatRequiresMention("chat_id:topic_group", true);

    await controller.onMessage(threadMessage(
      "topic_group",
      "group",
      "topic_1",
      "om_topic_root",
      "/status",
    ));
    expect(outbound.addReaction).not.toHaveBeenCalled();

    await controller.onMessage({
      ...threadMessage(
        "topic_group",
        "group",
        "topic_1",
        "om_topic_root",
        "/mute off",
      ),
      mentionedBot: true,
    });
    expect(store.chatRequiresMention("chat_id:topic_group")).toBe(false);
    expect(outbound.replyText).toHaveBeenCalledWith(
      "chat_id:topic_group:thread_id:topic_1",
      expect.objectContaining({ messageId: expect.any(String), replyInThread: true }),
      expect.stringContaining("恢复自动响应群消息"),
    );
  });

  test("downloads a pure image and starts Codex with a default text prompt plus localImage input", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage({
      messageId: "om_image_input",
      contextKey: "chat_id:c1",
      text: "",
      images: [{ imageKey: "img_input" }],
    });

    expect(outbound.downloadImage).toHaveBeenCalledWith("om_image_input", "img_input");
    expect(runtime.startTurn).toHaveBeenCalledWith(expect.any(String), {
      text: "请查看这张图片",
      localImagePaths: [expect.stringContaining("img_input.png")],
    });
  });

  test("combines a forwarded image and its attached instruction into one Agent turn", async () => {
    const { controller, runtime, outbound, presenter, store } = fixture();
    vi.mocked(outbound.addReaction!).mockImplementation(async (messageId) => `reaction-${messageId}`);

    const imageProcessing = controller.onMessage({
      messageId: "om_forwarded_image",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_owner",
      text: "",
      images: [{ imageKey: "img_forwarded" }],
    });
    await vi.waitFor(() => expect(outbound.addReaction).toHaveBeenCalledWith("om_forwarded_image", "OnIt"));

    const instructionProcessing = controller.onMessage({
      messageId: "om_image_instruction",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_owner",
      parentMessageId: "om_forwarded_image",
      text: "总结图中的内容",
    });
    await Promise.all([imageProcessing, instructionProcessing]);

    expect(outbound.downloadImage).toHaveBeenCalledOnce();
    expect(outbound.downloadImage).toHaveBeenCalledWith("om_forwarded_image", "img_forwarded");
    expect(runtime.startTurn).toHaveBeenCalledOnce();
    expect(runtime.startTurn).toHaveBeenCalledWith(expect.any(String), {
      text: "总结图中的内容",
      localImagePaths: [path.join(process.cwd(), "img_forwarded.png")],
    });
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      expect.any(String),
      "chat_id:c1",
      "总结图中的内容",
      undefined,
      "总结图中的内容",
    );
    expect(store.getMessageReaction("om_forwarded_image")).toMatchObject({ turnId: "turn_1" });
    expect(store.getMessageReaction("om_image_instruction")).toMatchObject({ turnId: "turn_1" });
  });

  test("combines a forwarded file and its attached instruction into one Agent turn", async () => {
    const { controller, runtime, outbound, presenter, store } = fixture();
    vi.mocked(outbound.addReaction!).mockImplementation(async (messageId) => `reaction-${messageId}`);

    const fileProcessing = controller.onMessage({
      messageId: "om_forwarded_file",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_owner",
      text: "",
      files: [{ fileKey: "file_forwarded", fileName: "error.log" }],
    });
    await vi.waitFor(() => expect(outbound.addReaction).toHaveBeenCalledWith("om_forwarded_file", "OnIt"));

    const instructionProcessing = controller.onMessage({
      messageId: "om_file_instruction",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_owner",
      parentMessageId: "om_forwarded_file",
      text: "分析这个日志",
    });
    await Promise.all([fileProcessing, instructionProcessing]);

    expect(outbound.downloadFile).toHaveBeenCalledOnce();
    expect(outbound.downloadFile).toHaveBeenCalledWith("om_forwarded_file", "file_forwarded", "error.log");
    expect(runtime.startTurn).toHaveBeenCalledOnce();
    expect(runtime.startTurn).toHaveBeenCalledWith(
      expect.any(String),
      `分析这个日志\n\n参考文件（已下载到本地）：\n[文件 1：error.log] ${path.join(process.cwd(), "error.log")}`,
    );
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      expect.any(String),
      "chat_id:c1",
      "分析这个日志",
      undefined,
      "分析这个日志",
    );
    expect(store.getMessageReaction("om_forwarded_file")).toMatchObject({ turnId: "turn_1" });
    expect(store.getMessageReaction("om_file_instruction")).toMatchObject({ turnId: "turn_1" });
  });

  test("uses the default file prompt when a forwarded file has no attached instruction", async () => {
    const { controller, runtime, outbound } = fixture();

    await controller.onMessage({
      messageId: "om_file_without_instruction",
      contextKey: "chat_id:c1",
      text: "",
      files: [{ fileKey: "file_plain", fileName: "notes.txt" }],
    });

    expect(outbound.downloadFile).toHaveBeenCalledWith("om_file_without_instruction", "file_plain", "notes.txt");
    expect(runtime.startTurn).toHaveBeenCalledWith(
      expect.any(String),
      `请查看这个文件\n\n参考文件（已下载到本地）：\n[文件 1：notes.txt] ${path.join(process.cwd(), "notes.txt")}`,
    );
  });

  test("combines a user question with a referenced Feishu text message", async () => {
    const { controller, runtime, outbound } = fixture();
    vi.mocked(outbound.readReferencedMessage!).mockResolvedValueOnce({
      text: "[消息类型：文本]\n这是被引用的消息",
      messageType: "text",
      images: [],
      files: [],
    });

    await controller.onMessage({
      messageId: "om_quote_question",
      contextKey: "chat_id:c1",
      text: "你这样说的原因是什么？",
      parentMessageId: "om_quoted_text",
    });

    expect(outbound.readReferencedMessage).toHaveBeenCalledWith("om_quoted_text");
    expect(runtime.startTurn).toHaveBeenCalledWith(
      expect.any(String),
      "你这样说的原因是什么？\n\n引用消息：\n[消息类型：文本]\n这是被引用的消息",
    );
  });

  test("downloads a referenced image and passes it with the combined Prompt", async () => {
    const { controller, runtime, outbound } = fixture();
    vi.mocked(outbound.readReferencedMessage!).mockResolvedValueOnce({
      text: "[消息类型：图片]\n[图片 1]",
      messageType: "image",
      images: [{ messageId: "om_quoted_image", imageKey: "img_quoted" }],
      files: [],
    });

    await controller.onMessage({
      messageId: "om_quote_image_question",
      contextKey: "chat_id:c1",
      text: "你这样说的原因是什么？",
      parentMessageId: "om_quoted_image",
    });

    expect(outbound.downloadImage).toHaveBeenCalledWith("om_quoted_image", "img_quoted");
    expect(runtime.startTurn).toHaveBeenCalledWith(expect.any(String), {
      text: "你这样说的原因是什么？\n\n引用消息：\n[消息类型：图片]\n[图片 1]",
      localImagePaths: [path.join(process.cwd(), "img_quoted.png")],
    });
  });

  test("downloads a referenced file and appends its local path to the combined Prompt", async () => {
    const { controller, runtime, outbound } = fixture();
    vi.mocked(outbound.readReferencedMessage!).mockResolvedValueOnce({
      text: "[消息类型：文件]\n[文件 1：report.pdf]",
      messageType: "file",
      images: [],
      files: [{ messageId: "om_quoted_file", fileKey: "file_report", fileName: "report.pdf" }],
    });

    await controller.onMessage({
      messageId: "om_quote_file_question",
      contextKey: "chat_id:c1",
      text: "总结这个文件",
      parentMessageId: "om_quoted_file",
    });

    expect(outbound.downloadFile).toHaveBeenCalledWith("om_quoted_file", "file_report", "report.pdf");
    expect(runtime.startTurn).toHaveBeenCalledWith(
      expect.any(String),
      `总结这个文件\n\n引用消息：\n[消息类型：文件]\n[文件 1：report.pdf]\n\n参考文件（已下载到本地）：\n[文件 1：report.pdf] ${path.join(process.cwd(), "report.pdf")}`,
    );
  });

  test("prefers the local Turn snapshot for an AgentBot final reply", async () => {
    const { controller, runtime, outbound, store } = fixture();
    store.saveTurnSnapshot("turn_quoted", "session_quoted", {
      sessionId: "session_quoted",
      turnId: "turn_quoted",
      status: "completed",
      assistantText: "本地回答",
      activities: [],
      finalResponse: "这是 AgentBot 的本地最终回复。",
    }, "chat_id:c1");
    store.markFinalDelivered("turn_quoted", ["om_agentbot_final"]);

    await controller.onMessage({
      messageId: "om_quote_agentbot_question",
      contextKey: "chat_id:c1",
      text: "为什么？",
      parentMessageId: "om_agentbot_final",
    });

    expect(outbound.readReferencedMessage).not.toHaveBeenCalled();
    expect(runtime.startTurn).toHaveBeenCalledWith(
      expect.any(String),
      "为什么？\n\n引用消息：\n[消息类型：AgentBot 回复]\n这是 AgentBot 的本地最终回复。",
    );
  });

  test("checks an inherited topic root without loading the full graph before presenting the card", async () => {
    const { controller, runtime, outbound, presenter, store } = fixture();
    const topicMessage = (text: string) => threadMessage("group", "group", "topic", "om_root", text);
    await controller.onMessage(topicMessage("/new linked task"));
    const sessionId = store.getUserContext("chat_id:group:thread_id:topic")!.currentSessionId!;
    store.saveTurnSnapshot("root", "source", { status: "completed" });
    store.saveTurnParent("root", "source");
    store.bindMessageToTurn("om_root", "source", "root");
    store.audit("chat_id:group:thread_id:topic", "thread_forked", {
      forkedLocalSessionId: sessionId, sourceTurnId: "root",
    });
    const graphRead = vi.spyOn(store, "listTaskTurnGraph").mockImplementation(() => {
      throw new Error("The prompt path must not load the full history graph");
    });
    const membershipCheck = vi.spyOn(store, "hasTaskHistoryTurn");

    await controller.onMessage(topicMessage("continue"));
    expect(membershipCheck).toHaveBeenCalledWith(sessionId, "root");
    expect(runtime.startTurn).toHaveBeenLastCalledWith(sessionId, "continue");
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      sessionId, "chat_id:group:thread_id:topic", "linked task",
      { messageId: "m-topic-continue", replyInThread: true }, "continue",
    );
    await controller.onMessage(topicMessage("next instruction"));
    expect(runtime.steerTurn).toHaveBeenLastCalledWith(sessionId, "turn_1", "next instruction");
    expect(outbound.readReferencedMessage).not.toHaveBeenCalled();
    expect(graphRead).not.toHaveBeenCalled();

    await controller.onMessage(topicMessage("/new fresh task"));
    await controller.onMessage(topicMessage("start fresh"));
    expect(outbound.readReferencedMessage).toHaveBeenCalledOnce();
    expect(outbound.readReferencedMessage).toHaveBeenCalledWith("om_root");
    expect(runtime.startTurn).toHaveBeenLastCalledWith(
      expect.any(String), expect.stringContaining("start fresh\n\n话题根消息："),
    );
  });

  test("injects an unanchored topic root once into the task Prompt", async () => {
    const { controller, runtime, outbound, store } = fixture();
    vi.mocked(outbound.readReferencedMessage!).mockResolvedValueOnce({
      text: "[消息类型：文本]\nhttps://github.com/example/project/pull/1",
      messageType: "text",
      images: [],
      files: [],
    });

    await controller.onMessage(threadMessage(
      "topic_group",
      "group",
      "topic_quote_guard",
      "om_topic_root",
      "继续处理",
    ));

    expect(outbound.readReferencedMessage).toHaveBeenCalledWith("om_topic_root");
    expect(runtime.startTurn).toHaveBeenCalledWith(
      expect.any(String),
      "继续处理\n\n话题根消息：\n[消息类型：文本]\nhttps://github.com/example/project/pull/1",
    );
    const sessionId = store.getUserContext("chat_id:topic_group:thread_id:topic_quote_guard")?.currentSessionId;
    expect(sessionId).toBeDefined();
    expect(store.hasInjectedTopicRoot(sessionId!, "om_topic_root")).toBe(true);

    await controller.onMessage(threadMessage(
      "topic_group",
      "group",
      "topic_quote_guard",
      "om_topic_root",
      "继续第二步",
    ));

    expect(outbound.readReferencedMessage).toHaveBeenCalledOnce();
    expect(runtime.steerTurn).toHaveBeenCalledWith(
      sessionId,
      expect.any(String),
      "继续第二步",
    );
  });

  test("rejects unknown slash commands without sending text or images to the model", async () => {
    const { controller, runtime, outbound, store } = fixture();

    await controller.onMessage(message("/does-not-exist hello"));
    await controller.onMessage({
      messageId: "om_unknown_slash_image",
      contextKey: "chat_id:c1",
      text: "  /missing-with-image",
      images: [{ imageKey: "img_unused" }],
    });

    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.startTurn).not.toHaveBeenCalled();
    expect(runtime.steerTurn).not.toHaveBeenCalled();
    expect(store.listSessions("chat_id:c1")).toHaveLength(0);
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "未知命令：/does-not-exist。发送 /help 查看可用命令。",
    );
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "未知命令：/missing-with-image。发送 /help 查看可用命令。",
    );
  });

  test("keeps current tasks and stop operations isolated between groups", async () => {
    const { controller, runtime, sessions, remoteSessions, outbound, store, presenter, listeners } = fixture();
    let created = 0;
    (runtime.createSession as ReturnType<typeof vi.fn>).mockImplementation(async (input) => {
      created += 1;
      const session: RuntimeSession = {
        ...input,
        remoteSessionId: `thr_group_${created}`,
        runtimeKind: "codex",
        model: "gpt-test",
        reasoningEffort: "high",
      };
      sessions.set(input.localSessionId, session);
      remoteSessions.push({
        id: session.remoteSessionId,
        cwd: input.cwd,
        source: "agent-bot",
        status: "idle",
      });
      return session;
    });
    (runtime.startTurn as ReturnType<typeof vi.fn>).mockImplementation(async (sessionId: string) => {
      const session = sessions.get(sessionId)!;
      const turnId = `turn_${session.remoteSessionId}`;
      session.activeTurnId = turnId;
      const remote = remoteSessions.find((candidate) => candidate.id === session.remoteSessionId)!;
      remote.status = "active";
      remote.lastTurnId = turnId;
      remote.lastTurnStatus = "inProgress";
      for (const listener of listeners) listener({ type: "turn_started", sessionId, turnId, startedAt: 1 });
      return turnId;
    });

    await controller.onMessage(groupMessage("group_1", "first group task"));
    await controller.onMessage(groupMessage("group_2", "second group task"));

    const first = store.getOrCreateUserContext("chat_id:group_1", "codex").currentSessionId;
    const second = store.getOrCreateUserContext("chat_id:group_2", "codex").currentSessionId;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      first,
      "chat_id:group_1",
      "first group task",
      undefined,
      "first group task",
    );
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      second,
      "chat_id:group_2",
      "second group task",
      undefined,
      "second group task",
    );

    await controller.onMessage(groupMessage("group_1", "/sessions"));
    expect(outbound.sendInteractiveCard).toHaveBeenCalledWith(
      "chat_id:group_1",
      expect.objectContaining({ header: expect.any(Object) }),
    );

    await controller.onMessage(groupMessage("group_1", "/stop"));

    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("thr_group_1", "turn_thr_group_1");
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:group_1",
      "已发送停止信号，任务会自动停止。",
    );
    expect(sessions.get(second!)?.activeTurnId).toBe("turn_thr_group_2");
    expect(store.getOrCreateUserContext("chat_id:group_2", "codex").currentSessionId).toBe(second);
  });

  test("forks a completed private-chat turn into an isolated topic task", async () => {
    const { controller, runtime, store, listeners, outbound, presenter } = fixture();
    const sourceMessage: IncomingMessage = {
      messageId: "om_source",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      text: "build the base task",
    };

    await controller.onMessage(sourceMessage);
    const sourceSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(sourceSessionId).toBeDefined();
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId!,
        turnId: "turn_1",
        finalResponse: "base complete",
      });
    }

    await controller.onMessage(threadMessage("c1", "p2p", "omt_branch", "om_source", "continue differently"));

    const topicContextKey = "chat_id:c1:thread_id:omt_branch";
    const topicSessionId = store.getUserContext(topicContextKey)?.currentSessionId;
    expect(topicSessionId).toBeDefined();
    expect(topicSessionId).not.toBe(sourceSessionId);
    expect(store.getUserContext("chat_id:c1")?.currentSessionId).toBe(sourceSessionId);
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: topicSessionId,
      remoteSessionId: "thr_1",
      lastTurnId: "turn_1",
      title: "build the base task（分支 1）",
    }));
    expect(store.getSession(topicSessionId!)).toMatchObject({
      contextKey: topicContextKey,
      remoteSessionId: "thr_1_fork",
      title: "build the base task（分支 1）",
      status: "running",
    });
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      topicSessionId,
      topicContextKey,
      "build the base task（分支 1）",
      { messageId: "m-omt_branch-continue differently", replyInThread: true },
      "continue differently",
    );
    expect(outbound.sendText).not.toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("continue differently"),
    );

    await controller.onCardAction({
      actionId: "action_topic_stop",
      contextKey: "chat_id:c1",
      messageId: "om_topic_status_card",
      value: {
        action: "session_stop",
        sessionId: "thr_1_fork",
        contextKey: topicContextKey,
        cardView: "status",
      },
    });

    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("thr_1_fork", "turn_1");
    expect(outbound.replyText).toHaveBeenCalledWith(
      topicContextKey,
      { messageId: "om_topic_status_card", replyInThread: true },
      "已发送停止信号，任务会自动停止。",
    );
  });

  test("forks a completed group-main turn into an isolated group-topic task", async () => {
    const { controller, runtime, store, listeners, presenter } = fixture();
    await controller.onMessage({
      messageId: "om_group_source",
      contextKey: "chat_id:group_fork",
      chatId: "group_fork",
      chatType: "group",
      text: "group base task",
    });
    const sourceSessionId = store.getUserContext("chat_id:group_fork")?.currentSessionId;
    expect(sourceSessionId).toBeDefined();
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId!,
        turnId: "turn_1",
        finalResponse: "group base complete",
      });
    }

    await controller.onMessage(threadMessage(
      "group_fork",
      "group",
      "omt_group_branch",
      "om_group_source",
      "continue in group topic",
    ));

    const topicContextKey = "chat_id:group_fork:thread_id:omt_group_branch";
    const topicSessionId = store.getUserContext(topicContextKey)?.currentSessionId;
    expect(topicSessionId).toBeDefined();
    expect(topicSessionId).not.toBe(sourceSessionId);
    expect(store.getUserContext("chat_id:group_fork")?.currentSessionId).toBe(sourceSessionId);
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: topicSessionId,
      remoteSessionId: "thr_1",
      lastTurnId: "turn_1",
      title: "group base task（分支 1）",
    }));
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      topicSessionId,
      topicContextKey,
      "group base task（分支 1）",
      { messageId: "m-omt_group_branch-continue in group topic", replyInThread: true },
      "continue in group topic",
    );
  });

  test("keeps an anchored topic unbound for commands and forks on its first Prompt", async () => {
    const { controller, runtime, store, listeners, outbound } = fixture();
    await controller.onMessage({
      messageId: "om_lazy_topic_source",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      text: "build lazy topic source",
    });
    const sourceSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId!,
        turnId: "turn_1",
        finalResponse: "source complete",
      });
    }

    const threadId = "omt_lazy_topic";
    const topicContextKey = `chat_id:c1:thread_id:${threadId}`;
    const statusMessage = threadMessage("c1", "p2p", threadId, "om_lazy_topic_source", "/status");
    await controller.onMessage(statusMessage);

    expect(runtime.forkSession).not.toHaveBeenCalled();
    expect(store.getUserContext(topicContextKey)?.currentSessionId).toBeUndefined();
    const statusCard = (outbound.replyInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2];
    expect(JSON.stringify(statusCard)).toContain("当前话题尚未绑定任务");

    const modelMessage = threadMessage("c1", "p2p", threadId, "om_lazy_topic_source", "/model");
    await controller.onMessage(modelMessage);

    expect(runtime.forkSession).not.toHaveBeenCalled();
    expect(store.getUserContext(topicContextKey)?.currentSessionId).toBeUndefined();
    expect(outbound.replyText).toHaveBeenCalledWith(
      topicContextKey,
      { messageId: modelMessage.messageId, replyInThread: true },
      expect.stringContaining("当前话题尚未绑定任务"),
    );

    await controller.onMessage(threadMessage(
      "c1",
      "p2p",
      threadId,
      "om_lazy_topic_source",
      "continue from the source turn",
    ));

    expect(runtime.forkSession).toHaveBeenCalledOnce();
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      remoteSessionId: "thr_1",
      lastTurnId: "turn_1",
    }));
    expect(store.getUserContext(topicContextKey)?.currentSessionId).toBeDefined();
    expect(outbound.readReferencedMessage).not.toHaveBeenCalled();
    expect(runtime.startTurn).toHaveBeenLastCalledWith(
      expect.any(String),
      "continue from the source turn",
    );
  });

  test("creates a fresh topic task with new and injects a root absent from that task", async () => {
    const { controller, runtime, store, listeners, outbound } = fixture();
    await controller.onMessage({
      messageId: "om_new_topic_source",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      text: "build new topic source",
    });
    const sourceSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId!,
        turnId: "turn_1",
        finalResponse: "source complete",
      });
    }
    (runtime.createSession as ReturnType<typeof vi.fn>).mockClear();

    const topicContextKey = "chat_id:c1:thread_id:omt_new_topic";
    await controller.onMessage(threadMessage(
      "c1",
      "p2p",
      "omt_new_topic",
      "om_new_topic_source",
      "/new fresh topic task",
    ));

    expect(runtime.forkSession).not.toHaveBeenCalled();
    expect(runtime.createSession).toHaveBeenCalledOnce();
    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({ title: "fresh topic task" }));
    const topicSessionId = store.getUserContext(topicContextKey)?.currentSessionId;
    expect(topicSessionId).toBeDefined();
    expect(topicSessionId).not.toBe(sourceSessionId);
    expect(store.getSession(topicSessionId!)?.title).toBe("fresh topic task");

    vi.mocked(outbound.readReferencedMessage!).mockResolvedValueOnce({
      text: "[消息类型：文本]\nsource context",
      messageType: "text",
      images: [],
      files: [],
    });
    await controller.onMessage(threadMessage(
      "c1",
      "p2p",
      "omt_new_topic",
      "om_new_topic_source",
      "work independently",
    ));

    expect(outbound.readReferencedMessage).toHaveBeenCalledWith("om_new_topic_source");
    expect(runtime.startTurn).toHaveBeenLastCalledWith(
      topicSessionId,
      "work independently\n\n话题根消息：\n[消息类型：文本]\nsource context",
    );
  });

  test("shows an empty status instead of requiring a fork anchor in a new standalone topic", async () => {
    const { controller, runtime, outbound, store } = fixture();
    const messageId = "om_standalone_topic_status";
    const contextKey = "chat_id:standalone_topic_group:thread_id:omt_standalone_status";

    await controller.onMessage({
      messageId,
      contextKey,
      chatId: "standalone_topic_group",
      chatType: "group",
      replyInThread: true,
      threadContext: true,
      threadId: "omt_standalone_status",
      rootMessageId: messageId,
      text: "/status",
    });

    expect(runtime.forkSession).not.toHaveBeenCalled();
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(store.getUserContext(contextKey)?.currentSessionId).toBeUndefined();
    expect(outbound.replyInteractiveCard).toHaveBeenCalledWith(
      contextKey,
      { messageId, replyInThread: true },
      expect.objectContaining({ header: expect.any(Object) }),
    );
    expect(outbound.sendText).not.toHaveBeenCalledWith(
      contextKey,
      expect.stringContaining("无法确定这个话题对应的 App Server 轮次"),
    );
  });

  test("treats a topic reply to an unbound message as standalone", async () => {
    const { controller, runtime, outbound, store } = fixture();
    const messageId = "om_standalone_reply_status";
    const contextKey = "chat_id:standalone_topic_group:thread_id:omt_standalone_reply";

    await controller.onMessage({
      messageId,
      contextKey,
      chatId: "standalone_topic_group",
      chatType: "group",
      replyInThread: true,
      threadContext: true,
      threadId: "omt_standalone_reply",
      rootMessageId: "om_unbound_root_message",
      parentMessageId: "om_unbound_bot_reply",
      text: "/status",
    });

    expect(runtime.forkSession).not.toHaveBeenCalled();
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(store.getUserContext(contextKey)?.currentSessionId).toBeUndefined();
    expect(outbound.replyInteractiveCard).toHaveBeenCalledWith(
      contextKey,
      { messageId, replyInThread: true },
      expect.objectContaining({ header: expect.any(Object) }),
    );
    expect(outbound.sendText).not.toHaveBeenCalledWith(
      contextKey,
      expect.stringContaining("无法确定这个话题对应的 App Server 轮次"),
    );
  });

  test("creates a fresh task for the first Prompt in a new standalone topic", async () => {
    const { controller, runtime, store } = fixture();
    const messageId = "om_standalone_topic_prompt";
    const contextKey = "chat_id:standalone_topic_group:thread_id:omt_standalone_prompt";

    await controller.onMessage({
      messageId,
      contextKey,
      chatId: "standalone_topic_group",
      chatType: "group",
      replyInThread: true,
      threadContext: true,
      threadId: "omt_standalone_prompt",
      rootMessageId: messageId,
      text: "start a fresh topic task",
    });

    expect(runtime.forkSession).not.toHaveBeenCalled();
    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      title: "start a fresh topic task",
    }));
    expect(runtime.startTurn).toHaveBeenCalledWith(expect.any(String), "start a fresh topic task");
    const sessionId = store.getUserContext(contextKey)?.currentSessionId;
    expect(sessionId).toBeDefined();
    expect(store.getSession(sessionId!)?.contextKey).toBe(contextKey);
  });

  test("does not fork a private-chat topic while its anchor turn is still running", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage({
      messageId: "om_running_source",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      text: "long task",
    });

    await controller.onMessage(threadMessage("c1", "p2p", "omt_running", "om_running_source", "branch now"));

    expect(runtime.forkSession).not.toHaveBeenCalled();
    expect(outbound.replyText).toHaveBeenCalledWith(
      "chat_id:c1:thread_id:omt_running",
      { messageId: "m-omt_running-branch now", replyInThread: true },
      expect.stringContaining("轮次仍在执行"),
    );
  });

  test("forkgroup in an unbound topic forks the original turn without creating a topic task", async () => {
    const { controller, runtime, store, listeners } = fixture();
    await controller.onMessage({
      messageId: "om_forkgroup_source",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      text: "build forkgroup source",
    });
    const sourceSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId!,
        turnId: "turn_1",
        finalResponse: "source complete",
      });
    }
    await vi.waitFor(() => {
      expect(store.findTurnAnchorByMessageId("om_forkgroup_source")?.turnId).toBe("turn_1");
    });
    (runtime.forkSession as ReturnType<typeof vi.fn>).mockClear();
    vi.mocked(runtime.readRemoteSession!).mockClear();
    vi.mocked(runtime.readRemoteSession!).mockRejectedValue(new Error("Full history must not block Fork"));
    const importHistory = vi.spyOn(store, "importCompletedTurnHistory");

    await controller.onMessage({
      ...threadMessage(
        "c1",
        "p2p",
        "omt_forkgroup_unbound",
        "om_forkgroup_source",
        "/forkgroup",
      ),
      userId: "ou_current_user",
    });

    expect(runtime.forkSession).toHaveBeenCalledOnce();
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      remoteSessionId: "thr_1",
      lastTurnId: "turn_1",
    }));
    expect(store.getUserContext("chat_id:c1:thread_id:omt_forkgroup_unbound")?.currentSessionId)
      .toBeUndefined();
    expect(store.getUserContext("chat_id:oc_new_group")?.currentSessionId).toBeDefined();
    expect(runtime.readRemoteSession).not.toHaveBeenCalled();
    expect(importHistory).not.toHaveBeenCalled();
  });

  test("forkgroup in a bound topic with no completed topic turn falls back to the original turn", async () => {
    const { controller, runtime, sessions, store, listeners } = fixture();
    await controller.onMessage({
      messageId: "om_bound_forkgroup_source",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      text: "build bound forkgroup source",
    });
    const sourceSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId!,
        turnId: "turn_1",
        finalResponse: "source complete",
      });
    }
    await vi.waitFor(() => {
      expect(store.findTurnAnchorByMessageId("om_bound_forkgroup_source")?.turnId).toBe("turn_1");
    });

    const topicContextKey = "chat_id:c1:thread_id:omt_forkgroup_bound";
    await controller.onMessage(threadMessage(
      "c1",
      "p2p",
      "omt_forkgroup_bound",
      "om_bound_forkgroup_source",
      "start the topic task",
    ));
    const topicSessionId = store.getUserContext(topicContextKey)?.currentSessionId;
    expect(topicSessionId).toBeDefined();
    store.saveTurnSnapshot("turn_topic_running", topicSessionId!, {
      sessionId: topicSessionId,
      turnId: "turn_topic_running",
      status: "running",
      startedAt: 10,
    }, topicContextKey);
    store.updateSession(topicSessionId!, { status: "running" });
    store.updateRuntimeSession(topicSessionId!, {
      lastTurnId: "turn_topic_running",
      lastTurnStatus: "running",
    });
    sessions.get(topicSessionId!)!.activeTurnId = "turn_topic_running";
    (runtime.forkSession as ReturnType<typeof vi.fn>).mockClear();

    await controller.onMessage({
      ...threadMessage("c1", "p2p", "omt_forkgroup_bound", "om_bound_forkgroup_source", "/forkgroup"),
      userId: "ou_current_user",
    });

    expect(runtime.forkSession).toHaveBeenCalledOnce();
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      remoteSessionId: "thr_1",
      lastTurnId: "turn_1",
    }));
    expect(store.getUserContext(topicContextKey)?.currentSessionId).toBe(topicSessionId);
  });

  test("forkgroup in a bound topic forks its latest completed turn while a later turn is running", async () => {
    const { controller, runtime, sessions, store, listeners } = fixture();
    await controller.onMessage({
      messageId: "om_progressed_forkgroup_source",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      text: "build progressed forkgroup source",
    });
    const sourceSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId!,
        turnId: "turn_1",
        finalResponse: "source complete",
      });
    }
    await vi.waitFor(() => {
      expect(store.findTurnAnchorByMessageId("om_progressed_forkgroup_source")?.turnId).toBe("turn_1");
    });

    const topicContextKey = "chat_id:c1:thread_id:omt_forkgroup_progressed";
    await controller.onMessage(threadMessage(
      "c1",
      "p2p",
      "omt_forkgroup_progressed",
      "om_progressed_forkgroup_source",
      "start the progressed topic task",
    ));
    const topicSessionId = store.getUserContext(topicContextKey)?.currentSessionId;
    const topicSession = store.getSession(topicSessionId!);
    expect(topicSession?.remoteSessionId).toBe("thr_1_fork");
    store.saveTurnSnapshot("turn_topic_completed", topicSessionId!, {
      sessionId: topicSessionId,
      turnId: "turn_topic_completed",
      status: "completed",
      startedAt: 20,
      completedAt: 30,
    }, topicContextKey);
    store.saveTurnSnapshot("turn_topic_running", topicSessionId!, {
      sessionId: topicSessionId,
      turnId: "turn_topic_running",
      status: "running",
      startedAt: 40,
    }, topicContextKey);
    store.updateSession(topicSessionId!, { status: "running" });
    store.updateRuntimeSession(topicSessionId!, {
      lastTurnId: "turn_topic_running",
      lastTurnStatus: "running",
    });
    sessions.get(topicSessionId!)!.activeTurnId = "turn_topic_running";
    (runtime.forkSession as ReturnType<typeof vi.fn>).mockClear();

    await controller.onMessage({
      ...threadMessage(
        "c1",
        "p2p",
        "omt_forkgroup_progressed",
        "om_progressed_forkgroup_source",
        "/forkgroup",
      ),
      userId: "ou_current_user",
    });

    expect(runtime.forkSession).toHaveBeenCalledOnce();
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      remoteSessionId: "thr_1_fork",
      lastTurnId: "turn_topic_completed",
    }));
    expect(store.getUserContext(topicContextKey)?.currentSessionId).toBe(topicSessionId);
  });

  test("forks the current completed Codex task and switches to the new branch", async () => {
    const { controller, runtime, sessions, remoteSessions, store, listeners, outbound, presenter } = fixture();
    await controller.onMessage(message("build the source task"));
    const sourceSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(sourceSessionId).toBeDefined();
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId!,
        turnId: "turn_1",
        finalResponse: "source complete",
      });
    }
    store.saveTurnSnapshot("turn_1", sourceSessionId!, {
      sessionId: sourceSessionId!,
      turnId: "turn_1",
      status: "completed",
      prompt: "build the source task",
      startedAt: 1,
      completedAt: 2,
    }, "chat_id:c1");
    store.saveTurnRuntimeOrigin("turn_1", sourceSessionId!, "codex", "thr_1");
    const sourceRuntimeSession = sessions.get(sourceSessionId!);
    if (sourceRuntimeSession) sourceRuntimeSession.activeTurnId = undefined;
    const sourceRemote = remoteSessions.find((session) => session.id === "thr_1")!;
    sourceRemote.status = "idle";
    sourceRemote.lastTurnId = "turn_1";
    sourceRemote.lastTurnStatus = "completed";

    await controller.onMessage(message("/fork"));

    const context = store.getUserContext("chat_id:c1");
    const forkedSessionId = context?.currentSessionId;
    expect(forkedSessionId).toBeDefined();
    expect(forkedSessionId).not.toBe(sourceSessionId);
    expect(context?.previousSessionId).toBe(sourceSessionId);
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: forkedSessionId,
      remoteSessionId: "thr_1",
      lastTurnId: "turn_1",
      title: "build the source task（分支 1）",
      cwd: store.getSession(sourceSessionId!)?.cwd,
    }));
    expect(store.getSession(forkedSessionId!)).toMatchObject({
      contextKey: "chat_id:c1",
      remoteSessionId: "thr_1_fork",
      title: "build the source task（分支 1）",
      status: "ready",
      lastTurnId: "turn_1",
      lastTurnStatus: "completed",
    });
    expect(presenter.registerSession).toHaveBeenLastCalledWith(
      forkedSessionId,
      "chat_id:c1",
      "build the source task（分支 1）",
      store.getSession(sourceSessionId!)?.cwd,
      "Codex",
    );
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "已从当前任务创建分支并切换到新任务：build the source task（分支 1）（thr_1_fork）",
    );
    expect((await controller.controlListTaskTurns(forkedSessionId!)).turns).toEqual([
      expect.objectContaining({ turnId: "turn_1", prompt: "build the source task", current: true }),
    ]);

    store.getOrCreateUserContext("chat_id:switched", "codex");
    store.attachSessionToContext("chat_id:switched", forkedSessionId!);
    store.setCurrentSession("chat_id:switched", forkedSessionId!);
    await controller.onMessage({
      messageId: "fork-turns-after-switch",
      contextKey: "chat_id:switched",
      text: "/turns",
    });
    const turnsCard = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(turnsCard)).toContain("build the source task");

    store.updateRuntimeSession(forkedSessionId!, {
      lastTurnId: "turn_failed",
      lastTurnStatus: "failed",
    });
    const reset = await controller.controlResetTaskToTurn(forkedSessionId!, "turn_1");
    expect(runtime.forkSession).toHaveBeenLastCalledWith(expect.objectContaining({
      localSessionId: forkedSessionId,
      remoteSessionId: "thr_1",
      lastTurnId: "turn_1",
    }));
    expect(reset).toMatchObject({ lastTurnId: "turn_1", lastTurnStatus: "completed" });
  });

  test("forks the current task's latest completed turn into a new Feishu group", async () => {
    const { controller, runtime, sessions, remoteSessions, store, listeners, outbound, presenter } = fixture();
    await controller.onMessage(message("build the source task"));
    const sourceSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(sourceSessionId).toBeDefined();
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId!,
        turnId: "turn_1",
        finalResponse: "source complete",
      });
    }
    const sourceRuntimeSession = sessions.get(sourceSessionId!);
    if (sourceRuntimeSession) sourceRuntimeSession.activeTurnId = undefined;
    const sourceRemote = remoteSessions.find((session) => session.id === "thr_1")!;
    sourceRemote.status = "idle";
    sourceRemote.lastTurnId = "turn_1";
    sourceRemote.lastTurnStatus = "completed";
    store.updateRuntimeSession(sourceSessionId!, {
      model: "gpt-next",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
    });

    await controller.onMessage({
      messageId: "fork-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/forkgroup 并行修复",
    });

    expect(outbound.createGroup).toHaveBeenCalledWith({
      name: "[codex] 并行修复",
      userOpenId: "ou_current_user",
      avatarPng: expect.any(Uint8Array),
    });
    const groupSessionId = store.getUserContext("chat_id:oc_new_group")?.currentSessionId;
    expect(groupSessionId).toBeDefined();
    expect(store.getUserContext("chat_id:c1")?.currentSessionId).toBe(sourceSessionId);
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: groupSessionId,
      remoteSessionId: "thr_1",
      lastTurnId: "turn_1",
      title: "并行修复",
      cwd: store.getSession(sourceSessionId!)?.cwd,
      model: "gpt-next",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
    }));
    expect(store.getSession(groupSessionId!)).toMatchObject({
      contextKey: "chat_id:oc_new_group",
      remoteSessionId: "thr_1_fork",
      title: "并行修复",
      status: "ready",
      lastTurnId: "turn_1",
      lastTurnStatus: "completed",
    });
    expect(presenter.registerSession).toHaveBeenLastCalledWith(
      groupSessionId,
      "chat_id:oc_new_group",
      "并行修复",
      store.getSession(sourceSessionId!)?.cwd,
      "Codex",
    );
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:oc_new_group",
      expect.stringMatching(
        /^已从当前任务最新轮次创建分支。\n当前任务：并行修复（thr_1_fork）\n当前 Project 目录：.+\n当前 Provider：openai\n当前模型：gpt-next\n思考强度：xhigh\n权限类型：执行前确认$/,
      ),
    );
    expect((outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls)
      .not.toContainEqual(["chat_id:oc_new_group", expect.anything()]);
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringMatching(/^已将当前任务 Fork 到飞书群：.+；新群当前任务为 并行修复（thr_1_fork）。$/),
    );

  });

  test("forkgroup uses the locally persisted completed Turn without reading a running task's full history", async () => {
    const { controller, runtime, sessions, remoteSessions, store, outbound } = fixture();
    await controller.onMessage(message("completed source work"));
    const sourceSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(sourceSessionId).toBeDefined();
    store.saveTurnSnapshot("turn_1", sourceSessionId!, {
      sessionId: sourceSessionId!,
      turnId: "turn_1",
      prompt: "completed source work",
      status: "completed",
      startedAt: 1,
      completedAt: 10,
    }, "chat_id:c1");

    sessions.get(sourceSessionId!)!.activeTurnId = "turn_running";
    Object.assign(remoteSessions.find((session) => session.id === "thr_1")!, {
      status: "active",
      lastTurnId: "turn_running",
      lastTurnStatus: "inProgress",
    });
    store.saveTurnSnapshot("turn_running", sourceSessionId!, {
      sessionId: sourceSessionId!,
      turnId: "turn_running",
      status: "running",
      startedAt: 20,
    }, "chat_id:c1");
    store.updateSession(sourceSessionId!, { status: "running" });
    store.updateRuntimeSession(sourceSessionId!, {
      lastTurnId: "turn_running",
      lastTurnStatus: "running",
    });
    vi.mocked(runtime.readRemoteSession!).mockRejectedValue(
      new Error("App Server request timed out: thread/read"),
    );
    const graphRead = vi.spyOn(store, "listTaskTurnGraph").mockImplementation(() => {
      throw new Error("Fork must not load the complete local graph");
    });
    const importHistory = vi.spyOn(store, "importCompletedTurnHistory");

    await controller.onMessage({
      messageId: "fork-running-group-with-local-history",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/forkgroup fix build",
    });

    expect(runtime.readRemoteSession).not.toHaveBeenCalled();
    expect(runtime.readRemoteForkSource).not.toHaveBeenCalled();
    expect(graphRead).not.toHaveBeenCalled();
    expect(importHistory).not.toHaveBeenCalled();
    expect(runtime.cancelTurn).not.toHaveBeenCalled();
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      remoteSessionId: "thr_1",
      lastTurnId: "turn_1",
      title: "fix build",
    }));
    expect(outbound.createGroup).toHaveBeenCalledOnce();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:oc_new_group",
      expect.stringContaining("已从当前任务最近已完成轮次创建分支。"),
    );
  });

  test("shows every inherited remote Turn in the new group's Turn card without local source snapshots", async () => {
    const { controller, runtime, remoteSessions, store, outbound } = fixture();
    const sourceSessionId = "source-without-turn-snapshot";
    const sourceRemoteSessionId = "thr_external";
    const sourceTurnId = "turn_external_3";
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({
      localSessionId: sourceSessionId,
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: process.cwd(),
      status: "ready",
    });
    store.updateRuntimeSession(sourceSessionId, {
      runtimeKind: "codex",
      remoteSessionId: sourceRemoteSessionId,
      title: "External source task",
      lastTurnId: sourceTurnId,
      lastTurnStatus: "completed",
    });
    store.setCurrentSession("chat_id:c1", sourceSessionId);
    remoteSessions.push({
      id: sourceRemoteSessionId,
      title: "External source task",
      preview: "Inspect the external task",
      cwd: process.cwd(),
      source: "codex-desktop",
      status: "idle",
      updatedAt: 1_777_000_000,
      lastTurnId: sourceTurnId,
      lastCompletedTurnId: sourceTurnId,
      lastTurnStatus: "completed",
      lastUserPrompt: "Inspect the external task",
      completedTurns: [
        { id: "turn_external_1", prompt: "Collect the evidence", startedAt: 1_000, completedAt: 2_000 },
        { id: "turn_external_2", prompt: "Compare the results", startedAt: 3_000, completedAt: 4_000 },
        { id: sourceTurnId, prompt: "Inspect the external task", startedAt: 5_000, completedAt: 6_000 },
      ],
    });
    expect(store.getTurnSnapshot(sourceTurnId)).toBeUndefined();

    await controller.onMessage({
      messageId: "fork-external-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/forkgroup External branch",
    });
    expect(runtime.readRemoteSession).not.toHaveBeenCalled();
    expect(runtime.readRemoteForkSource).not.toHaveBeenCalled();
    expect(store.getTurnSnapshot(sourceTurnId)).toBeUndefined();
    const forkedSessionId = store.getUserContext("chat_id:oc_new_group")?.currentSessionId;
    expect(store.getForkHistorySource(forkedSessionId!)).toMatchObject({
      sourceLocalSessionId: sourceSessionId,
      sourceRemoteSessionId,
      sourceTurnId,
      sourceTurnHistoryCount: undefined,
    });
    remoteSessions.find((session) => session.id === sourceRemoteSessionId)!.completedTurns!.push({
      id: "turn_external_after_fork", prompt: "Not inherited", startedAt: 7_000, completedAt: 8_000,
    });
    await controller.onMessage({
      messageId: "fork-external-group-turns",
      contextKey: "chat_id:oc_new_group",
      chatId: "oc_new_group",
      chatType: "group",
      text: "/turns",
    });

    const turnsCard = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(turnsCard);
    expect(serialized).toContain("Inspect the external task");
    expect(serialized).toContain("Compare the results");
    expect(serialized).toContain("Collect the evidence");
    expect(serialized).not.toContain("Not inherited");
    expect(serialized).not.toContain("当前任务还没有成功完成的 turn");
    expect(runtime.readRemoteSession).not.toHaveBeenCalled();
    expect(runtime.listRemoteTurnSummaries).toHaveBeenCalledExactlyOnceWith(sourceRemoteSessionId, {
      cursor: undefined, limit: 10,
    });
    expect(store.listTaskTurnGraph(forkedSessionId!).map((turn) => turn.turnId)).toEqual([
      "turn_external_3",
      "turn_external_2",
      "turn_external_1",
    ]);
    const turns = await controller.controlListTaskTurns(forkedSessionId!);
    expect(turns.turns.map((turn) => turn.turnId)).toEqual([
      "turn_external_3", "turn_external_2", "turn_external_1",
    ]);
    expect(runtime.listRemoteTurnSummaries).toHaveBeenCalledTimes(1);
  });

  test.each([undefined, 0, 1])("hydrates legacy Fork history with an unverified import count of %s", async (sourceTurnHistoryCount) => {
    const { controller, runtime, remoteSessions, store, outbound } = fixture();
    store.createSession({
      localSessionId: "legacy_source",
      contextKey: "chat_id:legacy_source",
      agentName: "codex",
      cwd: process.cwd(),
      status: "ready",
    });
    store.updateRuntimeSession("legacy_source", {
      runtimeKind: "codex",
      remoteSessionId: "thread_legacy_source",
      lastTurnId: "legacy_turn_3",
      lastTurnStatus: "completed",
    });
    store.getOrCreateUserContext("chat_id:legacy_fork", "codex");
    store.createSession({
      localSessionId: "legacy_fork",
      contextKey: "chat_id:legacy_fork",
      agentName: "codex",
      cwd: process.cwd(),
      status: "ready",
    });
    store.updateRuntimeSession("legacy_fork", {
      runtimeKind: "codex",
      remoteSessionId: "thread_legacy_fork",
      lastTurnId: "legacy_turn_3",
      lastTurnStatus: "completed",
    });
    store.setCurrentSession("chat_id:legacy_fork", "legacy_fork");
    store.audit("chat_id:legacy_fork", "session_forked", {
      sourceLocalSessionId: "legacy_source",
      sourceRemoteSessionId: "thread_legacy_source",
      sourceTurnId: "legacy_turn_3",
      sourceTurnHistoryCount,
      forkedLocalSessionId: "legacy_fork",
      forkedRemoteSessionId: "thread_legacy_fork",
    });
    remoteSessions.push({
      id: "thread_legacy_source",
      cwd: process.cwd(),
      source: "codex-desktop",
      status: "idle",
      lastTurnId: "legacy_turn_3",
      lastCompletedTurnId: "legacy_turn_3",
      lastTurnStatus: "completed",
      completedTurns: [
        { id: "legacy_turn_1", prompt: "Legacy first", startedAt: 1_000, completedAt: 2_000 },
        { id: "legacy_turn_2", prompt: "Legacy second", startedAt: 3_000, completedAt: 4_000 },
        { id: "legacy_turn_3", prompt: "Legacy third", startedAt: 5_000, completedAt: 6_000 },
      ],
    });

    await controller.onMessage({
      messageId: "legacy-fork-turns",
      contextKey: "chat_id:legacy_fork",
      chatId: "legacy_fork",
      chatType: "group",
      text: "/turns",
    });

    expect(runtime.listRemoteTurnSummaries).toHaveBeenCalledWith("thread_legacy_source", { cursor: undefined, limit: 10 });
    expect(store.hasImportedForkTurnHistory("legacy_fork")).toBe(true);
    expect(store.listTaskTurnGraph("legacy_fork").map((turn) => turn.turnId)).toEqual([
      "legacy_turn_3",
      "legacy_turn_2",
      "legacy_turn_1",
    ]);
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("Legacy first");
    expect(serialized).toContain("Legacy second");
    expect(serialized).toContain("Legacy third");

    vi.mocked(runtime.listRemoteTurnSummaries!).mockClear();
    await controller.onMessage({
      messageId: "legacy-fork-turns-again",
      contextKey: "chat_id:legacy_fork",
      chatId: "legacy_fork",
      chatType: "group",
      text: "/turns",
    });
    expect(runtime.readRemoteSession).not.toHaveBeenCalled();
    expect(runtime.listRemoteTurnSummaries).not.toHaveBeenCalled();
  });

  test("defers history through consecutive empty Forks and reuses the original source when opening Turns", async () => {
    const { controller, runtime, remoteSessions, store, outbound } = fixture();
    remoteSessions.push({
      id: "desktop_root", title: "Desktop root", cwd: process.cwd(), source: "codex-desktop",
      status: "idle", lastTurnId: "root_2", lastTurnStatus: "completed",
      completedTurns: [
        { id: "root_1", prompt: "First root turn", startedAt: 1, completedAt: 2 },
        { id: "root_2", prompt: "Second root turn", startedAt: 3, completedAt: 4 },
      ],
    });
    await controller.onMessage(message("/fork desktop_root"));
    const first = store.getUserContext("chat_id:c1")!.currentSessionId!;
    expect(store.getTurnSnapshot("root_2")).toBeUndefined();
    // The next Fork can use provenance even when the intermediate task's first turn failed.
    store.updateRuntimeSession(first, { lastTurnId: "failed_first_turn", lastTurnStatus: "failed" });
    const graphRead = vi.spyOn(store, "listTaskTurnGraph");
    const importHistory = vi.spyOn(store, "importCompletedTurnHistory");
    await controller.onMessage({
      ...message("/forkgroup Nested branch"), chatId: "c1", chatType: "p2p", userId: "ou_current_user",
    });
    const second = store.getUserContext("chat_id:oc_new_group")!.currentSessionId!;
    expect(runtime.forkSession).toHaveBeenLastCalledWith(expect.objectContaining({
      remoteSessionId: "desktop_root_fork", lastTurnId: "root_2",
    }));
    expect(runtime.readRemoteForkSource).toHaveBeenCalledExactlyOnceWith("desktop_root");
    expect(runtime.readRemoteSession).not.toHaveBeenCalled();
    expect(graphRead).not.toHaveBeenCalled();
    expect(importHistory).not.toHaveBeenCalled();
    expect(store.getForkHistorySource(second)?.sourceLocalSessionId).toBe(first);

    await controller.onMessage(groupMessage("oc_new_group", "/turns"));
    expect(runtime.listRemoteTurnSummaries).toHaveBeenCalledExactlyOnceWith("desktop_root", { cursor: undefined, limit: 10 });
    expect(store.hasImportedForkTurnHistory(first)).toBe(true);
    expect(store.hasImportedForkTurnHistory(second)).toBe(true);
    expect(store.listTaskTurnGraph(second).map((turn) => turn.turnId)).toEqual(["root_2", "root_1"]);
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("First root turn");
    expect(JSON.stringify(card)).toContain("Second root turn");
    await controller.onMessage({ ...groupMessage("oc_new_group", "/turns"), messageId: "nested-turns-again" });
    expect(runtime.readRemoteSession).not.toHaveBeenCalled();
    expect(runtime.listRemoteTurnSummaries).toHaveBeenCalledTimes(1);
  });

  test.each(["failure", "missing-anchor"])("retries deferred history after %s without marking a partial import complete", async (failure) => {
    const { controller, runtime, remoteSessions, store, outbound } = fixture();
    remoteSessions.push({
      id: "retry_source", title: "Retry source", cwd: process.cwd(), source: "codex-desktop",
      status: "idle", lastTurnId: "retry_2", lastTurnStatus: "completed",
      completedTurns: [
        { id: "retry_1", prompt: "Retry first turn", startedAt: 1, completedAt: 2 },
        { id: "retry_2", prompt: "Retry second turn", startedAt: 3, completedAt: 4 },
      ],
    });
    await controller.onMessage(message("/fork retry_source"));
    const forkedId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    store.saveTurnSnapshot("retry_2", forkedId, {
      sessionId: forkedId, turnId: "retry_2", status: "completed",
      prompt: "Retry second turn", startedAt: 3, completedAt: 4,
    }, "chat_id:c1");
    const readRemote = vi.mocked(runtime.listRemoteTurnSummaries!);
    if (failure === "failure") readRemote.mockRejectedValueOnce(new Error("Connection closed"));
    else readRemote.mockResolvedValueOnce({
      turns: [
        { id: "retry_1", prompt: "Retry first turn", startedAt: 1, completedAt: 2 },
      ],
    });
    await controller.onMessage(message("/turns"));
    expect(store.hasImportedForkTurnHistory(forkedId)).toBe(false);
    expect(store.getTurnSnapshot("retry_1")).toBeUndefined();
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("Retry second turn");

    const turns = await controller.controlListTaskTurns(forkedId);
    expect(turns.turns.map((turn) => turn.turnId)).toEqual(["retry_2", "retry_1"]);
    expect(store.hasImportedForkTurnHistory(forkedId)).toBe(true);
    expect(readRemote.mock.calls.filter(([id]) => id === "retry_source")).toHaveLength(2);
  });

  test("coalesces concurrent on-demand history reads", async () => {
    const { controller, runtime, remoteSessions, store } = fixture();
    const remote: RemoteSessionSummary = {
      id: "concurrent_source", title: "Concurrent source", cwd: process.cwd(), source: "codex-desktop",
      status: "idle", lastTurnId: "concurrent_1", lastTurnStatus: "completed",
      completedTurns: [{ id: "concurrent_1", prompt: "Concurrent first turn", startedAt: 1, completedAt: 2 }],
    };
    remoteSessions.push(remote);
    await controller.onMessage(message("/fork concurrent_source"));
    const forkedId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    let resolveRead!: (value: RemoteTurnPage) => void;
    vi.mocked(runtime.listRemoteTurnSummaries!).mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve; }));
    const first = controller.controlListTaskTurns(forkedId);
    const second = controller.controlListTaskTurns(forkedId);
    expect(runtime.listRemoteTurnSummaries).toHaveBeenCalledOnce();
    resolveRead({ turns: remote.completedTurns! });
    expect((await first).turns).toEqual((await second).turns);
    expect(runtime.listRemoteTurnSummaries).toHaveBeenCalledOnce();
  });

  test.each([false, true])("loads only the requested Fork page with sparse local source history: %s", async (sparseLocalSource) => {
    const { controller, runtime, remoteSessions, store, outbound } = fixture();
    remoteSessions.push({
      id: "large_source", title: "Large source", cwd: process.cwd(), source: "codex-desktop",
      status: "idle", lastTurnId: "large_40", lastTurnStatus: "completed",
      completedTurns: Array.from({ length: 40 }, (_, index) => ({
        id: `large_${index + 1}`, prompt: `Large prompt ${index + 1}`,
        startedAt: index * 10, completedAt: index * 10 + 1,
      })),
    });
    if (sparseLocalSource) {
      store.createSession({
        localSessionId: "sparse_source", contextKey: "chat_id:c1", agentName: "codex", cwd: process.cwd(), status: "ready",
      });
      store.updateRuntimeSession("sparse_source", {
        runtimeKind: "codex", remoteSessionId: "large_source", lastTurnId: "large_40", lastTurnStatus: "completed",
      });
      for (const index of [1, 40]) {
        store.saveTurnSnapshot(`large_${index}`, "sparse_source", {
          sessionId: "sparse_source", turnId: `large_${index}`, status: "completed",
          prompt: `Large prompt ${index}`, startedAt: (index - 1) * 10, completedAt: (index - 1) * 10 + 1,
        }, "chat_id:c1");
      }
      store.saveTurnParent("large_40", "sparse_source", "large_1");
    }
    await controller.onMessage(message("/fork large_source"));
    const forkedId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    expect(runtime.listRemoteTurnSummaries).not.toHaveBeenCalled();
    await controller.onMessage(message("/turns"));
    expect(runtime.readRemoteSession).not.toHaveBeenCalled();
    expect(runtime.listRemoteTurnSummaries).toHaveBeenCalledExactlyOnceWith("large_source", {
      cursor: undefined, limit: 10,
    });
    expect(store.listTaskTurnGraph(forkedId).slice(0, 10).map((turn) => turn.turnId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `large_${40 - index}`),
    );
    expect(store.getTurnSnapshot("large_30")).toBeUndefined();
    expect(store.hasImportedForkTurnHistory(forkedId)).toBe(false);
    const firstCard = vi.mocked(outbound.sendInteractiveCard).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(firstCard)).toContain("Large prompt 40");
    expect(JSON.stringify(firstCard)).toContain("Large prompt 31");
    expect(JSON.stringify(firstCard)).toContain("<font color='blue'>Next</font>");
    await controller.onMessage({ ...message("/turns"), messageId: "large-turns-again" });
    expect(runtime.listRemoteTurnSummaries).toHaveBeenCalledTimes(1);

    await controller.onCardAction({
      actionId: "load-fork-page-2", contextKey: "chat_id:c1", messageId: "om_fork_turns",
      value: { action: "turn_reset_page", sessionId: forkedId, contextKey: "chat_id:c1", page: "1" },
    });
    expect(runtime.listRemoteTurnSummaries).toHaveBeenLastCalledWith("large_source", { cursor: "10", limit: 10 });
    expect(store.listTaskTurnGraph(forkedId).slice(0, 20).map((turn) => turn.turnId)).toEqual(
      Array.from({ length: 20 }, (_, index) => `large_${40 - index}`),
    );
    expect(store.getTurnSnapshot("large_20")).toBeUndefined();
    const secondCard = vi.mocked(outbound.updateInteractiveCard).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(secondCard)).toContain("Large prompt 30");
    expect(JSON.stringify(secondCard)).toContain("Large prompt 21");
    expect(store.getTurnParent("large_31", sparseLocalSource ? "sparse_source" : forkedId)).toBe("large_30");

    await controller.onMessage({ ...message("/turns"), messageId: "large-return-first-page" });
    expect(runtime.listRemoteTurnSummaries).toHaveBeenCalledTimes(2);
    await controller.onCardAction({
      actionId: "load-fork-last-page", contextKey: "chat_id:c1", messageId: "om_fork_turns",
      value: { action: "turn_reset_page", sessionId: forkedId, contextKey: "chat_id:c1", page: "3" },
    });
    expect(runtime.listRemoteTurnSummaries).toHaveBeenCalledTimes(4);
    expect(store.hasImportedForkTurnHistory(forkedId)).toBe(true);
    const lastCard = vi.mocked(outbound.updateInteractiveCard).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(lastCard)).toContain("Large prompt 10");
    expect(JSON.stringify(lastCard)).not.toContain("<font color='blue'>Next</font>");
  });

  test("does not fetch remote history when the local source already satisfies the requested page", async () => {
    const { controller, runtime, store } = fixture();
    await controller.onMessage(message("/new Cached source"));
    const sourceId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    for (let index = 1; index <= 12; index += 1) {
      store.saveTurnSnapshot(`cached_${index}`, sourceId, {
        sessionId: sourceId, turnId: `cached_${index}`, status: "completed", prompt: `Cached ${index}`,
        startedAt: index, completedAt: index,
      }, "chat_id:c1");
    }
    store.updateRuntimeSession(sourceId, { lastTurnId: "cached_12", lastTurnStatus: "completed" });
    await controller.onMessage(message("/fork"));
    await controller.onMessage(message("/turns"));
    expect(runtime.readRemoteSession).not.toHaveBeenCalled();
    expect(runtime.listRemoteTurnSummaries).not.toHaveBeenCalled();
  });

  test("never falls back to full history when summary pagination is unavailable", async () => {
    const { controller, runtime, remoteSessions, store } = fixture();
    remoteSessions.push({
      id: "old_server", cwd: process.cwd(), source: "app-server", status: "idle",
      lastTurnId: "old_turn", lastTurnStatus: "completed",
    });
    await controller.onMessage(message("/fork old_server"));
    vi.mocked(runtime.listRemoteTurnSummaries!).mockRejectedValue(new Error("Unknown method thread/turns/list"));
    await controller.onMessage(message("/turns"));
    expect(runtime.readRemoteSession).not.toHaveBeenCalled();
    expect(store.hasImportedForkTurnHistory(store.getUserContext("chat_id:c1")!.currentSessionId!)).toBe(false);
  });

  test("loads missing Desktop continuations from the branch without reloading its completed source history", async () => {
    const { controller, runtime, remoteSessions, store, outbound } = fixture();
    const inherited = [
      { id: "before_fork", prompt: "Original work", startedAt: 1, completedAt: 2 },
    ];
    remoteSessions.push({
      id: "desktop_continue_source", cwd: process.cwd(), source: "codex-desktop", status: "idle",
      lastTurnId: "before_fork", lastTurnStatus: "completed", completedTurns: inherited,
    });
    await controller.onMessage(message("/fork desktop_continue_source"));
    const forkedId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    await controller.onMessage(message("/turns"));
    expect(store.hasImportedForkTurnHistory(forkedId)).toBe(true);
    const child = remoteSessions.find((session) => session.id === "desktop_continue_source_fork")!;
    child.completedTurns = [...inherited, ...Array.from({ length: 15 }, (_, index) => ({
      id: `desktop_${index + 1}`, prompt: `Desktop work ${index + 1}`,
      startedAt: 10 + index * 2, completedAt: 11 + index * 2,
    }))];
    store.updateRuntimeSession(forkedId, { lastTurnId: "desktop_15", lastTurnStatus: "completed" });
    vi.mocked(runtime.listRemoteTurnSummaries!).mockClear();

    await controller.onMessage({ ...message("/turns"), messageId: "turns-after-desktop-work" });
    expect(runtime.listRemoteTurnSummaries).toHaveBeenCalledExactlyOnceWith(child.id, { cursor: undefined, limit: 10 });
    expect(store.getTurnSnapshot("desktop_6")).toBeDefined();
    expect(store.getTurnSnapshot("desktop_5")).toBeUndefined();
    const card = vi.mocked(outbound.sendInteractiveCard).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("Desktop work 15");
    await controller.onCardAction({
      actionId: "desktop-next", contextKey: "chat_id:c1", messageId: "om_desktop_turns",
      value: { action: "turn_reset_page", sessionId: forkedId, contextKey: "chat_id:c1", page: "1" },
    });
    expect(runtime.listRemoteTurnSummaries).toHaveBeenLastCalledWith(child.id, { cursor: "10", limit: 10 });
    expect(store.getTurnSnapshot("desktop_1")).toBeDefined();
    expect(runtime.readRemoteSession).not.toHaveBeenCalled();
  });

  test("uses the same generated branch title for forkgroup as fork", async () => {
    const { controller, runtime, sessions, remoteSessions, store, listeners, outbound } = fixture();
    await controller.onMessage(message("build the source task"));
    const sourceSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(sourceSessionId).toBeDefined();
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId!,
        turnId: "turn_1",
        finalResponse: "source complete",
      });
    }
    const sourceRuntimeSession = sessions.get(sourceSessionId!);
    if (sourceRuntimeSession) sourceRuntimeSession.activeTurnId = undefined;
    const sourceRemote = remoteSessions.find((session) => session.id === "thr_1")!;
    sourceRemote.status = "idle";
    sourceRemote.lastTurnId = "turn_1";
    sourceRemote.lastTurnStatus = "completed";

    await controller.onMessage({
      messageId: "fork-group-default-title",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/forkgroup",
    });

    expect(outbound.createGroup).toHaveBeenCalledWith({
      name: "[codex] build the source task（分支 1）",
      userOpenId: "ou_current_user",
      avatarPng: expect.any(Uint8Array),
    });
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      title: "build the source task（分支 1）",
    }));
  });

  test("truncates a long generated forkgroup name without changing the fork task title", async () => {
    const { controller, runtime, sessions, remoteSessions, store, listeners, outbound } = fixture();
    const longSourceTitle = "修复一个特别长的源任务标题用于验证 forkgroup 群名不会超过飞书限制".repeat(2);
    await controller.onMessage(message(longSourceTitle));
    const sourceSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(sourceSessionId).toBeDefined();
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId!,
        turnId: "turn_1",
        finalResponse: "source complete",
      });
    }
    const sourceRuntimeSession = sessions.get(sourceSessionId!);
    if (sourceRuntimeSession) sourceRuntimeSession.activeTurnId = undefined;
    const sourceRemote = remoteSessions.find((session) => session.id === "thr_1")!;
    sourceRemote.status = "idle";
    sourceRemote.lastTurnId = "turn_1";
    sourceRemote.lastTurnStatus = "completed";

    await controller.onMessage({
      messageId: "fork-group-long-name",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/forkgroup",
    });

    const groupInput = (outbound.createGroup as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(Array.from(groupInput.name)).toHaveLength(60);
    expect(groupInput.name).not.toMatch(/ \(\d{2}-\d{2}\)$/);
    expect(groupInput.name).toContain("...");
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      title: `${longSourceTitle}（分支 1）`,
    }));
  });

  test("does not create a group when the current task has no completed turn to fork", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("long-running source"));

    await controller.onMessage({
      messageId: "fork-group-too-early",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/forkgroup",
    });

    expect(outbound.createGroup).not.toHaveBeenCalled();
    expect(runtime.forkSession).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("还没有已完成轮次"),
    );
  });

  test("forks an external Codex task by task ID without switching to it first", async () => {
    const { controller, runtime, remoteSessions, store, outbound } = fixture();
    remoteSessions.push({
      id: "external_fork_source",
      title: "External fork source",
      cwd: "D:\\work\\external-source",
      source: "cli",
      status: "idle",
      lastTurnId: "turn_external_done",
      lastTurnStatus: "completed",
    });

    await controller.onMessage(message("/fork external_fork_source"));

    const forkedSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(runtime.readRemoteForkSource).toHaveBeenCalledWith("external_fork_source");
    expect(runtime.readRemoteSession).not.toHaveBeenCalled();
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: forkedSessionId,
      remoteSessionId: "external_fork_source",
      lastTurnId: "turn_external_done",
      title: "External fork source（分支 1）",
      cwd: "D:\\work\\external-source",
    }));
    expect(store.getSession(forkedSessionId!)).toMatchObject({
      remoteSessionId: "external_fork_source_fork",
      title: "External fork source（分支 1）",
      status: "ready",
    });
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "已从指定任务创建分支并切换到新任务：External fork source（分支 1）（external_fork_source_fork）",
    );
  });

  test("reports an unmaterialized external task as having no completed Turn to fork", async () => {
    const { controller, runtime, remoteSessions, outbound } = fixture();
    remoteSessions.push({
      id: "empty_external_task",
      title: "Empty external task",
      cwd: "D:\\work\\empty-external",
      source: "app-server",
      status: "not_loaded",
      completedTurns: [],
    });

    await controller.onMessage(message("/fork empty_external_task"));

    expect(runtime.forkSession).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "指定任务还没有可供 fork 的轮次。请先完成至少一轮对话。",
    );
  });

  test("resolves a fork source by its latest sessions-list sequence number", async () => {
    const { controller, runtime, remoteSessions, store } = fixture();
    remoteSessions.push(
      {
        id: "fork_list_first",
        title: "First fork candidate",
        cwd: "D:\\work\\first",
        source: "cli",
        status: "idle",
        lastTurnId: "turn_first",
        lastTurnStatus: "completed",
      },
      {
        id: "fork_list_second",
        title: "Second fork candidate",
        cwd: "D:\\work\\second",
        source: "desktop",
        status: "idle",
        lastTurnId: "turn_second",
        lastTurnStatus: "completed",
      },
    );
    await controller.onMessage(message("/sessions"));

    await controller.onMessage(message("/fork 2"));

    const forkedSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: forkedSessionId,
      remoteSessionId: "fork_list_second",
      lastTurnId: "turn_second",
      title: "Second fork candidate（分支 1）",
      cwd: "D:\\work\\second",
    }));
  });

  test("refuses to fork a running task that has no completed turn yet", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("long-running source"));

    await controller.onMessage(message("/fork"));

    expect(runtime.forkSession).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("还没有已完成轮次"),
    );
  });

  test("new always uses the current default agent and accepts cwd through --dir", async () => {
    const { controller, runtime, store } = fixture();
    const cwd = path.resolve("test-workspaces", "work space", "repo");
    await controller.onMessage(message("/agent acp"));
    await controller.onMessage(message(`/new --dir "${cwd}"`));

    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "acp",
      cwd,
    }));
    expect(store.listSessions("chat_id:c1").at(-1)).toMatchObject({
      agentName: "acp",
      cwd,
    });
  });

  test("rejects --nodir when the current default agent is not App Server", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("/agent acp"));

    await controller.onMessage(message("/new --nodir"));

    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "/new --nodir 仅支持 App Server Agent。",
    );
  });

  test("expands the user home shorthand for new task directories", async () => {
    const { controller, runtime, store } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-new-home-"));
    const selectedProject = path.join(home, "work", "demo");
    fs.mkdirSync(selectedProject, { recursive: true });
    tempDirs.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);

    await controller.onMessage(message("/new Home project --dir ~/work/demo"));

    expect(runtime.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      cwd: selectedProject,
      title: "Home project",
    }));
    expect(store.listSessions("chat_id:c1").at(-1)).toMatchObject({
      cwd: selectedProject,
      title: "Home project",
    });
  });

  test("creates a task with an explicit title and synchronizes it with the runtime", async () => {
    const { controller, runtime, store, presenter, outbound } = fixture();
    const cwd = path.resolve("test-workspaces", "work");

    await controller.onMessage(message(`/new 修复会话列表时间 --dir "${cwd}"`));

    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      title: "修复会话列表时间",
      cwd,
    }));
    const session = store.listSessions("chat_id:c1")[0]!;
    expect(session.title).toBe("修复会话列表时间");
    expect(presenter.registerSession).toHaveBeenCalledWith(
      session.localSessionId,
      "chat_id:c1",
      "修复会话列表时间",
      cwd,
      "Codex",
    );
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("修复会话列表时间"),
    );
  });

  test("creates a Feishu group with a bound task without sending a sessions card", async () => {
    const { controller, runtime, store, outbound, presenter } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-newgroup-home-"));
    tempDirs.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);

    await controller.onMessage({
      messageId: "new-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup 广州天气",
    });

    expect(outbound.createGroup).toHaveBeenCalledWith({
      name: "[codex] 广州天气",
      userOpenId: "ou_current_user",
      avatarPng: expect.any(Uint8Array),
    });
    const groupContext = store.getUserContext("chat_id:oc_new_group");
    const groupSessions = store.listSessions("chat_id:oc_new_group");
    expect(groupSessions).toHaveLength(1);
    expect(groupContext).toMatchObject({
      defaultAgent: "codex",
      currentSessionId: groupSessions[0]!.localSessionId,
    });
    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: groupSessions[0]!.localSessionId,
      title: "广州天气",
      model: undefined,
      reasoningEffort: undefined,
      permissionMode: "auto",
    }));
    expect(presenter.registerSession).toHaveBeenCalledWith(
      groupSessions[0]!.localSessionId,
      "chat_id:oc_new_group",
      "广州天气",
      expect.any(String),
      "Codex",
    );
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:oc_new_group",
      "群和新任务已创建。\n当前任务：广州天气（thr_1）\n当前 Project 目录：未绑定（Projectless）\n当前 Provider：openai\n当前模型：gpt-test\n思考强度：high\n权限类型：自动执行",
    );
    expect(outbound.sendInteractiveCard).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringMatching(
        /^已创建飞书群：\[codex\] 广州天气，并创建新任务 广州天气（thr_1）。$/,
      ),
    );
    expect(store.getUserContext("chat_id:c1")?.currentSessionId).toBeUndefined();
  });

  test("binds a new group task to the source project and reuses it for the first prompt", async () => {
    const { controller, runtime, store, outbound } = fixture();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-source-project-"));
    tempDirs.push(project);
    await controller.onMessage(message(`/new --dir "${project}"`));

    await controller.onMessage({
      messageId: "new-project-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup Project room",
    });

    const groupContext = store.getUserContext("chat_id:oc_new_group");
    expect(groupContext).toMatchObject({
      currentSessionId: expect.any(String),
      boundProjectCwd: project,
    });
    expect((outbound.createGroup as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]?.avatarPng)
      .toEqual(generateGroupAvatarPng(resolveGroupAvatarProjectName(project, "Project room"), project));
    expect(runtime.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      cwd: project,
      title: "Project room",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "auto",
    }));
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:oc_new_group",
      `群和新任务已创建。\n当前任务：Project room（thr_2）\n当前 Project 目录：${project}\n当前 Provider：openai\n当前模型：gpt-test\n思考强度：high\n权限类型：自动执行`,
    );

    const createCount = (runtime.createSession as ReturnType<typeof vi.fn>).mock.calls.length;
    await controller.onMessage(groupMessage("oc_new_group", "inspect this project"));

    expect(runtime.createSession).toHaveBeenCalledTimes(createCount);
    expect(runtime.startTurn).toHaveBeenCalledWith(
      groupContext!.currentSessionId,
      "inspect this project",
    );
  });

  test("lets newgroup select a project directory and expands the user home shorthand", async () => {
    const { controller, runtime, store, outbound } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-newgroup-home-"));
    const sourceProject = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-source-project-"));
    const selectedProject = path.join(home, "work", "demo");
    fs.mkdirSync(selectedProject, { recursive: true });
    tempDirs.push(home, sourceProject);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    await controller.onMessage(message(`/new --dir "${sourceProject}"`));

    await controller.onMessage({
      messageId: "new-group-explicit-home-project",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup Home project --dir ~/work/demo",
    });

    expect(store.getUserContext("chat_id:oc_new_group")).toMatchObject({
      boundProjectCwd: selectedProject,
      currentSessionId: expect.any(String),
    });
    expect(runtime.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      cwd: selectedProject,
      title: "Home project",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "auto",
    }));
    expect(outbound.createGroup).toHaveBeenLastCalledWith({
      name: `[codex] [work${path.sep}demo] Home project`,
      userOpenId: "ou_current_user",
      avatarPng: expect.any(Uint8Array),
    });
  });

  test("lets newgroup force a Projectless task without inheriting the source project", async () => {
    const { controller, runtime, store, outbound } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-newgroup-home-"));
    const sourceProject = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-source-project-"));
    tempDirs.push(home, sourceProject);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    await controller.onMessage(message(`/new Source --dir "${sourceProject}"`));

    await controller.onMessage({
      messageId: "new-projectless-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup Projectless room --nodir",
    });

    const groupContext = store.getUserContext("chat_id:oc_new_group");
    const groupSession = store.getSession(groupContext!.currentSessionId!)!;
    expect(groupContext?.boundProjectCwd).toBeUndefined();
    expect(groupSession.cwd.startsWith(path.join(home, "Documents", "Codex"))).toBe(true);
    expect(runtime.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      cwd: groupSession.cwd,
      title: "Projectless room",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "auto",
    }));
    expect(outbound.createGroup).toHaveBeenLastCalledWith({
      name: "[codex] Projectless room",
      userOpenId: "ou_current_user",
      avatarPng: expect.any(Uint8Array),
    });
  });

  test("rejects newgroup --nodir when the current default agent is not App Server", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("/agent acp"));

    await controller.onMessage({
      messageId: "new-projectless-acp-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup --nodir",
    });

    expect(outbound.createGroup).not.toHaveBeenCalled();
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "/newgroup --nodir 仅支持 App Server Agent。",
    );
  });

  test("inherits Provider, model, reasoning effort, and permission mode from the source task", async () => {
    const { controller, runtime, store } = fixture();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-source-project-"));
    tempDirs.push(project);
    await controller.onMessage(message(`/new --dir "${project}"`));
    const sourceSessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    const source = store.getSession(sourceSessionId)!;
    store.updateRuntimeSession(source.localSessionId, {
      modelProvider: "azure",
      model: "gpt-next",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
    });

    await controller.onMessage({
      messageId: "new-inherited-settings-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup Inherited settings",
    });

    expect(runtime.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      cwd: project,
      title: "Inherited settings",
      modelProvider: "azure",
      model: "gpt-next",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
    }));
    const groupSessionId = store.getUserContext("chat_id:oc_new_group")!.currentSessionId!;
    expect(store.getSession(groupSessionId)).toMatchObject({
      cwd: project,
      title: "Inherited settings",
      modelProvider: "azure",
      model: "gpt-next",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
    });
  });

  test("inherits the complete execution settings group for /new", async () => {
    const { controller, runtime, store } = fixture();
    await controller.onMessage(message("/new Source"));
    const sourceSessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    store.updateRuntimeSession(sourceSessionId, {
      modelProvider: "azure",
      model: "gpt-next",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
    });

    await controller.onMessage(message("/new Inherited"));

    expect(runtime.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      title: "Inherited",
      modelProvider: "azure",
      model: "gpt-next",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
    }));
  });

  test("lets an explicit directory override a new group's bound project", async () => {
    const { controller, runtime } = fixture();
    const sourceProject = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-source-project-"));
    const explicitProject = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-explicit-project-"));
    tempDirs.push(sourceProject, explicitProject);
    await controller.onMessage(message(`/new --dir "${sourceProject}"`));
    await controller.onMessage({
      messageId: "new-project-group-override",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup Override room",
    });

    await controller.onMessage(groupMessage("oc_new_group", `/new --dir "${explicitProject}"`));

    expect(runtime.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      cwd: explicitProject,
    }));
  });

  test("uses the local mm-dd date when newgroup omits the title", async () => {
    const { controller, runtime, outbound } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-newgroup-home-"));
    tempDirs.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);

    await controller.onMessage({
      messageId: "new-group-default-title",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup",
    });

    const groupInput = (outbound.createGroup as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(groupInput.name).toMatch(
      /^\[codex\] 新任务 \(\d{2}-\d{2}\)$/,
    );
    const taskTitle = groupInput.name.replace(/^\[codex\] /, "");
    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      title: taskTitle,
      model: undefined,
      reasoningEffort: undefined,
      permissionMode: "auto",
    }));
  });

  test("uses the configured Projectless group name format", async () => {
    const { controller, outbound, config } = fixture();
    config.feishu.groupNameFormat = {
      project: "P-{agent}-{project}-{taskname}",
      projectless: "{os}-{agent}-{taskname}-{date:yyyy}",
      dateFormat: "MM-dd",
    };

    await controller.onMessage({
      messageId: "custom-projectless-group-name",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup Custom room --nodir",
    });

    expect((outbound.createGroup as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.name)
      .toBe(`${process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux"}-codex-Custom room-${new Date().getFullYear()}`);
  });

  test("reports a new task creation failure inside the already-created group", async () => {
    const { controller, runtime, outbound } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-newgroup-home-"));
    tempDirs.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    (runtime.createSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("thread/start failed"));

    await controller.onMessage({
      messageId: "new-group-task-failure",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup Broken task",
    });

    expect(outbound.createGroup).toHaveBeenCalledOnce();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:oc_new_group",
      "群已创建，但新任务创建失败：thread/start failed",
    );
    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", "thread/start failed");
  });

  test("uses a tilde for a project directory inside the user home directory", async () => {
    const { controller, outbound } = fixture();
    await controller.onMessage(message(`/new --dir "${os.homedir()}"`));

    await controller.onMessage({
      messageId: "new-home-project-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup Home project",
    });

    expect(outbound.createGroup).toHaveBeenCalledWith({
      name: "[codex] [~] Home project",
      userOpenId: "ou_current_user",
      avatarPng: expect.any(Uint8Array),
    });
  });

  test("keeps readable trailing directories in the generated group name", async () => {
    const { controller, outbound } = fixture();
    const project = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-long-project-")),
      "dev",
      "agent-bot",
    );
    fs.mkdirSync(project, { recursive: true });
    tempDirs.push(path.dirname(path.dirname(project)));
    await controller.onMessage(message(`/new --dir "${project}"`));

    await controller.onMessage({
      messageId: "new-long-project-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup",
    });

    const groupInput = (outbound.createGroup as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(groupInput.name).toMatch(/^\[codex\] \[[^\]]+\] 新任务 \(\d{2}-\d{2}\)$/);
    const projectDisplay = /^\[codex\] \[([^\]]+)\]/.exec(groupInput.name)?.[1];
    expect(projectDisplay).toBe(`dev${path.sep}agent-bot`);
  });

  test("falls back to the leaf directory when the trailing pair is too long for a group name", async () => {
    const { controller, outbound } = fixture();
    const project = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-long-project-")),
      "a-very-long-middle-directory-name",
      "project-tail",
    );
    fs.mkdirSync(project, { recursive: true });
    tempDirs.push(path.dirname(path.dirname(project)));
    await controller.onMessage(message(`/new --dir "${project}"`));

    await controller.onMessage({
      messageId: "new-long-leaf-project-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup",
    });

    const groupInput = (outbound.createGroup as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const projectDisplay = /^\[codex\] \[([^\]]+)\]/.exec(groupInput.name)?.[1];
    expect(projectDisplay).toBe("project-tail");
  });

  test("truncates the tail when the leaf directory is too long for a group name", async () => {
    const { controller, outbound } = fixture();
    const project = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-long-project-")),
      "dev",
      "a-very-long-project-tail",
    );
    fs.mkdirSync(project, { recursive: true });
    tempDirs.push(path.dirname(path.dirname(project)));
    await controller.onMessage(message(`/new --dir "${project}"`));

    await controller.onMessage({
      messageId: "new-overlong-leaf-project-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup",
    });

    const groupInput = (outbound.createGroup as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const projectDisplay = /^\[codex\] \[([^\]]+)\]/.exec(groupInput.name)?.[1];
    expect(projectDisplay).toBe("a-very-long-...");
    expect(Array.from(projectDisplay ?? "")).toHaveLength(15);
  });

  test("rejects newgroup when the message does not contain a Feishu open_id", async () => {
    const { controller, runtime, outbound } = fixture();

    await controller.onMessage(message("/newgroup 广州天气"));

    expect(outbound.createGroup).not.toHaveBeenCalled();
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("具有 open_id 的飞书用户"),
    );
  });

  test("opens the unified Agent tab without a current task and switches the default in place", async () => {
    const { controller, outbound, store } = fixture();

    await controller.onMessage({ messageId: "list-agents", contextKey: "chat_id:c1", text: "/agent" });

    expect(outbound.sendInteractiveCard).toHaveBeenCalledWith("chat_id:c1", expect.any(Object));
    let card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    let serialized = JSON.stringify(card);
    expect(serialized).toContain("运行设置");
    expect(serialized).toContain('"tag":"markdown","content":"Agent"');
    expect(serialized).toContain('"tag":"markdown","content":"`codex` · Codex"');
    expect(serialized).toContain('"tag":"markdown","content":"`acp` · ACP"');
    expect(serialized).not.toContain("`codex` · Codex · Codex");
    expect(serialized).not.toContain("`acp` · ACP · ACP");
    expect(serialized).toContain('"action":"settings_agent_select"');
    expect(serialized).not.toContain('"tab":"model"');
    expect(serialized).not.toContain('"sessionId"');

    await controller.onCardAction({
      actionId: "select-agent-acp",
      contextKey: "chat_id:c1",
      messageId: "om_agent",
      value: {
        action: "settings_agent_select",
        contextKey: "chat_id:c1",
        agent: "acp",
      },
    });

    expect(store.getUserContext("chat_id:c1")?.defaultAgent).toBe("acp");
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_agent", expect.any(Object));
    card = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    serialized = JSON.stringify(card);
    expect(serialized).toContain("默认 Agent 已切换为 `acp`，从下一次新建任务生效");
    expect(serialized).toContain("**默认 Agent**：`acp`");
    expect(serialized).toContain("✅ 当前");
  });

  test("creates a Desktop-compatible projectless workspace when a new Codex task omits cwd", async () => {
    const { controller, runtime } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-projectless-home-"));
    tempDirs.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);

    await controller.onMessage(message("/new"));

    const input = (runtime.createSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const projectlessRoot = path.join(home, "Documents", "Codex");
    const relativeCwd = path.relative(projectlessRoot, input.cwd);
    expect(relativeCwd).toMatch(/^\d{4}-\d{2}-\d{2}[\\/]new-chat$/);
    expect(input.cwd).not.toBe(projectlessRoot);
    expect(fs.statSync(input.cwd).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(input.cwd, "work")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(input.cwd, "outputs")).isDirectory()).toBe(true);
  });

  test("inherits the current project directory when new omits cwd", async () => {
    const { controller, runtime } = fixture();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-project-"));
    tempDirs.push(project);

    await controller.onMessage(message(`/new --dir "${project}"`));
    await controller.onMessage({ messageId: "new-in-project", contextKey: "chat_id:c1", text: "/new" });

    expect((runtime.createSession as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toMatchObject({
      cwd: project,
    });
  });

  test("forces a fresh projectless workspace with /new --nodir from a project task", async () => {
    const { controller, runtime } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-projectless-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-project-"));
    tempDirs.push(home, project);
    vi.spyOn(os, "homedir").mockReturnValue(home);

    await controller.onMessage(message(`/new --dir "${project}"`));
    await controller.onMessage({
      messageId: "new-forced-projectless",
      contextKey: "chat_id:c1",
      text: "/new Detached task --nodir",
    });

    const input = (runtime.createSession as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];
    const projectlessRoot = path.join(home, "Documents", "Codex");
    expect(path.relative(projectlessRoot, input.cwd)).toMatch(
      /^\d{4}-\d{2}-\d{2}[\\/]detached-task$/,
    );
    expect(input.cwd).not.toBe(project);
    expect(fs.statSync(path.join(input.cwd, "work")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(input.cwd, "outputs")).isDirectory()).toBe(true);
  });

  test("creates a fresh projectless workspace when new is sent from a projectless task", async () => {
    const { controller, runtime } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-projectless-home-"));
    tempDirs.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);

    await controller.onMessage(message("/new"));
    await controller.onMessage({ messageId: "new-projectless-again", contextKey: "chat_id:c1", text: "/new" });

    const firstCwd = (runtime.createSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].cwd;
    const secondCwd = (runtime.createSession as ReturnType<typeof vi.fn>).mock.calls[1]?.[0].cwd;
    const projectlessRoot = path.join(home, "Documents", "Codex");
    expect(path.relative(projectlessRoot, firstCwd)).toMatch(/^\d{4}-\d{2}-\d{2}[\\/]new-chat$/);
    expect(path.relative(projectlessRoot, secondCwd)).toMatch(/^\d{4}-\d{2}-\d{2}[\\/]new-chat-2$/);
    expect(secondCwd).not.toBe(firstCwd);
  });

  test("keeps the first ordinary prompt as the task title fallback", async () => {
    const { controller, store } = fixture();

    await controller.onMessage(message("  inspect\n this repo  "));
    await controller.onMessage(message("also update docs"));

    expect(store.listSessions("chat_id:c1")[0]?.title).toBe("inspect this repo");
  });

  test("persists runtime title metadata and refreshes the turn presenter", async () => {
    const { controller, store, presenter, listeners } = fixture();
    await controller.onMessage(message("/new"));
    const sessionId = store.listSessions("chat_id:c1")[0]!.localSessionId;

    for (const listener of listeners) {
      listener({ type: "session_metadata_updated", sessionId, title: "Generated title" });
    }

    await vi.waitFor(() => expect(store.getSession(sessionId)?.title).toBe("Generated title"));
    expect(presenter.onEvent).not.toHaveBeenCalled();
    expect(presenter.updateSessionTitle).toHaveBeenCalledWith(sessionId, "Generated title");
  });

  test("renames the current task and refreshes its presentation", async () => {
    const { controller, runtime, store, presenter, outbound } = fixture();
    await controller.onMessage(message("/new"));
    const sessionId = store.listSessions("chat_id:c1")[0]!.localSessionId;

    await controller.onMessage(message("/title 修复会话列表时间"));

    expect(runtime.setTitle).toHaveBeenCalledWith(sessionId, "修复会话列表时间");
    expect(store.getSession(sessionId)?.title).toBe("修复会话列表时间");
    expect(presenter.updateSessionTitle).toHaveBeenCalledWith(sessionId, "修复会话列表时间");
    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", "已将当前任务标题修改为：修复会话列表时间");
  });

  test("renames the current task from a custom group name format", async () => {
    const { controller, runtime, store, config } = fixture();
    config.feishu.groupNameFormat = {
      project: "Project {project} · {agent} · {taskname}",
      projectless: "No project · {agent} · {taskname}",
      dateFormat: "MM-dd",
    };
    await controller.onMessage(groupMessage("rename_custom_group", "old title"));
    const sessionId = store.getUserContext("chat_id:rename_custom_group")!.currentSessionId!;

    await controller.onChatUpdated({
      chatId: "rename_custom_group",
      beforeName: "No project · codex · old title",
      afterName: "No project · codex · custom title",
    });

    expect(runtime.setTitle).toHaveBeenCalledWith(sessionId, "custom title");
    expect(store.getSession(sessionId)?.title).toBe("custom title");
  });

  test("renames the group-bound current task when the Feishu group name changes", async () => {
    const { controller, runtime, store, presenter, outbound } = fixture();
    await controller.onMessage(groupMessage("rename_group", "old title"));
    const sessionId = store.getUserContext("chat_id:rename_group")!.currentSessionId!;
    const sentMessageCount = (outbound.sendText as ReturnType<typeof vi.fn>).mock.calls.length;

    await controller.onChatUpdated({
      chatId: "rename_group",
      beforeName: "[codex] [dev\\agent-bot] old title",
      afterName: "[Codex] [dev\\agent-bot] abc",
    });

    expect(runtime.setTitle).toHaveBeenCalledWith(sessionId, "abc");
    expect(store.getSession(sessionId)?.title).toBe("abc");
    expect(presenter.updateSessionTitle).toHaveBeenCalledWith(sessionId, "abc");
    expect(outbound.sendText).toHaveBeenCalledTimes(sentMessageCount);
  });

  test("keeps supporting group names without a project prefix when renaming a task", async () => {
    const { controller, runtime, store } = fixture();
    await controller.onMessage(groupMessage("rename_legacy_group", "old title"));
    const sessionId = store.getUserContext("chat_id:rename_legacy_group")!.currentSessionId!;

    await controller.onChatUpdated({
      chatId: "rename_legacy_group",
      beforeName: "[codex] old title",
      afterName: "[Codex] legacy title",
    });

    expect(runtime.setTitle).toHaveBeenCalledWith(sessionId, "legacy title");
    expect(store.getSession(sessionId)?.title).toBe("legacy title");
  });

  test("ignores a group name containing only agent and project prefixes", async () => {
    const { controller, runtime, store } = fixture();
    await controller.onMessage(groupMessage("rename_prefix_only", "current title"));
    const sessionId = store.getUserContext("chat_id:rename_prefix_only")!.currentSessionId!;

    await controller.onChatUpdated({
      chatId: "rename_prefix_only",
      beforeName: "[codex] [dev\\agent-bot] current title",
      afterName: "[codex] [dev\\agent-bot]",
    });

    expect(runtime.setTitle).not.toHaveBeenCalled();
    expect(store.getSession(sessionId)?.title).toBe("current title");
  });

  test("ignores group names that do not match the current task agent or have no bound task", async () => {
    const { controller, runtime, store } = fixture();
    await controller.onMessage(groupMessage("rename_guard", "current title"));
    const sessionId = store.getUserContext("chat_id:rename_guard")!.currentSessionId!;

    await controller.onChatUpdated({
      chatId: "rename_guard",
      beforeName: "[codex] current title",
      afterName: "[acp] should not apply",
    });
    await controller.onChatUpdated({
      chatId: "rename_guard",
      beforeName: "[acp] should not apply",
      afterName: "missing agent prefix",
    });
    await controller.onChatUpdated({
      chatId: "empty_group",
      beforeName: "[codex] old",
      afterName: "[codex] no task",
    });
    await controller.onChatUpdated({
      chatId: "rename_guard",
      beforeName: "[codex] anything",
      afterName: "[codex] current title",
    });

    expect(runtime.setTitle).not.toHaveBeenCalled();
    expect(store.getSession(sessionId)?.title).toBe("current title");
  });

  test("rejects title changes when there is no current task", async () => {
    const { controller, runtime, outbound } = fixture();

    await controller.onMessage(message("/title 尚不存在的任务"));

    expect(runtime.setTitle).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", expect.stringContaining("当前没有任务"));
  });

  test("ignores a duplicate inbound message id", async () => {
    const { controller, runtime, outbound } = fixture();
    const duplicate = { messageId: "same-event", contextKey: "chat_id:c1", text: "inspect" };
    await controller.onMessage(duplicate);
    await controller.onMessage(duplicate);
    expect(runtime.startTurn).toHaveBeenCalledOnce();
    expect(outbound.addReaction).toHaveBeenCalledOnce();
  });

  test("continues processing when the received-message reaction fails", async () => {
    const { controller, runtime, outbound } = fixture();
    (outbound.addReaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("missing reaction scope"));

    await controller.onMessage(message("continue despite reaction failure"));

    expect(runtime.startTurn).toHaveBeenCalledOnce();
  });

  test("replaces every received reaction with DONE when the bound turn completes", async () => {
    const { controller, sessions, store, outbound, listeners } = fixture();
    let reactionSequence = 0;
    (outbound.addReaction as ReturnType<typeof vi.fn>).mockImplementation(async () => `reaction_${++reactionSequence}`);

    await controller.onMessage(message("build it"));
    await controller.onMessage(message("also update docs"));
    const session = store.listSessions("chat_id:c1")[0]!;
    expect(store.getMessageReaction("m-build it")).toMatchObject({ turnId: "turn_1", status: "pending" });
    expect(store.getMessageReaction("m-also update docs")).toMatchObject({ turnId: "turn_1", status: "pending" });

    sessions.get(session.localSessionId)!.activeTurnId = undefined;
    for (const listener of listeners) {
      listener({ type: "turn_completed", sessionId: session.localSessionId, turnId: "turn_1", finalResponse: "done" });
    }

    await vi.waitFor(() => expect(store.getMessageReaction("m-build it")?.status).toBe("completed"));
    expect(store.getMessageReaction("m-also update docs")).toMatchObject({ emojiType: "DONE", status: "completed" });
    expect(outbound.addReaction).toHaveBeenCalledWith("m-build it", "DONE");
    expect(outbound.addReaction).toHaveBeenCalledWith("m-also update docs", "DONE");
    expect(outbound.deleteReaction).toHaveBeenCalledWith("m-build it", "reaction_1");
    expect(outbound.deleteReaction).toHaveBeenCalledWith("m-also update docs", "reaction_2");
  });

  test("keeps a completed turn active until its final response has been delivered", async () => {
    const { controller, sessions, store, listeners, presenter } = fixture();
    let releaseFinalDelivery!: () => void;
    const finalDelivery = new Promise<void>((resolve) => { releaseFinalDelivery = resolve; });
    (presenter.onEvent as ReturnType<typeof vi.fn>).mockImplementation(async (event: RuntimeEvent) => {
      if (event.type === "turn_completed") await finalDelivery;
    });

    await controller.onMessage(message("build it safely"));
    const session = store.listSessions("chat_id:c1")[0]!;
    sessions.get(session.localSessionId)!.activeTurnId = undefined;
    for (const listener of listeners) {
      listener({ type: "turn_completed", sessionId: session.localSessionId, turnId: "turn_1", finalResponse: "done" });
    }

    await vi.waitFor(() => expect(presenter.onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "turn_completed",
      turnId: "turn_1",
    })));
    expect(store.getServerActivityState().runningSessions).toBe(1);
    expect(store.getSession(session.localSessionId)).toMatchObject({
      status: "running",
      lastTurnStatus: "completed",
    });

    releaseFinalDelivery();
    await vi.waitFor(() => expect(store.getSession(session.localSessionId)?.status).toBe("ready"));
    expect(store.getServerActivityState().runningSessions).toBe(0);
  });

  test("keeps the received reaction pending when terminal presentation fails", async () => {
    const { controller, sessions, store, listeners, presenter, outbound } = fixture();
    (outbound.addReaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce("reaction_on_it");
    (presenter.onEvent as ReturnType<typeof vi.fn>).mockImplementation(async (event: RuntimeEvent) => {
      if (event.type === "turn_completed") throw new Error("terminal presentation failed");
    });

    await controller.onMessage(message("build it safely"));
    const session = store.listSessions("chat_id:c1")[0]!;
    sessions.get(session.localSessionId)!.activeTurnId = undefined;
    for (const listener of listeners) {
      listener({ type: "turn_completed", sessionId: session.localSessionId, turnId: "turn_1", finalResponse: "done" });
    }

    await vi.waitFor(() => expect(store.getSession(session.localSessionId)?.status).toBe("ready"));
    expect(store.getMessageReaction("m-build it safely")).toMatchObject({
      emojiType: "OnIt",
      status: "pending",
    });
    expect(outbound.addReaction).not.toHaveBeenCalledWith("m-build it safely", "DONE");
  });

  test("uses CrossMark for the original prompt when its turn is cancelled", async () => {
    const { controller, sessions, store, outbound, listeners } = fixture();
    (outbound.addReaction as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("reaction_on_it")
      .mockResolvedValueOnce("reaction_cancelled");

    await controller.onMessage(message("long task"));
    const session = store.listSessions("chat_id:c1")[0]!;
    sessions.get(session.localSessionId)!.activeTurnId = undefined;
    for (const listener of listeners) {
      listener({ type: "turn_cancelled", sessionId: session.localSessionId, turnId: "turn_1" });
    }

    await vi.waitFor(() => expect(store.getMessageReaction("m-long task")?.status).toBe("cancelled"));
    expect(outbound.addReaction).toHaveBeenLastCalledWith("m-long task", "CrossMark");
    expect(outbound.deleteReaction).toHaveBeenCalledWith("m-long task", "reaction_on_it");
  });

  test("does not apply a stale cancelled reaction after the same turn is active again", async () => {
    const { controller, store, outbound, listeners, presenter } = fixture();
    (outbound.addReaction as ReturnType<typeof vi.fn>).mockResolvedValue("reaction_on_it");
    let releaseCancelledPresentation!: () => void;
    const cancelledPresentation = new Promise<void>((resolve) => { releaseCancelledPresentation = resolve; });
    (presenter.onEvent as ReturnType<typeof vi.fn>).mockImplementation(async (event: RuntimeEvent) => {
      if (event.type === "turn_cancelled") await cancelledPresentation;
    });

    await controller.onMessage(message("keep running"));
    const session = store.listSessions("chat_id:c1")[0]!;
    for (const listener of listeners) {
      listener({ type: "turn_cancelled", sessionId: session.localSessionId, turnId: "turn_1" });
    }
    await vi.waitFor(() => expect(presenter.onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "turn_cancelled",
      turnId: "turn_1",
    })));
    for (const listener of listeners) {
      listener({
        type: "turn_started",
        sessionId: session.localSessionId,
        turnId: "turn_1",
        startedAt: Date.now(),
      });
    }
    releaseCancelledPresentation();

    await vi.waitFor(() => expect(store.getSession(session.localSessionId)?.lastTurnStatus).toBe("running"));
    expect(store.getMessageReaction("m-keep running")).toMatchObject({ status: "pending", emojiType: "OnIt" });
    expect(outbound.addReaction).not.toHaveBeenCalledWith("m-keep running", "CrossMark");
  });

  test("plain text steers an active turn, inserts it into the thinking card, and stop bypasses prompt completion", async () => {
    const { controller, runtime, outbound, presenter, store } = fixture();
    await controller.onMessage(message("build it"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    const attemptId = store.findIncompleteTurnAttemptForSession(sessionId)!.attemptId;
    await controller.onMessage(message("also update docs"));
    await controller.onMessage(message("/stop"));

    expect(runtime.steerTurn).toHaveBeenCalledWith(expect.any(String), "turn_1", "also update docs");
    expect(presenter.appendSteerMessage).toHaveBeenCalledWith(
      sessionId,
      "turn_1",
      "also update docs",
      "m-also update docs",
    );
    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("thr_1", "turn_1");
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "已发送停止信号，任务会自动停止。",
    );
    expect(store.getTurnAttempt(attemptId)?.status).toBe("cancelling");
  });

  test("restores a recoverable attempt when a user interrupt request fails", async () => {
    const { controller, runtime, store } = fixture();
    await controller.onMessage(message("keep working if stop fails"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    const attemptId = store.findIncompleteTurnAttemptForSession(sessionId)!.attemptId;
    (runtime.interruptRemoteTurn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("App Server control request failed"),
    );

    await controller.onMessage(message("/stop"));

    expect(store.getTurnAttempt(attemptId)?.status).toBe("running");
  });

  test("reads a missing local turn from the current Codex task before interrupting", async () => {
    const { controller, runtime, sessions, store, outbound } = fixture();
    await controller.onMessage(message("build it"));
    const sessionId = store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId!;
    sessions.get(sessionId)!.activeTurnId = undefined;

    await controller.onMessage({ messageId: "stop-synchronized", contextKey: "chat_id:c1", text: "/stop" });

    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("thr_1", "turn_1");
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "已发送停止信号，任务会自动停止。",
    );
  });

  test("interrupts the active turn of the current task even when another client started it", async () => {
    const { controller, runtime, sessions, remoteSessions, store, outbound } = fixture();
    await controller.onMessage(message("build it"));
    const sessionId = store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId!;
    sessions.get(sessionId)!.activeTurnId = undefined;
    Object.assign(remoteSessions.find((remote) => remote.id === "thr_1")!, {
      status: "active",
      lastTurnId: "turn_from_another_client",
      lastTurnStatus: "inProgress",
    });

    await controller.onMessage({ messageId: "stop-different-turn", contextKey: "chat_id:c1", text: "/stop" });

    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("thr_1", "turn_from_another_client");
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "已发送停止信号，任务会自动停止。",
    );
  });

  test("interrupts the current externally created task without loading it locally", async () => {
    const { controller, runtime, remoteSessions, store, outbound } = fixture();
    remoteSessions.push({
      id: "external_current",
      title: "External task",
      cwd: "D:\\work\\external",
      source: "cli",
      status: "idle",
      lastTurnId: "turn_old",
      lastTurnStatus: "completed",
    });
    await controller.onMessage(message("/switch external_current"));
    const currentSessionId = store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId!;
    expect(runtime.getSession(currentSessionId)).toBeUndefined();
    Object.assign(remoteSessions.find((remote) => remote.id === "external_current")!, {
      status: "active",
      lastTurnId: "turn_external_active",
      lastTurnStatus: "inProgress",
    });

    await controller.onMessage({ messageId: "stop-external-current", contextKey: "chat_id:c1", text: "/stop" });

    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("external_current", "turn_external_active");
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "已发送停止信号，任务会自动停止。",
    );
  });

  test("read-only commands bypass a blocked prompt queue", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("build it"));
    let releaseSteer!: () => void;
    (runtime.steerTurn as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseSteer = resolve; }),
    );

    const blockedPrompt = controller.onMessage(message("also update docs"));
    await vi.waitFor(() => expect(runtime.steerTurn).toHaveBeenCalled());
    await controller.onMessage(message("/help"));

    expect(outbound.sendInteractiveCard).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.objectContaining({ header: expect.objectContaining({ title: expect.objectContaining({ content: "Agent Bot 使用帮助" }) }) }),
    );
    releaseSteer();
    await blockedPrompt;
  });

  test("/queue can enqueue while a normal steer request is blocked", async () => {
    const { controller, runtime, outbound, presenter, store } = fixture();
    await controller.onMessage(message("build it"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    let releaseSteer!: () => void;
    (runtime.steerTurn as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseSteer = resolve; }),
    );

    const blockedPrompt = controller.onMessage(message("also update docs"));
    await vi.waitFor(() => expect(runtime.steerTurn).toHaveBeenCalled());
    await controller.onMessage(message("/queue run tests afterwards"));

    expect(store.listQueuedPrompts(sessionId).map((prompt) => prompt.text)).toEqual([
      "run tests afterwards",
    ]);
    expect(presenter.appendSteerMessage).not.toHaveBeenCalledWith(
      sessionId,
      expect.any(String),
      "run tests afterwards",
      expect.any(String),
    );
    expect(outbound.sendInteractiveCard).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.objectContaining({ header: expect.objectContaining({ title: expect.objectContaining({ content: "排队 Prompt · 1" }) }) }),
    );
    releaseSteer();
    await blockedPrompt;
  });

  test("safe restart bypasses a blocked prompt queue", async () => {
    const { controller, runtime, restart } = fixture();
    await controller.onMessage(message("build it"));
    let releaseSteer!: () => void;
    (runtime.steerTurn as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseSteer = resolve; }),
    );

    const blockedPrompt = controller.onMessage(message("also update docs"));
    await vi.waitFor(() => expect(runtime.steerTurn).toHaveBeenCalled());
    await controller.onMessage(message("/restart"));

    expect(restart).toHaveBeenCalledWith("chat_id:c1", false, undefined);
    releaseSteer();
    await blockedPrompt;
  });

  test("passes --force to the restart lifecycle", async () => {
    const { controller, restart } = fixture();

    await controller.onMessage(message("/restart --force"));

    expect(restart).toHaveBeenCalledWith("chat_id:c1", true, undefined);
  });

  test("requires a card click before releasing an idle App Server", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("/new"));
    vi.mocked(runtime.release!).mockClear();
    vi.mocked(outbound.sendInteractiveCard).mockClear();
    vi.mocked(outbound.updateInteractiveCard).mockClear();
    vi.useFakeTimers();

    try {
      await controller.onMessage(message("/release"));

      expect(runtime.release).not.toHaveBeenCalled();
      const confirmationCard = vi.mocked(outbound.sendInteractiveCard).mock.calls.at(-1)?.[1];
      expect(confirmationCard).toMatchObject({
        header: { template: "orange", title: { content: "确认释放" } },
      });
      expect(JSON.stringify(confirmationCard)).toContain("**状态**：可以释放");
      expect(JSON.stringify(confirmationCard)).toContain('"content":"Release"');
      expect(JSON.stringify(confirmationCard)).toContain("Cancel");

      await vi.advanceTimersByTimeAsync(60_000);
      expect(runtime.release).not.toHaveBeenCalled();

      await controller.onCardAction({
        actionId: "confirm-idle-release",
        contextKey: "chat_id:c1",
        messageId: "card",
        value: {
          action: "app_server_release_now",
          contextKey: "chat_id:c1",
          scheduleId: 1,
          agentName: "codex",
        },
      });

      expect(runtime.release).toHaveBeenCalledWith({ force: true });
      const finalCard = vi.mocked(outbound.updateInteractiveCard).mock.calls.at(-1)?.[1];
      expect(finalCard).toMatchObject({
        header: { template: "green", title: { content: "任务已释放" } },
      });
      expect(JSON.stringify(finalCard)).toContain("Retry");
    } finally {
      vi.useRealTimers();
    }
  });

  test("cancels a pending idle App Server release from its card", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("/new"));
    vi.mocked(runtime.release!).mockClear();
    vi.mocked(outbound.updateInteractiveCard).mockClear();
    vi.useFakeTimers();

    try {
      await controller.onMessage(message("/release"));
      await controller.onCardAction({
        actionId: "cancel-release",
        contextKey: "chat_id:c1",
        messageId: "card",
        value: {
          action: "app_server_release_cancel",
          contextKey: "chat_id:c1",
          scheduleId: 1,
          agentName: "codex",
        },
      });

      const cancelledCard = vi.mocked(outbound.updateInteractiveCard).mock.calls.at(-1)?.[1];
      expect(cancelledCard).toMatchObject({
        header: { template: "grey", title: { content: "已取消释放" } },
      });
      expect(JSON.stringify(cancelledCard)).toContain("Agent Bot 将继续保持当前任务连接");
      await vi.advanceTimersByTimeAsync(6_000);
      expect(runtime.release).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("releases an idle App Server without reporting interrupted work after confirmation", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("/new"));
    vi.mocked(runtime.release!).mockClear();
    vi.mocked(outbound.updateInteractiveCard).mockClear();
    vi.useFakeTimers();

    try {
      await controller.onMessage(message("/release"));
      await controller.onCardAction({
        actionId: "release-idle-now",
        contextKey: "chat_id:c1",
        messageId: "card",
        value: {
          action: "app_server_release_now",
          contextKey: "chat_id:c1",
          scheduleId: 1,
          agentName: "codex",
        },
      });

      expect(runtime.release).toHaveBeenCalledWith({ force: true });
      const releasedCard = vi.mocked(outbound.updateInteractiveCard).mock.calls.at(-1)?.[1];
      expect(releasedCard).toMatchObject({
        header: { template: "green", title: { content: "任务已释放" } },
      });
      expect(JSON.stringify(releasedCard)).not.toContain("执行中的任务已中断");
    } finally {
      vi.useRealTimers();
    }
  });

  test("lets cancellation win while the card is updating to the releasing state", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("/new"));
    vi.mocked(runtime.release!).mockClear();
    let markReleasingUpdate!: () => void;
    let finishReleasingUpdate!: () => void;
    const releasingUpdateStarted = new Promise<void>((resolve) => { markReleasingUpdate = resolve; });
    const releasingUpdateGate = new Promise<void>((resolve) => { finishReleasingUpdate = resolve; });
    vi.mocked(outbound.updateInteractiveCard).mockImplementation(async (_messageId, card) => {
      const title = (card.header as { title?: { content?: string } } | undefined)?.title?.content;
      if (title === "正在释放") {
        markReleasingUpdate();
        await releasingUpdateGate;
      }
    });
    await controller.onMessage(message("/release"));
    const release = controller.onCardAction({
      actionId: "release-during-update",
      contextKey: "chat_id:c1",
      messageId: "card",
      value: {
        action: "app_server_release_now",
        contextKey: "chat_id:c1",
        scheduleId: 1,
        agentName: "codex",
      },
    });
    await releasingUpdateStarted;

    const cancellation = controller.onCardAction({
      actionId: "cancel-release-during-update",
      contextKey: "chat_id:c1",
      messageId: "card",
      value: {
        action: "app_server_release_cancel",
        contextKey: "chat_id:c1",
        scheduleId: 1,
        agentName: "codex",
      },
    });
    finishReleasingUpdate();
    await Promise.all([release, cancellation]);

    expect(runtime.release).not.toHaveBeenCalled();
    const cancelledCard = vi.mocked(outbound.updateInteractiveCard).mock.calls.at(-1)?.[1];
    expect(cancelledCard).toMatchObject({
      header: { template: "grey", title: { content: "已取消释放" } },
    });
  });

  test("keeps waiting for confirmation after App Server tasks finish", async () => {
    const { controller, runtime, outbound, sessions, listeners, store } = fixture();
    await controller.onMessage(message("build it"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    vi.mocked(runtime.release!).mockClear();
    vi.mocked(outbound.sendInteractiveCard).mockClear();

    await controller.onMessage(message("/release"));

    expect(runtime.release).not.toHaveBeenCalled();
    const waitingCard = vi.mocked(outbound.sendInteractiveCard).mock.calls.at(-1)?.[1];
    expect(waitingCard).toMatchObject({
      header: { template: "orange", title: { content: "等待释放" } },
    });
    expect(JSON.stringify(waitingCard)).toContain("1. `build it`");
    expect(JSON.stringify(waitingCard)).toContain("Release Now");

    store.updateRuntimeSession(sessionId, { title: "renamed active task" });
    await vi.waitFor(() => {
      const cards = vi.mocked(outbound.updateInteractiveCard).mock.calls.map((call) => JSON.stringify(call[1]));
      expect(cards.some((card) => card.includes("1. `renamed active task`"))).toBe(true);
    }, { timeout: 2_000 });

    sessions.get(sessionId)!.activeTurnId = undefined;
    for (const listener of listeners) {
      listener({ type: "turn_completed", sessionId, turnId: "turn_1", finalResponse: "done" });
    }

    await vi.waitFor(() => {
      const readyCard = vi.mocked(outbound.updateInteractiveCard).mock.calls.at(-1)?.[1];
      expect(readyCard).toMatchObject({
        header: { template: "orange", title: { content: "确认释放" } },
      });
      expect(JSON.stringify(readyCard)).toContain('"content":"Release"');
    }, { timeout: 2_000 });
    expect(runtime.release).not.toHaveBeenCalled();
  });

  test("releases App Server tasks immediately from the waiting card and clears queued Prompts", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(message("build it"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    store.enqueuePrompt({
      promptId: "queued-before-release",
      localSessionId: sessionId,
      contextKey: "chat_id:c1",
      text: "run later",
      messageId: "om-queued-before-release",
    });
    vi.mocked(runtime.release!).mockClear();

    await controller.onMessage(message("/release"));
    await controller.onCardAction({
      actionId: "release-now",
      contextKey: "chat_id:c1",
      messageId: "card",
      value: {
        action: "app_server_release_now",
        contextKey: "chat_id:c1",
        scheduleId: 1,
        agentName: "codex",
      },
    });

    expect(runtime.release).toHaveBeenCalledWith({ force: true });
    expect(store.countQueuedPrompts(sessionId)).toBe(0);
    const finalCard = vi.mocked(outbound.updateInteractiveCard).mock.calls.at(-1)?.[1];
    expect(finalCard).toMatchObject({
      header: { template: "green", title: { content: "任务已释放" } },
    });
    expect(JSON.stringify(finalCard)).toContain("执行中的任务已中断");
  });

  test("passes the requesting topic message to the restart lifecycle", async () => {
    const { controller, restart, store } = fixture();
    const contextKey = "chat_id:c1:thread_id:topic_restart";
    store.getOrCreateUserContext(contextKey, "codex");
    store.createSession({
      localSessionId: "session_restart_topic",
      contextKey,
      agentName: "codex",
      cwd: process.cwd(),
      status: "ready",
    });
    store.setCurrentSession(contextKey, "session_restart_topic");

    await controller.onMessage(threadMessage(
      "c1",
      "group",
      "topic_restart",
      "om_topic_root",
      "/restart",
    ));

    expect(restart).toHaveBeenCalledWith(contextKey, false, {
      messageId: "m-topic_restart-/restart",
      replyInThread: true,
    });
  });

  test("lazily resumes a persisted session before starting the next turn", async () => {
    const { controller, runtime, store, remoteSessions } = fixture();
    remoteSessions.push({
      id: "thr_saved",
      cwd: process.cwd(),
      source: "agent-bot",
      status: "idle",
      lastTurnId: "turn_saved",
      lastTurnStatus: "completed",
    });
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({ localSessionId: "saved", contextKey: "chat_id:c1", agentName: "codex", cwd: process.cwd(), status: "ready" });
    store.updateRuntimeSession("saved", {
      runtimeKind: "codex",
      remoteSessionId: "thr_saved",
      lastTurnId: "turn_saved",
      lastTurnStatus: "completed",
      reasoningEffort: "high",
      permissionMode: "auto",
    });
    store.setCurrentSession("chat_id:c1", "saved");

    await controller.onMessage(message("continue"));
    expect(runtime.resumeSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: "saved",
      remoteSessionId: "thr_saved",
      reasoningEffort: "high",
      activeTurnId: undefined,
    }));
    expect(runtime.startTurn).toHaveBeenCalledWith("saved", "continue");
  });

  test("restores and reconciles a persisted running turn before handling a new prompt", async () => {
    const { controller, runtime, store, remoteSessions, outbound } = fixture();
    remoteSessions.push({
      id: "thr_running",
      cwd: process.cwd(),
      source: "agent-bot",
      status: "active",
      lastTurnId: "turn_saved",
      lastTurnStatus: "inProgress",
    });
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({
      localSessionId: "running",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: process.cwd(),
      status: "running",
    });
    store.updateRuntimeSession("running", {
      runtimeKind: "codex",
      remoteSessionId: "thr_running",
      lastTurnId: "turn_saved",
      lastTurnStatus: "running",
      permissionMode: "auto",
    });
    store.setCurrentSession("chat_id:c1", "running");

    await controller.onMessage(message("latest progress"));

    expect(runtime.resumeSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: "running",
      remoteSessionId: "thr_running",
      activeTurnId: "turn_saved",
    }));
    expect((outbound.sendText as ReturnType<typeof vi.fn>).mock.calls).toEqual([]);
    expect(runtime.steerTurn).toHaveBeenCalledWith("running", "turn_saved", "latest progress");
  });

  test("continues a restarted task when restoring the previous final answer fails", async () => {
    const { controller, runtime, store, remoteSessions, presenter } = fixture();
    remoteSessions.push({
      id: "thr_restored",
      cwd: process.cwd(),
      source: "agent-bot",
      status: "idle",
      lastTurnId: "turn_previous",
      lastTurnStatus: "completed",
    });
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({
      localSessionId: "restored",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: process.cwd(),
      status: "ready",
    });
    store.updateRuntimeSession("restored", {
      runtimeKind: "codex",
      remoteSessionId: "thr_restored",
      lastTurnId: "turn_previous",
      lastTurnStatus: "completed",
      permissionMode: "auto",
    });
    store.setCurrentSession("chat_id:c1", "restored");
    (presenter.resumeDelivery as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("invalid persisted image card"),
    );

    await controller.onMessage(message("continue after restart"));

    expect(presenter.resumeDelivery).toHaveBeenCalledWith("restored", "chat_id:c1", "turn_previous");
    expect(runtime.resumeSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: "restored",
      remoteSessionId: "thr_restored",
    }));
    expect(runtime.startTurn).toHaveBeenCalledWith("restored", "continue after restart");
  });

  test("starts the first turn of a new Codex thread before it is materialized", async () => {
    const { controller, runtime } = fixture();
    await controller.onMessage(message("/new"));
    (runtime.inspectRemoteSessionActivity as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error(
        "thread/read failed: thread thr_1 is not materialized yet; includeTurns is unavailable before first user message",
      ),
    );

    await controller.onMessage(message("hello from the first turn"));

    expect(runtime.startTurn).toHaveBeenCalledWith(expect.any(String), "hello from the first turn");
    expect(runtime.synchronizeSession).not.toHaveBeenCalled();
  });

  test("starts a prompt on a completed large task without reading or synchronizing its full history", async () => {
    const { controller, runtime, sessions, remoteSessions, store } = fixture();
    await controller.onMessage(message("first prompt"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    sessions.get(sessionId)!.activeTurnId = undefined;
    Object.assign(remoteSessions[0]!, {
      status: "idle",
      lastTurnId: "turn_1",
      lastTurnStatus: "completed",
    });
    store.updateSession(sessionId, { status: "ready" });
    store.updateRuntimeSession(sessionId, {
      lastTurnId: "turn_1",
      lastTurnStatus: "completed",
    });
    (runtime.readRemoteSession as ReturnType<typeof vi.fn>).mockClear();
    (runtime.inspectRemoteSessionActivity as ReturnType<typeof vi.fn>).mockClear();
    (runtime.synchronizeSession as ReturnType<typeof vi.fn>).mockClear();
    (runtime.startTurn as ReturnType<typeof vi.fn>).mockClear();

    await controller.onMessage(message("continue without loading 300 MB of history"));

    expect(runtime.inspectRemoteSessionActivity).toHaveBeenCalledWith("thr_1");
    expect(runtime.readRemoteSession).not.toHaveBeenCalled();
    expect(runtime.synchronizeSession).not.toHaveBeenCalled();
    expect(runtime.startTurn).toHaveBeenCalledWith(
      sessionId,
      "continue without loading 300 MB of history",
    );
  });

  test("recreates an empty Codex thread after restart instead of resuming a missing rollout", async () => {
    const { controller, runtime, store, remoteSessions } = fixture();
    remoteSessions.push({
      id: "thr_without_rollout",
      cwd: process.cwd(),
      source: "agent-bot",
      status: "not_loaded",
    });
    (runtime.resumeSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("thread/resume failed: no rollout found for thread id thr_without_rollout"),
    );
    (runtime.readRemoteSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("thread/read failed: thread not loaded: thr_without_rollout"),
    );
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({
      localSessionId: "empty",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: process.cwd(),
      status: "ready",
    });
    store.updateRuntimeSession("empty", {
      runtimeKind: "codex",
      remoteSessionId: "thr_without_rollout",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "auto",
    });
    store.setCurrentSession("chat_id:c1", "empty");

    await controller.onMessage(message("run a local command"));

    expect(runtime.resumeSession).toHaveBeenCalledOnce();
    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: "empty",
      cwd: process.cwd(),
      model: "gpt-test",
      reasoningEffort: "high",
    }));
    expect(runtime.startTurn).toHaveBeenCalledWith("empty", "run a local command");
    expect(store.getSession("empty")?.remoteSessionId).toBe("thr_1");
  });

  test.each([
    ["configuration failure", "thread/resume failed: failed to load configuration", false],
    ["provider failure", "thread/resume failed: model provider unknown is not configured", false],
    ["missing inherited lineage", "thread/resume failed: invalid paginated history lineage: missing source rollout", false],
    ["known fork with no cached last turn", "thread/resume failed: no rollout found for thread id inherited", true],
  ])("does not recreate a task after %s", async (_name, error, fork) => {
    const { controller, runtime, store, remoteSessions } = fixture();
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({ localSessionId: "saved", contextKey: "chat_id:c1", agentName: "codex", cwd: process.cwd(), status: "ready" });
    store.updateRuntimeSession("saved", { runtimeKind: "codex", remoteSessionId: "inherited", modelProvider: "openai", model: "gpt-test" });
    remoteSessions.push({ id: "inherited", cwd: process.cwd(), status: "idle", source: "agent-bot" });
    if (fork) store.audit("chat_id:c1", "session_forked", {
      forkedLocalSessionId: "saved", sourceRemoteSessionId: "parent", sourceTurnId: "parent-turn",
    });
    vi.mocked(runtime.resumeSession).mockRejectedValueOnce(new Error(String(error)));
    await expect(controller.controlTaskSettings("saved", "provider", "azure")).rejects.toThrow(String(error));
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(store.getSession("saved")?.remoteSessionId).toBe("inherited");
  });

  test("replaces a resume failure with a dedicated thread-writer conflict card", async () => {
    const owner = threadWriterOwner();
    const threadId = "01a05543-1cfd-75b1-9eba-1ce331ab4230";
    const threadWriterProcesses: ThreadWriterProcessController = {
      inspect: vi.fn(async () => [owner]),
      inspectApplicationThreadIds: vi.fn(async () => [threadId, "other-idle-thread"]),
      close: vi.fn(async () => undefined),
    };
    const { controller, runtime, remoteSessions, presenter, outbound, store } = fixture({}, threadWriterProcesses);
    remoteSessions.push({
      id: threadId,
      title: "Desktop task",
      cwd: process.cwd(),
      source: "vscode",
      status: "idle",
    });
    remoteSessions.push({
      id: "other-idle-thread",
      cwd: process.cwd(),
      source: "vscode",
      status: "idle",
    });
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({
      localSessionId: "occupied",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: process.cwd(),
      status: "ready",
    });
    store.updateRuntimeSession("occupied", {
      runtimeKind: "codex",
      remoteSessionId: threadId,
      title: "Desktop task",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "auto",
    });
    store.setCurrentSession("chat_id:c1", "occupied");
    (runtime.resumeSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error(`thread/resume failed: thread ${threadId} already has an active writer`),
    );
    (presenter.failPendingTurn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

    await controller.onMessage(message("continue occupied task"));

    expect(threadWriterProcesses.inspect).toHaveBeenCalledOnce();
    expect(presenter.failPendingTurn).toHaveBeenCalledWith(
      "occupied",
      "任务被占用。",
      expect.objectContaining({
        header: expect.objectContaining({
          template: "orange",
          title: { tag: "plain_text", content: "任务被占用" },
        }),
      }),
    );
    const card = (presenter.failPendingTurn as ReturnType<typeof vi.fn>).mock.calls[0]?.[2];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("ChatGPT.exe (81552)");
    expect(serialized).not.toContain("Codex Desktop");
    expect(serialized).toContain("无执行中任务，可安全关闭");
    expect(serialized).toContain("thread_writer_fork");
    expect(serialized).toContain("Fork");
    expect(serialized).toContain("Close 81552");
    expect(outbound.sendText).not.toHaveBeenCalled();
    expect(outbound.sendInteractiveCard).not.toHaveBeenCalled();
    expect(threadWriterProcesses.inspectApplicationThreadIds).toHaveBeenCalledWith(
      path.join("C:\\codex-home", `${threadId}.lock`),
      owner,
    );
    expect(runtime.inspectRemoteSessionActivity).toHaveBeenCalledWith(threadId);
    expect(runtime.inspectRemoteSessionActivity).toHaveBeenCalledWith("other-idle-thread");
  });

  test("revalidates and closes the exact thread-writer process from the conflict card", async () => {
    const owner = threadWriterOwner();
    const threadWriterProcesses: ThreadWriterProcessController = {
      inspect: vi.fn()
        .mockResolvedValueOnce([owner])
        .mockResolvedValueOnce([]),
      close: vi.fn(async () => undefined),
    };
    const { controller, outbound, store } = fixture({}, threadWriterProcesses);
    const threadId = "01a05543-1cfd-75b1-9eba-1ce331ab4230";
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({
      localSessionId: "occupied",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: process.cwd(),
      status: "ready",
    });
    store.updateRuntimeSession("occupied", {
      runtimeKind: "codex",
      remoteSessionId: threadId,
      title: "Desktop task",
    });

    await controller.onCardAction({
      actionId: "close-writer",
      contextKey: "chat_id:c1",
      messageId: "om_conflict",
      value: {
        action: "thread_writer_close",
        contextKey: "chat_id:c1",
        sessionId: "occupied",
        threadId,
        writerPid: owner.writerPid,
        writerStartedAt: owner.writerStartedAt,
        applicationPid: owner.applicationPid,
        applicationStartedAt: owner.applicationStartedAt,
        force: false,
      },
    });

    expect(threadWriterProcesses.close).toHaveBeenCalledWith(owner, false);
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith(
      "om_conflict",
      expect.objectContaining({
        header: expect.objectContaining({
          template: "green",
          title: { tag: "plain_text", content: "任务占用已解除" },
        }),
      }),
    );
  });

  test("forks the occupied task from the conflict card without resuming it", async () => {
    const { controller, runtime, remoteSessions, outbound, store } = fixture();
    const threadId = "01a05543-1cfd-75b1-9eba-1ce331ab4230";
    remoteSessions.push({
      id: threadId,
      title: "Occupied task",
      cwd: process.cwd(),
      source: "vscode",
      status: "idle",
      lastTurnId: "turn_completed",
      lastTurnStatus: "completed",
      lastCompletedTurnId: "turn_completed",
      completedTurns: [{
        id: "turn_completed",
        prompt: "completed work",
        startedAt: 100,
        completedAt: 200,
      }],
    });
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({
      localSessionId: "occupied",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: process.cwd(),
      status: "ready",
    });
    store.updateRuntimeSession("occupied", {
      runtimeKind: "codex",
      remoteSessionId: threadId,
      title: "Occupied task",
      lastTurnId: "turn_completed",
      lastTurnStatus: "completed",
    });
    store.setCurrentSession("chat_id:c1", "occupied");

    await controller.onCardAction({
      actionId: "fork-writer",
      contextKey: "chat_id:c1",
      messageId: "om_conflict",
      value: {
        action: "thread_writer_fork",
        contextKey: "chat_id:c1",
        sessionId: "occupied",
        threadId,
      },
    });

    expect(runtime.resumeSession).not.toHaveBeenCalled();
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      remoteSessionId: threadId,
      lastTurnId: "turn_completed",
    }));
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("已从指定任务创建分支并切换到新任务"),
    );
  });

  test("lists all Codex tasks through one unified view", async () => {
    const { controller, remoteSessions, outbound, store } = fixture();
    store.createSession({
      localSessionId: "legacy_acp",
      contextKey: "chat_id:c1",
      agentName: "acp",
      cwd: "D:\\work\\acp",
      status: "running",
    });
    store.updateRuntimeSession("legacy_acp", {
      runtimeKind: "acp",
      remoteSessionId: "remote_acp",
      title: "Legacy ACP task",
    });
    remoteSessions.push({
      id: "external_1",
      title: "Desktop investigation",
      cwd: "D:\\work\\desktop",
      source: "vscode",
      status: "not_loaded",
      updatedAt: 946_684_800,
      recencyAt: 1_893_456_000,
      lastTurnId: "turn_external",
      lastTurnStatus: "completed",
      lastUserPrompt: "Inspect the latest desktop state",
    });

    await controller.onMessage(message("/sessions Desktop"));

    expect(outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("Desktop investigation");
    expect(serialized).toContain("Inspect the latest desktop state");
    expect(serialized).not.toContain("external_1");
    expect(serialized).toContain("2030");
    expect(serialized).not.toContain("2000");
    expect(serialized).not.toContain("最后更新：");
    expect(serialized).toContain('"tag":"overflow"');
    expect(serialized).toContain('"content":"Switch"');
    expect(sessionOverflowActions(card, store)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "session_switch",
        sessionId: "agent-runtime:codex:external_1",
        searchTerm: "Desktop",
        page: "0",
      }),
      expect.objectContaining({ action: "session_fork", sessionId: "agent-runtime:codex:external_1" }),
      expect.objectContaining({ action: "session_fork_group", sessionId: "agent-runtime:codex:external_1" }),
      expect.objectContaining({ action: "session_status", sessionId: "agent-runtime:codex:external_1" }),
    ]));
    expect(serialized).toContain('"tag":"plain_text","content":"New"');
    expect(serialized).toContain('"tag":"plain_text","content":"NewGroup"');
    expect(sessionOverflowActions(card, store)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "session_new",
        sessionId: "agent-runtime:codex:external_1",
        searchTerm: "Desktop",
        page: "0",
      }),
      expect.objectContaining({
        action: "session_new_group",
        sessionId: "agent-runtime:codex:external_1",
        searchTerm: "Desktop",
        page: "0",
      }),
    ]));
    expect(serialized).not.toContain("Legacy ACP task");
    expect(serialized).not.toContain("remote_acp");
    expect(serialized).toContain("> 项目菜单：**New** 新建任务，**NewGroup** 新建群。");
    expect(serialized).not.toContain("/switch [序号或任务 ID]");
    expect(serialized).not.toContain("已接入");
    expect(serialized).not.toContain("其他 Codex 任务");
    expect(serialized).not.toContain("未加载");
    expect(serialized).not.toContain("Agent / 任务 ID");
    expect(serialized).not.toContain("**目录**");
  });

  test("follows App Server cursors to list unbound Codex tasks from later remote pages", async () => {
    const { controller, runtime, outbound, store } = fixture();
    const remoteTasks = Array.from({ length: 12 }, (_, index): RemoteSessionSummary => ({
      id: `unbound_${index + 1}`,
      title: `Unbound task ${index + 1}`,
      cwd: "D:\\work\\unbound",
      source: "appServer",
      status: "idle",
      updatedAt: 100 - index,
    }));
    vi.mocked(runtime.listRemoteSessions!).mockImplementation(async ({ cursor, limit = 20 } = {}) => {
      const offset = cursor ? Number.parseInt(cursor, 10) : 0;
      const pageSize = Math.min(limit, 4);
      const nextOffset = offset + pageSize;
      return {
        sessions: remoteTasks.slice(offset, nextOffset),
        nextCursor: remoteTasks.length > nextOffset ? String(nextOffset) : undefined,
      };
    });

    await controller.onMessage(message("/sessions"));

    const firstCard = vi.mocked(outbound.sendInteractiveCard).mock.calls[0]?.[1];
    expect(JSON.stringify(firstCard)).toContain("10. Unbound task 10 · codex");
    expect(runtime.listRemoteSessions).toHaveBeenCalledWith({ searchTerm: undefined, cursor: "8", limit: 2 });
    expect(sessionOverflowActions(firstCard, store)).toContainEqual(expect.objectContaining({
      action: "session_page",
      page: "1",
    }));

    await controller.onCardAction({
      actionId: "sessions-next-unbound-page",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: { action: "session_page", page: "1" },
    });

    const secondCard = vi.mocked(outbound.updateInteractiveCard).mock.calls[0]?.[1];
    const secondPage = JSON.stringify(secondCard);
    expect(secondPage).toContain("11. Unbound task 11 · codex");
    expect(secondPage).toContain("12. Unbound task 12 · codex");
    expect(sessionOverflowActions(secondCard, store, "om_sessions")).toContainEqual(expect.objectContaining({
      action: "session_switch",
      sessionId: "agent-runtime:codex:unbound_11",
    }));
  });

  test("shows the latest persisted user Prompt for an Agent Bot task", async () => {
    const { controller, remoteSessions, outbound, store } = fixture();
    const latestPrompt = "这是一条包含表情🙂且长度明显超过五十个字符的最新用户请求，请只显示前五十个字符，并确保后续的这部分内容不会出现在任务卡片中";
    store.createSession({
      localSessionId: "local_prompt_task",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: "D:\\work\\prompt-task",
      status: "ready",
    });
    store.updateRuntimeSession("local_prompt_task", {
      runtimeKind: "codex",
      remoteSessionId: "remote_prompt_task",
      title: "Prompt task",
    });
    store.saveTurnSnapshot("turn_prompt_task", "local_prompt_task", {
      turnId: "turn_prompt_task",
      status: "completed",
      prompt: "Initial request",
      activities: [
        { kind: "user", id: "user_follow_up", text: latestPrompt },
      ],
    });
    remoteSessions.push({
      id: "remote_prompt_task",
      title: "Prompt task",
      cwd: "D:\\work\\prompt-task",
      source: "agent-bot",
      status: "idle",
      updatedAt: 1_893_456_000,
    });

    await controller.onMessage(message("/sessions"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("最新 Prompt");
    expect(serialized).toContain(`${Array.from(latestPrompt).slice(0, 50).join("")}...`);
    expect(serialized).not.toContain(latestPrompt);
    expect(serialized).not.toContain("最后一个用户 Prompt");
    expect(serialized).not.toContain("Initial request");
    expect(serialized).not.toContain("remote_prompt_task");
    expect(serialized).not.toContain("Agent / 任务 ID");
    expect(serialized).not.toContain("**目录**");
  });

  test("shows the persisted Prompt for a task bound to another Feishu conversation", async () => {
    const { controller, remoteSessions, outbound, store } = fixture();
    store.createSession({
      localSessionId: "cross_context_prompt_task",
      contextKey: "chat_id:other_group",
      agentName: "codex",
      cwd: "D:\\work\\cross-context",
      status: "running",
    });
    store.updateRuntimeSession("cross_context_prompt_task", {
      runtimeKind: "codex",
      remoteSessionId: "remote_cross_context_prompt",
      title: "Cross-context Prompt task",
      lastTurnId: "turn_cross_context_prompt",
      lastTurnStatus: "running",
    });
    store.saveTurnSnapshot("turn_cross_context_prompt", "cross_context_prompt_task", {
      turnId: "turn_cross_context_prompt",
      status: "running",
      startedAt: 1_893_456_000_000,
      prompt: "Run the Amazon case until it matches CNGC",
    }, "chat_id:other_group");
    remoteSessions.push({
      id: "remote_cross_context_prompt",
      title: "Cross-context Prompt task",
      cwd: "D:\\work\\cross-context",
      source: "agent-bot",
      status: "active",
      lastTurnId: "turn_cross_context_prompt",
      lastTurnStatus: "inProgress",
      updatedAt: 1_893_456_000,
    });

    await controller.onMessage(message("/sessions"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("最新 Prompt");
    expect(serialized).toContain("Run the Amazon case until it matches CNGC");
    expect(serialized).toContain("<font color='grey'>最近更新：");
    expect(serialized).not.toContain("暂无用户 Prompt");
  });

  test("resolves compact sessions-card actions from persisted message bindings", async () => {
    const { controller, remoteSessions, outbound, store } = fixture();
    remoteSessions.push({
      id: "compact_switch",
      title: "Compact switch target",
      cwd: "D:\\work\\compact-switch",
      source: "vscode",
      status: "idle",
    });

    await controller.onMessage(message("/sessions"));
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const token = sessionOverflowToken(card, "Switch");
    expect(token).toBeDefined();
    expect(JSON.stringify(card)).not.toContain("session_switch");

    await controller.onCardAction({
      actionId: "compact-session-switch",
      contextKey: "chat_id:c1",
      messageId: "card",
      value: { t: token! },
    });

    const currentSessionId = store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId;
    expect(store.getSession(currentSessionId!)?.remoteSessionId).toBe("compact_switch");
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("card", expect.any(Object));
  });

  test("groups compact session rows by project directory", async () => {
    const { controller, remoteSessions, outbound, store } = fixture();
    vi.spyOn(os, "homedir").mockReturnValue("/home/runner");
    remoteSessions.push(
      {
        id: "same_new",
        title: "Newer task",
        cwd: "D:\\work\\same",
        source: "vscode",
        status: "idle",
        updatedAt: 300,
      },
      {
        id: "same_old",
        title: "Older task",
        cwd: "D:\\work\\same",
        source: "vscode",
        status: "idle",
        updatedAt: 200,
      },
      {
        id: "other",
        title: "Other project task",
        cwd: "D:\\work\\other",
        source: "vscode",
        status: "idle",
        updatedAt: 250,
      },
    );

    await controller.onMessage(message("/sessions"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      body: { elements: Array<Record<string, unknown>> };
    };
    const projectRows = card.body.elements.filter((item) => item.tag === "column_set"
      && JSON.stringify(item).includes("📁"));
    const panels = card.body.elements.filter((item) => item.tag === "collapsible_panel");
    expect(projectRows).toHaveLength(2);
    expect(JSON.stringify(projectRows[0])).toContain("📁 D:&#92;work&#92;same");
    expect(sessionOverflowActions(projectRows[0], store)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "session_new", sessionId: "agent-runtime:codex:same_new" }),
      expect.objectContaining({ action: "session_new_group", sessionId: "agent-runtime:codex:same_new" }),
    ]));
    expect(JSON.stringify(projectRows[1])).toContain("📁 D:&#92;work&#92;other");
    expect(panels.map((item) => JSON.stringify(item.header))).toEqual([
      expect.stringContaining("1. Newer task · codex"),
      expect.stringContaining("2. Older task · codex"),
      expect.stringContaining("3. Other project task · codex"),
    ]);
  });

  test("paginates by global activity before rendering project groups", async () => {
    const { controller, remoteSessions, runtime, outbound } = fixture();
    remoteSessions.push(
      {
        id: "active_project_task",
        title: "Active project task",
        cwd: "D:\\work\\active-project",
        source: "vscode",
        status: "active",
        lastTurnStatus: "inProgress",
        updatedAt: 1_000,
      },
      {
        id: "old_same_project_task",
        title: "Old task from active project",
        cwd: "D:\\work\\active-project",
        source: "vscode",
        status: "idle",
        updatedAt: 1,
      },
      ...Array.from({ length: 9 }, (_, index): RemoteSessionSummary => ({
        id: `recent_other_project_${index + 1}`,
        title: `Recent task ${index + 1}`,
        cwd: `D:\\work\\recent-project-${index + 1}`,
        source: "vscode",
        status: "idle",
        updatedAt: 900 - index,
      })),
    );
    (runtime.listRemoteSessions as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      sessions: [...remoteSessions],
    }));

    await controller.onMessage(message("/sessions"));

    const firstCard = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const firstPage = JSON.stringify(firstCard);
    expect(firstPage).toContain("Active project task");
    expect(firstPage).toContain("Recent task 9");
    expect(firstPage).not.toContain("Old task from active project");

    await controller.onCardAction({
      actionId: "global-activity-next-page",
      contextKey: "chat_id:c1",
      messageId: "om_global_sessions",
      value: { action: "session_page", page: "1" },
    });
    const secondCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(JSON.stringify(secondCard)).toContain("Old task from active project");
  });

  test("keeps same-id Codex tasks isolated by Agent and routes card actions to their owning runtime", async () => {
    const traexRemote: RemoteSessionSummary = {
      id: "shared_task",
      title: "TraeX task",
      cwd: "D:\\work\\traex",
      source: "traex",
      status: "idle",
    };
    const traexRead = vi.fn(async () => traexRemote);
    const traexRuntime = {
      kind: "codex",
      listRemoteSessions: vi.fn(async () => ({ sessions: [traexRemote] })),
      readRemoteSession: traexRead,
      onEvent: vi.fn(() => () => undefined),
      close: vi.fn(),
    } as unknown as AgentRuntime;
    const { controller, remoteSessions, outbound, store, runtime } = fixture({ traex: traexRuntime });
    remoteSessions.push({
      id: "shared_task",
      title: "Codex task",
      cwd: "D:\\work\\codex",
      source: "codex",
      status: "idle",
    });

    await controller.onMessage(message("/sessions"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    expect(sessionOverflowActions(card, store)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: "agent-runtime:codex:shared_task" }),
      expect.objectContaining({ sessionId: "agent-runtime:traex:shared_task" }),
    ]));
    expect(serialized).toContain("Codex task");
    expect(serialized).toContain("TraeX task");

    await controller.onCardAction({
      actionId: "switch-shared-traex-task",
      contextKey: "chat_id:c1",
      value: { action: "session_switch", sessionId: "agent-runtime:traex:shared_task" },
    });

    expect(traexRead).toHaveBeenCalledWith("shared_task", "latest");
    expect(runtime.readRemoteSession).not.toHaveBeenCalled();
    const currentId = store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId;
    expect(store.getSession(currentId!)?.agentName).toBe("traex");
  });

  test("marks active external Codex sessions and sorts them first", async () => {
    const { controller, remoteSessions, outbound, store } = fixture();
    remoteSessions.push(
      { id: "idle_1", title: "Idle task", cwd: "D:\\work", source: "cli", status: "idle" },
      {
        id: "active_1",
        title: "Running task",
        cwd: "D:\\work",
        source: "vscode",
        status: "active",
        lastTurnStatus: "inProgress",
      },
    );

    await controller.onMessage(message("/sessions"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("任务（1 个活跃）");
    expect(serialized).toContain("1. 🟢 Running task · codex");
    expect(serialized).not.toContain("外部执行中");
    expect(serialized).toContain('"content":"Stop"');
    expect(sessionOverflowActions(card, store)).toContainEqual(expect.objectContaining({
      action: "session_stop",
      sessionId: "agent-runtime:codex:active_1",
      page: "0",
    }));
    expect(serialized.indexOf("Running task")).toBeLessThan(serialized.indexOf("Idle task"));
  });

  test("stops an active external task from the sessions card and changes its button to Switch", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    remoteSessions.push({
      id: "active_external",
      title: "External build",
      cwd: "D:\\work\\external",
      source: "vscode",
      status: "active",
      lastTurnId: "turn_external",
      lastTurnStatus: "inProgress",
    });
    const action = {
      actionId: "stop-card-active",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: { action: "session_stop", sessionId: "active_external" },
    };

    await controller.onCardAction(action);
    await controller.onCardAction(action);

    expect(runtime.interruptRemoteTurn).toHaveBeenCalledOnce();
    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("active_external", "turn_external");
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "已发送停止信号，任务会自动停止。",
    );
    expect(outbound.updateInteractiveCard).toHaveBeenCalledOnce();
    const updatedCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(updatedCard);
    expect(serialized).toContain('"content":"Switch"');
    expect(sessionOverflowActions(updatedCard, store, "om_sessions")).toContainEqual(expect.objectContaining({
      action: "session_switch",
      sessionId: "agent-runtime:codex:active_external",
      page: "0",
    }));
    expect(sessionOverflowActions(updatedCard, store, "om_sessions")).not.toContainEqual(expect.objectContaining({
      action: "session_stop",
      sessionId: "agent-runtime:codex:active_external",
    }));
  });

  test("archives an idle task from the sessions card and clears the current binding", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({
      localSessionId: "archive_local",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: "D:\\work\\archive",
      status: "ready",
    });
    store.updateRuntimeSession("archive_local", {
      runtimeKind: "codex",
      remoteSessionId: "archive_remote",
      title: "Archive me",
    });
    store.setCurrentSession("chat_id:c1", "archive_local");
    remoteSessions.push({
      id: "archive_remote",
      title: "Archive me",
      cwd: "D:\\work\\archive",
      source: "agent-bot",
      status: "idle",
    });

    await controller.onMessage(message("/sessions"));
    const initialCard = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(sessionOverflowActions(initialCard, store)).toContainEqual(expect.objectContaining({
      action: "session_archive",
      sessionId: "agent-runtime:codex:archive_remote",
    }));

    await controller.onCardAction({
      actionId: "archive-card-task",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: {
        action: "session_archive",
        sessionId: "agent-runtime:codex:archive_remote",
        page: "0",
        contextKey: "chat_id:c1",
      },
    });

    expect(runtime.archiveRemoteSession).toHaveBeenCalledWith("archive_remote");
    expect(store.getSession("archive_local")?.status).toBe("closed");
    expect(store.getUserContext("chat_id:c1")?.currentSessionId).toBeUndefined();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "已归档任务：Archive me\n当前会话已没有绑定任务，直接发送消息即可创建新任务。",
    );
    const updatedCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(JSON.stringify(updatedCard)).not.toContain("Archive me");
  });

  test("archives the current task with the archive command", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({
      localSessionId: "archive_command_local",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: "D:\\work\\archive-command",
      status: "ready",
    });
    store.updateRuntimeSession("archive_command_local", {
      runtimeKind: "codex",
      remoteSessionId: "archive_command_remote",
      title: "Archive command",
    });
    store.setCurrentSession("chat_id:c1", "archive_command_local");
    remoteSessions.push({
      id: "archive_command_remote",
      title: "Archive command",
      cwd: "D:\\work\\archive-command",
      source: "agent-bot",
      status: "idle",
    });

    await controller.onMessage(message("/archive"));

    expect(runtime.archiveRemoteSession).toHaveBeenCalledWith("archive_command_remote");
    expect(store.getSession("archive_command_local")?.status).toBe("closed");
    expect(store.getUserContext("chat_id:c1")?.currentSessionId).toBeUndefined();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "已归档任务：Archive command\n当前会话已没有绑定任务，直接发送消息即可创建新任务。",
    );
  });

  test("confirms, archives, and dissolves the current group with dismiss", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    const contextKey = "chat_id:oc_dismiss";
    store.recordChatContext(contextKey, "group");
    store.getOrCreateUserContext(contextKey, "codex");
    store.createSession({
      localSessionId: "dismiss_local",
      contextKey,
      agentName: "codex",
      cwd: "D:\\work\\dismiss",
      status: "ready",
    });
    store.updateRuntimeSession("dismiss_local", {
      runtimeKind: "codex",
      remoteSessionId: "dismiss_remote",
      title: "Dismiss task",
    });
    store.setCurrentSession(contextKey, "dismiss_local");
    remoteSessions.push({
      id: "dismiss_remote",
      title: "Dismiss task",
      cwd: "D:\\work\\dismiss",
      source: "agent-bot",
      status: "idle",
    });

    await controller.onMessage({
      ...groupMessage("oc_dismiss", "/dismiss"),
      userId: "ou_owner",
    });

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(card).toMatchObject({ config: { width_mode: "compact" } });
    expect(JSON.stringify(card)).toContain("group_dismiss_confirm");
    expect(runtime.archiveRemoteSession).not.toHaveBeenCalled();
    expect(outbound.deleteGroup).not.toHaveBeenCalled();

    await controller.onCardAction({
      actionId: "dismiss-confirm",
      contextKey,
      userId: "ou_owner",
      messageId: "om_dismiss_card",
      value: {
        action: "group_dismiss_confirm",
        contextKey,
        sessionId: "dismiss_local",
        requestedBy: "ou_owner",
      },
    });

    expect(runtime.archiveRemoteSession).toHaveBeenCalledWith("dismiss_remote");
    expect(outbound.deleteGroup).toHaveBeenCalledWith("oc_dismiss");
    expect(store.getSession("dismiss_local")?.status).toBe("closed");
    expect(store.getChatContext(contextKey)).toBeUndefined();
    expect(store.getUserContext(contextKey)).toBeUndefined();
  });

  test("keeps the group when dismiss confirmation is cancelled", async () => {
    const { controller, outbound, store } = fixture();
    const contextKey = "chat_id:oc_keep";
    store.recordChatContext(contextKey, "group");

    await controller.onCardAction({
      actionId: "dismiss-keep",
      contextKey,
      userId: "ou_owner",
      messageId: "om_dismiss_card",
      value: {
        action: "group_dismiss_keep",
        contextKey,
        sessionId: "session_unused",
        requestedBy: "ou_owner",
      },
    });

    expect(outbound.deleteGroup).not.toHaveBeenCalled();
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith(
      "om_dismiss_card",
      expect.objectContaining({ config: expect.objectContaining({ width_mode: "compact" }) }),
    );
    expect(store.getChatContext(contextKey)).toBeDefined();
  });

  test("forks a completed task from the sessions card and refreshes the current task", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    remoteSessions.push({
      id: "card_fork_source",
      title: "Card fork source",
      cwd: "D:\\work\\card-fork-source",
      source: "desktop",
      status: "idle",
      lastTurnId: "turn_card_fork_source",
      lastTurnStatus: "completed",
    });
    await controller.onMessage(message("/sessions"));

    await controller.onCardAction({
      actionId: "fork-card-task",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: {
        action: "session_fork",
        sessionId: "card_fork_source",
        page: "0",
        contextKey: "chat_id:c1",
      },
    });

    const forkedSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: forkedSessionId,
      remoteSessionId: "card_fork_source",
      lastTurnId: "turn_card_fork_source",
      title: "Card fork source（分支 1）",
    }));
    expect(store.getSession(forkedSessionId!)).toMatchObject({
      remoteSessionId: "card_fork_source_fork",
      title: "Card fork source（分支 1）",
    });
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_sessions", expect.any(Object));
    const updatedCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(JSON.stringify(updatedCard)).toContain("Card fork source（分支 1）");
  });

  test("creates and switches to a new task in the selected sessions-card project", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    const cwd = path.resolve("test-workspaces", "card-new-source");
    remoteSessions.push({
      id: "card_new_source",
      title: "Card new source",
      cwd,
      source: "desktop",
      status: "active",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
      lastTurnId: "turn_card_new_source",
      lastTurnStatus: "inProgress",
    });
    await controller.onMessage(message("/sessions"));

    await controller.onCardAction({
      actionId: "new-card-task",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: {
        action: "session_new",
        sessionId: "card_new_source",
        page: "0",
        contextKey: "chat_id:c1",
      },
    });

    const createdSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: createdSessionId,
      agentName: "codex",
      cwd,
      title: undefined,
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
    }));
    expect(store.getSession(createdSessionId!)).toMatchObject({
      remoteSessionId: "thr_1",
      cwd,
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
      status: "ready",
    });
    expect(runtime.interruptRemoteTurn).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("已创建 Codex 任务"),
    );
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_sessions", expect.any(Object));
  });

  test("creates a new group and task in the selected sessions-card project", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    const cwd = path.resolve("test-workspaces", "card-new-group-source");
    remoteSessions.push({
      id: "card_new_group_source",
      title: "Card new group source",
      cwd,
      source: "desktop",
      status: "idle",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
      lastTurnId: "turn_card_new_group_source",
      lastTurnStatus: "completed",
    });
    await controller.onMessage(message("/sessions"));

    await controller.onCardAction({
      actionId: "new-group-card-task",
      contextKey: "chat_id:c1",
      userId: "ou_current_user",
      messageId: "om_sessions",
      value: {
        action: "session_new_group",
        sessionId: "card_new_group_source",
        page: "0",
        contextKey: "chat_id:c1",
      },
    });

    const groupInput = (outbound.createGroup as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(groupInput).toEqual(expect.objectContaining({
      name: expect.stringMatching(/^\[codex\] \[[^\]]+\] 新任务 \(\d{2}-\d{2}\)$/u),
      userOpenId: "ou_current_user",
      avatarPng: expect.any(Uint8Array),
    }));
    const taskTitle = groupInput?.name.replace(/^\[codex\] \[[^\]]+\] /u, "");
    expect(taskTitle).toMatch(/^新任务 \(\d{2}-\d{2}\)$/u);
    const groupSessionId = store.getUserContext("chat_id:oc_new_group")?.currentSessionId;
    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: groupSessionId,
      agentName: "codex",
      cwd,
      title: taskTitle,
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
    }));
    expect(store.getSession(groupSessionId!)).toMatchObject({
      contextKey: "chat_id:oc_new_group",
      cwd,
      title: taskTitle,
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
      status: "ready",
    });
    expect(store.getUserContext("chat_id:c1")?.currentSessionId).toBeUndefined();
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_sessions", expect.any(Object));
  });

  test("forks a selected sessions-card task into a new group", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    const cwd = path.resolve("test-workspaces", "card-fork-group-source");
    remoteSessions.push({
      id: "card_fork_group_source",
      title: "Card fork group source",
      cwd,
      source: "desktop",
      status: "idle",
      lastTurnId: "turn_card_fork_group_source",
      lastTurnStatus: "completed",
    });
    await controller.onMessage(message("/sessions"));

    await controller.onCardAction({
      actionId: "fork-group-card-task",
      contextKey: "chat_id:c1",
      userId: "ou_current_user",
      messageId: "om_sessions",
      value: {
        action: "session_fork_group",
        sessionId: "card_fork_group_source",
        page: "0",
        contextKey: "chat_id:c1",
      },
    });

    expect(outbound.createGroup).toHaveBeenCalledWith(expect.objectContaining({
      name: expect.stringContaining("Card fork group source（分支 1）"),
      userOpenId: "ou_current_user",
      avatarPng: expect.any(Uint8Array),
    }));
    const groupSessionId = store.getUserContext("chat_id:oc_new_group")?.currentSessionId;
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: groupSessionId,
      remoteSessionId: "card_fork_group_source",
      lastTurnId: "turn_card_fork_group_source",
      cwd,
      title: "Card fork group source（分支 1）",
    }));
    expect(store.getSession(groupSessionId!)).toMatchObject({
      contextKey: "chat_id:oc_new_group",
      remoteSessionId: "card_fork_group_source_fork",
      lastTurnId: "turn_card_fork_group_source",
      lastTurnStatus: "completed",
      status: "ready",
    });
    expect(store.getUserContext("chat_id:c1")?.currentSessionId).toBeUndefined();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("已将指定任务 Fork 到飞书群"),
    );
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_sessions", expect.any(Object));
  });

  test("inherits locally tracked execution settings when the remote task omits them", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    const cwd = path.resolve("test-workspaces", "locally-tracked-source");
    store.createSession({
      localSessionId: "local_card_new_source",
      contextKey: "chat_id:source",
      agentName: "codex",
      cwd,
      status: "ready",
    });
    store.updateRuntimeSession("local_card_new_source", {
      runtimeKind: "codex",
      remoteSessionId: "locally_tracked_source",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      permissionMode: "auto",
    });
    remoteSessions.push({
      id: "locally_tracked_source",
      cwd,
      source: "agent-bot",
      status: "idle",
    });

    await controller.onCardAction({
      actionId: "new-locally-tracked-card-task",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: {
        action: "session_new",
        sessionId: "locally_tracked_source",
        page: "0",
        contextKey: "chat_id:c1",
      },
    });

    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      permissionMode: "auto",
    }));
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_sessions", expect.any(Object));
  });

  test("forks an active task from its latest completed turn through the sessions card", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    remoteSessions.push({
      id: "active_card_fork_source",
      title: "Active card fork source",
      cwd: "D:\\work\\active-card-fork-source",
      source: "desktop",
      status: "active",
      lastTurnId: "turn_still_running",
      lastCompletedTurnId: "turn_latest_completed",
      lastTurnStatus: "inProgress",
    });
    await controller.onMessage(message("/sessions"));

    await controller.onCardAction({
      actionId: "fork-active-card-task",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: {
        action: "session_fork",
        sessionId: "active_card_fork_source",
        page: "0",
        contextKey: "chat_id:c1",
      },
    });

    const forkedSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: forkedSessionId,
      remoteSessionId: "active_card_fork_source",
      lastTurnId: "turn_latest_completed",
      title: "Active card fork source（分支 1）",
    }));
    expect(store.getSession(forkedSessionId!)).toMatchObject({
      remoteSessionId: "active_card_fork_source_fork",
      status: "ready",
      lastTurnId: "turn_latest_completed",
      lastTurnStatus: "completed",
    });
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("已从指定任务最近已完成轮次创建分支"),
    );
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_sessions", expect.any(Object));
  });

  test("pages through ten tasks at a time in the same sessions card", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    for (let index = 1; index <= 22; index += 1) {
      remoteSessions.push({
        id: `task_${index}`,
        title: `Task ${index}`,
        cwd: "D:\\work\\shared",
        source: "vscode",
        status: "idle",
        updatedAt: 100 - index,
      });
    }

    await controller.onMessage(message("/sessions"));

    const initialCard = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const initial = JSON.stringify(initialCard);
    const initialPanels = (initialCard as { body: { elements: Array<Record<string, unknown>> } })
      .body.elements.filter((item) => item.tag === "collapsible_panel");
    expect(initialPanels).toHaveLength(10);
    expect(JSON.stringify(initialPanels[0]?.header)).toContain("1. Task 1 · codex");
    expect(JSON.stringify(initialPanels.at(-1)?.header)).toContain("10. Task 10 · codex");
    expect(initial).toContain("<font color='blue'>Next</font>");
    expect(sessionOverflowActions(initialCard, store)).toContainEqual(expect.objectContaining({
      action: "session_page",
      page: "1",
    }));
    expect(initial).not.toContain("<font color='blue'>Previous</font>");
    expect(initial).toContain("> 项目菜单：**New** 新建任务，**NewGroup** 新建群。");
    expect(initial).toContain("> 任务详情：**Switch** 切换，**Stop** 停止，**Fork** / **ForkGroup** 创建分支，**Status** 查看状态，**Archive** 归档。");
    expect(initial.indexOf("<font color='blue'>Next</font>")).toBeLessThan(
      initial.indexOf("> 项目菜单：**New** 新建任务"),
    );

    await controller.onCardAction({
      actionId: "sessions-next-page",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: { action: "session_page", page: "1" },
    });

    expect(runtime.listRemoteSessions).toHaveBeenLastCalledWith({ searchTerm: undefined, limit: 20 });
    const secondPageCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const secondPage = JSON.stringify(secondPageCard);
    const secondPagePanels = (secondPageCard as { body: { elements: Array<Record<string, unknown>> } })
      .body.elements.filter((item) => item.tag === "collapsible_panel");
    const secondPageProjectRow = (secondPageCard as { body: { elements: Array<Record<string, unknown>> } })
      .body.elements.find((item) => JSON.stringify(item).includes("📁"));
    expect(secondPagePanels.map((item) => JSON.stringify(item.header))).toEqual([
      expect.stringContaining("11. Task 11 · codex"),
      expect.stringContaining("12. Task 12 · codex"),
      expect.stringContaining("13. Task 13 · codex"),
      expect.stringContaining("14. Task 14 · codex"),
      expect.stringContaining("15. Task 15 · codex"),
      expect.stringContaining("16. Task 16 · codex"),
      expect.stringContaining("17. Task 17 · codex"),
      expect.stringContaining("18. Task 18 · codex"),
      expect.stringContaining("19. Task 19 · codex"),
      expect.stringContaining("20. Task 20 · codex"),
    ]);
    expect(sessionOverflowActions(secondPageProjectRow, store, "om_sessions")).toContainEqual(expect.objectContaining({
      action: "session_new",
      sessionId: "agent-runtime:codex:task_1",
    }));
    expect(secondPage).toContain("<font color='blue'>Previous</font>");
    expect(secondPage).toContain("<font color='blue'>Next</font>");

    await controller.onCardAction({
      actionId: "sessions-previous-page",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: { action: "session_page", page: "0" },
    });
    const firstPageAgain = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[1]?.[1];
    const firstPageAgainPanels = (firstPageAgain as { body: { elements: Array<Record<string, unknown>> } })
      .body.elements.filter((item) => item.tag === "collapsible_panel");
    expect(firstPageAgainPanels.map((item) => JSON.stringify(item.header))).toHaveLength(10);
    expect(JSON.stringify(firstPageAgainPanels.at(-1)?.header)).toContain("10. Task 10 · codex");
  });

  test("stops an external task even when another context has a local route for it", async () => {
    const { controller, remoteSessions, runtime, store } = fixture();
    store.createSession({
      localSessionId: "other_context_route",
      contextKey: "chat_id:c2",
      agentName: "codex",
      cwd: "D:\\work\\external",
      status: "ready",
    });
    store.updateRuntimeSession("other_context_route", {
      runtimeKind: "codex",
      remoteSessionId: "shared_external",
    });
    remoteSessions.push({
      id: "shared_external",
      title: "External build",
      cwd: "D:\\work\\external",
      source: "vscode",
      status: "active",
      lastTurnId: "turn_shared",
      lastTurnStatus: "inProgress",
    });

    await controller.onCardAction({
      actionId: "stop-card-cross-context",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: { action: "session_stop", sessionId: "shared_external" },
    });

    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("shared_external", "turn_shared");
  });

  test("uses the remote terminal state instead of a stale local running state", async () => {
    const { controller, remoteSessions, outbound, store } = fixture();
    store.createSession({
      localSessionId: "stale_running",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: "D:\\work\\stale",
      status: "running",
    });
    store.updateRuntimeSession("stale_running", {
      runtimeKind: "codex",
      remoteSessionId: "remote_completed",
      lastTurnId: "turn_completed",
      lastTurnStatus: "running",
    });
    remoteSessions.push({
      id: "remote_completed",
      title: "Completed elsewhere",
      cwd: "D:\\work\\stale",
      source: "vscode",
      status: "not_loaded",
      lastTurnId: "turn_completed",
      lastTurnStatus: "completed",
      lastUserPrompt: "Verify the completed task",
    });

    await controller.onMessage(message("/sessions"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("Verify the completed task");
    expect(serialized).not.toContain("remote_completed");
    expect(serialized).not.toContain("未加载");
    expect(serialized).not.toContain("个活跃");
  });

  test("always lists the current task before other active tasks", async () => {
    const { controller, remoteSessions, outbound, store } = fixture();
    await controller.onMessage(message("/new"));
    remoteSessions.push({
      id: "active_external",
      title: "Running elsewhere",
      cwd: "D:\\work",
      source: "vscode",
      status: "active",
      lastTurnStatus: "inProgress",
      updatedAt: Date.now() + 1_000,
    });

    await controller.onMessage(message("/sessions"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    const actions = sessionOverflowActions(card, store);
    expect(serialized.indexOf("新任务")).toBeLessThan(serialized.indexOf("Running elsewhere"));
    expect(actions).not.toContainEqual(expect.objectContaining({ action: "session_switch", sessionId: "agent-runtime:codex:thr_1" }));
    expect(actions).not.toContainEqual(expect.objectContaining({ action: "session_stop", sessionId: "agent-runtime:codex:thr_1" }));
    expect(actions).toContainEqual(expect.objectContaining({ action: "session_fork", sessionId: "agent-runtime:codex:thr_1" }));
    expect(actions).toContainEqual(expect.objectContaining({ action: "session_status", sessionId: "agent-runtime:codex:thr_1" }));
    expect(actions).toContainEqual(expect.objectContaining({ action: "session_status", sessionId: "agent-runtime:codex:active_external" }));
  });

  test("switches by the one-based order from the last sessions list", async () => {
    const { controller, remoteSessions, outbound, store } = fixture();
    await controller.onMessage(message("/new"));
    remoteSessions.push({
      id: "external_second",
      title: "Second task",
      cwd: "D:\\work\\second",
      source: "vscode",
      status: "idle",
      updatedAt: Date.now(),
    });

    await controller.onMessage(message("/sessions"));
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("1. ✅ 未命名任务 · codex");
    expect(serialized).toContain("2. Second task · codex");
    await controller.onMessage(message("/switch 2"));

    const context = store.getOrCreateUserContext("chat_id:c1", "codex");
    expect(context.currentSessionId).toBeDefined();
    const currentId = context.currentSessionId;
    expect(store.getSession(currentId!)?.remoteSessionId).toBe("external_second");
  });

  test("switches from a sessions card callback and refreshes the current marker", async () => {
    const { controller, remoteSessions, outbound, store } = fixture();
    remoteSessions.push({
      id: "external_card_switch",
      title: "Card target",
      cwd: "D:\\work\\card-target",
      source: "vscode",
      status: "idle",
    });

    await controller.onCardAction({
      actionId: "switch-card-task",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: { action: "session_switch", sessionId: "external_card_switch" },
    });

    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", expect.stringContaining("已切换到任务"));
    const context = store.getOrCreateUserContext("chat_id:c1", "codex");
    expect(context.currentSessionId).toBeDefined();
    const currentId = context.currentSessionId;
    expect(store.getSession(currentId!)?.remoteSessionId).toBe("external_card_switch");
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_sessions", expect.any(Object));
    const updatedCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(JSON.stringify(updatedCard)).toContain("✅");
  });

  test("shows task status from a sessions card without switching tasks", async () => {
    const { controller, remoteSessions, outbound, store } = fixture();
    remoteSessions.push({
      id: "status_target",
      title: "Status target",
      cwd: "D:\\work\\status-target",
      source: "vscode",
      status: "idle",
      lastTurnId: "turn_status",
      lastTurnStatus: "completed",
      finalResponse: "Status result",
    });

    await controller.onCardAction({
      actionId: "sessions-task-status",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: { action: "session_status", sessionId: "status_target" },
    });

    expect(store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId).toBeUndefined();
    expect(outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("Agent 状态：Status target");
    expect(serialized).toContain("status_target");
    expect(serialized).toContain("Status result");
    expect(serialized).toContain('"element_id":"status_execution_details"');
    expect(serialized).toContain('"expanded":false');
    expect(serialized.indexOf("最终结果")).toBeLessThan(serialized.indexOf('"element_id":"status_execution_details"'));
    expect(serialized).toContain("<font color='blue'>Refresh</font>");
    expect(serialized).toContain('"action":"session_status_refresh","sessionId":"agent-runtime:codex:status_target","cardView":"status"');
    expect(serialized).toContain("<font color='blue'>Switch</font>");
    expect(serialized).toContain('"action":"session_switch","sessionId":"agent-runtime:codex:status_target","cardView":"status"');
  });

  test("refreshes a status card in place with the latest task state", async () => {
    const { controller, remoteSessions, outbound } = fixture();
    remoteSessions.push({
      id: "refresh_status_target",
      title: "Refresh status target",
      cwd: "D:\\work\\refresh-status",
      source: "vscode",
      status: "idle",
      lastTurnId: "turn_before_refresh",
      lastTurnStatus: "completed",
      finalResponse: "Result before refresh",
    });

    await controller.onCardAction({
      actionId: "show-refreshable-status",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: { action: "session_status", sessionId: "refresh_status_target" },
    });
    Object.assign(remoteSessions[0]!, {
      status: "active",
      lastTurnId: "turn_after_refresh",
      lastTurnStatus: "inProgress",
      lastActivity: "Running after refresh",
      finalResponse: undefined,
    });

    await controller.onCardAction({
      actionId: "refresh-task-status",
      contextKey: "chat_id:c1",
      messageId: "om_status",
      value: {
        action: "session_status_refresh",
        sessionId: "refresh_status_target",
        cardView: "status",
        contextKey: "chat_id:c1",
      },
    });

    expect(outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_status", expect.any(Object));
    const refreshedCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(refreshedCard);
    expect(serialized).toContain("turn_after_refresh");
    expect(serialized).toContain("Running after refresh");
    expect(serialized).toContain('"action":"session_status_refresh","sessionId":"agent-runtime:codex:refresh_status_target"');
    expect(serialized).toContain('"action":"session_stop","sessionId":"agent-runtime:codex:refresh_status_target"');
    expect(serialized).not.toContain("Result before refresh");
  });

  test("stops an active external task from its status card and changes the action to Switch", async () => {
    const { controller, remoteSessions, runtime, outbound } = fixture();
    remoteSessions.push({
      id: "active_status_target",
      title: "Active status target",
      cwd: "D:\\work\\active-status",
      source: "vscode",
      status: "active",
      lastTurnId: "turn_active_status",
      lastTurnStatus: "inProgress",
    });

    await controller.onCardAction({
      actionId: "show-active-task-status",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: { action: "session_status", sessionId: "active_status_target" },
    });
    const statusCard = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(JSON.stringify(statusCard)).toContain(
      '"action":"session_stop","sessionId":"agent-runtime:codex:active_status_target","cardView":"status"',
    );

    await controller.onCardAction({
      actionId: "stop-from-task-status",
      contextKey: "chat_id:c1",
      messageId: "om_status",
      value: { action: "session_stop", sessionId: "active_status_target", cardView: "status" },
    });

    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("active_status_target", "turn_active_status");
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_status", expect.any(Object));
    const updatedCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(updatedCard);
    expect(serialized).toContain("<font color='blue'>Switch</font>");
    expect(serialized).toContain(
      '"action":"session_switch","sessionId":"agent-runtime:codex:active_status_target","cardView":"status"',
    );
    expect(serialized).not.toContain(
      '"action":"session_stop","sessionId":"agent-runtime:codex:active_status_target","cardView":"status"',
    );
  });

  test("shows Stop on the current running task status card", async () => {
    const { controller, outbound } = fixture();
    await controller.onMessage(message("keep running"));
    await controller.onMessage(message("/status"));

    const statusCard = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(statusCard);
    expect(serialized).toContain("<font color='red'>Stop</font>");
    expect(serialized).toContain('"action":"session_status_refresh","sessionId":"agent-runtime:codex:thr_1","cardView":"status"');
    expect(serialized).toContain('"element_id":"status_execution_details"');
    expect(serialized).toContain('"expanded":false');
    expect(serialized.indexOf("最终结果")).toBeLessThan(serialized.indexOf('"element_id":"status_execution_details"'));
    expect(serialized).toContain(
      '"action":"session_stop","sessionId":"agent-runtime:codex:thr_1","cardView":"status"',
    );
    expect(serialized).not.toContain('"action":"session_switch","sessionId":"agent-runtime:codex:thr_1","cardView":"status"');
  });

  test("switches back to a bot-owned task while its turn is still running", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    await controller.onMessage(message("keep running"));
    const runningTask = store.listSessions("chat_id:c1")[0]!;

    store.createSession({
      localSessionId: "local_idle",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: "D:\\work\\idle",
      status: "ready",
    });
    store.updateRuntimeSession("local_idle", {
      runtimeKind: "codex",
      remoteSessionId: "remote_idle",
      title: "Idle target",
    });
    remoteSessions.push({
      id: "remote_idle",
      title: "Idle target",
      cwd: "D:\\work\\idle",
      source: "vscode",
      status: "idle",
    });

    await controller.onMessage(message("/switch remote_idle"));
    await controller.onMessage(message("/sessions"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const actions = sessionOverflowActions(card, store);
    expect(actions).toContainEqual(expect.objectContaining({
      action: "session_switch",
      sessionId: "agent-runtime:codex:thr_1",
      page: "0",
    }));
    expect(actions).not.toContainEqual(expect.objectContaining({
      action: "session_stop",
      sessionId: "agent-runtime:codex:thr_1",
    }));

    await controller.onCardAction({
      actionId: "switch-back-running-bot-task",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: { action: "session_switch", sessionId: "thr_1", page: "0" },
    });

    expect(store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId).toBe(runningTask.localSessionId);
    expect(runtime.interruptRemoteTurn).not.toHaveBeenCalled();
  });

  test("does not switch back when the active turn was triggered outside agent-bot", async () => {
    const { controller, remoteSessions, outbound, store } = fixture();
    remoteSessions.push(
      {
        id: "external_origin",
        title: "External origin",
        cwd: "D:\\work\\external-origin",
        source: "vscode",
        status: "idle",
      },
      {
        id: "idle_target",
        title: "Idle target",
        cwd: "D:\\work\\idle-target",
        source: "vscode",
        status: "idle",
      },
    );

    await controller.onMessage({
      messageId: "switch-back-external-turn",
      contextKey: "chat_id:c1",
      text: "/switch external_origin",
    });
    const external = remoteSessions.find((session) => session.id === "external_origin")!;
    external.status = "active";
    external.lastTurnId = "external_turn";
    external.lastTurnStatus = "inProgress";
    await controller.onMessage(message("/switch idle_target"));
    const idleTask = store.findSessionByRemoteSessionId("idle_target")!;
    await controller.onMessage(message("/sessions"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const actions = sessionOverflowActions(card, store);
    expect(actions).toContainEqual(expect.objectContaining({
      action: "session_stop",
      sessionId: "agent-runtime:codex:external_origin",
      page: "0",
    }));
    expect(actions).not.toContainEqual(expect.objectContaining({
      action: "session_switch",
      sessionId: "agent-runtime:codex:external_origin",
    }));

    await controller.onMessage(message("/switch external_origin"));

    expect(store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId).toBe(idleTask.localSessionId);
    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", expect.stringContaining("不会接管或追加消息"));
  });

  test("rejects a switch position that is outside the last sessions list", async () => {
    const { controller, outbound } = fixture();

    await controller.onMessage(message("/sessions"));
    await controller.onMessage(message("/switch 1"));

    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", expect.stringContaining("任务序号超出范围"));
  });

  test("switches to the previous task without an argument and supports toggling back", async () => {
    const { controller, remoteSessions, store } = fixture();
    store.getOrCreateUserContext("chat_id:c1", "codex");
    for (const [localSessionId, remoteSessionId] of [["local_1", "remote_1"], ["local_2", "remote_2"]] as const) {
      store.createSession({
        localSessionId,
        contextKey: "chat_id:c1",
        agentName: "codex",
        cwd: `D:\\work\\${localSessionId}`,
        status: "ready",
      });
      store.updateRuntimeSession(localSessionId, { runtimeKind: "codex", remoteSessionId, title: localSessionId });
      remoteSessions.push({ id: remoteSessionId, title: localSessionId, cwd: `D:\\work\\${localSessionId}`, source: "vscode", status: "idle" });
    }
    store.setCurrentSession("chat_id:c1", "local_1");
    store.setCurrentSession("chat_id:c1", "local_2");

    await controller.onMessage(message("/switch"));
    expect(store.getOrCreateUserContext("chat_id:c1", "codex")).toMatchObject({
      currentSessionId: "local_1",
      previousSessionId: "local_2",
    });

    await controller.onMessage({ messageId: "switch-back", contextKey: "chat_id:c1", text: "/switch" });
    expect(store.getOrCreateUserContext("chat_id:c1", "codex")).toMatchObject({
      currentSessionId: "local_2",
      previousSessionId: "local_1",
    });
  });

  test("explains when switch has no previous task", async () => {
    const { controller, outbound } = fixture();

    await controller.onMessage(message("/switch"));

    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", expect.stringContaining("没有可切换的上一个任务"));
  });

  test("switches to an idle Codex task without resuming it", async () => {
    const { controller, runtime, remoteSessions, store } = fixture();
    remoteSessions.push({
      id: "external_1",
      title: "Desktop task",
      cwd: "D:\\work\\desktop",
      source: "vscode",
      status: "not_loaded",
      lastTurnId: "turn_external",
      lastTurnStatus: "completed",
    });

    await controller.onMessage(message("/switch external_1"));

    const current = store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId;
    expect(current).toBeTruthy();
    expect(store.getSession(current!)).toMatchObject({
      remoteSessionId: "external_1",
      cwd: "D:\\work\\desktop",
      lastTurnId: "turn_external",
      lastTurnStatus: "completed",
    });
    expect(runtime.resumeSession).not.toHaveBeenCalled();
  });

  test("links another chat context to the same canonical Codex task", async () => {
    const { controller, runtime, remoteSessions, store, outbound } = fixture();
    store.getOrCreateUserContext("chat_id:other", "codex");
    store.createSession({
      localSessionId: "other_local",
      contextKey: "chat_id:other",
      agentName: "codex",
      cwd: "D:\\work\\shared",
      status: "ready",
    });
    store.updateRuntimeSession("other_local", {
      runtimeKind: "codex",
      remoteSessionId: "shared_remote",
      title: "Shared Codex task",
      lastTurnId: "turn_shared",
      lastTurnStatus: "completed",
    });
    remoteSessions.push({
      id: "shared_remote",
      title: "Shared Codex task",
      cwd: "D:\\work\\shared",
      source: "agent-bot",
      status: "idle",
      lastTurnId: "turn_shared",
      lastTurnStatus: "completed",
    });

    await controller.onMessage(groupMessage("group_switch", "/switch shared_remote"));

    const current = store.getUserContext("chat_id:group_switch")?.currentSessionId;
    expect(current).toBeDefined();
    expect(current).toBe("other_local");
    expect(store.getSessionForContext(current!, "chat_id:group_switch")).toMatchObject({
      contextKey: "chat_id:group_switch",
      remoteSessionId: "shared_remote",
      status: "ready",
    });
    expect(store.listAllSessions().filter((session) => session.remoteSessionId === "shared_remote"))
      .toHaveLength(1);
    expect(store.findSessionByRemoteSessionId("shared_remote", "chat_id:other")?.localSessionId)
      .toBe("other_local");
    expect(store.findSessionByRemoteSessionId("shared_remote", "chat_id:group_switch")?.localSessionId)
      .toBe(current);
    expect(runtime.resumeSession).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:group_switch",
      expect.stringContaining("已切换到任务：Shared Codex task"),
    );

    await controller.onMessage(groupMessage("group_switch", "/fork"));

    const forked = store.getUserContext("chat_id:group_switch")?.currentSessionId;
    expect(forked).toBeDefined();
    expect(forked).not.toBe("other_local");
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      remoteSessionId: "shared_remote",
      lastTurnId: "turn_shared",
      localSessionId: forked,
    }));
    expect(store.getSession(forked!)).toMatchObject({
      remoteSessionId: "shared_remote_fork",
      contextKey: "chat_id:group_switch",
    });
    expect(store.listAllSessions().filter((session) => session.remoteSessionId === "shared_remote"))
      .toHaveLength(1);
  });

  test("queues a prompt from another chat instead of steering its active turn", async () => {
    const { controller, runtime, store } = fixture();
    await controller.onMessage(message("first chat turn"));

    const task = store.listSessions("chat_id:c1")[0]!;
    store.saveTurnSnapshot("turn_1", task.localSessionId, {
      sessionId: task.localSessionId,
      turnId: "turn_1",
      status: "running",
      startedAt: 1,
      plan: [],
      activities: [],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
    }, "chat_id:c1");

    await controller.onMessage(groupMessage("second", "/switch thr_1"));
    await controller.onMessage(groupMessage("second", "second chat turn"));

    expect(store.getUserContext("chat_id:second")?.currentSessionId).toBe(task.localSessionId);
    expect(runtime.startTurn).toHaveBeenCalledOnce();
    expect(runtime.steerTurn).not.toHaveBeenCalled();
  });

  test("queues multiple /queue and /nosteer prompts, cancels one, and starts the rest in FIFO order", async () => {
    const { controller, runtime, sessions, remoteSessions, outbound, store, listeners } = fixture();
    await controller.onMessage(message("active turn"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;

    await controller.onMessage({ messageId: "nosteer-1", contextKey: "chat_id:c1", text: "/queue run tests" });
    await controller.onMessage({ messageId: "nosteer-2", contextKey: "chat_id:c1", text: "/queue update docs" });
    await controller.onMessage({ messageId: "nosteer-3", contextKey: "chat_id:c1", text: "/nosteer report result" });

    expect(runtime.steerTurn).not.toHaveBeenCalled();
    expect(runtime.startTurn).toHaveBeenCalledOnce();
    expect(store.listQueuedPrompts(sessionId).map((prompt) => prompt.text)).toEqual([
      "run tests",
      "update docs",
      "report result",
    ]);
    expect(outbound.sendInteractiveCard).toHaveBeenCalledTimes(3);
    expect(outbound.updateInteractiveCard).toHaveBeenCalledTimes(2);
    for (const call of (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls) {
      expect(JSON.stringify(call[1])).toContain("排队 Prompt · 已停止");
      expect(JSON.stringify(call[1])).not.toContain("queued_prompt_cancel");
    }
    let card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("排队 Prompt · 3");
    expect(JSON.stringify(card).match(/Cancel/g)).toHaveLength(3);

    const cancelled = store.listQueuedPrompts(sessionId)[1]!;
    await controller.onCardAction({
      actionId: "cancel-nosteer-2",
      contextKey: "chat_id:c1",
      messageId: "card",
      value: {
        action: "queued_prompt_cancel",
        promptId: cancelled.promptId,
        sessionId,
        contextKey: "chat_id:c1",
      },
    });
    expect(store.listQueuedPrompts(sessionId).map((prompt) => prompt.text)).toEqual([
      "run tests",
      "report result",
    ]);
    card = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("排队 Prompt · 2");
    expect(JSON.stringify(card)).not.toContain("update docs");

    sessions.get(sessionId)!.activeTurnId = undefined;
    Object.assign(remoteSessions.find((remote) => remote.id === "thr_1")!, {
      status: "idle",
      lastTurnStatus: "completed",
    });
    for (const listener of listeners) {
      listener({ type: "turn_completed", sessionId, turnId: "turn_1", finalResponse: "done" });
    }
    await vi.waitFor(() => expect(runtime.startTurn).toHaveBeenCalledTimes(2));
    expect((runtime.startTurn as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]).toBe("run tests");
    expect(store.listQueuedPrompts(sessionId).map((prompt) => prompt.text)).toEqual(["report result"]);

    sessions.get(sessionId)!.activeTurnId = undefined;
    Object.assign(remoteSessions.find((remote) => remote.id === "thr_1")!, {
      status: "idle",
      lastTurnStatus: "completed",
    });
    for (const listener of listeners) {
      listener({ type: "turn_completed", sessionId, turnId: "turn_1", finalResponse: "done again" });
    }
    await vi.waitFor(() => expect(runtime.startTurn).toHaveBeenCalledTimes(3));
    expect((runtime.startTurn as ReturnType<typeof vi.fn>).mock.calls[2]?.[1]).toBe("report result");
    expect(store.countQueuedPrompts(sessionId)).toBe(0);
  });

  test("retries a queued prompt when its idle preflight check fails", async () => {
    vi.useFakeTimers();
    const { controller, runtime, sessions, remoteSessions, store } = fixture();
    try {
      await controller.onMessage(message("active turn"));
      const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
      sessions.get(sessionId)!.activeTurnId = undefined;
      Object.assign(remoteSessions.find((remote) => remote.id === "thr_1")!, {
        status: "idle",
        lastTurnStatus: "completed",
      });
      (runtime.inspectRemoteSessionActivity as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("App Server request timed out: thread/read"),
      );

      await controller.controlQueueTaskPrompt(sessionId, "retry after preflight timeout");

      expect(runtime.startTurn).toHaveBeenCalledOnce();
      expect(store.listQueuedPrompts(sessionId).map((prompt) => prompt.text)).toEqual([
        "retry after preflight timeout",
      ]);

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runtime.startTurn).toHaveBeenCalledTimes(2);
      expect((runtime.startTurn as ReturnType<typeof vi.fn>).mock.calls[1]?.[1])
        .toBe("retry after preflight timeout");
      expect(store.countQueuedPrompts(sessionId)).toBe(0);
    } finally {
      controller.close();
      vi.useRealTimers();
    }
  });

  test("refuses to switch or resume a task that is running in another Codex client", async () => {
    const { controller, runtime, remoteSessions, store, outbound } = fixture();
    const external: RemoteSessionSummary = {
      id: "external_active",
      title: "Running elsewhere",
      cwd: "D:\\work\\desktop",
      source: "vscode",
      status: "active",
      lastTurnId: "turn_external",
      lastTurnStatus: "inProgress",
    };
    remoteSessions.push(external);

    await controller.onMessage(message("/switch external_active"));

    expect(store.findSessionByRemoteSessionId("external_active")).toBeUndefined();
    expect(runtime.resumeSession).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", expect.stringContaining("正在外部 Agent 中执行"));

    external.status = "idle";
    external.lastTurnStatus = "completed";
    await controller.onMessage({ messageId: "switch-after-idle", contextKey: "chat_id:c1", text: "/switch external_active" });
    external.status = "active";
    external.lastTurnId = "turn_new_external";
    external.lastTurnStatus = "inProgress";
    await controller.onMessage(message("continue from feishu"));

    expect(runtime.resumeSession).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", expect.stringContaining("不会接管或追加消息"));
  });

  test("handles model, permissions, details, and approval actions", async () => {
    const { controller, runtime, presenter } = fixture();
    await controller.onMessage(message("start"));
    const sessionId = (runtime.startTurn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    await controller.onCardAction({
      actionId: "model-setting",
      contextKey: "chat_id:c1",
      messageId: "om_settings",
      value: { action: "settings_model_select", sessionId, contextKey: "chat_id:c1", model: "gpt-test" },
    });
    await controller.onCardAction({
      actionId: "permission-setting",
      contextKey: "chat_id:c1",
      messageId: "om_settings",
      value: { action: "settings_permission_select", sessionId, contextKey: "chat_id:c1", permissionMode: "confirm" },
    });
    await controller.onCardAction({ actionId: "a1", contextKey: "chat_id:c1", value: { action: "turn_details", turnId: "turn_1" } });
    await controller.onCardAction({
      actionId: "a2",
      contextKey: "chat_id:c1",
      value: { action: "approval", sessionId, requestId: "req_1", decision: "accept" },
    });

    expect(runtime.setModel).toHaveBeenCalledWith(sessionId, "gpt-test");
    expect(runtime.setPermissionMode).toHaveBeenCalledWith(sessionId, "confirm");
    expect(presenter.showDetails).toHaveBeenCalledWith("chat_id:c1", "turn_1");
    expect(runtime.respondToApproval).toHaveBeenCalledWith(sessionId, "req_1", "accept");
  });

  test("switches the thinking card to an in-place activity history page", async () => {
    const { controller, presenter, store } = fixture();
    store.saveTurnSnapshot("turn_history", "s1", {
      sessionId: "s1",
      turnId: "turn_history",
      status: "completed",
      startedAt: 1,
      assistantText: "",
      plan: [],
      activities: [{ kind: "assistant", id: "commentary:1", text: "saved assistant text" }],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
    });

    await controller.onCardAction({
      actionId: "activity-history-page",
      contextKey: "chat_id:c1",
      messageId: "om_thinking_card",
      value: { action: "activity_history", turnId: "turn_history", page: "0" },
    });

    expect(presenter.showActivityPage).toHaveBeenCalledWith(
      "chat_id:c1",
      "turn_history",
      0,
      "om_thinking_card",
    );

    await controller.onCardAction({
      actionId: "activity-history-latest",
      contextKey: "chat_id:c1",
      messageId: "om_thinking_card",
      value: { action: "activity_history", turnId: "turn_history", page: "latest" },
    });
    expect(presenter.showActivityPage).toHaveBeenLastCalledWith(
      "chat_id:c1",
      "turn_history",
      "latest",
      "om_thinking_card",
    );
  });

  test("stops the task identified by a thinking-card callback", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("start stoppable task"));
    const sessionId = (runtime.startTurn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;

    await controller.onCardAction({
      actionId: "stop-thinking-card-task",
      contextKey: "chat_id:c1",
      messageId: "om_thinking_card",
      value: { action: "turn_cancel", sessionId, turnId: "turn_1" },
    });

    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("thr_1", "turn_1");
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "已发送停止信号，任务会自动停止。",
    );
  });

  test("supports local CLI task stop and title controls", async () => {
    const { controller, runtime, store } = fixture();
    await controller.onMessage(message("start task for CLI"));
    const localSessionId = (runtime.startTurn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;

    await expect(controller.controlSetTaskTitle(localSessionId, "CLI title")).resolves.toContain("CLI title");
    expect(runtime.setTitle).toHaveBeenCalledWith(localSessionId, "CLI title");
    expect(store.getSession(localSessionId)?.title).toBe("CLI title");

    await expect(controller.controlStopTask(localSessionId)).resolves.toContain("CLI title");
    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("thr_1", "turn_1");
  });

  test("sends a CLI prompt to the task's existing response context without switching that context", async () => {
    const { controller, runtime, sessions, remoteSessions, outbound, presenter, store } = fixture();
    await controller.onMessage(groupMessage("origin", "start task for targeted CLI prompt"));
    const localSessionId = (runtime.startTurn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const runtimeSession = sessions.get(localSessionId)!;
    runtimeSession.activeTurnId = undefined;
    const remote = remoteSessions.find((candidate) => candidate.id === runtimeSession.remoteSessionId)!;
    remote.status = "idle";
    remote.lastTurnStatus = "completed";
    store.updateSession(localSessionId, { status: "ready" });
    store.saveTurnSnapshot("turn_latest", localSessionId, {}, "chat_id:latest");
    store.updateRuntimeSession(localSessionId, {
      lastTurnId: "turn_latest",
      lastTurnStatus: "completed",
    });
    store.attachSessionToContext("chat_id:latest", localSessionId);
    store.getOrCreateUserContext("chat_id:latest", "codex");
    store.createSession({
      localSessionId: "other_current_task",
      contextKey: "chat_id:latest",
      agentName: "codex",
      cwd: process.cwd(),
      status: "ready",
    });
    store.setCurrentSession("chat_id:latest", "other_current_task");

    await expect(controller.controlSendTaskPrompt(localSessionId, "continue from CLI"))
      .resolves.toContain("Prompt was posted to the original chat");

    expect(outbound.sendText).toHaveBeenLastCalledWith("chat_id:latest", "continue from CLI");
    expect(runtime.startTurn).toHaveBeenLastCalledWith(localSessionId, "continue from CLI");
    expect((outbound.sendText as ReturnType<typeof vi.fn>).mock.invocationCallOrder.at(-1))
      .toBeLessThan((runtime.startTurn as ReturnType<typeof vi.fn>).mock.invocationCallOrder.at(-1)!);
    expect(presenter.registerSession).toHaveBeenLastCalledWith(
      localSessionId,
      "chat_id:latest",
      "start task for targeted CLI prompt",
      expect.any(String),
      "Codex",
    );
    expect(presenter.startPendingTurn).toHaveBeenLastCalledWith(
      localSessionId,
      "chat_id:latest",
      "start task for targeted CLI prompt",
      undefined,
      "continue from CLI",
    );
    expect(store.getUserContext("chat_id:latest")?.currentSessionId).toBe("other_current_task");
  });

  test("uses the live task route when an active turn context has not been persisted yet", async () => {
    const { controller, runtime, sessions, remoteSessions, outbound, outboundRouter, presenter, store } = fixture();
    await controller.onMessage(groupMessage("origin", "start task before route race"));
    const localSessionId = (runtime.startTurn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const runtimeSession = sessions.get(localSessionId)!;
    runtimeSession.activeTurnId = "turn_racing";
    const remote = remoteSessions.find((candidate) => candidate.id === runtimeSession.remoteSessionId)!;
    remote.status = "active";
    remote.lastTurnId = "turn_racing";
    remote.lastTurnStatus = "inProgress";
    store.updateRuntimeSession(localSessionId, {
      lastTurnId: "turn_racing",
      lastTurnStatus: "running",
    });
    store.attachSessionToContext("chat_id:latest", localSessionId);
    outboundRouter.registerSession(localSessionId, "chat_id:latest", "start task before route race", process.cwd());

    await controller.controlSendTaskPrompt(localSessionId, "steer from CLI");

    expect(outbound.sendText).toHaveBeenLastCalledWith("chat_id:latest", "steer from CLI");
    expect(runtime.steerTurn).toHaveBeenCalledWith(localSessionId, "turn_racing", "steer from CLI");
    expect((outbound.sendText as ReturnType<typeof vi.fn>).mock.invocationCallOrder.at(-1))
      .toBeLessThan((runtime.steerTurn as ReturnType<typeof vi.fn>).mock.invocationCallOrder.at(-1)!);
    expect(presenter.registerSession).toHaveBeenLastCalledWith(
      localSessionId,
      "chat_id:latest",
      "start task before route race",
      expect.any(String),
      "Codex",
    );
  });

  test("posts a CLI prompt inside the task's existing thread and anchors the new turn to that post", async () => {
    const { controller, runtime, sessions, remoteSessions, outbound, presenter, store } = fixture();
    await controller.onMessage(groupMessage("origin", "start task before threaded CLI prompt"));
    const localSessionId = store.getUserContext("chat_id:origin")!.currentSessionId!;
    sessions.get(localSessionId)!.activeTurnId = undefined;
    Object.assign(remoteSessions[0]!, { status: "idle", lastTurnStatus: "completed" });
    store.updateSession(localSessionId, { status: "ready" });
    const threadContextKey = "chat_id:group:thread_id:omt_thread";
    store.saveTurnSnapshot("turn_thread", localSessionId, {
      sessionId: localSessionId,
      turnId: "turn_thread",
      status: "completed",
      replyTarget: { messageId: "om_previous", replyInThread: true },
    }, threadContextKey);
    store.updateRuntimeSession(localSessionId, {
      lastTurnId: "turn_thread",
      lastTurnStatus: "completed",
    });
    store.attachSessionToContext(threadContextKey, localSessionId);
    (outbound.replyText as ReturnType<typeof vi.fn>).mockResolvedValueOnce("om_cli_prompt");

    await controller.controlSendTaskPrompt(localSessionId, "continue in this thread");

    expect(outbound.replyText).toHaveBeenCalledWith(
      threadContextKey,
      { messageId: "om_previous", replyInThread: true },
      "continue in this thread",
    );
    expect(runtime.startTurn).toHaveBeenLastCalledWith(localSessionId, "continue in this thread");
    expect(presenter.startPendingTurn).toHaveBeenLastCalledWith(
      localSessionId,
      threadContextKey,
      "start task before threaded CLI prompt",
      { messageId: "om_cli_prompt", replyInThread: true },
      "continue in this thread",
    );
  });

  test("does not start or steer a CLI prompt when posting it to the task route fails", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(groupMessage("origin", "start task before failed CLI post"));
    const localSessionId = store.getUserContext("chat_id:origin")!.currentSessionId!;
    (outbound.sendText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Feishu unavailable"));

    await expect(controller.controlSendTaskPrompt(localSessionId, "must be visible first"))
      .rejects.toThrow("Feishu unavailable");

    expect(runtime.startTurn).toHaveBeenCalledOnce();
    expect(runtime.steerTurn).not.toHaveBeenCalled();
  });

  test("creates a new group and inherited task from an explicit CLI source task", async () => {
    const { controller, runtime, outbound, store } = fixture();
    const sourceProject = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-cli-source-project-"));
    tempDirs.push(sourceProject);
    await controller.onMessage(groupMessage(
      "origin",
      `/new Source --dir "${sourceProject}"`,
    ));
    const sourceSessionId = store.getUserContext("chat_id:origin")!.currentSessionId!;
    const source = store.getSession(sourceSessionId)!;

    const created = await controller.controlCreateTaskGroup(
      sourceSessionId,
      "CLI review room",
      "ou_cli_user",
    );

    expect(outbound.createGroup).toHaveBeenCalledWith({
      name: expect.stringContaining("CLI review room"),
      userOpenId: "ou_cli_user",
      avatarPng: expect.any(Uint8Array),
    });
    expect(created).toMatchObject({
      sourceLocalSessionId: sourceSessionId,
      group: {
        chatId: "oc_new_group",
        contextKey: "chat_id:oc_new_group",
        name: expect.stringContaining("CLI review room"),
      },
      task: {
        contextKey: "chat_id:oc_new_group",
        agentName: source.agentName,
        cwd: sourceProject,
        modelProvider: source.modelProvider,
        model: source.model,
        reasoningEffort: source.reasoningEffort,
        permissionMode: source.permissionMode,
        title: "CLI review room",
      },
    });
    expect(store.getUserContext("chat_id:origin")?.currentSessionId).toBe(sourceSessionId);
    expect(store.getUserContext("chat_id:oc_new_group")?.currentSessionId)
      .toBe(created.task.localSessionId);
    expect(runtime.createSession).toHaveBeenCalledTimes(2);
  });

  test("lets CLI newgroup override the project directory and expand home shorthand", async () => {
    const { controller, runtime, outbound, store } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-cli-newgroup-home-"));
    const sourceProject = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-cli-source-project-"));
    const selectedProject = path.join(home, "work", "demo");
    fs.mkdirSync(selectedProject, { recursive: true });
    tempDirs.push(home, sourceProject);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    await controller.onMessage(groupMessage(
      "origin",
      `/new Source --dir "${sourceProject}"`,
    ));
    const sourceSessionId = store.getUserContext("chat_id:origin")!.currentSessionId!;

    const created = await controller.controlCreateTaskGroup(
      sourceSessionId,
      "CLI home project",
      "ou_cli_user",
      "~/work/demo",
    );

    expect(created.task.cwd).toBe(selectedProject);
    expect(store.getUserContext("chat_id:oc_new_group")?.boundProjectCwd).toBe(selectedProject);
    expect(runtime.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      cwd: selectedProject,
      title: "CLI home project",
    }));
    expect(outbound.createGroup).toHaveBeenLastCalledWith({
      name: `[codex] [work${path.sep}demo] CLI home project`,
      userOpenId: "ou_cli_user",
      avatarPng: expect.any(Uint8Array),
    });
  });

  test("lets CLI newgroup force a Projectless task instead of inheriting the project", async () => {
    const { controller, runtime, outbound, store } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-cli-newgroup-home-"));
    const sourceProject = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-cli-source-project-"));
    tempDirs.push(home, sourceProject);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    await controller.onMessage(groupMessage(
      "origin",
      `/new Source --dir "${sourceProject}"`,
    ));
    const sourceSessionId = store.getUserContext("chat_id:origin")!.currentSessionId!;

    const created = await controller.controlCreateTaskGroup(
      sourceSessionId,
      "CLI Projectless room",
      "ou_cli_user",
      undefined,
      true,
    );

    expect(created.task.cwd.startsWith(path.join(home, "Documents", "Codex"))).toBe(true);
    expect(store.getUserContext("chat_id:oc_new_group")?.boundProjectCwd).toBeUndefined();
    expect(runtime.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      cwd: created.task.cwd,
      title: "CLI Projectless room",
    }));
    expect(outbound.createGroup).toHaveBeenLastCalledWith({
      name: "[codex] CLI Projectless room",
      userOpenId: "ou_cli_user",
      avatarPng: expect.any(Uint8Array),
    });
  });

  test("creates a CLI newgroup with an explicitly selected Agent and its runtime defaults", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(groupMessage("origin", "start source task for another Agent"));
    const sourceSessionId = store.getUserContext("chat_id:origin")!.currentSessionId!;
    store.updateRuntimeSession(sourceSessionId, {
      modelProvider: "azure",
      model: "gpt-next",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
    });

    const created = await controller.controlCreateTaskGroup(
      sourceSessionId,
      "ACP review room",
      "ou_cli_user",
      undefined,
      false,
      "acp",
    );

    expect(outbound.createGroup).toHaveBeenCalledWith({
      name: "[acp] ACP review room",
      userOpenId: "ou_cli_user",
      avatarPng: expect.any(Uint8Array),
    });
    expect(created.task).toMatchObject({
      contextKey: "chat_id:oc_new_group",
      agentName: "acp",
      modelProvider: "openai",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "auto",
      title: "ACP review room",
    });
    const createInput = (runtime.createSession as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(createInput).toMatchObject({
      agentName: "acp",
      title: "ACP review room",
    });
    expect(createInput.modelProvider).toBeUndefined();
    expect(createInput.model).toBeUndefined();
    expect(createInput.reasoningEffort).toBeUndefined();
    expect(createInput.permissionMode).toBe("auto");
    expect(store.getUserContext("chat_id:origin")?.currentSessionId).toBe(sourceSessionId);
  });

  test("forks an explicit CLI source task into a group without switching the source context", async () => {
    const { controller, runtime, sessions, remoteSessions, outbound, store, listeners } = fixture();
    await controller.onMessage(groupMessage("origin", "start source task for CLI forkgroup"));
    const sourceSessionId = store.getUserContext("chat_id:origin")!.currentSessionId!;
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId,
        turnId: "turn_1",
        finalResponse: "source complete",
      });
    }
    sessions.get(sourceSessionId)!.activeTurnId = undefined;
    const remote = remoteSessions.find((session) => session.id === "thr_1")!;
    remote.status = "idle";
    remote.lastTurnId = "turn_1";
    remote.lastTurnStatus = "completed";

    const created = await controller.controlForkTaskGroup(
      sourceSessionId,
      "CLI parallel fix",
      "ou_cli_user",
    );

    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      remoteSessionId: "thr_1",
      lastTurnId: "turn_1",
      title: "CLI parallel fix",
    }));
    expect(outbound.createGroup).toHaveBeenCalledWith({
      name: expect.stringContaining("CLI parallel fix"),
      userOpenId: "ou_cli_user",
      avatarPng: expect.any(Uint8Array),
    });
    expect(created).toMatchObject({
      sourceLocalSessionId: sourceSessionId,
      sourceTurnId: "turn_1",
      group: { chatId: "oc_new_group", contextKey: "chat_id:oc_new_group" },
      task: { contextKey: "chat_id:oc_new_group", title: "CLI parallel fix" },
    });
    expect(store.getUserContext("chat_id:origin")?.currentSessionId).toBe(sourceSessionId);
    expect(store.getUserContext("chat_id:oc_new_group")?.currentSessionId)
      .toBe(created.task.localSessionId);
  });

  test("supports targeted CLI new, queue, fork, and switch controls", async () => {
    const { controller, runtime, sessions, remoteSessions, store, listeners } = fixture();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-cli-task-project-"));
    tempDirs.push(project);
    await controller.onMessage(groupMessage("origin", `/new Source --dir "${project}"`));
    const sourceSessionId = store.getUserContext("chat_id:origin")!.currentSessionId!;

    const created = await controller.controlCreateTask(sourceSessionId, "CLI child");
    expect(created).toMatchObject({ contextKey: "chat_id:origin", cwd: project, title: "CLI child" });
    expect(store.getUserContext("chat_id:origin")?.currentSessionId).toBe(created.localSessionId);

    const queued = await controller.controlQueueTaskPrompt(created.localSessionId, "run after this turn");
    expect(queued.queued).toBeGreaterThanOrEqual(0);
    expect(runtime.startTurn).toHaveBeenCalledWith(created.localSessionId, "run after this turn");

    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: created.localSessionId,
        turnId: "turn_1",
        finalResponse: "done",
      });
    }
    sessions.get(created.localSessionId)!.activeTurnId = undefined;
    const remote = remoteSessions.find((candidate) => candidate.id === created.remoteSessionId)!;
    Object.assign(remote, { status: "idle", lastTurnId: "turn_1", lastTurnStatus: "completed" });

    const forked = await controller.controlForkTask(created.localSessionId);
    expect(forked.sourceTurnId).toBe("turn_1");
    expect(forked.task.localSessionId).not.toBe(created.localSessionId);
    expect(store.getUserContext("chat_id:origin")?.currentSessionId).toBe(forked.task.localSessionId);

    await controller.controlSwitchTask(forked.task.localSessionId, created.localSessionId);
    expect(store.getUserContext("chat_id:origin")?.currentSessionId).toBe(created.localSessionId);
  });

  test("uses the selected Agent defaults when a new task does not inherit execution settings", async () => {
    const { controller, runtime, config, store } = fixture();
    await controller.onMessage(groupMessage("origin", "/new Source"));
    const sourceSessionId = store.getUserContext("chat_id:origin")!.currentSessionId!;
    config.agents.acp!.defaults = {
      modelProvider: "acp-provider",
      model: "acp-model",
      reasoningEffort: "medium",
      permissionMode: "confirm",
    };

    const created = await controller.controlCreateTask(
      sourceSessionId,
      "ACP defaults",
      undefined,
      false,
      "acp",
    );

    expect(created.agentName).toBe("acp");
    expect(runtime.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      agentName: "acp",
      modelProvider: "acp-provider",
      model: "acp-model",
      reasoningEffort: "medium",
      permissionMode: "confirm",
    }));
  });

  test("supports targeted CLI Agent, execution setting, Goal, mute, shell, and directory controls", async () => {
    const { controller, runtime, outbound, shellCommandExecutor, store } = fixture();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-cli-controls-"));
    fs.mkdirSync(path.join(project, "src"));
    fs.writeFileSync(path.join(project, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    fs.writeFileSync(path.join(project, "readable.bin"), "plain text despite its extension\n");
    fs.writeFileSync(path.join(project, "binary.txt"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    tempDirs.push(project);
    await controller.onMessage(groupMessage("origin", `/new Source --dir "${project}"`));
    const sessionId = store.getUserContext("chat_id:origin")!.currentSessionId!;

    expect(controller.controlTaskAgent(sessionId, "acp")).toMatchObject({ current: "acp" });
    expect(controller.controlTaskAgent(sessionId).agents.map((agent) => agent.name)).toEqual(["codex", "acp"]);

    const model = await controller.controlTaskSettings(sessionId, "model", "gpt-next");
    expect(model.session).toMatchObject({ model: "gpt-next", reasoningEffort: "medium" });
    const permissions = await controller.controlTaskSettings(sessionId, "permissions", "confirm");
    expect(permissions.session.permissionMode).toBe("confirm");
    const provider = await controller.controlTaskSettings(sessionId, "provider", "azure");
    expect(provider.session.modelProvider).toBe("azure");
    expect(runtime.setExecutionSettings).toHaveBeenCalled();

    const goal = await controller.controlTaskGoal(sessionId, "set", "finish the migration");
    expect(goal.goal).toMatchObject({ objective: "finish the migration", status: "active" });
    await expect(controller.controlTaskGoal(sessionId, "pause")).resolves.toMatchObject({
      goal: { status: "paused" },
    });

    expect(controller.controlTaskMute(sessionId, true)).toMatchObject({ enabled: true });
    expect(store.getChatContext("chat_id:origin")?.requiresMention).toBe(true);

    const shell = await controller.controlRunTaskShell(sessionId, "git status");
    expect(shell).toMatchObject({ cwd: project, command: "git status", exitCode: 0 });
    expect(shellCommandExecutor).toHaveBeenCalledWith("git status", project);

    const directory = await controller.controlListTaskDirectory(sessionId);
    expect(directory.directory).toBe(project);
    expect(directory.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "src", kind: "directory" }),
      expect.objectContaining({ name: "logo.png", kind: "image" }),
      expect.objectContaining({ name: "readable.bin", kind: "file" }),
      expect.objectContaining({ name: "binary.txt", kind: "binary" }),
    ]));
    await expect(controller.controlSendTaskFile(sessionId, "logo.png")).resolves.toBe("file");
    expect(outbound.sendFile).toHaveBeenCalledWith("chat_id:origin", path.join(project, "logo.png"));

    const nextTask = await controller.controlCreateTask(sessionId, "Uses default Agent");
    expect(nextTask.agentName).toBe("acp");
  });

  test("lists and resets completed turns through targeted CLI controls", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(groupMessage("origin", "/new Resettable"));
    const sessionId = store.getUserContext("chat_id:origin")!.currentSessionId!;
    store.saveTurnSnapshot("turn_old", sessionId, {
      sessionId,
      turnId: "turn_old",
      status: "completed",
      prompt: "old state",
      startedAt: 100,
      completedAt: 200,
    }, "chat_id:origin");
    store.saveTurnSnapshot("turn_new", sessionId, {
      sessionId,
      turnId: "turn_new",
      status: "completed",
      prompt: "new state",
      startedAt: 300,
      completedAt: 400,
    }, "chat_id:origin");
    store.updateRuntimeSession(sessionId, { lastTurnId: "turn_new", lastTurnStatus: "completed" });

    const turns = await controller.controlListTaskTurns(sessionId);
    expect(turns.turns).toHaveLength(2);
    expect(turns.turns.find((turn) => turn.turnId === "turn_new")?.current).toBe(true);

    const reset = await controller.controlResetTaskToTurn(sessionId, "turn_old");
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: sessionId,
      lastTurnId: "turn_old",
    }));
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:origin",
      "Reset 正在进行，请稍后。期间发送的消息会自动排队。",
    );
    expect(reset).toMatchObject({ lastTurnId: "turn_old", lastTurnStatus: "completed" });
  });

  test("opens the unified settings card on the Model tab", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(message("/new"));

    await controller.onMessage(message("/model"));

    expect(runtime.listModels).toHaveBeenCalled();
    expect(outbound.sendInteractiveCard).toHaveBeenCalled();
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    expect(serialized).toContain("运行设置");
    expect(serialized).toContain('"tag":"markdown","content":"Model"');
    expect(serialized).toContain('"tab":"agent"');
    expect(serialized).toContain('"tab":"provider"');
    expect(serialized).toContain('"tab":"thinking"');
    expect(serialized).toContain('"tab":"permission"');
    expect(serialized).toContain("思考强度");
    expect(serialized).toContain("gpt-test");
    expect(serialized).toContain("gpt-next");
    expect(serialized).not.toContain("GPT Test");
    expect(serialized).not.toContain("GPT Next");
    expect(serialized).toContain("✅ 当前");
    expect(serialized).toContain("<font color='blue'>Switch</font>");
    expect(serialized).toContain('"tag":"interactive_container"');
    expect(serialized).not.toContain('"tag":"button"');
    expect(serialized).toContain('"action":"settings_model_select"');
    expect(serialized).toContain(`"sessionId":"${sessionId}"`);
    expect(serialized).toContain('"model":"gpt-next"');
    const bodyElements = (card as { body?: { elements?: Array<Record<string, unknown>> } })?.body?.elements ?? [];
    const tabRow = bodyElements[1]!;
    expect(tabRow).toMatchObject({ tag: "column_set", flex_mode: "none", horizontal_spacing: "2px" });
    const tabColumns = tabRow.columns as Array<{ width: string; elements: Array<Record<string, unknown>> }>;
    expect(tabColumns).toHaveLength(9);
    expect(tabColumns.every((column) => column.width === "auto")).toBe(true);
    expect(tabColumns.filter((_, index) => index % 2 === 1)
      .map((column) => column.elements[0]?.content)).toEqual(["·", "·", "·", "·"]);
    const tabButtons = tabColumns.filter((_, index) => index % 2 === 0)
      .map((column) => column.elements[0]!);
    expect(tabButtons).toHaveLength(5);
    expect(tabButtons.filter((_, index) => index !== 2)
      .every((button) => JSON.stringify(button).includes("<font color='blue'>"))).toBe(true);
    expect(tabButtons[2]).toEqual({
      tag: "markdown",
      content: "Model",
      text_align: "center",
      text_size: "notation",
    });
    expect(tabButtons[2]).not.toHaveProperty("behaviors");
    expect(tabButtons[0]).toMatchObject({
      tag: "interactive_container",
      has_border: false,
      behaviors: expect.any(Array),
    });
    const modelRows = bodyElements
      .filter((element) => element.tag === "column_set" && element.horizontal_spacing === "8px");
    expect(modelRows).toHaveLength(2);
    for (const row of modelRows) {
      expect(row).toMatchObject({ flex_mode: "none" });
      const columns = row.columns as Array<Record<string, unknown>>;
      expect(columns).toHaveLength(2);
      expect(columns[0]).toMatchObject({ width: "weighted" });
      expect(columns[1]).toMatchObject({ width: "auto" });
    }
  });

  test("hides the Agent tab when only one agent is configured", async () => {
    const { controller, outbound, config } = fixture();
    delete config.agents.acp;

    await controller.onMessage(message("/agent"));

    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "当前 Agent：codex\n当前没有其他 Agent 可以切换。",
    );
    expect(outbound.sendInteractiveCard).not.toHaveBeenCalled();
    await controller.onMessage(message("/new"));

    await controller.onMessage(message("/model"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain('"tab":"agent"');
    expect(serialized).not.toContain("<font color='blue'>Agent</font>");
    expect(serialized).toContain('"tab":"provider"');
    expect(serialized).toContain('"tag":"markdown","content":"Model"');
  });

  test("reports the current Provider without a card when no alternative is configured", async () => {
    const { controller, runtime, outbound } = fixture();
    (runtime.listModelProviders as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await controller.onMessage(message("/new"));
    (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mockClear();

    await controller.onMessage(message("/provider"));

    expect(outbound.sendText).toHaveBeenLastCalledWith(
      "chat_id:c1",
      "当前 Provider：openai\n当前没有其他 Provider 可以切换。",
    );
    expect(outbound.sendInteractiveCard).not.toHaveBeenCalled();
  });

  test("includes the current Provider in CLI settings when the runtime omits it", async () => {
    const { controller, runtime, store } = fixture();
    await controller.onMessage(message("/new"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    vi.mocked(runtime.listModelProviders!).mockResolvedValueOnce([
      { id: "ai_coding", displayName: "AI Coding" },
    ]);

    const result = await controller.controlTaskSettings(sessionId);

    expect(result.providers).toEqual([
      { id: "openai" },
      { id: "ai_coding", displayName: "AI Coding" },
    ]);
  });

  test.each(["cli", "card"])("persists a replacement thread ID when switching Provider through %s", async (entry) => {
    const { controller, runtime, outbound, store, config, persistAgentExecutionDefaults } = fixture();
    await controller.onMessage(message("/new"));
    const id = store.getUserContext("chat_id:c1")!.currentSessionId!;
    const original = runtime.getSession(id)!;
    vi.mocked(outbound.sendText).mockClear();
    vi.mocked(runtime.setExecutionSettings!).mockImplementationOnce(async (_id, settings, persist) => {
      const candidate = { ...original, ...settings, remoteSessionId: "replacement" };
      await persist?.(candidate);
      Object.assign(original, candidate);
      return original;
    });
    if (entry === "cli") await controller.controlTaskSettings(id, "provider", "azure");
    else await controller.onCardAction({ actionId: "switch", contextKey: "chat_id:c1", messageId: "om_provider",
      value: { action: "settings_provider_select", sessionId: id, contextKey: "chat_id:c1", provider: "azure" } });
    const noticeCall = vi.mocked(outbound.sendText).mock.calls.findIndex((call) =>
      call[1] === "正在切换到 Provider azure，请稍后。");
    expect(noticeCall).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(outbound.sendText).mock.invocationCallOrder[noticeCall])
      .toBeLessThan(vi.mocked(runtime.setExecutionSettings!).mock.invocationCallOrder[0]!);
    expect(store.getSession(id)).toMatchObject({ remoteSessionId: "replacement", modelProvider: "azure" });
    expect(config.agents.codex?.defaults?.modelProvider).toBe("azure");
    expect(persistAgentExecutionDefaults).toHaveBeenCalledOnce();
  });

  test.each(["cli", "card"])("rejects old Provider responses through %s without saving or reporting success", async (entry) => {
    const { controller, runtime, outbound, store, config, persistAgentExecutionDefaults } = fixture();
    await controller.onMessage(message("/new"));
    const id = store.getUserContext("chat_id:c1")!.currentSessionId!;
    const original = store.getSession(id)!;
    const defaults = config.agents.codex?.defaults;
    vi.mocked(runtime.setExecutionSettings!).mockImplementationOnce(async (_id, _settings, persist) => {
      const unchanged = runtime.getSession(id)!;
      await persist?.(unchanged);
      return unchanged;
    });
    vi.mocked(outbound.sendText).mockClear();
    if (entry === "cli") await expect(controller.controlTaskSettings(id, "provider", "azure")).rejects.toThrow("Provider 未生效");
    else {
      await controller.onCardAction({ actionId: "switch", contextKey: "chat_id:c1", messageId: "om_provider",
        value: { action: "settings_provider_select", sessionId: id, contextKey: "chat_id:c1", provider: "azure" } });
      expect(JSON.stringify(vi.mocked(outbound.sendText).mock.calls)).toContain("Provider 未生效");
      expect(JSON.stringify(vi.mocked(outbound.updateInteractiveCard).mock.calls)).not.toContain("Provider 已切换");
    }
    expect(store.getSession(id)).toEqual(original);
    expect(config.agents.codex?.defaults).toEqual(defaults);
    expect(persistAgentExecutionDefaults).not.toHaveBeenCalled();
  });

  test("does not change task settings when saving Provider defaults fails", async () => {
    const { controller, runtime, store, config, persistAgentExecutionDefaults } = fixture();
    await controller.onMessage(message("/new"));
    const id = store.getUserContext("chat_id:c1")!.currentSessionId!;
    const original = store.getSession(id)!;
    const defaults = config.agents.codex?.defaults;
    persistAgentExecutionDefaults.mockRejectedValueOnce(new Error("config is read-only"));
    await expect(controller.controlTaskSettings(id, "provider", "azure")).rejects.toThrow("config is read-only");
    expect(store.getSession(id)).toEqual(original);
    expect(runtime.getSession(id)?.modelProvider).toBe(original.modelProvider);
    expect(config.agents.codex?.defaults).toEqual(defaults);
  });

  test("switches Provider, Model, Thinking, and Permission through one tabbed card", async () => {
    const { controller, runtime, outbound, store, config, persistAgentExecutionDefaults } = fixture();
    await controller.onMessage(message("/new"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;

    await controller.onMessage(message("/provider"));
    let card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    let serialized = JSON.stringify(card);
    expect(serialized).toContain('"tag":"markdown","content":"Provider"');
    expect(serialized).toContain('"action":"settings_provider_select"');
    expect(serialized).toContain("azure");

    await controller.onCardAction({
      actionId: "provider-azure",
      contextKey: "chat_id:c1",
      messageId: "om_provider",
      value: {
        action: "settings_provider_select",
        sessionId,
        contextKey: "chat_id:c1",
        provider: "azure",
      },
    });
    card = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    serialized = JSON.stringify(card);
    expect(runtime.setExecutionSettings).toHaveBeenLastCalledWith(sessionId, {
      modelProvider: "azure",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "auto",
    }, expect.any(Function));
    expect(serialized).toContain("Provider 已切换为 `azure`");

    await controller.onCardAction({
      actionId: "open-model-tab",
      contextKey: "chat_id:c1",
      messageId: "om_provider",
      value: {
        action: "settings_tab_open",
        sessionId,
        contextKey: "chat_id:c1",
        tab: "model",
      },
    });
    card = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    serialized = JSON.stringify(card);
    expect(serialized).toContain('"tag":"markdown","content":"Model"');
    expect(serialized).toContain('"action":"settings_model_select"');

    await controller.onCardAction({
      actionId: "model-next",
      contextKey: "chat_id:c1",
      messageId: "om_provider",
      value: {
        action: "settings_model_select",
        sessionId,
        contextKey: "chat_id:c1",
        model: "gpt-next",
      },
    });
    expect(runtime.setModel).toHaveBeenLastCalledWith(sessionId, "gpt-next");
    expect(runtime.setReasoningEffort).toHaveBeenLastCalledWith(sessionId, "medium");

    await controller.onCardAction({
      actionId: "open-thinking-tab",
      contextKey: "chat_id:c1",
      messageId: "om_provider",
      value: {
        action: "settings_tab_open",
        sessionId,
        contextKey: "chat_id:c1",
        tab: "thinking",
      },
    });
    card = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    serialized = JSON.stringify(card);
    expect(serialized).toContain('"tag":"markdown","content":"Thinking"');
    expect(serialized).toContain('"action":"settings_thinking_select"');

    await controller.onCardAction({
      actionId: "thinking-xhigh",
      contextKey: "chat_id:c1",
      messageId: "om_provider",
      value: {
        action: "settings_thinking_select",
        sessionId,
        contextKey: "chat_id:c1",
        model: "gpt-next",
        effort: "xhigh",
      },
    });
    expect(runtime.setReasoningEffort).toHaveBeenLastCalledWith(sessionId, "xhigh");

    await controller.onCardAction({
      actionId: "open-permission-tab",
      contextKey: "chat_id:c1",
      messageId: "om_provider",
      value: {
        action: "settings_tab_open",
        sessionId,
        contextKey: "chat_id:c1",
        tab: "permission",
      },
    });
    card = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    serialized = JSON.stringify(card);
    expect(serialized).toContain('"tag":"markdown","content":"Permission"');
    expect(serialized).toContain('"action":"settings_permission_select"');

    await controller.onCardAction({
      actionId: "permission-confirm",
      contextKey: "chat_id:c1",
      messageId: "om_provider",
      value: {
        action: "settings_permission_select",
        sessionId,
        contextKey: "chat_id:c1",
        permissionMode: "confirm",
      },
    });
    expect(runtime.setPermissionMode).toHaveBeenLastCalledWith(sessionId, "confirm");
    expect(store.getSession(sessionId)).toMatchObject({
      modelProvider: "azure",
      model: "gpt-next",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
    });
    expect(persistAgentExecutionDefaults).toHaveBeenLastCalledWith("codex", {
      modelProvider: "azure",
      model: "gpt-next",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
    });
    expect(config.agents.codex!.defaults).toEqual({
      modelProvider: "azure",
      model: "gpt-next",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
    });
    card = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("已切换为执行前确认模式");
  });

  test("switches the model from the unified card and keeps the Model tab active", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(message("/new"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;

    await controller.onCardAction({
      actionId: "select-model-next",
      contextKey: "chat_id:c1",
      messageId: "om_model",
      value: {
        action: "settings_model_select",
        sessionId,
        contextKey: "chat_id:c1",
        model: "gpt-next",
      },
    });

    expect(runtime.setModel).toHaveBeenCalledWith(sessionId, "gpt-next");
    expect(runtime.setReasoningEffort).toHaveBeenCalledWith(sessionId, "medium");
    expect(store.getSession(sessionId)).toMatchObject({
      model: "gpt-next",
      reasoningEffort: "medium",
    });
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_model", expect.any(Object));
    const updated = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(updated);
    expect(serialized).toContain("运行设置");
    expect(serialized).toContain('"tag":"markdown","content":"Model"');
    expect(serialized).toContain("模型已切换为 `gpt-next`");
    expect(serialized).toContain("gpt-next");
    expect(serialized).toContain("medium");
    expect(serialized).toContain("✅ 当前");
    expect(serialized).toContain("<font color='blue'>Switch</font>");
    expect(serialized).toContain('"action":"settings_tab_open"');
    expect(serialized).toContain('"action":"settings_model_select"');
    expect(serialized).not.toContain('"action":"settings_thinking_select"');
    const bodyElements = (updated as { body?: { elements?: Array<Record<string, unknown>> } })?.body?.elements ?? [];
    expect(bodyElements[1]).toMatchObject({ tag: "column_set", flex_mode: "none" });
  });

  test("switches reasoning from the Thinking tab and updates it in place", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(message("/new"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    await controller.onCardAction({
      actionId: "select-model-next-first",
      contextKey: "chat_id:c1",
      messageId: "om_model",
      value: {
        action: "settings_model_select",
        sessionId,
        contextKey: "chat_id:c1",
        model: "gpt-next",
      },
    });
    (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mockClear();

    await controller.onCardAction({
      actionId: "select-reasoning-xhigh",
      contextKey: "chat_id:c1",
      messageId: "om_model",
      value: {
        action: "settings_thinking_select",
        sessionId,
        contextKey: "chat_id:c1",
        model: "gpt-next",
        effort: "xhigh",
      },
    });

    expect(runtime.setReasoningEffort).toHaveBeenLastCalledWith(sessionId, "xhigh");
    expect(store.getSession(sessionId)).toMatchObject({ reasoningEffort: "xhigh" });
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_model", expect.any(Object));
    const updated = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(updated);
    expect(serialized).toContain("思考强度已切换为 `xhigh`");
    expect(serialized).toContain("已保存为 `codex` Agent 的默认设置");
    expect(serialized).toContain('"tag":"markdown","content":"Thinking"');
    expect(serialized).toContain("✅ 当前");
    expect(serialized).toContain('"effort":"medium"');
  });

  test("switches tabs in place without changing execution settings", async () => {
    const { controller, outbound, store } = fixture();
    await controller.onMessage(message("/new"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;

    await controller.onCardAction({
      actionId: "return-to-models",
      contextKey: "chat_id:c1",
      messageId: "om_model",
      value: {
        action: "settings_tab_open",
        sessionId,
        contextKey: "chat_id:c1",
        tab: "model",
      },
    });

    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_model", expect.any(Object));
    const updated = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(updated);
    expect(serialized).toContain('"tag":"markdown","content":"Model"');
    expect(serialized).toContain('"action":"settings_model_select"');
    expect(serialized).not.toContain('"action":"settings_thinking_select"');
  });

  test("opens the unified settings card on Thinking and changes effort through its callback", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(message("/new"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;

    await controller.onMessage(message("/thinking"));
    expect(outbound.sendInteractiveCard).toHaveBeenCalled();
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('"tag":"markdown","content":"Thinking"');
    expect(serialized).toContain("high");
    expect(serialized).toContain("low");
    expect(serialized).not.toContain("Fast");
    expect(serialized).not.toContain("Deep");
    expect(serialized).toContain('"action":"settings_thinking_select"');

    await controller.onCardAction({
      actionId: "thinking-low",
      contextKey: "chat_id:c1",
      messageId: "om_settings",
      value: {
        action: "settings_thinking_select",
        sessionId,
        contextKey: "chat_id:c1",
        model: "gpt-test",
        effort: "low",
      },
    });
    expect(runtime.setReasoningEffort).toHaveBeenCalledWith(sessionId, "low");
    expect(store.listSessions("chat_id:c1")[0]).toMatchObject({ reasoningEffort: "low" });
  });

  test("opens the unified settings card on the Permission tab", async () => {
    const { controller, outbound } = fixture();
    await controller.onMessage(message("/new"));

    await controller.onMessage(message("/permissions"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('"tag":"markdown","content":"Permission"');
    expect(serialized).toContain('"action":"settings_permission_select"');
    expect(serialized).toContain("执行前确认");
  });

  test("rejects unsupported reasoning efforts without changing state", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(message("/new"));

    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    await controller.onCardAction({
      actionId: "thinking-extreme",
      contextKey: "chat_id:c1",
      messageId: "om_settings",
      value: {
        action: "settings_thinking_select",
        sessionId,
        contextKey: "chat_id:c1",
        model: "gpt-test",
        effort: "extreme",
      },
    });

    expect(runtime.setReasoningEffort).not.toHaveBeenCalled();
    expect(store.listSessions("chat_id:c1")[0]).toMatchObject({ reasoningEffort: "high" });
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("支持的强度：low、high"),
    );
  });

  test("retains compatible effort and falls back for an incompatible model", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(message("/new"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;

    await controller.onCardAction({
      actionId: "model-current",
      contextKey: "chat_id:c1",
      messageId: "om_settings",
      value: {
        action: "settings_model_select",
        sessionId,
        contextKey: "chat_id:c1",
        model: "gpt-test",
      },
    });
    expect(runtime.setReasoningEffort).not.toHaveBeenCalled();

    await controller.onCardAction({
      actionId: "model-next",
      contextKey: "chat_id:c1",
      messageId: "om_settings",
      value: {
        action: "settings_model_select",
        sessionId,
        contextKey: "chat_id:c1",
        model: "gpt-next",
      },
    });
    expect(runtime.setModel).toHaveBeenCalledWith(expect.any(String), "gpt-next");
    expect(runtime.setReasoningEffort).toHaveBeenCalledWith(expect.any(String), "medium");
    expect(store.listSessions("chat_id:c1")[0]).toMatchObject({
      model: "gpt-next",
      reasoningEffort: "medium",
    });
    const card = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("思考强度已自动调整为 medium");
  });

  test("rejects an unknown model without changing runtime state", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(message("/new"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;

    await controller.onCardAction({
      actionId: "model-missing",
      contextKey: "chat_id:c1",
      messageId: "om_settings",
      value: {
        action: "settings_model_select",
        sessionId,
        contextKey: "chat_id:c1",
        model: "missing-model",
      },
    });

    expect(runtime.setModel).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("未知模型：missing-model"),
    );
  });

  test("shows a rich status summary for the current task", async () => {
    const { controller, outbound, remoteSessions, store } = fixture();
    await controller.onMessage(message("inspect this repo"));
    Object.assign(remoteSessions[0]!, {
      createdAt: 1_776_272_400,
      updatedAt: 1_776_272_460,
      recencyAt: 1_785_000_000,
    });
    const cardsBeforeStatus = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.length;

    await controller.onMessage(message("/status"));

    const task = store.listSessions("chat_id:c1")[0]!;
    const live = await controller.controlGetTaskStatus(task.localSessionId);
    expect(live.session.createdAt).toBe(new Date(1_776_272_400_000).toISOString());
    expect(live.session.updatedAt).toBe(new Date(1_785_000_000_000).toISOString());
    expect(outbound.sendInteractiveCard).toHaveBeenCalledTimes(cardsBeforeStatus + 1);
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(card).toMatchObject({ header: { title: { content: "Agent 状态" } } });
    expect(serialized).toContain("当前任务");
    expect(serialized).toContain("**标题**：`inspect this repo`");
    expect(serialized).toContain("**工作目录**：");
    expect(serialized).toContain("**Provider / 模型 / 思考强度**：`openai` / `gpt-test` / `high`");
    expect(serialized).toContain("**状态 / 最近结果**：执行中 / 执行中");
    expect(serialized).toContain("**权限 / 任务范围**：自动执行 / 未指定项目");
    expect(serialized).toContain("**Agent**：`Codex`");
    expect(serialized).not.toContain("Agent / 运行时");
    expect(serialized).toContain("**App Server 任务 ID**：`thr_1`");
    expect(serialized).toContain("**创建时间 / 最近活动**：");
    expect(serialized).not.toContain("**创建 / 更新**：");
    expect(serialized).toContain("Agent Bot");
    expect(serialized).toContain("**默认 Agent / 保活**：`codex` / 已启用");
    expect(serialized).not.toContain("任务统计");
    expect(serialized).not.toContain("###");
  });

  test("shows the remote active turn for the current externally executing task", async () => {
    const { controller, outbound, remoteSessions, store } = fixture();
    remoteSessions.push({
      id: "external_current_status",
      title: "External current task",
      cwd: "D:\\work\\external-status",
      source: "cli",
      status: "idle",
      lastTurnId: "turn_old",
      lastTurnStatus: "completed",
    });
    await controller.onMessage(message("/switch external_current_status"));
    const current = store.listSessions("chat_id:c1").find(
      (session) => session.remoteSessionId === "external_current_status",
    )!;
    store.saveTurnSnapshot("turn_old", current.localSessionId, {
      sessionId: current.localSessionId,
      turnId: "turn_old",
      status: "completed",
      startedAt: 1,
      plan: [],
      activities: [{
        kind: "tool",
        id: "stale_tool",
        tool: { id: "stale_tool", title: "stale local tool", kind: "command", status: "completed" },
      }],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
      finalResponse: "stale local result",
    });
    Object.assign(remoteSessions.find((remote) => remote.id === "external_current_status")!, {
      status: "active",
      lastTurnId: "turn_external_active",
      lastTurnStatus: "inProgress",
      lastActivity: "Running external integration tests",
      finalResponse: undefined,
    });

    await controller.onMessage(message("/status"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("**状态 / 最近结果**：外部执行中 / 执行中");
    expect(serialized).toContain("**当前执行 / 排队消息**：`turn_external_active` / 0 条");
    expect(serialized).toContain("**回合 ID**：turn_external_active");
    expect(serialized).toContain("Running external integration tests");
    expect(serialized).toContain("任务仍在执行，尚无最终结果");
    expect(serialized).not.toContain("turn_old");
    expect(serialized).not.toContain("stale local tool");
    expect(serialized).not.toContain("stale local result");
  });

  test("shows the latest externally completed turn instead of a stale local snapshot", async () => {
    const { controller, outbound, remoteSessions, store } = fixture();
    remoteSessions.push({
      id: "external_completed_status",
      title: "External completed task",
      cwd: "D:\\work\\external-completed",
      source: "cli",
      status: "idle",
      lastTurnId: "turn_local_old",
      lastTurnStatus: "completed",
    });
    await controller.onMessage(message("/switch external_completed_status"));
    const current = store.listSessions("chat_id:c1").find(
      (session) => session.remoteSessionId === "external_completed_status",
    )!;
    store.updateRuntimeSession(current.localSessionId, {
      lastTurnId: "turn_local_old",
      lastTurnStatus: "completed",
    });
    store.saveTurnSnapshot("turn_local_old", current.localSessionId, {
      sessionId: current.localSessionId,
      turnId: "turn_local_old",
      status: "completed",
      startedAt: 1,
      plan: [],
      activities: [{ kind: "reasoning", id: "old_reasoning", text: "stale local step" }],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
      finalResponse: "stale local result",
    });
    Object.assign(remoteSessions.find((remote) => remote.id === "external_completed_status")!, {
      status: "idle",
      lastTurnId: "turn_external_latest",
      lastTurnStatus: "completed",
      lastActivity: "Latest external step",
      finalResponse: "latest external result",
      lastTurnToolCount: 7,
      lastTurnCompletedToolCount: 7,
      lastTurnFailedToolCount: 0,
      lastTurnRunningToolCount: 0,
      updatedAt: 1_785_000_000,
    });

    const live = await controller.controlGetTaskStatus(current.localSessionId);
    expect(live.session).toMatchObject({
      lastTurnId: "turn_external_latest",
      lastTurnStatus: "completed",
      status: "ready",
    });
    expect(live.snapshot).toBeUndefined();
    expect(live.remote?.finalResponse).toBe("latest external result");

    await controller.onMessage(message("/status"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("**回合 ID**：turn_external_latest");
    expect(serialized).toContain("Latest external step");
    expect(serialized).toContain("**工具执行**：完成 7，失败 0");
    expect(serialized).toContain("latest external result");
    expect(serialized).not.toContain("turn_local_old");
    expect(serialized).not.toContain("stale local step");
    expect(serialized).not.toContain("stale local result");
  });

  test("shows execution step and final result for a specified local task without switching", async () => {
    const { controller, outbound, store, sessions, remoteSessions } = fixture();
    await controller.onMessage(message("inspect this repo"));
    const task = store.listSessions("chat_id:c1")[0]!;
    sessions.get(task.localSessionId)!.activeTurnId = undefined;
    store.updateSession(task.localSessionId, { status: "ready" });
    store.updateRuntimeSession(task.localSessionId, { lastTurnId: "turn_1", lastTurnStatus: "completed" });
    Object.assign(remoteSessions.find((remote) => remote.id === task.remoteSessionId)!, {
      status: "idle",
      lastTurnId: "turn_1",
      lastTurnStatus: "completed",
      lastTurnToolCount: 37,
      lastTurnCompletedToolCount: 35,
      lastTurnFailedToolCount: 2,
      lastTurnRunningToolCount: 0,
    });
    store.saveTurnSnapshot("turn_1", task.localSessionId, {
      sessionId: task.localSessionId,
      turnId: "turn_1",
      taskTitle: "inspect this repo",
      status: "completed",
      startedAt: 1_000,
      completedAt: 3_500,
      durationMs: 2_500,
      assistantText: "",
      plan: [],
      activities: [
        { kind: "tool", id: "tool_1", tool: { id: "tool_1", title: "npm test", kind: "command", status: "completed" } },
        { kind: "reasoning", id: "reasoning_1", text: "整理测试结果" },
      ],
      completedTools: [{ id: "tool_1", title: "npm test", kind: "command", status: "completed" }],
      failedTools: [],
      fileSummary: [],
      finalResponse: "全部检查完成，测试通过。",
    });

    await controller.onMessage(message(`/status ${task.localSessionId}`));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(card).toMatchObject({ header: { title: { content: "Agent 状态：inspect this repo" } } });
    expect(serialized).toContain("指定任务");
    expect(serialized).toContain("执行详情");
    expect(serialized).toContain("**当前 / 最后步骤**：整理测试结果");
    expect(serialized).toContain("**工具执行**：完成 35，失败 2");
    expect(serialized).toContain("**耗时**：2.5s");
    expect(serialized).toContain("最终结果");
    expect(serialized).toContain("全部检查完成，测试通过。");
    expect(store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId).toBe(task.localSessionId);
  });

  test("reads detailed status for any Codex task without switching to it", async () => {
    const { controller, outbound, remoteSessions, runtime, store } = fixture();
    remoteSessions.push({
      id: "external_status",
      title: "Desktop build",
      cwd: "D:\\work\\desktop",
      source: "vscode",
      status: "active",
      createdAt: 1_776_272_400,
      updatedAt: 1_776_272_460,
      recencyAt: 1_785_000_000,
      lastTurnId: "turn_external",
      lastTurnStatus: "inProgress",
      lastActivity: "Running the integration tests",
    });

    await controller.onMessage(message("/status external_status"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("🟢 外部执行中");
    expect(serialized).toContain("Running the integration tests");
    expect(serialized).toContain("**状态 / 当前任务**：🟢 外部执行中 / 未切换");
    expect(serialized).toContain("**创建时间 / 最近活动**：");
    expect(serialized).not.toContain("时间未知");
    expect(serialized).not.toContain("**来源**");
    expect(serialized).toContain("任务仍在执行，尚无最终结果");
    expect(runtime.resumeSession).not.toHaveBeenCalled();
    expect(store.findSessionByRemoteSessionId("external_status")).toBeUndefined();
  });

  test("reads task status by the one-based order from the last sessions list", async () => {
    const { controller, outbound, remoteSessions, store } = fixture();
    await controller.onMessage(message("/new"));
    const currentSessionId = store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId;
    remoteSessions.push({
      id: "status_second",
      title: "Second status task",
      cwd: "D:\\work\\status-second",
      source: "vscode",
      status: "idle",
      lastTurnId: "turn_status_second",
      lastTurnStatus: "completed",
      lastActivity: "Finished the second task",
      finalResponse: "Second task result",
      updatedAt: Date.now(),
    });

    await controller.onMessage(message("/sessions"));
    await controller.onMessage(message("/status 2"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(card).toMatchObject({ header: { title: { content: "Agent 状态：Second status task" } } });
    expect(serialized).toContain("Second task result");
    expect(store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId).toBe(currentSessionId);
  });

  test("renders grouped help without repeating command entries", async () => {
    const { controller, outbound } = fixture();

    await controller.onMessage(message("/help"));

    expect(outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    expect(outbound.sendMarkdown).not.toHaveBeenCalled();
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    const intro = String((card as { body?: { elements?: Array<{ content?: unknown }> } })
      .body?.elements?.[0]?.content ?? "");
    expect(card).toMatchObject({ header: { title: { content: "Agent Bot 使用帮助" } } });
    expect(intro).toContain(
      "> 命令前缀示例：/sess 等同于 /sessions。\n> 命令缩写示例：/fg 等同于 /forkgroup。",
    );
    expect(intro).toContain("点击命令按钮可执行默认形式；有必填参数的命令需要手动发送。");
    expect(serialized).toContain("**任务管理**");
    expect(serialized).toContain("**执行设置**");
    expect(serialized).toContain("**Agent**");
    expect(serialized).toContain("**系统**");
    const clickableCommands = [
      "/new",
      "/newgroup",
      "/dir",
      "/forkgroup",
      "/fork",
      "/turns",
      "/sessions",
      "/archive",
      "/dismiss",
      "/switch",
      "/stop",
      "/provider",
      "/model",
      "/thinking",
      "/permissions",
      "/agent",
      "/status",
      "/restart",
      "/release",
      "/mute",
      "/help",
    ];
    expect(serialized.match(/"action":"help_command"/g)).toHaveLength(clickableCommands.length);
    for (const command of clickableCommands) {
      expect(serialized.split(`"command":"${command}"`)).toHaveLength(2);
    }
    for (const command of ["!", "/file", "/title", "/queue", "/nosteer", "/goal"]) {
      expect(serialized).not.toContain(`"command":"${command}"`);
      expect(serialized).toContain(`**${command}**`);
    }
    expect(serialized).toContain("选择 AI 服务提供商");
    expect(serialized).toContain("选择当前任务使用的模型");
    expect(serialized).toContain("设置模型的思考强度");
    expect(serialized).toContain("设置执行工具前是否需要确认");
    expect(serialized).not.toContain("/model [name]");
    expect(serialized).not.toContain("/permissions [auto|confirm]");
    expect(serialized).toContain("**[--force]**");
    expect(serialized).toContain("**[序号或任务 ID]**");
    expect(serialized).not.toContain("/reset");
    expect(serialized).toContain("Reset 对话上下文");
    expect(serialized).not.toContain("/attach");
    expect(serialized).not.toContain("/detach");
    expect(serialized).not.toContain("/cancel");
    expect(serialized).not.toContain("/close");
    expect(serialized).not.toContain("/agents");
    expect(serialized).not.toContain("/ask");
    expect(serialized).not.toContain("/use");
    expect(serialized).not.toContain("<id>");
    expect(serialized).not.toContain("<name>");
    expect(serialized).not.toContain("###");
    expect(serialized).not.toContain("`");
  });

  test("falls back to plain text when the help card cannot be sent", async () => {
    const { controller, outbound, logger } = fixture();
    const cardError = Object.assign(new Error("card rejected"), { code: 200621 });
    (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mockRejectedValueOnce(cardError);

    await controller.onMessage(message("/help"));

    expect(outbound.sendText).toHaveBeenCalledOnce();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("Agent Bot 使用帮助\n"),
    );
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("/file <文件路径> - 将指定文件发送到当前飞书会话"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: cardError, command: "help", phase: "help_card_send" }),
      "Failed to send the help card; falling back to plain text.",
    );
  });

  test("records a secondary failure when neither help response can be delivered", async () => {
    const { controller, outbound, logger } = fixture();
    (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("card rejected"));
    (outbound.sendText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("message delivery failed"));

    await controller.onMessage(message("/help"));

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: "message delivery failed" }),
        originalError: expect.objectContaining({
          name: "AggregateError",
          message: "帮助卡片和纯文本帮助均发送失败。",
        }),
        command: "help",
        phase: "error_response_send",
      }),
      "Failed to deliver the request failure to the user.",
    );
  });

  test("executes only registered default commands from help-card callbacks", async () => {
    const { controller, outbound, shellCommandExecutor } = fixture();

    await controller.onCardAction({
      actionId: "help-sessions",
      contextKey: "chat_id:c1",
      messageId: "om_help",
      value: {
        action: "help_command",
        command: "/sessions",
        contextKey: "chat_id:c1",
      },
    });

    expect(outbound.sendInteractiveCard).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({ content: "任务列表" }),
        }),
      }),
    );

    await controller.onCardAction({
      actionId: "help-required-shell",
      contextKey: "chat_id:c1",
      messageId: "om_help",
      value: {
        action: "help_command",
        command: "!",
        contextKey: "chat_id:c1",
      },
    });

    expect(shellCommandExecutor).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "帮助卡片中的命令无效，请发送 /help 获取最新卡片。",
    );

    await controller.onCardAction({
      actionId: "help-required-goal",
      contextKey: "chat_id:c1",
      messageId: "om_help",
      value: {
        action: "help_command",
        command: "/goal",
        contextKey: "chat_id:c1",
      },
    });

    expect(outbound.sendText).toHaveBeenLastCalledWith(
      "chat_id:c1",
      "帮助卡片中的命令无效，请发送 /help 获取最新卡片。",
    );
  });
});
