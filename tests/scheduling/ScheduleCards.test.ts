import { describe, expect, test } from "vitest";
import { renderSchedule } from "../../src/scheduling/ScheduleCards.js";
import type { ScheduledJob, ScheduledRun } from "../../src/scheduling/types.js";

const time = Date.parse("2026-10-28T14:07:35+08:00");
const job: ScheduledJob = {
  id: "sched_test",
  revision: 3,
  status: "draft",
  localSessionId: "task",
  contextKey: "chat_id:c:thread_id:t",
  replyMessageId: "anchor",
  ownerId: "owner",
  spec: {
    name: "报时测试",
    prompt: "Report the current time.",
    at: "2026-10-28T14:07:35.1234567+08:00",
    timeZone: "Asia/Singapore",
    maxDelayMinutes: 60,
    catchUpMinutes: 0,
  },
  createdAt: time,
  updatedAt: time,
};
const run: ScheduledRun = {
  id: "run_test",
  jobId: job.id,
  status: "unknown",
  scheduledFor: time,
  deadline: time + 3_600_000,
  startedAt: time + 5000,
  turnId: "turn_test",
  manual: false,
};

function objects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(objects);
  if (!value || typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  return [item, ...Object.values(item).flatMap(objects)];
}
function buttons(card: unknown): Record<string, unknown>[] {
  return objects(card).filter((item) => item.tag === "button");
}
function navigationValues(card: unknown): unknown[] {
  return objects(card)
    .filter((item) => item.type === "callback")
    .map((item) => item.value);
}

describe("scheduled plan and run-history cards", () => {
  test("keeps one plan-action row and moves navigation to borderless links", () => {
    const card = renderSchedule(job, "Target task", []);
    expect(buttons(card).map((item) => item.value)).toEqual([
      expect.objectContaining({ action: "schedule_confirm", revision: "3" }),
      expect.objectContaining({ action: "schedule_edit", revision: "3" }),
      expect.objectContaining({ action: "schedule_delete", revision: "3" }),
    ]);
    expect(buttons(card)[0]).toMatchObject({ type: "primary" });
    expect(buttons(card)[2]).toMatchObject({
      type: "danger",
      confirm: expect.any(Object),
    });
    expect(navigationValues(card)).toEqual([
      { action: "schedule_list", contextKey: job.contextKey },
      expect.objectContaining({
        action: "schedule_history",
        scheduleId: job.id,
        contextKey: job.contextKey,
      }),
      expect.objectContaining({ action: "schedule_show", scheduleId: job.id }),
    ]);
    expect(
      objects(card).filter((item) => item.tag === "interactive_container"),
    ).toHaveLength(3);
  });

  test("shows a readable one-time schedule without duplicate next-time or raw ISO text", () => {
    const card = renderSchedule(job, "Target task", []);
    const content = JSON.stringify(card);
    expect(content).toContain("2026/10/28 14:07:35");
    expect(content).toContain("计划时间后 60 分钟");
    expect(content).toContain(job.spec.prompt);
    expect(content).not.toContain(job.spec.at);
    expect(content).not.toContain("下次执行");
    expect(objects(card)).toContainEqual(
      expect.objectContaining({
        tag: "markdown",
        content: `计划 ID：${job.id}`,
        text_size: "notation",
      }),
    );
  });

  test.each([
    [
      "enabled",
      ["schedule_pause", "schedule_run", "schedule_edit", "schedule_delete"],
    ],
    [
      "paused",
      ["schedule_resume", "schedule_run", "schedule_edit", "schedule_delete"],
    ],
    ["completed", ["schedule_run", "schedule_edit", "schedule_delete"]],
    ["deleted", []],
  ] as const)(
    "preserves the appropriate plan controls for %s",
    (status, actions) => {
      const card = renderSchedule({ ...job, status }, "Target task", []);
      expect(
        buttons(card).map(
          (item) => (item.value as Record<string, string>).action,
        ),
      ).toEqual(actions);
    },
  );

  test("history only offers run controls and refresh stays in history", () => {
    const card = renderSchedule(job, "Target task", [run], true);
    expect(buttons(card).map((item) => item.value)).toEqual([
      {
        action: "turn_details",
        turnId: run.turnId,
        contextKey: job.contextKey,
      },
      expect.objectContaining({
        action: "schedule_resolve",
        runId: run.id,
        revision: "3",
      }),
    ]);
    expect(buttons(card)[1]).toMatchObject({ confirm: expect.any(Object) });
    expect(navigationValues(card)).toEqual([
      { action: "schedule_list", contextKey: job.contextKey },
      expect.objectContaining({ action: "schedule_show", scheduleId: job.id }),
      expect.objectContaining({
        action: "schedule_history",
        scheduleId: job.id,
      }),
    ]);
    expect(JSON.stringify(card)).not.toContain(job.spec.prompt);
    expect(
      objects(card).filter((item) => item.tag === "column_set"),
    ).toHaveLength(2);
  });

  test("empty history and ended runs do not acquire plan-editing or resolve controls", () => {
    const empty = renderSchedule(job, "Target task", [], true);
    expect(buttons(empty)).toEqual([]);
    expect(JSON.stringify(empty)).toContain("暂无执行记录");
    const ended = renderSchedule(
      job,
      "Target task",
      [{ ...run, status: "completed" }],
      true,
    );
    expect(buttons(ended)).toHaveLength(1);
    expect(buttons(ended)[0]).toMatchObject({
      value: { action: "turn_details" },
    });
  });

  test("keeps cron timing separate from its next execution time", () => {
    const { at: _at, ...spec } = job.spec;
    const card = renderSchedule(
      {
        ...job,
        status: "enabled",
        nextRunAt: time,
        spec: { ...spec, cron: "0 9 * * 1-5" },
      },
      "Target task",
      [],
    );
    expect(JSON.stringify(card)).toContain("周期：0 9 * * 1-5");
    expect(JSON.stringify(card)).toContain("下次执行：2026/10/28 14:07:35");
  });
});
