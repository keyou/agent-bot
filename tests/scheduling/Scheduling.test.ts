import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { StateStore } from "../../src/state/StateStore.js";
import { TaskScheduler } from "../../src/scheduling/TaskScheduler.js";
import { parseScheduleCommand } from "../../src/scheduling/ScheduleCommand.js";
import {
  scheduleInputSchema,
  nextScheduleTime,
} from "../../src/scheduling/types.js";
import {
  renderSchedule,
  renderScheduleForm,
  renderScheduleList,
} from "../../src/scheduling/ScheduleCards.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});
const now = Date.parse("2026-10-28T08:00:00+08:00");
const input = {
  name: "每日检查",
  prompt: "check build",
  cron: "0 9 * * *",
  timeZone: "Asia/Singapore",
};
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-schedule-"));
  const dbPath = path.join(dir, "state.sqlite");
  const store = new StateStore(dbPath);
  cleanups.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  store.createSession({
    localSessionId: "task",
    contextKey: "chat_id:c",
    cwd: dir,
    agentName: "codex",
    status: "ready",
  });
  const target = {
    localSessionId: "task",
    contextKey: "chat_id:c",
    ownerId: "ou_owner",
  };
  const draft = store.schedules.create(input, target);
  const job = store.schedules.change(draft.id, draft.revision, "confirm");
  return { store, target, job, dbPath };
}

