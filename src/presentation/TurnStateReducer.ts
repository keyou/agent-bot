import type { AgentEvent, RemoteTurnDetails, ToolState } from "../runtime/types.js";
import { appendGeneratedImageMarkdown } from "../utils/generatedImageMarkdown.js";
import type { MessageReplyTarget } from "../feishu/types.js";
import { formatStorageSize } from "../utils/formatStorageSize.js";
import type { FileSummary, TurnActivity, TurnReasoningItem, TurnViewState } from "./turnViewTypes.js";
import { turnReasoningItems } from "./turnReasoning.js";

const MAX_TEXT = 6_000;
const MAX_COMPLETED_TOOLS = 20;
const MAX_FAILED_TOOLS = 5;
const MAX_FILES = 30;

export function createTurnViewState(
  sessionId: string,
  turnId: string,
  startedAt: number,
  taskTitle?: string,
  replyTarget?: MessageReplyTarget,
  projectCwd?: string,
  prompt?: string,
  agentLabel?: string,
  model?: string,
  promptImagePaths?: string[],
  modelProvider?: string,
): TurnViewState {
  return {
    sessionId,
    turnId,
    agentLabel,
    model,
    modelProvider,
    taskTitle,
    prompt,
    ...(promptImagePaths?.length ? { promptImagePaths: [...new Set(promptImagePaths)] } : {}),
    projectCwd,
    replyTarget,
    status: "starting",
    historyDetail: "full",
    startedAt,
    assistantText: "",
    plan: [],
    activities: [],
    fullToolOutputs: {},
    fullToolErrors: {},
    totalToolCount: 0,
    completedToolCount: 0,
    failedToolCount: 0,
    toolStatuses: {},
    completedTools: [],
    failedTools: [],
    fileSummary: [],
  };
}

export function hydrateTurnViewState(summary: TurnViewState, details: RemoteTurnDetails): TurnViewState {
  let state: TurnViewState = {
    ...summary,
    ...createTurnViewState(summary.sessionId, summary.turnId, details.startedAt ?? summary.startedAt,
      summary.taskTitle, summary.replyTarget, summary.projectCwd, summary.prompt,
      summary.agentLabel, summary.model, summary.promptImagePaths, summary.modelProvider),
    historyDetail: "full",
    historyDetailError: undefined,
  };
  let hasPrompt = false;
  const identity = { sessionId: state.sessionId, turnId: state.turnId };
  for (const item of details.items) {
    if (item.kind === "message") {
      if (item.role === "user") {
        if (!hasPrompt) {
          state = { ...state, prompt: item.text, promptImagePaths: item.localImagePaths };
          hasPrompt = true;
        } else {
          state = { ...state, activities: [...state.activities, {
            kind: "user", id: item.id, text: item.text, localImagePaths: item.localImagePaths,
          }] };
        }
      } else {
        state = reduceTurnEvent(state, { ...identity, type: "progress", activityId: `commentary:${item.id}`, text: item.text });
      }
    } else if (item.kind === "tool") {
      state = reduceToolUpdate(state, item.tool, undefined, true);
      state.activities = state.activities.map((a) => a.kind === "tool" && a.id === item.tool.id ? { ...a, tool: item.tool } : a);
    } else if (item.kind === "reasoning") {
      for (const [summaryIndex, text] of item.summary.entries()) {
        state = reduceTurnEvent(state, { ...identity, type: "progress", text,
          activityId: `reasoning:${item.id}:${summaryIndex}`, reasoning: { itemId: item.id, summaryIndex } });
      }
      state = reduceTurnEvent(state, { ...identity, type: "reasoning_completed", itemId: item.id,
        summary: item.summary, content: item.content });
    } else {
      state = reduceTurnEvent(state, { ...identity, type: "plan_updated", steps: item.steps });
    }
  }
  const completedAt = details.completedAt ?? (details.durationMs === undefined || details.startedAt === undefined
    ? undefined : details.startedAt + details.durationMs);
  return {
    ...state,
    status: details.status,
    completedAt,
    durationMs: details.durationMs ?? (completedAt === undefined || details.startedAt === undefined
      ? undefined : Math.max(0, completedAt - details.startedAt)),
    activeTool: undefined,
    approval: undefined,
    finalResponse: details.finalResponse,
    error: details.error,
  };
}

