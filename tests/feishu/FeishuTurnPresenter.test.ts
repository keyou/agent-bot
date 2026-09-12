import { describe, expect, test, vi } from "vitest";
import { CardRenderer } from "../../src/feishu/CardRenderer.js";
import { FeishuTurnPresenter } from "../../src/feishu/FeishuTurnPresenter.js";
import type { FeishuOutbound } from "../../src/feishu/types.js";
import type { AgentEvent } from "../../src/runtime/types.js";
import type { TurnPresentationStore } from "../../src/feishu/FeishuTurnPresenter.js";

function completed(finalResponse = "answer"): AgentEvent {
  return { type: "turn_completed", sessionId: "s1", turnId: "turn_1", finalResponse, durationMs: 1_000 };
}

function createFixture(delivered = false, renderer?: CardRenderer) {
  const outbound: FeishuOutbound = {
    sendText: vi.fn(async () => "text_1"),
    sendMarkdown: vi.fn(async () => "final_1"),
    sendInteractiveCard: vi.fn(async () => "progress_1"),
    replyMarkdown: vi.fn(async () => "thread_final_1"),
    replyInteractiveCard: vi.fn(async () => "thread_progress_1"),
    updateInteractiveCard: vi.fn(async () => undefined),
    addReaction: vi.fn(async () => "reaction_1"),
    deleteReaction: vi.fn(async () => undefined),
  };
  const store = {
    saveTurnSnapshot: vi.fn(),
    promotePendingTurn: vi.fn(),
    getTurnSnapshot: vi.fn(),
    getTurnContextKey: vi.fn(),
    saveTurnDelivery: vi.fn(),
    saveFinalDeliveryProgress: vi.fn(),
    markFinalDelivered: vi.fn(),
    getTurnDelivery: vi.fn(() => (delivered
      ? { progressMessageId: undefined as string | undefined, finalDelivered: true, finalMessageIds: ["old"] }
      : undefined)),
  };
  const presenter = new FeishuTurnPresenter(outbound, store, renderer, {
    normalIntervalMs: 1,
    criticalGapMs: 0,
  });
  presenter.registerSession("s1", "chat_id:c1", undefined, "D:\\dev\\agent-bot");
  return { presenter, outbound, store };
}

