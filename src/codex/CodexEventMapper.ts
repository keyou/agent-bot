import type { PlanStep, ToolState } from "../runtime/types.js";

export type MappedCodexNotification =
  | { kind: "turn_started"; threadId: string; turnId: string; startedAt?: number }
  | {
      kind: "token_usage";
      threadId: string;
      turnId: string;
      lastTokens: number;
      cumulativeTokens: number;
      contextTokens?: number;
    }
  | {
      kind: "context_compaction";
      threadId: string;
      turnId: string;
      phase: "started" | "completed";
      compactionId?: string;
      timestampMs?: number;
    }
  | { kind: "agent_delta"; threadId: string; turnId: string; itemId: string; text: string }
  | {
      kind: "agent_message_phase";
      threadId: string;
      turnId: string;
      itemId: string;
      phase: "commentary" | "final_answer";
    }
  | {
      kind: "progress";
      threadId: string;
      turnId: string;
      activityId: string;
      text: string;
      append: true;
    }
  | { kind: "plan"; threadId: string; turnId: string; steps: PlanStep[] }
  | { kind: "tool"; phase: "started" | "updated"; threadId: string; turnId: string; tool: ToolState }
  | { kind: "tool_output_delta"; threadId: string; turnId: string; toolId: string; delta: string }
  | {
      kind: "terminal";
      threadId: string;
      turnId: string;
      status: "completed" | "cancelled" | "failed";
      durationMs?: number;
      error?: string;
    };

export function mapCodexNotification(method: string, params: unknown): MappedCodexNotification | undefined {
  if (!isRecord(params)) return undefined;
  const threadId = stringValue(params.threadId);
  const turnId = stringValue(params.turnId) ?? (isRecord(params.turn) ? stringValue(params.turn.id) : undefined);
  if (!threadId || !turnId) return undefined;

  if (method === "turn/started") {
    return {
      kind: "turn_started",
      threadId,
      turnId,
      startedAt: isRecord(params.turn) ? secondsToMilliseconds(numberValue(params.turn.startedAt)) : undefined,
    };
  }

  if (
    method === "thread/tokenUsage/updated"
    && isRecord(params.tokenUsage)
    && isRecord(params.tokenUsage.last)
    && isRecord(params.tokenUsage.total)
  ) {
    const lastTokens = effectiveTokenCount(params.tokenUsage.last);
    const cumulativeTokens = effectiveTokenCount(params.tokenUsage.total);
    if (lastTokens === undefined || cumulativeTokens === undefined) return undefined;
    return {
      kind: "token_usage",
      threadId,
      turnId,
      lastTokens,
      cumulativeTokens,
      contextTokens: numberValue(params.tokenUsage.last.totalTokens),
    };
  }

  if (method === "thread/compacted") {
    return { kind: "context_compaction", threadId, turnId, phase: "completed" };
  }

  if (method === "item/agentMessage/delta") {
    const text = stringValue(params.delta);
    const itemId = stringValue(params.itemId);
    return text === undefined || !itemId ? undefined : { kind: "agent_delta", threadId, turnId, itemId, text };
  }
  if (method === "item/commandExecution/outputDelta") {
    const delta = stringValue(params.delta);
    const toolId = stringValue(params.itemId);
    return delta === undefined || !toolId
      ? undefined
      : { kind: "tool_output_delta", threadId, turnId, toolId, delta };
  }
  if (method === "item/reasoning/summaryTextDelta") {
    const text = stringValue(params.delta);
    const itemId = stringValue(params.itemId);
    const summaryIndex = numberValue(params.summaryIndex);
    if (text === undefined || !itemId || summaryIndex === undefined) return undefined;
    return {
      kind: "progress",
      threadId,
      turnId,
      activityId: `reasoning:${itemId}:${summaryIndex}`,
      text,
      append: true,
    };
  }
  if (method === "turn/plan/updated" && Array.isArray(params.plan)) {
    const steps = params.plan.flatMap((value): PlanStep[] => {
      if (!isRecord(value) || typeof value.step !== "string") return [];
      return [{ text: value.step, status: mapPlanStatus(value.status) }];
    });
    return { kind: "plan", threadId, turnId, steps };
  }
  if ((method === "item/started" || method === "item/completed") && isRecord(params.item)) {
    if (params.item.type === "contextCompaction") {
      return {
        kind: "context_compaction",
        threadId,
        turnId,
        phase: method === "item/started" ? "started" : "completed",
        compactionId: stringValue(params.item.id),
        timestampMs: numberValue(method === "item/started" ? params.startedAtMs : params.completedAtMs),
      };
    }
    if (params.item.type === "agentMessage") {
      const itemId = stringValue(params.item.id);
      const phase = messagePhase(params.item.phase);
      if (!itemId || !phase) return undefined;
      return { kind: "agent_message_phase", threadId, turnId, itemId, phase };
    }
    const phase = method === "item/started" ? "started" : "updated";
    const tool = mapTool(params.item, phase, numberValue(params.startedAtMs), numberValue(params.completedAtMs));
    if (!tool) return undefined;
    return {
      kind: "tool",
      phase,
      threadId,
      turnId,
      tool,
    };
  }
  if (method === "turn/completed" && isRecord(params.turn)) {
    const status = params.turn.status;
    const mappedStatus = status === "interrupted" ? "cancelled" : status === "failed" ? "failed" : "completed";
    const error = isRecord(params.turn.error) ? stringValue(params.turn.error.message) : undefined;
    return {
      kind: "terminal",
      threadId,
      turnId,
      status: mappedStatus,
      durationMs: numberValue(params.turn.durationMs),
      error,
    };
  }
  return undefined;
}

