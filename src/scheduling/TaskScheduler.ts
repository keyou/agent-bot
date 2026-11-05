import type { Logger } from "pino";
import type { StateStore } from "../state/StateStore.js";
import { latestScheduleTime, type ScheduledJob } from "./types.js";

interface SchedulerOptions {
  store: StateStore;
  logger: Pick<Logger, "warn">;
  canDispatch(): boolean;
  ownerId(): string | undefined;
  drain(localSessionId: string): Promise<void>;
  notify(job: ScheduledJob, text: string): Promise<void>;
  now?: () => number;
}

export class TaskScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private work?: Promise<void>;
  private stopped = true;
  private startedAt = 0;
  private readonly now: () => number;

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.startedAt = this.now();
    this.work = this.tick(true);
    try {
      await this.work;
    } finally {
      this.work = undefined;
    }
    if (this.stopped) return;
    this.timer = setInterval(() => {
      if (this.work) return;
      this.work = this.tick()
        .catch((error: unknown) => {
          this.options.logger.warn({ error }, "Scheduled task polling failed.");
        })
        .finally(() => {
          this.work = undefined;
        });
    }, 5_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.work;
  }

  async tick(startup = false): Promise<void> {
    const { store } = this.options;
    const now = this.now();
    const drain = new Set<string>();
    for (const run of store.schedules.pendingRuns()) {
      const job = store.schedules.get(run.jobId);
      if (!job) continue;
      const attempt = store.getTurnAttempt(run.id);
      if (
        run.status !== "unknown" &&
        attempt &&
        ["completed", "failed", "cancelled", "interrupted"].includes(
          attempt.status,
        )
      ) {
        const status =
          attempt.status === "interrupted"
            ? "unknown"
            : (attempt.status as "completed" | "failed" | "cancelled");
        store.schedules.saveRun({ ...run, turnId: attempt.turnId, status });
      } else if (
        startup &&
        ["dispatching", "submitting"].includes(run.status) &&
        !attempt?.turnId
      ) {
        store.schedules.finish(
          run.id,
          "unknown",
          "重启后无法确认是否已提交，未自动重发。请核实执行记录。",
        );
      } else if (run.status === "queued") {
        if (!store.schedules.canSubmit(run.id, now)) {
          store.cancelQueuedPrompt(run.id, job.localSessionId);
          await this.notice(
            job,
            store.schedules.getRun(run.id)?.detail ?? "本次运行已取消。",
          );
        } else if (!store.hasQueuedPrompt(run.id)) {
          store.schedules.finish(run.id, "cancelled", "排队任务已取消。");
        } else drain.add(job.localSessionId);
      }
      const session = store.getSession(job.localSessionId);
      if (
        job.status === "enabled" &&
        (!session ||
          session.status === "closed" ||
          job.ownerId !== this.options.ownerId())
      ) {
        const changed = store.schedules.change(
          job.id,
          job.revision,
          "pause",
          now,
        );
        await this.notice(
          changed,
          "目标任务已关闭或所有者已变化，定时计划已暂停。",
        );
      }
    }
    if (!this.options.canDispatch() || (this.stopped && !startup)) return;
    for (const job of store.schedules.due(now)) {
      if (!this.options.canDispatch()) break;
      const session = store.getSession(job.localSessionId);
      if (
        !session ||
        session.status === "closed" ||
        job.ownerId !== this.options.ownerId()
      ) {
        const changed = store.schedules.change(
          job.id,
          job.revision,
          "pause",
          now,
        );
        await this.notice(
          changed,
          "目标任务已关闭或所有者已变化，定时计划已暂停。",
        );
        continue;
      }
      const missed =
        startup ||
        job.nextRunAt! <= this.startedAt ||
        now - job.nextRunAt! > 60_000;
      const scheduledFor = missed
        ? latestScheduleTime(job.spec, now)
        : job.nextRunAt!;
      const skip =
        missed &&
        (job.spec.catchUpMinutes === 0 ||
          now - scheduledFor > job.spec.catchUpMinutes * 60_000)
          ? "停服、休眠或调度延迟，已跳过错过的计划。"
          : undefined;
      const run = store.schedules.dispatch(job, scheduledFor, now, { skip });
      if (run?.status === "queued") drain.add(job.localSessionId);
      else if (run && skip)
        await this.notice(store.schedules.get(job.id)!, run.detail!);
    }
    for (const sessionId of drain) {
      if (!this.options.canDispatch()) break;
      await this.options.drain(sessionId);
    }
  }

  private async notice(job: ScheduledJob, text: string): Promise<void> {
    try {
      await this.options.notify(job, `定时任务「${job.spec.name}」：${text}`);
    } catch (error) {
      this.options.logger.warn(
        { error, scheduleId: job.id },
        "Failed to deliver scheduled task notice.",
      );
    }
  }
}
