import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { RuntimeEvent, RuntimeExecutionSettings, RuntimeGoal } from "../../src/runtime/types.js";
import { AppServerRequestError } from "../../src/codex/AppServerConnection.js";
import { CodexRuntime, type AppServerClientProvider } from "../../src/codex/CodexRuntime.js";
import { CodexLocalActivityDetector } from "../../src/codex/CodexLocalActivityDetector.js";

describe("CodexRuntime", () => {
  test.each(["notification", "snapshot"])("separates unphased progress from the final answer through %s", async (completion) => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({ localSessionId: "s1", agentName: "codex", cwd: process.cwd(), permissionMode: "auto" });
    const turnId = await runtime.startTurn("s1", "continue");
    const delta = (itemId: string, text: string) => client.emit("item/agentMessage/delta", {
      threadId: "thr_1", turnId, itemId, delta: text,
    });
    client.emit("item/started", { threadId: "thr_1", turnId, item: { type: "agentMessage", id: "progress", phase: null } });
    delta("progress", "I will inspect ");
    delta("progress", "the code.");
    client.emit("item/started", { threadId: "thr_1", turnId,
      item: { type: "commandExecution", id: "tool", command: "git status", status: "inProgress" } });
    delta("update", "Checking the result.");
    delta("answer", "Final ");
    delta("answer", "answer.");
    expect(events.filter((event) => event.type === "agent_text_delta")).toHaveLength(0);
    expect(events.filter((event) => event.type === "progress").map((event) => event.activityId))
      .toEqual(["commentary:progress", "commentary:progress", "commentary:update", "commentary:answer", "commentary:answer"]);
    if (completion === "snapshot") {
      client.readResult = { thread: { id: "thr_1", status: { type: "idle" }, turns: [{ id: turnId, status: "completed", items: [
        { type: "agentMessage", id: "progress", phase: null, text: "I will inspect the code." },
        { type: "commandExecution", id: "tool" },
        { type: "agentMessage", id: "answer", phase: null, text: "Final answer." },
      ] }] } };
      await runtime.synchronizeSession("s1");
    } else {
      client.emit("turn/completed", { threadId: "thr_1", turn: { id: turnId, status: "completed" } });
    }
    expect(events.filter((event) => event.type === "agent_text_delta")).toEqual([{
      type: "agent_text_delta", sessionId: "s1", turnId, text: "Final answer.", replacesActivityId: "commentary:answer",
    }]);
    expect(events.at(-1)).toMatchObject({ type: "turn_completed", finalResponse: "Final answer." });
  });

  test.each(["commentary", "final_answer"])("honors a late %s phase without duplicating streamed text", async (phase) => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({ localSessionId: "s1", agentName: "codex", cwd: process.cwd(), permissionMode: "auto" });
    const turnId = await runtime.startTurn("s1", "hello");
    client.emit("item/agentMessage/delta", { threadId: "thr_1", turnId, itemId: "message", delta: "hello" });
    for (let i = 0; i < 2; i++) client.emit("item/completed", {
      threadId: "thr_1", turnId, item: { type: "agentMessage", id: "message", phase, text: "hello" },
    });
    client.emit("turn/completed", { threadId: "thr_1", turn: { id: turnId, status: "completed" } });
    expect(events.at(-1)).toMatchObject({ type: "turn_completed", finalResponse: phase === "final_answer" ? "hello" : "" });
    expect(events.filter((event) => event.type === "agent_text_delta")).toHaveLength(phase === "final_answer" ? 1 : 0);
  });

  test.each(["completed", "failed", "interrupted"])("does not deliver pre-tool commentary as a %s turn's answer", async (status) => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({ localSessionId: "s1", agentName: "codex", cwd: process.cwd(), permissionMode: "auto" });
    const turnId = await runtime.startTurn("s1", "hello");
    client.emit("item/agentMessage/delta", { threadId: "thr_1", turnId, itemId: "message", delta: "Inspecting" });
    client.emit("item/started", { threadId: "thr_1", turnId,
      item: { type: "commandExecution", id: "tool", command: "git status", status: "inProgress" } });
    client.emit("turn/completed", { threadId: "thr_1", turn: { id: turnId, status } });
    expect(events.filter((event) => event.type === "agent_text_delta")).toHaveLength(0);
    if (status === "completed") expect(events.at(-1)).toMatchObject({ type: "turn_completed", finalResponse: "" });
  });

  test.each(["completed", "failed"])("shows retry errors without terminating before %s", async (status) => {
    const client = new FakeAppServerClient();
    const log = logger();
    const runtime = new CodexRuntime(provider(client), log);
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({ localSessionId: "s1", agentName: "codex", cwd: process.cwd(), permissionMode: "auto" });
    const turnId = await runtime.startTurn("s1", "hello");
    const error = { message: "Reconnecting... 2/5", additionalDetails: "rate_limit_reached (code=3003). Please try again in 60 seconds." };
    const fullError = `${error.message}\n\n${error.additionalDetails}`;
    client.emit("error", { threadId: "unrelated", turnId, error, willRetry: true });
    expect(events.filter((event) => event.type === "progress")).toHaveLength(0);
    for (const willRetry of [true, true, false]) {
      client.emit("error", { threadId: "thr_1", turnId, error, willRetry });
      expect(runtime.getSession("s1")?.activeTurnId).toBe(turnId);
      expect(events.at(-1)).toMatchObject({
        type: "progress", sessionId: "s1", turnId, severity: "warning", append: false,
        activityId: `commentary:runtime-error:${turnId}`,
        text: `${willRetry ? "运行请求出错，Agent 正在重试" : "运行请求失败，等待 Agent 返回最终状态"}：${fullError}`,
      });
    }
    expect(events.some((event) => event.type === "turn_failed" || event.type === "turn_completed")).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ turnId, willRetry: true, error: fullError }),
      "App Server reported a turn error.");
    client.emit("item/agentMessage/delta", { threadId: "thr_1", turnId, itemId: "answer", delta: "Recovered" });
    client.emit("turn/completed", { threadId: "thr_1", turn: { id: turnId, status, error: status === "failed" ? error : null } });
    expect(runtime.getSession("s1")?.activeTurnId).toBeUndefined();
    expect(events.at(-1)).toMatchObject(status === "failed"
      ? { type: "turn_failed", message: fullError }
      : { type: "turn_completed", finalResponse: "Recovered" });
    const count = events.length;
    client.emit("error", { threadId: "thr_1", turnId, error, willRetry: true });
    client.emit("turn/completed", { threadId: "thr_1", turn: { id: turnId, status, error } });
    expect(events).toHaveLength(count);
  });

  test("preserves failure details when synchronizing and inspecting a remote turn", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({ localSessionId: "s1", agentName: "codex", cwd: process.cwd(), permissionMode: "auto" });
    const turnId = await runtime.startTurn("s1", "hello");
    client.readResult = { thread: { id: "thr_1", status: { type: "idle" }, turns: [{
      id: turnId, status: "failed", items: [],
      error: { message: "Request failed", additionalDetails: "HTTP 429: rate_limit_reached" },
    }] } };
    await runtime.synchronizeSession("s1");
    expect(events.at(-1)).toMatchObject({ type: "turn_failed", message: "Request failed\n\nHTTP 429: rate_limit_reached" });
    await expect(runtime.readRemoteSession("thr_1")).resolves.toMatchObject({
      lastError: "Request failed\n\nHTTP 429: rate_limit_reached", lastTurnStatus: "failed",
    });
  });

  test.each(["network", "401", "404", "503"])("keeps model fallback warnings visible for %s failures", async (failure) => {
    const client = new FakeAppServerClient();
    client.configResult = { config: { model_providers: { custom: { base_url: "https://provider.example/v1" } } } };
    const fetchMock = vi.fn(async () => {
      if (failure === "network") throw new TypeError("fetch failed");
      return new Response("failed", { status: Number(failure) });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const runtime = new CodexRuntime(provider(client), logger());
      const result = await runtime.listModelsWithStatus("custom", "current");
      expect(result.models.map((model) => model.id)).toEqual(["current"]);
      expect(result.warning).toContain("服务可用性未确认");
      expect(result.warning).toContain(failure === "network" ? "无法连接" : failure);
      const catalog = client.modelListResult;
      client.modelListResult = { data: [] };
      await expect(runtime.listModelsWithStatus("custom")).rejects.toThrow();
      client.modelListResult = catalog;
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: "online" }] })));
      expect(await runtime.listModelsWithStatus("custom", "current")).toEqual({
        models: [expect.objectContaining({ id: "online" })],
      });
      expect((await runtime.listModelsWithStatus("openai")).warning).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("treats a new unmaterialized task as empty without masking pagination failures", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    client.turnListErrors.push(new AppServerRequestError("thread/turns/list", -32600,
      "thread empty is not materialized yet; thread/turns/list is unavailable before first user message"));
    expect((await runtime.readRemoteSession("empty")).completedTurns).toEqual([]);
    client.turnListErrors.push(new AppServerRequestError("thread/turns/list", -32601, "Unknown method"));
    await expect(runtime.listRemoteTurnSummaries("empty", { limit: 10 })).rejects.toThrow("Unknown method");
    expect(client.requests.filter((r) => r.method === "thread/read")).toEqual([
      { method: "thread/read", params: { threadId: "empty", includeTurns: false } },
    ]);
  });

  test("exports paginated prompts and final answers without tools, reasoning, or active Turns", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const answer = "long answer".repeat(2_000);
    client.turnListResults.push(
      { data: [{ id: "active", status: "inProgress" }, { id: "last", status: "completed" }], nextCursor: null },
      { data: [{ id: "first", status: "completed", items: [
        { type: "userMessage", content: [{ type: "text", text: "first prompt" }, { type: "image", url: "excluded" }] },
        { type: "reasoning", text: "private reasoning" },
        { type: "agentMessage", phase: "commentary", text: "progress" },
        { type: "commandExecution", output: "huge output" },
        { type: "agentMessage", phase: "final_answer", text: answer },
      ] }], nextCursor: "page2" },
      { data: [{ id: "failed", status: "failed", items: [{ type: "userMessage", content: [{ type: "text", text: "excluded failed prompt" }] }] }, { id: "last", status: "completed", items: [
        { type: "userMessage", content: [{ type: "text", text: "second prompt" }] },
        { type: "userMessage", content: [{ type: "text", text: "steered prompt" }] },
        { type: "agentMessage", text: "legacy final" },
      ] }, { id: "active", status: "inProgress" }], nextCursor: "unused" },
    );
    const turns = [];
    for await (const turn of runtime.readConversation("source")) turns.push(turn);
    expect(turns).toEqual([
      { turnId: "first", messages: [{ role: "user", text: "first prompt" }, { role: "assistant", text: answer }] },
      { turnId: "last", messages: [{ role: "user", text: "second prompt" }, { role: "user", text: "steered prompt" }, { role: "assistant", text: "legacy final" }] },
    ]);
    expect(client.requests.every((request) => request.method === "thread/turns/list")).toBe(true);
    expect(client.requests.at(-1)?.params).toEqual({ threadId: "source", cursor: "page2", limit: 50, sortDirection: "asc", itemsView: "summary" });
  });

  test("conversation export respects an explicit boundary and rejects repeated cursors and missing anchors", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const collect = async () => {
      const turns = [];
      for await (const turn of runtime.readConversation("source", "anchor")) turns.push(turn);
      return turns;
    };
    client.turnListResults.push({ data: [{ id: "anchor", status: "completed", items: [] }, { id: "later", status: "completed", items: [] }], nextCursor: null });
    expect(await collect()).toEqual([{ turnId: "anchor", messages: [] }]);
    client.turnListResults.push({ data: [], nextCursor: "repeat" }, { data: [], nextCursor: "repeat" });
    await expect(collect()).rejects.toThrow("repeated");
    client.turnListResults.push({ data: [], nextCursor: null });
    await expect(collect()).rejects.toThrow("截止轮次");
    client.turnListResults.push({ data: [{ id: "anchor", status: "inProgress" }], nextCursor: null });
    await expect(collect()).rejects.toThrow("历史发生变化");
  });

  test("counts paginated Turns and reads rollout disk usage without loading full history", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-metrics-"));
    const rolloutPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(rolloutPath, "x".repeat(12_345));
    try {
      const client = new FakeAppServerClient();
      client.readResult = { thread: { id: "large", name: "Large task", path: rolloutPath } };
      client.turnListResults.push(
        {
          data: Array.from({ length: 100 }, (_, index) => ({ id: `turn_${123 - index}`, status: "completed" })),
          nextCursor: "page_2",
        },
        {
          data: Array.from({ length: 23 }, (_, index) => ({ id: `turn_${23 - index}`, status: "completed" })),
          nextCursor: null,
        },
      );
      const runtime = new CodexRuntime(provider(client), logger());

      await expect(runtime.readRemoteSessionMetrics("large")).resolves.toEqual({
        turnCount: 123,
        storageBytes: 12_345,
      });
      expect(client.requests).toEqual([
        { method: "thread/read", params: { threadId: "large", includeTurns: false } },
        {
          method: "thread/turns/list",
          params: { threadId: "large", limit: 100, sortDirection: "desc", itemsView: "summary" },
        },
        {
          method: "thread/turns/list",
          params: {
            threadId: "large", cursor: "page_2", limit: 100, sortDirection: "desc", itemsView: "summary",
          },
        },
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses TraeX's explicit updated_at sorting without a failed Codex-protocol probe", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime({ ...provider(client), getAgentFamily: () => "traex" }, logger());
    await runtime.listRemoteSessions();
    expect(client.requests).toEqual([{ method: "thread/list", params: expect.objectContaining({ sortKey: "updated_at" }) }]);
  });

  test("status fetches one full turn while metadata fetches none, even with thousands of turns", async () => {
    const client = new FakeAppServerClient();
    client.readResult = { thread: {
      id: "large", status: { type: "idle" },
      turns: Array.from({ length: 2_000 }, (_, i) => ({
        id: `turn_${i}`, status: "completed",
        items: [{ type: "agentMessage", phase: "final_answer", text: `Result ${i}` }],
      })),
    } };
    const runtime = new CodexRuntime(provider(client), logger());
    expect((await runtime.readRemoteSession("large", "metadata")).lastTurnId).toBeUndefined();
    expect(client.requests.map((r) => r.method)).toEqual(["thread/read"]);
    const result = await runtime.readRemoteSession("large", "latest-full");
    expect(result.finalResponse).toBe("Result 1999");
    expect(result.completedTurns).toHaveLength(1);
    expect(client.requests.at(-1)).toEqual({
      method: "thread/turns/list",
      params: { threadId: "large", limit: 1, sortDirection: "desc", itemsView: "full" },
    });
  });

  test("refreshes only the current thread and retries once when turn/start rejects a stale cwd", async () => {
    const client = new FakeAppServerClient();
    const testLogger = logger();
    const runtime = new CodexRuntime(provider(client), testLogger);
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: "/Volumes/Work/project",
      permissionMode: "auto",
    });
    client.turnStartErrors.push(new AppServerRequestError(
      "turn/start",
      -32602,
      "invalid cwd: No such file or directory (os error 2)",
    ));

    await expect(runtime.startTurn("s1", "continue")).resolves.toBe("turn_1");

    expect(client.requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
      "thread/resume",
      "turn/start",
    ]);
    expect(testLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", cwd: "/Volumes/Work/project" }),
      "App Server rejected the task working directory; refreshing the current thread before retrying.",
    );
  });

  test("sends text and local images as Codex app-server user input blocks", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });

    const turnId = await runtime.startTurn("s1", {
      text: "检查这张截图",
      localImagePaths: ["D:\\captures\\screen.png"],
    });
    await runtime.steerTurn("s1", turnId, {
      text: "再看这张",
      localImagePaths: ["D:\\captures\\detail.jpg"],
    });

    expect(client.requests.find((request) => request.method === "turn/start")?.params).toEqual(
      expect.objectContaining({
        input: [
          { type: "text", text: "检查这张截图", text_elements: [] },
          { type: "localImage", path: "D:\\captures\\screen.png" },
        ],
      }),
    );
    expect(client.requests.find((request) => request.method === "turn/steer")?.params).toEqual(
      expect.objectContaining({
        input: [
          { type: "text", text: "再看这张", text_elements: [] },
          { type: "localImage", path: "D:\\captures\\detail.jpg" },
        ],
      }),
    );
  });

  test("adds DPI-aware Windows screenshot instructions to every thread lifecycle request", async () => {
    const client = new FakeAppServerClient();
    let disconnect: ((error: Error) => void) | undefined;
    const runtime = new CodexRuntime({
      getClient: async () => client,
      close: vi.fn(),
      onDisconnect: (listener) => {
        disconnect = listener;
        return () => { disconnect = undefined; };
      },
    }, logger());

    await runtime.createSession({
      localSessionId: "created",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    await runtime.resumeSession({
      localSessionId: "restored",
      remoteSessionId: "thr_restored",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    await runtime.startTurn("created", "first");
    disconnect?.(new Error("process exited"));
    await runtime.startTurn("created", "second");

    const lifecycleRequests = client.requests.filter(
      (request) => request.method === "thread/start" || request.method === "thread/resume",
    );
    expect(lifecycleRequests).toHaveLength(3);
    for (const request of lifecycleRequests) {
      expect(request.params).toEqual(expect.objectContaining({
        developerInstructions: expect.stringContaining("SetProcessDpiAwarenessContext"),
      }));
      const instructions = (request.params as { developerInstructions: string }).developerInstructions;
      expect(instructions).toContain("-4");
      expect(instructions).toContain("specific window");
      expect(instructions).toContain("DwmGetWindowAttribute");
      expect(instructions).toContain("DWMWA_EXTENDED_FRAME_BOUNDS");
      expect(instructions).toContain("GetWindowRect");
      expect(instructions).toContain("UI Automation");
      expect(instructions).toContain("bitmap dimensions");
    }
  });

  test("starts generated Codex task directories with projectless workspace metadata", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const workspaceRoot = path.join(os.homedir(), "Documents", "Codex");
    const cwd = path.join(workspaceRoot, "2026-07-15", "new-chat");

    await runtime.createSession({
      localSessionId: "projectless",
      agentName: "codex",
      cwd,
      permissionMode: "auto",
    });

    const request = client.requests.find((item) => item.method === "thread/start");
    expect(request?.params).toEqual(expect.objectContaining({
      cwd,
      threadSource: "user",
      developerInstructions: expect.stringMatching(/Projectless Chat[\s\S]*outputs/),
    }));
    expect(request?.params).not.toHaveProperty("runtimeWorkspaceRoots");
  });

  test("allows slow App Server session lifecycle requests to finish", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());

    await runtime.createSession({
      localSessionId: "slow-start",
      agentName: "traex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    await runtime.resumeSession({
      localSessionId: "slow-resume",
      remoteSessionId: "thr_slow",
      agentName: "traex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });

    expect(client.timeouts).toContainEqual({ method: "thread/start", timeoutMs: 60_000 });
    expect(client.timeouts).toContainEqual({ method: "thread/resume", timeoutMs: 60_000 });
  });

  test("archives a remote App Server thread and releases its loaded session", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    await runtime.createSession({
      localSessionId: "archive-local",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });

    await runtime.archiveRemoteSession("thr_1");

    expect(client.requests).toContainEqual({
      method: "thread/archive",
      params: { threadId: "thr_1" },
    });
    expect(runtime.getSession("archive-local")).toBeUndefined();
  });

  test("releases the shared App Server only when idle unless forced", async () => {
    const client = new FakeAppServerClient();
    const release = vi.fn(async () => undefined);
    const runtime = new CodexRuntime({ ...provider(client), release }, logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({
      localSessionId: "release-local",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    await runtime.startTurn("release-local", "keep working");

    await expect(runtime.release()).resolves.toEqual({
      status: "busy",
      activeSessionIds: ["release-local"],
    });
    expect(release).not.toHaveBeenCalled();

    await expect(runtime.release({ force: true })).resolves.toEqual({ status: "released" });
    expect(release).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      type: "turn_failed",
      sessionId: "release-local",
      turnId: "turn_1",
      message: "Task interrupted because Agent Bot released the App Server.",
    });

    await runtime.startTurn("release-local", "resume through Agent Bot");
    expect(client.requests.slice(-2).map((request) => request.method)).toEqual([
      "thread/resume",
      "turn/start",
    ]);
  });

  test("forks a thread through the requested completed turn", async () => {
    const client = new FakeAppServerClient();
    client.forkResult = {
      thread: { id: "thr_forked", name: "Forked task" },
      model: "gpt-test",
      reasoningEffort: "high",
    };
    const runtime = new CodexRuntime(provider(client), logger());

    const session = await runtime.forkSession({
      localSessionId: "forked_local",
      remoteSessionId: "thr_source",
      lastTurnId: "turn_anchor",
      agentName: "codex",
      cwd: process.cwd(),
      title: "Forked task（分支 1）",
      modelProvider: "azure",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "auto",
    });

    expect(session).toMatchObject({
      localSessionId: "forked_local",
      remoteSessionId: "thr_forked",
      title: "Forked task（分支 1）",
    });
    expect(client.requests).toContainEqual({
      method: "thread/fork",
      params: expect.objectContaining({
        threadId: "thr_source",
        lastTurnId: "turn_anchor",
        excludeTurns: true,
        cwd: process.cwd(),
        modelProvider: "azure",
        model: "gpt-test",
        threadSource: "user",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
    });
    expect(client.timeouts).toContainEqual({
      method: "thread/fork",
      timeoutMs: 0,
    });
    expect(client.requests).toContainEqual({
      method: "thread/name/set",
      params: { threadId: "thr_forked", name: "Forked task（分支 1）" },
    });
  });

  test("does not retry a fork with a full-history response when excludeTurns is rejected", async () => {
    const client = new FakeAppServerClient();
    client.forkErrors.push(new AppServerRequestError(
      "thread/fork",
      -32602,
      "Invalid params",
      { detail: "unknown field `excludeTurns`" },
    ));
    const testLogger = logger();
    const runtime = new CodexRuntime(provider(client), testLogger);

    await expect(runtime.forkSession({
      localSessionId: "fallback_local",
      remoteSessionId: "thr_source",
      lastTurnId: "turn_anchor",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    })).rejects.toThrow("Invalid params");

    const requests = client.requests.filter((request) => request.method === "thread/fork");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.params).toEqual(expect.objectContaining({ excludeTurns: true }));
  });

  test("does not retry a fork after an ambiguous failure", async () => {
    const client = new FakeAppServerClient();
    client.forkErrors.push(new Error("App Server connection closed."));
    const runtime = new CodexRuntime(provider(client), logger());

    await expect(runtime.forkSession({
      localSessionId: "failed_local",
      remoteSessionId: "thr_source",
      lastTurnId: "turn_anchor",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    })).rejects.toThrow("App Server connection closed");

    expect(client.requests.filter((request) => request.method === "thread/fork")).toHaveLength(1);
  });

  test("sets an explicit title immediately after creating a thread", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());

    const session = await runtime.createSession({
      localSessionId: "titled_local",
      agentName: "codex",
      cwd: process.cwd(),
      title: "  修复   会话列表  ",
      permissionMode: "auto",
    });

    expect(client.requests).toContainEqual({
      method: "thread/name/set",
      params: { threadId: "thr_1", name: "修复 会话列表" },
    });
    expect(session.title).toBe("修复 会话列表");
  });

  test("renames a thread through thread/name/set", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    await runtime.createSession({
      localSessionId: "renamed_local",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });

    await runtime.setTitle("renamed_local", "  Renamed   task  ");

    expect(client.requests).toContainEqual({
      method: "thread/name/set",
      params: { threadId: "thr_1", name: "Renamed task" },
    });
    expect(runtime.getSession("renamed_local")?.title).toBe("Renamed task");
  });

  test("manages a persisted thread goal and adopts its automatic continuation turn", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({
      localSessionId: "goal_local",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });

    await expect(runtime.getGoal("goal_local")).resolves.toBeUndefined();
    const goal = await runtime.setGoal("goal_local", {
      objective: "完成迁移并通过全部测试",
      status: "active",
    });
    expect(goal).toMatchObject({ objective: "完成迁移并通过全部测试", status: "active" });
    await runtime.setGoal("goal_local", { status: "paused" });

    client.emit("turn/started", {
      threadId: "thr_1",
      turn: { id: "goal_turn_1", status: "inProgress", startedAt: 42 },
    });
    expect(events).toContainEqual({
      type: "turn_started",
      sessionId: "goal_local",
      turnId: "goal_turn_1",
      startedAt: 42_000,
    });

    await expect(runtime.clearGoal("goal_local")).resolves.toBe(true);
    expect(client.requests).toContainEqual({
      method: "thread/goal/get",
      params: { threadId: "thr_1" },
    });
    expect(client.requests).toContainEqual({
      method: "thread/goal/set",
      params: { threadId: "thr_1", objective: "完成迁移并通过全部测试", status: "active" },
    });
    expect(client.requests).toContainEqual({
      method: "thread/goal/set",
      params: { threadId: "thr_1", status: "paused" },
    });
    expect(client.requests).toContainEqual({
      method: "thread/goal/clear",
      params: { threadId: "thr_1" },
    });
  });

  test("creates a thread and emits active turn deltas and completion", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));

    const session = await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    const turnId = await runtime.startTurn("s1", "inspect the repo");
    expect(client.requests.find((request) => request.method === "turn/start")?.params).toEqual(
      expect.objectContaining({ effort: "medium", summary: "auto" }),
    );
    client.emit("item/started", {
      threadId: "thr_1", turnId,
      item: { type: "agentMessage", id: "item_1", phase: "final_answer" },
    });
    client.emit("item/agentMessage/delta", {
      threadId: "thr_1",
      turnId,
      itemId: "item_1",
      delta: "hello",
    });
    client.emit("thread/tokenUsage/updated", {
      threadId: "thr_1",
      turnId,
      tokenUsage: {
        total: { inputTokens: 98_765, cachedInputTokens: 90_000, outputTokens: 500, totalTokens: 99_265 },
        last: { inputTokens: 12_345, cachedInputTokens: 10_000, outputTokens: 100, totalTokens: 12_445 },
        modelContextWindow: 200_000,
      },
    });
    client.emit("item/started", {
      threadId: "thr_1",
      turnId,
      startedAtMs: 1_000,
      item: { type: "contextCompaction", id: "compact_1" },
    });
    client.emit("item/completed", {
      threadId: "thr_1",
      turnId,
      completedAtMs: 3_500,
      item: { type: "contextCompaction", id: "compact_1" },
    });
    client.emit("item/started", {
      threadId: "thr_1",
      turnId,
      item: { type: "commandExecution", id: "command_1", command: "npm test", status: "inProgress" },
    });
    client.emit("item/commandExecution/outputDelta", {
      threadId: "thr_1",
      turnId,
      itemId: "command_1",
      delta: "running tests\n",
    });
    client.emit("turn/completed", {
      threadId: "thr_1",
      turn: { id: turnId, status: "completed", durationMs: 1200 },
    });

    expect(session.remoteSessionId).toBe("thr_1");
    expect(session.reasoningEffort).toBe("medium");
    expect(events).toContainEqual(expect.objectContaining({ type: "agent_text_delta", text: "hello", turnId }));
    expect(events).toContainEqual({
      type: "token_usage_updated",
      sessionId: "s1",
      turnId,
      lastTokens: 2_445,
      cumulativeTokens: 9_265,
      lastTotalTokens: 12_445,
      cumulativeTotalTokens: 99_265,
      lastCachedTokens: 10_000,
      cumulativeCachedTokens: 90_000,
      contextTokens: 12_445,
    });
    expect(events).toContainEqual({
      type: "context_compaction",
      sessionId: "s1",
      turnId,
      phase: "started",
      compactionId: "compact_1",
      timestampMs: 1_000,
      turnCount: 1,
      storageBytes: undefined,
    });
    expect(events).toContainEqual({
      type: "context_compaction",
      sessionId: "s1",
      turnId,
      phase: "completed",
      compactionId: "compact_1",
      timestampMs: 3_500,
      turnCount: 1,
      storageBytes: undefined,
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_started",
      turnId,
      tool: expect.objectContaining({ id: "command_1", status: "running" }),
    }));
    expect(events).toContainEqual({
      type: "tool_output_delta",
      sessionId: "s1",
      turnId,
      toolId: "command_1",
      delta: "running tests\n",
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn_completed", finalResponse: "hello", durationMs: 1200 }),
    );
  });

  test("routes commentary messages to the timeline and keeps only final-answer text in the response", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    const turnId = await runtime.startTurn("s1", "explain it");

    client.emit("item/started", {
      threadId: "thr_1",
      turnId,
      item: { type: "agentMessage", id: "commentary_1", text: "", phase: "commentary" },
    });
    client.emit("item/agentMessage/delta", {
      threadId: "thr_1",
      turnId,
      itemId: "commentary_1",
      delta: "我先检查官方文档。",
    });
    client.emit("item/started", {
      threadId: "thr_1",
      turnId,
      item: { type: "agentMessage", id: "final_1", text: "", phase: "final_answer" },
    });
    client.emit("item/agentMessage/delta", {
      threadId: "thr_1",
      turnId,
      itemId: "final_1",
      delta: "这是最终结论。",
    });
    client.emit("turn/completed", {
      threadId: "thr_1",
      turn: { id: turnId, status: "completed" },
    });

    expect(events).toContainEqual({
      type: "progress",
      sessionId: "s1",
      turnId,
      activityId: "commentary:commentary_1",
      text: "我先检查官方文档。",
      append: true,
    });
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "agent_text_delta",
      text: "我先检查官方文档。",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent_text_delta",
      text: "这是最终结论。",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "turn_completed",
      finalResponse: "这是最终结论。",
    }));
  });

  test("suggests switching models when a completed turn reports the code-mode stdout failure", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "traex",
      cwd: process.cwd(),
      permissionMode: "auto",
      model: "gpt-5.6-sol",
    });
    const turnId = await runtime.startTurn("s1", "run it");

    client.emit("item/agentMessage/delta", {
      threadId: "thr_1",
      turnId,
      itemId: "final_1",
      delta: "The command failed: code-mode host closed its stdout",
    });
    client.emit("turn/completed", {
      threadId: "thr_1",
      turn: { id: turnId, status: "completed" },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "turn_completed",
      finalResponse: [
        "The command failed: code-mode host closed its stdout",
        "> 当前模型 `gpt-5.6-sol` 的本地工具执行通道异常。请发送 `/model` 切换到其他模型后重试。",
      ].join("\n\n"),
    }));
  });

  test("suggests switching models when snapshot recovery reports malformed exec input", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "traex",
      cwd: process.cwd(),
      permissionMode: "auto",
      model: "gpt-5.6-luna",
    });
    await runtime.startTurn("s1", "run it");
    client.readResult = {
      thread: {
        id: "thr_1",
        status: { type: "idle" },
        turns: [{
          id: "turn_1",
          status: "completed",
          items: [{
            type: "agentMessage",
            id: "final",
            phase: "final_answer",
            text: "exec expects an object containing raw JavaScript in `input`",
          }],
        }],
      },
    };

    await runtime.synchronizeSession("s1");

    expect(events).toContainEqual(expect.objectContaining({
      type: "turn_completed",
      finalResponse: [
        "exec expects an object containing raw JavaScript in `input`",
        "> 当前模型 `gpt-5.6-luna` 的本地工具执行通道异常。请发送 `/model` 切换到其他模型后重试。",
      ].join("\n\n"),
    }));
  });

  test("does not add model guidance for ordinary command failures", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "traex",
      cwd: process.cwd(),
      permissionMode: "auto",
      model: "gpt-5.6-sol",
    });
    const turnId = await runtime.startTurn("s1", "run it");

    client.emit("item/agentMessage/delta", {
      threadId: "thr_1",
      turnId,
      itemId: "final_1",
      delta: "The command exited with code 1.",
    });
    client.emit("turn/completed", {
      threadId: "thr_1",
      turn: { id: turnId, status: "completed" },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "turn_completed",
      finalResponse: "The command exited with code 1.",
    }));
  });

  test("turns generated image items into a deliverable final response", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    const turnId = await runtime.startTurn("s1", "generate an avatar");
    const imagePath = path.resolve("generated avatar.png");

    client.emit("item/completed", {
      threadId: "thr_1",
      turnId,
      completedAtMs: 1234,
      item: {
        type: "imageGeneration",
        id: "generated_1",
        status: "completed",
        revisedPrompt: "A square profile avatar",
        result: "large-base64-result",
        savedPath: imagePath,
      },
    });
    client.emit("turn/completed", {
      threadId: "thr_1",
      turn: { id: turnId, status: "completed" },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_updated",
      turnId,
      tool: expect.objectContaining({ kind: "image_generation", imagePath }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "turn_completed",
      turnId,
      finalResponse: `![生成图片 1](<${imagePath.replaceAll("\\", "/")}>)`,
    }));
  });

  test("persists a selected effort in runtime state and exposes model effort metadata", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
      reasoningEffort: "high",
    });

    await runtime.setReasoningEffort("s1", "low");
    expect(runtime.getSession("s1")?.reasoningEffort).toBe("low");
    await expect(runtime.listModels()).resolves.toEqual([
      expect.objectContaining({
        id: "gpt-test",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { value: "low", description: "Fast" },
          { value: "medium", description: "Balanced" },
        ],
      }),
    ]);
  });

  test("uses the model default when a new thread omits reasoning effort", async () => {
    const client = new FakeAppServerClient();
    client.startResult = { thread: { id: "thr_1" }, model: "gpt-test", reasoningEffort: null };
    const runtime = new CodexRuntime(provider(client), logger());

    const session = await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });

    expect(session.reasoningEffort).toBe("medium");
  });

  test("uses the Codex-configured default Provider when starting without an override", async () => {
    const client = new FakeAppServerClient();
    client.startResult = {
      thread: { id: "thr_default_provider" },
      modelProvider: "codex-default",
      model: "gpt-test",
      reasoningEffort: "medium",
    };
    const runtime = new CodexRuntime(provider(client), logger());

    const session = await runtime.createSession({
      localSessionId: "default-provider",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });

    const request = client.requests.find((item) => item.method === "thread/start");
    expect(request?.params).not.toHaveProperty("modelProvider");
    expect(session.modelProvider).toBe("codex-default");
  });

  test("lists configured Providers and applies unified execution settings", async () => {
    const client = new FakeAppServerClient();
    client.configResult = {
      config: {
        model_provider: "openai",
        model_providers: {
          openai: { name: "OpenAI" },
          azure: { name: "Azure OpenAI", env_key: "SECRET_MUST_NOT_BE_EXPOSED" },
        },
      },
    };
    client.startResult = {
      thread: { id: "thr_settings" },
      modelProvider: "openai",
      model: "gpt-test",
      reasoningEffort: "medium",
    };
    client.resumeResult = {
      thread: { id: "thr_settings" },
      modelProvider: "azure",
      model: "gpt-test",
      reasoningEffort: "medium",
    };
    const runtime = new CodexRuntime(provider(client), logger());
    await runtime.createSession({
      localSessionId: "settings",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });

    await expect(runtime.listModelProviders()).resolves.toEqual([
      { id: "openai", displayName: "OpenAI", isDefault: true },
      { id: "azure", displayName: "Azure OpenAI" },
    ]);
    client.readResult = { thread: { id: "thr_settings", preview: "existing task", status: { type: "idle" } } };
    const session = await runtime.setExecutionSettings("settings", {
      modelProvider: "azure",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "confirm",
    });

    expect(client.requests).toContainEqual({
      method: "thread/resume",
      params: expect.objectContaining({
        threadId: "thr_settings",
        modelProvider: "azure",
        model: "gpt-test",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      }),
    });
    expect(session).toMatchObject({
      modelProvider: "azure",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "confirm",
    });
  });

  test("keeps the built-in OpenAI Provider available beside custom Codex Providers", async () => {
    const client = new FakeAppServerClient();
    client.configResult = {
      config: {
        model_providers: {
          ai_coding: { name: "AI Coding" },
        },
      },
    };
    const runtime = new CodexRuntime({
      ...provider(client),
      getAgentFamily: () => "codex",
    }, logger());

    await expect(runtime.listModelProviders()).resolves.toEqual([
      { id: "openai", displayName: "OpenAI", isDefault: true },
      { id: "ai_coding", displayName: "AI Coding" },
    ]);
  });

  test.each([
    ["traex", "trae"], ["traex", " trae "], ["traex", undefined], ["codex", "openai"],
  ] as const)("uses the complete native catalog for %s Provider %s", async (family, modelProvider) => {
    const client = new FakeAppServerClient();
    client.configResult = { config: { model_provider: null, model_providers: {} } };
    client.modelListResult = { data: [
      { id: "first-model", displayName: "First Model", isDefault: true },
      {
        id: "current-model", displayName: "Current Model", isDefault: false,
        supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Thorough" }],
        defaultReasoningEffort: "high",
      },
      { id: "other-model", displayName: "Other Model", isDefault: false },
    ] };
    const log = logger();
    const runtime = new CodexRuntime({ ...provider(client), getAgentFamily: () => family }, log);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const models = await runtime.listModels(modelProvider, "current-model");
      expect(models.map((model) => model.id)).toEqual(["first-model", "current-model", "other-model"]);
      expect(models[0]).toMatchObject({ displayName: "First Model", isDefault: true });
      expect(models[1]).toMatchObject({
        displayName: "Current Model", isDefault: false, defaultReasoningEffort: "high",
        supportedReasoningEfforts: [{ value: "high", description: "Thorough" }],
      });
      expect(client.requests).toEqual([{ method: "model/list", params: {} }]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      runtime.close();
    }
  });

  test.each([
    ["codex", "azure"], ["traex", "azure"], ["traex", "openai"], ["codex", "trae"],
  ] as const)("lists only models returned by %s custom Provider %s", async (family, providerId) => {
    const client = new FakeAppServerClient();
    client.configResult = {
      config: {
        model_providers: {
          [providerId]: { name: "Azure OpenAI", base_url: "https://azure.example/v1", env_key: "AZURE_TOKEN" },
        },
      },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "azure-only", is_default: true }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const runtime = new CodexRuntime({
        ...provider(client),
        getAgentFamily: () => family,
        getEnvironmentVariable: (name) => name === "AZURE_TOKEN" ? "azure-secret" : undefined,
      }, logger());

      await expect(runtime.listModels(providerId)).resolves.toEqual([{
        id: "azure-only",
        isDefault: true,
        supportedReasoningEfforts: [],
      }]);
      expect(client.requests.map((request) => request.method)).toEqual(["config/read", "model/list"]);
      const fetchCalls = fetchMock.mock.calls as unknown as Array<[URL, RequestInit?]>;
      const headers = new Headers(fetchCalls[0]?.[1]?.headers);
      expect(headers.get("authorization")).toBe("Bearer azure-secret");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test.each(["codex", "traex"] as const)("keeps a custom Provider on %s usable without a model list", async (family) => {
    const client = new FakeAppServerClient();
    client.configResult = {
      config: {
        model_providers: {
          single: { name: "Single Model", base_url: "https://single.example/v1" },
        },
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    try {
      const runtime = new CodexRuntime({
        ...provider(client),
        getAgentFamily: () => family,
      }, logger());

      await expect(runtime.listModels("single", "single-default")).resolves.toEqual([{
        id: "single-default",
        isDefault: true,
        supportedReasoningEfforts: [],
      }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("does not add the Codex OpenAI Provider to TraeX", async () => {
    const client = new FakeAppServerClient();
    client.configResult = {
      config: {
        model_providers: {
          trae: { name: "Trae" },
        },
      },
    };
    const runtime = new CodexRuntime({
      ...provider(client),
      getAgentFamily: () => "traex",
    }, logger());

    await expect(runtime.listModelProviders()).resolves.toEqual([
      { id: "trae", displayName: "Trae" },
    ]);
  });

  test("resume ignores history and historical notifications", async () => {
    const client = new FakeAppServerClient();
    client.resumeResult = {
      thread: {
        id: "thr_1",
        turns: [{ id: "old", items: [{ type: "agentMessage", id: "old_i", text: "already sent" }] }],
      },
      model: "gpt-test",
    };
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));

    await runtime.resumeSession({
      localSessionId: "s1",
      remoteSessionId: "thr_1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    client.emit("item/agentMessage/delta", {
      threadId: "thr_1",
      turnId: "old",
      itemId: "old_i",
      delta: "already sent",
    });

    expect(events).toEqual([]);
  });

  test("steers and interrupts the active turn", async () => {
    const client = new FakeAppServerClient();
    const log = logger();
    const runtime = new CodexRuntime(provider(client), log);
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    const turnId = await runtime.startTurn("s1", "build it");

    await runtime.steerTurn("s1", turnId, "also update docs");
    await runtime.cancelTurn("s1", turnId);

    expect(client.requests).toContainEqual(
      expect.objectContaining({ method: "turn/steer", params: expect.objectContaining({ expectedTurnId: turnId }) }),
    );
    expect(client.requests).toContainEqual(
      expect.objectContaining({ method: "turn/interrupt", params: { threadId: "thr_1", turnId } }),
    );
    expect(client.timeouts).toContainEqual({ method: "turn/steer", timeoutMs: 10_000 });
    expect(client.timeouts).toContainEqual({ method: "turn/interrupt", timeoutMs: 10_000 });
    expect(log.info).toHaveBeenCalledWith(
      { sessionId: "s1", threadId: "thr_1", turnId },
      "App Server accepted the turn interrupt request.",
    );
  });

  test("reconciles a stale active turn and recovers the latest completed result", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    await runtime.startTurn("s1", "monitor it");
    client.readResult = {
      thread: {
        id: "thr_1",
        status: { type: "idle" },
        turns: [
          { id: "turn_1", status: "completed", items: [], startedAt: 10, durationMs: 100 },
          {
            id: "turn_2",
            status: "completed",
            startedAt: 20,
            durationMs: 250,
            items: [{ type: "agentMessage", id: "final", phase: "final_answer", text: "最新执行结果" }],
          },
        ],
      },
    };

    await runtime.synchronizeSession("s1");

    expect(runtime.getSession("s1")?.activeTurnId).toBeUndefined();
    expect(events).toContainEqual({ type: "turn_cancelled", sessionId: "s1", turnId: "turn_1" });
    expect(events).toContainEqual({ type: "turn_started", sessionId: "s1", turnId: "turn_2", startedAt: 20_000 });
    expect(events).toContainEqual({
      type: "turn_completed",
      sessionId: "s1",
      turnId: "turn_2",
      finalResponse: "最新执行结果",
      durationMs: 250,
    });
  });

  test("recovers generated images from a completed thread snapshot", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    await runtime.startTurn("s1", "generate an avatar");
    const imagePath = path.resolve("recovered avatar.png");
    client.readResult = {
      thread: {
        id: "thr_1",
        status: { type: "idle" },
        turns: [{
          id: "turn_1",
          status: "completed",
          startedAt: 10,
          items: [{
            type: "imageGeneration",
            status: "completed",
            savedPath: imagePath,
          }],
        }],
      },
    };

    await runtime.synchronizeSession("s1");

    expect(events).toContainEqual(expect.objectContaining({
      type: "turn_completed",
      turnId: "turn_1",
      finalResponse: `![生成图片 1](<${imagePath.replaceAll("\\", "/")}>)`,
    }));
  });

  test("tracks a live Codex turn that supersedes the locally active turn", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({ localSessionId: "s1", agentName: "codex", cwd: process.cwd(), permissionMode: "auto" });
    await runtime.startTurn("s1", "start");

    const newerStartedAt = Math.floor(Date.now() / 1_000) + 1;
    client.emit("turn/started", {
      threadId: "thr_1",
      turn: { id: "turn_2", status: "inProgress", startedAt: newerStartedAt, items: [] },
    });
    client.emit("item/started", {
      threadId: "thr_1",
      turnId: "turn_2",
      item: { type: "agentMessage", id: "final_2", phase: "final_answer" },
    });
    client.emit("item/agentMessage/delta", {
      threadId: "thr_1",
      turnId: "turn_2",
      itemId: "final_2",
      delta: "done",
    });
    client.emit("turn/completed", {
      threadId: "thr_1",
      turn: { id: "turn_2", status: "completed" },
    });

    expect(events).toContainEqual({ type: "turn_cancelled", sessionId: "s1", turnId: "turn_1" });
    expect(events).toContainEqual({
      type: "turn_started",
      sessionId: "s1",
      turnId: "turn_2",
      startedAt: newerStartedAt * 1_000,
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "turn_completed",
      turnId: "turn_2",
      finalResponse: "done",
    }));
    expect(runtime.getSession("s1")?.activeTurnId).toBeUndefined();
  });

  test("ignores a replayed historical turn start while a newer turn is active", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    await runtime.startTurn("s1", "start");
    events.length = 0;

    client.emit("turn/started", {
      threadId: "thr_1",
      turn: { id: "historical_turn", status: "inProgress", startedAt: 1, items: [] },
    });

    expect(runtime.getSession("s1")?.activeTurnId).toBe("turn_1");
    expect(events).toEqual([]);
  });

  test("ignores replayed events for the terminal turn known at resume time", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.resumeSession({
      localSessionId: "s1",
      remoteSessionId: "thr_1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
      lastTurnId: "completed_turn",
      lastTurnStatus: "completed",
    });

    client.emit("turn/started", {
      threadId: "thr_1",
      turn: { id: "completed_turn", status: "inProgress", startedAt: 1, items: [] },
    });
    client.emit("turn/completed", {
      threadId: "thr_1",
      turn: { id: "completed_turn", status: "completed" },
    });

    expect(runtime.getSession("s1")?.activeTurnId).toBeUndefined();
    expect(events).toEqual([]);
  });

  test("reconciles an idle thread status notification when completion was missed", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({ localSessionId: "s1", agentName: "codex", cwd: process.cwd(), permissionMode: "auto" });
    await runtime.startTurn("s1", "start");
    client.readResult = {
      thread: {
        id: "thr_1",
        status: { type: "idle" },
        turns: [{
          id: "turn_1",
          status: "completed",
          startedAt: 1,
          durationMs: 50,
          items: [{ type: "agentMessage", phase: "final_answer", text: "recovered" }],
        }],
      },
    };

    client.emit("thread/status/changed", { threadId: "thr_1", status: { type: "idle" } });

    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "turn_completed",
      turnId: "turn_1",
      finalResponse: "recovered",
    })));
  });

  test("auto approvals accept immediately and confirm approvals wait for a response", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    const auto = await client.invokeRequest("item/commandExecution/requestApproval", 7, {
      threadId: "thr_1",
      turnId: "turn_1",
      command: "npm test",
    });
    expect(auto).toEqual({ decision: "accept" });

    await runtime.setPermissionMode("s1", "confirm");
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    const pending = client.invokeRequest("item/commandExecution/requestApproval", 8, {
      threadId: "thr_1",
      turnId: "turn_1",
      command: "npm test",
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === "approval_requested")).toBe(true));
    await runtime.respondToApproval("s1", "8", "acceptForSession");
    await expect(pending).resolves.toEqual({ decision: "acceptForSession" });
  });

  test("fails an active turn on App Server exit and resumes the thread before the next turn", async () => {
    const client = new FakeAppServerClient();
    let disconnect: ((error: Error) => void) | undefined;
    const runtime = new CodexRuntime({
      getClient: async () => client,
      close: vi.fn(),
      onDisconnect: (listener) => {
        disconnect = listener;
        return () => { disconnect = undefined; };
      },
    }, logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({ localSessionId: "s1", agentName: "codex", cwd: process.cwd(), permissionMode: "auto" });
    await runtime.startTurn("s1", "first");

    disconnect?.(new Error("process exited"));
    expect(events).toContainEqual(expect.objectContaining({ type: "turn_failed", message: expect.stringContaining("process exited") }));
    expect(runtime.getSession("s1")?.activeTurnId).toBeUndefined();

    await runtime.startTurn("s1", "second");
    const methods = client.requests.map((request) => request.method);
    expect(methods.slice(-2)).toEqual(["thread/resume", "turn/start"]);
  });

  test("prefers a generated thread name and falls back to the thread preview", async () => {
    const client = new FakeAppServerClient();
    client.startResult = {
      thread: { id: "thr_1", name: "Generated title", preview: "First prompt" },
      model: "gpt-test",
      reasoningEffort: "medium",
    };
    client.resumeResult = {
      thread: { id: "thr_2", name: null, preview: "Restored first prompt", turns: [] },
      model: "gpt-test",
      reasoningEffort: "medium",
    };
    const runtime = new CodexRuntime(provider(client), logger());

    const created = await runtime.createSession({
      localSessionId: "created",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    const resumed = await runtime.resumeSession({
      localSessionId: "resumed",
      remoteSessionId: "thr_2",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });

    expect(created.title).toBe("Generated title");
    expect(resumed.title).toBe("Restored first prompt");
  });

  test("updates task metadata from a thread name notification without an active turn", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      title: "Prompt fallback",
      permissionMode: "auto",
    });

    client.emit("thread/name/updated", { threadId: "thr_1", threadName: "Updated title" });
    client.emit("thread/name/updated", { threadId: "thr_1", threadName: "   " });

    expect(runtime.getSession("s1")?.title).toBe("Updated title");
    expect(events).toContainEqual({
      type: "session_metadata_updated",
      sessionId: "s1",
      title: "Updated title",
    });
    expect(events.filter((event) => event.type === "session_metadata_updated")).toHaveLength(1);
  });

  test("reads title-only metadata without loading thread turns", async () => {
    const client = new FakeAppServerClient();
    client.readResult = { thread: { id: "thr_1", name: null, preview: "  Legacy\n task  " } };
    const runtime = new CodexRuntime(provider(client), logger());

    await expect(runtime.readSessionMetadata("thr_1")).resolves.toEqual({ title: "Legacy task" });
    expect(client.requests).toContainEqual({
      method: "thread/read",
      params: { threadId: "thr_1", includeTurns: false },
    });
  });

  test("inspects thread activity without loading turns", async () => {
    const client = new FakeAppServerClient();
    client.readResult = {
      thread: {
        id: "large_thread",
        status: { type: "active" },
      },
    };
    const runtime = new CodexRuntime(provider(client), logger());

    await expect(runtime.inspectRemoteSessionActivity("large_thread")).resolves.toEqual({
      active: true,
    });
    expect(client.requests).toContainEqual({
      method: "thread/read",
      params: { threadId: "large_thread", includeTurns: false },
    });
    expect(client.timeouts).toContainEqual({
      method: "thread/read",
      timeoutMs: 5_000,
    });
  });

  test("reports the in-memory turn id for activity owned by Agent Bot", async () => {
    const client = new FakeAppServerClient();
    client.readResult = {
      thread: {
        id: "thr_1",
        status: { type: "notLoaded" },
      },
    };
    const runtime = new CodexRuntime(provider(client), logger());
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    await runtime.startTurn("s1", "work");

    await expect(runtime.inspectRemoteSessionActivity("thr_1")).resolves.toEqual({
      active: true,
      activeTurnId: "turn_1",
    });
  });

  test("discovers and inspects existing Codex sessions without resuming them", async () => {
    const client = new FakeAppServerClient();
    client.listResult = {
      data: [{
        id: "external_1",
        name: "Desktop task",
        preview: "first prompt",
        cwd: "D:\\work\\desktop",
        source: "vscode",
        createdAt: 80,
        updatedAt: 100,
        recencyAt: 90,
        status: { type: "notLoaded" },
        turns: [],
      }],
      nextCursor: "next",
    };
    client.readResult = {
      thread: {
        id: "external_1",
        name: "Desktop task",
        cwd: "D:\\work\\desktop",
        source: "vscode",
        updatedAt: 100,
        status: { type: "notLoaded" },
        turns: [{
          id: "turn_external",
          status: "completed",
          items: [
            { type: "userMessage", content: [{ type: "text", text: "Initial request" }] },
            { type: "commandExecution", status: "completed" },
            { type: "userMessage", content: [{ type: "text", text: "Latest follow-up" }] },
            { type: "mcpToolCall", status: "failed" },
            { type: "agentMessage", phase: "final_answer", text: "done" },
          ],
        }],
      },
    };
    const runtime = new CodexRuntime(provider(client), logger());

    await expect(runtime.listRemoteSessions({ searchTerm: "Desktop", limit: 10 })).resolves.toEqual({
      sessions: [expect.objectContaining({
        id: "external_1",
        title: "Desktop task",
        source: "vscode",
        createdAt: 80,
        recencyAt: 90,
        lastTurnStatus: "completed",
        lastUserPrompt: "Latest follow-up",
      })],
      nextCursor: "next",
    });
    await expect(runtime.readRemoteSession("external_1")).resolves.toEqual(expect.objectContaining({
      id: "external_1",
      lastTurnId: "turn_external",
      lastCompletedTurnId: "turn_external",
      lastTurnStatus: "completed",
      lastUserPrompt: "Latest follow-up",
      lastTurnToolCount: 2,
      lastTurnCompletedToolCount: 1,
      lastTurnFailedToolCount: 1,
      lastTurnRunningToolCount: 0,
      completedTurns: [expect.objectContaining({
        id: "turn_external",
        prompt: "Latest follow-up",
      })],
    }));
    expect(client.requests.filter((request) => request.method === "thread/resume")).toHaveLength(0);
    expect(client.requests).toContainEqual({
      method: "thread/read",
      params: { threadId: "external_1", includeTurns: false },
    });
    expect(client.requests).toContainEqual(expect.objectContaining({
      method: "thread/list",
      params: expect.objectContaining({
        searchTerm: "Desktop",
        limit: 10,
        sourceKinds: ["cli", "vscode", "exec", "appServer"],
      }),
    }));
  });

  test.each(["codex", "traex"] as const)("lists every Provider on %s for initial and searched cursor pages", async (family) => {
    const client = new FakeAppServerClient();
    const threads = [
      { id: "default_task", name: "Default task", modelProvider: "openai", cwd: "D:\\dev\\agent-bot" },
      { id: "custom_task", name: "各种优化", modelProvider: "ai_coding", cwd: "D:\\dev\\agent-bot" },
    ];
    client.listResult = { data: threads, nextCursor: "page_2" };
    const runtime = new CodexRuntime({ ...provider(client), getAgentFamily: () => family }, logger());

    const first = await runtime.listRemoteSessions({ limit: 2 });
    expect(first.sessions.map((session) => session.id)).toEqual(["default_task", "custom_task"]);
    expect(first.nextCursor).toBe("page_2");
    client.listResult = { data: [threads[1]], nextCursor: null };
    const next = await runtime.listRemoteSessions({ cursor: "page_2", searchTerm: "优化", limit: 2 });
    expect(next.sessions).toEqual([expect.objectContaining({ id: "custom_task", title: "各种优化" })]);
    expect(next.nextCursor).toBeUndefined();
    const common = {
      limit: 2,
      modelProviders: [],
      sortKey: family === "traex" ? "updated_at" : "recency_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "exec", "appServer"],
      archived: false,
    };
    expect(client.requests.filter((request) => request.method === "thread/list")).toEqual([
      { method: "thread/list", params: { ...common, cursor: undefined, searchTerm: undefined } },
      { method: "thread/list", params: { ...common, cursor: "page_2", searchTerm: "优化" } },
    ]);
    expect(client.requests.every((request) => ["thread/list", "thread/turns/list"].includes(request.method))).toBe(true);
    expect(client.requests.filter((request) => request.method === "thread/turns/list"))
      .toEqual(threads.concat(threads.slice(1)).map((thread) => ({
        method: "thread/turns/list",
        params: { threadId: thread.id, limit: 1, sortDirection: "desc", itemsView: "summary" },
      })));
  });

  test("reports the latest completed turn while a newer turn is still running", async () => {
    const client = new FakeAppServerClient();
    client.readResult = {
      thread: {
        id: "active_with_history",
        cwd: "D:\\work\\active",
        source: "vscode",
        status: { type: "active" },
        turns: [
          { id: "turn_completed_1", status: "completed", items: [] },
          { id: "turn_failed", status: "failed", items: [] },
          { id: "turn_completed_2", status: "completed", items: [] },
          { id: "turn_running", status: "inProgress", items: [] },
        ],
      },
    };
    const runtime = new CodexRuntime(provider(client), logger());

    await expect(runtime.readRemoteForkSource("active_with_history")).resolves.toEqual(expect.objectContaining({
      lastTurnId: "turn_running",
      lastCompletedTurnId: "turn_completed_2",
      lastTurnStatus: "inProgress",
      status: "active",
    }));
  });

  test("reads only recent summary Turns when resolving an external Fork source", async () => {
    const client = new FakeAppServerClient();
    client.readResult = {
      thread: {
        id: "external_fork_source",
        name: "Large external task",
        cwd: "D:\\work\\large-external",
        source: "vscode",
        status: { type: "active" },
        turns: [],
      },
    };
    client.turnListResults.push(
      {
        data: [
          {
            id: "turn_running",
            status: "inProgress",
            items: [{ type: "userMessage", content: [{ type: "text", text: "Current work" }] }],
          },
          { id: "turn_failed", status: "failed", items: [] },
        ],
        nextCursor: "next_page",
      },
      {
        data: [
          { id: "turn_interrupted", status: "interrupted", items: [] },
          {
            id: "turn_completed",
            status: "completed",
            items: [{ type: "userMessage", content: [{ type: "text", text: "Fork anchor" }] }],
          },
          {
            id: "turn_older",
            status: "completed",
            items: [{ type: "userMessage", content: [{ type: "text", text: "Older history" }] }],
          },
        ],
        nextCursor: "older_history",
      },
    );
    const runtime = new CodexRuntime(provider(client), logger());

    await expect(runtime.readRemoteForkSource("external_fork_source")).resolves.toEqual(expect.objectContaining({
      id: "external_fork_source",
      lastTurnId: "turn_running",
      lastCompletedTurnId: "turn_completed",
      lastTurnStatus: "inProgress",
      completedTurns: [expect.objectContaining({ id: "turn_completed", prompt: "Fork anchor" })],
    }));
    expect(client.requests).toContainEqual({
      method: "thread/read",
      params: { threadId: "external_fork_source", includeTurns: false },
    });
    expect(client.requests).toContainEqual({
      method: "thread/turns/list",
      params: {
        threadId: "external_fork_source",
        limit: 20,
        sortDirection: "desc",
        itemsView: "summary",
      },
    });
    expect(client.requests).toContainEqual({
      method: "thread/turns/list",
      params: {
        threadId: "external_fork_source",
        cursor: "next_page",
        limit: 20,
        sortDirection: "desc",
        itemsView: "summary",
      },
    });
    expect(client.requests.some((request) => (
      request.method === "thread/read"
      && (request.params as { includeTurns?: boolean }).includeTurns === true
    ))).toBe(false);
    expect(client.requests.filter((request) => request.method === "thread/turns/list")).toHaveLength(2);
  });

  test("reads only one requested page of Turn summaries without fetching complete history", async () => {
    const client = new FakeAppServerClient();
    client.turnListResults.push({
      data: [
        { id: "running", status: "inProgress", items: [] },
        { id: "done_2", status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: "Second" }] }] },
        { id: "done_1", status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: "First" }] }] },
      ],
      nextCursor: "older",
    });
    const runtime = new CodexRuntime(provider(client), logger());
    await expect(runtime.listRemoteTurnSummaries("large_thread", { cursor: "page_2", limit: 3 })).resolves.toEqual({
      turns: [expect.objectContaining({ id: "done_2", prompt: "Second" }), expect.objectContaining({ id: "done_1", prompt: "First" })],
      nextCursor: "older",
    });
    expect(client.requests).toEqual([{
      method: "thread/turns/list",
      params: { threadId: "large_thread", cursor: "page_2", limit: 3, sortDirection: "desc", itemsView: "summary" },
    }]);
  });

  test("reads only the latest turn and does not follow its history cursor", async () => {
    const client = new FakeAppServerClient();
    client.readResult = {
      thread: {
        id: "paginated_thread",
        name: "Paginated task",
        cwd: "D:\\work\\paginated",
        source: "vscode",
        status: { type: "notLoaded" },
        turns: [],
      },
    };
    client.turnListResults.push(
      {
        data: [{
          id: "turn_2",
          status: "completed",
          items: [{ type: "userMessage", content: [{ type: "text", text: "Latest request" }] }],
        }],
        nextCursor: "page_2",
      },
      {
        data: [{
          id: "turn_2",
          status: "completed",
          items: [{ type: "userMessage", content: [{ type: "text", text: "Latest request" }] }],
        }],
        nextCursor: null,
      },
    );
    const runtime = new CodexRuntime(provider(client), logger());

    await expect(runtime.readRemoteSession("paginated_thread")).resolves.toEqual(expect.objectContaining({
      id: "paginated_thread",
      lastTurnId: "turn_2",
      lastCompletedTurnId: "turn_2",
      lastUserPrompt: "Latest request",
      completedTurns: [
        expect.objectContaining({ id: "turn_2", prompt: "Latest request" }),
      ],
    }));
    expect(client.requests).toEqual([
      {
        method: "thread/read",
        params: { threadId: "paginated_thread", includeTurns: false },
      },
      {
        method: "thread/turns/list",
        params: {
          threadId: "paginated_thread",
          limit: 1,
          sortDirection: "desc",
          itemsView: "summary",
        },
      },
    ]);
    expect(client.turnListResults).toHaveLength(1);
  });

  test("reads metadata without Turns for an unmaterialized thread", async () => {
    const client = new FakeAppServerClient();
    client.readResult = {
      thread: {
        id: "empty_thread",
        name: "Empty task",
        cwd: "D:\\work\\empty",
        source: "appServer",
        status: { type: "notLoaded" },
        turns: [],
      },
    };
    const runtime = new CodexRuntime(provider(client), logger());

    await expect(runtime.readRemoteSession("empty_thread", "metadata")).resolves.toEqual(expect.objectContaining({
      id: "empty_thread",
      title: "Empty task",
      completedTurns: [],
    }));
    expect(client.requests).toContainEqual({
      method: "thread/read",
      params: { threadId: "empty_thread", includeTurns: false },
    });
    expect(client.requests.some((request) => request.method === "thread/turns/list")).toBe(false);
  });

  test("does not retry unsupported legacy thread sorting", async () => {
    const client = new FakeAppServerClient();
    client.listErrors.push(new AppServerRequestError(
      "thread/list",
      -32602,
      "Invalid request: unknown variant recency_at, expected created_at or updated_at",
    ));
    const testLogger = logger();
    const runtime = new CodexRuntime(provider(client), testLogger);

    await expect(runtime.listRemoteSessions()).rejects.toThrow("unknown variant recency_at");

    const requests = client.requests.filter((request) => request.method === "thread/list");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.params).toEqual(expect.objectContaining({ sortKey: "recency_at" }));
  });

  test("enriches external task reads with locally persisted execution settings", async () => {
    const client = new FakeAppServerClient();
    client.readResult = {
      thread: {
        id: "external_settings",
        cwd: "D:\\work\\external-settings",
        source: "vscode",
        status: { type: "notLoaded" },
        turns: [],
      },
    };
    const activeSpy = vi.spyOn(CodexLocalActivityDetector.prototype, "activeThreads")
      .mockResolvedValue(new Map());
    const settingsSpy = vi.spyOn(CodexLocalActivityDetector.prototype, "threadSettings")
      .mockResolvedValue(new Map([["external_settings", {
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        permissionMode: "confirm",
      }]]));
    const runtime = new CodexRuntime({
      ...provider(client),
      getCodexHome: () => "C:\\codex-home",
    }, logger());

    try {
      await expect(runtime.readRemoteSession("external_settings")).resolves.toEqual(expect.objectContaining({
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        permissionMode: "confirm",
      }));
    } finally {
      activeSpy.mockRestore();
      settingsSpy.mockRestore();
    }
  });

  test("does not treat a stale inProgress turn from an unloaded app-server as active", async () => {
    const client = new FakeAppServerClient();
    client.listResult = {
      data: [{
        id: "stale_external",
        cwd: "D:\\work\\desktop",
        source: "vscode",
        status: { type: "notLoaded" },
        turns: [{ id: "stale_turn", status: "inProgress", items: [] }],
      }],
    };
    client.readResult = {
      thread: {
        id: "stale_external",
        cwd: "D:\\work\\desktop",
        source: "vscode",
        status: { type: "notLoaded" },
        turns: [{ id: "stale_turn", status: "inProgress", items: [] }],
      },
    };
    const runtime = new CodexRuntime(provider(client), logger());

    await expect(runtime.listRemoteSessions()).resolves.toEqual({
      sessions: [expect.objectContaining({
        id: "stale_external",
        status: "not_loaded",
        lastTurnId: "stale_turn",
        lastTurnStatus: "interrupted",
      })],
      nextCursor: undefined,
    });
    expect(client.requests).toContainEqual({
      method: "thread/turns/list",
      params: { threadId: "stale_external", limit: 1, sortDirection: "desc", itemsView: "summary" },
    });
  });
});