export function reduceTurnEvent(state: TurnViewState, event: AgentEvent, complete = false): TurnViewState {
  if (event.sessionId !== state.sessionId || event.turnId !== state.turnId) return state;
  const next = reduceEvent(state, event);
  if (!complete) return next;
  if (event.type === "turn_completed") next.finalResponse = event.finalResponse;
  if (event.type === "agent_text_delta") next.assistantText = state.assistantText + event.text;
  if (event.type === "plan_updated") next.plan = event.steps;
  if (event.type === "progress") {
    const id = event.activityId ?? "progress";
    const old = state.activities.find((a) => a.id === id);
    next.activities = next.activities.map((a) => a.id === id && a.kind !== "tool"
      ? { ...a, text: (event.append && old && old.kind !== "tool" ? old.text : "") + event.text } : a);
  }
  if (event.type === "tool_started" || event.type === "tool_updated") {
    next.activities = next.activities.map((a) => a.kind === "tool" && a.id === event.tool.id
      ? { ...a, tool: { ...a.tool, ...event.tool } } : a);
    const files = new Map(state.fileSummary.map((f) => [f.path, f]));
    for (const file of event.tool.files ?? []) files.set(file.path, file);
    next.fileSummary = [...files.values()];
  }
  return next;
}

function reduceEvent(state: TurnViewState, event: AgentEvent): TurnViewState {
  if (event.sessionId !== state.sessionId || event.turnId !== state.turnId) return state;

  switch (event.type) {
    case "turn_started":
      return { ...state, status: "running", startedAt: event.startedAt };
    case "agent_text_delta":
      return {
        ...state,
        assistantText: bound(`${state.assistantText}${event.text}`),
        ...(event.replacesActivityId ? {
          activities: (state.activities ?? []).filter((activity) => activity.id !== event.replacesActivityId),
          progressText: undefined,
        } : {}),
      };
    case "token_usage_updated": {
      const lastTokens = normalizeTokenCount(event.lastTokens);
      const cumulativeTokens = normalizeTokenCount(event.cumulativeTokens);
      const previousCumulative = state.tokenUsageCumulative;
      const delta = previousCumulative === undefined
        ? lastTokens
        : Math.max(0, cumulativeTokens - previousCumulative);
      const total = accumulateReportedTokens(
        event.lastTotalTokens, event.cumulativeTotalTokens,
        state.totalTokensIncludingCache, state.tokenUsageTotalCumulative, previousCumulative !== undefined,
      );
      const cached = accumulateReportedTokens(
        event.lastCachedTokens, event.cumulativeCachedTokens,
        state.cachedInputTokens, state.tokenUsageCachedCumulative, previousCumulative !== undefined,
      );
      return {
        ...state,
        totalTokens: (state.totalTokens ?? 0) + delta,
        ...countModelCall(state, event),
        tokenUsageCumulative: Math.max(previousCumulative ?? 0, cumulativeTokens),
        totalTokensIncludingCache: total.value,
        tokenUsageTotalCumulative: total.cumulative,
        cachedInputTokens: cached.value,
        tokenUsageCachedCumulative: cached.cumulative,
        latestContextTokens: event.contextTokens === undefined
          ? state.latestContextTokens
          : normalizeTokenCount(event.contextTokens),
      };
    }
    case "context_compaction": {
      if (event.phase === "started") {
        const compactionId = event.compactionId ?? `generated:${(state.contextCompactionCount ?? 0) + 1}`;
        const beforeTokens = state.latestContextTokens;
        const text = contextCompactionRunningText(beforeTokens, event.turnCount, event.storageBytes);
        const activityId = `context-compaction:${compactionId}`;
        const activityUpdate = upsertActivity(
          state.activities ?? [],
          (state.activities ?? []).findIndex((activity) => activity.id === activityId),
          { kind: "assistant", id: activityId, text },
        );
        return {
          ...state,
          contextCompactionStatus: "running",
          contextCompactionId: compactionId,
          contextCompactionStartedAt: event.timestampMs ?? Date.now(),
          contextCompactionDurationMs: undefined,
          contextCompactionBeforeTokens: beforeTokens,
          contextCompactionAfterTokens: undefined,
          contextCompactionTurnCount: event.turnCount,
          contextCompactionStorageBytes: event.storageBytes,
          progressText: text,
          activities: activityUpdate.activities,
          activitiesTruncated: state.activitiesTruncated || activityUpdate.truncated,
        };
      }
      const currentId = state.contextCompactionId;
      const repeatedItemCompletion = event.compactionId !== undefined
        && event.compactionId === currentId
        && state.contextCompactionStatus === "completed";
      const repeatedLegacyCompletion = event.compactionId === undefined
        && state.contextCompactionStatus === "completed";
      const repeatedCompletion = repeatedItemCompletion || repeatedLegacyCompletion;
      const contextCompactionCount = repeatedCompletion
        ? state.contextCompactionCount ?? 1
        : (state.contextCompactionCount ?? 0) + 1;
      const compactionId = event.compactionId
        ?? currentId
        ?? `legacy:${contextCompactionCount}`;
      const completedAt = event.timestampMs ?? Date.now();
      const durationMs = repeatedCompletion
        ? state.contextCompactionDurationMs
        : state.contextCompactionStartedAt === undefined
          ? undefined
          : Math.max(0, completedAt - state.contextCompactionStartedAt);
      const beforeTokens = state.contextCompactionBeforeTokens;
      const afterTokens = repeatedCompletion
        ? state.contextCompactionAfterTokens
        : state.latestContextTokens;
      const turnCount = repeatedCompletion
        ? state.contextCompactionTurnCount
        : event.turnCount ?? state.contextCompactionTurnCount;
      const storageBytes = repeatedCompletion
        ? state.contextCompactionStorageBytes
        : event.storageBytes ?? state.contextCompactionStorageBytes;
      const text = contextCompactionCompletedText(
        contextCompactionCount,
        durationMs,
        beforeTokens,
        afterTokens,
        turnCount,
        storageBytes,
      );
      const activityId = `context-compaction:${compactionId}`;
      const activityUpdate = upsertActivity(
        state.activities ?? [],
        (state.activities ?? []).findIndex((activity) => activity.id === activityId),
        { kind: "assistant", id: activityId, text },
      );
      return {
        ...state,
        contextCompactionStatus: "completed",
        contextCompactionCount,
        contextCompactionId: compactionId,
        contextCompactionDurationMs: durationMs,
        contextCompactionBeforeTokens: beforeTokens,
        contextCompactionAfterTokens: afterTokens,
        contextCompactionTurnCount: turnCount,
        contextCompactionStorageBytes: storageBytes,
        progressText: text,
        activities: activityUpdate.activities,
        activitiesTruncated: state.activitiesTruncated || activityUpdate.truncated,
      };
    }
    case "reasoning_delta":
      return updateReasoningItem(state, event.itemId, (item) => {
        if (item.completed) return item;
        const content = [...item.content];
        content[event.contentIndex] = (content[event.contentIndex] ?? "") + event.text;
        return { ...item, content };
      });
    case "reasoning_completed":
      return updateReasoningItem(state, event.itemId, (item) => ({
        ...item, summary: [...event.summary], content: [...event.content], completed: true,
      }));
    case "progress": {
      const previewState = event.reasoning
        ? updateReasoningItem(state, event.reasoning.itemId, (item) => {
          if (item.completed) return item;
          const summary = [...item.summary];
          summary[event.reasoning!.summaryIndex] = event.append
            ? (summary[event.reasoning!.summaryIndex] ?? "") + event.text : event.text;
          return { ...item, summary };
        })
        : state;
      const activities = state.activities ?? [];
      const warning = event.severity === "warning";
      const activityUpdate = upsertReasoningActivity(
        warning ? activities.filter((activity) => activity.id !== (event.activityId ?? "progress")) : activities,
        event.activityId ?? "progress",
        warning && !event.activityId?.startsWith("commentary:runtime-error:") ? bound(event.text) : event.text,
        !warning && event.append === true,
        event.activityId?.startsWith("commentary:") ? "assistant" : "reasoning",
      );
      return {
        ...state,
        progressText: bound(event.text),
        ...(previewState.reasoningItems ? { reasoningItems: previewState.reasoningItems } : {}),
        activities: activityUpdate.activities,
        activitiesTruncated: state.activitiesTruncated || activityUpdate.truncated,
      };
    }
    case "plan_updated":
      return { ...state, plan: event.steps.slice(0, 30).map((step) => ({ ...step, text: bound(step.text) })) };
    case "tool_started": {
      const tool = withToolTiming(state, event.tool);
      const bounded = boundTool(tool);
      const activityUpdate = upsertToolActivity(state.activities ?? [], bounded);
      const tracking = trackToolStatus(state, tool);
      return {
        ...state,
        ...tracking,
        status: state.approval ? "waiting_for_approval" : "tool_running",
        activeTool: bounded,
        activities: activityUpdate.activities,
        activitiesTruncated: state.activitiesTruncated || activityUpdate.truncated,
        fileSummary: mergeFiles(state.fileSummary, tool.files),
      };
    }
    case "tool_updated":
      return reduceToolUpdate(state, event.tool);
    case "tool_output_delta":
      return reduceToolOutputDelta(state, event.toolId, event.delta);
    case "approval_requested":
      return { ...state, status: "waiting_for_approval", approval: event.request };
    case "approval_resolved":
      if (state.approval?.id !== event.requestId) return state;
      return { ...state, status: state.activeTool ? "tool_running" : "running", approval: undefined };
    case "turn_completed": {
      const durationMs = Math.max(0, event.durationMs ?? Date.now() - state.startedAt);
      return {
        ...state,
        status: "completed",
        activeTool: undefined,
        approval: undefined,
        completedAt: state.startedAt + durationMs,
        durationMs,
        finalResponse: appendGeneratedImageMarkdown(
          event.finalResponse,
          state.completedTools.flatMap((tool) =>
            tool.kind === "image_generation" && tool.imagePath ? [tool.imagePath] : []),
        ),
      };
    }
    case "turn_cancelled": {
      const completedAt = Date.now();
      return {
        ...state,
        status: "cancelled",
        activeTool: undefined,
        approval: undefined,
        completedAt,
        durationMs: Math.max(0, completedAt - state.startedAt),
      };
    }
    case "turn_failed": {
      const completedAt = Date.now();
      return {
        ...state,
        status: "failed",
        activeTool: undefined,
        approval: undefined,
        completedAt,
        durationMs: Math.max(0, completedAt - state.startedAt),
        error: event.message,
      };
    }
  }
}

