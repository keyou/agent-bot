import { createHash } from "node:crypto";
import path from "node:path";
import { enableDiagramFences, DIAGRAM_PREVIEW_CLIENT_SCRIPT, DIAGRAM_PREVIEW_CSS } from "./DiagramPreview.js";
import MarkdownIt from "markdown-it";
import { highlightPreviewCode, PREVIEW_SYNTAX_CSS } from "./PreviewSyntaxHighlight.js";
import type { ApprovalRequest, ToolState } from "../runtime/types.js";
import type { FileSummary, TurnActivity, TurnReasoningItem, TurnViewState, TurnViewStatus } from "../presentation/turnViewTypes.js";
import { displayFilePath, displayToolCommand, formatShellCommandForDisplay, toolStatusIcon } from "../feishu/CardRenderer.js";
import { turnReasoningItems } from "../presentation/turnReasoning.js";
import { isFileUrl, rewriteMarkdownFileLinks } from "./MarkdownFileLinks.js";

const MARKDOWN = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: false,
  highlight: highlightPreviewCode,
});
enableDiagramFences(MARKDOWN);
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
    reasoning: "思考",
    finalAnswer: "最终回答",
    downloadMarkdown: "下载 Markdown",
    copyMarkdown: "复制 Markdown",
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
    modelCalls: "模型调用",
    modelCallsDescription: "本轮有效 Token 用量更新次数",
    contextTokens: "上下文",
    tools: "个工具",
    turnTokens: "本轮",
    totalTokens: "总计",
    nonCachedTokens: "非缓存",
    characters: "字符",
    truncated: "较早的活动已被运行时截断；本页展示 Agent Bot 当前保存的完整快照。",
    statuses: {
      starting: "正在启动",
      running: "正在处理",
      tool_running: "正在处理",
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
    reasoning: "Reasoning",
    finalAnswer: "Final answer",
    downloadMarkdown: "Download Markdown",
    copyMarkdown: "Copy Markdown",
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
    modelCalls: "Model calls",
    modelCallsDescription: "Effective token usage updates in this turn",
    contextTokens: "Context",
    tools: "tools",
    turnTokens: "Turn",
    totalTokens: "Total",
    nonCachedTokens: "Non-cached",
    characters: "characters",
    truncated: "Earlier activities were truncated by the runtime; this page shows the complete snapshot currently saved by Agent Bot.",
    statuses: {
      starting: "Starting",
      running: "Processing",
      tool_running: "Processing",
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

export const TURN_PREVIEW_CLIENT_SCRIPT = DIAGRAM_PREVIEW_CLIENT_SCRIPT + `(() => {
  const eventsUrl = document.body.dataset.eventsUrl;
  const content = document.getElementById("turn-content");
  const metadata = document.getElementById("turn-metadata");
  const status = document.getElementById("turn-status");
  const live = document.getElementById("turn-live");
  if (!eventsUrl || !content || !metadata || !status || !live) return;

  const isChinese = /^zh/i.test(document.documentElement.lang);
  const labels = {
    elapsed: isChinese ? "耗时 " : "Duration ",
    live: isChinese ? "实时更新" : "Live updates",
    waitingForUpdates: isChinese ? "等待更新" : "Waiting for updates",
    unavailable: isChinese ? "暂时不可用" : "Temporarily unavailable",
    reconnecting: isChinese ? "正在重连" : "Reconnecting",
    loading: isChinese ? "正在加载…" : "Loading…",
    loadFailed: isChinese ? "加载失败，请重试。" : "Could not load details.",
    retry: isChinese ? "重试" : "Retry",
    copied: isChinese ? "已复制 Markdown" : "Markdown copied",
    downloaded: isChinese ? "已开始下载" : "Download started",
    copyFailed: isChinese ? "复制失败，请检查浏览器剪贴板权限后重试。" : "Copy failed. Check clipboard permissions and retry.",
    downloadFailed: isChinese ? "下载失败，请重试。" : "Download failed. Please retry.",
  };
  const copyMarkdownFallback = (text) => {
    const active = document.activeElement;
    const selection = window.getSelection?.();
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.append(textarea);
    try {
      textarea.focus({ preventScroll: true });
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      if (!document.execCommand?.("copy")) throw new Error("Clipboard unavailable");
    } finally {
      textarea.remove();
      active?.focus?.({ preventScroll: true });
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    }
  };
  const copyMarkdown = async (text) => {
    if (window.navigator?.clipboard?.writeText) {
      try { await window.navigator.clipboard.writeText(text); return; } catch {}
    }
    copyMarkdownFallback(text);
  };
  const answerActionsInFlight = new WeakSet();
  content.addEventListener("click", async (event) => {
    const button = event.target.closest?.("button[data-answer-action]");
    const section = button?.closest(".final-result[data-answer-markdown]");
    if (!section || !content.contains(section) || answerActionsInFlight.has(button)) return;
    const action = button.dataset.answerAction;
    if (action !== "copy" && action !== "download") return;
    event.preventDefault();
    const feedback = section.querySelector("[data-answer-feedback]");
    answerActionsInFlight.add(button);
    button.disabled = true;
    try {
      const markdown = new TextDecoder("utf-8", { ignoreBOM: true }).decode(Uint8Array.from(atob(section.dataset.answerMarkdown), (char) => char.charCodeAt(0)));
      if (action === "copy") await copyMarkdown(markdown);
      else {
        const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
        const link = document.createElement("a");
        try {
          link.href = url;
          link.download = section.dataset.answerFilename;
          link.hidden = true;
          document.body.append(link);
          link.click();
        } finally {
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      }
      if (feedback) feedback.textContent = action === "copy" ? labels.copied : labels.downloaded;
    } catch {
      if (feedback) feedback.textContent = action === "copy" ? labels.copyFailed : labels.downloadFailed;
    } finally {
      button.disabled = false;
      answerActionsInFlight.delete(button);
    }
  });

  let source;
  const terminalAtLoad = document.body.dataset.terminal === "true";
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
      const shortDuration = hours > 0
        ? String(hours * 60 + minutes) + ":" + String(remainder).padStart(2, "0")
        : minutes > 0
          ? String(minutes) + ":" + String(remainder).padStart(2, "0")
          : remainder > 0 ? String(remainder) + "s" : "";
      element.textContent = element.dataset.shortDuration === "1" ? shortDuration : labels.elapsed + duration;
    });
  };
  updateElapsed();
  const clock = terminalAtLoad ? undefined : setInterval(updateElapsed, 1000);

  const nodeKey = (node) => {
    if (node.nodeType !== 1) return undefined;
    for (const attribute of ["data-preview-key", "data-activity", "data-activity-id", "data-scroll-id", "data-reasoning-field", "data-reasoning-part"]) {
      if (node.hasAttribute(attribute)) return attribute + ":" + node.getAttribute(attribute);
    }
    if (node.tagName === "IMG") return "image:" + node.getAttribute("src");
    // Keep Markdown image paragraphs/links anchored when text is inserted before them.
    if (["P", "A", "FIGURE", "PICTURE"].includes(node.tagName)) {
      const image = node.querySelector("img");
      if (image) return node.tagName + ":image:" + image.getAttribute("src");
    }
    for (const name of ["markdown", "tool-command", "tool-image", "files", "tool-header", "tool-body", "tool-footer"]) {
      if (node.classList.contains(name)) return node.tagName + ":" + name;
    }
    return undefined;
  };
  const compatible = (current, next) => current.nodeType === next.nodeType && current.nodeName === next.nodeName;
  const patchNode = (current, next) => {
    // Summary snapshots never own a detail body that has already been fetched.
    if (current.nodeType === 1 && current.hasAttribute("data-detail-body") && next.hasAttribute("data-detail-body")) return;
    if (current.isEqualNode(next)) return;
    if (current.nodeType !== 1) {
      if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
      return;
    }
    if (current.hasAttribute("data-diagram") && next.hasAttribute("data-diagram")) {
      const code = current.querySelector(".diagram-source code");
      const nextCode = next.querySelector(".diagram-source code");
      if (code && nextCode && code.textContent !== nextCode.textContent) {
        code.textContent = nextCode.textContent;
        window.agentBotDiagrams.refresh(current);
      }
      return;
    }
    const preserveOpen = current.tagName === "DETAILS";
    for (const attribute of Array.from(current.attributes)) {
      if (preserveOpen && attribute.name === "open") continue;
      if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    }
    for (const attribute of Array.from(next.attributes)) {
      if (preserveOpen && attribute.name === "open") continue;
      if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    }
    patchChildren(current, next);
  };
  const patchChildren = (parent, next) => {
    const nextChildren = Array.from(next.childNodes);
    const nextKeys = new Set(nextChildren.map(nodeKey).filter((key) => key !== undefined));
    const remaining = new Set(Array.from(parent.childNodes));
    const keyed = new Map();
    for (const child of remaining) {
      const key = nodeKey(child);
      if (key === undefined) continue;
      if (!nextKeys.has(key)) {
        child.remove();
        remaining.delete(child);
        continue;
      }
      const matches = keyed.get(key) || [];
      matches.push(child);
      keyed.set(key, matches);
    }
    let cursor = parent.firstChild;
    for (const child of nextChildren) {
      const key = nodeKey(child);
      const matches = key === undefined ? undefined : keyed.get(key);
      const current = key === undefined
        ? cursor && nodeKey(cursor) === undefined && compatible(cursor, child) ? cursor : undefined
        : matches?.find((candidate) => remaining.has(candidate) && compatible(candidate, child));
      if (current) {
        remaining.delete(current);
        // Drop obsolete text/markup before a retained block without detaching that block.
        while (cursor && cursor !== current && nodeKey(cursor) === undefined) {
          const obsolete = cursor;
          cursor = cursor.nextSibling;
          remaining.delete(obsolete);
          obsolete.remove();
        }
        if (current !== cursor) {
          if (typeof parent.moveBefore === "function" && current.isConnected) parent.moveBefore(current, cursor);
          else parent.insertBefore(current, cursor);
        }
        patchNode(current, child);
        cursor = current.nextSibling;
      } else {
        const added = child.cloneNode(true);
        parent.insertBefore(added, cursor);
      }
    }
    for (const child of remaining) child.remove();
  };
  const patchMarkup = (element, markup) => {
    const template = document.createElement("template");
    template.innerHTML = markup;
    patchChildren(element, template.content);
  };
  const detailStates = new WeakMap();
  const detailState = (details) => {
    if (!detailStates.has(details)) detailStates.set(details, {});
    return detailStates.get(details);
  };
  const loadDetails = async (details, retry = false) => {
    if (!details.open || !details.isConnected) return;
    const state = detailState(details);
    const revision = details.dataset.detailRevision;
    if (state.loadedRevision === revision) state.loadedFor = revision;
    if (state.pending || state.loadedFor === revision || (!retry && state.failedRevision === revision)) return;
    const body = details.querySelector("[data-detail-body]");
    const target = details.querySelector("[data-detail-content]");
    const message = details.querySelector("[data-detail-message]");
    if (!body || !target || !message) return;
    const controller = new AbortController();
    const request = { controller, revision };
    state.pending = request;
    state.failedRevision = undefined;
    body.setAttribute("aria-busy", "true");
    message.textContent = state.loadedRevision ? "" : labels.loading;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const url = new URL(eventsUrl, window.location.href);
      url.searchParams.delete("events");
      url.searchParams.set("detail", details.dataset.detailKey);
      if (state.cursor !== undefined) url.searchParams.set("detailAfter", String(state.cursor));
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error("Detail HTTP " + response.status);
      const result = await response.json();
      if (result.key !== details.dataset.detailKey || typeof result.content !== "string" || typeof result.revision !== "string") throw new Error("Invalid detail response");
      if (state.pending !== request || !details.open || !details.isConnected) return;
      if (details.dataset.detailRevision !== revision && result.revision !== details.dataset.detailRevision) return;
      const positions = Array.from(target.querySelectorAll("[data-scroll-id]"), (item) => [item, item.scrollLeft, item.scrollTop]);
      if (typeof result.outputAppend === "string") {
        const output = target.querySelector(".tool-output:not(.error-output)");
        if (!output) throw new Error("Output delta without a loaded body");
        output.append(document.createTextNode(result.outputAppend));
        const footer = target.querySelector(".tool-footer");
        if (footer && result.footer) patchMarkup(footer, result.footer);
      } else patchMarkup(target, result.content);
      state.cursor = result.cursor;
      window.agentBotDiagrams?.scan();
      for (const [item, left, top] of positions) { if (item.isConnected) { item.scrollLeft = left; item.scrollTop = top; } }
      state.loadedRevision = result.revision;
      state.loadedFor = details.dataset.detailRevision;
      message.textContent = "";
      updateElapsed();
    } catch {
      if (state.pending !== request || !details.open || !details.isConnected) return;
      state.cursor = undefined;
      state.failedRevision = revision;
      message.textContent = labels.loadFailed;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = labels.retry;
      button.addEventListener("click", () => { void loadDetails(details, true); });
      message.append(button);
    } finally {
      clearTimeout(timeout);
      if (state.pending === request) {
        state.pending = undefined;
        body.removeAttribute("aria-busy");
        if (details.dataset.detailRevision !== revision) void loadDetails(details);
      }
    }
  };
  content.addEventListener("toggle", (event) => {
    const details = event.target;
    if (!details.matches?.("details[data-detail-key]")) return;
    if (details.open) { void loadDetails(details, true); return; }
    const state = detailState(details);
    state.pending?.controller.abort();
    state.pending = undefined;
    details.querySelector("[data-detail-body]")?.removeAttribute("aria-busy");
    const message = details.querySelector("[data-detail-message]");
    if (message) message.textContent = "";
  }, true);
  const refreshDetails = () => {
    for (const details of content.querySelectorAll("details[data-detail-key][open]")) void loadDetails(details);
  };
  window.addEventListener("pagehide", () => {
    source?.close();
    clearInterval(clock);
    for (const details of content.querySelectorAll("details[data-detail-key]")) detailStates.get(details)?.pending?.controller.abort();
  }, { once: true });
  let previousContent;
  let previousMetadata;
  const applySnapshot = (update) => {
    const contentChanged = update.content !== previousContent;
    const scrollPositions = new Map(Array.from(contentChanged ? content.querySelectorAll("[data-scroll-id]") : [], (item) => [item.dataset.scrollId, [item.scrollLeft, item.scrollTop]]));
    const top = window.scrollY;
    const maxTop = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const atBottom = maxTop - top <= 32;
    if (contentChanged) {
      patchMarkup(content, update.content);
      window.agentBotDiagrams.scan();
      previousContent = update.content;
    }
    if (update.metadata !== previousMetadata) {
      patchMarkup(metadata, update.metadata);
      previousMetadata = update.metadata;
    }
    status.textContent = update.statusLabel;
    status.className = "status " + update.status;
    for (const item of content.querySelectorAll("[data-scroll-id]")) {
      const position = scrollPositions.get(item.dataset.scrollId);
      if (position) { item.scrollLeft = position[0]; item.scrollTop = position[1]; }
    }
    updateElapsed();
    refreshDetails();
    if (!contentChanged) return;
    requestAnimationFrame(() => {
      const nextMaxTop = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo(0, atBottom ? nextMaxTop : Math.min(top, nextMaxTop));
    });
  };

  const applyPatch = (update) => {
    const template = document.createElement("template");
    template.innerHTML = update.content;
    const incoming = template.content;
    const timeline = content.querySelector('[data-preview-key="timeline"]');
    const nextTimeline = incoming.querySelector('[data-preview-key="timeline"]');
    for (const id of update.removed || []) {
      for (const node of timeline.children) if (node.dataset.activity === id || node.dataset.activityId === id) node.remove();
    }
    for (const node of Array.from(nextTimeline.children)) {
      const id = node.dataset.activity || node.dataset.activityId;
      if (!id) continue;
      timeline.querySelector(".empty")?.remove();
      const current = Array.from(timeline.children).find((item) => (item.dataset.activity || item.dataset.activityId) === id);
      if (current) patchNode(current, node);
      else {
        const nextId = update.before?.[id];
        const anchor = Array.from(timeline.children).find((child) => (child.dataset.activity || child.dataset.activityId) === nextId);
        timeline.insertBefore(node, anchor || null);
      }
    }
    timeline.hidden = !timeline.children.length;
    const incomingKeys = new Set(Array.from(incoming.children, (node) => node.dataset.previewKey));
    for (const node of Array.from(incoming.children)) {
      const key = nodeKey(node);
      if (node.dataset.previewKey === "timeline" || !key) continue;
      const current = Array.from(content.children).find((item) => nodeKey(item) === key);
      if (current) patchNode(current, node);
      else {
        const result = content.querySelector('[data-preview-key="result"]');
        content.insertBefore(node, node.dataset.activityId === "turn:files-summary" ? result : null);
      }
    }
    for (const key of ["approval", "error", "plan", "result"]) {
      if (!incomingKeys.has(key)) content.querySelector('[data-preview-key="' + key + '"]')?.remove();
    }
    patchMarkup(metadata, update.metadata);
    status.textContent = update.statusLabel;
    status.className = "status " + update.status;
    window.agentBotDiagrams.scan();
    refreshDetails();
    updateElapsed();
  };
  if (terminalAtLoad || typeof EventSource !== "function") return;
  source = new EventSource(eventsUrl);
  source.addEventListener("patch", (event) => {
    try {
      const update = JSON.parse(event.data);
      applyPatch(update);
      live.textContent = update.terminal ? "" : labels.live;
      live.className = update.terminal ? "live terminal" : "live connected";
      if (update.terminal) { source.close(); clearInterval(clock); }
    } catch { live.textContent = labels.waitingForUpdates; }
  });
  source.addEventListener("update", (event) => {
    try {
      const update = JSON.parse(event.data);
      if (typeof update.content !== "string" || typeof update.metadata !== "string") return;
      applySnapshot(update);
      live.textContent = update.terminal ? "" : labels.live;
      live.className = update.terminal ? "live terminal" : "live connected";
      if (update.terminal) { source.close(); clearInterval(clock); }
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
  diagramScriptPath?: string;
  localFileUrl?: (filePath: string) => string | undefined;
  language?: TurnPreviewLanguage;
}): string {
  const language = input.language ?? "zh";
  const snapshot = renderTurnPreviewSnapshot(input.state, input.localFileUrl, language, { deferDetails: true });
  const title = previewTitle(input.state);
  return `<!doctype html>
<html lang="${language === "zh" ? "zh-CN" : "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Agent Bot</title>
  <style>${TURN_PREVIEW_CSS}${DIAGRAM_PREVIEW_CSS}${PREVIEW_SYNTAX_CSS}</style>
</head>
<body data-terminal="${snapshot.terminal}" data-events-url="${escapeAttribute(input.eventsUrl)}" data-diagram-script="${escapeAttribute(input.diagramScriptPath ?? "")}">
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

export function renderTurnPreviewPatch(
  state: TurnViewState, changed: Set<string>, removed: Set<string>,
  localFileUrl: (filePath: string) => string | undefined, language: TurnPreviewLanguage,
): TurnPreviewSnapshot & { removed: string[]; before: Record<string, string> } {
  const partial = { ...state,
    activities: state.activities.filter((a) => changed.has(a.id)),
    reasoningItems: state.reasoningItems?.filter((r) => changed.has(`reasoning:${r.itemId}`)),
  };
  const order = [
    ...(state.reasoningItems ?? []).filter((r) => !r.afterActivityId).map((r) => `reasoning:${r.itemId}`),
    ...state.activities.flatMap((a) => [a.id, ...(state.reasoningItems ?? []).filter((r) => r.afterActivityId === a.id).map((r) => `reasoning:${r.itemId}`)]),
  ];
  const before = Object.fromEntries(order.flatMap((id, i) => changed.has(id) && order[i + 1] ? [[id, order[i + 1]]] : []));
  return { ...renderTurnPreviewSnapshot(partial, localFileUrl, language, { deferDetails: true }), removed: [...removed], before };
}

export function renderTurnPreviewSnapshot(
  state: TurnViewState,
  localFileUrl?: (filePath: string) => string | undefined,
  language: TurnPreviewLanguage = "zh",
  options: { deferDetails?: boolean } = {},
): TurnPreviewSnapshot {
  const labels = previewLabels(language);
  const resolveFileUrl = localFileUrl ? (filePath: string): string | undefined => {
    if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) return localFileUrl(filePath);
    if (!state.projectCwd || !path.isAbsolute(state.projectCwd)) return undefined;
    return localFileUrl(path.resolve(state.projectCwd, filePath));
  } : undefined;
  const renderText = (value: string): string => renderMarkdown(value, state.projectCwd, localFileUrl, language);
  const timeline = renderTimeline(state, renderText, resolveFileUrl, state.fullToolOutputs, state.fullToolErrors, language, state.projectCwd, options.deferDetails);
  const terminal = isTerminal(state.status);
  const waitingForProgress = !terminal && !state.finalResponse && !state.assistantText
    && !state.error && !state.approval && state.status !== "waiting_for_approval"
    && state.plan.length === 0 && state.fileSummary.length === 0;
  const timelineContent = timeline || (waitingForProgress
    ? `<div class="empty">${escapeHtml(language === "zh" ? "正在等待 Agent 返回进度…" : "Waiting for Agent progress…")}</div>`
    : "");
  const sections = [
    state.prompt || state.promptImagePaths?.length ? renderMessageActivity("prompt", state.prompt ?? "", "user prompt", renderText, renderMessageImages(state.promptImagePaths, resolveFileUrl, language)) : "",
    state.historyDetailError
      ? `<section class="notice" data-preview-key="history-detail"><h2>${language === "zh" ? "历史执行详情读取失败" : "Failed to load historical execution details"}</h2><pre>${escapeHtml(state.historyDetailError)}</pre><p>${language === "zh" ? "刷新页面重试；本轮执行状态未改变。" : "Refresh to retry; the Turn's execution status is unchanged."}</p></section>`
      : state.historyDetail === "summary"
        ? `<section class="notice" data-preview-key="history-detail">${language === "zh" ? "当前仅保存轮次摘要，尚未加载历史执行详情。" : "Only a Turn summary is saved; execution details have not been loaded."}</section>` : "",
    state.plan.length > 0 ? renderPlan(state, language) : "",
    state.activitiesTruncated
      ? `<div class="notice" data-preview-key="truncated">${escapeHtml(labels.truncated)}</div>`
      : "",
    `<section class="timeline" data-preview-key="timeline"${timelineContent ? "" : " hidden"}>${timelineContent}</section>`,
    state.fileSummary.length > 0 ? renderFileSummary(state, language, resolveFileUrl, options.deferDetails) : "",
    state.approval ? renderApprovalNotice(state.approval, renderText, language) : "",
    state.error ? `<section class="result error-result" data-preview-key="error"><h2>${escapeHtml(labels.error)}</h2><pre>${escapeHtml(state.error)}</pre></section>` : "",
    state.finalResponse
      ? renderFinalAnswer(state.finalResponse, state.turnId, renderText, language)
      : state.assistantText
        ? `<section class="result" data-preview-key="result"><h2>${escapeHtml(labels.generating)}</h2><div class="markdown">${renderText(state.assistantText)}</div></section>`
        : "",
  ].filter(Boolean).join("");
  return {
    content: sections,
    metadata: renderMetadata(state, language),
    status: state.status,
    statusLabel: statusLabel(state.status, language),
    terminal,
  };
}

function renderApprovalNotice(request: ApprovalRequest, renderText: (value: string) => string, language: TurnPreviewLanguage): string {
  const command = request.command?.trim();
  const commandApproval = command && request.kind !== "mode_change";
  const title = commandApproval ? language === "zh" ? "命令执行确认" : "Command approval" : request.title;
  const reason = commandApproval
    ? request.reason?.trim() || (request.title.trim() !== command ? request.title : "")
    : request.reason ?? "";
  const description = commandApproval
    ? `<p class="approval-reason">${escapeHtml(reason === command ? "" : reason)}</p>`
    : `<div class="markdown">${renderText(reason)}</div>`;
  const details = commandApproval
    ? `<details class="approval-details" data-activity-id="approval:${escapeAttribute(request.id)}"><summary>${language === "zh" ? "查看完整命令" : "View full command"}</summary><pre data-scroll-id="approval:${escapeAttribute(request.id)}:command">${escapeHtml(request.command!)}</pre></details>` : "";
  return `<section class="notice" data-preview-key="approval"><h2>${escapeHtml(title)}</h2>${description}${details}<p>${language === "zh" ? "请在飞书任务卡片中确认或拒绝。" : "Approve or reject using the task card in Feishu."}</p></section>`;
}

function renderFinalAnswer(markdown: string, turnId: string, renderText: (value: string) => string, language: TurnPreviewLanguage): string {
  const labels = previewLabels(language);
  const filename = `turn-${turnId.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 80) || "answer"}.md`;
  const icon = (paths: string): string => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
  const button = (action: string, label: string, paths: string): string => `<button type="button" class="answer-action" data-answer-action="${action}" title="${escapeAttribute(label)}" aria-label="${escapeAttribute(label)}">${icon(paths)}</button>`;
  const actions = button("download", labels.downloadMarkdown, '<path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/>')
    + button("copy", labels.copyMarkdown, '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>');
  return `<section class="result final-result" data-preview-key="result" data-answer-markdown="${Buffer.from(markdown, "utf8").toString("base64")}" data-answer-filename="${filename}"><div class="result-heading"><h2>${escapeHtml(labels.finalAnswer)}</h2>${actions}<span class="answer-feedback" data-answer-feedback role="status" aria-live="polite"></span></div><div class="markdown">${renderText(markdown)}</div></section>`;
}

function renderPlan(state: TurnViewState, language: TurnPreviewLanguage): string {
  const labels = previewLabels(language);
  const completed = state.plan.filter((step) => step.status === "completed").length;
  const items = state.plan.map((step) => {
    const marker = step.status === "completed" ? "✓" : step.status === "in_progress" ? "↻" : "○";
    return `<li class="${step.status}"><span>${marker}</span><span>${escapeHtml(step.text)}</span></li>`;
  }).join("");
  return `<section class="plan" data-preview-key="plan"><h2>${escapeHtml(labels.plan)} <span>${completed}/${state.plan.length}</span></h2><ol>${items}</ol></section>`;
}

function renderTimeline(
  state: TurnViewState,
  renderText: (value: string) => string,
  localFileUrl?: (filePath: string) => string | undefined,
  fullToolOutputs?: Record<string, string>,
  fullToolErrors?: Record<string, string>,
  language: TurnPreviewLanguage = "zh",
  projectCwd?: string,
  deferDetails = false,
): string {
  const activities = state.activities ?? [];
  const positions = new Map(activities.map((activity, index) => [activity.id, index]));
  const reasoning = new Map<number, TurnReasoningItem[]>();
  for (const item of turnReasoningItems(state)) {
    const position = item.afterActivityId ? positions.get(item.afterActivityId) ?? -1 : -1;
    const items = reasoning.get(position) ?? [];
    items.push(item);
    reasoning.set(position, items);
  }
  const renderReasoning = (position: number): string => (reasoning.get(position) ?? [])
    .map((item) => renderReasoningItem(item, state.projectCwd, localFileUrl, language, deferDetails)).join("");
  return renderReasoning(-1) + activities.map((activity, index) => {
    const visible = activity.kind === "reasoning"
      ? activity.id.startsWith("commentary:") ? { ...activity, kind: "assistant" as const } : undefined
      : activity;
    return (visible ? renderActivity(visible, renderText, localFileUrl, fullToolOutputs, fullToolErrors, language, projectCwd, deferDetails) : "")
      + renderReasoning(index);
  }).join("");
}

function reasoningPresentation(item: TurnReasoningItem): {
  title?: string;
  sections: Array<{ field: "summary" | "content"; parts: Array<{ index: number; text: string }> }>;
} {
  let title: string | undefined;
  const sections = (["summary", "content"] as const).map((field) => ({
    field,
    parts: item[field].map((text, index) => {
      const heading = !title && text?.trim() ? leadingReasoningHeading(text) : undefined;
      if (heading) title = heading.title;
      return { index, text: heading?.body ?? text };
    }).filter((part) => part.text?.trim()),
  }));
  return { title, sections };
}

function leadingReasoningHeading(text: string): { title: string; body: string } | undefined {
  const first = /^(?:[ \t]*\r?\n)*([^\r\n]*)(?:\r?\n|$)/u.exec(text);
  if (!first || !/^ {0,3}(?:#{1,6}[ \t]+|\*\*|__)/u.test(first[1])) return undefined;
  // Parse only a possible title line; collapsed panels must not render the full Markdown.
  const [block, inline] = MARKDOWN.parse(first[1], {});
  const tokens = inline?.children?.filter((token) => token.type !== "text" || token.content !== "") ?? [];
  const strongTitle = block?.type === "paragraph_open"
    && tokens[0]?.type === "strong_open" && tokens.at(-1)?.type === "strong_close"
    && tokens.slice(1, -1).every((token) => token.level > 0);
  if (block?.type !== "heading_open" && !strongTitle) return undefined;
  const title = tokens.map((token) => token.content).join("").trim();
  if (!title) return undefined;
  // Keep linked/image headings in the body so moving their text never discards an attachment or link.
  const keepHeading = tokens.some((token) => token.type === "link_open" || token.type === "image");
  return { title, body: keepHeading ? text : text.slice(first[0].length) };
}

function renderReasoningItem(
  item: TurnReasoningItem,
  cwd: string | undefined,
  localFileUrl: ((filePath: string) => string | undefined) | undefined,
  language: TurnPreviewLanguage,
  deferDetails: boolean,
): string {
  const presentation = reasoningPresentation(item);
  if (!presentation.title && !presentation.sections.some((section) => section.parts.length > 0)) return "";
  const title = presentation.title ?? previewLabels(language).reasoning;
  const lazy = deferDetails ? lazyDetailAttributes(`reasoning:${item.itemId}`, reasoningRevision(item, cwd)) : "";
  const body = deferDetails ? lazyDetailBody() : renderReasoningBody(item, cwd, localFileUrl, language, presentation);
  return `<details class="reasoning-step" data-activity-id="reasoning:${escapeAttribute(item.itemId)}"${lazy}><summary class="reasoning-header" title="${escapeAttribute(title)}"><span class="reasoning-title">💭 ${escapeHtml(title)}</span></summary>${body}</details>`;
}

function renderReasoningBody(
  item: TurnReasoningItem,
  cwd: string | undefined,
  localFileUrl: ((filePath: string) => string | undefined) | undefined,
  language: TurnPreviewLanguage,
  presentation = reasoningPresentation(item),
): string {
  return presentation.sections.map(({ field, parts }) => {
    if (parts.length === 0) return "";
    const sections = parts.map(({ index, text }) => `<div class="markdown reasoning-part" data-reasoning-part="${index}">${renderMarkdown(text, cwd, localFileUrl, language)}</div>`).join("");
    return `<section class="reasoning-section" data-reasoning-field="${field}">${sections}</section>`;
  }).join("");
}

function reasoningRevision(item: TurnReasoningItem, cwd?: string): string {
  if (item.previewRevision !== undefined) return String(item.previewRevision);
  return createHash("sha256").update(JSON.stringify([item.summary, item.content, cwd])).digest("hex").slice(0, 24);
}

function renderActivity(
  activity: Exclude<TurnActivity, { kind: "reasoning" }>,
  renderText: (value: string) => string,
  localFileUrl?: (filePath: string) => string | undefined,
  fullToolOutputs?: Record<string, string>,
  fullToolErrors?: Record<string, string>,
  language: TurnPreviewLanguage = "zh",
  projectCwd?: string,
  deferDetails = false,
): string {
  switch (activity.kind) {
    case "assistant":
      if (activity.id.startsWith("commentary:runtime-error:")) {
        return `<article class="activity message runtime-error" data-activity="${escapeAttribute(activity.id)}"><pre>${escapeHtml(activity.text)}</pre></article>`;
      }
      return renderMessageActivity(activity.id, activity.text, "commentary", renderText);
    case "user":
      return renderMessageActivity(activity.id, activity.text, "user", renderText, renderMessageImages(activity.localImagePaths, localFileUrl, language));
    case "tool":
      return renderToolActivity(activity.id, activity.tool, localFileUrl, fullToolOutputs, fullToolErrors, language, projectCwd, deferDetails);
  }
}

function renderMessageActivity(id: string, text: string, kind: string, renderText: (value: string) => string, images = ""): string {
  return `<article class="activity message ${kind}" data-activity="${escapeAttribute(id)}"><div class="markdown">${renderText(text)}${images}</div></article>`;
}

function renderMessageImages(paths: string[] | undefined, localFileUrl: ((filePath: string) => string | undefined) | undefined, language: TurnPreviewLanguage): string {
  if (!paths?.length) return "";
  return [...new Set(paths)].map((filePath, index) => {
    const label = language === "zh" ? `图片 ${index + 1}` : `Image ${index + 1}`;
    const unavailable = `<p class="muted">${escapeHtml(label)}${language === "zh" ? "不可用" : " unavailable"}</p>`;
    const url = localFileUrl?.(filePath);
    if (!url) return unavailable;
    try {
      const raw = new URL(url);
      if (raw.protocol !== "http:" && raw.protocol !== "https:") return unavailable;
      raw.searchParams.set("raw", "1");
      return `<p class="message-image"><img src="${escapeAttribute(raw.toString())}" alt="${escapeAttribute(label)}" loading="lazy"></p>`;
    } catch {
      return unavailable;
    }
  }).join("");
}

function renderToolActivity(
  activityId: string,
  tool: ToolState,
  localFileUrl?: (filePath: string) => string | undefined,
  fullToolOutputs?: Record<string, string>,
  fullToolErrors?: Record<string, string>,
  language: TurnPreviewLanguage = "zh",
  projectCwd?: string,
  deferDetails = false,
): string {
  const labels = previewLabels(language);
  const command = tool.command ? (displayToolCommand(tool.command) || tool.command.trim()) : undefined;
  const repl = isReplTool(tool);
  const displayCommand = repl
    ? formatReplCommand(command ?? "")
    : command
      ? formatToolCommand(command)
      : undefined;
  const title = displayCommand ? summarizeToolCommand(displayCommand) : toolTitle(tool, command, repl, language);
  const titleMarkup = displayCommand
    ? `<code class="tool-command-title">${escapeHtml(title)}</code>`
    : `<span class="tool-title">${escapeHtml(title)}</span>`;
  const timing = renderToolTiming(tool, "header");
  const statusLabel = toolStatusLabel(tool.status, language);
  const icon = `<span class="tool-status-icon" role="img" aria-label="${escapeAttribute(statusLabel)}" title="${escapeAttribute(statusLabel)}">${toolStatusIcon(tool.status)}</span>`;
  const header = `<summary class="tool-header">${icon}<span class="tool-summary-content">${titleMarkup}</span><span class="tool-meta">${timing}</span></summary>`;
  const body = deferDetails
    ? lazyDetailBody()
    : renderToolBody(activityId, tool, localFileUrl, fullToolOutputs, fullToolErrors, language, projectCwd);
  const lazy = deferDetails ? lazyDetailAttributes(`tool:${activityId}`, toolDetailRevision(tool, fullToolOutputs, fullToolErrors, projectCwd)) : "";
  return `<article class="activity tool" data-activity="${escapeAttribute(activityId)}"><details class="tool-step" data-tool-status="${tool.status}" data-activity-id="${escapeAttribute(activityId)}"${lazy}>${header}${body}</details></article>`;
}

function renderToolBody(
  activityId: string,
  tool: ToolState,
  localFileUrl?: (filePath: string) => string | undefined,
  fullToolOutputs?: Record<string, string>,
  fullToolErrors?: Record<string, string>,
  language: TurnPreviewLanguage = "zh",
  projectCwd?: string,
): string {
  const labels = previewLabels(language);
  const command = tool.command ? (displayToolCommand(tool.command) || tool.command.trim()) : undefined;
  const repl = isReplTool(tool);
  const displayCommand = repl ? formatReplCommand(command ?? "") : command ? formatToolCommand(command) : undefined;
  const status = `<span class="tool-state ${tool.status}">${escapeHtml(toolStatusLabel(tool.status, language))}</span>`;
  const output = fullToolOutputs?.[tool.id] ?? tool.output;
  const error = fullToolErrors?.[tool.id] ?? tool.error;
  const sameError = Boolean(output && error && normalizeOutput(output) === normalizeOutput(error));
  const displayOutput = output && repl && !sameError ? formatReplOutput(output) : output;
  const displayError = sameError ? undefined : error;
  const detailParts = [
    displayCommand ? `<div class="tool-command"><span class="tool-command-prefix" aria-hidden="true">$</span><pre class="command-block${repl ? " repl-code" : ""}">${escapeHtml(displayCommand)}</pre></div>` : "",
    displayOutput
      ? renderToolOutput(sameError ? labels.resultError : repl ? labels.result : labels.output, displayOutput, sameError, repl)
      : "",
    displayError
      ? renderToolOutput(labels.error, displayError, true, repl)
      : "",
    renderToolImage(tool, localFileUrl, language),
    tool.files?.length
      ? `<ul class="files" aria-label="${escapeAttribute(labels.files)}">${tool.files.map((file) => renderFileEntry(file, localFileUrl, projectCwd)).join("")}</ul>`
      : "",
  ].filter(Boolean).join("");
  const footer = renderToolFooter(tool, (displayOutput?.length ?? 0) + (displayError?.length ?? 0), language);
  return `<div class="tool-body"><div class="tool-content" data-scroll-id="${escapeAttribute(`${activityId}:content`)}" tabindex="0">${detailParts || `<div class="muted">${escapeHtml(labels.noToolDetails)}</div>`}</div><div class="tool-footer">${footer}</div></div>`;
}

export function renderToolFooter(tool: ToolState, characterCount: number, language: TurnPreviewLanguage): string {
  const labels = previewLabels(language);
  const status = `<span class="tool-state ${tool.status}">${escapeHtml(toolStatusLabel(tool.status, language))}</span>`;
  const startedAt = tool.startedAt === undefined ? undefined : new Date(tool.startedAt);
  const startTime = startedAt
    ? `<time datetime="${startedAt.toISOString()}" title="${escapeAttribute(labels.startingTime)}">${new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(startedAt)}</time>`
    : `<span title="${escapeAttribute(labels.startingTime)}">${escapeHtml(labels.unknown)}</span>`;
  return `${status}${startTime}${renderToolTiming(tool, "footer")}<span>${formatNumber(characterCount)} ${escapeHtml(labels.characters)}</span>`;
}

function toolTitle(tool: ToolState, command?: string, repl = false, language: TurnPreviewLanguage = "zh"): string {
  if (repl) return "REPL";
  if (command) return tool.kind === "command" ? previewLabels(language).command : tool.kind;
  const title = tool.title.trim();
  return title || tool.kind;
}

function summarizeToolCommand(command: string): string {
  const summary = command.replace(/[\\`^][ \t]*\r?\n/gu, " ").replace(/\s+/gu, " ").trim();
  if (summary.length <= 160) return summary;
  return `${summary.slice(0, 157).trimEnd()}…`;
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
  label: string,
  value: string,
  error = false,
  repl = false,
): string {
  return `<pre class="tool-output${error ? " error-output" : ""}${repl ? " repl-result" : ""}" aria-label="${escapeAttribute(label)}">${escapeHtml(value)}</pre>`;
}

function renderToolTiming(tool: ToolState, placement: "header" | "footer"): string {
  const className = `tool-${placement}-timing`;
  const duration = toolDuration(tool);
  if (duration === undefined) {
    return `<span class="${className}">?</span>`;
  }
  const live = tool.status === "running" && tool.completedAt === undefined;
  return `<span class="${className}"${live ? ` data-live-tool-duration data-started-at="${tool.startedAt}" data-short-duration="1"` : ""}>${formatShortDuration(duration)}</span>`;
}

function formatShortDuration(duration: string): string {
  const parts = duration.split(":").map(Number);
  const seconds = parts.at(-1) ?? 0;
  const minutes = parts.length > 2 ? (parts.at(-2) ?? 0) + (parts.at(-3) ?? 0) * 60 : parts.at(-2) ?? 0;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : seconds > 0 ? `${seconds}s` : "";
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
  deferDetails = false,
): string {
  const labels = previewLabels(language);
  const body = deferDetails ? lazyDetailBody() : renderFileSummaryBody(state, localFileUrl);
  const lazy = deferDetails ? lazyDetailAttributes("files", fileSummaryRevision(state)) : "";
  return `<details class="files-summary" data-activity-id="turn:files-summary"${lazy}><summary><h2>${escapeHtml(labels.fileChanges)} <span>${state.fileSummary.length}</span></h2></summary>${body}</details>`;
}

function renderFileSummaryBody(state: TurnViewState, localFileUrl?: (filePath: string) => string | undefined): string {
  return `<ul class="files">${state.fileSummary.map((file) => renderFileEntry(file, localFileUrl, state.projectCwd)).join("")}</ul>`;
}

function lazyDetailAttributes(key: string, revision: string): string {
  return ` data-detail-key="${escapeAttribute(key)}" data-detail-revision="${revision}"`;
}

function lazyDetailBody(): string {
  return '<div data-detail-body><div class="detail-message" data-detail-message role="status"></div><div data-detail-content></div></div>';
}

function toolDetailRevision(tool: ToolState, outputs?: Record<string, string>, errors?: Record<string, string>, cwd?: string): string {
  if (tool.previewRevision !== undefined) return String(tool.previewRevision);
  return createHash("sha256").update(JSON.stringify([tool, outputs?.[tool.id], errors?.[tool.id], cwd])).digest("hex").slice(0, 24);
}

function fileSummaryRevision(state: TurnViewState): string {
  return createHash("sha256").update(JSON.stringify([state.fileSummary, state.projectCwd])).digest("hex").slice(0, 24);
}

export interface TurnPreviewDetail {
  key: string;
  revision: string;
  content: string;
  cursor?: number;
}

export function renderTurnPreviewDetail(
  state: TurnViewState,
  key: string,
  localFileUrl?: (filePath: string) => string | undefined,
  language: TurnPreviewLanguage = "zh",
): TurnPreviewDetail | undefined {
  const resolveFileUrl = localFileUrl ? (filePath: string): string | undefined => {
    if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) return localFileUrl(filePath);
    if (!state.projectCwd || !path.isAbsolute(state.projectCwd)) return undefined;
    return localFileUrl(path.resolve(state.projectCwd, filePath));
  } : undefined;
  if (key === "files" && state.fileSummary.length > 0) {
    return { key, revision: fileSummaryRevision(state), content: renderFileSummaryBody(state, resolveFileUrl) };
  }
  if (key.startsWith("reasoning:")) {
    const item = turnReasoningItems(state).find((item) => `reasoning:${item.itemId}` === key);
    if (!item || ![...item.summary, ...item.content].some((text) => text?.trim())) return undefined;
    return { key, revision: reasoningRevision(item, state.projectCwd),
      content: renderReasoningBody(item, state.projectCwd, localFileUrl, language) };
  }
  const activity = state.activities?.find((item) => item.kind === "tool" && `tool:${item.id}` === key);
  if (activity?.kind !== "tool") return undefined;
  return {
    key,
    revision: toolDetailRevision(activity.tool, state.fullToolOutputs, state.fullToolErrors, state.projectCwd),
    content: renderToolBody(activity.id, activity.tool, resolveFileUrl, state.fullToolOutputs, state.fullToolErrors, language, state.projectCwd),
  };
}

function renderFileEntry(file: FileSummary, localFileUrl?: (filePath: string) => string | undefined, projectCwd?: string): string {
  const label = `<code>${escapeHtml(displayFilePath(file.path, projectCwd))}</code>`;
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
  const fields = [
    elapsed,
    state.modelProvider?.trim() ? `<span title="Provider">${escapeHtml(state.modelProvider.trim())}</span>` : "",
    state.model?.trim() ? `<span title="${escapeAttribute(labels.model)}">${escapeHtml(state.model.trim())}</span>` : "",
    state.totalTokens === undefined ? "" : state.cachedInputTokens === undefined
      ? `<span title="${escapeAttribute(labels.turnTokens)}">${formatTokenCount(state.totalTokens)} tokens</span>`
      : `<span title="${escapeAttribute(labels.nonCachedTokens)}: ${formatNumber(state.totalTokens)} tokens">${escapeHtml(labels.nonCachedTokens)} ${formatTokenCount(state.totalTokens)} tokens</span>`,
    state.totalTokensIncludingCache === undefined ? "" : `<span title="${escapeAttribute(labels.totalTokens)}: ${formatNumber(state.totalTokensIncludingCache)} tokens">${escapeHtml(labels.totalTokens)} ${formatTokenCount(state.totalTokensIncludingCache)} tokens</span>`,
    state.latestContextTokens !== undefined && Number.isFinite(state.latestContextTokens) && state.latestContextTokens >= 0
      ? `<span title="${escapeAttribute(labels.contextTokens)}: ${formatNumber(state.latestContextTokens)} tokens">${escapeHtml(labels.contextTokens)} ${formatTokenCount(state.latestContextTokens)} tokens</span>` : "",
    state.modelCallCount !== undefined && Number.isSafeInteger(state.modelCallCount) && state.modelCallCount >= 0
      ? `<span title="${escapeAttribute(labels.modelCallsDescription)}">${escapeHtml(labels.modelCalls)} ${formatNumber(state.modelCallCount)}${language === "zh" ? " 次" : ""}</span>` : "",
    (state.totalToolCount ?? 0) > 0 ? `<span>${formatNumber(state.totalToolCount ?? 0)} ${escapeHtml(labels.tools)}</span>` : "",
  ].filter(Boolean);
  return fields.join("");
}

function previewTitle(state: TurnViewState): string {
  const value = (state.prompt ?? state.taskTitle ?? "Turn Preview").replace(/\s+/gu, " ").trim();
  return value.length > 80 ? `${value.slice(0, 79)}…` : value;
}

function renderMarkdown(value: string, projectCwd?: string, localFileUrl?: (filePath: string) => string | undefined, language: TurnPreviewLanguage = "zh"): string {
  const environment = { language };
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

function toolStatusLabel(status: ToolState["status"], language: TurnPreviewLanguage): string {
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
html { scrollbar-gutter: stable; }
@supports not (scrollbar-gutter: stable) {
  html { overflow-y: scroll; }
}
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
.plan, .files-summary, .result { padding: 14px 0; }
.files-summary, .result { border-top: 1px solid var(--line); }
.files-summary > summary h2 { margin: 0; }
.files-summary > .files { padding-top: 8px; }
.plan ol { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.plan li { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 6px; overflow-wrap: anywhere; }
.plan li.completed { color: var(--muted); }
.plan li.in_progress { color: var(--accent); }
.timeline { padding-top: 2px; }
.activity { min-width: 0; }
.message { padding: 12px 0; }
.prompt { border-bottom: 1px solid var(--line); }
.timeline .markdown hr { display: none; }
.markdown { min-width: 0; overflow-wrap: anywhere; }
.message > .markdown, .result > .markdown { font-size: 14px; font-weight: 400; }
.markdown > :first-child { margin-top: 0; }
.markdown > :last-child { margin-bottom: 0; }
.reasoning-step { margin:8px 0; border:1px solid var(--line); border-radius:7px; min-width:0; }
.reasoning-header { cursor:pointer; padding:8px 10px; color:var(--muted); }
.reasoning-title { min-width:0; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.reasoning-section { margin:0 10px 10px; max-height:30em; overflow:auto; overflow-wrap:anywhere; }
.reasoning-part + .reasoning-part { border-top:1px solid var(--line); padding-top:8px; }
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
.tool-step[data-tool-status="running"] { border-color: var(--accent); }
.tool-header { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 7px 10px; overflow: hidden; background: transparent; font-weight: 400; }
.tool-content { max-height: calc(30 * 12px * 1.55 + 16px); padding: 8px 12px; overflow: auto; --tool-scrollbar-thumb: var(--scrollbar-thumb); scrollbar-width: thin; scrollbar-color: var(--tool-scrollbar-thumb) transparent; }
.tool-content > * + * { margin-top: 8px; }
.tool-content pre { max-width: none; max-height: none; padding: 0; overflow: visible; background: transparent; }
.tool-command { display: flex; align-items: flex-start; gap: 8px; width: max-content; min-width: 100%; }
.tool-command-prefix { flex: none; color: var(--muted); font: 12px/1.55 "Cascadia Mono", "SFMono-Regular", Consolas, monospace; }
.tool-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding: 6px 12px; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.tool-footer > * { white-space: nowrap; }
.tool-footer > * + *::before { content: "·"; margin-right: 8px; }
@media (hover: hover) and (pointer: fine) {
  .tool-content { --tool-scrollbar-thumb: transparent; }
  .tool-content:is(:hover, :focus-visible, :focus-within) { --tool-scrollbar-thumb: var(--scrollbar-thumb); }
}
@supports selector(::-webkit-scrollbar) {
  .tool-content { scrollbar-width: auto; scrollbar-color: auto; }
  .tool-content::-webkit-scrollbar { width: 6px; height: 6px; }
  .tool-content::-webkit-scrollbar-track,
  .tool-content::-webkit-scrollbar-corner { background: transparent; }
  .tool-content::-webkit-scrollbar-thumb { background: var(--tool-scrollbar-thumb); border-radius: 3px; }
  .tool-content::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-thumb-hover); }
  .tool-content::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (hover: none), (pointer: coarse) {
  .tool-content { scrollbar-width: none; }
  .tool-content::-webkit-scrollbar { display: none; width: 0; height: 0; }
}
.tool-status-icon { display: inline-flex; flex: 0 0 16px; align-items: center; justify-content: center; font-size: 13px; line-height: 18px; }
.tool-state { display: inline-flex; flex: none; align-items: center; justify-content: center; color: var(--muted); font-size: 11px; font-weight: 400; white-space: nowrap; }
.tool-state.completed { color: var(--success); }
.tool-state.running { color: var(--accent); }
.tool-state.failed { color: var(--danger); }
.tool-summary-content { min-width: 0; flex: 1 1 auto; overflow: hidden; }
.tool-title, .tool-command-title { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-title { font-size: 12px; font-weight: 400; line-height: 1.45; }
.tool-command-title { margin: 0; padding: 0; background: transparent; color: var(--text); font: 12px/1.55 "Cascadia Mono", "SFMono-Regular", Consolas, monospace; font-weight: 400; }
.tool-meta { display: flex; flex: 0 0 auto; flex-wrap: nowrap; align-items: center; gap: 12px; max-width: none; margin-left: auto; color: var(--muted); font-size: 11px; font-weight: 400; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tool-meta span { white-space: nowrap; }
.tool-header-timing { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.tool-header-timing:empty, .tool-footer-timing:empty { display: none; }
.runtime-error pre { white-space: pre-wrap; overflow-wrap: anywhere; border-left: 2px solid var(--danger); }
.error-output, .error-result h2 { color: var(--danger); }
.muted, .empty { color: var(--muted); }
.notice, .empty { padding: 10px 0; }
.notice { color: #926a08; }
.files { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.tool-content .files code { background: transparent; }
.files li { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.files code { min-width: 0; }
.files .file-link { min-width: 0; color: var(--accent); text-underline-offset: 2px; }
.files .file-link code { color: inherit; }
.additions { color: var(--success); }
.deletions { color: var(--danger); }
.file-delta { display: inline-flex; flex: none; gap: 6px; font: 12px "Cascadia Mono", Consolas, monospace; }
.detail-message { padding: 8px 12px; color: var(--muted); }
.detail-message:empty { display: none; }
.detail-message button { margin-left: 8px; cursor: pointer; }
.tool-image img { display: block; max-width: 100%; max-height: 720px; }
.final-result h2 { color: var(--success); }
.approval-reason { white-space: pre-wrap; overflow-wrap: anywhere; }
.approval-reason:empty { display: none; }
.approval-details { margin: 8px 0; }
.approval-details pre { max-height: 30em; }
.result-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-bottom: 8px; }
.result-heading h2 { margin: 0 4px 0 0; }
.answer-action { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 30px; height: 30px; padding: 0; border: 1px solid transparent; border-radius: 5px; background: transparent; color: var(--muted); cursor: pointer; }
.answer-action:hover { color: var(--accent); background: var(--surface); }
.answer-action:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.answer-action:disabled { opacity: 0.5; cursor: wait; }
.answer-feedback { min-width: 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
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
  .tool-meta { gap: 10px; font-size: 11px; }
  .tool-content, .tool-footer { padding-left: 10px; padding-right: 10px; }
  pre { padding: 8px 10px; }
}
@media (prefers-color-scheme: dark) {
  :root { --page: #18191b; --surface: #232427; --code: #1d1e20; --text: #e0e1e4; --muted: #a0a3ab; --line: #35373c; --accent: #8aaff7; --success: #83c69c; --danger: #f58c94; --scrollbar-thumb: #45494f; --scrollbar-thumb-hover: #60666e; }
  .notice, .status.waiting_for_approval { color: #e1bc6f; }
}
`;
