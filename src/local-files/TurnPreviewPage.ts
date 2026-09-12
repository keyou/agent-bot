import path from "node:path";
import MarkdownIt from "markdown-it";
import type { ToolState } from "../runtime/types.js";
import type { FileSummary, TurnActivity, TurnViewState, TurnViewStatus } from "../presentation/turnViewTypes.js";
import { displayToolCommand, formatShellCommandForDisplay } from "../feishu/CardRenderer.js";
import { isFileUrl, rewriteMarkdownFileLinks } from "./MarkdownFileLinks.js";

const MARKDOWN = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: false,
});
const validateLink = MARKDOWN.validateLink.bind(MARKDOWN);
MARKDOWN.validateLink = (url) => isFileUrl(url) || validateLink(url);
const defaultLinkOpen = MARKDOWN.renderer.rules.link_open
  ?? ((tokens, index, options, _environment, renderer) => renderer.renderToken(tokens, index, options));
MARKDOWN.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  tokens[index]?.attrSet("target", "_blank");
  tokens[index]?.attrSet("rel", "noreferrer noopener");
  return defaultLinkOpen(tokens, index, options, environment, renderer);
};

export type TurnPreviewLanguage = "zh" | "en";

const PREVIEW_LABELS = {
  zh: {
    live: "实时更新",
    waitingForUpdates: "等待更新",
    unavailable: "暂时不可用",
    reconnecting: "正在重连",
    elapsed: "耗时 ",
    unknown: "未知",
    plan: "计划",
    error: "错误",
    finalAnswer: "最终回答",
    generating: "回答生成中",
    command: "命令",
    result: "结果",
    output: "输出",
    resultError: "结果 / 错误",
    files: "文件",
    startingTime: "开始时间",
    noToolDetails: "没有可显示的工具详情。",
    fileChanges: "文件变更",
    model: "模型",
    tools: "个工具",
    turnTokens: "本轮",
    compactionTokens: "压缩",
    compactionAfterTokens: "压缩后",
    characters: "字符",
    truncated: "较早的活动已被运行时截断；本页展示 Agent Bot 当前保存的完整快照。",
    statuses: {
      starting: "正在启动",
      running: "正在处理",
      tool_running: "正在执行工具",
      waiting_for_approval: "等待确认",
      completed: "已完成",
      cancelled: "已停止",
      failed: "执行失败",
    },
    toolStatuses: { completed: "成功", failed: "失败", running: "进行中" },
    toolImage: "工具图片",
  },
  en: {
    live: "Live updates",
    waitingForUpdates: "Waiting for updates",
    unavailable: "Temporarily unavailable",
    reconnecting: "Reconnecting",
    elapsed: "Duration ",
    unknown: "Unknown",
    plan: "Plan",
    error: "Error",
    finalAnswer: "Final answer",
    generating: "Generating answer",
    command: "Command",
    result: "Result",
    output: "Output",
    resultError: "Result / error",
    files: "Files",
    startingTime: "Start time",
    noToolDetails: "No tool details available.",
    fileChanges: "File changes",
    model: "Model",
    tools: "tools",
    turnTokens: "Turn",
    compactionTokens: "Compaction",
    compactionAfterTokens: "After compaction",
    characters: "characters",
    truncated: "Earlier activities were truncated by the runtime; this page shows the complete snapshot currently saved by Agent Bot.",
    statuses: {
      starting: "Starting",
      running: "Processing",
      tool_running: "Running tool",
      waiting_for_approval: "Waiting for approval",
      completed: "Completed",
      cancelled: "Stopped",
      failed: "Failed",
    },
    toolStatuses: { completed: "Success", failed: "Failed", running: "In progress" },
    toolImage: "Tool image",
  },
} as const;

function previewLabels(language: TurnPreviewLanguage) {
  return PREVIEW_LABELS[language];
}

