import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CardRenderer } from "../../src/feishu/CardRenderer.js";
import type { FeishuOutbound } from "../../src/feishu/types.js";
import { StateStore } from "../../src/state/StateStore.js";
import { SafeRestartNotifier } from "../../src/supervision/SafeRestartNotifier.js";

const directories: string[] = [];
const stores: StateStore[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("SafeRestartNotifier", () => {
  test("does not infer recipients when a restart has no requesting conversation", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-restart-no-target-"));
    directories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.recordChatContext("chat_id:private", "p2p");
    store.recordChatContext("chat_id:group", "group");
    store.markChatActive("chat_id:private");
    store.markChatActive("chat_id:group");
    const sendInteractiveCard = vi.fn(async () => "om_restart");
    const notifier = new SafeRestartNotifier(
      store,
      {
        sendText: vi.fn(async () => "text"),
        sendMarkdown: vi.fn(async () => "markdown"),
        sendInteractiveCard,
        updateInteractiveCard: vi.fn(async () => undefined),
      },
      new CardRenderer(),
      { warn: vi.fn() },
      { initialCardDelayMs: 0 },
    );

    await notifier.update({
      scheduleId: 1,
      reason: "internal restart",
      phase: "waiting_tasks",
      activity: { runningSessions: 1, pendingFinalDeliveries: 0 },
    });

    expect(sendInteractiveCard).not.toHaveBeenCalled();
    expect(notifier.getNotificationTargets()).toEqual([]);
  });

  test("notifies only requesting conversations and does not enroll recently active chats", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T12:00:00.000Z"));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-restart-active-"));
    directories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.recordChatContext("chat_id:active-private", "p2p");
    store.recordChatContext("chat_id:active-group", "group");
    store.recordChatContext("chat_id:stale-group", "group");
    store.markChatActive("chat_id:active-private", new Date("2026-08-03T11:59:30.000Z"));
    store.markChatActive("chat_id:active-group", new Date("2026-08-03T11:59:30.000Z"));
    store.markChatActive("chat_id:stale-group", new Date("2026-08-03T11:58:59.999Z"));
    const sendInteractiveCard = vi.fn(async (contextKey: string) => `om_${contextKey}`);
    const updateInteractiveCard = vi.fn(async () => undefined);
    const notifier = new SafeRestartNotifier(
      store,
      {
        sendText: vi.fn(async () => "text"),
        sendMarkdown: vi.fn(async () => "markdown"),
        sendInteractiveCard,
        updateInteractiveCard,
      },
      new CardRenderer(),
      { warn: vi.fn() },
      { initialCardDelayMs: 0 },
    );

    await notifier.update({
      scheduleId: 1,
      reason: "active conversations",
      notificationTargets: [{ contextKey: "chat_id:requester" }],
      phase: "waiting_tasks",
      activity: { runningSessions: 1, pendingFinalDeliveries: 0 },
    });

    expect(sendInteractiveCard).toHaveBeenCalledOnce();
    expect(sendInteractiveCard).toHaveBeenCalledWith("chat_id:requester", expect.any(Object));
    expect(sendInteractiveCard).not.toHaveBeenCalledWith("chat_id:active-group", expect.any(Object));
    expect(sendInteractiveCard).not.toHaveBeenCalledWith("chat_id:active-private", expect.any(Object));
    expect(sendInteractiveCard).not.toHaveBeenCalledWith("chat_id:stale-group", expect.any(Object));

    await vi.advanceTimersByTimeAsync(61_000);
    store.recordChatContext("chat_id:late-active-group", "group");
    store.markChatActive("chat_id:late-active-group");
    await notifier.update({
      scheduleId: 1,
      reason: "active conversations",
      notificationTargets: [{ contextKey: "chat_id:requester" }],
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 5_000,
    });

    expect(updateInteractiveCard).toHaveBeenCalledOnce();
    expect(sendInteractiveCard).not.toHaveBeenCalledWith("chat_id:late-active-group", expect.any(Object));
    expect(notifier.getNotificationTargets()).toEqual([{ contextKey: "chat_id:requester" }]);
  });

  test("routes safe-restart cards to every requesting conversation", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-restart-target-"));
    directories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.recordChatContext("chat_id:private", "p2p");
    store.recordChatContext("chat_id:group", "group");
    const sendInteractiveCard = vi.fn(async () => "om_group_restart");
    const replyInteractiveCard = vi.fn(async () => "om_thread_restart");
    const updateInteractiveCard = vi.fn(async () => undefined);
    const outbound: FeishuOutbound = {
      sendText: vi.fn(async () => "text"),
      sendMarkdown: vi.fn(async () => "markdown"),
      sendInteractiveCard,
      replyInteractiveCard,
      updateInteractiveCard,
    };
    const notifier = new SafeRestartNotifier(
      store,
      outbound,
      new CardRenderer(),
      { warn: vi.fn() },
      { initialCardDelayMs: 0 },
    );

    await notifier.update({
      scheduleId: 1,
      reason: "thread restart",
      notificationTargets: [
        {
          contextKey: "chat_id:group:thread_id:topic",
          replyMessageId: "om_request",
        },
        { contextKey: "chat_id:second-group" },
        { contextKey: "chat_id:missing-anchor:thread_id:topic" },
      ],
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 15_000,
    });

    expect(sendInteractiveCard).toHaveBeenCalledOnce();
    expect(sendInteractiveCard).toHaveBeenCalledWith("chat_id:second-group", expect.any(Object));
    expect(sendInteractiveCard).not.toHaveBeenCalledWith("chat_id:private", expect.any(Object));
    expect(replyInteractiveCard).toHaveBeenCalledOnce();
    expect(replyInteractiveCard).toHaveBeenCalledWith(
      "chat_id:group:thread_id:topic",
      { messageId: "om_request", replyInThread: true },
      expect.any(Object),
    );

    await notifier.update({
      scheduleId: 1,
      reason: "thread restart",
      notificationTargets: [
        {
          contextKey: "chat_id:group:thread_id:topic",
          replyMessageId: "om_request",
        },
        { contextKey: "chat_id:second-group" },
        { contextKey: "chat_id:missing-anchor:thread_id:topic" },
      ],
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 14_000,
    });

    expect(updateInteractiveCard).toHaveBeenCalledTimes(2);
    expect(updateInteractiveCard).toHaveBeenCalledWith("om_thread_restart", expect.any(Object));
    expect(updateInteractiveCard).toHaveBeenCalledWith("om_group_restart", expect.any(Object));
  });

  test("keeps restart reasons scoped to the conversation that requested them", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-restart-reasons-"));
    directories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    const sendInteractiveCard = vi.fn(async (
      contextKey: string,
      _card: Record<string, unknown>,
    ) => `om_${contextKey}`);
    const updateInteractiveCard = vi.fn(async (
      _messageId: string,
      _card: Record<string, unknown>,
    ) => undefined);
    const notifier = new SafeRestartNotifier(
      store,
      {
        sendText: vi.fn(async () => "text"),
        sendMarkdown: vi.fn(async () => "markdown"),
        sendInteractiveCard,
        updateInteractiveCard,
      },
      new CardRenderer(),
      { warn: vi.fn() },
      { initialCardDelayMs: 0 },
    );

    await notifier.update({
      scheduleId: 1,
      reason: "first reason",
      notificationTargets: [{ contextKey: "chat_id:first", reason: "first reason" }],
      phase: "waiting_tasks",
      activity: { runningSessions: 1, pendingFinalDeliveries: 0 },
    });
    await notifier.update({
      scheduleId: 1,
      reason: "second reason",
      notificationTargets: [
        { contextKey: "chat_id:first", reason: "first reason" },
        { contextKey: "chat_id:second", reason: "second reason" },
      ],
      phase: "waiting_tasks",
      activity: { runningSessions: 1, pendingFinalDeliveries: 0 },
    });

    expect(sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(sendInteractiveCard.mock.calls[0]?.[1])).toContain("first reason");
    expect(JSON.stringify(sendInteractiveCard.mock.calls[1]?.[1])).toContain("second reason");
    expect(updateInteractiveCard).not.toHaveBeenCalled();

    await notifier.update({
      scheduleId: 1,
      reason: "updated first reason",
      notificationTargets: [
        { contextKey: "chat_id:first", reason: "updated first reason" },
        { contextKey: "chat_id:second", reason: "second reason" },
      ],
      phase: "waiting_tasks",
      activity: { runningSessions: 1, pendingFinalDeliveries: 0 },
    });

    expect(updateInteractiveCard).toHaveBeenCalledOnce();
    expect(updateInteractiveCard).toHaveBeenCalledWith(
      "om_chat_id:first",
      expect.any(Object),
    );
    expect(JSON.stringify(updateInteractiveCard.mock.calls[0]?.[1])).toContain("updated first reason");
  });

  test("sends and updates one card only for an explicit requesting chat", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-restart-notifier-"));
    directories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.recordChatContext("chat_id:private", "p2p");
    store.recordChatContext("chat_id:group", "group");
    store.createSession({
      localSessionId: "session_1",
      contextKey: "chat_id:group",
      agentName: "codex",
      cwd: process.cwd(),
      status: "running",
    });
    store.updateRuntimeSession("session_1", { remoteSessionId: "thread_1", title: "Running build" });
    const sendInteractiveCard = vi.fn(async (_contextKey: string, _card: Record<string, unknown>) => "om_restart");
    const updateInteractiveCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => undefined);
    const outbound: FeishuOutbound = {
      sendText: vi.fn(async () => "text"),
      sendMarkdown: vi.fn(async () => "markdown"),
      sendInteractiveCard,
      updateInteractiveCard,
    };
    const notifier = new SafeRestartNotifier(
      store,
      outbound,
      new CardRenderer(),
      { warn: vi.fn() },
      { initialCardDelayMs: 0 },
    );

    notifier.update({
      scheduleId: 1,
      reason: "new build",
      notificationTargets: [{ contextKey: "chat_id:private" }],
      phase: "waiting_tasks",
      activity: { runningSessions: 1, pendingFinalDeliveries: 0 },
    });
    await notifier.flush();

    expect(sendInteractiveCard).toHaveBeenCalledOnce();
    expect(sendInteractiveCard).toHaveBeenCalledWith("chat_id:private", expect.any(Object));
    expect(JSON.stringify(sendInteractiveCard.mock.calls[0]?.[1])).toContain("Running build");
    expect(JSON.stringify(sendInteractiveCard.mock.calls[0]?.[1])).toContain("thread_1");
    expect(JSON.stringify(sendInteractiveCard.mock.calls[0]?.[1])).toContain(
      '"action":"session_stop","sessionId":"session_1","cardView":"safe_restart"',
    );

    store.updateSession("session_1", { status: "ready" });
    notifier.update({
      scheduleId: 1,
      reason: "new build",
      notificationTargets: [{ contextKey: "chat_id:private" }],
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 9_500,
    });
    await notifier.flush();

    expect(sendInteractiveCard).toHaveBeenCalledOnce();
    expect(updateInteractiveCard).toHaveBeenCalledWith("om_restart", expect.any(Object));
    expect(JSON.stringify(updateInteractiveCard.mock.calls.at(-1)?.[1])).toContain("10s");
    expect(JSON.stringify(updateInteractiveCard.mock.calls.at(-1)?.[1])).not.toContain('"action":"session_stop"');

    await notifier.update({
      scheduleId: 1,
      reason: "new build",
      notificationTargets: [{ contextKey: "chat_id:private" }],
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 9_100,
    });
    expect(updateInteractiveCard).toHaveBeenCalledOnce();

    await notifier.update({
      scheduleId: 1,
      reason: "new build",
      notificationTargets: [{ contextKey: "chat_id:private" }],
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 8_900,
    });
    expect(updateInteractiveCard).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(updateInteractiveCard.mock.calls.at(-1)?.[1])).toContain("9s");
  });

  test("stops the previous card before sending a new card for a repeated request", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-restart-repeated-"));
    directories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    const sendInteractiveCard = vi.fn(async (
      _contextKey: string,
      _card: Record<string, unknown>,
    ) => (
      sendInteractiveCard.mock.calls.length === 1 ? "om_first" : "om_second"
    ));
    const updateInteractiveCard = vi.fn(async (
      _messageId: string,
      _card: Record<string, unknown>,
    ) => undefined);
    const notifier = new SafeRestartNotifier(
      store,
      {
        sendText: vi.fn(async () => "text"),
        sendMarkdown: vi.fn(async () => "markdown"),
        sendInteractiveCard,
        updateInteractiveCard,
      },
      new CardRenderer(),
      { warn: vi.fn() },
      { initialCardDelayMs: 0 },
    );

    await notifier.update({
      scheduleId: 1,
      reason: "first request",
      notificationTargets: [{ contextKey: "chat_id:private", reason: "first request" }],
      phase: "waiting_tasks",
      activity: { runningSessions: 1, pendingFinalDeliveries: 0 },
    });
    await notifier.update({
      scheduleId: 2,
      reason: "second request",
      notificationTargets: [{ contextKey: "chat_id:private", reason: "second request" }],
      phase: "waiting_tasks",
      activity: { runningSessions: 1, pendingFinalDeliveries: 0 },
    });

    expect(sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect(updateInteractiveCard).toHaveBeenCalledOnce();
    expect(updateInteractiveCard).toHaveBeenCalledWith("om_first", expect.any(Object));
    const stopped = JSON.stringify(updateInteractiveCard.mock.calls[0]?.[1]);
    const active = JSON.stringify(sendInteractiveCard.mock.calls[1]?.[1]);
    expect(stopped).toContain("已停止");
    expect(stopped).not.toContain(">Cancel</font>");
    expect(active).toContain("second request");
    expect(active).toContain('"scheduleId":"2"');
    expect(updateInteractiveCard.mock.invocationCallOrder[0])
      .toBeLessThan(sendInteractiveCard.mock.invocationCallOrder[1]!);
  });

  test("serializes changed countdown cards instead of coalescing intermediate updates", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-restart-countdown-"));
    directories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.recordChatContext("chat_id:private", "p2p");

    let releaseFirstUpdate: (() => void) | undefined;
    const updateInteractiveCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => {
      if (updateInteractiveCard.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstUpdate = resolve;
        });
      }
    });
    const outbound: FeishuOutbound = {
      sendText: vi.fn(async () => "text"),
      sendMarkdown: vi.fn(async () => "markdown"),
      sendInteractiveCard: vi.fn(async () => "om_restart"),
      updateInteractiveCard,
    };
    const notifier = new SafeRestartNotifier(
      store,
      outbound,
      new CardRenderer(),
      { warn: vi.fn() },
      { initialCardDelayMs: 0 },
    );

    await notifier.update({
      scheduleId: 1,
      reason: "countdown",
      notificationTargets: [{ contextKey: "chat_id:private" }],
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 15_000,
    });
    const first = notifier.update({
      scheduleId: 1,
      reason: "countdown",
      notificationTargets: [{ contextKey: "chat_id:private" }],
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 14_000,
    });
    await vi.waitFor(() => expect(updateInteractiveCard).toHaveBeenCalledOnce());
    const second = notifier.update({
      scheduleId: 1,
      reason: "countdown",
      notificationTargets: [{ contextKey: "chat_id:private" }],
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 13_000,
    });

    expect(updateInteractiveCard).toHaveBeenCalledOnce();
    releaseFirstUpdate?.();
    await Promise.all([first, second]);

    expect(updateInteractiveCard).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(updateInteractiveCard.mock.calls[0]?.[1])).toContain("14s");
    expect(JSON.stringify(updateInteractiveCard.mock.calls[1]?.[1])).toContain("13s");
  });

  test("delays the initial card and publishes the latest status received during the delay", async () => {
    vi.useFakeTimers();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-restart-delay-"));
    directories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.recordChatContext("chat_id:private", "p2p");
    const sendInteractiveCard = vi.fn(async (
      _contextKey: string,
      _card: Record<string, unknown>,
    ) => "om_restart");
    const outbound: FeishuOutbound = {
      sendText: vi.fn(async () => "text"),
      sendMarkdown: vi.fn(async () => "markdown"),
      sendInteractiveCard,
      updateInteractiveCard: vi.fn(async () => undefined),
    };
    const notifier = new SafeRestartNotifier(
      store,
      outbound,
      new CardRenderer(),
      { warn: vi.fn() },
      { initialCardDelayMs: 3_000 },
    );

    await notifier.update({
      scheduleId: 1,
      reason: "new build",
      notificationTargets: [{ contextKey: "chat_id:private" }],
      phase: "waiting_tasks",
      activity: { runningSessions: 1, pendingFinalDeliveries: 0 },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await notifier.update({
      scheduleId: 1,
      reason: "new build",
      notificationTargets: [{ contextKey: "chat_id:private" }],
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 12_000,
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sendInteractiveCard).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await notifier.flush();

    expect(sendInteractiveCard).toHaveBeenCalledOnce();
    expect(JSON.stringify(sendInteractiveCard.mock.calls[0]?.[1])).toContain("12s");
  });

  test("flushes a delayed initial card immediately before restart", async () => {
    vi.useFakeTimers();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-restart-delay-flush-"));
    directories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.recordChatContext("chat_id:private", "p2p");
    const sendInteractiveCard = vi.fn(async (
      _contextKey: string,
      _card: Record<string, unknown>,
    ) => "om_restart");
    const outbound: FeishuOutbound = {
      sendText: vi.fn(async () => "text"),
      sendMarkdown: vi.fn(async () => "markdown"),
      sendInteractiveCard,
      updateInteractiveCard: vi.fn(async () => undefined),
    };
    const notifier = new SafeRestartNotifier(
      store,
      outbound,
      new CardRenderer(),
      { warn: vi.fn() },
      { initialCardDelayMs: 3_000 },
    );

    await notifier.update({
      scheduleId: 1,
      reason: "new build",
      notificationTargets: [{ contextKey: "chat_id:private" }],
      phase: "restarting",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 0,
    });
    await notifier.flush();

    expect(sendInteractiveCard).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sendInteractiveCard).toHaveBeenCalledOnce();
  });

  test("updates the existing card after cancellation and ignores late status updates", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-restart-cancel-"));
    directories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.recordChatContext("chat_id:private", "p2p");
    const updateInteractiveCard = vi.fn(async (
      _messageId: string,
      _card: Record<string, unknown>,
    ) => undefined);
    const outbound: FeishuOutbound = {
      sendText: vi.fn(async () => "text"),
      sendMarkdown: vi.fn(async () => "markdown"),
      sendInteractiveCard: vi.fn(async () => "om_restart"),
      updateInteractiveCard,
    };
    const notifier = new SafeRestartNotifier(
      store,
      outbound,
      new CardRenderer(),
      { warn: vi.fn() },
      { initialCardDelayMs: 0 },
    );

    await notifier.update({
      scheduleId: 1,
      reason: "cancel this",
      notificationTargets: [{ contextKey: "chat_id:private" }],
      phase: "waiting_tasks",
      activity: { runningSessions: 1, pendingFinalDeliveries: 0 },
    });
    await notifier.update({
      scheduleId: 1,
      reason: "cancel this",
      notificationTargets: [{ contextKey: "chat_id:private" }],
      phase: "cancelled",
      activity: { runningSessions: 1, pendingFinalDeliveries: 0 },
    });

    expect(updateInteractiveCard).toHaveBeenCalledOnce();
    const cancelledCard = updateInteractiveCard.mock.calls[0]?.[1];
    expect(JSON.stringify(cancelledCard)).toContain("已取消");
    expect(JSON.stringify(cancelledCard)).not.toContain(">Cancel</font>");

    await notifier.update({
      scheduleId: 1,
      reason: "cancel this",
      notificationTargets: [{ contextKey: "chat_id:private" }],
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 5_000,
    });
    expect(updateInteractiveCard).toHaveBeenCalledOnce();
  });
});
