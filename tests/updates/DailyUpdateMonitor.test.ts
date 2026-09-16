import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DailyUpdateMonitor, scheduleDailyUpdate } from "../../src/updates/DailyUpdateMonitor.js";
import { StateStore } from "../../src/state/StateStore.js";
import { SafeRestartScheduler } from "../../src/supervision/SafeRestartScheduler.js";
import type { CardAction } from "../../src/feishu/types.js";

const monitors: DailyUpdateMonitor[] = [];
const stores: StateStore[] = [];
const directories: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 16, 10));
});
afterEach(async () => {
  for (const monitor of monitors.splice(0)) await monitor.stop();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-updates-"));
  directories.push(directory);
  const database = path.join(directory, "state.sqlite");
  const store = new StateStore(database);
  stores.push(store);
  const options = {
    store,
    outbound: {
      sendInteractiveCard: vi.fn(async () => "om_update" as string | undefined),
      updateInteractiveCard: vi.fn(async () => undefined),
    },
    logger: { info: vi.fn(), warn: vi.fn() },
    currentVersion: "0.1.22",
    userOpenId: vi.fn(() => "ou_owner" as string | undefined),
    readLatest: vi.fn(async () => "0.1.23"),
    readNotes: vi.fn(async () => "- Faster task cards\n- New HTML preview"),
    checkSupport: vi.fn(async () => undefined),
    applyUpdate: vi.fn(async () => undefined),
    hasPendingUpdate: vi.fn(() => false),
    pendingVersion: vi.fn(() => undefined as string | undefined),
    random: vi.fn(() => 0),
  };
  const monitor = new DailyUpdateMonitor(options);
  monitors.push(monitor);
  return {
    monitor, options, store, database,
    start: async () => { await monitor.start(); await vi.advanceTimersByTimeAsync(0); },
    action: (): CardAction => ({
      actionId: "cancel", contextKey: "chat_id:private", userId: "ou_owner", messageId: "om_update",
      value: { action: "agentbot_update_cancel", version: "0.1.23", token: store.getUpdateNotice("0.1.23")!.token },
    }),
    restart: async () => {
      await monitor.stop();
      const nextStore = new StateStore(database);
      stores.push(nextStore);
      const next = new DailyUpdateMonitor({ ...options, store: nextStore });
      monitors.push(next);
      await next.start();
      await vi.advanceTimersByTimeAsync(0);
      return next;
    },
  };
}

describe("daily update scheduling", () => {
  test.each([8, 10, 14, 16, 17, 23])("chooses a local daytime slot when starting at %s:00", (hour) => {
    const now = new Date(2026, 8, 16, hour).getTime();
    for (const random of [0, 0.5, 0.99999, 1]) {
      const schedule = scheduleDailyUpdate(now, () => random);
      const due = new Date(schedule.dueAt);
      expect(due.getHours()).toBeGreaterThanOrEqual(10);
      expect(due.getHours()).toBeLessThan(17);
      expect(due.getDate()).toBe(hour >= 17 ? 17 : 16);
      expect(schedule.dueAt).toBeGreaterThanOrEqual(now);
    }
  });

  test("persists the random slot and performs one check per day across restarts", async () => {
    const f = fixture();
    f.options.random.mockReturnValue(0.5);
    await f.start();
    const schedule = f.store.getUpdateCheckSchedule();
    await f.restart();
    expect(f.options.random).toHaveBeenCalledOnce();
    expect(f.store.getUpdateCheckSchedule()).toEqual(schedule);
    vi.setSystemTime(schedule!.dueAt);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.options.readLatest).toHaveBeenCalledOnce();
    await f.monitor.stop();
  });

  test("checks a missed slot once inside the window, but never at night", async () => {
    const f = fixture();
    f.store.saveUpdateCheckSchedule({ day: "2026-9-16", dueAt: Date.now(), checked: false });
    vi.setSystemTime(new Date(2026, 8, 16, 18));
    await f.start();
    expect(f.options.readLatest).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(2026, 8, 17, 12));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.options.readLatest).toHaveBeenCalledOnce();
  });

  test("does not repeatedly query a failing registry on the same day", async () => {
    const f = fixture();
    f.options.readLatest.mockRejectedValue(new Error("offline"));
    await f.start();
    await f.restart();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.options.readLatest).toHaveBeenCalledOnce();
    expect(f.options.outbound.sendInteractiveCard).not.toHaveBeenCalled();
  });

  test.each(["0.1.22", "0.1.21", "0.1.23-alpha.1", "not-a-version"])("does not install %s", async (version) => {
    const f = fixture();
    f.options.readLatest.mockResolvedValue(version);
    await f.start();
    await vi.advanceTimersByTimeAsync(65_000);
    expect(f.options.readNotes).not.toHaveBeenCalled();
    expect(f.options.applyUpdate).not.toHaveBeenCalled();
    expect(f.options.outbound.sendInteractiveCard).not.toHaveBeenCalled();
  });

  test("does not check or update without a private notification recipient", async () => {
    const f = fixture();
    f.options.userOpenId.mockReturnValue(undefined);
    await f.start();
    await vi.advanceTimersByTimeAsync(65_000);
    expect(f.options.readLatest).not.toHaveBeenCalled();
    expect(f.options.applyUpdate).not.toHaveBeenCalled();
    f.options.userOpenId.mockReturnValue("ou_owner");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.options.outbound.sendInteractiveCard).toHaveBeenCalledOnce();
  });
});

