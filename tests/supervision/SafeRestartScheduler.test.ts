import { afterEach, describe, expect, test, vi } from "vitest";
import { SafeRestartScheduler, type ServerActivityState } from "../../src/supervision/SafeRestartScheduler.js";

afterEach(() => vi.useRealTimers());

describe("SafeRestartScheduler", () => {
  test("uses a five-second quiet period by default", async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const onStatus = vi.fn();
    const scheduler = new SafeRestartScheduler({
      readActivity: () => ({ runningSessions: 0, pendingFinalDeliveries: 0 }),
      onReady,
      onStatus,
    });

    scheduler.schedule("default countdown");
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "countdown",
      remainingMs: 5_000,
    }));

    await vi.advanceTimersByTimeAsync(4_999);
    expect(onReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onReady).toHaveBeenCalledWith("default countdown", []);
  });

  test("waits for all tasks and final deliveries plus a quiet inbound window", async () => {
    vi.useFakeTimers();
    let state: ServerActivityState = { runningSessions: 1, pendingFinalDeliveries: 0, latestInboundAt: "a" };
    const onReady = vi.fn();
    const scheduler = new SafeRestartScheduler({
      readActivity: () => state,
      onReady,
      quietPeriodMs: 1_000,
      pollIntervalMs: 100,
    });

    expect(scheduler.schedule("code updated")).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onReady).not.toHaveBeenCalled();

    state = { runningSessions: 0, pendingFinalDeliveries: 1, latestInboundAt: "a" };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onReady).not.toHaveBeenCalled();

    state = { runningSessions: 0, pendingFinalDeliveries: 0, latestInboundAt: "a" };
    await vi.advanceTimersByTimeAsync(900);
    state = { ...state, latestInboundAt: "b" };
    await vi.advanceTimersByTimeAsync(900);
    expect(onReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);

    expect(onReady).toHaveBeenCalledWith("code updated", []);
    expect(scheduler.scheduled).toBe(false);
  });

  test("publishes the restart card state before immediately restarting an idle update", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const onStatus = vi.fn(async () => { events.push("status"); });
    const onReady = vi.fn(async () => { events.push("ready"); });
    const scheduler = new SafeRestartScheduler({
      readActivity: () => ({ runningSessions: 0, pendingFinalDeliveries: 0 }),
      onReady,
      onStatus,
      quietPeriodMs: 15_000,
      pollIntervalMs: 1_000,
    });
    const target = { contextKey: "user_open_id:ou_owner" };

    scheduler.schedule("install update", target, { restartImmediatelyIfIdle: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(onStatus).toHaveBeenCalledWith({
      scheduleId: 1,
      reason: "install update",
      notificationTargets: [{ ...target, reason: "install update" }],
      phase: "restarting",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 0,
    });
    expect(onReady).toHaveBeenCalledWith("install update", [{ ...target, reason: "install update" }]);
    expect(events).toEqual(["status", "ready"]);
    expect(scheduler.scheduled).toBe(false);
  });

  test("keeps the latest global reason and each requesting conversation's own reason", async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const scheduler = new SafeRestartScheduler({
      readActivity: () => ({ runningSessions: 0, pendingFinalDeliveries: 0 }),
      onReady,
      quietPeriodMs: 1_000,
      pollIntervalMs: 100,
    });
    expect(scheduler.schedule("first", {
      contextKey: "chat_id:first:thread_id:topic",
      replyMessageId: "om_old_anchor",
    })).toBe(true);
    await vi.advanceTimersByTimeAsync(900);
    expect(scheduler.schedule("second", {
      contextKey: "chat_id:second",
      replyMessageId: "om_second",
    })).toBe(false);
    expect(scheduler.schedule("third", {
      contextKey: "chat_id:first:thread_id:topic",
      replyMessageId: "om_newer_anchor",
    })).toBe(false);
    expect(scheduler.pendingReason).toBe("third");

    await vi.advanceTimersByTimeAsync(900);
    expect(onReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);

    expect(onReady).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledWith("third", [
      {
        contextKey: "chat_id:first:thread_id:topic",
        replyMessageId: "om_newer_anchor",
        reason: "third",
      },
      {
        contextKey: "chat_id:second",
        replyMessageId: "om_second",
        reason: "second",
      },
    ]);
    expect(scheduler.scheduled).toBe(false);
  });

  test("publishes blockers and resets the countdown after new inbound activity", async () => {
    vi.useFakeTimers();
    let state: ServerActivityState = { runningSessions: 1, pendingFinalDeliveries: 0, latestInboundAt: "a" };
    const onStatus = vi.fn();
    const scheduler = new SafeRestartScheduler({
      readActivity: () => state,
      onReady: vi.fn(),
      onStatus,
      quietPeriodMs: 1_000,
      pollIntervalMs: 100,
    });

    scheduler.schedule("card update");
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      scheduleId: 1,
      phase: "waiting_tasks",
      reason: "card update",
    }));

    state = { runningSessions: 0, pendingFinalDeliveries: 0, latestInboundAt: "a" };
    await vi.advanceTimersByTimeAsync(500);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "countdown",
      remainingMs: expect.any(Number),
    }));

    state = { ...state, latestInboundAt: "b" };
    await vi.advanceTimersByTimeAsync(100);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "countdown",
      remainingMs: 1_000,
    }));
  });

  test("assigns a new schedule id to each explicit safe restart request", async () => {
    vi.useFakeTimers();
    const onStatus = vi.fn();
    const scheduler = new SafeRestartScheduler({
      readActivity: () => ({ runningSessions: 1, pendingFinalDeliveries: 0 }),
      onReady: vi.fn(),
      onStatus,
      quietPeriodMs: 1_000,
      pollIntervalMs: 100,
    });

    expect(scheduler.schedule("first")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ scheduleId: 1 }));

    expect(scheduler.schedule("second")).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      scheduleId: 2,
      reason: "second",
    }));
    expect(await scheduler.cancelScheduled(1)).toBe(false);
    expect(await scheduler.cancelScheduled(2)).toBe(true);
  });

  test("waits for each status delivery before publishing another countdown state", async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    const onStatus = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const scheduler = new SafeRestartScheduler({
      readActivity: () => ({ runningSessions: 0, pendingFinalDeliveries: 0 }),
      onReady: vi.fn(),
      onStatus,
      quietPeriodMs: 10_000,
      pollIntervalMs: 100,
    });

    scheduler.schedule("visible countdown");
    await vi.advanceTimersByTimeAsync(500);
    expect(onStatus).toHaveBeenCalledOnce();

    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenCalledTimes(2);

    scheduler.cancel();
    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
  });

  test.each([
    { runningSessions: 2, pendingFinalDeliveries: 1 },
    { runningSessions: 0, pendingFinalDeliveries: 1 },
    { runningSessions: 0, pendingFinalDeliveries: 0 },
  ])("forces a matching restart immediately regardless of activity %j", async (activity) => {
    vi.useFakeTimers();
    const events: string[] = [];
    const onStatus = vi.fn(async () => { events.push("status"); });
    const onReady = vi.fn(async () => { events.push("ready"); });
    const scheduler = new SafeRestartScheduler({ readActivity: () => activity, onStatus, onReady });
    const target = { contextKey: "chat_id:first:thread_id:topic", replyMessageId: "om_anchor" };
    scheduler.schedule("pending restart or update", target);
    await vi.advanceTimersByTimeAsync(0);
    events.length = 0;

    expect(await scheduler.forceScheduled(1)).toBe(true);

    expect(scheduler.scheduled).toBe(false);
    expect(onStatus).toHaveBeenLastCalledWith({
      scheduleId: 1, reason: "pending restart or update", phase: "restarting", activity, remainingMs: 0,
      notificationTargets: [{ ...target, reason: "pending restart or update" }],
    });
    expect(events).toEqual(["status", "ready"]);
    expect(onReady).toHaveBeenCalledExactlyOnceWith("pending restart or update", [
      { ...target, reason: "pending restart or update" },
    ]);
    expect(await scheduler.forceScheduled(1)).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onReady).toHaveBeenCalledOnce();
  });

  test("rejects force actions for missing, superseded, and cancelled schedules", async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const scheduler = new SafeRestartScheduler({
      readActivity: () => ({ runningSessions: 1, pendingFinalDeliveries: 0 }), onReady,
    });
    expect(await scheduler.forceScheduled(1)).toBe(false);
    scheduler.schedule("first");
    scheduler.schedule("newer");
    expect(await scheduler.forceScheduled(1)).toBe(false);
    expect(scheduler.pendingReason).toBe("newer");
    await scheduler.cancelCurrent();
    expect(await scheduler.forceScheduled(2)).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
  });

  test("claims a forced restart before awaiting card delivery", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const delivery = new Promise<void>((resolve) => { release = resolve; });
    const onReady = vi.fn();
    const scheduler = new SafeRestartScheduler({
      readActivity: () => ({ runningSessions: 1, pendingFinalDeliveries: 0 }),
      onReady,
      onStatus: (status) => status.phase === "restarting" ? delivery : undefined,
    });
    scheduler.schedule("force once");
    await vi.advanceTimersByTimeAsync(0);
    const forced = scheduler.forceScheduled(1);
    expect(await scheduler.forceScheduled(1)).toBe(false);
    expect(await scheduler.cancelScheduled(1)).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    release();
    expect(await forced).toBe(true);
    expect(onReady).toHaveBeenCalledOnce();
  });

  test("cancels only the matching scheduled restart and publishes its terminal state", async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const onStatus = vi.fn();
    const scheduler = new SafeRestartScheduler({
      readActivity: () => ({ runningSessions: 1, pendingFinalDeliveries: 0 }),
      onReady,
      onStatus,
      quietPeriodMs: 1_000,
      pollIntervalMs: 100,
    });

    scheduler.schedule("cancel from card");
    await vi.advanceTimersByTimeAsync(0);

    expect(await scheduler.cancelScheduled(2)).toBe(false);
    expect(scheduler.scheduled).toBe(true);
    expect(await scheduler.cancelScheduled(1)).toBe(true);
    expect(scheduler.scheduled).toBe(false);
    expect(onStatus).toHaveBeenLastCalledWith({
      scheduleId: 1,
      reason: "cancel from card",
      notificationTargets: [],
      phase: "cancelled",
      activity: { runningSessions: 1, pendingFinalDeliveries: 0 },
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(onReady).not.toHaveBeenCalled();

    scheduler.schedule("newer restart");
    expect(await scheduler.cancelScheduled(1)).toBe(false);
    expect(scheduler.scheduled).toBe(true);
    expect(await scheduler.cancelCurrent()).toBe(true);
    expect(scheduler.scheduled).toBe(false);
    expect(await scheduler.cancelCurrent()).toBe(false);
  });
});
