import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { expect, test, vi } from "vitest";
import type { AppServerClient, AppServerClientProvider } from "../../src/codex/CodexRuntime.js";
import { CodexRuntime } from "../../src/codex/CodexRuntime.js";
import type { AppConfig } from "../../src/config/schema.js";
import { FeishuTurnPresenter } from "../../src/feishu/FeishuTurnPresenter.js";
import type { FeishuOutbound } from "../../src/feishu/types.js";
import { OutboundRouter } from "../../src/presentation/OutboundRouter.js";
import { ProxySessionController } from "../../src/proxy/ProxySessionController.js";
import { AgentRuntimeRegistry } from "../../src/runtime/AgentRuntimeRegistry.js";
import type { AgentRuntime } from "../../src/runtime/types.js";
import { StateStore } from "../../src/state/StateStore.js";

test("pairs a plain-text link with its quoted instruction before starting the Turn and progress card", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-reference-flow-"));
  const app = createApplication(path.join(dir, "state.sqlite"), new FakeClient("quoted_turn"));
  const url = "https://example.test/merge-request/123";
  const instruction = "review 这个 MR 中的 skill 改动";
  try {
    app.store.getOrCreateUserContext("chat_id:c1", "codex");
    app.store.setBoundProjectCwd("chat_id:c1", dir);
    await app.controller.onMessage({ messageId: "create", contextKey: "chat_id:c1", text: "/new Existing task title" });
    const source = app.controller.onMessage({ messageId: "source", contextKey: "chat_id:c1", messageType: "text", text: url });
    await new Promise((resolve) => setTimeout(resolve, 365));
    expect(app.client.requests.filter((request) => request.method === "turn/start")).toEqual([]);
    await app.controller.onMessage({ messageId: "instruction", contextKey: "chat_id:c1", parentMessageId: "source", text: instruction });
    await source;
    expect(app.client.requests.filter((request) => request.method === "turn/start")).toEqual([
      { method: "turn/start", params: expect.objectContaining({ input: [expect.objectContaining({ type: "text", text: `${instruction}\n\n引用消息：\n${url}` })] }) },
    ]);
    expect(app.client.requests.some((request) => request.method === "turn/steer")).toBe(false);
    expect(app.store.getTurnSnapshot("quoted_turn")).toMatchObject({ prompt: instruction, taskTitle: "Existing task title" });
    expect(app.store.listSessions("chat_id:c1")).toHaveLength(1);
    expect(app.outbound.cards).toHaveLength(1);
    expect(JSON.stringify(app.outbound.cards[0]?.header)).toContain(instruction);
    expect(JSON.stringify(app.outbound.cards[0]?.header)).not.toContain(url);
    app.client.emit("turn/completed", { threadId: "thr_1", turn: { id: "quoted_turn", status: "completed" } });
    await vi.waitFor(() => expect(app.store.getTurnSnapshot("quoted_turn")).toMatchObject({ status: "completed" }));
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sends one progress card and one final answer per turn, then resumes without history replay", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-codex-flow-"));
  const dbPath = path.join(dir, "state.sqlite");
  const first = createApplication(dbPath, new FakeClient("turn_1"));
  try {
    await first.controller.onMessage({ messageId: "m1", contextKey: "chat_id:c1", text: "inspect" });
    first.client.emit("item/agentMessage/delta", {
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "i1",
      delta: "first answer",
    });
    first.client.emit("turn/completed", {
      threadId: "thr_1",
      turn: { id: "turn_1", status: "completed", durationMs: 100 },
    });
    await vi.waitFor(() => expect(first.outbound.markdown).toEqual(["first answer"]));
    expect(first.outbound.cards).toHaveLength(1);
  } finally {
    await first.close();
  }

  const secondClient = new FakeClient("turn_2");
  secondClient.resumeResult = {
    thread: { id: "thr_1", turns: [{ id: "turn_1", items: [{ type: "agentMessage", text: "first answer" }] }] },
    model: "gpt-test",
  };
  const second = createApplication(dbPath, secondClient);
  try {
    await second.controller.onMessage({ messageId: "m2", contextKey: "chat_id:c1", text: "continue" });
    expect(secondClient.requests.some((request) => request.method === "thread/resume")).toBe(true);

    secondClient.emit("item/agentMessage/delta", {
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "old",
      delta: "first answer",
    });
    secondClient.emit("turn/completed", {
      threadId: "thr_1",
      turn: { id: "turn_1", status: "completed" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(second.outbound.markdown).toEqual([]);

    secondClient.emit("item/agentMessage/delta", {
      threadId: "thr_1",
      turnId: "turn_2",
      itemId: "i2",
      delta: "second answer",
    });
    secondClient.emit("turn/completed", {
      threadId: "thr_1",
      turn: { id: "turn_2", status: "completed", durationMs: 100 },
    });
    await vi.waitFor(() => expect(second.outbound.markdown).toEqual(["second answer"]));
    expect(second.outbound.cards).toHaveLength(1);
  } finally {
    await second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

class MemoryOutbound implements FeishuOutbound {
  readonly cards: Array<Record<string, unknown>> = [];
  readonly updates: Array<Record<string, unknown>> = [];
  readonly markdown: string[] = [];

  async sendText(): Promise<string> {
    return `text-${Date.now()}`;
  }

  async sendMarkdown(_contextKey: string, markdown: string): Promise<string> {
    this.markdown.push(markdown);
    return `final-${this.markdown.length}`;
  }

  async sendInteractiveCard(_contextKey: string, card: Record<string, unknown>): Promise<string> {
    this.cards.push(card);
    return `card-${this.cards.length}`;
  }

  async updateInteractiveCard(_messageId: string, card: Record<string, unknown>): Promise<void> {
    this.updates.push(card);
  }
}

class FakeClient implements AppServerClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  resumeResult: unknown = { thread: { id: "thr_1", turns: [] }, model: "gpt-test" };
  private listener?: (method: string, params: unknown) => void;
  private latestTurn?: { id: string; status: "completed" | "inProgress" };

  constructor(private readonly turnId: string) {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thr_1" }, model: "gpt-test" } as T;
    if (method === "thread/resume") return this.resumeResult as T;
    if (method === "thread/read") {
      return {
        thread: {
          id: "thr_1",
          cwd: process.cwd(),
          source: "agent-bot",
          status: { type: this.latestTurn?.status === "inProgress" ? "active" : "idle" },
          turns: this.latestTurn ? [this.latestTurn] : [],
        },
      } as T;
    }
    if (method === "turn/start") {
      this.latestTurn = { id: this.turnId, status: "inProgress" };
      return { turn: { id: this.turnId } } as T;
    }
    if (method === "model/list") return { data: [] } as T;
    return {} as T;
  }

  notify(): void {}
  registerRequestHandler(): void {}
  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  emit(method: string, params: unknown): void {
    if (method === "turn/completed") {
      const turn = (params as { turn?: { id?: string } }).turn;
      if (turn?.id && this.latestTurn?.id === turn.id) {
        this.latestTurn = { id: turn.id, status: "completed" };
      }
    }
    this.listener?.(method, params);
  }
}

function createApplication(dbPath: string, client: FakeClient) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const provider: AppServerClientProvider = { getClient: async () => client, close: vi.fn() };
  const codex = new CodexRuntime(provider, logger);
  const acp = inertRuntime();
  const store = new StateStore(dbPath);
  const outbound = new MemoryOutbound();
  const presenter = new FeishuTurnPresenter(outbound, store, undefined, { normalIntervalMs: 0, criticalGapMs: 0 });
  const router = new OutboundRouter([{ matches: () => true, outbound, presenter }]);
  const config = {
    agents: { codex: { kind: "app-server", title: "Codex", command: "codex", args: [], env: {} } },
    defaults: { agent: "codex", cwd: process.cwd() },
    storage: { sqlitePath: dbPath },
  } as unknown as AppConfig;
  const controller = new ProxySessionController(config, store, new AgentRuntimeRegistry({ acp, codex }), router, logger);
  return {
    client,
    controller,
    outbound,
    store,
    close: async () => {
      controller.close();
      await router.flushAll();
      codex.close();
      store.close();
    },
  };
}

function inertRuntime(): AgentRuntime {
  return {
    kind: "acp",
    createSession: async () => { throw new Error("unused"); },
    resumeSession: async () => { throw new Error("unused"); },
    getSession: () => undefined,
    readSessionMetadata: async () => ({}),
    synchronizeSession: async () => { throw new Error("unused"); },
    startTurn: async () => { throw new Error("unused"); },
    steerTurn: async () => { throw new Error("unused"); },
    cancelTurn: async () => undefined,
    closeSession: async () => undefined,
    setModel: async () => undefined,
    setReasoningEffort: async () => undefined,
    setPermissionMode: async () => undefined,
    respondToApproval: async () => undefined,
    listModels: async () => [],
    onEvent: () => () => undefined,
    close: () => undefined,
  };
}
