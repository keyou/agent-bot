export type RuntimeKind = "acp" | "codex";
export interface AgentProcessInfo {
  pid?: number;
  version?: string;
}
export type PermissionMode = "auto" | "confirm";
export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type ToolStatus = "running" | "completed" | "failed";
export type RuntimeGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export interface RuntimeGoal {
  threadId: string;
  objective: string;
  status: RuntimeGoalStatus;
  tokenBudget?: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeGoalUpdate {
  objective?: string;
  status?: RuntimeGoalStatus;
  tokenBudget?: number | null;
}

export type RuntimePrompt = string | {
  text: string;
  localImagePaths?: string[];
};

export interface PlanStep {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ToolState {
  id: string;
  title: string;
  kind: string;
  status: ToolStatus;
  command?: string;
  output?: string;
  error?: string;
  exitCode?: number;
  startedAt?: number;
  completedAt?: number;
  imagePath?: string;
  files?: Array<{ path: string; additions?: number; deletions?: number }>;
}

export interface ApprovalRequest {
  id: string;
  title: string;
  command?: string;
  reason?: string;
  options: Array<{ id: ApprovalDecision; label: string }>;
}

export type AgentEvent =
  | { type: "turn_started"; sessionId: string; turnId: string; startedAt: number }
  | { type: "agent_text_delta"; sessionId: string; turnId: string; text: string }
  | {
      type: "token_usage_updated";
      sessionId: string;
      turnId: string;
      lastTokens: number;
      cumulativeTokens: number;
    }
  | {
      type: "progress";
      sessionId: string;
      turnId: string;
      text: string;
      activityId?: string;
      append?: boolean;
    }
  | { type: "plan_updated"; sessionId: string; turnId: string; steps: PlanStep[] }
  | { type: "tool_started"; sessionId: string; turnId: string; tool: ToolState }
  | { type: "tool_updated"; sessionId: string; turnId: string; tool: ToolState }
  | { type: "tool_output_delta"; sessionId: string; turnId: string; toolId: string; delta: string }
  | { type: "approval_requested"; sessionId: string; turnId: string; request: ApprovalRequest }
  | { type: "approval_resolved"; sessionId: string; turnId: string; requestId: string; decision: ApprovalDecision }
  | { type: "turn_completed"; sessionId: string; turnId: string; finalResponse: string; durationMs?: number }
  | { type: "turn_cancelled"; sessionId: string; turnId: string }
  | { type: "turn_failed"; sessionId: string; turnId: string; message: string };

export interface SessionMetadataUpdatedEvent {
  type: "session_metadata_updated";
  sessionId: string;
  title: string;
}

export type RuntimeEvent = AgentEvent | SessionMetadataUpdatedEvent;

export interface RuntimeSessionMetadata {
  title?: string;
}

export type RemoteSessionStatus = "active" | "idle" | "not_loaded" | "error";

export interface RemoteCompletedTurnSummary {
  id: string;
  prompt?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface RemoteTurnPage {
  turns: RemoteCompletedTurnSummary[];
  nextCursor?: string;
}

export interface RemoteSessionSummary {
  id: string;
  title?: string;
  preview?: string;
  cwd: string;
  source: string;
  status: RemoteSessionStatus;
  modelProvider?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: PermissionMode;
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number;
  lastTurnId?: string;
  lastCompletedTurnId?: string;
  lastTurnStatus?: "completed" | "interrupted" | "failed" | "inProgress";
  lastUserPrompt?: string;
  lastActivity?: string;
  finalResponse?: string;
  lastError?: string;
  lastTurnToolCount?: number;
  lastTurnCompletedToolCount?: number;
  lastTurnFailedToolCount?: number;
  lastTurnRunningToolCount?: number;
  completedTurns?: RemoteCompletedTurnSummary[];
}

export interface RemoteSessionPage {
  sessions: RemoteSessionSummary[];
  nextCursor?: string;
}

export interface RemoteSessionActivity {
  active: boolean;
  activeTurnId?: string;
}

export interface RuntimeSession {
  localSessionId: string;
  remoteSessionId: string;
  runtimeKind: RuntimeKind;
  agentName: string;
  cwd: string;
  title?: string;
  modelProvider?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode: PermissionMode;
  activeTurnId?: string;
  // Returned by reconciliation so status callers can reuse the same observation.
  remoteSummary?: RemoteSessionSummary;
}

export interface CreateRuntimeSessionInput {
  localSessionId: string;
  agentName: string;
  cwd: string;
  title?: string;
  modelProvider?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode: PermissionMode;
}

export interface ResumeRuntimeSessionInput extends CreateRuntimeSessionInput {
  remoteSessionId: string;
  activeTurnId?: string;
  lastTurnId?: string;
  lastTurnStatus?: string;
}

export interface ForkRuntimeSessionInput extends CreateRuntimeSessionInput {
  remoteSessionId: string;
  lastTurnId: string;
}

export interface ModelOption {
  id: string;
  displayName?: string;
  isDefault?: boolean;
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort?: string;
}

export interface ModelProviderOption {
  id: string;
  displayName?: string;
  isDefault?: boolean;
}

export interface RuntimeExecutionSettings {
  modelProvider: string;
  model: string;
  reasoningEffort: string;
  permissionMode: PermissionMode;
}

export interface RuntimeReleaseResult {
  status: "released" | "busy";
  activeSessionIds?: string[];
}

export interface ReasoningEffortOption {
  value: string;
  description?: string;
}

export interface AgentRuntime {
  readonly kind: RuntimeKind;
  getProcessInfo?(): AgentProcessInfo;
  getThreadWriterLockPath?(remoteSessionId: string): string | undefined;
  createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSession>;
  resumeSession(input: ResumeRuntimeSessionInput): Promise<RuntimeSession>;
  forkSession?(input: ForkRuntimeSessionInput): Promise<RuntimeSession>;
  getSession(localSessionId: string): RuntimeSession | undefined;
  readSessionMetadata(remoteSessionId: string): Promise<RuntimeSessionMetadata>;
  listRemoteSessions?(input?: { searchTerm?: string; cursor?: string; limit?: number }): Promise<RemoteSessionPage>;
  readRemoteSession?(remoteSessionId: string, view?: "metadata" | "latest" | "latest-full"): Promise<RemoteSessionSummary>;
  readRemoteForkSource?(remoteSessionId: string): Promise<RemoteSessionSummary>;
  listRemoteTurnSummaries?(remoteSessionId: string, input: { cursor?: string; limit: number }): Promise<RemoteTurnPage>;
  inspectRemoteSessionActivity?(remoteSessionId: string): Promise<RemoteSessionActivity>;
  synchronizeSession(sessionId: string): Promise<RuntimeSession>;
  startTurn(sessionId: string, prompt: RuntimePrompt): Promise<string>;
  steerTurn(sessionId: string, turnId: string, prompt: RuntimePrompt): Promise<void>;
  cancelTurn(sessionId: string, turnId: string): Promise<void>;
  interruptRemoteTurn?(remoteSessionId: string, turnId: string): Promise<void>;
  archiveRemoteSession?(remoteSessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  setTitle?(sessionId: string, title: string): Promise<void>;
  getGoal?(sessionId: string): Promise<RuntimeGoal | undefined>;
  setGoal?(sessionId: string, update: RuntimeGoalUpdate): Promise<RuntimeGoal>;
  clearGoal?(sessionId: string): Promise<boolean>;
  setModel(sessionId: string, model: string): Promise<void>;
  setReasoningEffort(sessionId: string, effort: string): Promise<void>;
  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void>;
  setExecutionSettings?(
    sessionId: string,
    settings: RuntimeExecutionSettings,
    // Called after remote verification, before releasing the task's operation lock.
    persist?: (session: RuntimeSession) => Promise<void>,
  ): Promise<RuntimeSession>;
  respondToApproval(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  listModels(): Promise<ModelOption[]>;
  listModelProviders?(): Promise<ModelProviderOption[]>;
  release?(options?: { force?: boolean }): Promise<RuntimeReleaseResult>;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  close(): void;
}