function mapTool(
  item: Record<string, unknown>,
  phase: "started" | "updated",
  startedAt?: number,
  completedAt?: number,
): ToolState | undefined {
  const id = stringValue(item.id);
  const type = stringValue(item.type);
  if (!id || !type) return undefined;
  const status = mapToolStatus(item.status, phase);
  if (type === "commandExecution") {
    const command = stringValue(item.command) ?? "Command";
    return {
      id,
      title: command,
      kind: "command",
      status,
      command,
      output: stringValue(item.aggregatedOutput),
      exitCode: numberValue(item.exitCode),
      startedAt,
      completedAt,
      error: status === "failed" ? stringValue(item.aggregatedOutput) : undefined,
    };
  }
  if (type === "fileChange") {
    const files = Array.isArray(item.changes)
      ? item.changes.flatMap((change): NonNullable<ToolState["files"]> => {
          if (!isRecord(change) || typeof change.path !== "string") return [];
          const diff = stringValue(change.diff) ?? "";
          return [{ path: change.path, additions: countDiff(diff, "+"), deletions: countDiff(diff, "-") }];
        })
      : [];
    return { id, title: `修改 ${files.length} 个文件`, kind: "file_change", status, files, startedAt, completedAt };
  }
  if (type === "mcpToolCall" || type === "dynamicToolCall") {
    const tool = stringValue(item.tool) ?? "tool";
    const server = stringValue(item.server);
    const title = server ? `${server}.${tool}` : tool;
    const error = isRecord(item.error) ? stringValue(item.error.message) : undefined;
    const argumentsText = formatJson(item.arguments);
    const output = formatJson(type === "mcpToolCall" ? item.result : item.contentItems);
    return {
      id,
      title,
      kind: type === "mcpToolCall" ? "mcp" : "tool",
      status,
      command: argumentsText ? `${title}\n${argumentsText}` : title,
      output,
      error,
      startedAt,
      completedAt,
    };
  }
  if (type === "webSearch") {
    return mapWebSearchTool(item, id, status, startedAt, completedAt);
  }
  if (type === "imageView") {
    const imagePath = stringValue(item.path) ?? "image";
    return {
      id,
      title: `查看图片 ${imagePath}`,
      kind: "image_view",
      status,
      command: `view_image ${imagePath}`,
      imagePath,
      startedAt,
      completedAt,
    };
  }
  if (type === "imageGeneration") {
    const imagePath = nonEmptyString(item.savedPath);
    return {
      id,
      title: "生成图片",
      kind: "image_generation",
      status,
      command: nonEmptyString(item.revisedPrompt),
      imagePath,
      startedAt,
      completedAt,
    };
  }
  return undefined;
}