describe("FeishuTurnPresenter", () => {
  test("creates one progress card and delivers a duplicated completion once", async () => {
    const { presenter, outbound, store } = createFixture();
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() - 1_000 });
    await Promise.all([presenter.onEvent(completed()), presenter.onEvent(completed())]);

    expect(outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    expect(outbound.sendMarkdown).toHaveBeenCalledOnce();
    expect(outbound.addReaction).toHaveBeenCalledOnce();
    expect(outbound.addReaction).toHaveBeenCalledWith("progress_1", "OnIt");
    expect(outbound.deleteReaction).toHaveBeenCalledOnce();
    expect(outbound.deleteReaction).toHaveBeenCalledWith("progress_1", "reaction_1");
    expect(store.markFinalDelivered).toHaveBeenCalledOnce();
    expect(store.markFinalDelivered).toHaveBeenCalledWith("turn_1", ["final_1"]);
    expect(store.saveTurnSnapshot).toHaveBeenCalledWith(
      "turn_1",
      "s1",
      expect.objectContaining({ projectCwd: "D:\\dev\\agent-bot" }),
      "chat_id:c1",
    );
  });

  test("normalizes project-local and external file link labels before delivering the final answer", async () => {
    const { presenter, outbound } = createFixture();
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });
    await presenter.onEvent(completed([
      "[inside.ts](D:\\dev\\agent-bot\\src\\inside.ts:10)",
      "[app.ts](D:\\dev\\agent-bot\\src\\app.ts:11)",
      "[runner.py](C:\\Users\\Admin\\runtime\\runner.py:122)",
    ].join("\n")));

    expect(outbound.sendMarkdown).toHaveBeenCalledWith(
      "chat_id:c1",
      [
        "[inside.ts:10](D:\\dev\\agent-bot\\src\\inside.ts:10)",
        "[app.ts:11](D:\\dev\\agent-bot\\src\\app.ts:11)",
        "runner.py(`C:\\Users\\Admin\\runtime\\runner.py:122`)",
      ].join("\n"),
      expect.stringMatching(/^codex-final-/),
    );
  });

  test("uses the local file viewer resolver for final answer links", async () => {
    const outbound: FeishuOutbound = {
      sendText: vi.fn(async () => "text_1"),
      sendMarkdown: vi.fn(async () => "final_1"),
      sendInteractiveCard: vi.fn(async () => "progress_1"),
      updateInteractiveCard: vi.fn(async () => undefined),
    };
    const store = new MemoryStore();
    const presenter = new FeishuTurnPresenter(outbound, store, undefined, {
      criticalGapMs: 0,
      localFileUrl: (_filePath, reference) => `http://127.0.0.1:3210/view/file?sig=signed${reference ? "#L10" : ""}`,
    });
    presenter.registerSession("s1", "chat_id:c1", undefined, "D:\\dev\\agent-bot");

    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });
    await presenter.onEvent(completed("[inside.ts](D:\\dev\\agent-bot\\src\\inside.ts:10)"));

    expect(outbound.sendMarkdown).toHaveBeenCalledWith(
      "chat_id:c1",
      "[inside.ts:10](http://127.0.0.1:3210/view/file?sig=signed#L10)",
      expect.stringMatching(/^codex-final-/),
    );
  });

  test("uses the local file viewer resolver for live and historical thinking-card links", async () => {
    const outbound: FeishuOutbound = {
      sendText: vi.fn(async () => "text_1"),
      sendMarkdown: vi.fn(async () => "final_1"),
      sendInteractiveCard: vi.fn(async () => "progress_1"),
      updateInteractiveCard: vi.fn(async () => undefined),
    };
    const store = new MemoryStore();
    const presenter = new FeishuTurnPresenter(outbound, store, undefined, {
      criticalGapMs: 0,
      localFileUrl: () => "http://127.0.0.1:3210/view/log?sig=signed",
    });
    presenter.registerSession("s1", "chat_id:c1", undefined, "D:\\dev\\agent-bot");

    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });
    await presenter.onEvent({
      type: "progress",
      sessionId: "s1",
      turnId: "turn_1",
      activityId: "commentary:log",
      text: "日志：[compact_snapshot_text_20260830.log](D:\\dev\\agent-bot\\compact_snapshot_text_20260830.log)",
    });
    await presenter.flushAll();

    const liveCard = JSON.stringify(
      (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1],
    );
    expect(liveCard).toContain("http://127.0.0.1:3210/view/log?sig=signed");
    expect(JSON.stringify(store.getTurnSnapshot("turn_1"))).not.toContain("http://127.0.0.1:3210");

    await presenter.showDetails("chat_id:c1", "turn_1");
    const detailsCard = JSON.stringify(
      (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1],
    );
    expect(detailsCard).toContain("http://127.0.0.1:3210/view/log?sig=signed");

    await presenter.showActivityPage("chat_id:c1", "turn_1", 0, "history_card");
    const historyCard = JSON.stringify(
      (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1],
    );
    expect(historyCard).toContain("http://127.0.0.1:3210/view/log?sig=signed");
  });

  test("adds Agent Bot branding only to the last chunk of a long final answer", async () => {
    const { outbound, store } = createFixture();
    const presenter = new FeishuTurnPresenter(outbound, store, undefined, {
      finalChunkLength: 128,
      criticalGapMs: 0,
    });
    presenter.registerSession("s1", "chat_id:c1");

    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });
    await presenter.onEvent(completed("x".repeat(150)));

    const chunks = (outbound.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[1] as string);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.slice(0, -1).every((chunk) => !chunk.includes("Powered by [AgentBot]"))).toBe(true);
    expect(chunks.at(-1)).toMatch(
      /----\n\n> Powered by \[AgentBot\]\(https:\/\/keyou\.github\.io\/agent-bot\/\)$/u,
    );
    expect(chunks.every((chunk) => chunk.length <= 128)).toBe(true);
  });

  test("adds linked Agent Bot branding to a long final answer that still fits one chunk", async () => {
    const { presenter, outbound } = createFixture();
    const answer = "x".repeat(601);

    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });
    await presenter.onEvent(completed(answer));

    expect(outbound.sendMarkdown).toHaveBeenCalledOnce();
    expect((outbound.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toBe(
      `${answer}\n\n----\n\n> Powered by [AgentBot](https://keyou.github.io/agent-bot/)`,
    );
  });

  test("does not add Agent Bot branding to a final answer with at most 600 characters", async () => {
    const { presenter, outbound } = createFixture();
    const answer = "x".repeat(600);

    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });
    await presenter.onEvent(completed(answer));

    expect(outbound.sendMarkdown).toHaveBeenCalledOnce();
    expect((outbound.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toBe(answer);
  });

  test("delivers completion after an earlier cancelled event for the same turn", async () => {
    const { presenter, outbound } = createFixture();
    await presenter.onEvent({
      type: "turn_started",
      sessionId: "s1",
      turnId: "turn_1",
      startedAt: Date.now() - 1_000,
    });
    await presenter.onEvent({ type: "turn_cancelled", sessionId: "s1", turnId: "turn_1" });
    await presenter.onEvent(completed("completed after stale cancellation"));

    expect(outbound.sendMarkdown).toHaveBeenCalledOnce();
    expect(outbound.sendMarkdown).toHaveBeenCalledWith(
      "chat_id:c1",
      "completed after stale cancellation",
      expect.stringMatching(/^codex-final-/),
    );
  });

  test.each([
    [
      "failed",
      { type: "turn_failed", sessionId: "s1", turnId: "turn_1", message: "network failed" } satisfies AgentEvent,
      "ERROR",
    ],
    [
      "cancelled",
      { type: "turn_cancelled", sessionId: "s1", turnId: "turn_1" } satisfies AgentEvent,
      "CrossMark",
    ],
  ])("replaces the running thinking-card reaction when a turn is %s", async (_status, event, terminalEmoji) => {
    const { presenter, outbound } = createFixture();
    (outbound.addReaction as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("reaction_running")
      .mockResolvedValueOnce("reaction_terminal");

    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });
    await presenter.onEvent(event);

    expect(outbound.addReaction).toHaveBeenNthCalledWith(1, "progress_1", "OnIt");
    expect(outbound.addReaction).toHaveBeenNthCalledWith(2, "progress_1", terminalEmoji);
    expect(outbound.deleteReaction).toHaveBeenCalledWith("progress_1", "reaction_running");
  });

  test("does not let thinking-card reaction failures block the final answer", async () => {
    const onError = vi.fn();
    const { presenter, outbound } = createFixture();
    (outbound.addReaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("missing reaction scope"));
    const resilientPresenter = new FeishuTurnPresenter(outbound, {
      saveTurnSnapshot: vi.fn(),
      promotePendingTurn: vi.fn(),
      getTurnSnapshot: vi.fn(),
      getTurnContextKey: vi.fn(),
      saveTurnDelivery: vi.fn(),
      saveFinalDeliveryProgress: vi.fn(),
      markFinalDelivered: vi.fn(),
      getTurnDelivery: vi.fn(),
    }, undefined, { normalIntervalMs: 1, criticalGapMs: 0, onError });
    resilientPresenter.registerSession("s1", "chat_id:c1");

    await resilientPresenter.onEvent({
      type: "turn_started",
      sessionId: "s1",
      turnId: "turn_1",
      startedAt: Date.now(),
    });
    await resilientPresenter.onEvent(completed());

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "missing reaction scope" }));
    expect(outbound.sendMarkdown).toHaveBeenCalledOnce();
  });

  test("delivers generated images when Codex completes with an empty text response", async () => {
    const { presenter, outbound } = createFixture();
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });
    await presenter.onEvent({
      type: "tool_updated",
      sessionId: "s1",
      turnId: "turn_1",
      tool: {
        id: "generated_1",
        title: "生成图片",
        kind: "image_generation",
        status: "completed",
        imagePath: "D:\\images\\avatar.png",
      },
    });
    await presenter.onEvent(completed(""));

    expect(outbound.sendMarkdown).toHaveBeenCalledWith(
      "chat_id:c1",
      "![生成图片 1](<D:/images/avatar.png>)",
      expect.stringMatching(/^codex-final-/),
    );
  });

  test("reuses the immediate starting card when the real turn id arrives", async () => {
    const { presenter, outbound, store } = createFixture();
    await presenter.startPendingTurn("s1", "chat_id:c1");
    const pendingTurnId = (store.saveTurnSnapshot as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() - 1_000 });
    expect(outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    expect(store.promotePendingTurn).toHaveBeenCalledWith(
      pendingTurnId,
      "turn_1",
      "s1",
      expect.objectContaining({ turnId: "turn_1", status: "running" }),
      "chat_id:c1",
    );
    await vi.waitFor(() => expect(outbound.updateInteractiveCard).toHaveBeenCalled());
  });

  test("replaces a failed pending turn with a dedicated card when requested", async () => {
    const { presenter, outbound } = createFixture();
    const replacementCard = {
      schema: "2.0",
      header: { title: { tag: "plain_text", content: "任务被其他程序占用" } },
    };
    await presenter.startPendingTurn("s1", "chat_id:c1", "Occupied task");

    const replaced = await presenter.failPendingTurn("s1", "active writer", replacementCard);

    expect(replaced).toBe(true);
    expect(outbound.updateInteractiveCard).toHaveBeenLastCalledWith("progress_1", replacementCard);
  });

  test("persists and renders the registered Agent label on the starting card", async () => {
    const { presenter, outbound, store } = createFixture();
    presenter.registerSession("s1", "chat_id:c1", undefined, "D:\\dev\\agent-bot", "TraeX", "gpt-5.3-codex");

    await presenter.startPendingTurn("s1", "chat_id:c1");

    expect(store.saveTurnSnapshot).toHaveBeenCalledWith(
      expect.stringMatching(/^pending_/),
      "s1",
      expect.objectContaining({ agentLabel: "TraeX", model: "gpt-5.3-codex" }),
      "chat_id:c1",
    );
    expect(JSON.stringify((outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]))
      .toContain("正在连接 TraeX…");
  });

  test("updates a persisted progress card instead of sending another card after restart", async () => {
    const { presenter, outbound, store } = createFixture();
    store.getTurnDelivery.mockReturnValue({
      progressMessageId: "persisted_progress",
      finalDelivered: false,
      finalMessageIds: [],
    });

    await presenter.onEvent({
      type: "turn_started",
      sessionId: "s1",
      turnId: "turn_1",
      startedAt: Date.now(),
    });

    expect(outbound.sendInteractiveCard).not.toHaveBeenCalled();
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("persisted_progress", expect.any(Object));
  });

  test("keeps a group turn progress card and final answer inside the triggering message thread", async () => {
    const { presenter, outbound, store } = createFixture();
    const target = { messageId: "om_question", replyInThread: true as const };

    await presenter.startPendingTurn("s1", "chat_id:c1", "Group question", target, "Current group prompt");
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });
    await presenter.onEvent(completed("thread answer"));

    expect(outbound.replyInteractiveCard).toHaveBeenCalledWith(
      "chat_id:c1",
      target,
      expect.any(Object),
      expect.stringMatching(/^codex-progress-/),
    );
    expect(outbound.replyMarkdown).toHaveBeenCalledWith(
      "chat_id:c1",
      target,
      "thread answer",
      expect.stringMatching(/^codex-final-/),
    );
    expect(outbound.sendInteractiveCard).not.toHaveBeenCalled();
    expect(outbound.sendMarkdown).not.toHaveBeenCalled();
    expect(store.saveTurnSnapshot).toHaveBeenCalledWith(
      "turn_1",
      "s1",
      expect.objectContaining({ replyTarget: target }),
      "chat_id:c1",
    );
  });

  test("keeps the current prompt in the active card when Codex generates a new task title", async () => {
    const { presenter, outbound } = createFixture();
    presenter.registerSession("s1", "chat_id:c1", "Initial title");
    await presenter.startPendingTurn("s1", "chat_id:c1", "Initial title", undefined, "Current prompt");
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });

    presenter.updateSessionTitle("s1", "Generated title");
    await presenter.flushAll();

    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith(
      "progress_1",
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({ tag: "plain_text", content: "⏳ 正在处理：Current prompt" }),
        }),
      }),
    );
  });

  test("updates an already-created pending card with the prompt before the real turn starts", async () => {
    const { presenter, outbound, store } = createFixture();
    await presenter.startPendingTurn("s1", "chat_id:c1", "Task title");

    await presenter.startPendingTurn("s1", "chat_id:c1", "Task title", undefined, "Actual prompt");
    await presenter.flushAll();

    expect(store.saveTurnSnapshot).toHaveBeenLastCalledWith(
      expect.stringMatching(/^pending_/),
      "s1",
      expect.objectContaining({ prompt: "Actual prompt" }),
      "chat_id:c1",
    );
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith(
      "progress_1",
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({ tag: "plain_text", content: "⏳ 正在处理：Actual prompt" }),
        }),
      }),
    );
  });

  test("persists a steer message and updates the active thinking card", async () => {
    const { presenter, outbound, store } = createFixture();
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });

    await presenter.appendSteerMessage("s1", "turn_1", "同时补充测试", "om_steer");
    await presenter.flushAll();

    expect(store.saveTurnSnapshot).toHaveBeenLastCalledWith(
      "turn_1",
      "s1",
      expect.objectContaining({
        activities: expect.arrayContaining([
          { kind: "user", id: "steer:om_steer", text: "同时补充测试" },
        ]),
      }),
      "chat_id:c1",
    );
    expect(JSON.stringify((outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]))
      .toContain("**🙋 同时补充测试**");
  });

  test("coalesces command output deltas into an incremental tool panel update", async () => {
    const { presenter, outbound, store } = createFixture();
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });
    await presenter.onEvent({
      type: "tool_started",
      sessionId: "s1",
      turnId: "turn_1",
      tool: { id: "command_1", title: "npm test", kind: "command", status: "running", command: "npm test" },
    });
    await presenter.flushAll();
    (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mockClear();

    await presenter.onEvent({
      type: "tool_output_delta",
      sessionId: "s1",
      turnId: "turn_1",
      toolId: "command_1",
      delta: "test 1 passed\n",
    });
    await presenter.onEvent({
      type: "tool_output_delta",
      sessionId: "s1",
      turnId: "turn_1",
      toolId: "command_1",
      delta: "test 2 passed\n",
    });
    await presenter.flushAll();

    expect(outbound.updateInteractiveCard).toHaveBeenCalledOnce();
    expect(JSON.stringify((outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1])).toContain(
      "test 1 passed\\ntest 2 passed",
    );
    expect(store.saveTurnSnapshot).toHaveBeenLastCalledWith(
      "turn_1",
      "s1",
      expect.objectContaining({ activeTool: expect.objectContaining({ output: "test 1 passed\ntest 2 passed\n" }) }),
      "chat_id:c1",
    );
  });

  test("refreshes elapsed time every three seconds while a turn is running", async () => {
    vi.useFakeTimers();
    try {
      const { presenter, outbound } = createFixture();
      await presenter.onEvent({
        type: "turn_started",
        sessionId: "s1",
        turnId: "turn_1",
        startedAt: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(0);
      (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mockClear();

      await vi.advanceTimersByTimeAsync(2_999);
      expect(outbound.updateInteractiveCard).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(outbound.updateInteractiveCard).toHaveBeenCalledOnce();
      expect(JSON.stringify((outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]))
        .toContain("<font color='grey'>· 3.0s</font>");
    } finally {
      vi.useRealTimers();
    }
  });

  test("stops elapsed-time refreshes after a turn reaches a terminal state", async () => {
    vi.useFakeTimers();
    try {
      const { presenter, outbound } = createFixture();
      await presenter.onEvent({
        type: "turn_started",
        sessionId: "s1",
        turnId: "turn_1",
        startedAt: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(0);
      const completion = presenter.onEvent(completed());
      await vi.advanceTimersByTimeAsync(0);
      await completion;
      (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mockClear();

      await vi.advanceTimersByTimeAsync(6_000);
      expect(outbound.updateInteractiveCard).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("stops elapsed-time refreshes when a turn fails unexpectedly", async () => {
    vi.useFakeTimers();
    try {
      const { presenter, outbound, store } = createFixture();
      await presenter.onEvent({
        type: "turn_started",
        sessionId: "s1",
        turnId: "turn_1",
        startedAt: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_500);
      const failure = presenter.onEvent({
        type: "turn_failed",
        sessionId: "s1",
        turnId: "turn_1",
        message: "stream disconnected",
      });
      await vi.advanceTimersByTimeAsync(0);
      await failure;
      const terminal = (store.saveTurnSnapshot as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2];
      expect(terminal).toMatchObject({ status: "failed", durationMs: 1_500 });
      (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mockClear();

      await vi.advanceTimersByTimeAsync(6_000);
      expect(outbound.updateInteractiveCard).not.toHaveBeenCalled();
      expect((store.saveTurnSnapshot as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2])
        .toMatchObject({ durationMs: 1_500 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("freezes in-place history pages and resumes live updates on the latest page", async () => {
    const { presenter, outbound } = createFixture(false, new CardRenderer({ thinkingCardLayout: "timeline" }));
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });
    for (let index = 1; index <= 45; index += 1) {
      await presenter.onEvent({
        type: "progress",
        sessionId: "s1",
        turnId: "turn_1",
        activityId: `reasoning:${index}`,
        text: `Activity ${index}`,
      });
    }
    await presenter.flushAll();
    (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mockClear();

    await presenter.showActivityPage("chat_id:c1", "turn_1", 0, "progress_1");

    expect(outbound.updateInteractiveCard).toHaveBeenCalledOnce();
    let rendered = JSON.stringify((outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]);
    expect(rendered).toContain("思考活动历史 · 1/2");
    expect(rendered).toContain("Activity 1");
    expect(rendered).not.toContain("Activity 45");
    (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mockClear();

    await presenter.onEvent({
      type: "progress",
      sessionId: "s1",
      turnId: "turn_1",
      activityId: "reasoning:46",
      text: "Activity 46",
    });
    await presenter.flushAll();
    expect(outbound.updateInteractiveCard).not.toHaveBeenCalled();

    await presenter.showActivityPage("chat_id:c1", "turn_1", "latest", "progress_1");
    expect(outbound.updateInteractiveCard).toHaveBeenCalledOnce();
    rendered = JSON.stringify((outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]);
    expect(rendered).toContain("Activity 46");
    expect(rendered).toContain("正在处理");
    (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mockClear();

    await presenter.onEvent({
      type: "progress",
      sessionId: "s1",
      turnId: "turn_1",
      activityId: "reasoning:47",
      text: "Activity 47",
    });
    await presenter.flushAll();
    expect(JSON.stringify((outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1])).toContain(
      "Activity 47",
    );
  });

  test("delivers a terminal answer without replacing the history page until latest is selected", async () => {
    const { presenter, outbound } = createFixture();
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() - 1_000 });
    for (let index = 1; index <= 41; index += 1) {
      await presenter.onEvent({
        type: "progress",
        sessionId: "s1",
        turnId: "turn_1",
        activityId: `reasoning:${index}`,
        text: `Activity ${index}`,
      });
    }
    await presenter.flushAll();
    await presenter.showActivityPage("chat_id:c1", "turn_1", 0, "progress_1");
    (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mockClear();

    await presenter.onEvent(completed("terminal answer"));

    expect(outbound.updateInteractiveCard).not.toHaveBeenCalled();
    expect(outbound.sendMarkdown).toHaveBeenCalledWith(
      "chat_id:c1",
      "terminal answer",
      expect.stringMatching(/^codex-final-/),
    );

    await presenter.showActivityPage("chat_id:c1", "turn_1", "latest", "progress_1");
    expect(JSON.stringify((outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1])).toContain(
      "已完成",
    );
  });

  test("cleans up a failed starting card so a later prompt can retry", async () => {
    const { presenter, outbound } = createFixture();
    (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce("progress_2");
    await expect(presenter.startPendingTurn("s1", "chat_id:c1")).rejects.toThrow("network down");
    await expect(presenter.startPendingTurn("s1", "chat_id:c1")).resolves.toMatch(/^pending_/);
    expect(outbound.sendInteractiveCard).toHaveBeenCalledTimes(2);
  });

  test("closes the interrupted card and creates a distinct thinking card for recovery", async () => {
    const store = new MemoryStore();
    const outbound = outboundWithMarkdown(vi.fn(async () => "final"));
    (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("progress_old")
      .mockResolvedValueOnce("progress_recovered");
    const presenter = new FeishuTurnPresenter(outbound, store, undefined, { criticalGapMs: 0 });
    presenter.registerSession("s1", "chat_id:c1", "Task");

    await presenter.startPendingTurn("s1", "chat_id:c1", "Task", undefined, "original prompt");
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: 1 });
    await presenter.interruptTurnForRecovery("s1", "chat_id:c1", "turn_1", "continuing after restart");
    const recoveredPendingId = await presenter.startPendingTurn(
      "s1",
      "chat_id:c1",
      "Task",
      undefined,
      "restore original prompt",
    );

    expect(recoveredPendingId).toMatch(/^pending_/);
    expect(outbound.sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith(
      "progress_old",
      expect.any(Object),
    );
    expect(store.getTurnSnapshot("turn_1")).toMatchObject({
      status: "cancelled",
      progressText: "continuing after restart",
    });
  });

  test("delivers a rehydrated turn failure to its persisted group instead of the latest session context", async () => {
    const { presenter, outbound, store } = createFixture();
    const persisted = {
      sessionId: "s1",
      turnId: "turn_1",
      status: "running" as const,
      startedAt: Date.now() - 1_000,
      assistantText: "",
      plan: [],
      activities: [],
      totalToolCount: 0,
      completedToolCount: 0,
      failedToolCount: 0,
      toolStatuses: {},
      completedTools: [],
      failedTools: [],
      fileSummary: [],
    };
    store.getTurnSnapshot.mockReturnValue(persisted);
    store.getTurnContextKey.mockReturnValue("chat_id:origin_group");
    presenter.registerSession("s1", "chat_id:current_private");

    await presenter.onEvent({
      type: "turn_failed",
      sessionId: "s1",
      turnId: "turn_1",
      message: "stream disconnected before completion",
    });

    expect(outbound.sendInteractiveCard).toHaveBeenCalledWith(
      "chat_id:origin_group",
      expect.any(Object),
    );
    expect(store.saveTurnSnapshot).toHaveBeenLastCalledWith(
      "turn_1",
      "s1",
      expect.objectContaining({
        status: "failed",
        error: "stream disconnected before completion",
      }),
      "chat_id:origin_group",
    );
  });

  test("does not resend a final answer already recorded as delivered", async () => {
    const { presenter, outbound } = createFixture(true);
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() - 1_000 });
    await presenter.onEvent(completed("historical answer"));
    expect(outbound.sendMarkdown).not.toHaveBeenCalled();
  });

  test("does not recreate a missing progress card for an already-delivered historical turn", async () => {
    const { presenter, outbound } = createFixture(true);

    await presenter.onEvent({
      type: "turn_started",
      sessionId: "s1",
      turnId: "turn_1",
      startedAt: Date.now() - 1_000,
    });

    expect(outbound.sendInteractiveCard).not.toHaveBeenCalled();
    expect(outbound.updateInteractiveCard).not.toHaveBeenCalled();
  });

  test("details are rendered from the saved snapshot without runtime history", async () => {
    const { presenter, outbound, store } = createFixture();
    store.getTurnSnapshot.mockReturnValue({
      sessionId: "s1",
      turnId: "turn_1",
      status: "completed",
      startedAt: 1,
      assistantText: "",
      plan: [],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
    });
    await presenter.showDetails("chat_id:c1", "turn_1");
    expect(outbound.sendInteractiveCard).toHaveBeenCalledOnce();
  });

  test("sends the final answer but does not finalize reactions when the terminal card update fails permanently", async () => {
    const { presenter, outbound } = createFixture();
    (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("bad card"));
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() - 1_000 });
    await expect(presenter.onEvent(completed())).rejects.toThrow("bad card");
    expect(outbound.sendMarkdown).toHaveBeenCalledOnce();
    expect(outbound.deleteReaction).not.toHaveBeenCalled();
  });

  test("checkpoints final chunks and resumes only unsent chunks", async () => {
    const store = new MemoryStore();
    const firstOutbound = outboundWithMarkdown(
      vi.fn().mockResolvedValueOnce("part_1").mockRejectedValueOnce(new Error("permanent failure")),
    );
    const first = new FeishuTurnPresenter(firstOutbound, store, undefined, { finalChunkLength: 32, criticalGapMs: 0 });
    first.registerSession("s1", "chat_id:c1");
    await first.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });
    await expect(first.onEvent(completed("x".repeat(50)))).rejects.toThrow("permanent failure");
    expect(store.getTurnDelivery("turn_1")?.finalMessageIds).toEqual(["part_1"]);
    expect((firstOutbound.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toMatch(/^codex-final-/);

    const secondSend = vi.fn().mockResolvedValue("part_2");
    const second = new FeishuTurnPresenter(outboundWithMarkdown(secondSend), store, undefined, { finalChunkLength: 32 });
    second.registerSession("s1", "chat_id:c1");
    await second.resumeDelivery("s1", "chat_id:c1", "turn_1");

    expect(secondSend).toHaveBeenCalledTimes(2);
    expect(store.getTurnDelivery("turn_1")).toMatchObject({
      finalDelivered: true,
      finalMessageIds: ["part_1", "part_2", "part_2"],
    });
  });

  test("splits table-heavy final answers at the Feishu card table limit", async () => {
    const { presenter, outbound, store } = createFixture();
    const answer = Array.from({ length: 9 }, (_, index) => [
      `### Table ${index + 1}\n`,
      "| Name | Value |\n",
      "| --- | --- |\n",
      `| item | ${index + 1} |\n`,
      "\n",
    ].join("")).join("");

    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });
    await presenter.onEvent(completed(answer));

    expect(outbound.sendMarkdown).toHaveBeenCalledTimes(2);
    const chunks = (outbound.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[1] as string);
    expect(chunks[0]?.match(/^\| Name \| Value \|$/gmu)).toHaveLength(5);
    expect(chunks[1]?.match(/^\| Name \| Value \|$/gmu)).toHaveLength(4);
    expect(chunks[0]).not.toContain("Powered by [AgentBot]");
    expect(chunks[1]).toMatch(
      /----\n\n> Powered by \[AgentBot\]\(https:\/\/keyou\.github\.io\/agent-bot\/\)$/u,
    );
    expect(store.saveFinalDeliveryProgress).toHaveBeenCalledTimes(2);
    expect(store.markFinalDelivered).toHaveBeenCalledWith("turn_1", ["final_1", "final_1"]);
  });
});

class MemoryStore implements TurnPresentationStore {
  private readonly snapshots = new Map<string, unknown>();
  private readonly contexts = new Map<string, string>();
  private readonly deliveries = new Map<
    string,
    { progressMessageId?: string; finalDelivered: boolean; finalMessageIds: string[] }
  >();
  saveTurnSnapshot(turnId: string, _sessionId: string, snapshot: unknown, contextKey?: string): void {
    this.snapshots.set(turnId, snapshot);
    if (contextKey) this.contexts.set(turnId, contextKey);
  }
  getTurnSnapshot(turnId: string): unknown { return this.snapshots.get(turnId); }
  getTurnContextKey(turnId: string): string | undefined { return this.contexts.get(turnId); }
  promotePendingTurn(
    pendingTurnId: string,
    turnId: string,
    localSessionId: string,
    snapshot: unknown,
    contextKey?: string,
  ): void {
    this.saveTurnSnapshot(turnId, localSessionId, snapshot, contextKey);
    const delivery = this.deliveries.get(pendingTurnId);
    if (delivery) this.deliveries.set(turnId, delivery);
    this.snapshots.delete(pendingTurnId);
    this.contexts.delete(pendingTurnId);
    this.deliveries.delete(pendingTurnId);
  }
  saveTurnDelivery(turnId: string, patch: { progressMessageId?: string }): void {
    const existing = this.deliveries.get(turnId);
    this.deliveries.set(turnId, {
      progressMessageId: patch.progressMessageId ?? existing?.progressMessageId,
      finalDelivered: existing?.finalDelivered ?? false,
      finalMessageIds: existing?.finalMessageIds ?? [],
    });
  }
  saveFinalDeliveryProgress(turnId: string, messageIds: string[]): void {
    this.deliveries.set(turnId, { finalDelivered: false, finalMessageIds: [...messageIds] });
  }
  markFinalDelivered(turnId: string, messageIds: string[]): void {
    this.deliveries.set(turnId, { finalDelivered: true, finalMessageIds: [...messageIds] });
  }
  getTurnDelivery(turnId: string) { return this.deliveries.get(turnId); }
}

function outboundWithMarkdown(sendMarkdown: FeishuOutbound["sendMarkdown"]): FeishuOutbound {
  return {
    sendText: vi.fn(async () => "text"),
    sendMarkdown,
    sendInteractiveCard: vi.fn(async () => "progress"),
    updateInteractiveCard: vi.fn(async () => undefined),
  };
}