export function detectTurnPreviewLanguage(
  acceptLanguage: string | string[] | undefined,
): TurnPreviewLanguage {
  const value = Array.isArray(acceptLanguage) ? acceptLanguage.join(",") : acceptLanguage;
  if (!value?.trim()) return "zh";
  const candidates = value.split(",")
    .map((item, index) => {
      const [tag, ...parameters] = item.trim().split(";");
      const quality = Number(parameters.find((parameter) => parameter.trim().startsWith("q="))?.trim().slice(2) ?? "1");
      return { tag: tag?.trim() ?? "", quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((item) => item.tag && item.quality > 0)
    .sort((left, right) => right.quality - left.quality || left.index - right.index);
  return /^zh(?:[-_]|$)/iu.test(candidates[0]?.tag ?? "") ? "zh" : "en";
}

export const TURN_PREVIEW_CLIENT_SCRIPT = `(() => {
  const eventsUrl = document.body.dataset.eventsUrl;
  const content = document.getElementById("turn-content");
  const metadata = document.getElementById("turn-metadata");
  const status = document.getElementById("turn-status");
  const live = document.getElementById("turn-live");
  if (!eventsUrl || !content || !metadata || !status || !live || typeof EventSource !== "function") return;

  const isChinese = /^zh/i.test(document.documentElement.lang);
  const labels = {
    elapsed: isChinese ? "耗时 " : "Duration ",
    live: isChinese ? "实时更新" : "Live updates",
    waitingForUpdates: isChinese ? "等待更新" : "Waiting for updates",
    unavailable: isChinese ? "暂时不可用" : "Temporarily unavailable",
    reconnecting: isChinese ? "正在重连" : "Reconnecting",
  };

  let source;
  const updateElapsed = () => {
    document.querySelectorAll("[data-live-elapsed]").forEach((element) => {
      const startedAt = Number(element.dataset.startedAt);
      const completedAt = Number(element.dataset.completedAt) || Date.now();
      if (!Number.isFinite(startedAt)) return;
      const seconds = Math.max(0, Math.floor((completedAt - startedAt) / 1000));
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const remainder = seconds % 60;
      element.textContent = hours > 0
        ? String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(remainder).padStart(2, "0")
        : String(minutes).padStart(2, "0") + ":" + String(remainder).padStart(2, "0");
    });
    document.querySelectorAll("[data-live-tool-duration]").forEach((element) => {
      const startedAt = Number(element.dataset.startedAt);
      const completedAt = Number(element.dataset.completedAt) || Date.now();
      if (!Number.isFinite(startedAt)) return;
      const seconds = Math.max(0, Math.floor((completedAt - startedAt) / 1000));
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const remainder = seconds % 60;
      const duration = hours > 0
        ? String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(remainder).padStart(2, "0")
        : String(minutes).padStart(2, "0") + ":" + String(remainder).padStart(2, "0");
      element.textContent = labels.elapsed + duration;
    });
  };
  updateElapsed();
  setInterval(updateElapsed, 1000);

  const replaceSnapshot = (update) => {
    const disclosures = new Map(Array.from(content.querySelectorAll("details[data-activity-id]"), (item) => [item.dataset.activityId, item.open]));
    const scrollPositions = new Map(Array.from(content.querySelectorAll("[data-scroll-id]"), (item) => [item.dataset.scrollId, [item.scrollLeft, item.scrollTop]]));
    const top = window.scrollY;
    const maxTop = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const atBottom = maxTop - top <= 32;
    content.innerHTML = update.content;
    metadata.innerHTML = update.metadata;
    status.textContent = update.statusLabel;
    status.className = "status " + update.status;
    for (const item of content.querySelectorAll("details[data-activity-id]")) {
      if (disclosures.has(item.dataset.activityId)) item.open = disclosures.get(item.dataset.activityId);
    }
    for (const item of content.querySelectorAll("[data-scroll-id]")) {
      const position = scrollPositions.get(item.dataset.scrollId);
      if (position) { item.scrollLeft = position[0]; item.scrollTop = position[1]; }
    }
    updateElapsed();
    requestAnimationFrame(() => {
      const nextMaxTop = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo(0, atBottom ? nextMaxTop : Math.min(top, nextMaxTop));
    });
  };

  source = new EventSource(eventsUrl);
  source.addEventListener("update", (event) => {
    try {
      const update = JSON.parse(event.data);
      if (typeof update.content !== "string" || typeof update.metadata !== "string") return;
      replaceSnapshot(update);
      live.textContent = update.terminal ? "" : labels.live;
      live.className = update.terminal ? "live terminal" : "live connected";
      if (update.terminal) source.close();
    } catch {
      live.textContent = labels.waitingForUpdates;
      live.className = "live";
    }
  });
  source.addEventListener("unavailable", () => {
    live.textContent = labels.unavailable;
    live.className = "live disconnected";
  });
  source.onerror = () => {
    live.textContent = labels.reconnecting;
    live.className = "live disconnected";
  };
  window.addEventListener("pagehide", () => source.close(), { once: true });
})();
`;

export interface TurnPreviewSnapshot {
  content: string;
  metadata: string;
  status: TurnViewStatus;
  statusLabel: string;
  terminal: boolean;
}

export function isTurnPreviewState(value: unknown): value is TurnViewState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<TurnViewState>;
  return typeof state.sessionId === "string"
    && typeof state.turnId === "string"
    && typeof state.startedAt === "number"
    && typeof state.status === "string"
    && Array.isArray(state.plan)
    && Array.isArray(state.completedTools)
    && Array.isArray(state.failedTools)
    && Array.isArray(state.fileSummary);
}

export function renderTurnPreviewPage(input: {
  state: TurnViewState;
  eventsUrl: string;
  scriptPath: string;
  localFileUrl?: (filePath: string) => string | undefined;
  language?: TurnPreviewLanguage;
}): string {
  const language = input.language ?? "zh";
  const snapshot = renderTurnPreviewSnapshot(input.state, input.localFileUrl, language);
  const title = previewTitle(input.state);
  return `<!doctype html>
<html lang="${language === "zh" ? "zh-CN" : "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Agent Bot</title>
  <style>${TURN_PREVIEW_CSS}</style>
</head>
<body data-events-url="${escapeAttribute(input.eventsUrl)}">
  <header class="page-header">
    <div class="header-inner">
      <div class="header-top">
        <h1 title="Turn ${escapeAttribute(input.state.turnId)}">Turn Preview</h1>
        <span id="turn-status" class="status ${snapshot.status}" role="status">${escapeHtml(snapshot.statusLabel)}</span>
        <span id="turn-live" class="live ${snapshot.terminal ? "terminal" : "connected"}" role="status">${snapshot.terminal ? "" : escapeHtml(previewLabels(language).live)}</span>
      </div>
      <div id="turn-metadata" class="metadata">${snapshot.metadata}</div>
    </div>
  </header>
  <main id="turn-content">${snapshot.content}</main>
  <script src="${escapeAttribute(input.scriptPath)}" defer></script>
</body>
</html>`;
}

export function renderTurnPreviewSnapshot(
  state: TurnViewState,
  localFileUrl?: (filePath: string) => string | undefined,
  language: TurnPreviewLanguage = "zh",
): TurnPreviewSnapshot {
  const labels = previewLabels(language);
  const resolveFileUrl = localFileUrl ? (filePath: string): string | undefined => {
    if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) return localFileUrl(filePath);
    if (!state.projectCwd || !path.isAbsolute(state.projectCwd)) return undefined;
    return localFileUrl(path.resolve(state.projectCwd, filePath));
  } : undefined;
  const renderText = (value: string): string => renderMarkdown(value, state.projectCwd, localFileUrl);
  const timeline = renderTimeline(state.activities ?? [], renderText, resolveFileUrl, state.fullToolOutputs, state.fullToolErrors, language);
  const sections = [
    state.prompt ? renderMessageActivity("prompt", state.prompt, "user prompt", renderText) : "",
    state.plan.length > 0 ? renderPlan(state, language) : "",
    state.activitiesTruncated
      ? `<div class="notice">${escapeHtml(labels.truncated)}</div>`
      : "",
    timeline ? `<section class="timeline">${timeline}</section>` : `<div class="empty">${escapeHtml(language === "zh" ? "正在等待 Agent 返回进度…" : "Waiting for Agent progress…")}</div>`,
    state.fileSummary.length > 0 ? renderFileSummary(state, language, resolveFileUrl) : "",
    state.error ? `<section class="result error-result"><h2>${escapeHtml(labels.error)}</h2><pre>${escapeHtml(state.error)}</pre></section>` : "",
    state.finalResponse
      ? `<section class="result final-result"><h2>${escapeHtml(labels.finalAnswer)}</h2><div class="markdown">${renderText(state.finalResponse)}</div></section>`
      : state.assistantText
        ? `<section class="result"><h2>${escapeHtml(labels.generating)}</h2><div class="markdown">${renderText(state.assistantText)}</div></section>`
        : "",
  ].filter(Boolean).join("");
  const terminal = isTerminal(state.status);
  return {
    content: sections,
    metadata: renderMetadata(state, language),
    status: state.status,
    statusLabel: statusLabel(state.status, language),
    terminal,
  };
}

function renderPlan(state: TurnViewState, language: TurnPreviewLanguage): string {
  const labels = previewLabels(language);
  const completed = state.plan.filter((step) => step.status === "completed").length;
  const items = state.plan.map((step) => {
    const marker = step.status === "completed" ? "✓" : step.status === "in_progress" ? "↻" : "○";
    return `<li class="${step.status}"><span>${marker}</span><span>${escapeHtml(step.text)}</span></li>`;
  }).join("");
  return `<section class="plan"><h2>${escapeHtml(labels.plan)} <span>${completed}/${state.plan.length}</span></h2><ol>${items}</ol></section>`;
}

function renderTimeline(
  activities: TurnActivity[],
  renderText: (value: string) => string,
  localFileUrl?: (filePath: string) => string | undefined,
  fullToolOutputs?: Record<string, string>,
  fullToolErrors?: Record<string, string>,
  language: TurnPreviewLanguage = "zh",
): string {
  return activities
    .filter((activity): activity is Exclude<TurnActivity, { kind: "reasoning" }> => activity.kind !== "reasoning")
    .map((activity) => renderActivity(activity, renderText, localFileUrl, fullToolOutputs, fullToolErrors, language))
    .join("");
}

function renderActivity(
  activity: Exclude<TurnActivity, { kind: "reasoning" }>,
  renderText: (value: string) => string,
  localFileUrl?: (filePath: string) => string | undefined,
  fullToolOutputs?: Record<string, string>,
  fullToolErrors?: Record<string, string>,
  language: TurnPreviewLanguage = "zh",
): string {
  switch (activity.kind) {
    case "assistant":
      return renderMessageActivity(activity.id, activity.text, "commentary", renderText);
    case "user":
      return renderMessageActivity(activity.id, activity.text, "user", renderText);
    case "tool":
      return renderToolActivity(activity.id, activity.tool, localFileUrl, fullToolOutputs, fullToolErrors, language);
  }
}

function renderMessageActivity(id: string, text: string, kind: string, renderText: (value: string) => string): string {
  return `<article class="activity message ${kind}" data-activity="${escapeAttribute(id)}"><div class="markdown">${renderText(text)}</div></article>`;
}

function renderToolActivity(
  activityId: string,
  tool: ToolState,
  localFileUrl?: (filePath: string) => string | undefined,
  fullToolOutputs?: Record<string, string>,
  fullToolErrors?: Record<string, string>,
  language: TurnPreviewLanguage = "zh",
): string {
  const labels = previewLabels(language);
  const command = tool.command ? (displayToolCommand(tool.command) || tool.command.trim()) : undefined;
  const repl = isReplTool(tool);
  const displayCommand = repl
    ? formatReplCommand(command ?? "")
    : command
      ? formatToolCommand(command)
      : undefined;
  const commandInHeader = Boolean(displayCommand);
  const title = commandInHeader ? displayCommand! : toolTitle(tool, command, repl, language);
  const output = fullToolOutputs?.[tool.id] ?? tool.output;
  const error = fullToolErrors?.[tool.id] ?? tool.error;
  const sameError = Boolean(output && error && normalizeOutput(output) === normalizeOutput(error));
  const detailParts = [
    displayCommand && !commandInHeader ? `<pre class="command-block${repl ? " repl-code" : ""}" data-scroll-id="${escapeAttribute(`${activityId}:command`)}">${escapeHtml(displayCommand)}</pre>` : "",
    output
      ? renderToolOutput(activityId, "output", sameError ? labels.resultError : repl ? labels.result : labels.output, output, sameError, repl, language, tool)
      : "",
    error && !sameError
      ? renderToolOutput(activityId, "error", labels.error, error, true, repl, language, tool)
      : "",
    !output && !error && !tool.files?.length ? renderToolStatusRow(tool, language) : "",
    renderToolImage(tool, localFileUrl, language),
    tool.files?.length
      ? `<details class="tool-output" data-activity-id="${escapeAttribute(`${activityId}:files`)}"><summary><span class="tool-output-label">${escapeHtml(labels.files)}</span><span class="tool-output-meta">${renderToolTiming(tool, language)}<span class="tool-state ${tool.status}" aria-label="${escapeAttribute(tool.status)}">${toolStatusIcon(tool.status, language)}</span><span>${tool.files.length}</span></span></summary><ul class="files">${tool.files.map((file) => renderFileEntry(file, localFileUrl)).join("")}</ul></details>`
      : "",
  ].filter(Boolean).join("");
  const titleMarkup = commandInHeader
    ? `<code class="tool-command-title">${escapeHtml(title)}</code>`
    : `<span class="tool-title">${escapeHtml(title)}</span>`;
  return `<article class="activity tool"><section class="tool-step" data-activity-id="${escapeAttribute(activityId)}"><div class="tool-header" data-scroll-id="${escapeAttribute(`${activityId}:command`)}">${titleMarkup}</div><div class="tool-body">${detailParts || `<div class="muted">${escapeHtml(labels.noToolDetails)}</div>`}</div></section></article>`;
}

function toolTitle(tool: ToolState, command?: string, repl = false, language: TurnPreviewLanguage = "zh"): string {
  if (repl) return "REPL";
  if (command) return tool.kind === "command" ? previewLabels(language).command : tool.kind;
  const title = tool.title.trim();
  return title || tool.kind;
}

function isReplTool(tool: ToolState): boolean {
  const title = tool.title.trim();
  const titleLooksLikeToolName = title.length <= 120 && !/[\s"'`]/u.test(title);
  return tool.kind.toLowerCase().includes("repl")
    || (titleLooksLikeToolName && /(?:^|[._-])repl(?:$|[._-])/iu.test(title));
}

function formatReplCommand(command: string): string {
  const normalized = command.trim();
  const newline = normalized.indexOf("\n");
  if (newline >= 0) {
    const payload = normalized.slice(newline + 1).trim();
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed && typeof parsed === "object") {
        for (const key of ["input", "code", "script", "javascript", "source"]) {
          const value = (parsed as Record<string, unknown>)[key];
          if (typeof value === "string" && value.trim()) return formatReplSource(value);
        }
      }
    } catch {
      // Keep the original payload when a provider uses a non-JSON argument format.
    }
  }
  return formatReplSource(newline >= 0 ? normalized.slice(0, newline) : normalized);
}