describe("Provider switching", () => {
  const target: RuntimeExecutionSettings = {
    modelProvider: "azure", model: "gpt-test", reasoningEffort: "high", permissionMode: "confirm",
  };
  const oldResponse = { thread: { id: "thr_1" }, modelProvider: "openai", model: "gpt-test" };
  const targetResponse = { ...oldResponse, modelProvider: "azure" };
  async function setup(empty = false) {
    const client = new FakeAppServerClient();
    client.startResult = oldResponse;
    client.resumeResult = targetResponse;
    client.readResult = { thread: { id: "thr_1", preview: empty ? "" : "previous prompt", status: { type: "idle" } } };
    const runtime = new CodexRuntime(provider(client), logger());
    const session = await runtime.createSession({ localSessionId: "s", agentName: "codex", cwd: process.cwd(),
      modelProvider: "openai", model: "gpt-test", reasoningEffort: "medium", permissionMode: "auto", title: "Original" });
    client.requests = [];
    return { client, runtime, session };
  }

  test("unloads idle history before resuming and does not read turn contents", async () => {
    const { client, runtime, session } = await setup();
    const persist = vi.fn(async () => { expect(session.modelProvider).toBe("openai"); });
    await runtime.setExecutionSettings("s", target, persist);
    expect(client.requests.map((r) => r.method)).toEqual([
      "thread/read", "thread/read", "thread/unsubscribe", "thread/resume",
    ]);
    expect(client.requests.at(-1)?.params).toMatchObject({ threadId: "thr_1", excludeTurns: true, modelProvider: "azure" });
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ ...target, remoteSessionId: "thr_1" }));
    expect(session).toMatchObject(target);
  });

  test("forks the latest completed Turn when resume ignores Provider settings", async () => {
    const { client, runtime, session } = await setup();
    client.resumeResults.push(oldResponse);
    client.turnListResults.push({
      data: [
        { id: "turn_failed", status: "failed" },
        { id: "turn_interrupted", status: "interrupted" },
        { id: "turn_latest", status: "completed" },
      ],
      nextCursor: null,
    });
    client.forkResult = {
      thread: { id: "thr_provider_fork", turns: [] },
      modelProvider: "azure",
      model: "gpt-test",
      reasoningEffort: "high",
    };

    await runtime.setExecutionSettings("s", target);

    expect(client.requests).toContainEqual({
      method: "thread/fork",
      params: expect.objectContaining({
        threadId: "thr_1",
        lastTurnId: "turn_latest",
        modelProvider: "azure",
        model: "gpt-test",
        excludeTurns: true,
      }),
    });
    expect(client.requests).toContainEqual({
      method: "thread/name/set",
      params: { threadId: "thr_provider_fork", name: "Original" },
    });
    expect(client.requests).toContainEqual({
      method: "thread/unsubscribe",
      params: { threadId: "thr_1" },
    });
    expect(session).toMatchObject({
      ...target,
      remoteSessionId: "thr_provider_fork",
      title: "Original",
    });
  });

  test("does not fork unfinished history when no completed Turn exists", async () => {
    const { client, runtime, session } = await setup();
    client.resumeResults.push(oldResponse, oldResponse);
    client.turnListResults.push({
      data: [{ id: "failed", status: "failed" }, { id: "interrupted", status: "interrupted" }],
      nextCursor: null,
    });
    const persist = vi.fn();

    await expect(runtime.setExecutionSettings("s", target, persist)).rejects.toThrow("已完成的 Turn");

    expect(client.requests.some((request) => request.method === "thread/fork")).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    expect(session).toMatchObject({ remoteSessionId: "thr_1", modelProvider: "openai" });
  });

  test("replaces only a proven empty thread and waits for persistence before starting a turn", async () => {
    const { client, runtime, session } = await setup(true);
    client.startResult = { ...targetResponse, thread: { id: "replacement" } };
    let finish!: () => void;
    const persisted = new Promise<void>((resolve) => { finish = resolve; });
    const persist = vi.fn(async () => persisted);
    const switching = runtime.setExecutionSettings("s", target, persist);
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    expect(session.remoteSessionId).toBe("thr_1");
    expect(await runtime.release()).toEqual({ status: "busy", activeSessionIds: ["s"] });
    const starting = runtime.startTurn("s", "next prompt");
    expect(client.requests.some((r) => r.method === "turn/start")).toBe(false);
    finish();
    await switching;
    await starting;
    expect(client.requests).toContainEqual({ method: "thread/turns/list", params: {
      threadId: "thr_1", limit: 1, sortDirection: "desc", itemsView: "summary",
    } });
    expect(client.requests).toContainEqual({ method: "thread/name/set", params: { threadId: "replacement", name: "Original" } });
    expect(client.requests).toContainEqual({ method: "thread/unsubscribe", params: { threadId: "thr_1" } });
    expect(client.requests.at(-1)).toMatchObject({ method: "turn/start", params: {
      threadId: "replacement", model: "gpt-test", effort: "high", approvalPolicy: "on-request",
    } });
    expect(session).toMatchObject({ ...target, remoteSessionId: "replacement", title: "Original", cwd: process.cwd() });
  });

  test.each(["local", "remote"])("refuses an active %s turn without detaching", async (kind) => {
    const { client, runtime, session } = await setup();
    if (kind === "local") session.activeTurnId = "running";
    else client.readResult = { thread: { id: "thr_1", status: { type: "active" } } };
    await expect(runtime.setExecutionSettings("s", target)).rejects.toThrow("当前任务正在执行");
    expect(client.requests.every((r) => r.method === "thread/read")).toBe(true);
  });

  test("rechecks active status immediately before unloading", async () => {
    const { client, runtime } = await setup();
    client.readResults.push(
      { thread: { id: "thr_1", preview: "history", status: { type: "idle" } } },
      { thread: { id: "thr_1", status: { type: "active" } } },
    );
    await expect(runtime.setExecutionSettings("s", target)).rejects.toThrow("当前任务正在执行");
    expect(client.requests.some((r) => r.method === "thread/unsubscribe")).toBe(false);
  });

  test.each(["fork", "resume"])("does not replace a %s thread without its own message", async (kind) => {
    const { client, runtime } = await setup(true);
    client.forkResult = oldResponse;
    client.resumeResult = oldResponse;
    const input = { localSessionId: "inherited", remoteSessionId: "source", agentName: "codex",
      cwd: process.cwd(), permissionMode: "auto" as const, modelProvider: "openai", model: "gpt-test", reasoningEffort: "medium" };
    if (kind === "fork") await runtime.forkSession({ ...input, lastTurnId: "inherited-turn" });
    else await runtime.resumeSession(input);
    client.resumeResults.push(new AppServerRequestError("thread/resume", -32600, "invalid paginated history lineage: missing source rollout"));
    client.requests = [];
    await expect(runtime.setExecutionSettings("inherited", target)).rejects.toThrow("missing source rollout");
    expect(client.requests.some((r) => r.method === "thread/start" || r.method === "thread/turns/list")).toBe(false);
    expect(runtime.getSession("inherited")?.remoteSessionId).toBe("thr_1");
  });

  test.each([
    ["old Provider", oldResponse, "Provider 未生效"],
    ["fallback model", { ...targetResponse, model: "different" }, "模型未生效"],
    ["unsupported model", new AppServerRequestError("thread/resume", -1, "model gpt-test is not supported"), "不支持当前模型"],
    ["authentication", new AppServerRequestError("thread/resume", -1, "authentication failed"), "配置和认证"],
    ["active writer", new AppServerRequestError("thread/resume", -1, "thread already has an active writer"), "原客户端释放任务"],
  ])("rejects %s and restores the old Provider without persisting", async (_name, response, expected) => {
    const { client, runtime, session } = await setup();
    client.resumeResults.push(response, oldResponse);
    if (!(response instanceof Error)) {
      client.turnListResults.push({ data: [{ id: "completed", status: "completed" }], nextCursor: null });
      client.forkResult = response;
    }
    const persist = vi.fn();
    await expect(runtime.setExecutionSettings("s", target, persist)).rejects.toThrow(String(expected));
    expect(persist).not.toHaveBeenCalled();
    expect(session).toMatchObject({ remoteSessionId: "thr_1", modelProvider: "openai", model: "gpt-test", reasoningEffort: "medium", permissionMode: "auto" });
    expect(client.requests.at(-1)).toMatchObject({ method: "thread/resume", params: { modelProvider: "openai" } });
    expect(client.requests.some((r) => r.method === "thread/start")).toBe(false);
  });

  test.each([true, false])("preserves settings on persistence failure (empty=%s)", async (empty) => {
    const { client, runtime, session } = await setup(empty);
    client.startResult = { ...targetResponse, thread: { id: "unused" } };
    client.resumeResults.push(targetResponse, oldResponse);
    await expect(runtime.setExecutionSettings("s", target, async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(session).toMatchObject({ remoteSessionId: "thr_1", modelProvider: "openai" });
    if (empty) expect(client.requests.at(-1)).toEqual({ method: "thread/unsubscribe", params: { threadId: "unused" } });
    else expect(client.requests.at(-1)).toMatchObject({ method: "thread/resume", params: { modelProvider: "openai" } });
  });

  test("blocks the next turn after failed recovery until settings are verified again", async () => {
    const { client, runtime } = await setup();
    client.resumeResults.push(oldResponse, new Error("restore failed"));
    await expect(runtime.setExecutionSettings("s", target)).rejects.toThrow("远端恢复失败");
    await expect(runtime.startTurn("s", "do not use uncertain settings")).rejects.toThrow("远端恢复失败");
    expect(client.requests.some((r) => r.method === "turn/start")).toBe(false);
    await runtime.setExecutionSettings("s", target);
    await expect(runtime.startTurn("s", "verified")).resolves.toBe("turn_1");
  });

  test("serializes consecutive switches so the last verified choice wins", async () => {
    const { client, runtime, session } = await setup();
    client.resumeResults.push(targetResponse, { ...targetResponse, modelProvider: "third" });
    const persist = vi.fn(async () => undefined);
    await Promise.all([
      runtime.setExecutionSettings("s", target, persist),
      runtime.setExecutionSettings("s", { ...target, modelProvider: "third" }, persist),
    ]);
    expect(persist.mock.calls.map((call) => (call as unknown[])[0])).toMatchObject([
      { modelProvider: "azure" }, { modelProvider: "third" },
    ]);
    expect(session.modelProvider).toBe("third");
  });

  test("does not unload another client's task", async () => {
    const { client, runtime } = await setup();
    client.unsubscribeResult = { status: "notSubscribed" };
    await expect(runtime.setExecutionSettings("s", target)).rejects.toThrow("其他客户端加载");
    expect(client.requests.some((r) => r.method === "thread/resume")).toBe(false);
  });

  test("does not replace a task with a Goal even before its first turn", async () => {
    const { client, runtime } = await setup(true);
    await runtime.setGoal("s", { objective: "keep this goal" });
    client.requests = [];
    await runtime.setExecutionSettings("s", target);
    expect(client.requests.some((r) => r.method === "thread/start")).toBe(false);
    expect(client.goalResult?.objective).toBe("keep this goal");
  });

  test("refuses a turn detected in local state even if App Server reports idle", async () => {
    const client = new FakeAppServerClient();
    const active = vi.spyOn(CodexLocalActivityDetector.prototype, "activeThreads").mockResolvedValue(new Map([["thr_1", "running-turn"]]));
    try {
      const runtime = new CodexRuntime({ ...provider(client), getCodexHome: () => os.tmpdir() }, logger());
      await runtime.createSession({ localSessionId: "s", agentName: "codex", cwd: process.cwd(), permissionMode: "auto" });
      client.requests = [];
      await expect(runtime.setExecutionSettings("s", target)).rejects.toThrow("当前任务正在执行");
      expect(client.requests.some((r) => r.method === "thread/unsubscribe")).toBe(false);
    } finally {
      active.mockRestore();
    }
  });
});

