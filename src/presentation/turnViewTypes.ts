import type { MessageReplyTarget } from "../feishu/types.js";
import type { ApprovalRequest, PlanStep, ToolState } from "../runtime/types.js";

export type TurnViewStatus =
  | "starting"
  | "running"
  | "tool_running"
  | "waiting_for_approval"
  | "completed"
  | "cancelled"
  | "failed";

export interface FileSummary {
  path: string;
  additions?: number;
  deletions?: number;
}

export type TurnActivity =
  | { kind: "assistant"; id: string; text: string }
  | { kind: "user"; id: string; text: string; localImagePaths?: string[] }
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "tool"; id: string; tool: ToolState };

export interface TurnReasoningItem {
  previewRevision?: number;
  itemId: string;
  afterActivityId?: string;
  summary: string[];
  content: string[];
  completed?: boolean;
}

export interface TurnViewState {
  /** Full execution content is stored in the append-only preview journal. */
  previewJournal?: boolean;
  /** Byte cursor for the on-demand preview, never needed for recovery. */
  previewCursor?: number;
  sessionId: string;
  turnId: string;
  agentLabel?: string;
  model?: string;
  modelProvider?: string;
  taskTitle?: string;
  prompt?: string;
  promptImagePaths?: string[];
  projectCwd?: string;
  replyTarget?: MessageReplyTarget;
  status: TurnViewStatus;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  totalTokens?: number;
  tokenUsageCumulative?: number;
  totalTokensIncludingCache?: number;
  cachedInputTokens?: number;
  tokenUsageTotalCumulative?: number;
  tokenUsageCachedCumulative?: number;
  /** Effective token-usage updates observed for this turn. */
  modelCallCount?: number;
  /** Independent high-water marks; token breakdowns may disappear in partial updates. */
  modelCallTokenBaseline?: { nonCached?: number; total?: number; totalNeedsRebase?: boolean };
  contextCompactionStatus?: "running" | "completed";
  contextCompactionCount?: number;
  contextCompactionId?: string;
  latestContextTokens?: number;
  contextCompactionStartedAt?: number;
  contextCompactionDurationMs?: number;
  contextCompactionBeforeTokens?: number;
  contextCompactionAfterTokens?: number;
  contextCompactionTurnCount?: number;
  contextCompactionStorageBytes?: number;
  progressText?: string;
  assistantText: string;
  plan: PlanStep[];
  activities: TurnActivity[];
  reasoningItems?: TurnReasoningItem[];
  fullToolOutputs?: Record<string, string>;
  fullToolErrors?: Record<string, string>;
  activitiesTruncated?: boolean;
  totalToolCount?: number;
  completedToolCount?: number;
  failedToolCount?: number;
  toolStatuses?: Record<string, ToolState["status"]>;
  activeTool?: ToolState;
  completedTools: ToolState[];
  failedTools: ToolState[];
  fileSummary: FileSummary[];
  approval?: ApprovalRequest;
  finalResponse?: string;
  error?: string;
  historyDetail?: "summary" | "full";
  historyDetailError?: string;
}