function formatToolCommand(command: string): string {
  const normalized = command.replace(/\r\n?/gu, "\n").trim();
  const newline = normalized.indexOf("\n");
  if (newline >= 0) {
    const name = normalized.slice(0, newline).trim();
    const payload = normalized.slice(newline + 1).trim();
    const formattedPayload = formatJsonPayload(payload);
    if (name && formattedPayload) return `${name}\n${formattedPayload}`;
  }
  return formatShellCommandForDisplay(normalized);
}

function formatJsonPayload(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object") return JSON.stringify(parsed, null, 2);
  } catch {
    // Keep non-JSON tool arguments in their original readable form.
  }
  return undefined;
}

function formatReplSource(source: string): string {
  const normalized = source.replace(/\r\n?/gu, "\n").trim();
  if (normalized.includes("\n")) return normalized;
  const lines: string[] = [];
  let current = "";
  let quote: "'" | "\"" | "`" | undefined;
  let escaped = false;
  for (const character of normalized) {
    current += character;
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quote) { escaped = true; continue; }
    if (quote) { if (character === quote) quote = undefined; continue; }
    if (character === "'" || character === "\"" || character === "`") { quote = character; continue; }
    if (character === ";") {
      lines.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines.join("\n");
}

function normalizeOutput(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function formatReplOutput(value: string): string {
  const normalized = normalizeOutput(value);
  if (!normalized) return normalized;
  try {
    const parsed: unknown = JSON.parse(normalized);
    const text = extractReplOutputText(parsed);
    if (text) return text;
  } catch {
    // REPL providers may return plain text instead of JSON.
  }
  return normalizeReplText(normalized);
}

function extractReplOutputText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const content = record.content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((item): string[] => {
    if (!item || typeof item !== "object") return [];
    const text = (item as Record<string, unknown>).text;
    return typeof text === "string" && text.trim() ? [normalizeReplText(text)] : [];
  });
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

function normalizeReplText(value: string): string {
  return value
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r")
    .replace(/\r\n?/gu, "\n")
    .trim();
}

function renderToolOutput(
  activityId: string,
  kind: string,
  label: string,
  value: string,
  error = false,
  repl = false,
  language: TurnPreviewLanguage = "zh",
  tool?: ToolState,
): string {
  const id = escapeAttribute(`${activityId}:${kind}`);
  const displayValue = repl && !error ? formatReplOutput(value) : value;
  const labels = previewLabels(language);
  const status = tool?.status ?? "completed";
  const timing = tool ? renderToolTiming(tool, language) : "";
  return `<details class="tool-output${error ? " error-output" : ""}${repl ? " repl-result" : ""}" data-activity-id="${id}"><summary><span class="tool-output-label">${escapeHtml(label)}</span><span class="tool-output-meta">${timing}<span class="tool-state ${status}" aria-label="${escapeAttribute(status)}">${toolStatusIcon(status, language)}</span><span>${formatNumber(displayValue.length)} ${escapeHtml(labels.characters)}</span></span></summary><pre data-scroll-id="${id}">${escapeHtml(displayValue)}</pre></details>`;
}

function renderToolStatusRow(tool: ToolState, language: TurnPreviewLanguage): string {
  const timing = renderToolTiming(tool, language);
  return `<div class="tool-status-row"><span class="tool-output-meta">${timing}<span class="tool-state ${tool.status}" aria-label="${escapeAttribute(tool.status)}">${toolStatusIcon(tool.status, language)}</span></span></div>`;
}

function renderToolTiming(tool: ToolState, language: TurnPreviewLanguage): string {
  const labels = previewLabels(language);
  const start = tool.startedAt === undefined ? labels.unknown : formatTimestamp(tool.startedAt);
  const duration = toolDuration(tool);
  const liveDuration = duration === undefined
    ? `<span>${escapeHtml(labels.elapsed.trim())}${language === "zh" ? "" : " "}${escapeHtml(labels.unknown)}</span>`
    : `<span${tool.status === "running" && tool.completedAt === undefined ? ` data-live-tool-duration data-started-at="${tool.startedAt}"` : ""}>${escapeHtml(labels.elapsed)}${escapeHtml(duration)}</span>`;
  return `<span title="${escapeAttribute(labels.startingTime)}">${escapeHtml(start)}</span>${liveDuration}`;
}

function renderToolImage(
  tool: ToolState,
  localFileUrl?: (filePath: string) => string | undefined,
  language: TurnPreviewLanguage = "zh",
): string {
  if (!tool.imagePath || !localFileUrl) return "";
  const viewerUrl = localFileUrl(tool.imagePath);
  if (!viewerUrl) return "";
  try {
    const rawUrl = new URL(viewerUrl);
    rawUrl.searchParams.set("raw", "1");
    return `<div class="tool-image"><img src="${escapeAttribute(rawUrl.toString())}" alt="${escapeAttribute(tool.title || previewLabels(language).toolImage)}"></div>`;
  } catch {
    return "";
  }
}

function renderFileSummary(
  state: TurnViewState,
  language: TurnPreviewLanguage,
  localFileUrl?: (filePath: string) => string | undefined,
): string {
  const labels = previewLabels(language);
  const files = state.fileSummary.map((file) => renderFileEntry(file, localFileUrl)).join("");
  return `<section class="files-summary"><h2>${escapeHtml(labels.fileChanges)} <span>${state.fileSummary.length}</span></h2><ul class="files">${files}</ul></section>`;
}

function renderFileEntry(file: FileSummary, localFileUrl?: (filePath: string) => string | undefined): string {
  const label = `<code>${escapeHtml(file.path)}</code>`;
  const url = localFileUrl?.(file.path);
  const link = url
    ? `<a class="file-link" href="${escapeAttribute(url)}" target="_blank" rel="noreferrer noopener">${label}</a>`
    : label;
  return `<li>${link}${fileDelta(file)}</li>`;
}

function fileDelta(file: { additions?: number; deletions?: number }): string {
  const additions = file.additions ? `<span class="additions">+${file.additions}</span>` : "";
  const deletions = file.deletions ? `<span class="deletions">-${file.deletions}</span>` : "";
  return additions || deletions ? `<span class="file-delta">${additions}${deletions}</span>` : "";
}

function renderMetadata(state: TurnViewState, language: TurnPreviewLanguage): string {
  const labels = previewLabels(language);
  const completedAt = state.completedAt ?? (isTerminal(state.status) && state.durationMs !== undefined
    ? state.startedAt + state.durationMs
    : undefined);
  const elapsed = `<span>${escapeHtml(labels.elapsed)}<strong${isTerminal(state.status) ? "" : ` data-live-elapsed data-started-at="${state.startedAt}"`}>${completedAt === undefined && isTerminal(state.status) ? escapeHtml(labels.unknown) : formatDuration((completedAt ?? Date.now()) - state.startedAt)}</strong></span>`;
  return [
    elapsed,
    state.model?.trim() ? `<span title="${escapeAttribute(labels.model)}">${escapeHtml(state.model.trim())}</span>` : "",
    state.totalTokens === undefined ? "" : `<span title="${escapeAttribute(labels.turnTokens)}">${formatTokenCount(state.totalTokens)} tokens</span>`,
    state.contextCompactionAfterTokens === undefined ? "" : state.contextCompactionBeforeTokens === undefined
      ? `<span title="${escapeAttribute(labels.compactionAfterTokens)}">${formatTokenCount(state.contextCompactionAfterTokens)} tokens</span>`
      : `<span title="${escapeAttribute(labels.compactionTokens)}">${formatTokenCount(state.contextCompactionBeforeTokens)} → ${formatTokenCount(state.contextCompactionAfterTokens)} tokens</span>`,
    (state.totalToolCount ?? 0) > 0 ? `<span>${formatNumber(state.totalToolCount ?? 0)} ${escapeHtml(labels.tools)}</span>` : "",
  ].filter(Boolean).join("");
}

function previewTitle(state: TurnViewState): string {
  const value = (state.prompt ?? state.taskTitle ?? "Turn Preview").replace(/\s+/gu, " ").trim();
  return value.length > 80 ? `${value.slice(0, 79)}…` : value;
}

function renderMarkdown(value: string, projectCwd?: string, localFileUrl?: (filePath: string) => string | undefined): string {
  const environment = {};
  const tokens = MARKDOWN.parse(value, environment);
  // Only the directory is used to resolve relative links; no Markdown file is created.
  const markdownPath = projectCwd && path.isAbsolute(projectCwd) ? path.join(projectCwd, "turn.md") : undefined;
  rewriteMarkdownFileLinks(tokens, markdownPath, (filePath) => {
    const url = localFileUrl?.(filePath);
    return url ? new URL(url) : undefined;
  });
  return MARKDOWN.renderer.render(tokens, MARKDOWN.options, environment);
}

function statusLabel(status: TurnViewStatus, language: TurnPreviewLanguage): string {
  return previewLabels(language).statuses[status];
}

function toolStatusIcon(status: ToolState["status"], language: TurnPreviewLanguage): string {
  return status === "completed"
    ? previewLabels(language).toolStatuses.completed
    : status === "failed"
      ? previewLabels(language).toolStatuses.failed
      : previewLabels(language).toolStatuses.running;
}

function toolDuration(tool: ToolState): string | undefined {
  if (tool.startedAt === undefined) return undefined;
  const end = tool.completedAt ?? (tool.status === "running" ? Date.now() : undefined);
  return end === undefined ? undefined : formatDuration(end - tool.startedAt);
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function formatTimestamp(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestampMs));
}

function formatNumber(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString("en-US");
}

function formatTokenCount(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  });
}