export function appendSteerMessage(state: TurnViewState, id: string, text: string, localImagePaths?: string[]): TurnViewState {
  const normalized = text.trim();
  if (!normalized && !localImagePaths?.length) return state;
  const activities = state.activities ?? [];
  const index = activities.findIndex((activity) => activity.id === id);
  const previous = activities[index];
  const images = localImagePaths ?? (previous?.kind === "user" ? previous.localImagePaths : undefined);
  const activityUpdate = upsertActivity(activities, index, {
    kind: "user",
    id,
    text: bound(normalized),
    ...(images?.length ? { localImagePaths: [...new Set(images)] } : {}),
  });
  return {
    ...state,
    activities: activityUpdate.activities,
    activitiesTruncated: state.activitiesTruncated || activityUpdate.truncated,
  };
}

function reduceToolOutputDelta(state: TurnViewState, toolId: string, delta: string): TurnViewState {
  if (!delta) return state;
  const tool = findTool(state, toolId);
  if (!tool || tool.status !== "running" || tool.kind !== "command") return state;
  const fullOutput = `${state.fullToolOutputs?.[toolId] ?? tool.output ?? ""}${delta}`;
  return reduceToolUpdate(state, {
    ...tool,
    output: appendBoundedOutput(tool.output, delta),
  }, fullOutput);
}

