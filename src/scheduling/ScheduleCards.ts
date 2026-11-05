import type { ScheduledJob, ScheduledRun } from "./types.js";
import { scheduleTime, nextScheduleTime } from "./types.js";

const labels: Record<string, string> = {
  draft: "待确认",
  enabled: "已启用",
  paused: "已暂停",
  completed: "已完成",
  deleted: "已删除",
  queued: "排队中",
  dispatching: "准备中",
  submitting: "提交中",
  running: "运行中",
  failed: "失败",
  cancelled: "已取消",
  expired: "已过期",
  skipped: "已跳过",
  unknown: "待核实",
};
const md = (content: string) => ({ tag: "markdown", content });
const planStatus = (job: ScheduledJob) =>
  job.status === "completed" ? "已触发" : labels[job.status];
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const card = (title: string, elements: unknown[]) => ({
  schema: "2.0",
  config: { update_multi: true, width_mode: "fill" },
  header: { template: "blue", title: { tag: "plain_text", content: title } },
  body: { elements },
});
const action = (
  text: string,
  value: Record<string, string>,
  type = "default",
) => ({
  tag: "button",
  type,
  text: { tag: "plain_text", content: text },
  value,
});
const row = (elements: unknown[]) => ({
  tag: "column_set",
  flex_mode: "flow",
  columns: elements.map((element) => ({
    tag: "column",
    width: "auto",
    elements: [element],
  })),
});
const navigationLink = (text: string, value: Record<string, string>) => ({
  tag: "interactive_container",
  margin: "0px",
  padding: "4px 0px",
  has_border: false,
  elements: [
    {
      ...md(`<font color='blue'>${text}</font>`),
      text_size: "notation",
    },
  ],
  behaviors: [{ type: "callback", value }],
});

export function renderScheduleList(
  jobs: ScheduledJob[],
  contextKey: string,
  page: number,
): Record<string, unknown> {
  const elements: unknown[] = jobs.length ? [] : [md("暂无定时任务")];
  for (const job of jobs.slice(0, 10)) {
    elements.push(
      md(
        `**${escape(job.spec.name)}** · ${planStatus(job)}\n${job.id}\n${escape(job.spec.cron ?? job.spec.at!)} · ${escape(job.spec.timeZone)}\n下次：${scheduleTime(job.nextRunAt, job.spec.timeZone)}`,
      ),
      row([
        action("查看", {
          action: "schedule_show",
          scheduleId: job.id,
          contextKey,
        }),
      ]),
      { tag: "hr" },
    );
  }
  elements.push(
    row([
      action("新建", { action: "schedule_new", contextKey }),
      ...(page > 0
        ? [
            action("上一页", {
              action: "schedule_list",
              contextKey,
              page: String(page - 1),
            }),
          ]
        : []),
      ...(jobs.length > 10
        ? [
            action("下一页", {
              action: "schedule_list",
              contextKey,
              page: String(page + 1),
            }),
          ]
        : []),
      action("刷新", {
        action: "schedule_list",
        contextKey,
        page: String(page),
      }),
    ]),
  );
  return card("定时任务", elements);
}

