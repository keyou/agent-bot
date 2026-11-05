import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  nextScheduleTime,
  scheduleInputSchema,
  type ScheduleInput,
  type ScheduledJob,
  type ScheduledRun,
  type ScheduledRunStatus,
} from "./types.js";

interface JsonRow {
  value_json: string;
}
const active = "'queued','dispatching','submitting','running','unknown'";

export class ScheduledTaskStore {
  constructor(private readonly db: Database.Database) {}

  create(
    input: ScheduleInput,
    target: Pick<
      ScheduledJob,
      "localSessionId" | "contextKey" | "replyMessageId" | "ownerId"
    >,
    now = Date.now(),
  ): ScheduledJob {
    const spec = scheduleInputSchema.parse(input);
    if (!nextScheduleTime(spec, now)) throw new Error("执行时间必须在将来。");
    const job: ScheduledJob = {
      id: `sched_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      revision: 1,
      status: "draft",
      ...target,
      spec,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO scheduled_jobs (id, local_session_id, context_key, status, next_run_at, revision, value_json)
      VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        job.id,
        job.localSessionId,
        job.contextKey,
        job.status,
        job.revision,
        JSON.stringify(job),
      );
    return job;
  }

  get(id: string): ScheduledJob | undefined {
    const row = this.db
      .prepare("SELECT value_json FROM scheduled_jobs WHERE id = ?")
      .get(id) as JsonRow | undefined;
    return row ? (JSON.parse(row.value_json) as ScheduledJob) : undefined;
  }

  list(contextKey?: string, limit = 10, offset = 0): ScheduledJob[] {
    const rows = this.db
      .prepare(
        `SELECT value_json FROM scheduled_jobs WHERE status != 'deleted'
      AND (? IS NULL OR context_key = ?) ORDER BY rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(
        contextKey ?? null,
        contextKey ?? null,
        Math.min(100, limit),
        offset,
      ) as JsonRow[];
    return rows.map((row) => JSON.parse(row.value_json) as ScheduledJob);
  }

  due(now: number): ScheduledJob[] {
    return (
      this.db
        .prepare(
          `SELECT value_json FROM scheduled_jobs WHERE status = 'enabled'
      AND next_run_at <= ? ORDER BY next_run_at LIMIT 50`,
        )
        .all(now) as JsonRow[]
    ).map((row) => JSON.parse(row.value_json) as ScheduledJob);
  }

  update(job: ScheduledJob, now = Date.now()): ScheduledJob {
    const updated = { ...job, revision: job.revision + 1, updatedAt: now };
    const result = this.db
      .prepare(
        `UPDATE scheduled_jobs SET status = ?, next_run_at = ?, revision = ?, value_json = ?
      WHERE id = ? AND revision = ?`,
      )
      .run(
        updated.status,
        updated.nextRunAt ?? null,
        updated.revision,
        JSON.stringify(updated),
        job.id,
        job.revision,
      );
    if (!result.changes) throw new Error("计划已变化，请刷新后重试。");
    return updated;
  }

  change(
    id: string,
    revision: number,
    operation: "confirm" | "pause" | "resume" | "delete",
    now = Date.now(),
  ): ScheduledJob {
    return this.db.transaction(() => {
      const job = this.require(id, revision);
      if (operation === "confirm" && job.status !== "draft")
        throw new Error("计划草稿已失效。");
      if (operation === "pause" && job.status === "draft")
        throw new Error("草稿尚未启用。");
      if (operation === "resume" && job.status !== "paused")
        throw new Error("仅已暂停的计划可以恢复；草稿需先确认。");
      if (operation === "confirm" || operation === "resume") {
        job.nextRunAt = nextScheduleTime(job.spec, now);
        if (job.nextRunAt === undefined)
          throw new Error("一次性时间已过期，请编辑计划。");
        job.status = "enabled";
      } else {
        job.status = operation === "delete" ? "deleted" : "paused";
        job.nextRunAt = undefined;
        this.cancelPending(id, "计划已暂停或删除。");
      }
      job.notice = undefined;
      return this.update(job, now);
    })();
  }

  edit(
    id: string,
    revision: number,
    input: ScheduleInput,
    now = Date.now(),
  ): ScheduledJob {
    const spec = scheduleInputSchema.parse(input);
    if (nextScheduleTime(spec, now) === undefined)
      throw new Error("执行时间必须在将来。");
    return this.db.transaction(() => {
      const job = this.require(id, revision);
      this.cancelPending(id, "计划已编辑，等待重新确认。");
      return this.update(
        { ...job, spec, status: "draft", nextRunAt: undefined },
        now,
      );
    })();
  }

  require(id: string, revision?: number): ScheduledJob {
    const job = this.get(id);
    if (!job || job.status === "deleted")
      throw new Error("计划不存在或已删除。");
    if (revision !== undefined && job.revision !== revision)
      throw new Error("计划卡片已过期，请刷新。");
    return job;
  }

  runs(id: string, limit = 10): ScheduledRun[] {
    return (
      this.db
        .prepare(
          "SELECT value_json FROM scheduled_runs WHERE job_id = ? ORDER BY rowid DESC LIMIT ?",
        )
        .all(id, Math.min(100, limit)) as JsonRow[]
    ).map((row) => JSON.parse(row.value_json) as ScheduledRun);
  }

  getRun(id: string): ScheduledRun | undefined {
    const row = this.db
      .prepare("SELECT value_json FROM scheduled_runs WHERE id = ?")
      .get(id) as JsonRow | undefined;
    return row ? (JSON.parse(row.value_json) as ScheduledRun) : undefined;
  }

  ownsTurn(turnId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM scheduled_runs s JOIN turn_attempts t ON t.attempt_id = s.id
      WHERE t.turn_id = ? OR t.pending_turn_id = ? LIMIT 1`,
        )
        .get(turnId, turnId),
    );
  }

  saveRun(run: ScheduledRun): void {
    this.db
      .prepare(
        "UPDATE scheduled_runs SET status = ?, value_json = ? WHERE id = ?",
      )
      .run(run.status, JSON.stringify(run), run.id);
  }

  pendingRuns(): ScheduledRun[] {
    return (
      this.db
        .prepare(
          "SELECT value_json FROM scheduled_runs WHERE status IN ('queued','dispatching','submitting','running') ORDER BY rowid LIMIT 500",
        )
        .all() as JsonRow[]
    ).map((row) => JSON.parse(row.value_json) as ScheduledRun);
  }

  dispatch(
    job: ScheduledJob,
    scheduledFor: number,
    now: number,
    options: { manual?: boolean; skip?: string } = {},
  ): ScheduledRun | undefined {
    return this.db.transaction(() => {
      const current = this.require(job.id, job.revision);
      if (current.status !== "enabled" && !options.manual) return undefined;
      if (current.status === "draft") throw new Error("草稿需要先确认。");
      const manual = options.manual === true;
      const busy = this.db
        .prepare(
          `SELECT 1 FROM scheduled_runs WHERE job_id = ? AND status IN (${active}) LIMIT 1`,
        )
        .get(job.id);
      const detail = options.skip ?? (busy ? "上次运行尚未结束。" : undefined);
      const run: ScheduledRun = {
        id: `schedule_run_${randomUUID()}`,
        jobId: job.id,
        scheduledFor,
        deadline: scheduledFor + job.spec.maxDelayMinutes * 60_000,
        manual,
        status: detail ? "skipped" : "queued",
        detail,
      };
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO scheduled_runs (id, job_id, occurrence_key, status, value_json)
        VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          job.id,
          manual ? run.id : String(scheduledFor),
          run.status,
          JSON.stringify(run),
        );
      if (!inserted.changes) return undefined;
      if (!detail) {
        this.db
          .prepare(
            `INSERT INTO queued_prompts (prompt_id, local_session_id, context_key, prompt_text,
          display_prompt, local_image_paths_json, reply_message_id, created_at) VALUES (?, ?, ?, ?, ?, '[]', ?, ?)`,
          )
          .run(
            run.id,
            job.localSessionId,
            job.contextKey,
            job.spec.prompt,
            `[定时任务：${job.spec.name} · ${new Date(scheduledFor).toISOString()}]\n${job.spec.prompt}`,
            job.replyMessageId ?? null,
            new Date(now).toISOString(),
          );
      }
      if (!manual) {
        current.nextRunAt = nextScheduleTime(current.spec, now);
        if (current.nextRunAt === undefined) current.status = "completed";
        this.update(current, now);
      }
      return run;
    })();
  }

  claimStart(id: string, now = Date.now()): boolean {
    const run = this.getRun(id);
    if (!run) return true;
    if (run.status !== "queued") return false;
    if (!this.canSubmit(id, now)) return false;
    const job = this.get(run.jobId);
    const session = job
      ? (this.db
          .prepare("SELECT status FROM sessions WHERE local_session_id = ?")
          .get(job.localSessionId) as { status: string } | undefined)
      : undefined;
    if (!session || session.status === "closed") {
      this.finish(id, "cancelled", "目标任务已关闭。");
      return false;
    }
    this.saveRun({ ...run, status: "dispatching", startedAt: now });
    return true;
  }

  canSubmit(id: string, now = Date.now()): boolean {
    const run = this.getRun(id);
    if (!run || !["queued", "dispatching"].includes(run.status)) return false;
    const job = this.get(run.jobId);
    const allowed =
      job &&
      (job.status === "enabled" ||
        job.status === "completed" ||
        (run.manual && job.status === "paused"));
    if (!allowed || now > run.deadline) {
      this.saveRun({
        ...run,
        status: allowed ? "expired" : "cancelled",
        detail: allowed ? "超过最晚开始时间。" : "计划已暂停、编辑或删除。",
      });
      return false;
    }
    return true;
  }

  finish(id: string, status: ScheduledRunStatus, detail?: string): void {
    const run = this.getRun(id);
    if (run) this.saveRun({ ...run, status, detail });
  }

  cancelPending(id: string, detail: string): void {
    const rows = this.db
      .prepare(
        "SELECT value_json FROM scheduled_runs WHERE job_id = ? AND status IN ('queued','dispatching')",
      )
      .all(id) as JsonRow[];
    for (const row of rows) {
      const run = JSON.parse(row.value_json) as ScheduledRun;
      this.saveRun({ ...run, status: "cancelled", detail });
      this.db
        .prepare("DELETE FROM queued_prompts WHERE prompt_id = ?")
        .run(run.id);
    }
  }
}