function findTool(state: TurnViewState, toolId: string): ToolState | undefined {
  if (state.activeTool?.id === toolId) return state.activeTool;
  const activity = [...(state.activities ?? [])].reverse().find((candidate) =>
    candidate.kind === "tool" && candidate.tool.id === toolId);
  if (activity?.kind === "tool") return activity.tool;
  return state.failedTools.find((tool) => tool.id === toolId)
    ?? state.completedTools.find((tool) => tool.id === toolId);
}

function withToolTiming(state: TurnViewState, tool: ToolState): ToolState {
  const previous = findTool(state, tool.id);
  const now = Date.now();
  const startedAt = tool.startedAt ?? previous?.startedAt ?? tool.completedAt ?? now;
  return {
    ...tool,
    startedAt,
    completedAt: tool.status === "running" ? tool.completedAt : tool.completedAt ?? now,
  };
}

function appendBoundedOutput(previous: string | undefined, delta: string): string {
  const combined = `${previous ?? ""}${delta}`;
  if (combined.length <= MAX_TEXT) return combined;
  return `…${combined.slice(-(MAX_TEXT - 1))}`;
}

function reduceToolUpdate(state: TurnViewState, tool: ToolState, fullOutput?: string, historical = false): TurnViewState {
  if (!historical) tool = withToolTiming(state, tool);
  const nextFullOutput = fullOutput ?? tool.output;
  const fullToolOutputs = nextFullOutput === undefined
    ? state.fullToolOutputs
    : { ...state.fullToolOutputs, [tool.id]: nextFullOutput };
  const fullToolErrors = tool.error === undefined
    ? state.fullToolErrors
    : { ...state.fullToolErrors, [tool.id]: tool.error };
  const tracking = trackToolStatus(state, tool);
  const bounded = boundTool(tool);
  const activityUpdate = upsertToolActivity(state.activities ?? [], bounded);
  const withoutCompleted = state.completedTools.filter((item) => item.id !== tool.id);
  const withoutFailed = state.failedTools.filter((item) => item.id !== tool.id);
  const activeTool = state.activeTool?.id === tool.id ? undefined : state.activeTool;

  if (tool.status === "running") {
    return {
      ...state,
      ...tracking,
      fullToolOutputs,
      fullToolErrors,
      status: state.approval ? "waiting_for_approval" : "tool_running",
      activeTool: bounded,
      activities: activityUpdate.activities,
      activitiesTruncated: state.activitiesTruncated || activityUpdate.truncated,
      completedTools: withoutCompleted,
      failedTools: withoutFailed,
      fileSummary: mergeFiles(state.fileSummary, tool.files),
    };
  }

  if (tool.status === "failed") {
    return {
      ...state,
      ...tracking,
      fullToolOutputs,
      fullToolErrors,
      status: state.approval ? "waiting_for_approval" : activeTool ? "tool_running" : "running",
      activeTool,
      activities: activityUpdate.activities,
      activitiesTruncated: state.activitiesTruncated || activityUpdate.truncated,
      completedTools: withoutCompleted,
      failedTools: [...withoutFailed, bounded].slice(-MAX_FAILED_TOOLS),
      fileSummary: mergeFiles(state.fileSummary, tool.files),
    };
  }

  return {
    ...state,
    ...tracking,
    fullToolOutputs,
    fullToolErrors,
    status: state.approval ? "waiting_for_approval" : activeTool ? "tool_running" : "running",
    activeTool,
    activities: activityUpdate.activities,
    activitiesTruncated: state.activitiesTruncated || activityUpdate.truncated,
    failedTools: withoutFailed,
    completedTools: [...withoutCompleted, bounded].slice(-MAX_COMPLETED_TOOLS),
    fileSummary: mergeFiles(state.fileSummary, tool.files),
  };
}