function mapWebSearchTool(
  item: Record<string, unknown>,
  id: string,
  status: ToolState["status"],
  startedAt?: number,
  completedAt?: number,
): ToolState {
  const action = isRecord(item.action) ? item.action : undefined;
  const actionType = stringValue(action?.type);
  const itemQuery = nonEmptyString(item.query);

  if (actionType === "openPage" || actionType === "open_page") {
    const url = nonEmptyString(action?.url);
    const target = displayWebTarget(url);
    return {
      id,
      title: target ? `打开网页 · ${target}` : "打开网页",
      kind: "web_search",
      status,
      command: url ? `open_page ${url}` : "open_page",
      startedAt,
      completedAt,
    };
  }

  if (actionType === "findInPage" || actionType === "find_in_page") {
    const url = nonEmptyString(action?.url);
    const pattern = nonEmptyString(action?.pattern);
    const target = displayWebTarget(url);
    const summary = pattern ?? target;
    return {
      id,
      title: summary ? `页内查找 · ${summary}` : "页内查找",
      kind: "web_search",
      status,
      command: [
        pattern ? `find_in_page ${JSON.stringify(pattern)}` : "find_in_page",
        url,
      ].filter((part): part is string => part !== undefined).join("\n"),
      startedAt,
      completedAt,
    };
  }

  const actionQueries = stringArray(action?.queries);
  const actionQuery = nonEmptyString(action?.query);
  const queries = actionQueries.length > 0
    ? actionQueries
    : actionQuery
      ? [actionQuery]
      : itemQuery
        ? [itemQuery]
        : [];
  const summary = queries.join("；");
  return {
    id,
    title: summary ? `网页搜索 · ${summary}` : "网页搜索",
    kind: "web_search",
    status,
    command: queries.length > 1
      ? `web_search\n${queries.map((query) => `- ${query}`).join("\n")}`
      : queries[0]
        ? `web_search ${JSON.stringify(queries[0])}`
        : "web_search",
    startedAt,
    completedAt,
  };
}

function displayWebTarget(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  const text = stringValue(value)?.trim();
  return text || undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const text = nonEmptyString(item);
        return text ? [text] : [];
      })
    : [];
}

function mapPlanStatus(value: unknown): PlanStep["status"] {
  if (value === "completed") return "completed";
  if (value === "inProgress" || value === "in_progress") return "in_progress";
  return "pending";
}

function mapToolStatus(value: unknown, phase: "started" | "updated"): ToolState["status"] {
  if (value === "completed") return "completed";
  if (value === "failed" || value === "declined") return "failed";
  return phase === "updated" ? "completed" : "running";
}

function countDiff(diff: string, prefix: "+" | "-"): number {
  return diff.split("\n").filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function effectiveTokenCount(usage: Record<string, unknown>): number | undefined {
  const inputTokens = numberValue(usage.inputTokens);
  const cachedInputTokens = numberValue(usage.cachedInputTokens) ?? 0;
  const outputTokens = numberValue(usage.outputTokens);
  if (inputTokens !== undefined || outputTokens !== undefined) {
    return Math.max(0, (inputTokens ?? 0) - cachedInputTokens) + Math.max(0, outputTokens ?? 0);
  }
  return numberValue(usage.totalTokens);
}

function secondsToMilliseconds(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value * 1_000;
}

function messagePhase(value: unknown): "commentary" | "final_answer" | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

function formatJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