describe("scheduled task rules and persistence", () => {
  test("defaults the start deadline and new-plan form to 60 minutes while preserving explicit limits", () => {
    expect(scheduleInputSchema.parse(input).maxDelayMinutes).toBe(60);
    expect(
      scheduleInputSchema.parse({ ...input, maxDelayMinutes: 10 })
        .maxDelayMinutes,
    ).toBe(10);
    expect(renderScheduleForm("chat_id:c", undefined, "task")).toMatchObject({
      body: {
        elements: expect.arrayContaining([
          expect.objectContaining({
            tag: "form",
            elements: expect.arrayContaining([
              expect.objectContaining({
                name: "maxDelayMinutes",
                default_value: "60",
              }),
            ]),
          }),
        ]),
      },
    });
    const { job } = fixture();
    expect(
      renderScheduleForm("chat_id:c", {
        ...job,
        spec: { ...job.spec, maxDelayMinutes: 10 },
      }),
    ).toMatchObject({
      body: {
        elements: expect.arrayContaining([
          expect.objectContaining({
            tag: "form",
            elements: expect.arrayContaining([
              expect.objectContaining({
                name: "maxDelayMinutes",
                default_value: "10",
              }),
            ]),
          }),
        ]),
      },
    });
  });
  test.each([11 * 60_000, 60 * 60_000, 60 * 60_000 + 1])(
    "starts queued work after %i ms only within the 60-minute deadline",
    (delay) => {
      const { store, job } = fixture();
      const run = store.schedules.dispatch(job, now, now)!;
      expect(run.deadline).toBe(now + 60 * 60_000);
      vi.setSystemTime(now + delay);
      const canStart = delay <= 60 * 60_000;
      expect(store.takeNextQueuedPrompt("task")?.promptId).toBe(
        canStart ? run.id : undefined,
      );
      expect(store.schedules.getRun(run.id)?.status).toBe(
        canStart ? "dispatching" : "expired",
      );
    },
  );
  test("parses commands without losing quoted prompts or cron expressions", () => {
    expect(
      parseScheduleCommand([
        "add",
        "--cron",
        "0 9 * * 1-5",
        "--prompt",
        "check all builds",
      ]),
    ).toMatchObject({
      operation: "add",
      input: { prompt: "check all builds", cron: "0 9 * * 1-5" },
    });
    expect(() => parseScheduleCommand(["run"])).toThrow();
    expect(() =>
      parseScheduleCommand(["add", "--cron", "x", "--cron", "y"]),
    ).toThrow();
    expect(() => parseScheduleCommand(["add", "--unknown", "x"])).toThrow();
  });
  test.each([
    { ...input, cron: "bad" },
    { ...input, cron: "* * * * * *" },
    { ...input, timeZone: "not/a/timezone" },
    { ...input, at: "2026-10-29T09:00:00+08:00" },
    { prompt: "" },
    { prompt: "hello", at: "tomorrow" },
    { ...input, maxDelayMinutes: 0 },
  ])("rejects invalid schedule $cron $at $timeZone", (invalid) => {
    expect(scheduleInputSchema.safeParse(invalid).success).toBe(false);
  });
  test("computes timezone-aware calendar occurrences and once-only time", () => {
    const spec = scheduleInputSchema.parse(input);
    expect(nextScheduleTime(spec, now)).toBe(
      Date.parse("2026-10-28T09:00:00+08:00"),
    );
    const once = scheduleInputSchema.parse({
      prompt: "once",
      at: "2026-10-28T09:00:00+08:00",
    });
    expect(nextScheduleTime(once, Date.parse(once.at!))).toBeUndefined();
    const dst = scheduleInputSchema.parse({
      ...input,
      timeZone: "America/New_York",
    });
    expect(nextScheduleTime(dst, Date.parse("2026-03-07T20:00:00Z"))).toBe(
      Date.parse("2026-03-08T13:00:00Z"),
    );
  });
  test("requires confirmation, rejects stale cards, and never enables a paused draft", () => {
    const { store, target } = fixture();
    const draft = store.schedules.create(input, target);
    expect(
      store.schedules.due(now + 86_400_000).some((job) => job.id === draft.id),
    ).toBe(false);
    expect(() =>
      store.schedules.change(draft.id, draft.revision, "pause"),
    ).toThrow();
    store.schedules.change(draft.id, draft.revision, "confirm");
    expect(() =>
      store.schedules.change(draft.id, draft.revision, "confirm"),
    ).toThrow();
  });
  test("atomically enqueues one occurrence and creates its attempt only when consumed", () => {
    const { store, job } = fixture();
    vi.setSystemTime(job.nextRunAt!);
    const run = store.schedules.dispatch(job, job.nextRunAt!, Date.now())!;
    expect(store.getTurnAttempt(run.id)).toBeUndefined();
    expect(store.listQueuedPrompts("task")).toHaveLength(1);
    const updated = store.schedules.get(job.id)!;
    expect(
      store.schedules.dispatch(updated, run.scheduledFor, Date.now()),
    ).toBeUndefined();
    expect(store.listQueuedPrompts("task")).toHaveLength(1);
    expect(store.takeNextQueuedPrompt("task")?.promptId).toBe(run.id);
    expect(store.getTurnAttempt(run.id)).toMatchObject({
      status: "accepted",
      promptText: input.prompt,
    });
    expect(store.schedules.getRun(run.id)?.status).toBe("dispatching");
    expect(store.takeNextQueuedPrompt("task")).toBeUndefined();
  });
  test("a failed transaction cannot leave a run without its queue entry", () => {
    const { store, job } = fixture();
    vi.setSystemTime(job.nextRunAt!);
    const original = store.schedules.update;
    vi.spyOn(store.schedules, "update").mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    expect(() =>
      store.schedules.dispatch(job, job.nextRunAt!, Date.now()),
    ).toThrow("write failed");
    expect(store.schedules.runs(job.id)).toEqual([]);
    expect(store.countQueuedPrompts("task")).toBe(0);
    store.schedules.update = original;
  });
  test("expired scheduled entries do not block ordinary queued prompts", () => {
    const { store, job } = fixture();
    const run = store.schedules.dispatch(job, now, now)!;
    store.enqueuePrompt({
      promptId: "normal",
      localSessionId: "task",
      contextKey: "chat_id:c",
      text: "ordinary",
    });
    vi.setSystemTime(now + 61 * 60_000);
    expect(store.takeNextQueuedPrompt("task")?.promptId).toBe("normal");
    expect(store.schedules.getRun(run.id)?.status).toBe("expired");
    expect(store.getTurnAttempt(run.id)).toBeUndefined();
  });
  test("pause cancels queued and preparing work but leaves submitted work untouched", () => {
    const { store, job } = fixture();
    const run = store.schedules.dispatch(job, now, now)!;
    store.takeNextQueuedPrompt("task");
    const updated = store.schedules.get(job.id)!;
    store.schedules.change(job.id, updated.revision, "pause");
    expect(store.schedules.canSubmit(run.id)).toBe(false);
    expect(store.schedules.getRun(run.id)?.status).toBe("cancelled");
    const resumed = store.schedules.change(
      job.id,
      store.schedules.get(job.id)!.revision,
      "resume",
    );
    const next = store.schedules.dispatch(resumed, now + 1, now, {
      manual: true,
    })!;
    store.schedules.saveRun({ ...next, status: "submitting" });
    store.schedules.change(
      job.id,
      store.schedules.get(job.id)!.revision,
      "pause",
    );
    expect(store.schedules.getRun(next.id)?.status).toBe("submitting");
  });
  test("overlap is skipped and manual execution does not move the next occurrence", () => {
    const { store, job } = fixture();
    store.schedules.dispatch(job, now, now, { manual: true });
    const nextRunAt = store.schedules.get(job.id)!.nextRunAt;
    const next = store.schedules.dispatch(job, now + 1, now + 1, {
      manual: true,
    })!;
    expect(next).toMatchObject({
      status: "skipped",
      detail: "上次运行尚未结束。",
    });
    expect(store.schedules.get(job.id)!.nextRunAt).toBe(nextRunAt);
  });
  test("safe restart ignores scheduled queue entries but waits for actual submission and ordinary queues", () => {
    const { store, job } = fixture();
    const run = store.schedules.dispatch(job, now, now)!;
    expect(store.getServerActivityState().runningSessions).toBe(0);
    expect(store.sessionBlocksSafeRestart("task")).toBe(false);
    store.takeNextQueuedPrompt("task");
    expect(store.getServerActivityState().runningSessions).toBe(1);
    expect(store.sessionBlocksSafeRestart("task")).toBe(true);
    store.schedules.finish(run.id, "failed");
    expect(store.getServerActivityState().runningSessions).toBe(0);
    store.enqueuePrompt({
      promptId: "normal",
      localSessionId: "task",
      contextKey: "chat_id:c",
      text: "ordinary",
    });
    expect(store.getServerActivityState().runningSessions).toBe(1);
  });
  test("edits preserve routing, cancel pending work and require confirmation again", () => {
    const { store, job } = fixture();
    const run = store.schedules.dispatch(job, now, now)!;
    const edited = store.schedules.edit(
      job.id,
      store.schedules.get(job.id)!.revision,
      { ...input, prompt: "changed" },
    );
    expect(edited).toMatchObject({
      status: "draft",
      contextKey: job.contextKey,
      localSessionId: "task",
    });
    expect(store.countQueuedPrompts("task")).toBe(0);
    expect(store.schedules.getRun(run.id)?.status).toBe("cancelled");
  });
  test("reopening an existing database preserves schedules and deduplication", () => {
    const { store, job, dbPath } = fixture();
    store.schedules.dispatch(job, now, now);
    const other = new StateStore(dbPath);
    try {
      expect(other.schedules.get(job.id)).toMatchObject({ status: "enabled" });
      expect(other.countQueuedPrompts("task")).toBe(1);
      expect(
        other.schedules.dispatch(other.schedules.get(job.id)!, now, now),
      ).toBeUndefined();
    } finally {
      other.close();
    }
  });
});