function trackToolStatus(
  state: TurnViewState,
  tool: ToolState,
): Pick<TurnViewState, "totalToolCount" | "completedToolCount" | "failedToolCount" | "toolStatuses"> {
  const toolStatuses = state.toolStatuses
    ? { ...state.toolStatuses }
    : legacyToolStatuses(state);
  const previous = toolStatuses[tool.id];
  let totalToolCount = state.totalToolCount ?? Object.keys(toolStatuses).length;
  let completedToolCount = state.completedToolCount
    ?? Object.values(toolStatuses).filter((status) => status === "completed").length;
  let failedToolCount = state.failedToolCount
    ?? Object.values(toolStatuses).filter((status) => status === "failed").length;

  if (previous === undefined) totalToolCount += 1;
  if (previous !== tool.status) {
    if (previous === "completed") completedToolCount = Math.max(0, completedToolCount - 1);
    if (previous === "failed") failedToolCount = Math.max(0, failedToolCount - 1);
    if (tool.status === "completed") completedToolCount += 1;
    if (tool.status === "failed") failedToolCount += 1;
  }
  toolStatuses[tool.id] = tool.status;
  return { totalToolCount, completedToolCount, failedToolCount, toolStatuses };
}

function legacyToolStatuses(state: TurnViewState): Record<string, ToolState["status"]> {
  const statuses: Record<string, ToolState["status"]> = {};
  for (const tool of state.completedTools ?? []) statuses[tool.id] = tool.status;
  for (const tool of state.failedTools ?? []) statuses[tool.id] = tool.status;
  for (const activity of state.activities ?? []) {
    if (activity.kind === "tool") statuses[activity.tool.id] = activity.tool.status;
  }
  if (state.activeTool) statuses[state.activeTool.id] = state.activeTool.status;
  return statuses;
}