describe("CodexRuntime mode confirmations", () => {
  const requestId = "mode:thr_1:request_1";
  const notification = {
    threadId: "thr_1", turnId: "turn_1", requestId: "request_1", targetMode: "default",
    reason: "Review the implementation plan", allowedPrompts: [{ tool: "PowerShell", prompt: "run tests" }],
  };

  async function setup() {
    const client = new FakeAppServerClient();
    let disconnect: ((error: Error) => void) | undefined;
    const runtime = new CodexRuntime({
      ...provider(client),
      onDisconnect: (listener) => { disconnect = listener; return () => { disconnect = undefined; }; },
    }, logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({ localSessionId: "s1", agentName: "traex", cwd: process.cwd(), permissionMode: "auto" });
    await runtime.startTurn("s1", "create a plan");
    events.length = 0;
    return { client, runtime, events, disconnect: () => disconnect?.(new Error("process exited")) };
  }

  test.each(["plan", "default"])("requires explicit confirmation for %s even with automatic permissions", async (targetMode) => {
    const { client, runtime, events } = await setup();
    client.emit("mode/changeRequested", { ...notification, targetMode });
    client.emit("mode/changeRequested", { ...notification, targetMode });
    expect(events).toEqual([{
      type: "approval_requested", sessionId: "s1", turnId: "turn_1",
      request: {
        id: requestId, kind: "mode_change",
        title: targetMode === "default" ? "确认方案并开始执行" : "确认进入规划模式",
        reason: "Review the implementation plan\n- PowerShell: run tests",
        options: [
          { id: "accept", label: targetMode === "default" ? "Approve Plan" : "Enter Plan Mode" },
          { id: "decline", label: "Reject" }, { id: "cancel", label: "Cancel Request" },
        ],
      },
    }]);
    expect(client.requests.some((entry) => entry.method === "mode/change/respond")).toBe(false);
    expect(runtime.getSession("s1")?.activeTurnId).toBe("turn_1");
    runtime.close();
  });

  test.each([
    ["accept", "approved"], ["decline", "rejected"], ["cancel", "cancelled"],
  ] as const)("sends %s as %s without completing the turn", async (decision, remoteDecision) => {
    const { client, runtime, events } = await setup();
    client.emit("mode/changeRequested", notification);
    await runtime.respondToApproval("s1", requestId, decision);
    expect(client.requests.at(-1)).toEqual({
      method: "mode/change/respond", params: { threadId: "thr_1", requestId: "request_1", decision: remoteDecision },
    });
    expect(events.at(-1)).toEqual({ type: "approval_resolved", sessionId: "s1", turnId: "turn_1", requestId, decision });
    expect(runtime.getSession("s1")?.activeTurnId).toBe("turn_1");
    client.emit("mode/changeRequested", notification);
    expect(events.filter((event) => event.type === "approval_requested")).toHaveLength(1);
    await expect(runtime.respondToApproval("s1", requestId, decision)).rejects.toThrow("no longer pending");
    runtime.close();
  });

  test("rejects incorrect sessions and unsupported decisions while retaining the request", async () => {
    const { client, runtime } = await setup();
    client.emit("mode/changeRequested", notification);
    await expect(runtime.respondToApproval("s2", requestId, "accept")).rejects.toThrow("no longer pending");
    await expect(runtime.respondToApproval("s1", requestId, "acceptForSession")).rejects.toThrow("Invalid mode change decision");
    expect(client.requests.some((entry) => entry.method === "mode/change/respond")).toBe(false);
    await runtime.respondToApproval("s1", requestId, "decline");
    runtime.close();
  });

  test("retains failed confirmations for retry and blocks concurrent responses", async () => {
    const { client, runtime, events } = await setup();
    client.emit("mode/changeRequested", notification);
    let fail: ((error: Error) => void) | undefined;
    client.modeChangeResponse = () => new Promise<void>((_resolve, reject) => { fail = reject; });
    const response = runtime.respondToApproval("s1", requestId, "accept");
    const rejected = expect(response).rejects.toThrow("transport failed");
    await vi.waitFor(() => expect(fail).toBeDefined());
    await expect(runtime.respondToApproval("s1", requestId, "accept")).rejects.toThrow("already in progress");
    fail?.(new Error("transport failed"));
    await rejected;
    expect(events.filter((event) => event.type === "approval_resolved")).toHaveLength(0);
    client.modeChangeResponse = undefined;
    await runtime.respondToApproval("s1", requestId, "accept");
    expect(events.filter((event) => event.type === "approval_resolved")).toHaveLength(1);
    runtime.close();
  });

  test.each([
    ["approved", "accept"], ["rejected", "decline"], ["cancelled", "cancel"],
  ] as const)("handles a remote %s resolution once", async (decision, localDecision) => {
    const { client, runtime, events } = await setup();
    client.emit("mode/changeRequested", notification);
    client.emit("mode/changeResolved", { ...notification, targetMode: "plan", decision });
    client.emit("mode/changeResolved", { ...notification, requestId: "unrelated", decision });
    expect(events.filter((event) => event.type === "approval_resolved")).toHaveLength(0);
    client.emit("mode/changeResolved", { ...notification, decision });
    client.emit("mode/changeResolved", { ...notification, decision });
    expect(events.filter((event) => event.type === "approval_resolved")).toEqual([{
      type: "approval_resolved", sessionId: "s1", turnId: "turn_1", requestId, decision: localDecision,
    }]);
    await expect(runtime.respondToApproval("s1", requestId, "accept")).rejects.toThrow("no longer pending");
    runtime.close();
  });

  test("does not resolve twice when the remote notification precedes the response", async () => {
    const { client, runtime, events } = await setup();
    client.emit("mode/changeRequested", notification);
    client.modeChangeResponse = async () => { client.emit("mode/changeResolved", { ...notification, decision: "approved" }); };
    await runtime.respondToApproval("s1", requestId, "accept");
    expect(events.filter((event) => event.type === "approval_resolved")).toHaveLength(1);
    runtime.close();
  });

  test.each(["completed", "interrupted", "failed", "disconnect", "close"])("clears pending confirmations on %s", async (status) => {
    const { client, runtime, disconnect } = await setup();
    client.emit("mode/changeRequested", notification);
    if (status === "disconnect") disconnect();
    else if (status === "close") runtime.close();
    else client.emit("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status } });
    client.emit("mode/changeRequested", notification);
    await expect(runtime.respondToApproval("s1", requestId, "accept")).rejects.toThrow("no longer pending");
    expect(client.requests.some((entry) => entry.method === "mode/change/respond")).toBe(false);
    runtime.close();
  });

  test("keeps plan text in progress rather than the final answer", async () => {
    const { client, runtime, events } = await setup();
    client.emit("item/plan/delta", { threadId: "thr_1", turnId: "turn_1", itemId: "plan_1", delta: "Review" });
    client.emit("item/completed", { threadId: "thr_1", turnId: "turn_1", item: { id: "plan_1", type: "plan", text: "Review and test" } });
    client.emit("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } });
    expect(events.filter((event) => event.type === "progress")).toEqual([
      { type: "progress", sessionId: "s1", turnId: "turn_1", activityId: "commentary:plan:plan_1", text: "Review", append: true },
      { type: "progress", sessionId: "s1", turnId: "turn_1", activityId: "commentary:plan:plan_1", text: "Review and test", append: false },
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "turn_completed", finalResponse: "" }));
    runtime.close();
  });
});

class FakeAppServerClient {
  requests: Array<{ method: string; params: unknown }> = [];
  timeouts: Array<{ method: string; timeoutMs: number | undefined }> = [];
  startResult: unknown = { thread: { id: "thr_1" }, model: "gpt-test", reasoningEffort: "medium" };
  resumeResult: unknown = { thread: { id: "thr_1", turns: [] }, model: "gpt-test", reasoningEffort: "medium" };
  resumeResults: unknown[] = [];
  unsubscribeResult: unknown = { status: "unsubscribed" };
  forkResult: unknown = { thread: { id: "thr_forked", turns: [] }, model: "gpt-test", reasoningEffort: "medium" };
  forkErrors: Error[] = [];
  readResult: unknown = { thread: { id: "thr_1", name: null, preview: "" } };
  readErrors: Error[] = [];
  readResults: unknown[] = [];
  turnListResults: unknown[] = [];
  turnListErrors: Error[] = [];
  listResult: unknown = { data: [], nextCursor: null };
  listErrors: Error[] = [];
  turnStartErrors: Error[] = [];
  modeChangeResponse?: () => Promise<void>;
  configResult: unknown = { config: { model_provider: "openai", model_providers: {} } };
  modelListResult: unknown = { data: [{
    id: "gpt-test",
    displayName: "GPT Test",
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast" },
      { reasoningEffort: "medium", description: "Balanced" },
    ],
    defaultReasoningEffort: "medium",
  }] };
  goalResult: RuntimeGoal | null = null;
  private notificationListener?: (method: string, params: unknown) => void;
  private readonly requestHandlers = new Map<
    string,
    (params: unknown, id: string | number, method: string) => Promise<unknown>
  >();

  async request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    this.requests.push({ method, params });
    this.timeouts.push({ method, timeoutMs });
    if (method === "mode/change/respond") {
      await this.modeChangeResponse?.();
      return {} as T;
    }
    if (method === "thread/start") return this.startResult as T;
    if (method === "thread/resume") {
      const result = this.resumeResults.shift() ?? this.resumeResult;
      if (result instanceof Error) throw result;
      return result as T;
    }
    if (method === "thread/unsubscribe") return this.unsubscribeResult as T;
    if (method === "thread/fork") {
      const error = this.forkErrors.shift();
      if (error) throw error;
      return this.forkResult as T;
    }
    if (method === "thread/read") {
      if ((params as { includeTurns?: boolean }).includeTurns) throw new Error("Full history must not be requested");
      const error = this.readErrors.shift();
      if (error) throw error;
      const result = (this.readResults.shift() ?? this.readResult) as { thread: Record<string, unknown> };
      return { thread: { ...result.thread, turns: [] } } as T;
    }
    if (method === "thread/turns/list") {
      const error = this.turnListErrors.shift();
      if (error) throw error;
      const turns = (this.readResult as { thread: { turns?: unknown[] } }).thread.turns ?? [];
      const limit = (params as { limit: number }).limit;
      return (this.turnListResults.shift() ?? { data: turns.slice().reverse().slice(0, limit), nextCursor: null }) as T;
    }
    if (method === "thread/list") {
      const error = this.listErrors.shift();
      if (error) throw error;
      return this.listResult as T;
    }
    if (method === "config/read") return this.configResult as T;
    if (method === "thread/goal/get") return { goal: this.goalResult } as T;
    if (method === "thread/goal/set") {
      const update = params as Partial<RuntimeGoal>;
      this.goalResult = {
        threadId: "thr_1",
        objective: update.objective ?? this.goalResult?.objective ?? "",
        status: update.status ?? this.goalResult?.status ?? "active",
        tokenBudget: update.tokenBudget ?? this.goalResult?.tokenBudget ?? null,
        tokensUsed: this.goalResult?.tokensUsed ?? 0,
        timeUsedSeconds: this.goalResult?.timeUsedSeconds ?? 0,
        createdAt: this.goalResult?.createdAt ?? 1_776_272_400,
        updatedAt: 1_776_272_460,
      };
      return { goal: this.goalResult } as T;
    }
    if (method === "thread/goal/clear") {
      const cleared = this.goalResult !== null;
      this.goalResult = null;
      return { cleared } as T;
    }
    if (method === "turn/start") {
      const error = this.turnStartErrors.shift();
      if (error) throw error;
      return { turn: { id: "turn_1", status: "inProgress" } } as T;
    }
    if (method === "model/list") return this.modelListResult as T;
    return {} as T;
  }

  notify(): void {}

  registerRequestHandler(
    method: string,
    handler: (params: unknown, id: string | number, method: string) => Promise<unknown>,
  ): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListener = listener;
    return () => {
      this.notificationListener = undefined;
    };
  }

  emit(method: string, params: unknown): void {
    this.notificationListener?.(method, params);
  }

  invokeRequest(method: string, id: string | number, params: unknown): Promise<unknown> {
    const handler = this.requestHandlers.get(method);
    if (!handler) throw new Error(`Missing request handler: ${method}`);
    return handler(params, id, method);
  }
}

function provider(client: FakeAppServerClient): AppServerClientProvider {
  return { getClient: async () => client, close: vi.fn() };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
}
