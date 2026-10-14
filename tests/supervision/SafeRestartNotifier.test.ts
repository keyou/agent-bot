import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CardRenderer } from "../../src/feishu/CardRenderer.js";
import type { FeishuOutbound } from "../../src/feishu/types.js";
import { StateStore } from "../../src/state/StateStore.js";
import { SafeRestartNotifier } from "../../src/supervision/SafeRestartNotifier.js";
import type { ActiveTerminal } from "../../src/terminal/TerminalServer.js";
import type { SafeRestartStatus } from "../../src/supervision/SafeRestartScheduler.js";

const directories: string[] = [];
const stores: StateStore[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("SafeRestartNotifier", () => {
  test.each([false, true])("replaces a failed topic card and ignores an old in-flight update after rescheduling (failure=%s)", async (fail) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-restart-terminal-race-")); directories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite")); stores.push(store);
    const reply = vi.fn(async () => "first");
    const update = vi.fn(async () => {});
    const stop = vi.fn(async () => true);
    const notifier = new SafeRestartNotifier(store, {
      sendText: vi.fn(), sendMarkdown: vi.fn(), sendInteractiveCard: vi.fn(), replyInteractiveCard: reply, updateInteractiveCard: update,
    }, new CardRenderer(), { warn: vi.fn() }, { initialCardDelayMs: 0, ownerId: () => "owner", isCurrentSchedule: () => true, stopTerminal: stop });
    const contextKey = "chat_id:g:thread_id:t";
    const terminal: ActiveTerminal = { terminalId: "a".repeat(32), token: "Abcd1234", cwd: "/tmp", state: "running", connected: true,
      active: true, foreground: true, command: { status: "idle" } };
    const status: SafeRestartStatus = { scheduleId: 1, reason: "test", phase: "waiting_tasks",
      notificationTargets: [{ contextKey, replyMessageId: "anchor" }],
      activity: { runningSessions: 0, pendingFinalDeliveries: 0, activeTerminals: 1, terminalBlockers: [terminal] } };
    const action = { actionId: "stop", contextKey, messageId: "first", userId: "owner",
      value: { scheduleId: "1", terminalId: terminal.terminalId } };
    await notifier.update(status);
    expect(reply).toHaveBeenCalledWith(contextKey, { messageId: "anchor", replyInThread: true }, expect.any(Object));
    update.mockRejectedValueOnce(new Error("card unavailable")); reply.mockResolvedValueOnce("replacement");
    const changed = { ...status, activity: { ...status.activity, terminalBlockers: [{ ...terminal, active: false }] } };
    await notifier.update(changed);
    await expect(notifier.stopTerminal(action)).rejects.toThrow("失效");
    await notifier.stopTerminal({ ...action, messageId: "replacement" }); expect(stop).toHaveBeenCalledOnce();
    let finish!: () => void;
    update.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = () => fail ? reject(new Error("stale failure")) : resolve(); }));
    const pending = notifier.update(status);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    reply.mockResolvedValueOnce("next");
    const next = notifier.update({ ...status, scheduleId: 2 });
    finish(); await pending; await next;
    await expect(notifier.stopTerminal({ ...action, messageId: "replacement" })).rejects.toThrow("失效");
    await notifier.stopTerminal({ ...action, messageId: "next", value: { ...action.value, scheduleId: "2" } });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenCalledTimes(3);
  });

  test("only the owner can close a listed terminal from the current original card; changing commands updates in place", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-restart-terminals-")); directories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite")); stores.push(store);
    const send = vi.fn(async (_context: string, _card: Record<string, unknown>) => "card");
    const update = vi.fn(async (_id: string, _card: Record<string, unknown>) => undefined);
    const stop = vi.fn(async (_id: string, _owner: string) => true);
    let current = true;
    const notifier = new SafeRestartNotifier(store, { sendText: vi.fn(), sendMarkdown: vi.fn(), sendInteractiveCard: send, updateInteractiveCard: update },
      new CardRenderer(), { warn: vi.fn() }, { initialCardDelayMs: 0, ownerId: () => "ou_owner", isCurrentSchedule: () => current, stopTerminal: stop });
    const terminal: ActiveTerminal = { terminalId: "a".repeat(32), token: "Ab_-1234", cwd: "/tmp", state: "running", connected: true,
      active: true, foreground: false, command: { status: "running", command: "sleep 60", source: "shell" } };
    const status: SafeRestartStatus = { scheduleId: 1, reason: "test", phase: "waiting_tasks", notificationTargets: [{ contextKey: "chat_id:requester" }],
      activity: { runningSessions: 0, pendingFinalDeliveries: 0, activeTerminals: 1, terminalBlockers: [terminal] } };
    const action = { actionId: "close", contextKey: "chat_id:requester", userId: "ou_owner", messageId: "card",
      value: { action: "safe_restart_terminal_stop", scheduleId: "1", terminalId: terminal.terminalId } };
    await notifier.update(status);
    for (const invalid of [
      { ...action, userId: "other" }, { ...action, userId: undefined }, { ...action, messageId: "forwarded" },
      { ...action, contextKey: "chat_id:other" }, { ...action, value: { ...action.value, scheduleId: "2" } },
      { ...action, value: { ...action.value, scheduleId: "-1" } },
      { ...action, value: { ...action.value, terminalId: "b".repeat(32) } },
      { ...action, value: { ...action.value, terminalId: terminal.token } },
    ]) await expect(notifier.stopTerminal(invalid)).rejects.toThrow();
    expect(stop).not.toHaveBeenCalled();
    expect(await notifier.stopTerminal(action)).toContain("已请求结束");
    expect(stop).toHaveBeenCalledExactlyOnceWith(terminal.terminalId, "ou_owner");
    stop.mockResolvedValueOnce(false); expect(await notifier.stopTerminal(action)).toContain("无需重复");
    await notifier.update(status); expect(update).not.toHaveBeenCalled();
    const changed: SafeRestartStatus = { ...status, activity: { ...status.activity, terminalBlockers: [{ ...terminal, command: { status: "idle" }, active: false }] } };
    await notifier.update(changed); expect(update).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce();
    expect(JSON.stringify(update.mock.lastCall)).toContain("Shell 空闲");
    current = false; await expect(notifier.stopTerminal(action)).rejects.toThrow("失效"); current = true;
    await notifier.update({ ...status, activity: { ...status.activity, activeTerminals: 0, terminalBlockers: [] } });
    await expect(notifier.stopTerminal(action)).rejects.toThrow("失效");
    await notifier.update({ ...status, scheduleId: 2 }); await expect(notifier.stopTerminal(action)).rejects.toThrow("失效");
    const next = { ...action, value: { ...action.value, scheduleId: "2" } };
    await notifier.update({ ...status, scheduleId: 2, phase: "cancelled" });
    await expect(notifier.stopTerminal(next)).rejects.toThrow("失效");
    expect(stop).toHaveBeenCalledTimes(2);
  });

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
      activity: { runningSessions: 1, pendingFinalDeliveries: 0, activeTerminals: 2 },
    });

    expect(sendInteractiveCard).toHaveBeenCalledOnce();
    expect(sendInteractiveCard).toHaveBeenCalledWith("chat_id:requester", expect.any(Object));
    expect(JSON.stringify(sendInteractiveCard.mock.calls)).toContain("活动终端");
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