function updateReasoningItem(
  state: TurnViewState,
  itemId: string,
  update: (item: TurnReasoningItem) => TurnReasoningItem,
): TurnViewState {
  const items = [...(state.reasoningItems ?? [])];
  const index = items.findIndex((item) => item.itemId === itemId);
  const item = index >= 0 ? items[index]! : turnReasoningItems(state).find((item) => item.itemId === itemId) ?? {
    itemId, afterActivityId: state.activities.at(-1)?.id, summary: [], content: [],
  };
  const next = update(item);
  if (next === item) return state;
  if (index >= 0) items[index] = next;
  else items.push(next);
  return { ...state, reasoningItems: items };
}

function upsertReasoningActivity(
  activities: TurnActivity[],
  id: string,
  text: string,
  append: boolean,
  kind: "assistant" | "reasoning",
): ActivityUpdate {
  const index = activities.findIndex((activity) => activity.id === id);
  const existing = index >= 0 ? activities[index] : undefined;
  const previousText = existing?.kind === "reasoning" || existing?.kind === "assistant" ? existing.text : "";
  const combined = append ? `${previousText}${text}` : text;
  const next: TurnActivity = {
    kind,
    id,
    text: kind === "assistant" ? combined : bound(combined),
  };
  return upsertActivity(activities, index, next);
}

function upsertToolActivity(activities: TurnActivity[], tool: ToolState): ActivityUpdate {
  const index = activities.findIndex((activity) => activity.id === tool.id);
  return upsertActivity(activities, index, { kind: "tool", id: tool.id, tool });
}

interface ActivityUpdate {
  activities: TurnActivity[];
  truncated: boolean;
}

function upsertActivity(activities: TurnActivity[], index: number, activity: TurnActivity): ActivityUpdate {
  const updated = [...activities];
  if (index >= 0) updated[index] = activity;
  else updated.push(activity);
  return {
    activities: updated,
    truncated: false,
  };
}

function boundTool(tool: ToolState): ToolState {
  return {
    ...tool,
    title: bound(tool.title),
    command: tool.command === undefined ? undefined : bound(tool.command),
    output: tool.output === undefined ? undefined : bound(tool.output),
    error: tool.error === undefined ? undefined : bound(tool.error),
    files: tool.files?.slice(0, MAX_FILES),
  };
}