export function renderSchedule(
  job: ScheduledJob,
  title: string,
  runs: ScheduledRun[],
  history = false,
): Record<string, unknown> {
  const value = {
    scheduleId: job.id,
    revision: String(job.revision),
    contextKey: job.contextKey,
  };
  const button = (text: string, operation: string, type = "default") =>
    action(text, { ...value, action: `schedule_${operation}` }, type);
  const tab = (text: string, operation: string, active: boolean) =>
    active
      ? { ...md(`**${text}**`), text_size: "notation" }
      : navigationLink(text, { ...value, action: `schedule_${operation}` });
  const elements: unknown[] = [
    md(
      `**${escape(job.spec.name)}** · ${planStatus(job)}\n任务：${escape(title)}`,
    ),
    {
      ...row([
        navigationLink("返回列表", {
          action: "schedule_list",
          contextKey: job.contextKey,
        }),
        tab("计划详情", "show", !history),
        tab("执行记录", "history", history),
        navigationLink("刷新", {
          ...value,
          action: history ? "schedule_history" : "schedule_show",
        }),
      ]),
      horizontal_spacing: "12px",
      vertical_align: "center",
    },
    { tag: "hr" },
  ];
  if (!history) {
    const time = job.spec.at
      ? `执行时间：${scheduleTime(Date.parse(job.spec.at), job.spec.timeZone)}`
      : `周期：${escape(job.spec.cron!)}\n下次执行：${scheduleTime(job.nextRunAt ?? (job.status === "draft" ? nextScheduleTime(job.spec, Date.now()) : undefined), job.spec.timeZone)}`;
    elements.push(
      md(`${time}\n时区：${escape(job.spec.timeZone)}`),
      {
        ...md(
          `最晚开始：计划时间后 ${job.spec.maxDelayMinutes} 分钟 · ${job.spec.catchUpMinutes ? `错过 ${job.spec.catchUpMinutes} 分钟内补跑最近一次` : "错过不补跑"}`,
        ),
        text_size: "notation",
      },
      md(`**Prompt**\n${escape(job.spec.prompt)}`),
    );
  }
  if (job.notice) elements.push(md(escape(job.notice)));
  if (!history && runs[0])
    elements.push(
      md(
        `最近运行：${labels[runs[0].status]} · ${scheduleTime(runs[0].scheduledFor, job.spec.timeZone)}`,
      ),
    );
  if (history) {
    elements.push({ ...md("最近 10 次运行"), text_size: "notation" });
    for (const [index, run] of runs.entries()) {
      if (index > 0) elements.push({ tag: "hr" });
      elements.push(
        md(
          `${run.manual ? "手动" : "计划"} ${scheduleTime(run.scheduledFor, job.spec.timeZone)} · ${labels[run.status]}\n实际开始：${scheduleTime(run.startedAt, job.spec.timeZone)}${run.turnId ? `\nTurn：${run.turnId}` : ""}${run.detail ? `\n${escape(run.detail)}` : ""}`,
        ),
      );
      const controls: unknown[] = [];
      if (run.turnId)
        controls.push(
          action("查看运行详情", {
            action: "turn_details",
            turnId: run.turnId,
            contextKey: job.contextKey,
          }),
        );
      if (run.status === "unknown")
        controls.push({
          ...action("已核实结束", {
            ...value,
            action: "schedule_resolve",
            runId: run.id,
          }),
          confirm: {
            title: { tag: "plain_text", content: "确认本次运行已结束？" },
            text: {
              tag: "plain_text",
              content:
                "仅在核实 Agent 已停止或完成后确认。这不会停止 Agent，只会解除后续调度阻塞。",
            },
          },
        });
      if (controls.length) elements.push(row(controls));
    }
    if (!runs.length) elements.push(md("暂无执行记录"));
  }
  if (!history && job.status !== "deleted") {
    elements.push(
      { tag: "hr" },
      row([
        ...(job.status === "draft"
          ? [button("确认启用", "confirm", "primary")]
          : []),
        ...(job.status === "enabled" ? [button("暂停", "pause")] : []),
        ...(job.status === "paused" ? [button("恢复", "resume")] : []),
        ...(["enabled", "paused", "completed"].includes(job.status)
          ? [button("立即执行", "run")]
          : []),
        button("编辑", "edit"),
        {
          ...button("删除", "delete", "danger"),
          confirm: {
            title: { tag: "plain_text", content: "删除定时计划？" },
            text: {
              tag: "plain_text",
              content:
                "取消尚未开始的运行，保留执行记录；不会停止正在执行的任务。",
            },
          },
        },
      ]),
    );
  }
  elements.push({ ...md(`计划 ID：${job.id}`), text_size: "notation" });
  return card("定时任务", elements);
}

export function renderScheduleForm(
  contextKey: string,
  job?: ScheduledJob,
  localSessionId?: string,
): Record<string, unknown> {
  const field = (
    name: string,
    label: string,
    value: string,
    required = false,
    maxLength = 1000,
  ) => ({
    tag: "input",
    name,
    required,
    input_type: "text",
    width: "fill",
    max_length: maxLength,
    label: { tag: "plain_text", content: label },
    default_value: value,
  });
  return card(job ? "编辑定时任务" : "新建定时任务", [
    {
      tag: "form",
      name: "schedule_form",
      elements: [
        field("name", "名称", job?.spec.name ?? "定时任务", true, 120),
        field("prompt", "Prompt", job?.spec.prompt ?? "", true),
        field("cron", "Cron（五段，与执行时间二选一）", job?.spec.cron ?? ""),
        field("at", "执行时间（ISO 格式，含时区）", job?.spec.at ?? ""),
        field(
          "timeZone",
          "时区",
          job?.spec.timeZone ??
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          true,
        ),
        field(
          "maxDelayMinutes",
          "最长等待（分钟）",
          String(job?.spec.maxDelayMinutes ?? 60),
          true,
        ),
        field(
          "catchUpMinutes",
          "错过补跑窗口（分钟，0 为不补跑）",
          String(job?.spec.catchUpMinutes ?? 0),
          true,
        ),
        {
          ...action(
            "保存草稿",
            {
              action: "schedule_submit",
              contextKey,
              ...(job
                ? { scheduleId: job.id, revision: String(job.revision) }
                : { sessionId: localSessionId! }),
            },
            "primary",
          ),
          name: "schedule_submit",
          action_type: "form_submit",
        },
      ],
    },
    row([action("取消", { action: "schedule_list", contextKey })]),
  ]);
}