describe("update notification and countdown", () => {
  test("unsupported installations receive notes and the manual-update error, without an automatic countdown", async () => {
    const f = fixture();
    f.options.checkSupport.mockRejectedValue(new Error("Source checkout: update manually"));
    await f.start();
    await vi.advanceTimersByTimeAsync(65_000);
    const card = JSON.stringify(f.options.outbound.sendInteractiveCard.mock.calls[0]);
    expect(card).toContain("New HTML preview");
    expect(card).toContain("update manually");
    expect(card).not.toContain("自动更新倒计时");
    expect(f.options.applyUpdate).not.toHaveBeenCalled();
    expect(f.store.getUpdateNotice("0.1.23")?.status).toBe("failed");
  });

  test("privately presents release notes and a full minute to cancel before preparing the pinned version", async () => {
    const f = fixture();
    await f.start();
    const notice = f.store.getUpdateNotice("0.1.23")!;
    expect(f.options.outbound.sendInteractiveCard).toHaveBeenCalledWith("open_id:ou_owner", expect.any(Object), notice.token);
    const card = JSON.stringify(f.options.outbound.sendInteractiveCard.mock.calls[0]);
    expect(card).toContain("New HTML preview");
    expect(card).toContain("60 秒");
    expect(card).toContain("取消本次更新");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.options.applyUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.options.applyUpdate).toHaveBeenCalledExactlyOnceWith("0.1.23");
    expect(f.options.readLatest).toHaveBeenCalledOnce();
    expect(f.store.getUpdateNotice("0.1.23")?.status).toBe("scheduled");
    expect(f.options.outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    expect(f.options.outbound.updateInteractiveCard.mock.calls.length).toBeLessThan(18);
  });

  test("cancellation at the last second survives a database reopen and suppresses this version, not newer versions", async () => {
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(59_000);
    await f.monitor.cancel(f.action());
    await f.restart();
    await vi.advanceTimersByTimeAsync(60_000);
    vi.setSystemTime(new Date(2026, 8, 17, 10));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.options.applyUpdate).not.toHaveBeenCalled();
    expect(f.options.outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    expect(f.store.getUpdateNotice("0.1.23")?.status).toBe("cancelled");
    f.options.readLatest.mockResolvedValue("0.1.24");
    vi.setSystemTime(new Date(2026, 8, 18, 10));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.options.outbound.sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect(f.store.getUpdateNotice("0.1.24")?.status).toBe("countdown");
  });

  test("renews an interrupted countdown on the same card, never installing immediately on recovery", async () => {
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(50_000);
    await f.monitor.stop();
    vi.setSystemTime(new Date(2026, 8, 16, 11));
    await f.restart();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.options.applyUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.options.applyUpdate).toHaveBeenCalledOnce();
    expect(f.options.outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    expect(f.options.readLatest).toHaveBeenCalledOnce();
  });

  test.each(["userId", "messageId", "token"])("rejects cancellation with a forged %s", async (field) => {
    const f = fixture();
    await f.start();
    const action = f.action();
    if (field === "token") action.value.token = "forged";
    else if (field === "userId") action.userId = "forged";
    else action.messageId = "forged";
    await expect(f.monitor.cancel(action)).rejects.toThrow("无权操作");
    expect(f.store.getUpdateNotice("0.1.23")?.status).toBe("countdown");
  });

  test("late cancellation cannot race update preparation", async () => {
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(f.monitor.cancel(f.action())).rejects.toThrow("倒计时已结束");
    expect(f.options.applyUpdate).toHaveBeenCalledOnce();
  });

  test("cancelling the later safe-restart card also marks the original update reminder cancelled", async () => {
    const f = fixture();
    await f.start();
    f.options.applyUpdate.mockImplementation(async () => { await f.monitor.cancelPreparedUpdate("0.1.23"); });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.store.getUpdateNotice("0.1.23")?.status).toBe("cancelled");
    expect(JSON.stringify(f.options.outbound.updateInteractiveCard.mock.lastCall)).toContain("已取消本版本");
    await f.restart();
    expect(f.store.getUpdateNotice("0.1.23")?.status).toBe("cancelled");
  });

  test("does not overwrite an already pending manual restart at the end of the countdown", async () => {
    const f = fixture();
    await f.start();
    f.options.hasPendingUpdate.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.options.applyUpdate).not.toHaveBeenCalled();
    expect(f.store.getUpdateNotice("0.1.23")?.status).toBe("failed");
  });

  test("disarms the countdown when the configured private recipient changes", async () => {
    const f = fixture();
    await f.start();
    f.options.userOpenId.mockReturnValue("ou_replacement");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.store.getUpdateNotice("0.1.23")?.status).toBe("cancelled");
    expect(f.options.applyUpdate).not.toHaveBeenCalled();
    expect(f.options.outbound.sendInteractiveCard).toHaveBeenCalledOnce();
  });

  test("does not overwrite a cancellation with an in-flight countdown card refresh", async () => {
    const f = fixture();
    await f.start();
    let resolve!: () => void;
    f.options.outbound.updateInteractiveCard.mockImplementationOnce(() => new Promise<undefined>((done) => { resolve = () => done(undefined); }));
    await vi.advanceTimersByTimeAsync(5_000);
    const cancelled = f.monitor.cancel(f.action());
    resolve();
    await cancelled;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(JSON.stringify(f.options.outbound.updateInteractiveCard.mock.lastCall)).toContain("已取消本版本");
    expect(f.options.applyUpdate).not.toHaveBeenCalled();
  });

  test.each(["notes", "send", "unconfirmed", "refresh", "prepare"])("fails closed when %s fails", async (phase) => {
    const f = fixture();
    if (phase === "notes") f.options.readNotes.mockRejectedValue(new Error("no notes"));
    if (phase === "send") f.options.outbound.sendInteractiveCard.mockRejectedValue(new Error("delivery failed"));
    if (phase === "unconfirmed") f.options.outbound.sendInteractiveCard.mockResolvedValue(undefined);
    if (phase === "refresh") f.options.outbound.updateInteractiveCard.mockRejectedValue(new Error("offline"));
    if (phase === "prepare") f.options.applyUpdate.mockRejectedValue(new Error("Source installations are not supported"));
    await f.start();
    await vi.advanceTimersByTimeAsync(65_000);
    await f.restart();
    await vi.advanceTimersByTimeAsync(65_000);
    expect(f.options.applyUpdate).toHaveBeenCalledTimes(phase === "prepare" ? 1 : 0);
    expect(f.options.outbound.sendInteractiveCard).toHaveBeenCalledTimes(phase === "notes" ? 0 : 1);
    if (phase !== "notes") expect(f.store.getUpdateNotice("0.1.23")?.status).toBe("failed");
  });

  test("does not show a duplicate card when prior delivery acknowledgement was lost", async () => {
    const f = fixture();
    await f.start();
    const notice = f.store.getUpdateNotice("0.1.23")!;
    f.store.saveUpdateNotice({ ...notice, status: "announcing", messageId: undefined, deadline: undefined });
    await f.restart();
    await vi.advanceTimersByTimeAsync(65_000);
    expect(f.options.outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    expect(f.options.applyUpdate).not.toHaveBeenCalled();
  });

  test("recovers prepared updates without preparing twice and marks successful activation on the same card", async () => {
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(60_000);
    f.options.pendingVersion.mockReturnValue("0.1.23");
    const next = await f.restart();
    expect(f.store.getUpdateNotice("0.1.23")?.status).toBe("scheduled");
    await next.stop();
    const upgraded = new DailyUpdateMonitor({ ...f.options, currentVersion: "0.1.23" });
    monitors.push(upgraded);
    await upgraded.start();
    expect(f.store.getUpdateNotice("0.1.23")?.status).toBe("completed");
    expect(f.options.applyUpdate).toHaveBeenCalledOnce();
    expect(f.options.outbound.sendInteractiveCard).toHaveBeenCalledOnce();
  });

  test("stopping the service disarms the countdown", async () => {
    const f = fixture();
    await f.start();
    await f.monitor.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.options.applyUpdate).not.toHaveBeenCalled();
  });

  test("reuses the safe restart gate for active tasks, deliveries, and new inbound messages", async () => {
    const f = fixture();
    let activity = { runningSessions: 1, pendingFinalDeliveries: 0, latestInboundAt: "initial" };
    const activate = vi.fn();
    const scheduler = new SafeRestartScheduler({ readActivity: () => activity, onReady: activate });
    f.options.applyUpdate.mockImplementation(async () => {
      scheduler.schedule("auto update", { contextKey: "open_id:ou_owner" });
    });
    try {
      await f.start();
      await vi.advanceTimersByTimeAsync(65_000);
      expect(f.options.applyUpdate).toHaveBeenCalledOnce();
      expect(activate).not.toHaveBeenCalled();
      activity = { ...activity, runningSessions: 0, pendingFinalDeliveries: 1 };
      await vi.advanceTimersByTimeAsync(10_000);
      expect(activate).not.toHaveBeenCalled();
      activity = { ...activity, pendingFinalDeliveries: 0 };
      await vi.advanceTimersByTimeAsync(3_000);
      activity = { ...activity, latestInboundAt: "new message" };
      await vi.advanceTimersByTimeAsync(3_000);
      expect(activate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(activate).toHaveBeenCalledOnce();
    } finally {
      scheduler.cancel();
    }
  });
});
