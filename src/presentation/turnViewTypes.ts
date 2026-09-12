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
  | { kind: "user"; id: string; text: string }
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "tool"; id: string; tool: ToolState };

export interface TurnViewState {
  sessionId: string;
  turnId: string;
  agentLabel?: string;
  model?: string;
  taskTitle?: string;
  prompt?: string;
  projectCwd?: string;
  replyTarget?: MessageReplyTarget;
  status: TurnViewStatus;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  totalTokens?: number;
  tokenUsageCumulative?: number;
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
}