function isTerminal(status: TurnViewStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

const TURN_PREVIEW_CSS = `
:root { color-scheme: light dark; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; --page: #fff; --surface: #f5f6f7; --code: #fafafa; --text: #25272b; --muted: #62666d; --line: #e0e2e5; --accent: #245bc0; --success: #257449; --danger: #b52c34; --scrollbar-thumb: #d4d7dc; --scrollbar-thumb-hover: #afb4bc; }
* { box-sizing: border-box; letter-spacing: 0; }
body { margin: 0; background: var(--page); color: var(--text); font-size: 13px; line-height: 1.55; }
.page-header { position: sticky; top: 0; z-index: 3; background: var(--page); border-bottom: 1px solid var(--line); }
.header-inner { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 12px; max-width: 1320px; margin: auto; padding: 6px 20px; }
.header-top { display: flex; flex-wrap: wrap; align-items: center; min-width: 0; max-width: 100%; gap: 2px 8px; }
h1 { flex: none; margin: 0; font-size: 14px; line-height: 20px; font-weight: 650; }
h2 { margin: 0 0 8px; font-size: 13px; font-weight: 650; }
h2 span { margin-left: 6px; color: var(--muted); font-size: 12px; font-weight: 400; }
.status, .live { flex: none; font-size: 12px; white-space: nowrap; }
.status { display: inline-flex; align-items: center; gap: 8px; }
.status::before { content: "·"; color: var(--muted); }
.status.starting, .status.running, .status.tool_running, .tool-state.running { color: var(--accent); }
.status.waiting_for_approval { color: #926a08; }
.status.completed, .tool-state.completed { color: var(--success); }
.status.cancelled { color: var(--muted); }
.status.failed, .tool-state.failed { color: var(--danger); }
.live { display: flex; align-items: center; gap: 5px; margin-left: auto; color: var(--muted); }
.live::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.live.connected::before { background: var(--success); }
.live.disconnected { color: var(--danger); }
.live.terminal { display: none; }
.metadata { display: flex; flex: 1 1 360px; flex-wrap: wrap; position: relative; min-width: 0; gap: 2px 8px; padding-left: 12px; color: var(--muted); font-size: 12px; line-height: 1.4; }
.metadata::before { content: "·"; position: absolute; left: 0; top: 0; }
.metadata > span { position: relative; min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.metadata > span + span { padding-left: 12px; }
.metadata > span + span::before { content: "·"; position: absolute; left: 0; top: 0; }
.metadata strong { color: var(--text); font-weight: 500; font-variant-numeric: tabular-nums; }
main { max-width: 1320px; margin: 0 auto; padding: 0 20px 40px; }
.plan, .files-summary, .result { padding: 14px 0; border-bottom: 1px solid var(--line); }
.plan ol { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.plan li { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 6px; overflow-wrap: anywhere; }
.plan li.completed { color: var(--muted); }
.plan li.in_progress { color: var(--accent); }
.timeline { padding-top: 2px; }
.activity { min-width: 0; }
.message { padding: 12px 0; border-bottom: 1px solid var(--line); }
.markdown { min-width: 0; overflow-wrap: anywhere; }
.message > .markdown, .result > .markdown { font-size: 14px; font-weight: 400; }
.markdown > :first-child { margin-top: 0; }
.markdown > :last-child { margin-bottom: 0; }
.markdown p, .markdown ul, .markdown ol, .markdown pre, .markdown blockquote { margin: 0 0 6px; }
.markdown ul, .markdown ol { padding-left: 1.5em; }
.markdown h1, .markdown h2, .markdown h3 { margin: 12px 0 6px; font-size: 14px; }
.markdown blockquote { padding-left: 10px; border-left: 2px solid var(--line); color: var(--muted); }
.markdown a { color: var(--accent); text-underline-offset: 2px; }
.markdown table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
.markdown th, .markdown td { padding: 5px 8px; border: 1px solid var(--line); }
.markdown img { max-width: 100%; height: auto; }
code { padding: 1px 3px; border-radius: 3px; background: var(--surface); font: 12px/1.55 "Cascadia Mono", "SFMono-Regular", Consolas, monospace; overflow-wrap: anywhere; }
pre { max-width: 100%; max-height: 480px; margin: 0; padding: 9px 12px; overflow: auto; background: var(--code); color: var(--text); font: 12px/1.55 "Cascadia Mono", "SFMono-Regular", Consolas, monospace; tab-size: 2; white-space: pre; }
.markdown pre code { padding: 0; background: transparent; color: inherit; }
details { min-width: 0; }
summary { display: flex; align-items: center; gap: 8px; min-height: 32px; cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary::before { content: ""; flex: none; width: 6px; height: 6px; margin: 0 3px 0 1px; border-right: 1.5px solid var(--muted); border-bottom: 1.5px solid var(--muted); transform: rotate(-45deg); }
details[open] > summary::before { transform: rotate(45deg); }
summary:hover { background: transparent; }
summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.tool { margin: 8px 0; }
.tool-step { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: transparent; }
.tool-header { display: flex; align-items: flex-start; gap: 8px; min-height: 32px; max-height: calc(15 * 12px * 1.55 + 14px); padding: 7px 10px; overflow: auto; background: transparent; font-weight: 400; }
.tool-header, .tool-body pre { --tool-scrollbar-thumb: var(--scrollbar-thumb); scrollbar-width: thin; scrollbar-color: var(--tool-scrollbar-thumb) transparent; }
@media (hover: hover) and (pointer: fine) {
  .tool-header, .tool-body pre { --tool-scrollbar-thumb: transparent; }
  .tool-header:is(:hover, :focus-visible, :focus-within),
  .tool-body pre:is(:hover, :focus-visible, :focus-within) { --tool-scrollbar-thumb: var(--scrollbar-thumb); }
}
@supports selector(::-webkit-scrollbar) {
  .tool-header, .tool-body pre { scrollbar-width: auto; scrollbar-color: auto; }
  :is(.tool-header, .tool-body pre)::-webkit-scrollbar { width: 6px; height: 6px; }
  :is(.tool-header, .tool-body pre)::-webkit-scrollbar-track,
  :is(.tool-header, .tool-body pre)::-webkit-scrollbar-corner { background: transparent; }
  :is(.tool-header, .tool-body pre)::-webkit-scrollbar-thumb { background: var(--tool-scrollbar-thumb); border-radius: 3px; }
  :is(.tool-header, .tool-body pre)::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-thumb-hover); }
  :is(.tool-header, .tool-body pre)::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
.tool-state { display: inline-flex; flex: none; align-items: center; justify-content: center; color: var(--muted); font-size: 11px; font-weight: 650; white-space: nowrap; }
.tool-state.completed { color: var(--success); }
.tool-state.running { color: var(--accent); }
.tool-state.failed { color: var(--danger); }
.tool-title { min-width: 0; flex: 1 0 auto; overflow-wrap: normal; font-size: 12px; font-weight: 400; line-height: 1.45; white-space: pre; }
.tool-command-title { display: block; min-width: 0; flex: 1 0 auto; margin: 0; padding: 0; overflow-wrap: normal; background: transparent; color: var(--text); font: 12px/1.55 "Cascadia Mono", "SFMono-Regular", Consolas, monospace; font-weight: 400; white-space: pre; }
.tool-meta { display: flex; flex: 0 1 auto; flex-wrap: nowrap; gap: 12px; max-width: 48%; overflow: hidden; color: var(--muted); font-size: 11px; font-weight: 400; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tool-meta span { white-space: nowrap; }
.tool-body { border-top: 1px solid var(--line); }
.tool-body > .muted { padding: 8px 12px; }
.tool-output { border-top: 1px solid var(--line); }
.tool-output:first-child { border-top: 0; }
.tool-output > summary { padding: 4px 12px; background: transparent; color: var(--muted); font-size: 12px; }
.tool-output-label { min-width: 0; }
.tool-output-meta { display: inline-flex; align-items: center; gap: 12px; margin-left: auto; font-size: 11px; }
.tool-status-row { display: flex; justify-content: flex-end; padding: 5px 12px; border-top: 1px solid var(--line); }
.tool-output > pre { max-height: none; border-top: 1px solid var(--line); background: transparent; }
.repl-code { background: transparent; }
.repl-result > pre { white-space: pre; overflow-wrap: normal; background: transparent; }
.error-output > summary, .error-result h2 { color: var(--danger); }
.muted, .empty { color: var(--muted); }
.notice, .empty { padding: 10px 0; border-bottom: 1px solid var(--line); }
.notice { color: #926a08; }
.files { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.tool-output .files { padding: 8px 12px; }
.files li { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.files code { min-width: 0; }
.files .file-link { min-width: 0; color: var(--accent); text-underline-offset: 2px; }
.files .file-link code { color: inherit; }
.additions { color: var(--success); }
.deletions { color: var(--danger); }
.file-delta { display: inline-flex; flex: none; gap: 6px; font: 12px "Cascadia Mono", Consolas, monospace; }
.tool-image { padding: 8px 12px; border-top: 1px solid var(--line); }
.tool-image img { display: block; max-width: 100%; max-height: 720px; }
.final-result h2 { color: var(--success); }
@media (max-width: 700px) {
  .header-inner { padding: 5px 12px; }
  .header-top { flex-basis: 100%; }
  .metadata { flex-basis: 100%; padding-left: 0; font-size: 11px; }
  .metadata::before { display: none; }
  .live { font-size: 11px; }
  main { padding: 0 12px 28px; }
  .message { padding: 10px 0; }
  .tool-header { gap: 6px; padding: 7px 9px; }
  .tool-state { font-size: 11px; }
  .tool-meta { flex: 0 1 auto; gap: 10px; max-width: 50%; font-size: 11px; }
  .tool-output > summary { min-height: 40px; padding: 6px 10px; }
  .tool-output-meta { gap: 10px; }
  pre { padding: 8px 10px; }
}
@media (prefers-color-scheme: dark) {
  :root { --page: #18191b; --surface: #232427; --code: #1d1e20; --text: #e0e1e4; --muted: #a0a3ab; --line: #35373c; --accent: #8aaff7; --success: #83c69c; --danger: #f58c94; --scrollbar-thumb: #45494f; --scrollbar-thumb-hover: #60666e; }
  .notice, .status.waiting_for_approval { color: #e1bc6f; }
}
`;