function mergeFiles(existing: FileSummary[], incoming: ToolState["files"]): FileSummary[] {
  if (!incoming?.length) return existing;
  const merged = new Map(existing.map((file) => [file.path, { ...file }]));
  for (const file of incoming) {
    const previous = merged.get(file.path);
    merged.set(file.path, {
      path: file.path,
      additions: addOptional(previous?.additions, file.additions),
      deletions: addOptional(previous?.deletions, file.deletions),
    });
  }
  return [...merged.values()].slice(-MAX_FILES);
}

function addOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

function bound(value: string): string {
  if (value.length <= MAX_TEXT) return value;
  return `${value.slice(0, MAX_TEXT - 1)}…`;
}

function countModelCall(
  state: TurnViewState,
  event: Extract<AgentEvent, { type: "token_usage_updated" }>,
): Pick<TurnViewState, "modelCallCount" | "modelCallTokenBaseline"> {
  // A pre-existing snapshot without a counter cannot provide a complete turn count.
  if (state.modelCallCount === undefined && state.modelCallTokenBaseline === undefined
    && state.tokenUsageCumulative !== undefined) return {};
  const nonCached = reportedUsage(event.lastTokens, event.cumulativeTokens);
  const total = reportedUsage(event.lastTotalTokens, event.cumulativeTotalTokens);
  if (!nonCached && !total) return { modelCallTokenBaseline: state.modelCallTokenBaseline ?? {} };
  const previous = state.modelCallTokenBaseline;
  const usage = total ?? nonCached!;
  const staleNonCached = nonCached !== undefined && previous?.nonCached !== undefined
    && nonCached.cumulative < previous.nonCached;
  const nonCachedGrew = nonCached !== undefined && previous?.nonCached !== undefined
    && nonCached.cumulative > previous.nonCached;
  const grew = total && previous?.total !== undefined && !previous.totalNeedsRebase
    ? total.cumulative > previous.total
    : nonCached && previous?.nonCached !== undefined
      ? nonCachedGrew
      : previous?.total === undefined && previous?.nonCached === undefined
        && usage.last > 0 && usage.cumulative > 0;
  return {
    modelCallCount: (state.modelCallCount ?? 0) + (grew ? 1 : 0),
    modelCallTokenBaseline: {
      nonCached: nonCached ? Math.max(previous?.nonCached ?? 0, nonCached.cumulative) : previous?.nonCached,
      total: total ? Math.max(previous?.total ?? 0, total.cumulative) : previous?.total,
      // After a legacy-only update, rebase totals before using them again; keep
      // their high-water mark so stale reports cannot lower the baseline.
      totalNeedsRebase: total && !staleNonCached ? false : nonCachedGrew || previous?.totalNeedsRebase,
    },
  };
}

function reportedUsage(last: number | undefined, cumulative: number | undefined): { last: number; cumulative: number } | undefined {
  if (last === undefined || cumulative === undefined || !Number.isFinite(last) || !Number.isFinite(cumulative)
    || last < 0 || cumulative < 0) return undefined;
  return { last: normalizeTokenCount(last), cumulative: normalizeTokenCount(cumulative) };
}

function accumulateReportedTokens(
  last: number | undefined,
  cumulative: number | undefined,
  value: number | undefined,
  previous: number | undefined,
  hasPriorUsage: boolean,
): { value?: number; cumulative?: number } {
  if (last === undefined || cumulative === undefined || !Number.isFinite(last) || !Number.isFinite(cumulative)
    || last < 0 || cumulative < 0) return {};
  // A saved or partial turn without a baseline cannot acquire a complete breakdown later.
  if (hasPriorUsage && (previous === undefined || value === undefined)) return {};
  const normalizedCumulative = normalizeTokenCount(cumulative);
  return {
    value: (value ?? 0) + (previous === undefined ? normalizeTokenCount(last) : Math.max(0, normalizedCumulative - previous)),
    cumulative: Math.max(previous ?? 0, normalizedCumulative),
  };
}

function normalizeTokenCount(value: number): number {
  return Math.max(0, Math.round(value));
}

