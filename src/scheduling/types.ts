import { z } from "zod";
import { CronExpressionParser } from "cron-parser";

export const scheduleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).default("定时任务"),
    prompt: z.string().trim().min(1).max(1_000),
    cron: z.string().trim().min(1).max(120).optional(),
    at: z.string().trim().datetime({ offset: true }).optional(),
    timeZone: z
      .string()
      .trim()
      .default(Intl.DateTimeFormat().resolvedOptions().timeZone),
    maxDelayMinutes: z.number().int().min(1).max(10_080).default(60),
    catchUpMinutes: z.number().int().min(0).max(10_080).default(0),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.cron) === Boolean(value.at)) {
      context.addIssue({
        code: "custom",
        message: "请且仅指定 Cron 或带时区的 ISO 执行时间。",
      });
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone: value.timeZone }).format();
      if (value.cron) {
        if (value.cron.split(/\s+/).length !== 5)
          throw new Error("Cron 使用五段格式，最小间隔一分钟。");
        CronExpressionParser.parse(value.cron, { tz: value.timeZone }).next();
      }
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "时间规则无效。",
      });
    }
  });

export type ScheduleInput = z.input<typeof scheduleInputSchema>;
export type ScheduleSpec = z.output<typeof scheduleInputSchema>;
export type ScheduleOperation =
  | "list"
  | "add"
  | "edit"
  | "show"
  | "history"
  | "pause"
  | "resume"
  | "run"
  | "delete";
export interface ScheduleCommand {
  operation: ScheduleOperation;
  id?: string;
  input?: ScheduleInput;
  page?: number;
}
export const scheduleCommandSchema = z
  .object({
    operation: z.enum([
      "list",
      "add",
      "edit",
      "show",
      "history",
      "pause",
      "resume",
      "run",
      "delete",
    ]),
    id: z.string().min(1).max(100).optional(),
    input: scheduleInputSchema.optional(),
    page: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();
export interface ScheduledJob {
  id: string;
  revision: number;
  status: "draft" | "enabled" | "paused" | "completed" | "deleted";
  localSessionId: string;
  contextKey: string;
  replyMessageId?: string;
  ownerId?: string;
  spec: ScheduleSpec;
  nextRunAt?: number;
  createdAt: number;
  updatedAt: number;
  notice?: string;
}
export type ScheduledRunStatus =
  | "queued"
  | "dispatching"
  | "submitting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "skipped"
  | "unknown";
export interface ScheduledRun {
  id: string;
  jobId: string;
  scheduledFor: number;
  deadline: number;
  status: ScheduledRunStatus;
  manual: boolean;
  startedAt?: number;
  turnId?: string;
  detail?: string;
}

export function nextScheduleTime(
  spec: ScheduleSpec,
  after: number,
): number | undefined {
  if (spec.at) {
    const time = Date.parse(spec.at);
    return time > after ? time : undefined;
  }
  return CronExpressionParser.parse(spec.cron!, {
    currentDate: new Date(after),
    tz: spec.timeZone,
  })
    .next()
    .getTime();
}

export function latestScheduleTime(spec: ScheduleSpec, now: number): number {
  if (spec.at) return Date.parse(spec.at);
  return CronExpressionParser.parse(spec.cron!, {
    currentDate: new Date(now + 1),
    tz: spec.timeZone,
  })
    .prev()
    .getTime();
}

export function scheduleTime(
  time: number | undefined,
  timeZone: string,
): string {
  return time === undefined
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone,
        dateStyle: "short",
        timeStyle: "medium",
        hour12: false,
      }).format(time);
}
