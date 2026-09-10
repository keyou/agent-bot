import { createHash } from "node:crypto";
import path from "node:path";
import type { TurnViewState } from "../presentation/turnViewTypes.js";
import type {
  ModelOption,
  ModelProviderOption,
  PermissionMode,
  ReasoningEffortOption,
  RemoteSessionSummary,
  RuntimeGoal,
} from "../runtime/types.js";
import type { SessionRecord } from "../state/StateStore.js";
import type { ShellCommandResult } from "../utils/executeShellCommand.js";

export type ControlRequest =
  | { action: "health" }
  | {
      action: "server_restart";
      mode: "safe" | "immediate";
      reason: string;
      notificationSessionId?: string;
    }
  | {
      action: "server_update";
      planPath: string;
      reason: string;
      notificationSessionId?: string;
    }
  | { action: "server_stop" }
  | { action: "task_status"; localSessionId: string }
  | { action: "task_stop"; localSessionId: string }
  | { action: "task_release"; localSessionId: string }
  | { action: "task_archive"; localSessionId: string }
  | { action: "task_dismiss"; localSessionId: string }
  | { action: "task_title"; localSessionId: string; title: string }
  | { action: "task_prompt"; localSessionId: string; text: string }
  | {
      action: "task_new";
      localSessionId: string;
      title?: string;
      cwd?: string;
      agentName?: string;
      projectless?: boolean;
    }
  | { action: "task_fork"; localSessionId: string }
  | {
      action: "task_switch";
      localSessionId: string;
      targetLocalSessionId?: string;
      previous?: boolean;
    }
  | { action: "task_queue"; localSessionId: string; text: string }
  | { action: "task_agent"; localSessionId: string; agentName?: string }
  | {
      action: "task_settings";
      localSessionId: string;
      setting?: "provider" | "model" | "thinking" | "permissions";
      value?: string;
    }
  | {
      action: "task_goal";
      localSessionId: string;
      goalAction: "show" | "set" | "edit" | "pause" | "resume" | "clear";
      objective?: string;
    }
  | { action: "task_turns"; localSessionId: string }
  | { action: "task_reset"; localSessionId: string; turnId: string }
  | { action: "task_mute"; localSessionId: string; enabled?: boolean }
  | { action: "task_shell"; localSessionId: string; command: string }
  | { action: "task_directory"; localSessionId: string; directory?: string; page?: number }
  | { action: "task_send_file"; localSessionId: string; filePath: string }
  | {
      action: "task_new_group";
      localSessionId: string;
      title?: string;
      cwd?: string;
      agentName?: string;
      projectless?: boolean;
    }
  | {
      action: "task_new_group_session";
      localSessionId: string;
      sessionId: string;
      title?: string;
      agentName?: string;
    }
  | { action: "task_fork_group"; localSessionId: string; title?: string };

export interface ControlResponse {
  ok: boolean;
  message?: string;
  data?: unknown;
}

export function assertCompatibleTaskNewGroupRequest(request: {
  action: "task_new_group";
  [key: string]: unknown;
}): void {
  if (request.sessionId !== undefined) {
    throw new Error(
      "This Agent Bot Worker no longer accepts --session through the legacy newgroup protocol. "
      + "Restart the Agent Bot CLI and try again.",
    );
  }
}

export interface TaskStatusControlData {
  session: SessionRecord;
  snapshot?: TurnViewState;
  remote?: RemoteSessionSummary;
}

export interface TaskGroupControlData {
  sourceLocalSessionId: string;
  sourceTurnId?: string;
  group: {
    chatId: string;
    contextKey: string;
    name: string;
  };
  task: SessionRecord;
}

export interface TaskDismissControlData {
  localSessionId: string;
  remoteSessionId: string;
  title: string;
  chatId: string;
}

export interface TaskReleaseControlData {
  agentName: string;
  status: "waiting" | "released";
  blockingTaskCount: number;
}

export interface TaskForkControlData {
  sourceLocalSessionId: string;
  sourceTurnId: string;
  task: SessionRecord;
}

export interface TaskAgentControlData {
  current: string;
  agents: Array<{ name: string; title: string }>;
}

export interface TaskSettingsControlData {
  session: SessionRecord;
  providers: ModelProviderOption[];
  models: ModelOption[];
  reasoningOptions: ReasoningEffortOption[];
  permissionModes: PermissionMode[];
}

export interface TaskGoalControlData {
  goal?: RuntimeGoal;
  cleared?: boolean;
}

export interface TaskTurnControlEntry {
  sequence: number;
  turnId: string;
  parentTurnId?: string;
  prompt?: string;
  startedAt?: number;
  completedAt?: number;
  current: boolean;
}

export interface TaskTurnsControlData {
  session: SessionRecord;
  turns: TaskTurnControlEntry[];
}

export interface TaskMuteControlData {
  contextKey: string;
  enabled: boolean;
}

export type TaskDirectoryEntryKind = "directory" | "image" | "binary" | "file" | "drive";

export interface TaskDirectoryControlData {
  directory: string;
  parentDirectory?: string;
  page: number;
  totalPages: number;
  totalEntries: number;
  entries: Array<{ name: string; path: string; kind: TaskDirectoryEntryKind }>;
}

export interface TaskShellControlData extends ShellCommandResult {
  cwd: string;
  command: string;
}

export function controlEndpoint(sqlitePath: string): string {
  const resolvedPath = path.resolve(sqlitePath);
  const key = createHash("sha256").update(resolvedPath.toLowerCase()).digest("hex").slice(0, 16);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\agent-bot-${key}`
    : path.join(path.dirname(resolvedPath), `.agent-bot-${key}.sock`);
}
