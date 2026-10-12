export function withConfiguredFeishuAppId(
  data: unknown,
  configuredFeishuAppId?: string,
): Record<string, unknown> {
  const value = data && typeof data === "object"
    ? data as Record<string, unknown>
    : {};
  if (Object.hasOwn(value, "feishuAppId")) return value;
  return {
    ...value,
    feishuAppId: configuredFeishuAppId ?? null,
  };
}

export function formatServerStatus(data: unknown, language: CliLanguage = cliLanguage): string {
  const value = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const activity = value.activity && typeof value.activity === "object"
    ? value.activity as Record<string, unknown>
    : {};
  const state = value.running === false
    ? cliText("not running", "未运行", language)
    : value.ready === false
      ? cliText("starting (connecting to Lark)", "正在启动（连接飞书中）", language)
      : cliText("running", "运行中", language);
  const safeRestart = value.safeRestartScheduled
    ? cliText(
        `pending (${String(value.safeRestartReason ?? "no reason provided")})`,
        `等待中（${String(value.safeRestartReason ?? "未提供原因")}）`,
        language,
      )
    : cliText("not scheduled", "未计划", language);
  const agents = formatAgentProcesses(value.agents, language);
  return [
    `${cliText("Agent Bot server: ", "Agent Bot 服务：", language)}${state}`,
    `${cliText("Lark App ID: ", "飞书 App ID：", language)}${value.feishuAppId ?? cliText("not configured", "未配置", language)}`,
    `${cliText("PID: ", "PID：", language)}${value.pid ?? "-"}`,
    `${cliText("Started at: ", "启动时间：", language)}${value.startedAt ?? "-"}`,
    `${cliText("Supervisor: ", "Supervisor：", language)}${value.supervised ? cliText("enabled", "已启用", language) : cliText("disabled", "未启用", language)}`,
    ...agents,
    `${cliText("Running tasks: ", "运行中任务：", language)}${activity.runningSessions ?? 0}`,
    ...(activity.activeTerminals ? [`${cliText("Active terminals: ", "活动终端：", language)}${activity.activeTerminals}`] : []),
    `${cliText("Pending final deliveries: ", "待发送最终结果：", language)}${activity.pendingFinalDeliveries ?? 0}`,
    `${cliText("Safe restart: ", "安全重启：", language)}${safeRestart}`,
    "",
  ].join("\n");
}

function formatAgentProcesses(value: unknown, language: CliLanguage): string[] {
  const agents = Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
  if (agents.length === 0) {
    return [`${cliText("Agents: ", "Agent 进程：", language)}-`];
  }
  return [
    cliText("Agents:", "Agent 进程：", language),
    ...agents.map((agent) => {
      const name = typeof agent.name === "string" && agent.name.trim() ? agent.name.trim() : "-";
      const title = typeof agent.title === "string" && agent.title.trim() ? agent.title.trim() : undefined;
      const label = title && title !== name ? `${name} (${title})` : name;
      const pid = typeof agent.pid === "number" && Number.isInteger(agent.pid) && agent.pid > 0
        ? String(agent.pid)
        : "-";
      const version = typeof agent.version === "string" && agent.version.trim()
        ? agent.version.trim()
        : "-";
      return language === "zh"
        ? `  ${label}：PID ${pid}，版本 ${version}`
        : `  ${label}: PID ${pid}, version ${version}`;
    }),
  ];
}
import { cliLanguage, cliText, type CliLanguage } from "./i18n.js";