describe("scheduler lifecycle", () => {
  function schedulerFixture() {
    const f = fixture();
    const drain = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    const options = {
      store: f.store,
      logger: { warn: vi.fn() },
      ownerId: () => "ou_owner",
      canDispatch: () => true,
      drain,
      notify,
    };
    const scheduler = new TaskScheduler(options);
    cleanups.push(() => scheduler.stop());
    return { ...f, scheduler, drain, notify, options };
  }
  test("triggers while live, once per occurrence, without loading full history", async () => {
    const { scheduler, store, job, drain } = schedulerFixture();
    await scheduler.start();
    vi.setSystemTime(job.nextRunAt!);
    await scheduler.tick();
    await scheduler.tick();
    expect(store.schedules.runs(job.id)).toHaveLength(1);
    expect(store.countQueuedPrompts("task")).toBe(1);
    expect(drain).toHaveBeenCalledWith("task");
  });
  test("startup skips old occurrences by default and advances directly to the future", async () => {
    const { scheduler, store, job, drain, notify } = schedulerFixture();
    vi.setSystemTime(now + 3 * 86_400_000);
    await scheduler.start();
    expect(store.schedules.runs(job.id)).toHaveLength(1);
    expect(store.schedules.runs(job.id)[0]?.status).toBe("skipped");
    expect(store.schedules.get(job.id)!.nextRunAt).toBeGreaterThan(Date.now());
    expect(drain).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });
  test("a bounded startup scan never runs remaining missed plans on the next poll", async () => {
    const { scheduler, store, target, job } = schedulerFixture();
    for (let index = 0; index < 51; index++) {
      const draft = store.schedules.create(input, target);
      store.schedules.change(draft.id, draft.revision, "confirm");
    }
    vi.setSystemTime(job.nextRunAt! + 10_000);
    await scheduler.start();
    await scheduler.tick();
    expect(store.countQueuedPrompts("task")).toBe(0);
    for (const plan of store.schedules.list(undefined, 100))
      expect(store.schedules.runs(plan.id)[0]?.status).toBe("skipped");
  });
  test("explicit catch-up only queues the latest occurrence inside its window", async () => {
    const { scheduler, store, job } = schedulerFixture();
    const edited = store.schedules.edit(job.id, job.revision, {
      ...input,
      catchUpMinutes: 10,
    });
    store.schedules.change(job.id, edited.revision, "confirm");
    vi.setSystemTime(Date.parse("2026-10-30T09:05:00+08:00"));
    await scheduler.start();
    const runs = store.schedules.runs(job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("queued");
    expect(runs[0]?.scheduledFor).toBe(Date.parse("2026-10-30T09:00:00+08:00"));
  });
  test("safe restart suppresses dispatch until cancelled", async () => {
    const { scheduler, store, job, options } = schedulerFixture();
    await scheduler.start();
    options.canDispatch = () => false;
    vi.setSystemTime(job.nextRunAt!);
    await scheduler.tick();
    expect(store.schedules.runs(job.id)).toHaveLength(0);
    options.canDispatch = () => true;
    await scheduler.tick();
    expect(store.schedules.runs(job.id)).toHaveLength(1);
  });
  test("submitted work with no known turn is not requeued after restart", async () => {
    const { scheduler, store, job, drain } = schedulerFixture();
    const run = store.schedules.dispatch(job, now, now)!;
    store.takeNextQueuedPrompt("task");
    await scheduler.start();
    expect(store.schedules.getRun(run.id)?.status).toBe("unknown");
    expect(store.countQueuedPrompts("task")).toBe(0);
    expect(drain).not.toHaveBeenCalled();
  });
  test("closed targets and changed owners pause without creating replacement tasks", async () => {
    const { scheduler, store, job, options } = schedulerFixture();
    options.ownerId = () => "different";
    vi.setSystemTime(job.nextRunAt!);
    await scheduler.start();
    expect(store.schedules.get(job.id)?.status).toBe("paused");
    expect(store.listAllSessions()).toHaveLength(1);
  });
});

test("cards preserve fixed targets and revisions and never include execution buttons on a draft", () => {
  const { store, job } = fixture();
  const draft = store.schedules.edit(job.id, job.revision, input);
  const content = JSON.stringify(renderSchedule(draft, "target task", []));
  expect(content).toContain("schedule_confirm");
  expect(content).not.toContain("schedule_run");
  expect(content).toContain(String(draft.revision));
  expect(
    JSON.stringify(renderScheduleForm("chat_id:c", undefined, "task")),
  ).toContain('"sessionId":"task"');
  expect(JSON.stringify(renderScheduleList([draft], "chat_id:c", 0))).toContain(
    "schedule_show",
  );
});