function contextCompactionCompletedText(
  count: number,
  durationMs: number | undefined,
  beforeTokens: number | undefined,
  afterTokens: number | undefined,
  turnCount: number | undefined,
  storageBytes: number | undefined,
): string {
  const subject = count > 1
    ? `Codex 已完成本轮第 ${count} 次上下文压缩`
    : "Codex 已完成上下文压缩";
  const details = [
    durationMs === undefined ? undefined : `耗时 ${formatCompactionDuration(durationMs)}`,
    contextCompactionSizeText(beforeTokens, afterTokens),
    contextCompactionTaskMetricsText(turnCount, storageBytes),
  ].filter((detail): detail is string => detail !== undefined);
  return `${subject}${details.length > 0 ? ` · ${details.join(" · ")}` : ""}，继续处理。`;
}

function contextCompactionRunningText(
  beforeTokens: number | undefined,
  turnCount: number | undefined,
  storageBytes: number | undefined,
): string {
  const context = beforeTokens === undefined
    ? "Codex 正在压缩上下文…"
    : `Codex 正在压缩上下文（压缩前 ${formatInteger(beforeTokens)} tokens）…`;
  const metrics = contextCompactionTaskMetricsText(turnCount, storageBytes);
  return metrics ? `${context} · ${metrics}` : context;
}

function contextCompactionTaskMetricsText(
  turnCount: number | undefined,
  storageBytes: number | undefined,
): string {
  const turns = turnCount === undefined ? "已执行轮次未知" : `已执行 ${formatInteger(turnCount)} 轮`;
  const storage = storageBytes === undefined ? "磁盘占用未知" : `磁盘占用 ${formatStorageSize(storageBytes)}`;
  return `${turns} · ${storage}`;
}

function contextCompactionSizeText(
  beforeTokens: number | undefined,
  afterTokens: number | undefined,
): string | undefined {
  if (afterTokens === undefined) return undefined;
  if (beforeTokens === undefined) return `压缩后 ${formatInteger(afterTokens)} tokens`;
  if (afterTokens >= beforeTokens || beforeTokens === 0) return undefined;
  const reduction = Math.round((1 - afterTokens / beforeTokens) * 100);
  return `上下文 ${formatInteger(beforeTokens)} → ${formatInteger(afterTokens)} tokens（减少 ${reduction}%）`;
}

function formatCompactionDuration(durationMs: number): string {
  const seconds = Math.max(0, durationMs) / 1_000;
  if (seconds < 10) return `${Number(seconds.toFixed(1))}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remainingSeconds = totalSeconds % 60;
  const time = `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${time}` : time;
}

function formatInteger(value: number): string {
  return normalizeTokenCount(value).toLocaleString("en-US");
}

/** Bound the hot card projection, never the journal or final-delivery payload. */
export function compactTurnView(state: TurnViewState): TurnViewState {
  const recent = state.activities.slice(-77);
  const commentary = state.activities.slice(0, -77).filter((a) => a.kind === "assistant").slice(-3);
  const retained = state.activities.length > 80 ? [...commentary, ...recent] : state.activities;
  const activities = retained.map((a) => a.kind === "tool"
    ? { ...a, tool: boundTool(a.tool) } : { ...a, text: bound(a.text) });
  const ids = new Set(activities.filter((a) => a.kind === "tool").map((a) => a.id));
  return { ...state, previewJournal: true, previewCursor: undefined, activities,
    assistantText: bound(state.assistantText), progressText: state.progressText === undefined ? undefined : bound(state.progressText),
    plan: state.plan.slice(0, 30).map((step) => ({ ...step, text: bound(step.text) })),
    activeTool: state.activeTool ? boundTool(state.activeTool) : undefined,
    completedTools: state.completedTools.slice(-20).map(boundTool), failedTools: state.failedTools.slice(-5).map(boundTool),
    fileSummary: state.fileSummary.slice(-30),
    activitiesTruncated: state.activitiesTruncated || state.activities.length > 80,
    reasoningItems: [], fullToolOutputs: {}, fullToolErrors: {},
    toolStatuses: Object.fromEntries(Object.entries(state.toolStatuses ?? {}).filter(([id]) => ids.has(id))),
  };
}
