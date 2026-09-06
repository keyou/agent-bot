import { createHash } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { createProjectlessWorkspace, detectProjectlessWorkspace } from "../codex/ProjectlessWorkspace.js";
import {
  SystemThreadWriterProcessController,
  type ThreadWriterProcess,
  type ThreadWriterProcessController,
} from "../codex/ThreadWriterProcess.js";
import { resolveUserPath } from "../config/paths.js";
import {
  DEFAULT_GROUP_NAME_FORMAT,
  type AgentExecutionDefaults,
  type AppConfig,
} from "../config/schema.js";
import { CommandRouter } from "../commands/CommandRouter.js";
import type { Command } from "../commands/commandTypes.js";
import { baseChatContextKey, isThreadContextKey } from "../feishu/contextKey.js";
import type {
  CardAction,
  ChatUpdatedEvent,
  IncomingMessage,
  MessageReplyTarget,
  ReferencedMessageContent,
} from "../feishu/types.js";
import {
  type AppServerReleaseCardView,
  CardRenderer,
  type CardSection,
  type DirectoryBrowserCardEntry,
  type ExecutionSettingsTab,
  type HelpCardSection,
  type ResetHistoryCardEntry,
  type SessionTaskCardEntry,
  type SessionTaskCardGroup,
  type ShellCommandCardView,
  type TaskListCardAction,
  type ThreadWriterConflictCardView,
} from "../feishu/CardRenderer.js";
import { CardUpdateScheduler } from "../feishu/CardUpdateScheduler.js";
import { generateGroupAvatarPng, resolveGroupAvatarProjectName } from "../feishu/GroupAvatarGenerator.js";
import {
  formatGroupNameDate,
  formatNewGroupName,
  parseTaskNameFromGroupName,
} from "../feishu/GroupNameFormatter.js";
import { normalizeFeishuPostText } from "../feishu/InboundText.js";
import { allowsFeishuUser } from "../feishu/ownerAccess.js";
import { classifyFileContent } from "../local-files/LocalFileViewerServer.js";
import { errorLogValue } from "../logging/errorLogValue.js";
import type { OutboundRouter } from "../presentation/OutboundRouter.js";
import type { TurnActivity, TurnViewState } from "../presentation/turnViewTypes.js";
import { buildTurnGraphRows } from "../presentation/turnGraph.js";
import type { AgentRuntimeRegistry } from "../runtime/AgentRuntimeRegistry.js";
import type {
  AgentRuntime,
  ApprovalDecision,
  PermissionMode,
  RemoteCompletedTurnSummary,
  RemoteSessionActivity,
  RemoteSessionPage,
  RemoteSessionSummary,
  RuntimeGoal,
  RuntimeEvent,
  RuntimePrompt,
  RuntimeSession,
} from "../runtime/types.js";
import {
  isActiveShellCommandJob,
  ShellCommandJobManager,
  type ShellCommandJobManagerLike,
  type ShellCommandJobSnapshot,
} from "../shell/ShellCommandJobManager.js";
import {
  StateStore,
  type CardActionBinding,
  type MessageReactionRecord,
  type MessageReactionStatus,
  type QueuedPromptRecord,
  type SessionRecord,
  type TurnAttemptRecord,
  type TurnAnchorRecord,
} from "../state/StateStore.js";
import { createId } from "../utils/id.js";
import { truncateMiddle, truncateText } from "../utils/markdown.js";
import { normalizeTaskTitle } from "../utils/taskTitle.js";
import {
  executeShellCommand,
  type ShellCommandOptions,
  type ShellCommandResult,
} from "../utils/executeShellCommand.js";

interface LoadedSession {
  record: SessionRecord;
  runtime: AgentRuntime;
  session: RuntimeSession;
}

interface StartTurnOptions {
  attemptId?: string;
  messageId?: string;
  displayPrompt?: string;
  preserveAttemptOnFailure?: boolean;
}

interface PendingForwardAttachment {
  contextKey: string;
  attachmentMessageId?: string;
  attachmentPromise: Promise<IncomingMessage | undefined>;
  resolveAttachment: (message: IncomingMessage | undefined) => void;
}

interface ForwardAttachmentReservation {
  sourceMessageId: string;
  sourceKind: "merged_forward" | "resource";
  pending: PendingForwardAttachment;
  registry: Map<string, PendingForwardAttachment>;
}

interface PreparedTopicRootPrompt {
  text: string;
  localImagePaths?: string[];
  displayPrompt: string;
  injectedRootMessageId?: string;
}

interface ShellCommandJobMonitor {
  scheduler: CardUpdateScheduler<ShellCommandCardView>;
  timer: NodeJS.Timeout;
  refreshing: boolean;
}

interface AppServerReleaseCardTarget {
  contextKey: string;
  messageId: string;
}

interface AppServerReleaseSchedule {
  id: number;
  agentName: string;
  runtime: AgentRuntime;
  status: AppServerReleaseCardView["status"];
  blockingTaskCount: number;
  blockingTaskTitles: string[];
  targets: Map<string, AppServerReleaseCardTarget>;
  forced: boolean;
  releaseStarted?: boolean;
  error?: string;
  timer?: NodeJS.Timeout;
  inFlight?: Promise<void>;
}

interface RequestFailureDetails {
  requestId?: string;
  messageId?: string;
  actionId?: string;
  command?: string;
  phase?: string;
}

class PresentedRequestError extends Error {
  constructor(public readonly originalError: unknown) {
    super(originalError instanceof Error ? originalError.message : String(originalError), { cause: originalError });
    this.name = "PresentedRequestError";
  }
}

const MESSAGE_RECEIVED_REACTION = "OnIt";
const MESSAGE_COMPLETED_REACTION = "DONE";
const MESSAGE_FAILED_REACTION = "ERROR";
const MESSAGE_CANCELLED_REACTION = "CrossMark";
const SESSION_PAGE_SIZE = 10;
const SESSION_PROMPT_PREVIEW_LENGTH = 50;
const DIRECTORY_PAGE_SIZE = 15;
const RESET_HISTORY_PAGE_SIZE = 10;
const REMOTE_TURN_HISTORY_REFRESH_INTERVAL_MS = 30_000;
const MAX_LLM_TURN_RETRIES = 3;
const QUEUED_PROMPT_RETRY_DELAY_MS = 5_000;
const RECOVERY_ACTIVITY_WINDOW_MS = 10 * 60 * 1_000;
const RECOVERY_HEARTBEAT_INTERVAL_MS = 60 * 1_000;
const SHELL_COMMAND_JOB_POLL_INTERVAL_MS = 1_000;
const SHELL_COMMAND_JOB_RELAUNCH_DELAY_MS = 5_000;
const APP_SERVER_RELEASE_POLL_INTERVAL_MS = 500;
const FORWARD_ATTACHMENT_WINDOW_MS = 800;
const DEFAULT_MERGED_FORWARD_INSTRUCTION = "请参考以下内容回复用户";
const DEFAULT_REFERENCED_MESSAGE_INSTRUCTION = "请参考引用消息回复用户";
const TURN_STOP_REQUESTED_MESSAGE = "已发送停止信号，任务会自动停止。";
const REMOTE_SESSION_REFERENCE_PREFIX = "agent-runtime:";
const WINDOWS_DRIVES_DIRECTORY = "agentbot://windows-drives";
const IMAGE_FILE_EXTENSIONS = new Set([
  ".avif", ".bmp", ".gif", ".heic", ".heif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp",
]);

interface HelpCommandDefinition {
  command: string;
  usage?: string;
  description: string;
  requiresArgument?: boolean;
}

const HELP_COMMAND_SECTIONS: Array<{
  title: string;
  commands: HelpCommandDefinition[];
}> = [
  {
    title: "任务管理",
    commands: [
      {
        command: "/new",
        usage: "[title] [--dir &#60;cwd&#62; | --nodir]",
        description: "使用默认 Agent 创建任务；--nodir 创建 Projectless 任务",
      },
      {
        command: "/newgroup",
        usage: "[title] [--dir &#60;cwd&#62; | --nodir]",
        description: "创建飞书群和新任务",
      },
      {
        command: "/dir",
        usage: "[目录]",
        description: "浏览、发送文件，并从选定目录创建任务或群",
      },
      {
        command: "/file",
        usage: "&#60;文件路径&#62;",
        description: "将指定文件发送到当前飞书会话",
        requiresArgument: true,
      },
      {
        command: "/forkgroup",
        usage: "[title]",
        description: "从当前任务最近完成轮次创建分支群",
      },
      {
        command: "/fork",
        usage: "[序号或任务 ID]",
        description: "从当前或指定任务最近完成轮次创建分支",
      },
      { command: "/turns", description: "浏览历史轮次，并可 Reset 对话上下文" },
      {
        command: "/title",
        usage: "&#60;新标题&#62;",
        description: "修改当前任务标题",
        requiresArgument: true,
      },
      { command: "/sessions", usage: "[关键词]", description: "查找本机任务" },
      {
        command: "/archive",
        usage: "[序号或任务 ID]",
        description: "归档当前或指定任务",
      },
      { command: "/dismiss", description: "归档当前任务并解散当前群" },
      {
        command: "/switch",
        usage: "[序号或任务 ID]",
        description: "切换任务；不填参数切回上一个任务",
      },
    ],
  },
  {
    title: "执行设置",
    commands: [
      {
        command: "!",
        usage: "&#60;命令&#62;",
        description: "在当前任务目录执行本地命令",
        requiresArgument: true,
      },
      { command: "/stop", description: "停止当前执行" },
      {
        command: "/queue",
        usage: "&#60;prompt&#62;",
        description: "将 Prompt 排队为后续轮次",
        requiresArgument: true,
      },
      {
        command: "/nosteer",
        usage: "&#60;prompt&#62;",
        description: "与 /queue 相同",
        requiresArgument: true,
      },
      {
        command: "/goal",
        usage: "&#60;目标或操作&#62;",
        description: "查看或创建长任务 Goal；支持 pause、resume、edit、clear",
        requiresArgument: true,
      },
      { command: "/provider", description: "选择 AI 服务提供商" },
      { command: "/model", description: "选择当前任务使用的模型" },
      { command: "/thinking", description: "设置模型的思考强度" },
      { command: "/permissions", description: "设置执行工具前是否需要确认" },
    ],
  },
  {
    title: "Agent",
    commands: [
      {
        command: "/agent",
        usage: "[name]",
        description: "选择新任务使用的默认 Agent",
      },
    ],
  },
  {
    title: "系统",
    commands: [
      {
        command: "/status",
        usage: "[序号或任务 ID]",
        description: "查看当前或指定任务状态",
      },
      {
        command: "/restart",
        usage: "[--force]",
        description: "默认安全重启；--force 立即重启",
      },
      {
        command: "/release",
        description: "释放 Agent Bot 占用的 App Server 任务",
      },
      {
        command: "/mute",
        usage: "[on|off]",
        description: "开启或关闭当前群的仅 @ 响应模式",
      },
      { command: "/help", description: "显示本帮助" },
    ],
  },
];

const HELP_DEFAULT_COMMANDS = new Set(
  HELP_COMMAND_SECTIONS.flatMap((section) => section.commands)
    .filter((command) => !command.requiresArgument)
    .map((command) => command.command),
);

interface AgentRemoteSession {
  agentName: string;
  runtime: AgentRuntime;
  remote: RemoteSessionSummary;
}

interface AgentRemoteSessionSummary {
  agentName: string;
  session: RemoteSessionSummary;
}

interface SessionsCardOptions {
  updateMessageId?: string;
  forceSwitchTaskId?: string;
  page?: number;
}

interface DirectoryBrowserOptions {
  updateMessageId?: string;
  page?: number;
}

interface StatusCardOptions {
  updateMessageId?: string;
  forceSwitchTaskId?: string;
}

interface ResetHistoryCardOptions {
  expectedSessionId?: string;
  updateMessageId?: string;
  page?: number;
}

interface ModelCardOptions {
  sessionId?: string;
  updateMessageId?: string;
}

interface ThinkingCardOptions extends ModelCardOptions {
  expectedModel?: string;
}

interface ExecutionSettingsCardOptions extends ModelCardOptions {
  notice?: string;
}

type SessionExecutionSettings = AgentExecutionDefaults;

interface ProjectSessionReference {
  source?: SessionRecord;
  agentName: string;
  remoteSessionId: string;
  cwd: string;
  executionSettings: SessionExecutionSettings;
}

interface ForkSessionPlan {
  source?: SessionRecord;
  sourceLabel: string;
  runtime: AgentRuntime;
  agentName: string;
  remoteSessionId: string;
  lastTurnId: string;
  cwd: string;
  forkTitle: string;
  modelProvider?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode: PermissionMode;
  lastTurnStatus?: SessionRecord["lastTurnStatus"];
  sourceTurnPrompt?: string;
  sourceTurnStartedAt?: number;
  sourceTurnCompletedAt?: number;
  sourceCompletedTurns?: RemoteCompletedTurnSummary[];
  sourceWasRunning: boolean;
  forkedFromHistoricalTurn: boolean;
}

interface ForkSessionResult {
  record: SessionRecord;
  session: RuntimeSession;
}

interface ForkGroupSessionPlan {
  plan: ForkSessionPlan;
  sourceDescription: string;
}

interface ResolvedThreadForkAnchor {
  anchor: TurnAnchorRecord;
  source: SessionRecord;
  snapshot?: TurnViewState;
}

interface CreatedFeishuGroupContext {
  chatId: string;
  contextKey: string;
  name: string;
}

interface CreatedFeishuTaskGroup {
  group: CreatedFeishuGroupContext;
  task: SessionRecord;
}

export interface ControlTaskGroupResult {
  sourceLocalSessionId: string;
  sourceTurnId?: string;
  group: CreatedFeishuGroupContext;
  task: SessionRecord;
}

export interface ControlTaskReleaseResult {
  agentName: string;
  status: "waiting" | "released";
  blockingTaskCount: number;
}

export interface ProxyLifecycle {
  supervised?: boolean;
  restart(contextKey: string, force: boolean, replyTarget?: MessageReplyTarget): Promise<void>;
  cancelSafeRestart?(scheduleId: number): Promise<boolean>;
  rememberFeishuUserOpenId?(userOpenId: string): Promise<void> | void;
  persistAgentExecutionDefaults?(
    agentName: string,
    defaults: AgentExecutionDefaults,
  ): Promise<void> | void;
}

export type ShellCommandExecutor = (
  command: string,
  cwd: string,
  options?: ShellCommandOptions,
) => Promise<ShellCommandResult>;
export interface WindowsDriveInfo {
  root: string;
  label?: string;
  driveType?: string;
}

export type WindowsDriveLister = () => Promise<WindowsDriveInfo[]>;

export class ProxySessionController {
  private readonly router = new CommandRouter();
  private readonly cardRenderer = new CardRenderer();
  private readonly messageQueues = new Map<string, Promise<void>>();
  private readonly sessionLoads = new Map<string, Promise<LoadedSession>>();
  private readonly queuedPromptStarts = new Map<string, Promise<void>>();
  private readonly queuedPromptCards = new Map<string, Map<string, string>>();
  private readonly queuedPromptCardWrites = new Map<string, Promise<void>>();
  private readonly sessionResets = new Map<string, Promise<void>>();
  private readonly resetHistoryOperations = new Map<string, string>();
  private readonly remoteTurnHistoryRefreshes = new Map<string, number>();
  private readonly lastSessionListings = new Map<string, string[]>();
  private readonly threadInitializations = new Map<string, Promise<void>>();
  private readonly llmRetryingSessions = new Set<string>();
  private readonly retriedFailureTurnIds = new Set<string>();
  private readonly queuedPromptRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly recoveryRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingMergedForwards = new Map<string, PendingForwardAttachment>();
  private readonly pendingResourceForwards = new Map<string, PendingForwardAttachment>();
  private readonly relatedReactionMessageIds = new Map<string, string[]>();
  private readonly shellCommandJobMonitors = new Map<string, ShellCommandJobMonitor>();
  private readonly appServerReleaseSchedules = new Map<string, AppServerReleaseSchedule>();
  private nextAppServerReleaseScheduleId = 1;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly recoveryActivityHeartbeat: NodeJS.Timeout;
  private startupRecovery?: Promise<void>;
  private queuedPromptsRestored = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore,
    private readonly runtimes: AgentRuntimeRegistry,
    private readonly outbound: OutboundRouter,
    private readonly logger: Logger,
    private readonly lifecycle?: ProxyLifecycle,
    private readonly shellCommandExecutor: ShellCommandExecutor = executeShellCommand,
    private readonly windowsDriveLister: WindowsDriveLister = listWindowsDriveRoots,
    private readonly shellCommandJobs: ShellCommandJobManagerLike = new ShellCommandJobManager(
      path.join(path.dirname(config.storage.sqlitePath), "command-jobs"),
    ),
    private readonly threadWriterProcesses: ThreadWriterProcessController = new SystemThreadWriterProcessController(),
  ) {
    for (const [, runtime] of this.runtimes.entries()) {
      this.unsubscribe.push(
        runtime.onEvent((event) => {
          void this.handleRuntimeEvent(event).catch((error: unknown) => {
            this.logger.warn({ error, event }, "Failed to present runtime event.");
          });
        }),
      );
    }
    this.restorePersistedSessionRoutes();
    void this.restorePersistedMessageReactions().catch((error: unknown) => {
      this.logger.warn({ error }, "Failed to restore persisted message reaction statuses.");
    });
    this.recoveryActivityHeartbeat = setInterval(
      () => this.persistActiveTurnHeartbeats(),
      RECOVERY_HEARTBEAT_INTERVAL_MS,
    );
    this.recoveryActivityHeartbeat.unref?.();
  }

  async onMessage(message: IncomingMessage): Promise<void> {
    let forwardedImages: Array<{ messageId: string; imageKey: string }> = [];
    let forwardedFiles: Array<{ messageId: string; fileKey: string; fileName: string }> = [];
    let coalescedForwardAttachment = false;
    if (!message.contextKey.startsWith("console:") && !allowsFeishuUser(this.config, message.userId)) {
      this.logger.debug(
        { messageId: message.messageId },
        "Ignored a Feishu message from a non-owner before acknowledgement.",
      );
      return;
    }
    if (
      message.chatType === "group"
      && this.store.chatRequiresMention(baseChatContextKey(message.contextKey))
      && message.mentionedBot !== true
    ) {
      this.logger.debug(
        { messageId: message.messageId, contextKey: message.contextKey },
        "Ignored an unmentioned message from a muted Lark group.",
      );
      return;
    }
    // For accepted messages, claim durable deduplication before acknowledgement so event
    // retries cannot add duplicate reactions.
    if (!this.store.claimInboundEvent(message.messageId, "message")) return;
    const attachmentReservation = message.mergedForwardMessageId
      ? undefined
      : this.reserveForwardAttachment(message);
    const pendingMergedForward = message.mergedForwardMessageId
      ? this.registerPendingForwardAttachment(message, this.pendingMergedForwards)
      : undefined;
    const pendingResourceForward = !attachmentReservation && isStandaloneResourceMessage(message)
      ? this.registerPendingForwardAttachment(message, this.pendingResourceForwards)
      : undefined;
    try {
      const reactionId = await this.outbound.addReaction(
        message.contextKey,
        message.messageId,
        MESSAGE_RECEIVED_REACTION,
      );
      if (reactionId) {
        this.store.saveMessageReaction(message.messageId, message.contextKey, reactionId, MESSAGE_RECEIVED_REACTION);
      }
    } catch (error) {
      this.logger.warn(
        { error, messageId: message.messageId, contextKey: message.contextKey },
        "Failed to acknowledge the incoming Feishu message with a reaction.",
      );
    }
    if (attachmentReservation && this.completeForwardAttachment(message, attachmentReservation)) {
      this.store.audit(message.contextKey, `${attachmentReservation.sourceKind}_attachment_coalesced`, {
        messageId: message.messageId,
        parentMessageId: message.parentMessageId,
      });
      return;
    }
    if (message.chatType === "p2p" && message.userId?.startsWith("ou_")) {
      try {
        await this.lifecycle?.rememberFeishuUserOpenId?.(message.userId);
      } catch (error) {
        this.logger.warn(
          { error, messageId: message.messageId },
          "Failed to persist the first private-chat Lark user Open ID.",
        );
      }
    }
    if (message.chatId && message.chatType) {
      const chatContextKey = baseChatContextKey(message.contextKey);
      this.store.recordChatContext(chatContextKey, message.chatType);
      this.store.markChatActive(chatContextKey);
    }
    if (pendingResourceForward) {
      const resourceMessage = message;
      const attachment = await this.waitForForwardAttachment(
        message.messageId,
        pendingResourceForward,
        this.pendingResourceForwards,
      );
      if (attachment) {
        coalescedForwardAttachment = true;
        const instruction = normalizeFeishuPostText(attachment.text) || defaultResourcePrompt(resourceMessage);
        forwardedImages = (resourceMessage.images ?? []).map((image) => ({
          messageId: resourceMessage.messageId,
          imageKey: image.imageKey,
        }));
        forwardedFiles = (resourceMessage.files ?? []).map((file) => ({
          messageId: resourceMessage.messageId,
          fileKey: file.fileKey,
          fileName: file.fileName,
        }));
        message = {
          ...attachment,
          text: instruction,
          displayText: instruction,
        };
        this.relatedReactionMessageIds.set(message.messageId, [resourceMessage.messageId]);
      }
    }
    if (message.mergedForwardMessageId) {
      const mergedForwardMessage = message;
      const mergedForwardResult = this.outbound.readMergedForward(
        message.contextKey,
        message.mergedForwardMessageId,
      ).then(
        (content) => ({ content } as const),
        (error: unknown) => ({ error } as const),
      );
      const attachment = pendingMergedForward
        ? await this.waitForForwardAttachment(
            message.messageId,
            pendingMergedForward,
            this.pendingMergedForwards,
          )
        : undefined;
      if (attachment) {
        coalescedForwardAttachment = true;
        const instruction = normalizeFeishuPostText(attachment.text)
          || ((attachment.images?.length ?? 0) > 0 ? "请查看附带的内容。" : "请结合参考聊天记录处理。");
        message = {
          ...attachment,
          text: instruction,
          displayText: instruction,
        };
        this.relatedReactionMessageIds.set(message.messageId, [mergedForwardMessage.messageId]);
      }
      const result = await mergedForwardResult;
      if ("error" in result) {
        const replyTarget = message.replyInThread
          ? { messageId: message.messageId, replyInThread: true as const }
          : undefined;
        await this.finalizeStandaloneMessageReaction(message.messageId, "failed");
        const detail = result.error instanceof Error ? result.error.message : String(result.error);
        await this.outbound.withReplyTarget(
          message.contextKey,
          replyTarget,
          () => this.sendError(message.contextKey, new Error(`无法读取合并转发消息：${detail}`), {
            requestId: message.messageId,
            messageId: message.messageId,
            phase: "merged_forward_read",
          }),
        );
        return;
      }
      const instruction = message.displayText ?? DEFAULT_MERGED_FORWARD_INSTRUCTION;
      forwardedImages = result.content.images;
      forwardedFiles = result.content.files;
      message = {
        ...message,
        displayText: instruction,
        text: mergedForwardPrompt(instruction, result.content.text),
      };
    }
    const referencedMessageId = coalescedForwardAttachment ? undefined : quotedMessageId(message);
    if (referencedMessageId) {
      try {
        const referenced = await this.resolveReferencedMessage(message.contextKey, referencedMessageId);
        const instruction = normalizeFeishuPostText(message.displayText ?? message.text)
          || DEFAULT_REFERENCED_MESSAGE_INSTRUCTION;
        forwardedImages = [...referenced.images, ...forwardedImages];
        forwardedFiles = [...referenced.files, ...forwardedFiles];
        message = {
          ...message,
          displayText: instruction,
          text: referencedMessagePrompt(instruction, referenced.text),
        };
      } catch (error) {
        const replyTarget = message.replyInThread
          ? { messageId: message.messageId, replyInThread: true as const }
          : undefined;
        await this.finalizeStandaloneMessageReaction(message.messageId, "failed");
        const detail = error instanceof Error ? error.message : String(error);
        await this.outbound.withReplyTarget(
          message.contextKey,
          replyTarget,
          () => this.sendError(message.contextKey, new Error(`无法读取引用消息：${detail}`), {
            requestId: message.messageId,
            messageId: message.messageId,
            phase: "referenced_message_read",
          }),
        );
        return;
      }
    }
    const replyTarget = message.replyInThread
      ? { messageId: message.messageId, replyInThread: true as const }
      : undefined;
    const imageReferences = deduplicateImageReferences([
      ...forwardedImages,
      ...(message.images ?? []).map((image) => ({ messageId: message.messageId, imageKey: image.imageKey })),
    ]);
    const fileReferences = deduplicateFileReferences([
      ...forwardedFiles,
      ...(message.files ?? []).map((file) => ({
        messageId: message.messageId,
        fileKey: file.fileKey,
        fileName: file.fileName,
      })),
    ]);
    const imageCount = imageReferences.length;
    const fileCount = fileReferences.length;
    this.store.audit(message.contextKey, "incoming_message", {
      messageId: message.messageId,
      text: message.text,
      ...(imageCount > 0 ? { imageCount } : {}),
      ...(fileCount > 0 ? { fileCount } : {}),
    });
    let localImagePaths: string[] | undefined;
    if (imageCount > 0) {
      try {
        localImagePaths = await Promise.all(imageReferences.map((image) =>
          this.outbound.downloadImage(message.contextKey, image.messageId, image.imageKey)));
      } catch (error) {
        await this.finalizeStandaloneMessageReaction(message.messageId, "failed");
        await this.outbound.withReplyTarget(
          message.contextKey,
          replyTarget,
          () => this.sendError(message.contextKey, error, {
            requestId: message.messageId,
            messageId: message.messageId,
            phase: "image_download",
          }),
        );
        return;
      }
    }
    if (fileCount > 0) {
      try {
        const downloadedFiles = await Promise.all(fileReferences.map(async (file) => ({
          fileName: file.fileName,
          filePath: await this.outbound.downloadFile(
            message.contextKey,
            file.messageId,
            file.fileKey,
            file.fileName,
          ),
        })));
        const instruction = message.text.trim() || defaultResourcePromptFromCounts(imageCount, fileCount);
        message = {
          ...message,
          displayText: message.displayText ?? instruction,
          text: appendDownloadedFiles(instruction, downloadedFiles),
        };
      } catch (error) {
        await this.finalizeStandaloneMessageReaction(message.messageId, "failed");
        await this.outbound.withReplyTarget(
          message.contextKey,
          replyTarget,
          () => this.sendError(message.contextKey, error, {
            requestId: message.messageId,
            messageId: message.messageId,
            phase: "file_download",
          }),
        );
        return;
      }
    }
    let command: Command;
    try {
      const resourceCount = imageCount + fileCount;
      command = resourceCount > 0 && !message.text.trimStart().startsWith("/")
        ? { type: "prompt", text: message.text.trim() || defaultResourcePromptFromCounts(imageCount, fileCount) }
        : this.router.parse(message.text);
    } catch (error) {
      await this.finalizeStandaloneMessageReaction(message.messageId, "failed");
      await this.outbound.withReplyTarget(
        message.contextKey,
        replyTarget,
        () => this.sendError(message.contextKey, error, {
          requestId: message.messageId,
          messageId: message.messageId,
          phase: "command_parse",
        }),
      );
      return;
    }
    if (command.type !== "prompt") {
      this.logger.info(
        {
          requestId: message.messageId,
          messageId: message.messageId,
          contextKey: message.contextKey,
          command: command.type,
        },
        "Processing Agent Bot command.",
      );
    }
    // Operational and read-only commands must remain available even if a prompt operation is slow.
    if (isQueueIndependentCommand(command)) {
      await this.outbound.withReplyTarget(message.contextKey, replyTarget, async () => {
        try {
          if (command.type === "prompt") await this.ensureThreadFork(message);
          await this.execute(
            message.contextKey,
            command,
            message.messageId,
            replyTarget,
            localImagePaths,
            message.userId,
            message,
          );
          if (!commandDefersReactionFinalization(command)) {
            await this.finalizeStandaloneMessageReaction(message.messageId, "completed");
          }
        } catch (error) {
          await this.finalizeStandaloneMessageReaction(message.messageId, "failed");
          await this.sendError(message.contextKey, error, {
            requestId: message.messageId,
            messageId: message.messageId,
            command: command.type,
            phase: "command_execute",
          });
        }
      });
      return;
    }

    const previous = this.messageQueues.get(message.contextKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() =>
      this.outbound.withReplyTarget(message.contextKey, replyTarget, async () => {
        try {
          let executableCommand = command;
          let executableImagePaths = localImagePaths;
          let executableMessage = message;
          let injectedRootMessageId: string | undefined;
          if (command.type === "prompt") {
            await this.ensureThreadFork(message);
            const prepared = await this.prepareTopicRootPrompt(message, command.text, localImagePaths);
            executableCommand = { ...command, text: prepared.text };
            executableImagePaths = prepared.localImagePaths;
            executableMessage = { ...message, displayText: prepared.displayPrompt };
            injectedRootMessageId = prepared.injectedRootMessageId;
          }
          await this.execute(
            message.contextKey,
            executableCommand,
            message.messageId,
            replyTarget,
            executableImagePaths,
            message.userId,
            executableMessage,
          );
          if (injectedRootMessageId) {
            const current = this.currentSession(message.contextKey);
            if (current) {
              this.store.audit(message.contextKey, "topic_root_injected", {
                localSessionId: current.localSessionId,
                rootMessageId: injectedRootMessageId,
                promptMessageId: message.messageId,
              });
            }
          }
          if (!commandDefersReactionFinalization(command)) {
            await this.finalizeStandaloneMessageReaction(message.messageId, "completed");
          }
        } catch (error) {
          await this.finalizeStandaloneMessageReaction(message.messageId, "failed");
          await this.sendError(message.contextKey, error, {
            requestId: message.messageId,
            messageId: message.messageId,
            command: command.type,
            phase: "command_execute",
          });
        }
      }),
    );
    this.messageQueues.set(message.contextKey, next);
    await next;
    if (this.messageQueues.get(message.contextKey) === next) this.messageQueues.delete(message.contextKey);
  }

  async onCardAction(action: CardAction): Promise<void> {
    if (!allowsFeishuUser(this.config, action.userId)) {
      this.logger.debug(
        { actionId: action.actionId },
        "Ignored a Feishu card action from a non-owner.",
      );
      return;
    }
    if (!this.store.claimInboundEvent(action.actionId, "card_action")) return;
    let resolvedAction: CardAction;
    try {
      resolvedAction = this.resolveCardActionBinding(action);
    } catch (error) {
      await this.sendError(action.contextKey, error, {
        requestId: action.actionId,
        actionId: action.actionId,
        phase: "card_action_resolve",
      });
      return;
    }
    const contextKey = this.cardActionContextKey(resolvedAction);
    const scopedAction = contextKey === resolvedAction.contextKey
      ? resolvedAction
      : { ...resolvedAction, contextKey };
    const replyTarget = isThreadContextKey(contextKey) && action.messageId
      ? { messageId: action.messageId, replyInThread: true as const }
      : undefined;

    await this.outbound.withReplyTarget(contextKey, replyTarget, async () => {
      try {
        const kind = String(scopedAction.value.action ?? "");
        if (kind === "help_command") {
          await this.executeHelpCommandAction(scopedAction, contextKey, replyTarget);
        } else if (kind === "turn_details") {
          await this.outbound.showDetails(contextKey, String(scopedAction.value.turnId ?? ""));
        } else if (kind === "activity_history") {
          const requestedPage = String(scopedAction.value.page ?? "0");
          const numericPage = Number(requestedPage);
          await this.outbound.showActivityPage(
            contextKey,
            String(scopedAction.value.turnId ?? ""),
            requestedPage === "latest" ? "latest" : Number.isFinite(numericPage) ? numericPage : 0,
            requiredCardMessageId(scopedAction.messageId),
          );
        } else if (kind === "turn_cancel") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.cancelSession(this.requireSession(contextKey, sessionId));
        } else if (kind === "shell_command_cancel") {
          await this.cancelShellCommandJob(
            contextKey,
            String(scopedAction.value.jobId ?? ""),
          );
        } else if (kind === "thread_writer_close") {
          await this.closeThreadWriter(scopedAction, contextKey);
        } else if (kind === "thread_writer_fork") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          const threadId = String(scopedAction.value.threadId ?? "");
          const record = this.requireSession(contextKey, sessionId);
          if (!threadId || record.remoteSessionId !== threadId) {
            throw new Error("任务占用卡片已经失效，请重新发送消息获取最新状态。");
          }
          await this.forkSessionReference(contextKey, sessionId);
        } else if (kind === "app_server_release_now") {
          await this.releaseAppServerNow(scopedAction);
        } else if (kind === "app_server_release_cancel") {
          await this.cancelAppServerRelease(scopedAction);
        } else if (kind === "turn_reset") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          const turnId = String(scopedAction.value.turnId ?? "");
          if (scopedAction.value.cardView === "reset_history") {
            await this.resetFromHistoryCard(
              contextKey,
              sessionId,
              turnId,
              requiredCardMessageId(scopedAction.messageId),
              resetHistoryPageValue(scopedAction.value.page),
            );
          } else {
            await this.resetCurrentSessionToTurn(contextKey, sessionId, turnId);
          }
        } else if (kind === "turn_reset_page") {
          await this.openResetHistory(contextKey, {
            expectedSessionId: String(scopedAction.value.sessionId ?? ""),
            updateMessageId: requiredCardMessageId(scopedAction.messageId),
            page: resetHistoryPageValue(scopedAction.value.page),
          });
        } else if (kind === "queued_prompt_cancel") {
          await this.cancelQueuedPrompt(scopedAction);
        } else if (kind === "safe_restart_cancel") {
          const scheduleId = Number(scopedAction.value.scheduleId);
          if (!Number.isSafeInteger(scheduleId) || scheduleId <= 0) {
            throw new Error("安全重启卡片无效，请使用最新的状态卡片。");
          }
          if (!this.lifecycle?.cancelSafeRestart) {
            throw new Error("当前运行方式不支持取消安全重启。");
          }
          const cancelled = await this.lifecycle.cancelSafeRestart(scheduleId);
          if (!cancelled) {
            await this.outbound.sendText(contextKey, "该安全重启计划已失效，请查看最新状态卡片。");
          }
        } else if (kind === "directory_open" || kind === "directory_page") {
          await this.openDirectoryBrowser(
            contextKey,
            directoryActionPath(scopedAction.value.directory),
            {
              updateMessageId: requiredCardMessageId(scopedAction.messageId),
              page: kind === "directory_page" ? directoryPageValue(scopedAction.value.page) : 0,
            },
          );
        } else if (kind === "directory_send_file") {
          const filePath = directoryFileActionPath(scopedAction.value.filePath);
          await this.assertSendableFile(filePath);
          await this.outbound.sendFile(contextKey, filePath);
        } else if (kind === "directory_new_folder_prompt") {
          const directory = directoryActionPath(scopedAction.value.directory);
          await this.assertBrowsableDirectory(directory);
          await this.outbound.updateInteractiveCard(
            contextKey,
            requiredCardMessageId(scopedAction.messageId),
            this.cardRenderer.renderDirectoryNewFolderCard({
              directory,
              displayDirectory: abbreviateHomeDirectory(directory),
              contextKey,
              page: directoryPageValue(scopedAction.value.page),
            }),
          );
        } else if (kind === "directory_new_folder_submit") {
          await this.createDirectoryFromCard(contextKey, scopedAction);
        } else if (kind === "directory_new_folder_cancel") {
          await this.openDirectoryBrowser(
            contextKey,
            directoryActionPath(scopedAction.value.directory),
            {
              updateMessageId: requiredCardMessageId(scopedAction.messageId),
              page: directoryPageValue(scopedAction.value.page),
            },
          );
        } else if (kind === "directory_new" || kind === "directory_new_group") {
          const directory = directoryActionPath(scopedAction.value.directory);
          await this.assertBrowsableDirectory(directory);
          await this.execute(
            contextKey,
            kind === "directory_new"
              ? { type: "new", cwd: directory }
              : { type: "newgroup", cwd: directory },
            undefined,
            replyTarget,
            undefined,
            scopedAction.userId,
          );
        } else if (kind === "session_page") {
          await this.refreshSessionsCardFromAction(scopedAction);
        } else if (kind === "session_switch") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.switchSession(contextKey, sessionId);
          if (scopedAction.value.cardView === "status") await this.refreshStatusCardFromAction(scopedAction);
          else await this.refreshSessionsCardFromAction(scopedAction, { page: 0 });
        } else if (kind === "session_fork") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.forkSessionReference(contextKey, sessionId);
          await this.refreshSessionsCardFromAction(scopedAction, { page: 0 });
        } else if (kind === "session_fork_group") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.forkSessionReferenceToFeishuGroup(contextKey, sessionId, scopedAction.userId);
          await this.refreshSessionsCardFromAction(scopedAction);
        } else if (kind === "session_new") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.createProjectSessionFromReference(contextKey, sessionId);
          await this.refreshSessionsCardFromAction(scopedAction, { page: 0 });
        } else if (kind === "session_new_group") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.createFeishuGroupFromReference(contextKey, sessionId, scopedAction.userId);
          await this.refreshSessionsCardFromAction(scopedAction);
        } else if (kind === "session_archive") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.archiveSessionReference(contextKey, sessionId, {
            announce: true,
            source: "sessions_card",
          });
          await this.refreshSessionsCardFromAction(scopedAction);
        } else if (kind === "group_dismiss_keep") {
          this.assertDismissGroupRequester(scopedAction);
          await this.outbound.updateInteractiveCard(
            contextKey,
            requiredCardMessageId(scopedAction.messageId),
            this.cardRenderer.renderDismissGroupKept(),
          );
        } else if (kind === "group_dismiss_confirm") {
          this.assertDismissGroupRequester(scopedAction);
          await this.dismissGroupAndArchiveTask(
            contextKey,
            String(scopedAction.value.sessionId ?? ""),
            "command",
          );
        } else if (kind === "session_stop") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.stopSessionReference(contextKey, sessionId);
          if (scopedAction.value.cardView === "status") await this.refreshStatusCardFromAction(scopedAction, sessionId);
          else await this.refreshSessionsCardFromAction(scopedAction, { forceSwitchTaskId: sessionId });
        } else if (kind === "session_status") {
          await this.status(contextKey, String(scopedAction.value.sessionId ?? ""));
        } else if (kind === "session_status_refresh") {
          await this.refreshStatusCardFromAction(scopedAction);
        } else if (kind === "settings_tab_open") {
          await this.openExecutionSettings(contextKey, executionSettingsTabValue(scopedAction.value.tab), {
            sessionId: String(scopedAction.value.sessionId ?? ""),
            updateMessageId: scopedAction.messageId,
          });
        } else if (kind === "settings_agent_select") {
          await this.setDefaultAgent(contextKey, String(scopedAction.value.agent ?? ""), {
            sessionId: String(scopedAction.value.sessionId ?? ""),
            updateMessageId: scopedAction.messageId,
          });
        } else if (kind === "settings_provider_select") {
          await this.selectProvider(contextKey, String(scopedAction.value.provider ?? ""), {
            sessionId: String(scopedAction.value.sessionId ?? ""),
            updateMessageId: scopedAction.messageId,
          });
        } else if (kind === "settings_model_select") {
          await this.model(contextKey, String(scopedAction.value.model ?? ""), {
            sessionId: String(scopedAction.value.sessionId ?? ""),
            updateMessageId: scopedAction.messageId,
          });
        } else if (kind === "settings_thinking_select") {
          await this.thinking(contextKey, String(scopedAction.value.effort ?? ""), {
            sessionId: String(scopedAction.value.sessionId ?? ""),
            updateMessageId: scopedAction.messageId,
            expectedModel: String(scopedAction.value.model ?? ""),
          });
        } else if (kind === "settings_permission_select") {
          await this.permissions(contextKey, permissionModeValue(scopedAction.value.permissionMode), {
            sessionId: String(scopedAction.value.sessionId ?? ""),
            updateMessageId: scopedAction.messageId,
          });
        } else if (kind === "model_select") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          const model = String(scopedAction.value.model ?? "");
          await this.model(contextKey, model, {
            sessionId,
            updateMessageId: scopedAction.messageId,
          });
        } else if (kind === "model_open") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.model(contextKey, undefined, {
            sessionId,
            updateMessageId: scopedAction.messageId,
          });
        } else if (kind === "reasoning_select") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          const model = String(scopedAction.value.model ?? "");
          const effort = String(scopedAction.value.effort ?? "");
          await this.thinking(contextKey, effort, {
            sessionId,
            updateMessageId: scopedAction.messageId,
            expectedModel: model,
          });
        } else if (kind === "provider_open") {
          await this.openExecutionSettings(contextKey, "provider", {
            sessionId: String(scopedAction.value.sessionId ?? ""),
            updateMessageId: scopedAction.messageId,
          });
        } else if (kind === "provider_select" || kind === "provider_model_open") {
          await this.openProviderModelSelector(
            contextKey,
            String(scopedAction.value.provider ?? ""),
            permissionModeValue(scopedAction.value.permissionMode),
            String(scopedAction.value.sessionId ?? ""),
            requiredCardMessageId(scopedAction.messageId),
          );
        } else if (kind === "provider_model_select" || kind === "provider_reasoning_open") {
          await this.openProviderReasoningSelector(
            contextKey,
            String(scopedAction.value.provider ?? ""),
            String(scopedAction.value.model ?? ""),
            permissionModeValue(scopedAction.value.permissionMode),
            String(scopedAction.value.sessionId ?? ""),
            requiredCardMessageId(scopedAction.messageId),
          );
        } else if (kind === "provider_reasoning_select") {
          await this.openProviderPermissionSelector(
            contextKey,
            String(scopedAction.value.provider ?? ""),
            String(scopedAction.value.model ?? ""),
            String(scopedAction.value.effort ?? ""),
            permissionModeValue(scopedAction.value.permissionMode),
            String(scopedAction.value.sessionId ?? ""),
            requiredCardMessageId(scopedAction.messageId),
          );
        } else if (kind === "provider_permission_select") {
          await this.applyProviderSettings(
            contextKey,
            {
              provider: String(scopedAction.value.provider ?? ""),
              model: String(scopedAction.value.model ?? ""),
              effort: String(scopedAction.value.effort ?? ""),
              mode: permissionModeValue(scopedAction.value.permissionMode),
            },
            {
              sessionId: String(scopedAction.value.sessionId ?? ""),
              updateMessageId: scopedAction.messageId,
            },
          );
        } else if (kind === "approval") {
          await this.resolveApproval(scopedAction);
        }
      } catch (error) {
        await this.sendError(contextKey, error, {
          requestId: scopedAction.actionId,
          actionId: scopedAction.actionId,
          command: String(scopedAction.value.action ?? "unknown"),
          phase: "card_action_execute",
        });
      }
    });
  }

  async onChatUpdated(event: ChatUpdatedEvent): Promise<void> {
    const contextKey = `chat_id:${event.chatId}`;
    const previous = this.messageQueues.get(contextKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.syncTaskTitleFromGroupName(contextKey, event));
    this.messageQueues.set(contextKey, next);
    try {
      await next;
    } finally {
      if (this.messageQueues.get(contextKey) === next) this.messageQueues.delete(contextKey);
    }
  }

  close(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.unsubscribe.length = 0;
    this.lastSessionListings.clear();
    this.queuedPromptCards.clear();
    this.queuedPromptCardWrites.clear();
    this.sessionResets.clear();
    this.resetHistoryOperations.clear();
    this.remoteTurnHistoryRefreshes.clear();
    for (const pending of this.pendingMergedForwards.values()) pending.resolveAttachment(undefined);
    this.pendingMergedForwards.clear();
    for (const pending of this.pendingResourceForwards.values()) pending.resolveAttachment(undefined);
    this.pendingResourceForwards.clear();
    this.relatedReactionMessageIds.clear();
    for (const timer of this.queuedPromptRetryTimers.values()) clearTimeout(timer);
    this.queuedPromptRetryTimers.clear();
    for (const timer of this.recoveryRetryTimers.values()) clearTimeout(timer);
    this.recoveryRetryTimers.clear();
    for (const schedule of this.appServerReleaseSchedules.values()) {
      if (schedule.timer) clearTimeout(schedule.timer);
    }
    this.appServerReleaseSchedules.clear();
    for (const [jobId] of this.shellCommandJobMonitors) this.stopShellCommandJobMonitor(jobId);
    clearInterval(this.recoveryActivityHeartbeat);
  }

  async controlStopTask(localSessionId: string): Promise<string> {
    const record = this.store.getSession(localSessionId);
    if (!record || record.status === "closed") throw new Error(`Task not found: ${localSessionId}`);
    await this.cancelSession(record);
    return `Task stop requested: ${record.title ?? record.remoteSessionId ?? record.localSessionId}`;
  }

  async controlReleaseTask(localSessionId: string): Promise<ControlTaskReleaseResult> {
    const record = this.requireControlSession(localSessionId);
    const contextKey = this.controlSessionContextKey(record);
    const result = await this.outbound.withReplyTarget(
      contextKey,
      this.controlSessionReplyTarget(record),
      () => this.requestAppServerRelease(contextKey, record),
    );
    if (result.status === "failed") throw new Error(result.error ?? "Failed to release App Server tasks.");
    return {
      agentName: result.agentName,
      status: result.status,
      blockingTaskCount: result.blockingTaskCount,
    };
  }

  async controlArchiveTask(localSessionId: string): Promise<{
    localSessionId: string;
    remoteSessionId: string;
    title: string;
  }> {
    const record = this.requireControlSession(localSessionId);
    return this.archiveSessionReference(this.controlSessionContextKey(record), localSessionId, {
      announce: false,
      source: "cli",
    });
  }

  async controlDismissTask(localSessionId: string): Promise<{
    localSessionId: string;
    remoteSessionId: string;
    title: string;
    chatId: string;
  }> {
    const record = this.store.getSession(localSessionId);
    if (!record) throw new Error(`Task not found: ${localSessionId}`);
    return this.dismissGroupAndArchiveTask(
      this.controlSessionContextKey(record),
      localSessionId,
      "cli",
    );
  }

  async controlGetTaskStatus(localSessionId: string): Promise<{
    session: SessionRecord;
    snapshot?: TurnViewState;
    remote?: RemoteSessionSummary;
  }> {
    const record = this.store.getSession(localSessionId);
    if (!record) throw new Error(`Task not found: ${localSessionId}`);
    let remote: RemoteSessionSummary | undefined;
    if (record.remoteSessionId) {
      const runtime = this.runtimes.forAgent(record.agentName);
      if (runtime.readRemoteSession) {
        try {
          remote = await runtime.readRemoteSession(record.remoteSessionId);
        } catch (error) {
          this.logger.warn({ error, sessionId: record.localSessionId }, "Failed to inspect App Server task status for CLI.");
        }
      }
    }
    const session = mergeRemoteTaskStatus(record, remote);
    const snapshot = session.lastTurnId
      ? turnViewSnapshot(this.store.getTurnSnapshot(session.lastTurnId))
      : undefined;
    return { session, snapshot, remote };
  }

  async controlSetTaskTitle(localSessionId: string, title: string): Promise<string> {
    const normalizedTitle = normalizeTaskTitle(title);
    if (!normalizedTitle) throw new Error("The task title cannot be empty.");
    const record = this.store.getSession(localSessionId);
    if (!record || record.status === "closed") throw new Error(`Task not found: ${localSessionId}`);
    const loaded = await this.loadSession(record);
    if (loaded.runtime.setTitle) await loaded.runtime.setTitle(record.localSessionId, normalizedTitle);
    else loaded.session.title = normalizedTitle;
    this.store.updateRuntimeSession(record.localSessionId, { title: normalizedTitle });
    this.outbound.updateSessionTitle(record.localSessionId, normalizedTitle);
    this.store.audit(record.contextKey, "session_title_changed", {
      localSessionId: record.localSessionId,
      title: normalizedTitle,
      source: "cli",
    });
    return `Task title changed to: ${normalizedTitle}`;
  }

  async controlSendTaskPrompt(localSessionId: string, text: string): Promise<string> {
    const promptText = text.trim();
    if (!promptText) throw new Error("The Prompt cannot be empty.");
    const record = this.store.getSession(localSessionId);
    if (!record || record.status === "closed") throw new Error(`Task not found: ${localSessionId}`);
    const runtime = this.runtimes.forAgent(record.agentName);
    const activeTurnId = runtime.getSession(localSessionId)?.activeTurnId;
    const routedContextKey = this.outbound.getSessionContextKey(localSessionId);
    const responseContextKey = (activeTurnId ? this.store.getTurnContextKey(activeTurnId) ?? routedContextKey : undefined)
      ?? (record.lastTurnId ? this.store.getTurnContextKey(record.lastTurnId) : undefined)
      ?? routedContextKey
      ?? record.contextKey;
    const lastSnapshot = record.lastTurnId
      ? turnViewSnapshot(this.store.getTurnSnapshot(record.lastTurnId))
      : undefined;
    const activeSnapshot = activeTurnId
      ? turnViewSnapshot(this.store.getTurnSnapshot(activeTurnId))
      : undefined;
    const routedReplyTarget = this.outbound.getSessionReplyTarget(localSessionId);
    const existingReplyTarget = activeSnapshot?.replyTarget
      ?? (activeTurnId ? routedReplyTarget : undefined)
      ?? lastSnapshot?.replyTarget
      ?? routedReplyTarget;
    if (isThreadContextKey(responseContextKey) && !existingReplyTarget) {
      throw new Error("Could not resolve the target task's thread reply location. The Prompt was not sent.");
    }
    const scopedRecord = this.store.getSessionForContext(localSessionId, responseContextKey)
      ?? { ...record, contextKey: responseContextKey };
    const previous = this.messageQueues.get(responseContextKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      this.outbound.registerSession(
        scopedRecord.localSessionId,
        responseContextKey,
        scopedRecord.title,
        scopedRecord.cwd,
        this.agentLabel(scopedRecord.agentName),
      );
      const promptMessageId = await this.outbound.withReplyTarget(
        responseContextKey,
        existingReplyTarget,
        () => this.outbound.sendText(responseContextKey, promptText),
      );
      const turnReplyTarget = isThreadContextKey(responseContextKey)
        ? promptMessageId
          ? { messageId: promptMessageId, replyInThread: true as const }
          : existingReplyTarget
        : undefined;
      await this.promptSession(scopedRecord, responseContextKey, promptText, undefined, turnReplyTarget);
      this.store.audit(responseContextKey, "task_prompt_sent", {
        localSessionId,
        source: "cli",
      });
    });
    this.messageQueues.set(responseContextKey, next);
    try {
      await next;
    } finally {
      if (this.messageQueues.get(responseContextKey) === next) this.messageQueues.delete(responseContextKey);
    }
    return `The Prompt was posted to the original chat and submitted to the task: ${record.title ?? record.remoteSessionId ?? record.localSessionId}`;
  }

  async controlCreateTaskGroup(
    localSessionId: string,
    requestedTitle: string | undefined,
    userOpenId: string | undefined,
    requestedProjectCwd?: string,
    forceProjectless = false,
    requestedAgentName?: string,
  ): Promise<ControlTaskGroupResult> {
    const source = this.store.getSession(localSessionId);
    if (!source || source.status === "closed") throw new Error(`Task not found: ${localSessionId}`);
    const agentName = requestedAgentName?.trim() || source.agentName;
    const agent = this.ensureAgent(agentName);
    if (forceProjectless && agent.kind !== "app-server") {
      throw new Error("task newgroup --nodir is only available for App Server agents.");
    }
    const sourceContextKey = this.outbound.getSessionContextKey(localSessionId) ?? source.contextKey;
    const replyTarget = this.outbound.getSessionReplyTarget(localSessionId);
    const boundProjectCwd = forceProjectless
      ? undefined
      : requestedProjectCwd === undefined
        ? detectProjectlessWorkspace(source.cwd) ? undefined : source.cwd
        : resolveUserPath(requestedProjectCwd);
    const created = await this.outbound.withReplyTarget(sourceContextKey, replyTarget, () =>
      this.createFeishuGroupWithTask(
        sourceContextKey,
        agentName,
        requestedTitle,
        userOpenId,
        boundProjectCwd,
        source.agentName === agentName
          ? {
              modelProvider: source.modelProvider,
              model: source.model,
              reasoningEffort: source.reasoningEffort,
              permissionMode: source.permissionMode,
            }
          : {},
      ));
    return {
      sourceLocalSessionId: source.localSessionId,
      group: created.group,
      task: created.task,
    };
  }

  async controlForkTaskGroup(
    localSessionId: string,
    requestedTitle: string | undefined,
    userOpenId: string | undefined,
  ): Promise<ControlTaskGroupResult> {
    const source = this.store.getSession(localSessionId);
    if (!source || source.status === "closed") throw new Error(`Task not found: ${localSessionId}`);
    const sourceContextKey = this.outbound.getSessionContextKey(localSessionId) ?? source.contextKey;
    const replyTarget = this.outbound.getSessionReplyTarget(localSessionId);
    const plan = await this.prepareForkSession(sourceContextKey, localSessionId, requestedTitle);
    const prepared: ForkGroupSessionPlan = {
      plan,
      sourceDescription: plan.forkedFromHistoricalTurn
        ? "当前任务最近已完成轮次"
        : "当前任务最新轮次",
    };
    const forked = await this.outbound.withReplyTarget(sourceContextKey, replyTarget, () =>
      this.forkPreparedSessionToFeishuGroup(
        sourceContextKey,
        prepared,
        userOpenId ?? "",
        "当前任务",
      ));
    return {
      sourceLocalSessionId: source.localSessionId,
      sourceTurnId: plan.lastTurnId,
      group: forked.group,
      task: forked.task,
    };
  }

  async controlCreateTask(
    localSessionId: string,
    requestedTitle?: string,
    requestedProjectCwd?: string,
    forceProjectless = false,
    requestedAgentName?: string,
  ): Promise<SessionRecord> {
    const source = this.requireControlSession(localSessionId);
    const contextKey = this.controlSessionContextKey(source);
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    const agentName = requestedAgentName?.trim() || context.defaultAgent;
    const agent = this.ensureAgent(agentName);
    if (forceProjectless && agent.kind !== "app-server") {
      throw new Error("task new --nodir is only available for App Server agents.");
    }
    const replyTarget = this.controlSessionReplyTarget(source);
    const cwd = forceProjectless
      ? undefined
      : requestedProjectCwd === undefined
        ? detectProjectlessWorkspace(source.cwd)
          ? agent.kind === "app-server" ? undefined : createProjectlessWorkspace().cwd
          : source.cwd
        : resolveUserPath(requestedProjectCwd, source.cwd);
    const settings: SessionExecutionSettings = source.agentName === agentName
      ? {
          modelProvider: source.modelProvider,
          model: source.model,
          reasoningEffort: source.reasoningEffort,
          permissionMode: source.permissionMode,
        }
      : {};
    return this.outbound.withReplyTarget(contextKey, replyTarget, () =>
      this.createSession(
        contextKey,
        agentName,
        cwd,
        true,
        false,
        undefined,
        undefined,
        requestedTitle,
        settings,
      ));
  }

  async controlForkTask(localSessionId: string): Promise<{
    sourceLocalSessionId: string;
    sourceTurnId: string;
    task: SessionRecord;
  }> {
    const source = this.requireControlSession(localSessionId);
    const contextKey = this.controlSessionContextKey(source);
    const replyTarget = this.controlSessionReplyTarget(source);
    const plan = await this.prepareForkSession(contextKey, source.localSessionId);
    const forked = await this.outbound.withReplyTarget(contextKey, replyTarget, async () => {
      const result = await this.forkSessionIntoContext(contextKey, plan);
      await this.outbound.sendText(
        contextKey,
        `已从指定任务${plan.forkedFromHistoricalTurn ? "最近已完成轮次" : ""}创建分支并切换到新任务：${
          result.session.title
            ? `${result.session.title}（${result.session.remoteSessionId}）`
            : result.session.remoteSessionId
        }`,
      );
      return result;
    });
    return {
      sourceLocalSessionId: source.localSessionId,
      sourceTurnId: plan.lastTurnId,
      task: this.store.getSession(forked.record.localSessionId) ?? forked.record,
    };
  }

  async controlSwitchTask(
    localSessionId: string,
    targetLocalSessionId?: string,
    previous = false,
  ): Promise<SessionRecord> {
    const anchor = this.requireControlSession(localSessionId);
    const contextKey = this.controlSessionContextKey(anchor);
    const replyTarget = this.controlSessionReplyTarget(anchor);
    const target = previous ? undefined : targetLocalSessionId ?? anchor.localSessionId;
    await this.outbound.withReplyTarget(contextKey, replyTarget, () => this.switchSession(contextKey, target));
    return this.requireCurrentSession(contextKey);
  }

  async controlQueueTaskPrompt(localSessionId: string, text: string): Promise<{ promptId: string; queued: number }> {
    const promptText = text.trim();
    if (!promptText) throw new Error("The queued Prompt cannot be empty.");
    const record = this.requireControlSession(localSessionId);
    const contextKey = this.controlSessionContextKey(record);
    const replyTarget = this.controlSessionReplyTarget(record);
    const queued = this.persistQueuedPrompt(record.localSessionId, contextKey, promptText, { replyTarget });
    this.store.audit(contextKey, "queued_prompt_added", {
      promptId: queued.promptId,
      localSessionId: record.localSessionId,
      source: "cli",
    });
    const queuedCount = this.store.countQueuedPrompts(record.localSessionId);
    await this.scheduleNextQueuedPrompt(record.localSessionId);
    return { promptId: queued.promptId, queued: queuedCount };
  }

  controlTaskAgent(localSessionId: string, agentName?: string): {
    current: string;
    agents: Array<{ name: string; title: string }>;
  } {
    const record = this.requireControlSession(localSessionId);
    const contextKey = this.controlSessionContextKey(record);
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    if (agentName) {
      this.ensureAgent(agentName);
      this.store.setDefaultAgent(contextKey, agentName);
    }
    return {
      current: agentName ?? context.defaultAgent,
      agents: Object.entries(this.config.agents).map(([name, agent]) => ({ name, title: agent.title })),
    };
  }

  async controlTaskSettings(
    localSessionId: string,
    setting?: "provider" | "model" | "thinking" | "permissions",
    value?: string,
  ): Promise<{
    session: SessionRecord;
    providers: Awaited<ReturnType<NonNullable<AgentRuntime["listModelProviders"]>>>;
    models: Awaited<ReturnType<AgentRuntime["listModels"]>>;
    reasoningOptions: Awaited<ReturnType<AgentRuntime["listModels"]>>[number]["supportedReasoningEfforts"];
    permissionModes: PermissionMode[];
  }> {
    const record = this.requireControlSession(localSessionId);
    const loaded = await this.loadSession(record);
    if (setting && !value?.trim()) throw new Error(`task ${setting} requires a value.`);
    const nextValue = value?.trim();
    if (setting === "provider" && nextValue) {
      await this.assertModelProvider(loaded, nextValue);
      const models = await loaded.runtime.listModels();
      const model = models.find((candidate) => candidate.id === loaded.session.model)
        ?? models.find((candidate) => candidate.isDefault);
      if (!model) throw new Error("The current runtime has no model available for a Provider change.");
      const effort = model.supportedReasoningEfforts.some(
        (candidate) => candidate.value === loaded.session.reasoningEffort,
      )
        ? loaded.session.reasoningEffort
        : model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0]?.value;
      if (!effort) throw new Error(`Model ${model.id} has no reasoning effort available for a Provider change.`);
      if (!loaded.runtime.setExecutionSettings) throw new Error("The current runtime does not support Provider settings.");
      const updated = await loaded.runtime.setExecutionSettings(record.localSessionId, {
        modelProvider: nextValue,
        model: model.id,
        reasoningEffort: effort,
        permissionMode: loaded.session.permissionMode,
      });
      this.store.updateRuntimeSession(record.localSessionId, {
        modelProvider: updated.modelProvider ?? nextValue,
        model: updated.model ?? model.id,
        reasoningEffort: updated.reasoningEffort ?? effort,
        permissionMode: updated.permissionMode,
      });
    } else if (setting === "model" && nextValue) {
      const models = await loaded.runtime.listModels();
      const selected = models.find((candidate) => candidate.id === nextValue);
      if (!selected) throw new Error(`Unknown model: ${nextValue}`);
      const currentEffort = loaded.session.reasoningEffort;
      const nextEffort = currentEffort && selected.supportedReasoningEfforts.some(
        (candidate) => candidate.value === currentEffort,
      )
        ? currentEffort
        : selected.defaultReasoningEffort;
      await loaded.runtime.setModel(record.localSessionId, nextValue);
      if (nextEffort && nextEffort !== currentEffort) {
        await loaded.runtime.setReasoningEffort(record.localSessionId, nextEffort);
      }
      this.store.updateRuntimeSession(record.localSessionId, { model: nextValue, reasoningEffort: nextEffort });
    } else if (setting === "thinking" && nextValue) {
      const models = await loaded.runtime.listModels();
      const currentModel = models.find((candidate) => candidate.id === loaded.session.model)
        ?? models.find((candidate) => candidate.isDefault);
      if (!currentModel) throw new Error("The current runtime has no model with configurable reasoning effort.");
      if (!currentModel.supportedReasoningEfforts.some((candidate) => candidate.value === nextValue)) {
        const supported = currentModel.supportedReasoningEfforts.map((candidate) => candidate.value).join(", ") || "none";
        throw new Error(`Unsupported reasoning effort: ${nextValue}. Supported values: ${supported}.`);
      }
      await loaded.runtime.setReasoningEffort(record.localSessionId, nextValue);
      this.store.updateRuntimeSession(record.localSessionId, { reasoningEffort: nextValue });
    } else if (setting === "permissions" && nextValue) {
      if (nextValue !== "auto" && nextValue !== "confirm") {
        throw new Error("task permissions accepts auto or confirm.");
      }
      await loaded.runtime.setPermissionMode(record.localSessionId, nextValue);
      this.store.updateRuntimeSession(record.localSessionId, { permissionMode: nextValue });
    }
    const session = this.store.getSession(record.localSessionId) ?? record;
    if (setting) await this.persistAgentExecutionDefaults(session.localSessionId);
    const models = await loaded.runtime.listModels();
    const currentModel = models.find((candidate) => candidate.id === session.model)
      ?? models.find((candidate) => candidate.isDefault);
    const providers = loaded.runtime.listModelProviders
      ? await loaded.runtime.listModelProviders()
      : [];
    return {
      session,
      providers,
      models,
      reasoningOptions: currentModel?.supportedReasoningEfforts ?? [],
      permissionModes: ["auto", "confirm"],
    };
  }

  async controlTaskGoal(
    localSessionId: string,
    action: "show" | "set" | "edit" | "pause" | "resume" | "clear",
    objective?: string,
  ): Promise<{ goal?: RuntimeGoal; cleared?: boolean }> {
    const record = this.requireControlSession(localSessionId);
    const loaded = await this.loadSession(record);
    if (loaded.runtime.kind !== "codex" || !loaded.runtime.getGoal || !loaded.runtime.setGoal || !loaded.runtime.clearGoal) {
      throw new Error("The current Agent does not support Goal mode.");
    }
    if (action === "show") return { goal: await loaded.runtime.getGoal(record.localSessionId) };
    if (action === "clear") return { cleared: await loaded.runtime.clearGoal(record.localSessionId) };
    const current = await loaded.runtime.getGoal(record.localSessionId);
    if (action === "pause" || action === "resume") {
      if (!current) throw new Error("The task has no Goal.");
      return { goal: await loaded.runtime.setGoal(record.localSessionId, { status: action === "pause" ? "paused" : "active" }) };
    }
    const nextObjective = objective?.trim();
    if (!nextObjective) throw new Error(`task goal ${action} requires an objective.`);
    validateGoalObjective(nextObjective);
    if (action === "set" && current && current.status !== "complete") {
      throw new Error("The task already has an unfinished Goal. Use task goal <task> edit <objective>, or clear it first.");
    }
    if (action === "edit" && !current) throw new Error("The task has no Goal to edit.");
    return {
      goal: await loaded.runtime.setGoal(record.localSessionId, {
        objective: nextObjective,
        status: action === "edit" ? current!.status : "active",
        ...(action === "edit" ? { tokenBudget: current!.tokenBudget } : {}),
      }),
    };
  }

  controlListTaskTurns(localSessionId: string): {
    session: SessionRecord;
    turns: Array<{
      sequence: number;
      turnId: string;
      parentTurnId?: string;
      prompt?: string;
      startedAt?: number;
      completedAt?: number;
      current: boolean;
    }>;
  } {
    const session = this.requireControlSession(localSessionId);
    if (!session.remoteSessionId || !this.isCodexSession(session)) {
      throw new Error("The task is not an App Server task that can be reset.");
    }
    const rows = this.store.listTaskTurnGraph(session.localSessionId);
    const graph = buildTurnGraphRows(rows.map((turn) => ({ turnId: turn.turnId, parentTurnId: turn.parentTurnId })));
    return {
      session,
      turns: rows.flatMap((turn, index) => {
        const snapshot = turnViewSnapshot(turn.snapshot);
        if (!snapshot) return [];
        return [{
          sequence: graph[index]!.sequence,
          turnId: turn.turnId,
          parentTurnId: turn.parentTurnId,
          prompt: snapshot.prompt ?? snapshot.taskTitle,
          startedAt: snapshot.startedAt,
          completedAt: snapshot.completedAt,
          current: session.lastTurnId === turn.turnId && session.lastTurnStatus === "completed",
        }];
      }),
    };
  }

  async controlResetTaskToTurn(localSessionId: string, turnId: string): Promise<SessionRecord> {
    const record = this.requireControlSession(localSessionId);
    const contextKey = this.controlSessionContextKey(record);
    const previous = this.sessionResets.get(record.localSessionId) ?? Promise.resolve();
    const reset = previous.catch(() => undefined).then(() =>
      this.performSessionReset(contextKey, record, turnId, false));
    this.sessionResets.set(record.localSessionId, reset);
    try {
      await reset;
    } finally {
      if (this.sessionResets.get(record.localSessionId) === reset) this.sessionResets.delete(record.localSessionId);
    }
    return this.store.getSession(record.localSessionId) ?? record;
  }

  controlTaskMute(localSessionId: string, enabled?: boolean): { contextKey: string; enabled: boolean } {
    const record = this.requireControlSession(localSessionId);
    const contextKey = baseChatContextKey(this.controlSessionContextKey(record));
    const chat = this.store.getChatContext(contextKey);
    if (chat?.chatType !== "group") throw new Error("task mute is only available for group chats.");
    const next = enabled ?? Boolean(chat.requiresMention);
    if (enabled !== undefined) this.store.setChatRequiresMention(contextKey, enabled);
    return { contextKey, enabled: next };
  }

  async controlRunTaskShell(localSessionId: string, command: string): Promise<ShellCommandResult & {
    cwd: string;
    command: string;
  }> {
    const record = this.requireControlSession(localSessionId);
    const normalized = command.trim();
    if (!normalized) throw new Error("task shell requires a command.");
    return { ...await this.shellCommandExecutor(normalized, record.cwd), cwd: record.cwd, command: normalized };
  }

  async controlListTaskDirectory(
    localSessionId: string,
    requestedDirectory?: string,
    requestedPage = 0,
  ): Promise<{
    directory: string;
    parentDirectory?: string;
    page: number;
    totalPages: number;
    totalEntries: number;
    entries: Array<{
      name: string;
      path: string;
      kind: "directory" | "image" | "binary" | "file" | "drive";
    }>;
  }> {
    const record = this.requireControlSession(localSessionId);
    if (requestedDirectory === WINDOWS_DRIVES_DIRECTORY) {
      const drives = await this.windowsDriveLister();
      const totalPages = Math.max(1, Math.ceil(drives.length / DIRECTORY_PAGE_SIZE));
      const page = Math.min(Math.max(0, Math.trunc(requestedPage)), totalPages - 1);
      return {
        directory: WINDOWS_DRIVES_DIRECTORY,
        page,
        totalPages,
        totalEntries: drives.length,
        entries: drives.slice(page * DIRECTORY_PAGE_SIZE, (page + 1) * DIRECTORY_PAGE_SIZE).map((drive) => ({
          name: windowsDriveDisplayName(drive),
          path: drive.root,
          kind: "drive" as const,
        })),
      };
    }
    const directory = requestedDirectory === undefined
      ? path.resolve(record.cwd)
      : resolveUserPath(requestedDirectory, record.cwd);
    await this.assertBrowsableDirectory(directory);
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .map((entry) => ({
        dirent: entry,
        name: entry.name,
        path: path.join(directory, entry.name),
        kind: entry.isDirectory() ? "directory" as const : "file" as const,
      }))
      .sort((left, right) => Number(right.kind === "directory") - Number(left.kind === "directory")
        || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
    const totalPages = Math.max(1, Math.ceil(entries.length / DIRECTORY_PAGE_SIZE));
    const page = Math.min(Math.max(0, Math.trunc(requestedPage)), totalPages - 1);
    const parentDirectory = isWindowsDriveRoot(directory) ? WINDOWS_DRIVES_DIRECTORY : path.dirname(directory);
    return {
      directory,
      ...(parentDirectory !== directory ? { parentDirectory } : {}),
      page,
      totalPages,
      totalEntries: entries.length,
      entries: entries
        .slice(page * DIRECTORY_PAGE_SIZE, (page + 1) * DIRECTORY_PAGE_SIZE)
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          kind: entry.kind === "directory"
            ? "directory" as const
            : directoryBrowserEntryKind(entry.dirent, entry.path),
        })),
    };
  }

  async controlSendTaskFile(localSessionId: string, requestedFilePath: string): Promise<string | undefined> {
    const record = this.requireControlSession(localSessionId);
    const filePath = resolveUserPath(requestedFilePath, record.cwd);
    await this.assertSendableFile(filePath);
    const contextKey = this.controlSessionContextKey(record);
    const replyTarget = this.controlSessionReplyTarget(record);
    return this.outbound.withReplyTarget(contextKey, replyTarget, () => this.outbound.sendFile(contextKey, filePath));
  }

  private cardActionContextKey(action: CardAction): string {
    const explicit = typeof action.value.contextKey === "string" ? action.value.contextKey : undefined;
    if (explicit && baseChatContextKey(explicit) === baseChatContextKey(action.contextKey)) return explicit;

    const sessionReference = typeof action.value.sessionId === "string" ? action.value.sessionId : undefined;
    const session = sessionReference
      ? this.store.getSession(sessionReference) ?? this.findStoredSessionByReference(sessionReference)
      : undefined;
    if (session && baseChatContextKey(session.contextKey) === baseChatContextKey(action.contextKey)) {
      return session.contextKey;
    }

    const turnId = typeof action.value.turnId === "string" ? action.value.turnId : undefined;
    const snapshot = turnId ? turnViewSnapshot(this.store.getTurnSnapshot(turnId)) : undefined;
    const turnSession = snapshot ? this.store.getSession(snapshot.sessionId) : undefined;
    return turnSession && baseChatContextKey(turnSession.contextKey) === baseChatContextKey(action.contextKey)
      ? turnSession.contextKey
      : action.contextKey;
  }

  private resolveCardActionBinding(action: CardAction): CardAction {
    if (typeof action.value.action === "string") return action;
    const token = typeof action.value.t === "string" ? action.value.t : undefined;
    if (!token) return action;
    if (!action.messageId) throw new Error("任务列表卡片缺少消息 ID，请重新发送 /sessions。");
    const value = this.store.getCardActionBinding(action.messageId, token);
    if (!value) throw new Error("任务列表卡片已失效，请重新发送 /sessions。");
    return { ...action, value };
  }

  private async execute(
    contextKey: string,
    command: Command,
    messageId?: string,
    replyTarget?: MessageReplyTarget,
    localImagePaths?: string[],
    userId?: string,
    incomingMessage?: IncomingMessage,
  ): Promise<void> {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    if (!this.currentSession(contextKey) && isThreadContextKey(contextKey) && commandRequiresCurrentSession(command)) {
      throw new Error(unboundThreadTaskMessage());
    }
    switch (command.type) {
      case "shell":
        await this.runShellCommand(contextKey, command.command, messageId, incomingMessage);
        return;
      case "dir":
        await this.openDirectoryBrowser(contextKey, command.directory);
        return;
      case "file":
        await this.sendCurrentTaskFile(contextKey, command.filePath);
        return;
      case "new":
        if (command.projectless && this.ensureAgent(context.defaultAgent).kind !== "app-server") {
          throw new Error("/new --nodir 仅支持 App Server Agent。");
        }
        await this.createSession(
          contextKey,
          context.defaultAgent,
          command.projectless
            ? undefined
            : command.cwd === undefined
              ? this.inheritedNewTaskCwd(contextKey)
              : resolveUserPath(command.cwd),
          true,
          false,
          undefined,
          undefined,
          command.title,
          this.inheritedExecutionSettings(contextKey, context.defaultAgent),
        );
        return;
      case "newgroup":
        if (command.projectless && this.ensureAgent(context.defaultAgent).kind !== "app-server") {
          throw new Error("/newgroup --nodir 仅支持 App Server Agent。");
        }
        await this.createFeishuGroup(
          contextKey,
          context.defaultAgent,
          command.title,
          userId,
          command.cwd === undefined ? undefined : resolveUserPath(command.cwd),
          command.projectless === true,
        );
        return;
      case "forkgroup":
        await this.forkCurrentSessionToFeishuGroup(contextKey, command.title, userId, incomingMessage);
        return;
      case "fork":
        await this.forkSessionReference(contextKey, command.sessionId);
        return;
      case "title":
        await this.setTitle(contextKey, command.title);
        return;
      case "prompt":
        await this.prompt(
          contextKey,
          command.text,
          messageId,
          replyTarget,
          localImagePaths,
          incomingMessage?.displayText,
        );
        return;
      case "nosteer":
        await this.enqueueNoSteerPrompt(contextKey, command.text, messageId, replyTarget);
        return;
      case "sessions":
        await this.listSessions(contextKey, command.searchTerm);
        return;
      case "switch":
        await this.switchSession(contextKey, command.sessionId);
        return;
      case "agent":
        if (command.agent) await this.setDefaultAgent(contextKey, command.agent);
        else await this.openAgentSettings(contextKey);
        return;
      case "archive": {
        const sessionId = command.sessionId ?? context.currentSessionId;
        if (!sessionId) throw new Error("当前会话没有可归档的任务。请使用 /sessions 查找任务。");
        await this.archiveSessionReference(contextKey, sessionId, {
          announce: true,
          source: "command",
        });
        return;
      }
      case "dismiss":
        await this.openDismissGroupCard(contextKey, userId);
        return;
      case "status":
        await this.status(contextKey, command.sessionId);
        return;
      case "goal":
        await this.goal(contextKey, command);
        return;
      case "restart":
        if (!this.lifecycle) throw new Error("当前运行方式不支持自动重启。");
        await this.lifecycle.restart(contextKey, command.force === true, replyTarget);
        return;
      case "release":
        await this.requestAppServerRelease(contextKey);
        return;
      case "mute":
        await this.setGroupMute(contextKey, command.enabled);
        return;
      case "turns":
        await this.openResetHistory(contextKey);
        return;
      case "model":
        await this.openExecutionSettings(contextKey, "model");
        return;
      case "provider":
        await this.openProviderSettings(contextKey);
        return;
      case "thinking":
        await this.openExecutionSettings(contextKey, "thinking");
        return;
      case "permissions":
        await this.openExecutionSettings(contextKey, "permission");
        return;
      case "help":
        await this.help(contextKey);
        return;
      case "stop":
        await this.cancel(contextKey);
        return;
    }
  }

  private restorePersistedSessionRoutes(): void {
    for (const context of this.store.listUserContexts()) {
      if (!context.currentSessionId) continue;
      const session = this.store.getSessionForContext(context.currentSessionId, context.contextKey);
      if (!session || session.status === "closed") continue;
      const turnContextKey = session.lastTurnId
        ? this.store.getTurnContextKey(session.lastTurnId) ?? context.contextKey
        : context.contextKey;
      if (!this.outbound.canRoute(turnContextKey)) continue;
      this.outbound.registerSession(
        session.localSessionId,
        turnContextKey,
        session.title,
        session.cwd,
        this.agentLabel(session.agentName),
      );
      if (!session.lastTurnId) continue;
      void this.outbound.resumeDelivery(session.localSessionId, turnContextKey, session.lastTurnId).catch((error: unknown) => {
        this.logger.warn({ error, sessionId: session.localSessionId }, "Failed to restore persisted turn delivery.");
      });
    }
    for (const turn of this.store.listUndeliveredCompletedTurns()) {
      const contextKey = turn.contextKey ?? this.store.getSession(turn.localSessionId)?.contextKey;
      if (!contextKey || !this.outbound.canRoute(contextKey)) continue;
      void this.outbound.resumeDelivery(turn.localSessionId, contextKey, turn.turnId).catch((error: unknown) => {
        this.logger.warn(
          { error, sessionId: turn.localSessionId, turnId: turn.turnId },
          "Failed to resume an undelivered completed turn.",
        );
      });
    }
  }

  private restorePersistedQueuedPrompts(): void {
    if (this.queuedPromptsRestored) return;
    this.queuedPromptsRestored = true;
    for (const sessionId of this.store.listQueuedPromptSessionIds()) {
      const firstPrompt = this.store.listQueuedPrompts(sessionId)[0];
      if (firstPrompt && !this.outbound.canRoute(firstPrompt.contextKey)) continue;
      void this.scheduleNextQueuedPrompt(sessionId).catch((error: unknown) => {
        this.logger.warn({ error, sessionId }, "Failed to resume a persisted prompt queue.");
      });
    }
  }

  async recoverInterruptedTasks(): Promise<void> {
    if (this.startupRecovery) return this.startupRecovery;
    const recovery = this.runStartupRecovery();
    this.startupRecovery = recovery;
    return recovery;
  }

  private async runStartupRecovery(): Promise<void> {
    await this.finishPersistedCancellationRequests();
    await this.recoverShellCommandJobs();
    this.backfillTurnAttemptsForUpgrade();
    const attempts = this.store.listIncompleteTurnAttempts();
    const recoveryCutoff = Date.now() - RECOVERY_ACTIVITY_WINDOW_MS;
    const recentAttempts = attempts.filter((attempt) => isRecoveryAttemptRecent(attempt, recoveryCutoff));
    if (recentAttempts.length > 0) {
      this.logger.warn(
        { attemptIds: recentAttempts.map((attempt) => attempt.attemptId) },
        "Recovering unfinished Agent Bot tasks after startup.",
      );
    }
    for (const attempt of attempts) {
      if (!isRecoveryAttemptRecent(attempt, recoveryCutoff)) {
        await this.expireStaleTurnAttempt(attempt);
        continue;
      }
      if (!this.outbound.canRoute(attempt.contextKey)) continue;
      try {
        await this.recoverTurnAttempt(attempt);
      } catch (error) {
        this.logger.error(
          { error, attemptId: attempt.attemptId, sessionId: attempt.localSessionId },
          "Failed to recover an unfinished task; it will be retried while the server is running.",
        );
        this.scheduleRecoveryRetry(attempt.attemptId);
      }
    }
    this.restorePersistedQueuedPrompts();
  }

  private async finishPersistedCancellationRequests(): Promise<void> {
    for (const attempt of this.store.listCancellationRequestedTurnAttempts()) {
      const session = this.store.getSession(attempt.localSessionId);
      if (!attempt.turnId) {
        this.store.updateTurnAttempt(attempt.attemptId, { status: "cancelled" });
        if (session?.status === "starting" || session?.status === "running") {
          this.store.updateSession(session.localSessionId, { status: "ready" });
        }
        continue;
      }
      if (session) {
        this.outbound.registerSession(
          session.localSessionId,
          attempt.contextKey,
          session.title,
          session.cwd,
          this.agentLabel(session.agentName),
        );
      }
      try {
        await this.handleRuntimeEvent({
          type: "turn_cancelled",
          sessionId: attempt.localSessionId,
          turnId: attempt.turnId,
        });
      } catch (error) {
        this.logger.warn(
          { error, attemptId: attempt.attemptId, turnId: attempt.turnId },
          "Failed to finish a persisted user-requested turn cancellation.",
        );
      }
    }
  }

  private backfillTurnAttemptsForUpgrade(): void {
    for (const session of this.store.listAllSessions()) {
      if (session.status !== "starting" && session.status !== "running" && session.status !== "ready") continue;
      if (this.store.findIncompleteTurnAttemptForSession(session.localSessionId)) continue;
      const lastTurn = session.lastTurnId
        ? {
            turnId: session.lastTurnId,
            localSessionId: session.localSessionId,
            contextKey: this.store.getTurnContextKey(session.lastTurnId),
            snapshot: this.store.getTurnSnapshot(session.lastTurnId),
            updatedAt: session.updatedAt,
          }
        : undefined;
      const lastTurnSnapshot = turnViewSnapshot(lastTurn?.snapshot);
      const latestPersisted = this.store.findLatestTurnSnapshotForSession(session.localSessionId);
      const latestPersistedSnapshot = turnViewSnapshot(latestPersisted?.snapshot);
      const latest = lastTurnSnapshot && !isTerminalTurnViewStatus(lastTurnSnapshot.status)
        ? lastTurn
        : latestPersistedSnapshot && !isTerminalTurnViewStatus(latestPersistedSnapshot.status)
          ? latestPersisted
          : session.status === "ready"
            ? undefined
            : lastTurn;
      if (!latest && session.status === "ready") continue;
      const snapshot = turnViewSnapshot(latest?.snapshot);
      if (snapshot && isTerminalTurnViewStatus(snapshot.status)) {
        this.store.updateSession(session.localSessionId, {
          status: snapshot.status === "failed" ? "failed" : "ready",
        });
        continue;
      }
      const persistedTurnId = latest?.turnId;
      const pendingTurnId = persistedTurnId?.startsWith("pending_") ? persistedTurnId : undefined;
      const turnId = pendingTurnId ? undefined : persistedTurnId ?? session.lastTurnId;
      const replyTarget = snapshot?.replyTarget?.replyInThread ? snapshot.replyTarget : undefined;
      this.store.createTurnAttempt({
        attemptId: createId("attempt"),
        localSessionId: session.localSessionId,
        contextKey: latest?.contextKey ?? session.contextKey,
        promptText: snapshot?.prompt?.trim() || "继续完成重启前尚未完成的任务。",
        messageId: turnId ? this.store.findMessageIdForTurn(turnId) : undefined,
        replyMessageId: replyTarget?.messageId,
        pendingTurnId,
        turnId,
        status: turnId ? "running" : "accepted",
        createdAt: latest?.updatedAt ?? session.updatedAt,
        updatedAt: latest?.updatedAt ?? session.updatedAt,
      });
    }
  }

  private async expireStaleTurnAttempt(attempt: TurnAttemptRecord): Promise<void> {
    const session = this.store.getSession(attempt.localSessionId);
    const oldCardTurnId = attempt.pendingTurnId ?? attempt.turnId;
    if (session && oldCardTurnId && this.outbound.canRoute(attempt.contextKey)) {
      await this.outbound.interruptTurnForRecovery(
        session.localSessionId,
        attempt.contextKey,
        oldCardTurnId,
        "执行中断已超过 10 分钟，未自动恢复。",
      ).catch((error: unknown) => {
        this.logger.warn(
          { error, attemptId: attempt.attemptId, turnId: oldCardTurnId },
          "Failed to close an expired interrupted thinking card.",
        );
      });
    }
    this.store.updateTurnAttempt(attempt.attemptId, { status: "interrupted" });
    if (!session || session.status === "closed") return;
    if (attempt.turnId && session.lastTurnId === attempt.turnId) {
      this.store.updateRuntimeSession(session.localSessionId, { lastTurnStatus: "cancelled" });
    }
    if (session.status === "starting" || session.status === "running") {
      this.store.updateSession(session.localSessionId, { status: "ready" });
    }
    if (attempt.turnId && this.outbound.canRoute(attempt.contextKey)) {
      await this.finalizeTurnMessageReactions(attempt.turnId, "cancelled").catch((error: unknown) => {
        this.logger.warn(
          { error, attemptId: attempt.attemptId, turnId: attempt.turnId },
          "Failed to finalize the message reaction for an expired interrupted turn.",
        );
      });
    }
  }

  private persistActiveTurnHeartbeats(): void {
    for (const attempt of this.store.listIncompleteTurnAttempts()) {
      if (!attempt.turnId) continue;
      const session = this.store.getSession(attempt.localSessionId);
      if (!session) continue;
      const activeTurnId = this.runtimes.forAgent(session.agentName).getSession(session.localSessionId)?.activeTurnId;
      if (activeTurnId === attempt.turnId) this.store.touchTurnAttempt(attempt.turnId);
    }
  }

  private async recoverTurnAttempt(attempt: TurnAttemptRecord, announce = true): Promise<void> {
    const session = this.store.getSession(attempt.localSessionId);
    if (!session || session.status === "closed") {
      this.store.updateTurnAttempt(attempt.attemptId, { status: "interrupted" });
      return;
    }
    const contextKey = attempt.contextKey || session.contextKey;
    const replyTarget = attempt.replyMessageId
      ? { messageId: attempt.replyMessageId, replyInThread: true as const }
      : undefined;
    this.outbound.registerSession(
      session.localSessionId,
      contextKey,
      session.title,
      session.cwd,
      this.agentLabel(session.agentName),
    );
    if (announce) {
      await this.outbound.withReplyTarget(contextKey, replyTarget, () =>
        this.outbound.sendText(contextKey, "检测到任务在 Agent Bot 重启前尚未完成，正在自动恢复。"),
      ).catch((error: unknown) => {
        this.logger.warn(
          { error, attemptId: attempt.attemptId, contextKey },
          "Failed to send the task recovery notification.",
        );
        return undefined;
      });
    }

    const runtime = this.runtimes.forAgent(session.agentName);
    const sourceTurnId = attempt.turnId;
    if (runtime.kind === "acp") {
      await this.continueInterruptedAttempt(attempt, session, sourceTurnId, replyTarget);
      return;
    }

    let remote: RemoteSessionSummary | undefined;
    if (session.remoteSessionId && runtime.readRemoteSession) {
      try {
        remote = await runtime.readRemoteSession(session.remoteSessionId);
      } catch (error) {
        this.logger.warn(
          { error, attemptId: attempt.attemptId, remoteSessionId: session.remoteSessionId },
          "Failed to read the remote task during startup recovery; treating the old local execution as interrupted.",
        );
      }
    }
    const remoteTurnBelongsToAttempt = remoteTurnMatchesAttempt(remote, attempt);
    if (remote && remoteTurnBelongsToAttempt && remote.lastTurnStatus === "completed") {
      await this.reconcileRecoveredRemoteTurn(attempt, session, remote.lastTurnId);
      return;
    }
    if (remote && remoteTurnBelongsToAttempt && remote.lastTurnStatus === "failed") {
      await this.reconcileRecoveredRemoteTurn(attempt, session, remote.lastTurnId);
      return;
    }
    if (remote && remoteTurnBelongsToAttempt && isRemoteSessionActive(remote) && remote.lastTurnId) {
      await this.reattachActiveRecoveredTurn(attempt, session, remote.lastTurnId, replyTarget);
      return;
    }
    if (remote && isRemoteSessionActive(remote) && !remoteTurnBelongsToAttempt) {
      this.store.updateTurnAttempt(attempt.attemptId, { status: "recovering" });
      if (announce) {
        await this.outbound.withReplyTarget(contextKey, replyTarget, () =>
          this.outbound.sendText(contextKey, "任务中检测到另一轮仍在执行；本次恢复将在它结束后重试。"),
        );
      }
      this.scheduleRecoveryRetry(attempt.attemptId);
      return;
    }
    await this.continueInterruptedAttempt(attempt, session, sourceTurnId, replyTarget);
  }

  private async reconcileRecoveredRemoteTurn(
    attempt: TurnAttemptRecord,
    session: SessionRecord,
    remoteTurnId: string | undefined,
  ): Promise<void> {
    if (remoteTurnId && !attempt.turnId) {
      this.store.updateTurnAttempt(attempt.attemptId, { turnId: remoteTurnId, status: "running" });
      this.store.updateRuntimeSession(session.localSessionId, {
        lastTurnId: remoteTurnId,
        lastTurnStatus: "running",
      });
    }
    const current = this.store.getSession(session.localSessionId) ?? session;
    const loaded = await this.loadSession({
      ...current,
      contextKey: attempt.contextKey,
      status: "running",
      lastTurnStatus: "running",
    });
    const synchronized = await loaded.runtime.synchronizeSession(session.localSessionId);
    if (synchronized.activeTurnId) this.scheduleRecoveryRetry(attempt.attemptId, synchronized.activeTurnId);
  }

  private scheduleRecoveryRetry(attemptId: string, activeTurnId?: string): void {
    if (this.recoveryRetryTimers.has(attemptId)) return;
    const timer = setTimeout(() => {
      this.recoveryRetryTimers.delete(attemptId);
      const attempt = this.store.getTurnAttempt(attemptId);
      if (!attempt || !isIncompleteTurnAttemptStatus(attempt.status)) return;
      const retry = async (): Promise<void> => {
        let recoveryAttempt = attempt;
        if (activeTurnId) {
          const session = this.store.getSession(attempt.localSessionId);
          if (session) {
            const runtime = this.runtimes.forAgent(session.agentName);
            const synchronized = await runtime.synchronizeSession(session.localSessionId);
            if (synchronized.activeTurnId === activeTurnId) {
              this.scheduleRecoveryRetry(attemptId, activeTurnId);
              return;
            }
            const current = this.store.getTurnAttempt(attemptId);
            if (!current || !isIncompleteTurnAttemptStatus(current.status)) return;
            recoveryAttempt = current;
          }
        }
        await this.recoverTurnAttempt(recoveryAttempt, false);
      };
      void retry().catch((error: unknown) => {
        this.logger.warn(
          { error, attemptId, sessionId: attempt.localSessionId },
          "Failed to retry an unfinished task recovery.",
        );
        this.scheduleRecoveryRetry(attemptId, activeTurnId);
      });
    }, 5_000);
    timer.unref?.();
    this.recoveryRetryTimers.set(attemptId, timer);
  }

  private async reattachActiveRecoveredTurn(
    attempt: TurnAttemptRecord,
    session: SessionRecord,
    turnId: string,
    replyTarget?: MessageReplyTarget,
  ): Promise<void> {
    const oldCardTurnId = attempt.pendingTurnId ?? attempt.turnId;
    if (oldCardTurnId) {
      await this.outbound.interruptTurnForRecovery(
        session.localSessionId,
        attempt.contextKey,
        oldCardTurnId,
        "Agent Bot 已重启，执行仍在继续；进度已转移到新的思考卡片。",
      );
    }
    const pendingTurnId = await this.outbound.startPendingTurn(
      session.localSessionId,
      attempt.contextKey,
      session.title,
      replyTarget,
      recoveryCardPrompt(attempt.promptText),
    );
    this.store.updateTurnAttempt(attempt.attemptId, {
      pendingTurnId: pendingTurnId ?? null,
      turnId,
      status: "running",
    });
    await this.outbound.onEvent({
      type: "turn_started",
      sessionId: session.localSessionId,
      turnId,
      startedAt: Date.now(),
    });
    this.store.updateTurnAttempt(attempt.attemptId, { pendingTurnId: null });
    const current = this.store.getSession(session.localSessionId) ?? session;
    const loaded = await this.loadSession({
      ...current,
      contextKey: attempt.contextKey,
      status: "running",
      lastTurnId: turnId,
      lastTurnStatus: "running",
    });
    const synchronized = await loaded.runtime.synchronizeSession(session.localSessionId);
    if (synchronized.activeTurnId) this.scheduleRecoveryRetry(attempt.attemptId, synchronized.activeTurnId);
  }

  private async continueInterruptedAttempt(
    attempt: TurnAttemptRecord,
    session: SessionRecord,
    sourceTurnId: string | undefined,
    replyTarget?: MessageReplyTarget,
  ): Promise<void> {
    const oldCardTurnId = attempt.pendingTurnId ?? sourceTurnId;
    if (oldCardTurnId) {
      await this.outbound.interruptTurnForRecovery(
        session.localSessionId,
        attempt.contextKey,
        oldCardTurnId,
        "Agent Bot 重启中断了这次执行，正在新的思考卡片中继续。",
      ).catch((error: unknown) => {
        this.logger.warn(
          { error, attemptId: attempt.attemptId, turnId: oldCardTurnId },
          "Failed to close the interrupted thinking card before recovery.",
        );
      });
    }
    this.store.prepareTurnAttemptRecovery(attempt.attemptId, oldCardTurnId);
    this.store.updateSession(session.localSessionId, { status: "ready" });
    if (sourceTurnId) {
      this.store.updateRuntimeSession(session.localSessionId, {
        lastTurnId: sourceTurnId,
        lastTurnStatus: "cancelled",
      });
    }
    const current = this.store.getSession(session.localSessionId) ?? session;
    const loaded = await this.loadSession({ ...current, contextKey: attempt.contextKey });
    const recoveryText = recoveryRuntimePrompt(attempt.promptText);
    const turnId = await this.startTurn(
      loaded,
      recoveryText,
      replyTarget,
      attempt.localImagePaths,
      {
        attemptId: attempt.attemptId,
        messageId: attempt.messageId,
        displayPrompt: recoveryCardPrompt(attempt.promptText),
        preserveAttemptOnFailure: true,
      },
    );
    if (attempt.messageId) await this.bindMessageReactionToTurn(attempt.messageId, session.localSessionId, turnId);
  }

  private async restorePersistedMessageReactions(): Promise<void> {
    const pending = this.store.listPendingMessageReactions();
    const terminalTurns = new Map<string, "completed" | "failed" | "cancelled">();
    for (const reaction of pending) {
      if (!reaction.turnId || !reaction.localSessionId) continue;
      const session = this.store.getSession(reaction.localSessionId);
      if (session?.lastTurnId !== reaction.turnId) continue;
      if (session.lastTurnStatus === "completed" || session.lastTurnStatus === "failed" || session.lastTurnStatus === "cancelled") {
        terminalTurns.set(reaction.turnId, session.lastTurnStatus);
      }
    }
    for (const [turnId, status] of terminalTurns) {
      await this.finalizeTurnMessageReactions(turnId, status);
    }
  }

  private async prompt(
    contextKey: string,
    text: string,
    messageId?: string,
    replyTarget?: MessageReplyTarget,
    localImagePaths?: string[],
    displayPrompt?: string,
  ): Promise<void> {
    if (!text.trim()) throw new Error("请输入要交给 Agent 的内容。");
    let record = this.currentSession(contextKey);
    if (!record) {
      const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
      record = await this.createSession(
        contextKey,
        context.defaultAgent,
        this.inheritedNewTaskCwd(contextKey),
        false,
        true,
        displayPrompt ?? text,
        replyTarget,
      );
    }
    await this.promptSession(record, contextKey, text, messageId, replyTarget, localImagePaths, displayPrompt);
  }

  private async promptSession(
    record: SessionRecord,
    contextKey: string,
    text: string,
    messageId?: string,
    replyTarget?: MessageReplyTarget,
    localImagePaths?: string[],
    displayPrompt?: string,
  ): Promise<void> {
    if (this.llmRetryingSessions.has(record.localSessionId)) {
      const queued = this.persistQueuedPrompt(record.localSessionId, contextKey, text, {
        localImagePaths,
        messageId,
        replyTarget,
        displayPrompt,
      });
      this.store.audit(contextKey, "queued_prompt_added_during_llm_retry", {
        promptId: queued.promptId,
        localSessionId: record.localSessionId,
      });
      await this.presentPromptQueueCard(record.localSessionId, contextKey);
      return;
    }
    const configuredRuntime = this.runtimes.forAgent(record.agentName);
    if (!configuredRuntime.getSession(record.localSessionId)) {
      this.outbound.registerSession(
        record.localSessionId,
        contextKey,
        record.title,
        record.cwd,
        this.agentLabel(record.agentName),
      );
      await this.outbound.startPendingTurn(
        record.localSessionId,
        contextKey,
        record.title,
        replyTarget,
        displayPrompt ?? text,
      );
    }
    let loaded: LoadedSession;
    try {
      loaded = await this.loadSession(record);
    } catch (error) {
      if (await this.presentThreadWriterConflict(record, contextKey, error, true)) {
        throw new PresentedRequestError(error);
      }
      await this.outbound.failPendingTurn(record.localSessionId, error instanceof Error ? error.message : String(error));
      throw error;
    }
    let remoteActivity: RemoteSessionActivity | undefined;
    try {
      remoteActivity = await this.assertSessionTurnOwnership(loaded.record, loaded.runtime);
    } catch (error) {
      await this.outbound.failPendingTurn(record.localSessionId, error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (needsFullSessionSynchronization(loaded.record, loaded.session, remoteActivity)) {
      try {
        loaded.session = await loaded.runtime.synchronizeSession(record.localSessionId);
      } catch (error) {
        this.logger.warn({ error, sessionId: record.localSessionId }, "Failed to synchronize session before prompt.");
      }
    }
    const activeTurnId = loaded.session.activeTurnId;
    if (activeTurnId) {
      const activeContextKey = this.store.getTurnContextKey(activeTurnId);
      if (activeContextKey && activeContextKey !== contextKey) {
        this.persistQueuedPrompt(record.localSessionId, contextKey, text, {
          localImagePaths,
          messageId,
          replyTarget,
          displayPrompt,
        });
        return;
      }
      try {
        await loaded.runtime.steerTurn(record.localSessionId, activeTurnId, runtimePrompt(text, localImagePaths));
        await this.presentSteerMessage(record.localSessionId, activeTurnId, displayPrompt ?? text, messageId);
        if (messageId) await this.bindMessageReactionToTurn(messageId, record.localSessionId, activeTurnId);
        return;
      } catch (error) {
        this.logger.debug({ error, sessionId: record.localSessionId, activeTurnId }, "Steering failed; reconciling the App Server thread.");
        let current = loaded.runtime.getSession(record.localSessionId);
        try {
          current = await loaded.runtime.synchronizeSession(record.localSessionId);
        } catch (syncError) {
          this.logger.warn({ error: syncError, sessionId: record.localSessionId }, "Failed to synchronize after steering failure.");
        }
        if (!current?.activeTurnId) {
          const turnId = await this.startTurn(loaded, text, replyTarget, localImagePaths, { messageId, displayPrompt });
          if (messageId) await this.bindMessageReactionToTurn(messageId, record.localSessionId, turnId);
          return;
        }
        if (current.activeTurnId !== activeTurnId) {
          try {
            await loaded.runtime.steerTurn(
              record.localSessionId,
              current.activeTurnId,
              runtimePrompt(text, localImagePaths),
            );
            await this.presentSteerMessage(
              record.localSessionId,
              current.activeTurnId,
              displayPrompt ?? text,
              messageId,
            );
            if (messageId) await this.bindMessageReactionToTurn(messageId, record.localSessionId, current.activeTurnId);
            return;
          } catch (retryError) {
            this.logger.warn(
              { error: retryError, sessionId: record.localSessionId, activeTurnId: current.activeTurnId },
              "Failed to steer the reconciled App Server turn; queueing prompt.",
            );
          }
        }
        this.persistQueuedPrompt(record.localSessionId, contextKey, text, {
          localImagePaths,
          messageId,
          replyTarget,
          displayPrompt,
        });
        return;
      }
    }
    const turnId = await this.startTurn(loaded, text, replyTarget, localImagePaths, { messageId, displayPrompt });
    if (messageId) await this.bindMessageReactionToTurn(messageId, record.localSessionId, turnId);
  }

  private async presentSteerMessage(
    localSessionId: string,
    turnId: string,
    text: string,
    messageId?: string,
  ): Promise<void> {
    this.store.touchTurnAttempt(turnId);
    try {
      await this.outbound.appendSteerMessage(localSessionId, turnId, text, messageId);
    } catch (error) {
      this.logger.warn(
        { error, sessionId: localSessionId, turnId, messageId },
        "Failed to insert a steer message into the thinking card.",
      );
    }
  }

  private async enqueueNoSteerPrompt(
    contextKey: string,
    text: string,
    messageId?: string,
    replyTarget?: MessageReplyTarget,
  ): Promise<void> {
    const record = this.requireCurrentSession(contextKey);
    const queued = this.persistQueuedPrompt(record.localSessionId, contextKey, text, { messageId, replyTarget });
    this.store.audit(contextKey, "queued_prompt_added", {
      promptId: queued.promptId,
      localSessionId: record.localSessionId,
    });
    await this.presentPromptQueueCard(record.localSessionId, contextKey);
    await this.scheduleNextQueuedPrompt(record.localSessionId);
  }

  private persistQueuedPrompt(
    localSessionId: string,
    contextKey: string,
    text: string,
    options: {
      localImagePaths?: string[];
      messageId?: string;
      replyTarget?: MessageReplyTarget;
      displayPrompt?: string;
    } = {},
  ): QueuedPromptRecord {
    return this.store.enqueuePrompt({
      promptId: createId("prompt"),
      localSessionId,
      contextKey,
      text,
      localImagePaths: options.localImagePaths,
      messageId: options.messageId,
      replyMessageId: options.replyTarget?.messageId,
      displayPrompt: options.displayPrompt,
    });
  }

  private async cancelQueuedPrompt(action: CardAction): Promise<void> {
    const promptId = String(action.value.promptId ?? "");
    const sessionId = String(action.value.sessionId ?? "");
    if (!promptId || !sessionId) throw new Error("无效的排队 Prompt 取消请求。");
    this.requireSession(action.contextKey, sessionId);
    if (action.messageId) this.rememberPromptQueueCard(sessionId, action.contextKey, action.messageId);
    const cancelled = this.store.cancelQueuedPrompt(promptId, sessionId);
    if (cancelled?.messageId) await this.finalizeStandaloneMessageReaction(cancelled.messageId, "cancelled");
    if (cancelled) {
      this.store.audit(action.contextKey, "queued_prompt_cancelled", {
        promptId,
        localSessionId: sessionId,
      });
    }
    await this.refreshPromptQueueCards(sessionId);
  }

  private async presentPromptQueueCard(localSessionId: string, contextKey: string): Promise<void> {
    await this.serializePromptQueueCardWrite(localSessionId, async () => {
      const cards = this.queuedPromptCards.get(localSessionId);
      const existing = cards?.get(contextKey);
      if (existing) {
        try {
          await this.outbound.updateInteractiveCard(
            contextKey,
            existing,
            this.renderPromptQueueCard(localSessionId, contextKey, "superseded"),
          );
        } catch (error) {
          this.logger.warn(
            { error, localSessionId, contextKey, messageId: existing },
            "Failed to stop the previous prompt queue card; sending a replacement.",
          );
        }
        cards?.delete(contextKey);
        if (cards?.size === 0) this.queuedPromptCards.delete(localSessionId);
      }
      const messageId = await this.outbound.sendInteractiveCard(
        contextKey,
        this.renderPromptQueueCard(localSessionId, contextKey),
      );
      if (messageId) this.rememberPromptQueueCard(localSessionId, contextKey, messageId);
    });
  }

  private async refreshPromptQueueCards(localSessionId: string): Promise<void> {
    await this.serializePromptQueueCardWrite(localSessionId, async () => {
      const cards = this.queuedPromptCards.get(localSessionId);
      if (!cards) return;
      await Promise.all([...cards].map(async ([contextKey, messageId]) => {
        try {
          await this.outbound.updateInteractiveCard(
            contextKey,
            messageId,
            this.renderPromptQueueCard(localSessionId, contextKey),
          );
        } catch (error) {
          this.logger.warn({ error, localSessionId, contextKey, messageId }, "Failed to refresh prompt queue card.");
        }
      }));
    });
  }

  private renderPromptQueueCard(
    localSessionId: string,
    contextKey: string,
    phase: "active" | "superseded" = "active",
  ): Record<string, unknown> {
    return this.cardRenderer.renderPromptQueue({
      sessionId: localSessionId,
      contextKey,
      phase,
      prompts: this.store.listQueuedPrompts(localSessionId).map((prompt) => ({
        id: prompt.promptId,
        text: prompt.displayPrompt ?? prompt.text,
      })),
    });
  }

  private rememberPromptQueueCard(localSessionId: string, contextKey: string, messageId: string): void {
    const cards = this.queuedPromptCards.get(localSessionId) ?? new Map<string, string>();
    cards.set(contextKey, messageId);
    this.queuedPromptCards.set(localSessionId, cards);
  }

  private serializePromptQueueCardWrite(localSessionId: string, write: () => Promise<void>): Promise<void> {
    const previous = this.queuedPromptCardWrites.get(localSessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(write);
    this.queuedPromptCardWrites.set(localSessionId, next);
    return next.finally(() => {
      if (this.queuedPromptCardWrites.get(localSessionId) === next) this.queuedPromptCardWrites.delete(localSessionId);
    });
  }

  private async ensureThreadFork(message: IncomingMessage): Promise<void> {
    if (!message.threadContext || !message.threadId || !message.chatId) return;
    const current = this.store.getUserContext(message.contextKey)?.currentSessionId;
    if (current && this.store.getSession(current)) return;
    const hasPersistedSourceTurn = threadForkAnchorMessageIds(message)
      .some((messageId) => this.store.findTurnAnchorByMessageId(messageId) !== undefined);
    if (!hasPersistedSourceTurn) return;

    const existing = this.threadInitializations.get(message.contextKey);
    if (existing) return existing;
    const initialization = this.forkThreadSession(message);
    this.threadInitializations.set(message.contextKey, initialization);
    try {
      await initialization;
    } finally {
      if (this.threadInitializations.get(message.contextKey) === initialization) {
        this.threadInitializations.delete(message.contextKey);
      }
    }
  }

  private async prepareTopicRootPrompt(
    message: IncomingMessage,
    text: string,
    localImagePaths?: string[],
  ): Promise<PreparedTopicRootPrompt> {
    const displayPrompt = message.displayText ?? text;
    const rootMessageId = topicRootMessageId(message);
    if (!rootMessageId) return { text, localImagePaths, displayPrompt };

    const current = this.currentSession(message.contextKey);
    if (current && (
      this.store.hasInjectedTopicRoot(current.localSessionId, rootMessageId)
      || this.taskHistoryContainsMessage(current, rootMessageId)
    )) {
      return { text, localImagePaths, displayPrompt };
    }

    try {
      const root = await this.resolveReferencedMessage(message.contextKey, rootMessageId);
      const rootImagePaths = await Promise.all(root.images.map((image) =>
        this.outbound.downloadImage(message.contextKey, image.messageId, image.imageKey)));
      let promptText = topicRootMessagePrompt(text, root.text);
      if (root.files.length > 0) {
        const downloadedFiles = await Promise.all(root.files.map(async (file) => ({
          fileName: file.fileName,
          filePath: await this.outbound.downloadFile(
            message.contextKey,
            file.messageId,
            file.fileKey,
            file.fileName,
          ),
        })));
        promptText = appendDownloadedFiles(promptText, downloadedFiles);
      }
      const combinedImagePaths = [...new Set([...(localImagePaths ?? []), ...rootImagePaths])];
      return {
        text: promptText,
        ...(combinedImagePaths.length > 0 ? { localImagePaths: combinedImagePaths } : {}),
        displayPrompt,
        injectedRootMessageId: rootMessageId,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`无法读取话题根消息：${detail}`);
    }
  }

  private taskHistoryContainsMessage(record: SessionRecord, messageId: string): boolean {
    const anchor = this.store.findTurnAnchorByMessageId(messageId);
    if (!anchor) return false;
    if (record.lastTurnId === anchor.turnId) return true;
    return this.store.hasTaskHistoryTurn(record.localSessionId, anchor.turnId);
  }

  private async forkThreadSession(message: IncomingMessage): Promise<void> {
    const { anchor, source, snapshot } = this.resolveThreadForkAnchor(message);
    const agent = this.ensureAgent(source.agentName);
    const runtime = this.runtimes.forAgent(source.agentName);
    if (runtime.kind !== "codex" || !runtime.forkSession) {
      throw new Error("当前 App Server Agent 不支持 fork 任务。");
    }

    const context = this.store.getOrCreateUserContext(message.contextKey, source.agentName);
    if (context.currentSessionId && this.store.getSession(context.currentSessionId)) return;

    const forkTitle = this.store.nextForkTitle(source.title);
    const localSessionId = createId("sess");
    const record = this.store.createSession({
      localSessionId,
      contextKey: message.contextKey,
      agentName: source.agentName,
      cwd: source.cwd,
      status: "starting",
    });
    this.store.updateRuntimeSession(localSessionId, {
      runtimeKind: "codex",
      title: forkTitle,
      modelProvider: source.modelProvider,
      model: source.model,
      reasoningEffort: source.reasoningEffort,
      permissionMode: source.permissionMode ?? "auto",
    });
    this.store.setCurrentSession(message.contextKey, localSessionId);
    this.outbound.registerSession(
      localSessionId,
      message.contextKey,
      forkTitle,
      source.cwd,
      this.agentLabel(source.agentName),
    );

    try {
      const forked = await runtime.forkSession({
        localSessionId,
        remoteSessionId: source.remoteSessionId!,
        lastTurnId: anchor.turnId,
        agentName: source.agentName,
        cwd: source.cwd,
        title: forkTitle,
        modelProvider: source.modelProvider,
        model: source.model,
        reasoningEffort: source.reasoningEffort,
        permissionMode: source.permissionMode ?? "auto",
      });
      this.persistRuntimeSession(record, forked, "ready");
      this.store.updateRuntimeSession(localSessionId, {
        lastTurnId: anchor.turnId,
        lastTurnStatus: forkedTurnStatus(snapshot?.status),
      });
      this.store.audit(message.contextKey, "thread_forked", {
        threadId: message.threadId,
        sourceMessageId: message.rootMessageId ?? message.parentMessageId,
        sourceLocalSessionId: source.localSessionId,
        sourceRemoteSessionId: source.remoteSessionId,
        sourceTurnId: anchor.turnId,
        forkedLocalSessionId: localSessionId,
        forkedRemoteSessionId: forked.remoteSessionId,
      });
    } catch (error) {
      this.store.updateSession(localSessionId, { status: "failed" });
      this.store.setCurrentSession(message.contextKey, undefined);
      this.outbound.unregisterSession(localSessionId);
      throw error;
    }
  }

  private resolveThreadForkAnchor(message: IncomingMessage): ResolvedThreadForkAnchor {
    if (!message.threadContext || !message.threadId || !message.chatId) {
      throw new Error("当前消息不属于可识别的飞书话题。");
    }
    const anchor = threadForkAnchorMessageIds(message)
      .map((messageId) => this.store.findTurnAnchorByMessageId(messageId))
      .find((candidate) => candidate !== undefined);
    if (!anchor) {
      throw new Error("无法确定这个话题对应的 App Server 轮次，因此没有创建分支任务。请从该轮的用户消息、思考卡片或最终回答创建话题。");
    }

    const source = anchor.contextKey
      ? this.store.getSessionForContext(anchor.localSessionId, anchor.contextKey)
      : this.store.getSession(anchor.localSessionId);
    if (!source || !source.remoteSessionId || !this.isCodexSession(source)) {
      throw new Error("这个话题的来源不是可 fork 的 App Server 任务。");
    }
    if (baseChatContextKey(anchor.contextKey ?? source.contextKey) !== `chat_id:${message.chatId}`) {
      throw new Error("话题来源任务不属于当前会话，已拒绝创建分支。");
    }

    const snapshot = turnViewSnapshot(this.store.getTurnSnapshot(anchor.turnId));
    if (isTurnStillRunning(snapshot?.status)
      || (source.lastTurnId === anchor.turnId && source.lastTurnStatus === "running")) {
      throw new Error("话题对应的轮次仍在执行，App Server 暂时不能从这一轮 fork。请等待该轮完成后再在话题中发送消息。");
    }

    return { anchor, source, snapshot };
  }

  private async forkSessionReference(contextKey: string, reference?: string): Promise<void> {
    const plan = await this.prepareForkSession(contextKey, reference);
    const forked = await this.forkSessionIntoContext(contextKey, plan);
    const forkSourceLabel = plan.forkedFromHistoricalTurn
      ? `${plan.sourceLabel}最近已完成轮次`
      : plan.sourceLabel;
    await this.outbound.sendText(
      contextKey,
      `已从${forkSourceLabel}创建分支并切换到新任务：${
        forked.session.title
          ? `${forked.session.title}（${forked.session.remoteSessionId}）`
          : forked.session.remoteSessionId
      }`,
    );
  }

  private async prepareForkSession(
    contextKey: string,
    reference?: string,
    requestedTitle?: string,
  ): Promise<ForkSessionPlan> {
    const sourceLabel = reference === undefined ? "当前任务" : "指定任务";
    const taskId = reference === undefined ? undefined : this.resolveSessionReference(contextKey, reference);
    let source: SessionRecord | undefined;
    if (taskId === undefined) {
      source = this.requireCurrentSession(contextKey);
    } else {
      const direct = this.store.getSession(taskId);
      if (direct?.status === "closed") {
        throw new Error(`找不到任务：${taskId}`);
      }
      const global = direct ?? this.findStoredSessionByReference(taskId);
      source = global ? { ...global, contextKey } : undefined;
    }

    if (source && (!source.remoteSessionId || !this.isCodexSession(source))) {
      throw new Error(`${sourceLabel}不是可 fork 的 App Server 任务。`);
    }

    let runtime: AgentRuntime;
    let agentName: string;
    let remote: RemoteSessionSummary | undefined;
    if (source) {
      agentName = source.agentName;
      runtime = this.runtimes.forAgent(agentName);
    } else {
      if (!taskId) throw new Error("缺少要 fork 的 App Server 任务 ID。");
      const resolved = await this.resolveRemoteCodexSession(taskId, { forFork: true });
      agentName = resolved.agentName;
      runtime = resolved.runtime;
      remote = resolved.remote;
    }
    if (runtime.kind !== "codex" || !runtime.forkSession) {
      throw new Error("当前 App Server Agent 不支持 fork 任务。");
    }

    const remoteSessionId = source?.remoteSessionId ?? remote?.id ?? taskId;
    if (!remoteSessionId) throw new Error("当前任务尚未创建 App Server 任务 ID，暂时不能 fork。");
    if (!runtime.readRemoteSession && !source) {
      throw new Error("当前 App Server Agent 不支持读取指定任务。");
    }
    const persistedCompletedTurns = source ? this.localForkCompletedTurns(source) : [];
    const sourceLastSnapshot = turnViewSnapshot(
      source?.lastTurnId ? this.store.getTurnSnapshot(source.lastTurnId) : undefined,
    );
    const localCompletedTurns = persistedCompletedTurns.length > 0
      ? persistedCompletedTurns
      : source?.lastTurnId
          && (source.lastTurnStatus === "completed" || sourceLastSnapshot?.status === "completed")
        ? [{
            id: source.lastTurnId,
            prompt: latestUserPromptFromTurnView(sourceLastSnapshot) ?? source.title,
            startedAt: sourceLastSnapshot?.startedAt ?? parseIsoTimestamp(source.updatedAt),
            completedAt: sourceLastSnapshot?.completedAt
              ?? sourceLastSnapshot?.startedAt
              ?? parseIsoTimestamp(source.updatedAt),
          }]
        : [];
    if (!remote && runtime.readRemoteSession && (!source || persistedCompletedTurns.length === 0)) {
      try {
        remote = await runtime.readRemoteSession(remoteSessionId);
      } catch (error) {
        if (localCompletedTurns.length === 0) throw error;
        this.logger.warn(
          { error, contextKey, remoteSessionId, sourceTurnId: localCompletedTurns.at(-1)?.id },
          "Failed to read the complete source task before Fork; using the locally persisted completed Turn.",
        );
      }
    }
    const latestTurnId = remote?.lastTurnId ?? source?.lastTurnId ?? localCompletedTurns.at(-1)?.id;
    const latestSnapshot = turnViewSnapshot(latestTurnId ? this.store.getTurnSnapshot(latestTurnId) : undefined);
    const isRunning = remote
      ? isRemoteSessionActive(remote)
      : Boolean(
        (source && runtime.getSession(source.localSessionId)?.activeTurnId)
        || source?.lastTurnStatus === "running"
        || isTurnStillRunning(latestSnapshot?.status),
      );
    const lastTurnId = remote?.lastCompletedTurnId
      ?? (remote?.lastTurnStatus === "completed" ? remote.lastTurnId : undefined)
      ?? localCompletedTurns.at(-1)?.id;
    if (!lastTurnId) {
      if (isRunning) {
        throw new Error(`${sourceLabel}正在执行，且还没有已完成轮次可供 fork。请等待当前轮次完成后重试。`);
      }
      throw new Error(`${sourceLabel}还没有可供 fork 的轮次。请先完成至少一轮对话。`);
    }
    const snapshot = turnViewSnapshot(this.store.getTurnSnapshot(lastTurnId));
    const forkedFromHistoricalTurn = lastTurnId !== latestTurnId;
    const completedTurn = (remote?.completedTurns ?? localCompletedTurns)
      .find((turn) => turn.id === lastTurnId);

    const cwd = remote?.cwd || source?.cwd;
    if (!cwd) throw new Error("指定的 App Server 任务没有可用的工作目录，暂时不能 fork。");
    const sourceTitle = remote?.title ?? source?.title ?? remote?.preview;
    const forkTitle = normalizeTaskTitle(requestedTitle) ?? this.store.nextForkTitle(sourceTitle);
    const modelProvider = remote?.modelProvider ?? source?.modelProvider;
    const model = remote?.model ?? source?.model;
    const reasoningEffort = source?.reasoningEffort;
    const permissionMode = source?.permissionMode ?? "auto";
    const sourceTurnPrompt = truncateText(
      latestUserPromptFromTurnView(snapshot)
        ?? completedTurn?.prompt
        ?? (lastTurnId === latestTurnId ? remote?.lastUserPrompt : undefined)
        ?? remote?.preview
        ?? source?.title
        ?? remote?.title
        ?? "Fork 来源轮次",
      1_000,
    );
    const sourceTurnCompletedAt = snapshot?.completedAt
      ?? snapshot?.startedAt
      ?? completedTurn?.completedAt
      ?? completedTurn?.startedAt
      ?? (lastTurnId === latestTurnId
        ? latestRemoteTimestamp(remote?.recencyAt, remote?.updatedAt)
        : undefined)
      ?? parseIsoTimestamp(source?.updatedAt);

    return {
      source,
      sourceLabel,
      runtime,
      agentName,
      remoteSessionId,
      lastTurnId,
      cwd,
      forkTitle,
      modelProvider,
      model,
      reasoningEffort,
      permissionMode,
      lastTurnStatus: "completed",
      sourceTurnPrompt,
      sourceTurnStartedAt: snapshot?.startedAt ?? sourceTurnCompletedAt,
      sourceTurnCompletedAt,
      sourceCompletedTurns: remote?.completedTurns
        ?? (persistedCompletedTurns.length > 0 ? [] : localCompletedTurns),
      sourceWasRunning: isRunning,
      forkedFromHistoricalTurn,
    };
  }

  private localForkCompletedTurns(source: SessionRecord): RemoteCompletedTurnSummary[] {
    return this.store.listTaskTurnGraph(source.localSessionId)
      .slice()
      .reverse()
      .map((record) => {
        const snapshot = turnViewSnapshot(record.snapshot);
        const startedAt = snapshot?.startedAt ?? parseIsoTimestamp(record.updatedAt);
        return {
          id: record.turnId,
          prompt: latestUserPromptFromTurnView(snapshot),
          startedAt,
          completedAt: snapshot?.completedAt ?? startedAt,
        };
      });
  }

  private async prepareForkGroupSession(
    contextKey: string,
    requestedTitle: string | undefined,
    incomingMessage: IncomingMessage | undefined,
  ): Promise<ForkGroupSessionPlan> {
    if (!incomingMessage?.threadContext) {
      const plan = await this.prepareForkSession(contextKey, undefined, requestedTitle);
      return {
        plan,
        sourceDescription: plan.forkedFromHistoricalTurn
          ? "当前任务最近已完成轮次"
          : "当前任务最新轮次",
      };
    }

    const resolved = this.resolveThreadForkAnchor(incomingMessage);
    const topicSession = this.currentSession(contextKey);
    const topicTurnId = topicSession
      ? this.store.findLatestCompletedTurnId(topicSession.localSessionId, contextKey)
      : undefined;
    if (topicSession && topicTurnId) {
      return {
        plan: this.prepareForkSessionFromTurn(
          topicSession,
          topicTurnId,
          requestedTitle,
          "当前话题任务",
        ),
        sourceDescription: "当前话题任务最近已完成轮次",
      };
    }

    return {
      plan: this.prepareForkSessionFromTurn(
        resolved.source,
        resolved.anchor.turnId,
        requestedTitle,
        "话题原始轮次",
      ),
      sourceDescription: "话题原始轮次",
    };
  }

  private prepareForkSessionFromTurn(
    source: SessionRecord,
    lastTurnId: string,
    requestedTitle: string | undefined,
    sourceLabel: string,
  ): ForkSessionPlan {
    if (!source.remoteSessionId || !this.isCodexSession(source)) {
      throw new Error(`${sourceLabel}不是可 fork 的 App Server 任务。`);
    }
    const runtime = this.runtimes.forAgent(source.agentName);
    if (runtime.kind !== "codex" || !runtime.forkSession) {
      throw new Error("当前 App Server Agent 不支持 fork 任务。");
    }

    const snapshot = turnViewSnapshot(this.store.getTurnSnapshot(lastTurnId));
    if (isTurnStillRunning(snapshot?.status)) {
      throw new Error(`${sourceLabel}仍在执行，App Server 暂时不能从这一轮 fork。`);
    }
    const sourceWasRunning = Boolean(
      runtime.getSession(source.localSessionId)?.activeTurnId
      || source.lastTurnStatus === "running"
      || source.status === "running",
    );
    const forkTitle = normalizeTaskTitle(requestedTitle) ?? this.store.nextForkTitle(source.title);
    const sourceTurnCompletedAt = snapshot?.completedAt
      ?? snapshot?.startedAt
      ?? parseIsoTimestamp(source.updatedAt);

    return {
      source,
      sourceLabel,
      runtime,
      agentName: source.agentName,
      remoteSessionId: source.remoteSessionId,
      lastTurnId,
      cwd: source.cwd,
      forkTitle,
      modelProvider: source.modelProvider,
      model: source.model,
      reasoningEffort: source.reasoningEffort,
      permissionMode: source.permissionMode ?? "auto",
      lastTurnStatus: forkedTurnStatus(snapshot?.status)
        ?? (source.lastTurnId === lastTurnId ? source.lastTurnStatus : undefined)
        ?? "completed",
      sourceTurnPrompt: truncateText(
        latestUserPromptFromTurnView(snapshot) ?? source.title ?? "Fork 来源轮次",
        1_000,
      ),
      sourceTurnStartedAt: snapshot?.startedAt ?? sourceTurnCompletedAt,
      sourceTurnCompletedAt,
      sourceWasRunning,
      forkedFromHistoricalTurn: sourceWasRunning && source.lastTurnId !== lastTurnId,
    };
  }

  private async forkSessionIntoContext(
    contextKey: string,
    plan: ForkSessionPlan,
  ): Promise<ForkSessionResult> {
    const sourceCompletedTurns = await this.resolveForkSourceCompletedTurns(plan);
    const localSessionId = createId("sess");
    const record = this.store.createSession({
      localSessionId,
      contextKey,
      agentName: plan.agentName,
      cwd: plan.cwd,
      status: "starting",
    });
    this.store.updateRuntimeSession(localSessionId, {
      runtimeKind: "codex",
      title: plan.forkTitle,
      modelProvider: plan.modelProvider,
      model: plan.model,
      reasoningEffort: plan.reasoningEffort,
      permissionMode: plan.permissionMode,
    });

    try {
      const forked = await plan.runtime.forkSession!({
        localSessionId,
        remoteSessionId: plan.remoteSessionId,
        lastTurnId: plan.lastTurnId,
        agentName: plan.agentName,
        cwd: plan.cwd,
        title: plan.forkTitle,
        modelProvider: plan.modelProvider,
        model: plan.model,
        reasoningEffort: plan.reasoningEffort,
        permissionMode: plan.permissionMode,
      });
      this.persistRuntimeSession(record, forked, "ready");
      this.store.updateRuntimeSession(localSessionId, {
        lastTurnId: plan.lastTurnId,
        lastTurnStatus: plan.lastTurnStatus,
      });
      this.outbound.registerSession(
        localSessionId,
        contextKey,
        forked.title ?? plan.forkTitle,
        plan.cwd,
        this.agentLabel(plan.agentName),
      );
      const sourceTurnHistoryCount = this.persistForkSourceHistory(
        contextKey,
        localSessionId,
        plan,
        sourceCompletedTurns,
      );
      this.store.audit(contextKey, "session_forked", {
        sourceLocalSessionId: plan.source?.localSessionId,
        sourceRemoteSessionId: plan.remoteSessionId,
        sourceTurnId: plan.lastTurnId,
        sourceTurnPrompt: plan.sourceTurnPrompt,
        sourceTurnStartedAt: plan.sourceTurnStartedAt,
        sourceTurnCompletedAt: plan.sourceTurnCompletedAt,
        sourceTurnHistoryCount,
        sourceWasRunning: plan.sourceWasRunning,
        forkedLocalSessionId: localSessionId,
        forkedRemoteSessionId: forked.remoteSessionId,
      });
      this.store.setCurrentSession(contextKey, localSessionId);
      return {
        record: this.store.getSession(localSessionId) ?? record,
        session: forked,
      };
    } catch (error) {
      this.store.updateSession(localSessionId, { status: "failed" });
      throw error;
    }
  }

  private async resolveForkSourceCompletedTurns(
    plan: ForkSessionPlan,
  ): Promise<RemoteCompletedTurnSummary[]> {
    let completedTurns = plan.sourceCompletedTurns;
    if (completedTurns === undefined && plan.runtime.readRemoteSession) {
      try {
        completedTurns = (await plan.runtime.readRemoteSession(plan.remoteSessionId)).completedTurns ?? [];
      } catch (error) {
        this.logger.warn(
          { error, remoteSessionId: plan.remoteSessionId, sourceTurnId: plan.lastTurnId },
          "Failed to read the source task Turn history before Fork; keeping the Fork anchor fallback.",
        );
      }
    }
    if (!completedTurns?.length) return [];
    const anchorIndex = completedTurns.findIndex((turn) => turn.id === plan.lastTurnId);
    if (anchorIndex < 0) {
      this.logger.warn(
        { remoteSessionId: plan.remoteSessionId, sourceTurnId: plan.lastTurnId },
        "The source task Turn history did not include the Fork anchor; keeping the Fork anchor fallback.",
      );
      return [];
    }
    return completedTurns.slice(0, anchorIndex + 1);
  }

  private persistForkSourceHistory(
    contextKey: string,
    forkedLocalSessionId: string,
    plan: ForkSessionPlan,
    completedTurns: RemoteCompletedTurnSummary[],
  ): number {
    if (completedTurns.length === 0) return 0;
    const localSessionId = plan.source?.localSessionId ?? forkedLocalSessionId;
    const historyContextKey = plan.source?.contextKey ?? contextKey;
    const fallbackStart = plan.sourceTurnStartedAt
      ?? plan.sourceTurnCompletedAt
      ?? Date.now() - completedTurns.length;
    return this.persistCompletedTurnHistory({
      localSessionId,
      contextKey: historyContextKey,
      agentName: plan.agentName,
      remoteSessionId: plan.remoteSessionId,
      completedTurns,
      fallbackStart,
    });
  }

  private persistCompletedTurnHistory(input: {
    localSessionId: string;
    contextKey: string;
    agentName: string;
    remoteSessionId: string;
    completedTurns: RemoteCompletedTurnSummary[];
    fallbackStart: number;
  }): number {
    try {
      this.store.importCompletedTurnHistory({
        localSessionId: input.localSessionId,
        contextKey: input.contextKey,
        agentName: input.agentName,
        remoteSessionId: input.remoteSessionId,
        turns: input.completedTurns.map((turn, index) => {
          const startedAt = turn.startedAt ?? input.fallbackStart + index;
          const completedAt = turn.completedAt ?? startedAt;
          return {
            turnId: turn.id,
            snapshot: {
              sessionId: input.localSessionId,
              turnId: turn.id,
              prompt: turn.prompt ?? "未记录对话内容",
              status: "completed",
              startedAt,
              completedAt,
              assistantText: "",
              plan: [],
              activities: [],
              completedTools: [],
              failedTools: [],
              fileSummary: [],
            } satisfies TurnViewState,
            updatedAt: new Date(completedAt).toISOString(),
          };
        }),
      });
      return input.completedTurns.length;
    } catch (error) {
      this.logger.warn(
        { error, remoteSessionId: input.remoteSessionId },
        "Failed to persist inherited Turn history after Fork; keeping the Fork anchor fallback.",
      );
      return 0;
    }
  }

  private async hydrateLegacyForkTurnHistory(
    contextKey: string,
    current: SessionRecord,
  ): Promise<void> {
    const source = this.store.getForkHistorySource(current.localSessionId);
    if (!source || source.sourceTurnHistoryCount !== undefined
      || this.store.hasImportedForkTurnHistory(current.localSessionId)) return;
    if (!source.sourceRemoteSessionId) return;
    const runtime = this.runtimes.forAgent(current.agentName);
    if (runtime.kind !== "codex" || !runtime.readRemoteSession) return;
    try {
      const remote = await runtime.readRemoteSession(source.sourceRemoteSessionId);
      const completedTurns = remote.completedTurns ?? [];
      const anchorIndex = completedTurns.findIndex((turn) => turn.id === source.sourceTurnId);
      if (anchorIndex < 0) return;
      const inheritedTurns = completedTurns.slice(0, anchorIndex + 1);
      const sourceSession = source.sourceLocalSessionId
        ? this.store.getSession(source.sourceLocalSessionId)
        : undefined;
      const imported = this.persistCompletedTurnHistory({
        localSessionId: sourceSession?.localSessionId ?? current.localSessionId,
        contextKey: sourceSession?.contextKey ?? contextKey,
        agentName: current.agentName,
        remoteSessionId: source.sourceRemoteSessionId,
        completedTurns: inheritedTurns,
        fallbackStart: source.sourceTurnStartedAt
          ?? source.sourceTurnCompletedAt
          ?? Date.now() - inheritedTurns.length,
      });
      if (imported > 0) {
        this.store.audit(contextKey, "fork_turn_history_imported", {
          forkedLocalSessionId: current.localSessionId,
          sourceRemoteSessionId: source.sourceRemoteSessionId,
          sourceTurnId: source.sourceTurnId,
          importedTurnCount: imported,
        });
      }
    } catch (error) {
      this.logger.warn(
        { error, localSessionId: current.localSessionId, sourceRemoteSessionId: source.sourceRemoteSessionId },
        "Failed to hydrate legacy Fork Turn history; rendering the locally available history.",
      );
    }
  }

  private async hydrateRemoteTurnHistory(
    contextKey: string,
    current: SessionRecord,
  ): Promise<void> {
    if (!current.remoteSessionId) return;
    const refreshedAt = this.remoteTurnHistoryRefreshes.get(current.localSessionId);
    if (refreshedAt !== undefined && Date.now() - refreshedAt < REMOTE_TURN_HISTORY_REFRESH_INTERVAL_MS) return;
    const forkSource = this.store.getForkHistorySource(current.localSessionId);
    if (forkSource?.sourceTurnId === current.lastTurnId
      && this.store.hasImportedForkTurnHistory(current.localSessionId)) return;
    const runtime = this.runtimes.forAgent(current.agentName);
    if (runtime.kind !== "codex" || !runtime.readRemoteSession) return;
    try {
      const remote = await runtime.readRemoteSession(current.remoteSessionId);
      this.remoteTurnHistoryRefreshes.set(current.localSessionId, Date.now());
      const completedTurns = remote.completedTurns ?? [];
      if (completedTurns.length === 0) return;
      this.persistCompletedTurnHistory({
        localSessionId: current.localSessionId,
        contextKey,
        agentName: current.agentName,
        remoteSessionId: current.remoteSessionId,
        completedTurns,
        fallbackStart: parseIsoTimestamp(current.createdAt) ?? Date.now() - completedTurns.length,
      });
    } catch (error) {
      this.logger.warn(
        { error, localSessionId: current.localSessionId, remoteSessionId: current.remoteSessionId },
        "Failed to hydrate App Server Turn history; rendering the locally available history.",
      );
    }
  }

  private async createProjectSessionFromReference(contextKey: string, reference: string): Promise<void> {
    const resolved = await this.resolveProjectSessionReference(contextKey, reference);
    const created = await this.createSession(
      contextKey,
      resolved.agentName,
      resolved.cwd,
      true,
      false,
      undefined,
      undefined,
      undefined,
      resolved.executionSettings,
    );
    this.store.audit(contextKey, "project_session_created", {
      sourceLocalSessionId: resolved.source?.localSessionId,
      sourceRemoteSessionId: resolved.remoteSessionId,
      createdLocalSessionId: created.localSessionId,
      createdRemoteSessionId: created.remoteSessionId,
      cwd: resolved.cwd,
      ...resolved.executionSettings,
    });
  }

  private async resolveProjectSessionReference(
    contextKey: string,
    reference: string,
  ): Promise<ProjectSessionReference> {
    const taskId = this.resolveSessionReference(contextKey, reference);
    const direct = this.store.getSession(taskId);
    if (direct?.status === "closed") {
      throw new Error(`找不到任务：${taskId}`);
    }
    const source = direct ?? this.findStoredSessionByReference(taskId);
    if (source && !this.isCodexSession(source)) {
      throw new Error("指定任务不是 App Server 任务，暂时不能按项目创建新任务。");
    }

    let agentName: string;
    let runtime: AgentRuntime;
    let remote: RemoteSessionSummary | undefined;
    if (source) {
      agentName = source.agentName;
      runtime = this.runtimes.forAgent(agentName);
    } else {
      const resolved = await this.resolveRemoteCodexSession(taskId);
      agentName = resolved.agentName;
      runtime = resolved.runtime;
      remote = resolved.remote;
    }

    const remoteSessionId = source?.remoteSessionId ?? remote?.id ?? taskId;
    if (!remote && runtime.readRemoteSession && remoteSessionId) {
      try {
        remote = await runtime.readRemoteSession(remoteSessionId);
      } catch (error) {
        if (!source) throw error;
        this.logger.warn(
          { error, contextKey, taskId: remoteSessionId },
          "Failed to refresh the source task before creating a project task; using the local project path.",
        );
      }
    }

    const cwd = remote?.cwd || source?.cwd;
    if (!cwd) {
      throw new Error("指定的 App Server 任务没有可用的工作目录，暂时不能按项目创建新任务。");
    }
    const executionSettings: SessionExecutionSettings = {
      modelProvider: remote?.modelProvider ?? source?.modelProvider,
      model: remote?.model ?? source?.model,
      reasoningEffort: remote?.reasoningEffort ?? source?.reasoningEffort,
      permissionMode: remote?.permissionMode ?? source?.permissionMode ?? "auto",
    };
    return {
      source,
      agentName,
      remoteSessionId,
      cwd,
      executionSettings,
    };
  }

  private async startTurn(
    loaded: LoadedSession,
    text: string,
    replyTarget?: MessageReplyTarget,
    localImagePaths?: string[],
    options: StartTurnOptions = {},
  ): Promise<string> {
    const currentRecord = this.store.getSession(loaded.record.localSessionId);
    const title = currentRecord?.title ?? normalizeTaskTitle(options.displayPrompt ?? text);
    if (!currentRecord?.title && title) this.store.updateRuntimeSession(loaded.record.localSessionId, { title });
    if (title) this.outbound.updateSessionTitle(loaded.record.localSessionId, title);
    const attemptId = options.attemptId ?? createId("attempt");
    if (options.attemptId) {
      this.store.updateTurnAttempt(attemptId, {
        messageId: options.messageId ?? undefined,
        replyMessageId: replyTarget?.messageId ?? undefined,
        status: "recovering",
      });
    } else {
      this.store.createTurnAttempt({
        attemptId,
        localSessionId: loaded.record.localSessionId,
        contextKey: loaded.record.contextKey,
        promptText: text,
        localImagePaths,
        messageId: options.messageId,
        replyMessageId: replyTarget?.messageId,
      });
    }
    let turnId: string;
    let runtimeText = text;
    let cardPrompt = options.displayPrompt ?? text;
    let retriedStart = false;
    try {
      while (true) {
        let pendingTurnId: string | undefined;
        try {
          pendingTurnId = await this.outbound.startPendingTurn(
            loaded.record.localSessionId,
            loaded.record.contextKey,
            title,
            replyTarget,
            cardPrompt,
          );
        } catch (error) {
          this.store.updateTurnAttempt(attemptId, {
            status: options.preserveAttemptOnFailure ? "recovering" : "failed",
          });
          throw error;
        }
        this.store.updateTurnAttempt(attemptId, { pendingTurnId: pendingTurnId ?? null });

        try {
          turnId = await loaded.runtime.startTurn(
            loaded.record.localSessionId,
            runtimePrompt(runtimeText, localImagePaths),
          );
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const attempt = this.store.getTurnAttempt(attemptId);
          const retryAttempt = attempt
            && isRetryableLlmTurnFailure(message)
            && attempt.retryCount < MAX_LLM_TURN_RETRIES
            ? this.store.prepareUnstartedTurnAttemptRetry(attemptId)
            : undefined;
          if (!retryAttempt) {
            const exhausted = attempt
              && isRetryableLlmTurnFailure(message)
              && attempt.retryCount >= MAX_LLM_TURN_RETRIES;
            const finalMessage = exhausted
              ? `${message}\n\n已自动重试 ${MAX_LLM_TURN_RETRIES} 次，仍未成功。`
              : message;
            this.store.updateTurnAttempt(attemptId, {
              status: options.preserveAttemptOnFailure ? "recovering" : "failed",
            });
            await this.outbound.failPendingTurn(loaded.record.localSessionId, finalMessage);
            if (finalMessage === message) throw error;
            throw new Error(finalMessage, { cause: error });
          }

          retriedStart = true;
          this.llmRetryingSessions.add(loaded.record.localSessionId);
          this.store.audit(loaded.record.contextKey, "llm_turn_start_retry_started", {
            attemptId,
            retryNumber: retryAttempt.retryCount,
            maxRetries: MAX_LLM_TURN_RETRIES,
            error: message,
          });
          await this.outbound.failPendingTurn(
            loaded.record.localSessionId,
            `${message}\n\n检测到临时模型服务错误，正在自动重试（${retryAttempt.retryCount}/${MAX_LLM_TURN_RETRIES}）。`,
          ).catch((presentationError: unknown) => {
            this.logger.warn(
              { error: presentationError, sessionId: loaded.record.localSessionId },
              "Failed to finalize the pending thinking card before an LLM start retry.",
            );
          });
          runtimeText = llmRetryRuntimePrompt(retryAttempt.promptText, retryAttempt.retryCount);
          cardPrompt = llmRetryCardPrompt(options.displayPrompt ?? retryAttempt.promptText, retryAttempt.retryCount);
        }
      }
    } finally {
      if (retriedStart) this.llmRetryingSessions.delete(loaded.record.localSessionId);
    }
    const attempt = this.store.getTurnAttempt(attemptId);
    this.store.updateTurnAttempt(attemptId, {
      pendingTurnId: null,
      turnId,
      ...(attempt && isIncompleteTurnAttemptStatus(attempt.status) ? { status: "running" as const } : {}),
    });
    const latest = this.store.getSession(loaded.record.localSessionId);
    const alreadyTerminal = latest?.lastTurnId === turnId
      && ["completed", "cancelled", "failed"].includes(latest.lastTurnStatus ?? "");
    if (!alreadyTerminal) {
      this.store.updateSession(loaded.record.localSessionId, { status: "running" });
      this.store.updateRuntimeSession(loaded.record.localSessionId, { lastTurnId: turnId, lastTurnStatus: "running" });
    }
    return turnId;
  }

  private async createSession(
    contextKey: string,
    agentName: string,
    cwd: string | undefined,
    announce: boolean,
    prepareTurn: boolean,
    prompt?: string,
    replyTarget?: MessageReplyTarget,
    requestedTitle?: string,
    executionSettings: SessionExecutionSettings = {},
  ): Promise<SessionRecord> {
    const agent = this.ensureAgent(agentName);
    const resolvedExecutionSettings = mergeExecutionSettings(agent.defaults ?? {}, executionSettings);
    const localSessionId = createId("sess");
    const initialTitle = normalizeTaskTitle(requestedTitle ?? prompt ?? "");
    const sessionCwd = cwd === undefined && agent.kind === "app-server"
      ? createProjectlessWorkspace({ prompt: initialTitle }).cwd
      : path.resolve(cwd ?? this.config.defaults.cwd);
    const record = this.store.createSession({ localSessionId, contextKey, agentName, cwd: sessionCwd, status: "starting" });
    if (initialTitle || resolvedExecutionSettings.modelProvider || resolvedExecutionSettings.model
      || resolvedExecutionSettings.reasoningEffort || resolvedExecutionSettings.permissionMode) {
      this.store.updateRuntimeSession(localSessionId, {
        title: initialTitle,
        modelProvider: resolvedExecutionSettings.modelProvider,
        model: resolvedExecutionSettings.model,
        reasoningEffort: resolvedExecutionSettings.reasoningEffort,
        permissionMode: resolvedExecutionSettings.permissionMode,
      });
    }
    this.store.setCurrentSession(contextKey, localSessionId);
    this.outbound.registerSession(
      localSessionId,
      contextKey,
      initialTitle,
      sessionCwd,
      this.agentLabel(agentName),
    );
    const runtime = this.runtimes.forAgent(agentName);
    try {
      if (prepareTurn) {
        await this.outbound.startPendingTurn(localSessionId, contextKey, initialTitle, replyTarget, prompt);
      }
      const session = await runtime.createSession({
        localSessionId,
        agentName,
        cwd: sessionCwd,
        title: initialTitle,
        modelProvider: resolvedExecutionSettings.modelProvider,
        model: resolvedExecutionSettings.model,
        reasoningEffort: resolvedExecutionSettings.reasoningEffort,
        permissionMode: resolvedExecutionSettings.permissionMode ?? "auto",
      });
      this.persistRuntimeSession(record, session, session.activeTurnId ? "running" : "ready");
      const saved = this.store.getSession(localSessionId) ?? record;
      if (announce) {
        const task = initialTitle ? `${initialTitle}（${session.remoteSessionId}）` : session.remoteSessionId;
        await this.outbound.sendText(contextKey, `已创建 ${agent.title} 任务：${task}`);
      }
      return saved;
    } catch (error) {
      this.store.updateSession(localSessionId, { status: "failed" });
      if (prepareTurn) {
        await this.outbound.failPendingTurn(localSessionId, error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  private async createFeishuGroup(
    sourceContextKey: string,
    agentName: string,
    requestedTitle: string | undefined,
    userId: string | undefined,
    requestedProjectCwd?: string,
    forceProjectless = false,
  ): Promise<void> {
    const source = this.currentSession(sourceContextKey);
    const boundProjectCwd = forceProjectless
      ? undefined
      : requestedProjectCwd ?? this.currentProjectCwd(sourceContextKey);
    const executionSettings: SessionExecutionSettings = source?.agentName === agentName
      ? {
          modelProvider: source.modelProvider,
          model: source.model,
          reasoningEffort: source.reasoningEffort,
          permissionMode: source.permissionMode,
        }
      : {};
    await this.createFeishuGroupWithTask(
      sourceContextKey,
      agentName,
      requestedTitle,
      userId,
      boundProjectCwd,
      executionSettings,
    );
  }

  private async createFeishuGroupFromReference(
    sourceContextKey: string,
    reference: string,
    userId: string | undefined,
  ): Promise<void> {
    const resolved = await this.resolveProjectSessionReference(sourceContextKey, reference);
    const boundProjectCwd = detectProjectlessWorkspace(resolved.cwd) ? undefined : resolved.cwd;
    await this.createFeishuGroupWithTask(
      sourceContextKey,
      resolved.agentName,
      undefined,
      userId,
      boundProjectCwd,
      resolved.executionSettings,
    );
  }

  private async createFeishuGroupWithTask(
    sourceContextKey: string,
    agentName: string,
    requestedTitle: string | undefined,
    userId: string | undefined,
    boundProjectCwd: string | undefined,
    executionSettings: SessionExecutionSettings,
  ): Promise<CreatedFeishuTaskGroup> {
    const explicitTitle = normalizeTaskTitle(requestedTitle);
    const taskTitle = explicitTitle ?? `新任务 (${formatGroupNameDate(
      new Date(),
      this.config.feishu?.groupNameFormat?.dateFormat ?? DEFAULT_GROUP_NAME_FORMAT.dateFormat,
    )})`;
    const group = await this.createFeishuGroupContext(
      sourceContextKey,
      agentName,
      taskTitle,
      userId,
      boundProjectCwd,
      "/newgroup",
    );

    let task: SessionRecord;
    try {
      task = await this.createSession(
        group.contextKey,
        agentName,
        boundProjectCwd,
        false,
        false,
        undefined,
        undefined,
        taskTitle,
        executionSettings,
      );
    } catch (error) {
      await this.outbound.sendText(
        group.contextKey,
        `群已创建，但新任务创建失败：${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    const taskDescription = task.title
      ? `${task.title}（${task.remoteSessionId}）`
      : task.remoteSessionId ?? task.localSessionId;
    await this.outbound.sendText(
      group.contextKey,
      [
        "群和新任务已创建。",
        `当前任务：${taskDescription}`,
        `当前 Project 目录：${boundProjectCwd ?? "未绑定（Projectless）"}`,
        `当前 Provider：${task.modelProvider ?? "Agent 默认"}`,
        `当前模型：${task.model ?? "默认"}`,
        `思考强度：${task.reasoningEffort ?? "自动"}`,
        `权限类型：${task.permissionMode === "confirm" ? "执行前确认" : "自动执行"}`,
      ].join("\n"),
    );
    await this.outbound.sendText(
      sourceContextKey,
      `已创建飞书群：${group.name}，并创建新任务 ${taskDescription}。`,
    );
    return { group, task };
  }

  private async forkCurrentSessionToFeishuGroup(
    sourceContextKey: string,
    requestedTitle: string | undefined,
    userId: string | undefined,
    incomingMessage: IncomingMessage | undefined,
  ): Promise<void> {
    if (!userId?.startsWith("ou_")) {
      throw new Error("/forkgroup 只能由具有 open_id 的飞书用户消息触发。");
    }
    const prepared = await this.prepareForkGroupSession(sourceContextKey, requestedTitle, incomingMessage);
    await this.forkPreparedSessionToFeishuGroup(
      sourceContextKey,
      prepared,
      userId,
      incomingMessage?.threadContext ? prepared.sourceDescription : "当前任务",
    );
  }

  private async forkSessionReferenceToFeishuGroup(
    sourceContextKey: string,
    reference: string,
    userId: string | undefined,
  ): Promise<void> {
    if (!userId?.startsWith("ou_")) {
      throw new Error("ForkGroup 只能由具有 open_id 的飞书用户触发。");
    }
    const plan = await this.prepareForkSession(sourceContextKey, reference);
    await this.forkPreparedSessionToFeishuGroup(
      sourceContextKey,
      {
        plan,
        sourceDescription: plan.forkedFromHistoricalTurn
          ? "指定任务最近已完成轮次"
          : "指定任务最新轮次",
      },
      userId,
      "指定任务",
    );
  }

  private async forkPreparedSessionToFeishuGroup(
    sourceContextKey: string,
    prepared: ForkGroupSessionPlan,
    userId: string,
    sourceSummary: string,
  ): Promise<CreatedFeishuTaskGroup> {
    const { plan } = prepared;
    const boundProjectCwd = detectProjectlessWorkspace(plan.cwd) ? undefined : plan.cwd;
    const group = await this.createFeishuGroupContext(
      sourceContextKey,
      plan.agentName,
      plan.forkTitle,
      userId,
      boundProjectCwd,
      "/forkgroup",
    );

    let forked: ForkSessionResult;
    try {
      forked = await this.forkSessionIntoContext(group.contextKey, plan);
    } catch (error) {
      await this.outbound.sendText(
        group.contextKey,
        `群已创建，但 Fork 任务失败：${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    const taskDescription = forked.session.title
      ? `${forked.session.title}（${forked.session.remoteSessionId}）`
      : forked.session.remoteSessionId;
    await this.outbound.sendText(
      group.contextKey,
      [
        `已从${prepared.sourceDescription}创建分支。`,
        `当前任务：${taskDescription}`,
        `当前 Project 目录：${boundProjectCwd ?? "未绑定（Projectless）"}`,
        `当前 Provider：${forked.session.modelProvider ?? "Agent 默认"}`,
        `当前模型：${forked.session.model ?? "默认"}`,
        `思考强度：${forked.session.reasoningEffort ?? "自动"}`,
        `权限类型：${forked.session.permissionMode === "confirm" ? "执行前确认" : "自动执行"}`,
      ].join("\n"),
    );
    await this.outbound.sendText(
      sourceContextKey,
      `已将${sourceSummary} Fork 到飞书群：${group.name}；新群当前任务为 ${taskDescription}。`,
    );
    return { group, task: forked.record };
  }

  private async createFeishuGroupContext(
    sourceContextKey: string,
    agentName: string,
    taskTitle: string,
    userId: string | undefined,
    boundProjectCwd: string | undefined,
    commandName: "/newgroup" | "/forkgroup",
  ): Promise<CreatedFeishuGroupContext> {
    if (!userId?.startsWith("ou_")) {
      throw new Error(`${commandName} 只能由具有 open_id 的飞书用户消息触发。`);
    }
    const groupName = formatNewGroupName({
      agentName,
      projectCwd: boundProjectCwd,
      taskName: taskTitle,
      date: new Date(),
      format: this.config.feishu?.groupNameFormat,
    });
    const group = await this.outbound.createGroup(sourceContextKey, {
      name: groupName,
      userOpenId: userId,
      avatarPng: generateGroupAvatarPng(
        resolveGroupAvatarProjectName(boundProjectCwd, taskTitle),
        boundProjectCwd,
      ),
    });
    const groupContextKey = `chat_id:${group.chatId}`;
    this.store.recordChatContext(groupContextKey, "group");
    this.store.getOrCreateUserContext(groupContextKey, agentName);
    if (boundProjectCwd) this.store.setBoundProjectCwd(groupContextKey, boundProjectCwd);
    return { chatId: group.chatId, contextKey: groupContextKey, name: group.name };
  }

  private async loadSession(record: SessionRecord): Promise<LoadedSession> {
    const agent = this.ensureAgent(record.agentName);
    const runtime = this.runtimes.forAgent(record.agentName);
    const existing = runtime.getSession(record.localSessionId);
    if (existing) return { record, runtime, session: existing };
    const pending = this.sessionLoads.get(record.localSessionId);
    if (pending) {
      const loaded = await pending;
      return {
        ...loaded,
        record: { ...loaded.record, contextKey: record.contextKey },
      };
    }

    this.outbound.registerSession(
      record.localSessionId,
      record.contextKey,
      record.title,
      record.cwd,
      this.agentLabel(record.agentName),
    );
    const loading = (async (): Promise<LoadedSession> => {
      if (record.lastTurnId) {
        try {
          await this.outbound.resumeDelivery(record.localSessionId, record.contextKey, record.lastTurnId);
        } catch (error) {
          this.logger.warn(
            { error, sessionId: record.localSessionId, turnId: record.lastTurnId },
            "Failed to restore persisted turn delivery before loading session.",
          );
        }
      }
      const permissionMode = record.permissionMode ?? "auto";
      if (record.remoteSessionId) await this.assertSessionTurnOwnership(record, runtime);
      let session: RuntimeSession;
      if (record.remoteSessionId) {
        try {
          session = await runtime.resumeSession({
            localSessionId: record.localSessionId,
            remoteSessionId: record.remoteSessionId,
            agentName: record.agentName,
            cwd: record.cwd,
            title: record.title,
            modelProvider: record.modelProvider,
            model: record.model,
            reasoningEffort: record.reasoningEffort,
            permissionMode,
            activeTurnId: agent.kind === "app-server" && record.status === "running" && record.lastTurnStatus === "running"
              ? record.lastTurnId
              : undefined,
            lastTurnId: record.lastTurnId,
            lastTurnStatus: record.lastTurnStatus,
          });
        } catch (error) {
          if (activeWriterThreadId(error)) throw error;
          if (!(agent.kind === "app-server" && !record.lastTurnId && isMissingRolloutError(error))) throw error;
          this.logger.warn({ error, sessionId: record.localSessionId }, "App Server task has no rollout; creating a replacement task.");
          session = await runtime.createSession({
            localSessionId: record.localSessionId,
            agentName: record.agentName,
            cwd: record.cwd,
            title: record.title,
            modelProvider: record.modelProvider,
            model: record.model,
            reasoningEffort: record.reasoningEffort,
            permissionMode,
          });
        }
      } else {
        session = await runtime.createSession({
          localSessionId: record.localSessionId,
          agentName: record.agentName,
          cwd: record.cwd,
          title: record.title,
          modelProvider: record.modelProvider,
          model: record.model,
          reasoningEffort: record.reasoningEffort,
          permissionMode,
        });
      }
      this.persistRuntimeSession(record, session, session.activeTurnId ? "running" : "ready");
      const saved = this.store.getSession(record.localSessionId) ?? record;
      return {
        record: { ...saved, contextKey: record.contextKey },
        runtime,
        session,
      };
    })();
    this.sessionLoads.set(record.localSessionId, loading);
    try {
      return await loading;
    } finally {
      this.sessionLoads.delete(record.localSessionId);
    }
  }

  private persistRuntimeSession(record: SessionRecord, session: RuntimeSession, status: "ready" | "running"): void {
    this.store.updateRuntimeSession(record.localSessionId, {
      runtimeKind: session.runtimeKind,
      remoteSessionId: session.remoteSessionId,
      title: session.title,
      modelProvider: session.modelProvider,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      permissionMode: session.permissionMode,
    });
    this.store.updateSession(record.localSessionId, {
      acpSessionId: session.runtimeKind === "acp" ? session.remoteSessionId : undefined,
      status,
    });
  }

  private async handleRuntimeEvent(event: RuntimeEvent): Promise<void> {
    if ("turnId" in event) {
      this.store.touchTurnAttempt(event.turnId);
      const source = this.store.getSession(event.sessionId);
      if (source?.remoteSessionId && this.isCodexSession(source)) {
        this.store.saveTurnRuntimeOrigin(
          event.turnId,
          source.localSessionId,
          source.agentName,
          source.remoteSessionId,
        );
      }
      if (event.type === "turn_started") {
        const attempt = this.store.bindTurnAttempt(event.sessionId, event.turnId);
        if (attempt?.recoveredFromTurnId && attempt.recoveredFromTurnId !== event.turnId) {
          this.store.rebindPendingTurnMessages(event.sessionId, attempt.recoveredFromTurnId, event.turnId);
        }
        this.store.saveTurnParent(
          event.turnId,
          event.sessionId,
          this.completedParentTurnId(source),
        );
      }
    }
    const failedAttempt = event.type === "turn_failed"
      ? this.store.findIncompleteTurnAttemptByTurnId(event.turnId)
      : undefined;
    if (event.type === "turn_failed") {
      if (this.retriedFailureTurnIds.has(event.turnId)) return;
      if (failedAttempt && isRetryableLlmTurnFailure(event.message) && failedAttempt.retryCount < MAX_LLM_TURN_RETRIES) {
        const retryAttempt = this.store.prepareTurnAttemptRetry(failedAttempt.attemptId, event.turnId);
        if (retryAttempt) {
          this.retriedFailureTurnIds.add(event.turnId);
          await this.retryFailedLlmTurn(event, retryAttempt);
          return;
        }
      }
    }
    if (event.type === "session_metadata_updated") {
      this.store.updateRuntimeSession(event.sessionId, { title: event.title });
      this.outbound.updateSessionTitle(event.sessionId, event.title);
      return;
    }
    if (event.type === "turn_started") {
      this.store.updateSession(event.sessionId, { status: "running" });
      this.store.updateRuntimeSession(event.sessionId, { lastTurnId: event.turnId, lastTurnStatus: "running" });
    } else if (event.type === "turn_completed" || event.type === "turn_cancelled" || event.type === "turn_failed") {
      this.store.markTurnAttemptTerminal(
        event.turnId,
        event.type === "turn_completed" ? "completed" : event.type === "turn_cancelled" ? "cancelled" : "failed",
      );
      this.store.updateRuntimeSession(event.sessionId, {
        lastTurnId: event.turnId,
        lastTurnStatus: event.type === "turn_completed" ? "completed" : event.type === "turn_cancelled" ? "cancelled" : "failed",
      });
    }

    const presentationEvent = event.type === "turn_failed"
      && isRetryableLlmTurnFailure(event.message)
      && (failedAttempt?.retryCount ?? 0) >= MAX_LLM_TURN_RETRIES
      ? {
          ...event,
          message: `${event.message}\n\n已自动重试 ${MAX_LLM_TURN_RETRIES} 次，仍未成功。`,
        }
      : event;
    let presentationError: unknown;
    try {
      await this.outbound.onEvent(presentationEvent);
    } catch (error) {
      presentationError = error;
    }

    if (event.type === "turn_completed" || event.type === "turn_cancelled" || event.type === "turn_failed") {
      await this.refreshGoalCards(event.sessionId);
      const terminalStatus = event.type === "turn_completed"
        ? "completed"
        : event.type === "turn_cancelled"
          ? "cancelled"
          : "failed";
      const reactionSession = this.store.getSession(event.sessionId);
      if (
        !presentationError
        && reactionSession?.lastTurnId === event.turnId
        && reactionSession.lastTurnStatus === terminalStatus
      ) {
        await this.finalizeTurnMessageReactions(event.turnId, terminalStatus);
      }

      const latest = this.store.getSession(event.sessionId);
      const activeTurnId = latest
        ? this.runtimes.forAgent(latest.agentName).getSession(event.sessionId)?.activeTurnId
        : undefined;
      if (latest?.lastTurnId === event.turnId && !activeTurnId) {
        this.store.updateSession(event.sessionId, { status: event.type === "turn_failed" ? "failed" : "ready" });
        await this.scheduleNextQueuedPrompt(event.sessionId);
      }
    }

    if (presentationError) throw presentationError;
  }

  private async retryFailedLlmTurn(
    event: Extract<RuntimeEvent, { type: "turn_failed" }>,
    attempt: TurnAttemptRecord,
  ): Promise<void> {
    const retryNumber = attempt.retryCount;
    const session = this.store.getSession(event.sessionId);
    if (!session || session.status === "closed") {
      this.store.updateTurnAttempt(attempt.attemptId, { status: "failed" });
      return;
    }

    this.llmRetryingSessions.add(session.localSessionId);
    this.store.updateRuntimeSession(session.localSessionId, {
      lastTurnId: event.turnId,
      lastTurnStatus: "failed",
    });
    this.store.audit(attempt.contextKey, "llm_turn_retry_started", {
      attemptId: attempt.attemptId,
      failedTurnId: event.turnId,
      retryNumber,
      maxRetries: MAX_LLM_TURN_RETRIES,
      error: event.message,
    });

    try {
      await this.outbound.onEvent({
        ...event,
        message: `${event.message}\n\n检测到临时模型服务错误，正在自动重试（${retryNumber}/${MAX_LLM_TURN_RETRIES}）。`,
      });
    } catch (error) {
      this.logger.warn(
        { error, sessionId: session.localSessionId, turnId: event.turnId },
        "Failed to finalize the failed thinking card before an LLM retry.",
      );
    }

    const replyTarget = attempt.replyMessageId
      ? { messageId: attempt.replyMessageId, replyInThread: true as const }
      : undefined;
    try {
      const current = this.store.getSession(session.localSessionId) ?? session;
      const loaded = await this.loadSession(current);
      const retryTurnId = await this.startTurn(
        loaded,
        llmRetryRuntimePrompt(attempt.promptText, retryNumber),
        replyTarget,
        attempt.localImagePaths,
        {
          attemptId: attempt.attemptId,
          messageId: attempt.messageId,
          displayPrompt: llmRetryCardPrompt(attempt.promptText, retryNumber),
          preserveAttemptOnFailure: true,
        },
      );
      this.store.rebindPendingTurnMessages(session.localSessionId, event.turnId, retryTurnId);
    } catch (error) {
      this.store.updateTurnAttempt(attempt.attemptId, { status: "failed" });
      this.store.updateSession(session.localSessionId, { status: "failed" });
      await this.finalizeTurnMessageReactions(event.turnId, "failed").catch((reactionError: unknown) => {
        this.logger.warn(
          { error: reactionError, sessionId: session.localSessionId, turnId: event.turnId },
          "Failed to finalize reactions after an LLM retry could not start.",
        );
      });
      this.logger.error(
        { error, sessionId: session.localSessionId, retryNumber },
        "Failed to start an automatic LLM turn retry.",
      );
      await this.scheduleNextQueuedPrompt(session.localSessionId);
    } finally {
      this.llmRetryingSessions.delete(session.localSessionId);
    }
  }

  private scheduleNextQueuedPrompt(sessionId: string): Promise<void> {
    const retryTimer = this.queuedPromptRetryTimers.get(sessionId);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.queuedPromptRetryTimers.delete(sessionId);
    }
    const previous = this.queuedPromptStarts.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.startNextQueuedPromptIfIdle(sessionId));
    this.queuedPromptStarts.set(sessionId, next);
    return next.finally(() => {
      if (this.queuedPromptStarts.get(sessionId) === next) this.queuedPromptStarts.delete(sessionId);
    });
  }

  private scheduleQueuedPromptRetry(sessionId: string): void {
    if (this.queuedPromptRetryTimers.has(sessionId)) return;
    if (this.store.countQueuedPrompts(sessionId) === 0) return;
    const timer = setTimeout(() => {
      this.queuedPromptRetryTimers.delete(sessionId);
      void this.scheduleNextQueuedPrompt(sessionId).catch((error: unknown) => {
        this.logger.warn(
          { error, errorMessage: runtimeErrorMessage(error), sessionId },
          "Failed to retry queued prompt start.",
        );
        this.scheduleQueuedPromptRetry(sessionId);
      });
    }, QUEUED_PROMPT_RETRY_DELAY_MS);
    timer.unref?.();
    this.queuedPromptRetryTimers.set(sessionId, timer);
  }

  private async startNextQueuedPromptIfIdle(sessionId: string): Promise<void> {
    if (this.store.countQueuedPrompts(sessionId) === 0) return;
    const baseRecord = this.store.getSession(sessionId);
    if (!baseRecord || baseRecord.status === "closed") return;
    let prompt: QueuedPromptRecord | undefined;
    try {
      let loaded = await this.loadSession(baseRecord);
      const remoteActivity = await this.assertSessionTurnOwnership(loaded.record, loaded.runtime);
      if (needsFullSessionSynchronization(loaded.record, loaded.session, remoteActivity)) {
        loaded = { ...loaded, session: await loaded.runtime.synchronizeSession(sessionId) };
      }
      if (loaded.session.activeTurnId) return;

      prompt = this.store.takeNextQueuedPrompt(sessionId);
      if (!prompt) return;
      const record = this.store.getSessionForContext(sessionId, prompt.contextKey) ?? baseRecord;
      loaded = { ...loaded, record };
      await this.refreshPromptQueueCards(sessionId);
      const turnId = await this.startTurn(
        loaded,
        prompt.text,
        prompt.replyMessageId ? { messageId: prompt.replyMessageId, replyInThread: true } : undefined,
        prompt.localImagePaths,
        { messageId: prompt.messageId, displayPrompt: prompt.displayPrompt },
      );
      if (prompt.messageId) await this.bindMessageReactionToTurn(prompt.messageId, sessionId, turnId);
    } catch (error) {
      this.logger.warn(
        {
          error,
          errorMessage: runtimeErrorMessage(error),
          phase: prompt ? "start" : "preflight",
          sessionId,
        },
        "Failed to start queued prompt.",
      );
      if (!prompt) {
        this.scheduleQueuedPromptRetry(sessionId);
        return;
      }
      if (prompt.messageId) await this.finalizeStandaloneMessageReaction(prompt.messageId, "failed");
      await this.sendError(prompt.contextKey, error);
      if (this.store.countQueuedPrompts(sessionId) > 0) {
        queueMicrotask(() => void this.scheduleNextQueuedPrompt(sessionId));
      }
    }
  }

  private completedParentTurnId(source: SessionRecord | undefined): string | undefined {
    if (!source?.lastTurnId) return undefined;
    if (source.lastTurnStatus === "completed") return source.lastTurnId;
    const snapshot = turnViewSnapshot(this.store.getTurnSnapshot(source.lastTurnId));
    return snapshot?.status === "completed"
      ? source.lastTurnId
      : this.store.findLatestCompletedTurnId(source.localSessionId, source.contextKey);
  }

  private async finalizeStandaloneMessageReaction(
    messageId: string,
    status: "completed" | "failed" | "cancelled",
  ): Promise<void> {
    for (const relatedMessageId of this.takeRelatedReactionMessageIds(messageId)) {
      const reaction = this.store.claimMessageReaction(relatedMessageId);
      if (reaction) await this.replaceMessageReaction(reaction, status);
    }
  }

  private async bindMessageReactionToTurn(messageId: string, sessionId: string, turnId: string): Promise<void> {
    for (const relatedMessageId of this.takeRelatedReactionMessageIds(messageId)) {
      this.store.bindMessageToTurn(relatedMessageId, sessionId, turnId);
      this.store.bindMessageReaction(relatedMessageId, sessionId, turnId);
    }
    const session = this.store.getSession(sessionId);
    if (session?.lastTurnId !== turnId) return;
    if (session.lastTurnStatus === "completed" || session.lastTurnStatus === "failed" || session.lastTurnStatus === "cancelled") {
      await this.finalizeTurnMessageReactions(turnId, session.lastTurnStatus);
    }
  }

  private registerPendingForwardAttachment(
    message: IncomingMessage,
    registry: Map<string, PendingForwardAttachment>,
  ): PendingForwardAttachment {
    let resolveAttachment!: (message: IncomingMessage | undefined) => void;
    const attachmentPromise = new Promise<IncomingMessage | undefined>((resolve) => {
      resolveAttachment = resolve;
    });
    const pending = {
      contextKey: message.contextKey,
      attachmentPromise,
      resolveAttachment,
    };
    registry.set(message.messageId, pending);
    return pending;
  }

  private reserveForwardAttachment(message: IncomingMessage): ForwardAttachmentReservation | undefined {
    if (!message.parentMessageId) return undefined;
    const candidates = [
      { sourceKind: "merged_forward" as const, registry: this.pendingMergedForwards },
      { sourceKind: "resource" as const, registry: this.pendingResourceForwards },
    ];
    for (const candidate of candidates) {
      const pending = candidate.registry.get(message.parentMessageId);
      if (!pending || pending.contextKey !== message.contextKey || pending.attachmentMessageId) continue;
      pending.attachmentMessageId = message.messageId;
      return {
        sourceMessageId: message.parentMessageId,
        sourceKind: candidate.sourceKind,
        pending,
        registry: candidate.registry,
      };
    }
    return undefined;
  }

  private completeForwardAttachment(
    message: IncomingMessage,
    reservation: ForwardAttachmentReservation,
  ): boolean {
    if (!message.parentMessageId) return false;
    if (reservation.sourceMessageId !== message.parentMessageId) return false;
    if (reservation.registry.get(message.parentMessageId) !== reservation.pending) return false;
    if (reservation.pending.attachmentMessageId !== message.messageId) return false;
    reservation.pending.resolveAttachment(message);
    return true;
  }

  private async waitForForwardAttachment(
    messageId: string,
    pending: PendingForwardAttachment,
    registry: Map<string, PendingForwardAttachment>,
  ): Promise<IncomingMessage | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), FORWARD_ATTACHMENT_WINDOW_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([pending.attachmentPromise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      if (registry.get(messageId) === pending) {
        registry.delete(messageId);
      }
    }
  }

  private async resolveReferencedMessage(
    contextKey: string,
    messageId: string,
  ): Promise<ReferencedMessageContent> {
    const local = this.store.findAgentBotTurnMessageById(messageId);
    if (local) {
      const snapshot = turnViewSnapshot(this.store.getTurnSnapshot(local.turnId));
      const text = snapshot ? renderLocalTurnReference(snapshot, local.messageKind) : undefined;
      if (text) {
        return {
          text,
          messageType: local.messageKind === "final" ? "agent_bot_reply" : "agent_bot_progress",
          images: [],
          files: [],
        };
      }
    }
    return this.outbound.readReferencedMessage(contextKey, messageId);
  }

  private takeRelatedReactionMessageIds(messageId: string): string[] {
    const related = this.relatedReactionMessageIds.get(messageId) ?? [];
    this.relatedReactionMessageIds.delete(messageId);
    return [...new Set([messageId, ...related])];
  }

  private async finalizeTurnMessageReactions(
    turnId: string,
    status: "completed" | "failed" | "cancelled",
  ): Promise<void> {
    for (const reaction of this.store.claimMessageReactionsForTurn(turnId)) {
      await this.replaceMessageReaction(reaction, status);
    }
  }

  private async replaceMessageReaction(
    reaction: MessageReactionRecord,
    status: Exclude<MessageReactionStatus, "pending" | "updating">,
  ): Promise<void> {
    const emojiType = status === "completed"
      ? MESSAGE_COMPLETED_REACTION
      : status === "cancelled"
        ? MESSAGE_CANCELLED_REACTION
        : MESSAGE_FAILED_REACTION;
    try {
      const replacementId = await this.outbound.addReaction(reaction.contextKey, reaction.messageId, emojiType);
      if (!replacementId) throw new Error("Feishu did not return the replacement reaction ID.");
      try {
        await this.outbound.deleteReaction(reaction.contextKey, reaction.messageId, reaction.reactionId);
      } catch (error) {
        this.logger.warn(
          { error, messageId: reaction.messageId, reactionId: reaction.reactionId },
          "Added the terminal reaction but failed to remove the previous reaction.",
        );
      }
      this.store.finishMessageReaction(reaction.messageId, replacementId, emojiType, status);
    } catch (error) {
      this.store.releaseMessageReaction(reaction.messageId);
      this.logger.warn(
        { error, messageId: reaction.messageId, status },
        "Failed to update the Feishu message reaction for a completed task state.",
      );
    }
  }

  private async cancel(contextKey: string): Promise<void> {
    const record = this.requireCurrentSession(contextKey);
    await this.cancelSession(record);
  }

  private async cancelSession(record: SessionRecord): Promise<void> {
    const runtime = this.runtimes.forAgent(record.agentName);
    if (runtime.kind === "codex" && record.remoteSessionId && runtime.interruptRemoteTurn) {
      if (runtime.getGoal && runtime.setGoal) {
        try {
          if (!runtime.getSession(record.localSessionId)) await this.loadSession(record);
          const goal = await runtime.getGoal(record.localSessionId);
          if (goal?.status === "active") await runtime.setGoal(record.localSessionId, { status: "paused" });
        } catch (error) {
          this.logger.warn(
            { error, sessionId: record.localSessionId },
            "Failed to pause the active Agent goal before interrupting its turn.",
          );
        }
      }
      let turnId = runtime.getSession(record.localSessionId)?.activeTurnId;
      if (runtime.readRemoteSession) {
        try {
          const remote = await runtime.readRemoteSession(record.remoteSessionId);
          turnId = remote.status === "active" || remote.lastTurnStatus === "inProgress"
            ? remote.lastTurnId
            : undefined;
        } catch (error) {
          this.logger.warn(
            { error, sessionId: record.localSessionId, remoteSessionId: record.remoteSessionId },
            "Failed to inspect the current App Server turn before interrupting; using the locally tracked turn.",
          );
        }
      }
      if (!turnId) {
        await this.outbound.sendText(record.contextKey, "当前没有正在执行的任务。");
        return;
      }
      const cancellationAttempt = this.store.requestTurnAttemptCancellation(turnId);
      try {
        await runtime.interruptRemoteTurn(record.remoteSessionId, turnId);
      } catch (error) {
        if (cancellationAttempt) this.store.restoreTurnAttemptAfterCancellationFailure(cancellationAttempt);
        throw error;
      }
      this.store.audit(record.contextKey, "turn_interrupt_sent", {
        localSessionId: record.localSessionId,
        remoteSessionId: record.remoteSessionId,
        turnId,
      });
      await this.outbound.sendText(record.contextKey, TURN_STOP_REQUESTED_MESSAGE);
      return;
    }

    const loaded = await this.loadSession(record);
    const turnId = loaded.session.activeTurnId;
    if (!turnId) {
      await this.outbound.sendText(record.contextKey, "当前没有正在执行的任务。");
      return;
    }
    const cancellationAttempt = this.store.requestTurnAttemptCancellation(turnId);
    try {
      await loaded.runtime.cancelTurn(record.localSessionId, turnId);
    } catch (error) {
      if (cancellationAttempt) this.store.restoreTurnAttemptAfterCancellationFailure(cancellationAttempt);
      throw error;
    }
  }

  private async resetCurrentSessionToTurn(
    contextKey: string,
    sessionId: string,
    turnId: string,
  ): Promise<void> {
    if (!sessionId || !turnId) throw new Error("无效的 Reset 请求。请使用最新的思考卡片重试。");
    const previous = this.sessionResets.get(sessionId) ?? Promise.resolve();
    const reset = previous.catch(() => undefined).then(() =>
      this.performCurrentSessionReset(contextKey, sessionId, turnId));
    this.sessionResets.set(sessionId, reset);
    try {
      await reset;
    } finally {
      if (this.sessionResets.get(sessionId) === reset) this.sessionResets.delete(sessionId);
    }
  }

  private async resetFromHistoryCard(
    contextKey: string,
    sessionId: string,
    turnId: string,
    updateMessageId: string,
    page: number,
  ): Promise<void> {
    if (!sessionId || !turnId) throw new Error("无效的 Reset 请求。请使用最新的历史轮次卡片重试。");
    const existingTurnId = this.resetHistoryOperations.get(sessionId);
    if (existingTurnId) {
      await this.openResetHistory(contextKey, { expectedSessionId: sessionId, updateMessageId, page });
      throw new Error("当前已有 Reset 正在执行，请稍候。");
    }

    this.resetHistoryOperations.set(sessionId, turnId);
    try {
      await this.openResetHistory(contextKey, { expectedSessionId: sessionId, updateMessageId, page });
    } catch (error) {
      if (this.resetHistoryOperations.get(sessionId) === turnId) {
        this.resetHistoryOperations.delete(sessionId);
      }
      throw error;
    }

    try {
      await this.resetCurrentSessionToTurn(contextKey, sessionId, turnId);
    } catch (error) {
      if (this.resetHistoryOperations.get(sessionId) === turnId) {
        this.resetHistoryOperations.delete(sessionId);
      }
      try {
        await this.openResetHistory(contextKey, { expectedSessionId: sessionId, updateMessageId, page });
      } catch (refreshError) {
        this.logger.warn(
          { error: refreshError, contextKey, sessionId, turnId, updateMessageId },
          "Failed to restore the Turns card after Reset failed.",
        );
      }
      throw error;
    }

    if (this.resetHistoryOperations.get(sessionId) === turnId) {
      this.resetHistoryOperations.delete(sessionId);
    }
    await this.openResetHistory(contextKey, { expectedSessionId: sessionId, updateMessageId, page });
  }

  private async performCurrentSessionReset(
    contextKey: string,
    sessionId: string,
    turnId: string,
  ): Promise<void> {
    const current = this.requireCurrentSession(contextKey);
    if (current.localSessionId !== sessionId) {
      throw new Error("这张思考卡片不属于当前任务。请先切换回对应任务，再点击 Reset。");
    }
    await this.performSessionReset(contextKey, current, turnId, true);
  }

  private async performSessionReset(
    contextKey: string,
    current: SessionRecord,
    turnId: string,
    announce: boolean,
  ): Promise<void> {
    if (!current.remoteSessionId || !this.isCodexSession(current)) {
      throw new Error("当前任务不是可 Reset 的 App Server 任务。");
    }

    const historyTurn = this.store.listTaskTurnGraph(current.localSessionId)
      .find((turn) => turn.turnId === turnId);
    const snapshot = turnViewSnapshot(historyTurn?.snapshot);
    if (!snapshot || snapshot.status !== "completed") {
      throw new Error("只能将当前任务 Reset 到已成功完成的轮次。");
    }
    if (current.lastTurnId === turnId && current.lastTurnStatus === "completed") {
      if (announce) await this.outbound.sendText(contextKey, "当前任务已经处于本轮完成后的对话状态，无需 Reset。");
      return;
    }

    const runtime = this.runtimes.forAgent(current.agentName);
    if (runtime.kind !== "codex" || !runtime.forkSession) {
      throw new Error("当前 App Server Agent 不支持 Reset。");
    }
    const loaded = await this.loadSession(current);
    const activity = await this.assertSessionTurnOwnership(current, runtime);
    const active = activity?.active
      ?? Boolean(loaded.session.activeTurnId || current.status === "running" || current.lastTurnStatus === "running");
    if (active) {
      throw new Error("当前任务仍在执行。请等待任务完成或先停止任务，再点击 Reset。");
    }

    const origin = this.store.getTurnRuntimeOrigin(turnId);
    if (origin && origin.agentName !== current.agentName) {
      throw new Error("这张思考卡片与当前任务不匹配，已拒绝 Reset。");
    }
    const sourceRemoteSessionId = origin?.remoteSessionId ?? current.remoteSessionId;
    const previousRemoteSessionId = current.remoteSessionId;
    const forked = await runtime.forkSession({
      localSessionId: current.localSessionId,
      remoteSessionId: sourceRemoteSessionId,
      lastTurnId: turnId,
      agentName: current.agentName,
      cwd: current.cwd,
      title: current.title,
      modelProvider: current.modelProvider,
      model: current.model,
      reasoningEffort: current.reasoningEffort,
      permissionMode: current.permissionMode ?? "auto",
    });
    this.persistRuntimeSession(current, forked, "ready");
    this.store.updateRuntimeSession(current.localSessionId, {
      lastTurnId: turnId,
      lastTurnStatus: "completed",
    });
    this.outbound.registerSession(
      current.localSessionId,
      contextKey,
      forked.title ?? current.title,
      current.cwd,
      this.agentLabel(current.agentName),
    );
    this.store.audit(contextKey, "session_reset_to_turn", {
      localSessionId: current.localSessionId,
      previousRemoteSessionId,
      sourceRemoteSessionId,
      resetTurnId: turnId,
      forkedRemoteSessionId: forked.remoteSessionId,
    });
    const targetSummary = truncateText(
      (snapshot.prompt ?? snapshot.taskTitle ?? "未记录对话内容").replace(/\s+/g, " ").trim(),
      100,
    ) || "未记录对话内容";
    const targetTime = snapshot.completedAt ?? snapshot.startedAt;
    if (announce) {
      await this.outbound.sendText(
        contextKey,
        [
          "已将当前任务重置到：",
          targetSummary,
          `完成时间：${targetTime === undefined ? "未知" : formatResetTurnTime(targetTime)}`,
          `Turn ID：${turnId}`,
          "后续对话将从该轮完成后的状态继续；本地文件没有回退。",
        ].join("\n"),
      );
    }
  }

  private async resolveApproval(action: CardAction): Promise<void> {
    const sessionId = String(action.value.sessionId ?? "");
    const requestId = String(action.value.requestId ?? "");
    const decision = String(action.value.decision ?? "") as ApprovalDecision;
    if (!(["accept", "acceptForSession", "decline", "cancel"] as string[]).includes(decision)) {
      throw new Error("无效的确认选项。");
    }
    const loaded = await this.loadSession(this.requireSession(action.contextKey, sessionId));
    await loaded.runtime.respondToApproval(sessionId, requestId, decision);
  }

  private async openExecutionSettings(
    contextKey: string,
    activeTab: ExecutionSettingsTab,
    options: ExecutionSettingsCardOptions = {},
  ): Promise<void> {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    const record = options.sessionId
      ? this.requireSession(contextKey, options.sessionId)
      : this.currentSession(contextKey);
    if (!record && activeTab !== "agent") this.requireCurrentSession(contextKey);
    const agents = Object.entries(this.config.agents).map(([name, agent]) => ({
      name,
      title: agent.title,
    }));

    let runtimeSettings: Omit<Parameters<CardRenderer["renderExecutionSettings"]>[0],
      "sessionId" | "contextKey" | "activeTab" | "currentAgent" | "taskAgent" | "agents" | "runtimeSettingsAvailable" | "notice"> = {
        currentPermissionMode: "auto",
        providers: [],
        providerSupported: false,
        models: [],
        reasoningOptions: [],
      };
    if (record) {
      const loaded = await this.loadSession(record);
      const models = await loaded.runtime.listModels();
      const currentModel = models.find((model) => model.id === loaded.session.model)
        ?? models.find((model) => model.isDefault);
      const providerSupported = loaded.runtime.kind === "codex" && Boolean(loaded.runtime.listModelProviders);
      const providers = providerSupported ? await this.modelProviderOptions(loaded) : [];
      const currentProvider = loaded.session.modelProvider ?? providers.find((provider) => provider.isDefault)?.id;
      const currentEffort = currentModel?.supportedReasoningEfforts.some(
        (option) => option.value === loaded.session.reasoningEffort,
      )
        ? loaded.session.reasoningEffort
        : currentModel?.defaultReasoningEffort ?? loaded.session.reasoningEffort;
      runtimeSettings = {
        currentProvider,
        currentModel: currentModel?.id ?? loaded.session.model,
        currentEffort,
        currentPermissionMode: loaded.session.permissionMode,
        providers,
        providerSupported,
        models,
        reasoningOptions: currentModel?.supportedReasoningEfforts ?? [],
      };
    }
    const card = this.cardRenderer.renderExecutionSettings({
      ...(record ? { sessionId: record.localSessionId, taskAgent: record.agentName } : {}),
      contextKey,
      activeTab,
      currentAgent: context.defaultAgent,
      agents,
      runtimeSettingsAvailable: Boolean(record),
      ...runtimeSettings,
      notice: options.notice,
    });
    if (options.updateMessageId) {
      await this.outbound.updateInteractiveCard(contextKey, options.updateMessageId, card);
    } else {
      await this.outbound.sendInteractiveCard(contextKey, card);
    }
  }

  private async openAgentSettings(contextKey: string): Promise<void> {
    const current = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!).defaultAgent;
    if (Object.keys(this.config.agents).length <= 1) {
      await this.outbound.sendText(contextKey, `当前 Agent：${current}\n当前没有其他 Agent 可以切换。`);
      return;
    }
    await this.openExecutionSettings(contextKey, "agent");
  }

  private async openProviderSettings(contextKey: string): Promise<void> {
    const loaded = await this.loadSession(this.requireCurrentSession(contextKey));
    const providers = loaded.runtime.kind === "codex" && loaded.runtime.listModelProviders
      ? await this.modelProviderOptions(loaded)
      : [];
    const current = loaded.session.modelProvider?.trim()
      || providers.find((provider) => provider.isDefault)?.id
      || "运行时默认";
    if (providers.length <= 1) {
      await this.outbound.sendText(contextKey, `当前 Provider：${current}\n当前没有其他 Provider 可以切换。`);
      return;
    }
    await this.openExecutionSettings(contextKey, "provider", { sessionId: loaded.record.localSessionId });
  }

  private async selectProvider(
    contextKey: string,
    modelProvider: string,
    options: ModelCardOptions = {},
  ): Promise<void> {
    const record = options.sessionId
      ? this.requireSession(contextKey, options.sessionId)
      : this.requireCurrentSession(contextKey);
    const loaded = await this.loadSession(record);
    await this.assertModelProvider(loaded, modelProvider);
    const models = await loaded.runtime.listModels();
    const model = models.find((candidate) => candidate.id === loaded.session.model)
      ?? models.find((candidate) => candidate.isDefault);
    if (!model) throw new Error("当前运行时没有可用于 Provider 切换的模型。");
    const effort = model.supportedReasoningEfforts.some(
      (candidate) => candidate.value === loaded.session.reasoningEffort,
    )
      ? loaded.session.reasoningEffort
      : model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0]?.value;
    if (!effort) throw new Error(`模型 ${model.id} 没有可用于 Provider 切换的思考强度。`);
    await this.applyProviderSettings(contextKey, {
      provider: modelProvider,
      model: model.id,
      effort,
      mode: loaded.session.permissionMode,
    }, options);
  }

  private async openProviderSelector(
    contextKey: string,
    options: ExecutionSettingsCardOptions = {},
  ): Promise<void> {
    await this.openExecutionSettings(contextKey, "provider", options);
  }

  private async openProviderModelSelector(
    contextKey: string,
    modelProvider: string,
    permissionMode: PermissionMode,
    sessionId: string,
    updateMessageId: string,
  ): Promise<void> {
    const loaded = await this.loadSession(this.requireSession(contextKey, sessionId));
    await this.assertModelProvider(loaded, modelProvider);
    const models = await loaded.runtime.listModels();
    const card = this.cardRenderer.renderModelSelector({
      sessionId,
      contextKey,
      currentModel: loaded.session.model ?? models.find((model) => model.isDefault)?.id,
      reasoningEffort: loaded.session.reasoningEffort,
      models,
      modelProvider,
      permissionMode,
      unifiedSettings: true,
    });
    await this.outbound.updateInteractiveCard(contextKey, updateMessageId, card);
  }

  private async openProviderReasoningSelector(
    contextKey: string,
    modelProvider: string,
    model: string,
    permissionMode: PermissionMode,
    sessionId: string,
    updateMessageId: string,
  ): Promise<void> {
    const loaded = await this.loadSession(this.requireSession(contextKey, sessionId));
    await this.assertModelProvider(loaded, modelProvider);
    const models = await loaded.runtime.listModels();
    const selected = models.find((candidate) => candidate.id === model);
    if (!selected) throw new Error(`未知模型：${model}`);
    const currentEffort = selected.supportedReasoningEfforts.some(
      (option) => option.value === loaded.session.reasoningEffort,
    )
      ? loaded.session.reasoningEffort
      : selected.defaultReasoningEffort;
    const card = this.cardRenderer.renderReasoningSelector({
      sessionId,
      contextKey,
      modelProvider,
      model,
      currentEffort,
      options: selected.supportedReasoningEfforts,
      permissionMode,
      unifiedSettings: true,
    });
    await this.outbound.updateInteractiveCard(contextKey, updateMessageId, card);
  }

  private async openProviderPermissionSelector(
    contextKey: string,
    modelProvider: string,
    model: string,
    effort: string,
    permissionMode: PermissionMode,
    sessionId: string,
    updateMessageId: string,
  ): Promise<void> {
    const loaded = await this.loadSession(this.requireSession(contextKey, sessionId));
    await this.assertProviderModelSettings(loaded, modelProvider, model, effort);
    await this.outbound.updateInteractiveCard(
      contextKey,
      updateMessageId,
      this.cardRenderer.renderPermissionSelector({
        sessionId,
        contextKey,
        modelProvider,
        model,
        reasoningEffort: effort,
        currentMode: permissionMode,
      }),
    );
  }

  private async applyProviderSettings(
    contextKey: string,
    settings: { provider: string; model: string; effort: string; mode: PermissionMode },
    options: ModelCardOptions = {},
  ): Promise<void> {
    const record = options.sessionId
      ? this.requireSession(contextKey, options.sessionId)
      : this.requireCurrentSession(contextKey);
    const loaded = await this.loadSession(record);
    await this.assertProviderModelSettings(loaded, settings.provider, settings.model, settings.effort);
    if (!loaded.runtime.setExecutionSettings) {
      throw new Error("当前运行时不支持 Provider 设置。");
    }
    const session = await loaded.runtime.setExecutionSettings(loaded.record.localSessionId, {
      modelProvider: settings.provider,
      model: settings.model,
      reasoningEffort: settings.effort,
      permissionMode: settings.mode,
    });
    this.store.updateRuntimeSession(loaded.record.localSessionId, {
      modelProvider: session.modelProvider ?? settings.provider,
      model: session.model ?? settings.model,
      reasoningEffort: session.reasoningEffort ?? settings.effort,
      permissionMode: session.permissionMode,
    });
    await this.persistAgentExecutionDefaults(loaded.record.localSessionId);
    const notice = [
      `Provider 已切换为 ${cardCode(session.modelProvider ?? settings.provider)}`,
      `模型 ${cardCode(session.model ?? settings.model)}`,
      `思考强度 ${cardCode(session.reasoningEffort ?? settings.effort)}`,
      `权限 ${cardCode(session.permissionMode)}`,
      `并已保存为 ${cardCode(loaded.record.agentName)} Agent 的默认设置，从下一次请求生效。`,
    ].join("，");
    if (options.updateMessageId) {
      await this.openProviderSelector(contextKey, {
        sessionId: loaded.record.localSessionId,
        updateMessageId: options.updateMessageId,
        notice,
      });
    } else {
      await this.outbound.sendText(contextKey, notice.replaceAll("`", ""));
    }
  }

  private async assertProviderModelSettings(
    loaded: LoadedSession,
    modelProvider: string,
    model: string,
    effort: string,
  ): Promise<void> {
    await this.assertModelProvider(loaded, modelProvider);
    const selected = (await loaded.runtime.listModels()).find((candidate) => candidate.id === model);
    if (!selected) throw new Error(`未知模型：${model}`);
    if (!selected.supportedReasoningEfforts.some((option) => option.value === effort)) {
      const supported = selected.supportedReasoningEfforts.map((option) => option.value).join("、") || "无";
      throw new Error(`模型 ${model} 不支持思考强度 ${effort}。支持的强度：${supported}`);
    }
  }

  private async assertModelProvider(loaded: LoadedSession, modelProvider: string): Promise<void> {
    const providers = await this.modelProviderOptions(loaded);
    if (!providers.some((provider) => provider.id === modelProvider)) {
      throw new Error(`未知 Provider：${modelProvider}`);
    }
  }

  private async modelProviderOptions(loaded: LoadedSession) {
    if (loaded.runtime.kind !== "codex" || !loaded.runtime.listModelProviders) {
      throw new Error("当前任务不支持 Provider 设置。");
    }
    const providers = await loaded.runtime.listModelProviders();
    const current = loaded.session.modelProvider?.trim();
    if (current && !providers.some((provider) => provider.id === current)) {
      providers.unshift({ id: current });
    }
    return providers;
  }

  private async model(contextKey: string, model?: string, options: ModelCardOptions = {}): Promise<void> {
    if (!model) {
      await this.openExecutionSettings(contextKey, "model", options);
      return;
    }
    const record = options.sessionId
      ? this.requireSession(contextKey, options.sessionId)
      : this.requireCurrentSession(contextKey);
    const loaded = await this.loadSession(record);
    const models = await loaded.runtime.listModels();
    const selected = models.find((item) => item.id === model);
    if (!selected) throw new Error(`未知模型：${model}`);
    const currentEffort = loaded.session.reasoningEffort;
    const compatible = currentEffort
      ? selected.supportedReasoningEfforts.some((option) => option.value === currentEffort)
      : false;
    const nextEffort = compatible ? currentEffort : selected.defaultReasoningEffort;

    await loaded.runtime.setModel(loaded.record.localSessionId, model);
    if (nextEffort && nextEffort !== currentEffort) {
      await loaded.runtime.setReasoningEffort(loaded.record.localSessionId, nextEffort);
    }
    this.store.updateRuntimeSession(loaded.record.localSessionId, { model, reasoningEffort: nextEffort });
    await this.persistAgentExecutionDefaults(loaded.record.localSessionId);
    const effortMessage = nextEffort && nextEffort !== currentEffort
      ? `，思考强度已自动调整为 ${nextEffort}`
      : "";
    if (options.updateMessageId) {
      await this.openExecutionSettings(contextKey, "model", {
        sessionId: loaded.record.localSessionId,
        updateMessageId: options.updateMessageId,
        notice: `模型已切换为 ${cardCode(model)}${effortMessage}，并已保存为 ${cardCode(loaded.record.agentName)} Agent 的默认设置，从下一次请求生效。`,
      });
      return;
    }
    await this.outbound.sendText(
      contextKey,
      `模型已切换为 ${model}${effortMessage}，并已保存为 ${loaded.record.agentName} Agent 的默认设置，从下一次请求生效。`,
    );
  }

  private async goal(contextKey: string, command: Extract<Command, { type: "goal" }>): Promise<void> {
    const objective = command.action === "set" || command.action === "edit" ? command.objective : undefined;
    if (objective !== undefined) validateGoalObjective(objective);
    let record = this.currentSession(contextKey);
    if (!record) {
      if (command.action !== "set") {
        throw new Error("当前没有任务。请使用 /goal <目标> 创建 Goal，或先发送消息创建任务。");
      }
      const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
      const agent = this.ensureAgent(context.defaultAgent);
      if (agent.kind !== "app-server") throw new Error("Goal 模式仅支持 App Server 任务。");
      record = await this.createSession(
        contextKey,
        context.defaultAgent,
        this.inheritedNewTaskCwd(contextKey),
        false,
        false,
        objective,
      );
    }

    const loaded = await this.loadSession(record);
    if (loaded.runtime.kind !== "codex" || !loaded.runtime.getGoal || !loaded.runtime.setGoal || !loaded.runtime.clearGoal) {
      throw new Error("当前 Agent 不支持 Goal 模式。");
    }

    if (command.action === "show") {
      await this.sendGoalCard(contextKey, await loaded.runtime.getGoal(record.localSessionId));
      return;
    }
    if (command.action === "clear") {
      const cleared = await loaded.runtime.clearGoal(record.localSessionId);
      if (!cleared) {
        await this.outbound.sendText(contextKey, "当前任务没有 Goal。");
        return;
      }
      await this.sendGoalCard(contextKey, undefined, "Goal 已清除；当前正在执行的轮次不会被中断。", record);
      return;
    }

    const current = await loaded.runtime.getGoal(record.localSessionId);
    if (command.action === "pause" || command.action === "resume") {
      if (!current) throw new Error("当前任务没有 Goal。使用 /goal <目标> 创建一个 Goal。");
      const status = command.action === "pause" ? "paused" : "active";
      const goal = await loaded.runtime.setGoal(record.localSessionId, { status });
      await this.sendGoalCard(
        contextKey,
        goal,
        command.action === "pause"
          ? "Goal 已暂停；当前轮次可以完成，但不会继续自动执行。"
          : "Goal 已恢复，Agent 会继续自动执行。",
        record,
      );
      return;
    }

    if (objective === undefined) throw new Error("无效的 Goal 命令。");
    if (command.action === "set" && current && current.status !== "complete") {
      throw new Error("当前已有未完成的 Goal。使用 /goal edit <新目标> 修改，或先使用 /goal clear 清除。");
    }
    if (command.action === "edit" && !current) {
      throw new Error("当前任务没有可修改的 Goal。使用 /goal <目标> 创建一个 Goal。");
    }
    const goal = await loaded.runtime.setGoal(record.localSessionId, {
      objective,
      status: command.action === "edit" ? current!.status : "active",
      ...(command.action === "edit" ? { tokenBudget: current!.tokenBudget } : {}),
    });
    await this.sendGoalCard(
      contextKey,
      goal,
      command.action === "edit" ? "Goal 已更新。" : "Goal 已启动，Agent 会持续执行直到完成、暂停或遇到阻塞。",
      record,
    );
  }

  private async sendGoalCard(
    contextKey: string,
    goal: RuntimeGoal | undefined,
    notice?: string,
    record = this.currentSession(contextKey),
  ): Promise<void> {
    const card = this.renderGoalCard(goal, notice, record);
    if (!record) {
      await this.outbound.sendInteractiveCard(contextKey, card);
      return;
    }
    const existing = this.store.getGoalCardDelivery(record.localSessionId, contextKey);
    if (existing) {
      await this.outbound.updateInteractiveCard(contextKey, existing.messageId, card);
      return;
    }
    const messageId = await this.outbound.sendInteractiveCard(contextKey, card);
    if (messageId) this.store.saveGoalCardDelivery(record.localSessionId, contextKey, messageId);
  }

  private renderGoalCard(
    goal: RuntimeGoal | undefined,
    notice?: string,
    record?: SessionRecord,
  ): Record<string, unknown> {
    const sections: CardSection[] = [];
    if (notice) sections.push({ lines: [cardText(notice)] });
    sections.push(goal
      ? { title: "当前 Goal", lines: goalDetailLines(goal) }
      : { title: "当前 Goal", lines: ["未设置。使用 **/goal &#60;目标&#62;** 创建一个长任务。"] });
    if (record) {
      sections.push({
        title: "任务",
        lines: [
          `**标题**：${cardText(record.title ?? "未命名任务")}`,
          `**App Server 任务 ID**：${cardText(record.remoteSessionId ?? "尚未创建")}`,
        ],
      });
    }
    sections.push({
      title: "命令",
      lines: [
        "**/goal**　查看　　**/goal pause**　暂停　　**/goal resume**　恢复",
        "**/goal edit &#60;新目标&#62;**　修改　　**/goal clear**　清除",
      ],
    });
    const title = goal ? `Agent Goal · ${goalStatusLabel(goal.status)}` : "Agent Goal";
    return this.cardRenderer.renderSectionsCard(title, sections);
  }

  private async refreshGoalCards(localSessionId: string): Promise<void> {
    const deliveries = this.store.listGoalCardDeliveries(localSessionId);
    if (deliveries.length === 0) return;
    const record = this.store.getSession(localSessionId);
    if (!record) return;
    const runtime = this.runtimes.forAgent(record.agentName);
    if (runtime.kind !== "codex" || !runtime.getGoal) return;

    try {
      const loaded = runtime.getSession(localSessionId) ?? (await this.loadSession(record)).session;
      const goal = await runtime.getGoal(loaded.localSessionId);
      const card = this.renderGoalCard(goal, undefined, record);
      await Promise.all(deliveries.map(async (delivery) => {
        try {
          await this.outbound.updateInteractiveCard(delivery.contextKey, delivery.messageId, card);
        } catch (error) {
          this.logger.warn(
            { error, localSessionId, contextKey: delivery.contextKey, messageId: delivery.messageId },
            "Failed to refresh an Agent Goal card.",
          );
        }
      }));
    } catch (error) {
      this.logger.warn({ error, localSessionId }, "Failed to read the latest Agent Goal status.");
    }
  }

  private async runShellCommand(
    contextKey: string,
    command: string,
    sourceMessageId?: string,
    incomingMessage?: IncomingMessage,
  ): Promise<void> {
    const cwd = await this.shellCommandCwd(contextKey, incomingMessage);
    const created = await this.shellCommandJobs.createJob({ contextKey, sourceMessageId, command, cwd });
    let cardMessageId: string | undefined;
    const initialState: ShellCommandCardView = {
      jobId: created.id,
      contextKey,
      command,
      cwd,
      output: "",
      outputTruncated: false,
      status: "running",
      elapsedMs: 0,
    };
    try {
      cardMessageId = await this.outbound.sendInteractiveCard(
        contextKey,
        this.cardRenderer.renderShellCommandCard(initialState),
      );
      if (!cardMessageId) throw new Error("Failed to create the shell command card.");
      const bound = await this.shellCommandJobs.bindCard(created.id, cardMessageId);
      await this.shellCommandJobs.startJob(created.id);
      this.monitorShellCommandJob(bound, initialState);
    } catch (error) {
      await this.shellCommandJobs.failJob(created.id, runtimeErrorMessage(error)).catch(() => undefined);
      if (cardMessageId) {
        try {
          const failed = await this.shellCommandJobs.readJob(created.id);
          await this.outbound.updateInteractiveCard(
            contextKey,
            cardMessageId,
            this.cardRenderer.renderShellCommandCard(shellCommandJobCardView(failed)),
          );
          await this.shellCommandJobs.markPresented(created.id);
        } catch (cardError) {
          this.logger.warn(
            { error: cardError, jobId: created.id, contextKey, messageId: cardMessageId },
            "Failed to finalize a shell command card after the runner failed to start.",
          );
        }
      } else {
        await this.shellCommandJobs.markPresented(created.id).catch(() => undefined);
      }
      throw error;
    }
  }

  private async shellCommandCwd(contextKey: string, incomingMessage?: IncomingMessage): Promise<string> {
    const current = this.currentSession(contextKey);
    if (current) return current.cwd;

    if (incomingMessage?.threadContext) {
      const anchorMessageIds = threadForkAnchorMessageIds(incomingMessage);
      const anchor = anchorMessageIds
        .map((messageId) => this.store.findTurnAnchorByMessageId(messageId))
        .find((candidate) => candidate !== undefined);
      const source = anchor?.contextKey
        ? this.store.getSessionForContext(anchor.localSessionId, anchor.contextKey)
        : anchor
          ? this.store.getSession(anchor.localSessionId)
          : undefined;
      const sourceContextKey = anchor?.contextKey ?? source?.contextKey;
      if (source && sourceContextKey && baseChatContextKey(sourceContextKey) === baseChatContextKey(contextKey)) {
        return source.cwd;
      }

      for (const messageId of anchorMessageIds) {
        const commandJob = await this.shellCommandJobs.findJobByCardMessageId(messageId);
        if (commandJob && baseChatContextKey(commandJob.contextKey) === baseChatContextKey(contextKey)) {
          return commandJob.cwd;
        }
      }

      const baseContextKey = baseChatContextKey(contextKey);
      const baseSession = this.currentSession(baseContextKey);
      if (baseSession) return baseSession.cwd;
      const boundProjectCwd = this.store.getUserContext(baseContextKey)?.boundProjectCwd;
      if (boundProjectCwd) return boundProjectCwd;
    }

    return this.config.defaults.cwd;
  }

  private monitorShellCommandJob(
    job: ShellCommandJobSnapshot,
    seededState?: ShellCommandCardView,
  ): void {
    if (!job.cardMessageId || this.shellCommandJobMonitors.has(job.id)) return;
    const scheduler = new CardUpdateScheduler<ShellCommandCardView>({
      render: (state) => this.cardRenderer.renderShellCommandCard(state),
      write: (card) => this.outbound.updateInteractiveCard(job.contextKey, job.cardMessageId!, card),
      onError: (error) => this.logger.warn(
        { error, jobId: job.id, contextKey: job.contextKey, messageId: job.cardMessageId },
        "Failed to update a background shell command card.",
      ),
    });
    if (seededState) scheduler.seed(seededState);
    const monitor: ShellCommandJobMonitor = {
      scheduler,
      refreshing: false,
      timer: setInterval(() => {
        void this.refreshShellCommandJob(job.id);
      }, SHELL_COMMAND_JOB_POLL_INTERVAL_MS),
    };
    monitor.timer.unref?.();
    this.shellCommandJobMonitors.set(job.id, monitor);
    void this.refreshShellCommandJob(job.id, seededState === undefined);
  }

  private async refreshShellCommandJob(jobId: string, critical = false): Promise<void> {
    const monitor = this.shellCommandJobMonitors.get(jobId);
    if (!monitor || monitor.refreshing) return;
    monitor.refreshing = true;
    try {
      const job = await this.shellCommandJobs.readJob(jobId);
      const view = shellCommandJobCardView(job);
      if (isActiveShellCommandJob(job.status)) {
        monitor.scheduler.update(view, critical ? "critical" : "normal");
        return;
      }
      await monitor.scheduler.flush(view);
      if (job.sourceMessageId) {
        await this.finalizeStandaloneMessageReaction(
          job.sourceMessageId,
          job.status === "completed" ? "completed" : job.status === "cancelled" ? "cancelled" : "failed",
        );
      }
      await this.shellCommandJobs.markPresented(jobId);
      this.stopShellCommandJobMonitor(jobId);
    } catch (error) {
      this.logger.warn({ error, jobId }, "Failed to refresh a background shell command job.");
    } finally {
      const current = this.shellCommandJobMonitors.get(jobId);
      if (current) current.refreshing = false;
    }
  }

  private stopShellCommandJobMonitor(jobId: string): void {
    const monitor = this.shellCommandJobMonitors.get(jobId);
    if (!monitor) return;
    clearInterval(monitor.timer);
    monitor.scheduler.dispose();
    this.shellCommandJobMonitors.delete(jobId);
  }

  private async cancelShellCommandJob(contextKey: string, jobId: string): Promise<void> {
    if (!jobId) throw new Error("命令任务无效，请使用最新的命令卡片。");
    const job = await this.shellCommandJobs.readJob(jobId);
    if (job.contextKey !== contextKey) throw new Error("该命令不属于当前会话。");
    const requested = await this.shellCommandJobs.requestCancellation(jobId);
    if (!requested) {
      await this.outbound.sendText(contextKey, "该命令已经结束。");
      return;
    }
    if (!this.shellCommandJobMonitors.has(jobId)) this.monitorShellCommandJob(job);
    await this.refreshShellCommandJob(jobId, true);
  }

  private async recoverShellCommandJobs(): Promise<void> {
    const jobs = await this.shellCommandJobs.listRecoverableJobs();
    if (jobs.length > 0) {
      this.logger.warn(
        { jobIds: jobs.map((job) => job.id) },
        "Recovering background shell command jobs after startup.",
      );
    }
    for (const job of jobs) {
      if (!job.cardMessageId || !this.outbound.canRoute(job.contextKey)) continue;
      if (
        job.status === "starting"
        && job.runnerPid === undefined
        && Date.now() - job.updatedAt >= SHELL_COMMAND_JOB_RELAUNCH_DELAY_MS
      ) {
        try {
          await this.shellCommandJobs.startJob(job.id);
        } catch (error) {
          await this.shellCommandJobs.failJob(job.id, runtimeErrorMessage(error)).catch(() => undefined);
        }
      }
      const refreshed = await this.shellCommandJobs.readJob(job.id);
      this.monitorShellCommandJob(refreshed);
    }
  }

  private async setTitle(contextKey: string, title: string): Promise<void> {
    const normalizedTitle = normalizeTaskTitle(title);
    if (!normalizedTitle) throw new Error("任务标题不能为空。");
    const loaded = await this.loadSession(this.requireCurrentSession(contextKey));
    if (loaded.runtime.setTitle) await loaded.runtime.setTitle(loaded.record.localSessionId, normalizedTitle);
    else loaded.session.title = normalizedTitle;
    this.store.updateRuntimeSession(loaded.record.localSessionId, { title: normalizedTitle });
    this.outbound.updateSessionTitle(loaded.record.localSessionId, normalizedTitle);
    await this.outbound.sendText(contextKey, `已将当前任务标题修改为：${normalizedTitle}`);
  }

  private async syncTaskTitleFromGroupName(
    contextKey: string,
    event: ChatUpdatedEvent,
  ): Promise<void> {
    const context = this.store.getUserContext(contextKey);
    if (!context?.currentSessionId) return;
    const record = this.store.getSessionForContext(context.currentSessionId, contextKey);
    if (!record || record.status === "closed") return;
    const nameFormat = this.config.feishu?.groupNameFormat ?? DEFAULT_GROUP_NAME_FORMAT;
    const projectCwd = detectProjectlessWorkspace(record.cwd) ? undefined : record.cwd;
    const templateTitle = parseTaskNameFromGroupName({
      agentName: record.agentName,
      groupName: event.afterName,
      projectCwd,
      format: nameFormat,
    });
    const legacy = parseAgentGroupName(event.afterName);
    const legacyTitle = legacy && record.agentName.toLowerCase() === legacy.agentName.toLowerCase()
      ? legacy.title
      : undefined;
    if (isDefaultGroupNameFormat(nameFormat) && isLegacyGroupPrefixOnly(event.afterName)) return;
    const title = normalizeTaskTitle(isDefaultGroupNameFormat(nameFormat)
      ? legacyTitle ?? templateTitle
      : templateTitle ?? legacyTitle);
    if (!title || title === record.title) return;

    const loaded = await this.loadSession(record);
    if (loaded.runtime.setTitle) await loaded.runtime.setTitle(record.localSessionId, title);
    else loaded.session.title = title;
    this.store.updateRuntimeSession(record.localSessionId, { title });
    this.outbound.updateSessionTitle(record.localSessionId, title);
    this.store.audit(contextKey, "session_title_changed", {
      localSessionId: record.localSessionId,
      title,
      source: "group_name",
      beforeName: event.beforeName,
      afterName: event.afterName,
    });
  }

  private async thinking(contextKey: string, effort?: string, options: ThinkingCardOptions = {}): Promise<void> {
    if (!effort) {
      await this.openExecutionSettings(contextKey, "thinking", options);
      return;
    }
    const record = options.sessionId
      ? this.requireSession(contextKey, options.sessionId)
      : this.requireCurrentSession(contextKey);
    const loaded = await this.loadSession(record);
    const models = await loaded.runtime.listModels();
    const currentModel = models.find((item) => item.id === loaded.session.model)
      ?? models.find((item) => item.isDefault);
    if (!currentModel) throw new Error("当前运行时没有可配置思考强度的模型。");
    if (options.expectedModel && currentModel.id !== options.expectedModel) {
      throw new Error("模型已发生变化，请重新打开 /model。");
    }
    const supported = currentModel.supportedReasoningEfforts;

    if (!supported.some((option) => option.value === effort)) {
      const options = supported.map((option) => option.value).join("、") || "无";
      throw new Error(`不支持的思考强度：${effort}。支持的强度：${options}`);
    }
    await loaded.runtime.setReasoningEffort(loaded.record.localSessionId, effort);
    this.store.updateRuntimeSession(loaded.record.localSessionId, { reasoningEffort: effort });
    await this.persistAgentExecutionDefaults(loaded.record.localSessionId);
    if (options.updateMessageId) {
      await this.openExecutionSettings(contextKey, "thinking", {
        sessionId: loaded.record.localSessionId,
        updateMessageId: options.updateMessageId,
        notice: `思考强度已切换为 ${cardCode(effort)}，并已保存为 ${cardCode(loaded.record.agentName)} Agent 的默认设置，从下一次请求生效。`,
      });
      return;
    }
    await this.outbound.sendText(
      contextKey,
      `思考强度已切换为 ${effort}，并已保存为 ${loaded.record.agentName} Agent 的默认设置，从下一次请求生效。`,
    );
  }

  private async permissions(
    contextKey: string,
    mode?: PermissionMode,
    options: ModelCardOptions = {},
  ): Promise<void> {
    if (!mode) {
      await this.openExecutionSettings(contextKey, "permission", options);
      return;
    }
    const record = options.sessionId
      ? this.requireSession(contextKey, options.sessionId)
      : this.requireCurrentSession(contextKey);
    const loaded = await this.loadSession(record);
    await loaded.runtime.setPermissionMode(record.localSessionId, mode);
    loaded.session.permissionMode = mode;
    this.store.updateRuntimeSession(record.localSessionId, { permissionMode: mode });
    await this.persistAgentExecutionDefaults(record.localSessionId);
    if (options.updateMessageId) {
      await this.openExecutionSettings(contextKey, "permission", {
        sessionId: loaded.record.localSessionId,
        updateMessageId: options.updateMessageId,
        notice: mode === "auto"
          ? `已切换为自动执行模式，并已保存为 ${cardCode(loaded.record.agentName)} Agent 的默认设置，从下一次请求生效。`
          : `已切换为执行前确认模式，并已保存为 ${cardCode(loaded.record.agentName)} Agent 的默认设置，从下一次请求生效。`,
      });
      return;
    }
    await this.outbound.sendText(
      contextKey,
      mode === "auto"
        ? `已切换为自动执行模式，并已保存为 ${loaded.record.agentName} Agent 的默认设置。`
        : `已切换为执行前确认模式，并已保存为 ${loaded.record.agentName} Agent 的默认设置。`,
    );
  }

  private async openResetHistory(
    contextKey: string,
    options: ResetHistoryCardOptions = {},
  ): Promise<void> {
    const current = this.requireCurrentSession(contextKey);
    if (options.expectedSessionId && current.localSessionId !== options.expectedSessionId) {
      throw new Error("这张历史轮次卡片不属于当前任务。请先切换回对应任务，再重新发送 /turns。");
    }
    if (!current.remoteSessionId || !this.isCodexSession(current)) {
      throw new Error("当前任务不是可 Reset 的 App Server 任务。");
    }
    await this.hydrateLegacyForkTurnHistory(contextKey, current);
    await this.hydrateRemoteTurnHistory(contextKey, current);
    const completedTurns = this.store.listTaskTurnGraph(current.localSessionId);
    const completedTurnIds = new Set(completedTurns.map((turn) => turn.turnId));
    const runningTurnId = current.lastTurnStatus === "running" && current.lastTurnId
      && !completedTurnIds.has(current.lastTurnId)
      ? current.lastTurnId
      : undefined;
    const persistedRunningSnapshot = runningTurnId
      ? turnViewSnapshot(this.store.getTurnSnapshot(runningTurnId))
      : undefined;
    const runningAttempt = runningTurnId
      ? this.store.findIncompleteTurnAttemptByTurnId(runningTurnId)
      : undefined;
    const attemptStartedAt = Date.parse(runningAttempt?.createdAt ?? "");
    const runningSnapshot: TurnViewState | undefined = runningTurnId
      ? persistedRunningSnapshot ?? {
          sessionId: current.localSessionId,
          turnId: runningTurnId,
          prompt: runningAttempt?.promptText ?? current.title,
          status: "running",
          startedAt: Number.isFinite(attemptStartedAt) ? attemptStartedAt : Date.now(),
          assistantText: "",
          plan: [],
          activities: [],
          completedTools: [],
          failedTools: [],
          fileSummary: [],
        }
      : undefined;
    const runningTurn = runningTurnId && runningSnapshot
      ? {
          turnId: runningTurnId,
          parentTurnId: this.store.getTurnParent(runningTurnId, current.localSessionId),
          snapshot: runningSnapshot,
          updatedAt: runningAttempt?.updatedAt ?? new Date(runningSnapshot.startedAt).toISOString(),
        }
      : undefined;
    const allTurns = runningTurn ? [runningTurn, ...completedTurns] : completedTurns;
    const graphRows = buildTurnGraphRows(allTurns.map((turn) => ({
      turnId: turn.turnId,
      parentTurnId: turn.parentTurnId,
    })));
    const total = allTurns.length;
    const totalPages = Math.max(1, Math.ceil(total / RESET_HISTORY_PAGE_SIZE));
    const page = Math.max(0, Math.min(Math.trunc(options.page ?? 0), totalPages - 1));
    const offset = page * RESET_HISTORY_PAGE_SIZE;
    const turns = allTurns.slice(offset, offset + RESET_HISTORY_PAGE_SIZE);
    const resettingTurnId = this.resetHistoryOperations.get(current.localSessionId);
    const entries: ResetHistoryCardEntry[] = turns.flatMap((turn, index) => {
      const snapshot = turnViewSnapshot(turn.snapshot);
      if (!snapshot) return [];
      const graph = graphRows[offset + index]!;
      const summary = truncateText(
        (snapshot.prompt ?? snapshot.taskTitle ?? "未记录对话内容").replace(/\s+/g, " ").trim(),
        100,
      );
      const isCurrent = current.lastTurnId === turn.turnId && current.lastTurnStatus === "completed";
      const isRunning = runningTurnId === turn.turnId;
      const isResetting = resettingTurnId === turn.turnId;
      return [{
        sequence: graph.sequence,
        graphNodeLine: graph.nodeLine,
        graphConnectorLine: graph.connectorLine,
        lines: [cardText(summary || "未记录对话内容")],
        timestamp: formatResetTurnTime(snapshot.completedAt ?? snapshot.startedAt),
        current: isCurrent,
        running: isRunning,
        resetting: isResetting,
        actions: isCurrent || isRunning || resettingTurnId ? undefined : [{
          text: "Reset",
          value: {
            action: "turn_reset",
            cardView: "reset_history",
            sessionId: current.localSessionId,
            turnId: turn.turnId,
            contextKey,
            page: String(page),
          },
        }],
      }];
    });
    const pageActions: TaskListCardAction[] = [
      ...(page > 0 ? [{
        text: "Previous",
        value: {
          action: "turn_reset_page",
          sessionId: current.localSessionId,
          contextKey,
          page: String(page - 1),
        },
      }] : []),
      ...(page < totalPages - 1 ? [{
        text: "Next",
        value: {
          action: "turn_reset_page",
          sessionId: current.localSessionId,
          contextKey,
          page: String(page + 1),
        },
      }] : []),
    ];
    const card = this.cardRenderer.renderResetHistoryCard({
      entries,
      footerLines: [
        runningTurn
          ? `第 ${page + 1}/${totalPages} 页 · 共 ${total} 个 turn（${completedTurns.length} 个已完成，1 个运行中）`
          : `第 ${page + 1}/${totalPages} 页 · 共 ${total} 个已完成 turn`,
        ...(resettingTurnId ? ["正在 Reset 到所选轮次，请稍候…"] : []),
      ],
      pageActions,
    });
    if (options.updateMessageId) {
      await this.outbound.updateInteractiveCard(contextKey, options.updateMessageId, card);
    } else {
      await this.outbound.sendInteractiveCard(contextKey, card);
    }
  }

  private async openDirectoryBrowser(
    contextKey: string,
    requestedDirectory?: string,
    options: DirectoryBrowserOptions = {},
  ): Promise<void> {
    if (requestedDirectory === WINDOWS_DRIVES_DIRECTORY) {
      await this.openWindowsDriveBrowser(contextKey, options);
      return;
    }
    const baseDirectory = this.currentSession(contextKey)?.cwd
      ?? this.store.getUserContext(contextKey)?.boundProjectCwd
      ?? this.config.defaults.cwd;
    const directory = requestedDirectory === undefined
      ? path.resolve(baseDirectory)
      : resolveUserPath(requestedDirectory, baseDirectory);
    await this.assertBrowsableDirectory(directory);

    let directoryEntries: Dirent[];
    try {
      directoryEntries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`无法读取目录 ${directory}：${runtimeErrorMessage(error)}`);
    }
    const entries = directoryEntries
      .map((entry) => ({
        dirent: entry,
        name: entry.name,
        path: path.join(directory, entry.name),
        kind: entry.isDirectory() ? "directory" as const : "file" as const,
      }))
      .sort((left, right) => Number(right.kind === "directory") - Number(left.kind === "directory")
        || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
    const parentDirectory = isWindowsDriveRoot(directory)
      ? WINDOWS_DRIVES_DIRECTORY
      : path.dirname(directory);
    const parentEntries: DirectoryBrowserCardEntry[] = parentDirectory === directory ? [] : [{
      name: "..",
      kind: "directory",
      openAction: {
        text: "..",
        value: {
          action: "directory_open",
          directory: parentDirectory,
          contextKey,
        },
      },
    }];
    const pageSize = DIRECTORY_PAGE_SIZE;
    const requestedPage = Math.max(0, Math.trunc(options.page ?? 0));
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
    const page = Math.min(requestedPage, totalPages - 1);
    const offset = page * pageSize;
    const visibleEntries: DirectoryBrowserCardEntry[] = [
      ...parentEntries,
      ...entries
      .slice(offset, offset + pageSize)
      .map((entry): DirectoryBrowserCardEntry => {
        if (entry.kind === "directory") {
          return {
            name: entry.name,
            kind: entry.kind,
            openAction: {
              text: entry.name,
              value: {
                action: "directory_open",
                directory: entry.path,
                contextKey,
              },
            },
          };
        }
        return {
            name: entry.name,
            kind: directoryBrowserEntryKind(entry.dirent, entry.path),
            openAction: {
              text: entry.name,
              value: {
                action: "directory_send_file",
                filePath: entry.path,
                contextKey,
              },
            },
          };
      }),
    ];
    const navigationActions = directoryPaginationActions(directory, page, totalPages, contextKey);
    const directoryCount = entries.filter((entry) => entry.kind === "directory").length;
    const card = this.cardRenderer.renderDirectoryBrowserCard({
      directory: abbreviateHomeDirectory(directory),
      entries: visibleEntries,
      currentActions: directoryCreationActions(directory, contextKey, page),
      navigationActions,
      footerLines: [
        `第 ${page + 1}/${totalPages} 页 · ${directoryCount} 个目录 · ${entries.length - directoryCount} 个文件`,
        "",
        "> 点击目录名称进入，点击文件名称发送到当前会话；卡片顶部可新建目录、任务或群聊。",
      ],
    });
    if (options.updateMessageId) {
      await this.outbound.updateInteractiveCard(contextKey, options.updateMessageId, card);
    } else {
      await this.outbound.sendInteractiveCard(contextKey, card);
    }
  }

  private async openWindowsDriveBrowser(
    contextKey: string,
    options: DirectoryBrowserOptions,
  ): Promise<void> {
    const drives = await this.windowsDriveLister();
    const requestedPage = Math.max(0, Math.trunc(options.page ?? 0));
    const totalPages = Math.max(1, Math.ceil(drives.length / DIRECTORY_PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages - 1);
    const offset = page * DIRECTORY_PAGE_SIZE;
    const entries: DirectoryBrowserCardEntry[] = drives
      .slice(offset, offset + DIRECTORY_PAGE_SIZE)
      .map((drive) => ({
        name: windowsDriveDisplayName(drive),
        kind: "drive",
        openAction: {
          text: windowsDriveDisplayName(drive),
          value: {
            action: "directory_open",
            directory: drive.root,
            contextKey,
          },
        },
      }));
    const card = this.cardRenderer.renderDirectoryBrowserCard({
      directory: "此电脑",
      entries,
      currentActions: [],
      navigationActions: directoryPaginationActions(
        WINDOWS_DRIVES_DIRECTORY,
        page,
        totalPages,
        contextKey,
      ),
      footerLines: [
        `第 ${page + 1}/${totalPages} 页 · ${drives.length} 个磁盘`,
        "",
        "> 点击磁盘名称进入。",
      ],
    });
    if (options.updateMessageId) {
      await this.outbound.updateInteractiveCard(contextKey, options.updateMessageId, card);
    } else {
      await this.outbound.sendInteractiveCard(contextKey, card);
    }
  }

  private async assertBrowsableDirectory(directory: string): Promise<void> {
    let stats;
    try {
      stats = await fs.stat(directory);
    } catch (error) {
      throw new Error(`目录不存在或无法访问：${directory}（${runtimeErrorMessage(error)}）`);
    }
    if (!stats.isDirectory()) throw new Error(`这不是目录：${directory}`);
  }

  private async createDirectoryFromCard(contextKey: string, action: CardAction): Promise<void> {
    const directory = directoryActionPath(action.value.directory);
    await this.assertBrowsableDirectory(directory);
    const folderName = directoryFolderName(cardFormValue(action.value, "folderName"));
    const newDirectory = path.join(directory, folderName);
    try {
      await fs.mkdir(newDirectory);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
      if (code === "EEXIST") throw new Error(`目录已存在：${newDirectory}`);
      throw new Error(`无法创建目录 ${newDirectory}：${runtimeErrorMessage(error)}`);
    }
    await this.openDirectoryBrowser(contextKey, directory, {
      updateMessageId: requiredCardMessageId(action.messageId),
      page: directoryPageValue(action.value.page),
    });
    await this.outbound.sendText(contextKey, `已创建目录：${newDirectory}`);
  }

  private async assertSendableFile(filePath: string): Promise<void> {
    let stats;
    try {
      stats = await fs.stat(filePath);
    } catch (error) {
      throw new Error(`文件不存在或无法访问：${filePath}（${runtimeErrorMessage(error)}）`);
    }
    if (!stats.isFile()) throw new Error(`这不是普通文件：${filePath}`);
  }

  private async sendCurrentTaskFile(contextKey: string, requestedFilePath: string): Promise<void> {
    const record = this.requireCurrentSession(contextKey);
    const filePath = resolveUserPath(requestedFilePath, record.cwd);
    await this.assertSendableFile(filePath);
    await this.outbound.sendFile(contextKey, filePath);
  }

  private async listSessions(
    contextKey: string,
    searchTerm?: string,
    options: SessionsCardOptions = {},
  ): Promise<void> {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    const normalizedSearch = searchTerm?.trim().toLowerCase();
    const requestedPage = Math.max(0, Math.trunc(options.page ?? 0));
    const fetchLimit = (requestedPage + 1) * SESSION_PAGE_SIZE;
    const localSessions = this.store.listSessions(contextKey).filter((session) =>
      session.status !== "closed" && this.isCodexSession(session),
    );
    const remoteSessions: AgentRemoteSessionSummary[] = [];
    const remoteErrors: string[] = [];
    let remoteHasMore = false;
    await Promise.all(this.runtimes.entries("codex").map(async ([agentName, runtime]) => {
      if (!runtime.listRemoteSessions) return;
      try {
        const result = await this.listRemoteSessionsThroughCursor(runtime, searchTerm, fetchLimit);
        remoteSessions.push(...result.sessions.map((session) => ({ agentName, session })));
        remoteHasMore ||= Boolean(result.nextCursor);
      } catch (error) {
        this.logger.warn({ error, contextKey, agentName }, "Failed to list App Server sessions for an Agent.");
        remoteErrors.push(`${agentName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    const remoteHint = remoteErrors.length > 0
      ? `部分 Agent 的任务读取失败：${remoteErrors.join("；")}`
      : undefined;
    const latestLocalUserPrompts = new Map<string, string>();
    for (const session of localSessions) {
      const persisted = this.store.findLatestTurnSnapshotForSession(session.localSessionId);
      const prompt = latestUserPromptFromTurnView(turnViewSnapshot(persisted?.snapshot));
      if (prompt) latestLocalUserPrompts.set(session.localSessionId, prompt);
    }
    const latestRemoteUserPrompts = new Map<string, string>();
    for (const { agentName, session: remote } of remoteSessions) {
      const local = this.store.findSessionByRemoteSessionId(remote.id, undefined, agentName);
      if (!local) continue;
      const persisted = this.store.findLatestTurnSnapshotForSession(local.localSessionId);
      const prompt = latestUserPromptFromTurnView(turnViewSnapshot(persisted?.snapshot));
      if (prompt) latestRemoteUserPrompts.set(agentRemoteKey(agentName, remote.id), prompt);
    }

    const globallyOrderedEntries = orderTaskListByRecency(
      mergeTaskList(
        localSessions,
        remoteSessions,
        context.currentSessionId,
        latestLocalUserPrompts,
        latestRemoteUserPrompts,
      )
        .filter((entry) => !normalizedSearch
        || [entry.id, entry.title, entry.cwd, entry.agentName]
          .some((value) => value.toLowerCase().includes(normalizedSearch))),
    );
    const entries = groupTaskListPagesByProject(globallyOrderedEntries, SESSION_PAGE_SIZE);
    const activeCount = entries.filter((entry) => entry.active).length;
    const lastKnownPage = Math.max(0, Math.ceil(entries.length / SESSION_PAGE_SIZE) - 1);
    const page = remoteHasMore ? requestedPage : Math.min(requestedPage, lastKnownPage);
    const offset = page * SESSION_PAGE_SIZE;
    const visibleEntries = entries.slice(offset, offset + SESSION_PAGE_SIZE);
    const projectActionSources = new Map<string, UnifiedTaskListEntry>();
    for (const entry of entries) {
      const project = taskProjectInfo(entry);
      if (!projectActionSources.has(project.key)) projectActionSources.set(project.key, entry);
    }
    const hasPrevious = page > 0;
    const hasNext = remoteHasMore || entries.length > offset + SESSION_PAGE_SIZE;
    this.lastSessionListings.set(contextKey, entries.map((entry) => entry.reference));
    const cardActionBindings = new Map<string, CardActionBinding>();
    const bindCardAction = (action: TaskListCardAction): TaskListCardAction =>
      bindSessionCardAction(action, cardActionBindings);
    const cardEntries = visibleEntries.map((entry, index): {
      project: TaskProjectInfo;
      projectActions: TaskListCardAction[];
      cardEntry: SessionTaskCardEntry;
    } => {
      const project = taskProjectInfo(entry);
      const projectActionSource = projectActionSources.get(project.key) ?? entry;
      const marker = entry.current ? "✅ " : entry.active ? "🟢 " : "";
      const showStop = entry.status === "外部执行中"
        && entry.reference !== options.forceSwitchTaskId
        && entry.id !== options.forceSwitchTaskId;
      const actions: TaskListCardAction[] = entry.current ? [] : [bindCardAction({
        text: showStop ? "Stop" : "Switch",
        type: showStop ? "danger" as const : "default" as const,
        value: {
          action: showStop ? "session_stop" : "session_switch",
          sessionId: entry.reference,
          ...(searchTerm ? { searchTerm } : {}),
          page: String(page),
          contextKey,
        },
      })];
      const projectActions: TaskListCardAction[] = [bindCardAction({
        text: "New",
        value: {
          action: "session_new",
          sessionId: projectActionSource.reference,
          ...(searchTerm ? { searchTerm } : {}),
          page: String(page),
          contextKey,
        },
      }), bindCardAction({
        text: "NewGroup",
        value: {
          action: "session_new_group",
          sessionId: projectActionSource.reference,
          ...(searchTerm ? { searchTerm } : {}),
          page: String(page),
          contextKey,
        },
      })];
      actions.push(bindCardAction({
        text: "Fork",
        value: {
          action: "session_fork",
          sessionId: entry.reference,
          ...(searchTerm ? { searchTerm } : {}),
          page: String(page),
          contextKey,
        },
      }));
      actions.push(bindCardAction({
        text: "ForkGroup",
        value: {
          action: "session_fork_group",
          sessionId: entry.reference,
          ...(searchTerm ? { searchTerm } : {}),
          page: String(page),
          contextKey,
        },
      }));
      actions.push(bindCardAction({
        text: "Status",
        value: {
          action: "session_status",
          sessionId: entry.reference,
          contextKey,
        },
      }));
      actions.push(bindCardAction({
        text: "Archive",
        value: {
          action: "session_archive",
          sessionId: entry.reference,
          ...(searchTerm ? { searchTerm } : {}),
          page: String(page),
          contextKey,
        },
      }));
      const title = truncateText(entry.title.replace(/\s+/gu, " ").trim() || "未命名任务", 56);
      const lastUserPrompt = sessionPromptPreview(entry.lastUserPrompt);
      return {
        project,
        projectActions,
        cardEntry: {
          reference: entry.reference,
          summary: `${offset + index + 1}. ${marker}${title} · ${entry.agentName}`,
          detailLines: [
            `**最新 Prompt**：${cardText(lastUserPrompt)}`,
            `<font color='grey'>最近更新：${cardText(entry.updatedLabel)}</font>`,
          ],
          actions,
          current: entry.current,
        },
      };
    });
    const cardGroups: SessionTaskCardGroup[] = [];
    let currentProjectKey: string | undefined;
    for (const item of cardEntries) {
      const currentGroup = cardGroups.at(-1);
      if (currentGroup && currentProjectKey === item.project.key) {
        currentGroup.entries.push(item.cardEntry);
      } else {
        currentProjectKey = item.project.key;
        cardGroups.push({
          title: item.project.title,
          entries: [item.cardEntry],
          actions: item.projectActions,
        });
      }
    }
    const card = this.cardRenderer.renderSessionTaskListCard(
      searchTerm ? `任务列表：${searchTerm}` : "任务列表",
      activeCount > 0 ? `任务（${activeCount} 个活跃）` : "任务",
      cardGroups,
      [
        ...(remoteHint ? [remoteHint] : []),
        `第 ${page + 1} 页 · 每页 ${SESSION_PAGE_SIZE} 个任务${hasNext ? "" : ` · 当前共 ${entries.length} 个任务`}`,
        "",
        "> 项目菜单：**New** 新建任务，**NewGroup** 新建群。",
        "> 任务详情：**Switch** 切换，**Stop** 停止，**Fork** / **ForkGroup** 创建分支，**Status** 查看状态，**Archive** 归档。",
      ],
      [
        ...(hasPrevious ? [bindCardAction({
          text: "Previous",
          value: {
            action: "session_page",
            ...(searchTerm ? { searchTerm } : {}),
            page: String(page - 1),
            contextKey,
          },
        })] : []),
        ...(hasNext ? [bindCardAction({
          text: "Next",
          value: {
            action: "session_page",
            ...(searchTerm ? { searchTerm } : {}),
            page: String(page + 1),
            contextKey,
          },
        })] : []),
      ],
    );
    const bindings = [...cardActionBindings.values()];
    if (options.updateMessageId) {
      this.store.upsertCardActionBindings(options.updateMessageId, bindings);
      await this.outbound.updateInteractiveCard(contextKey, options.updateMessageId, card);
      this.store.retainCardActionBindings(options.updateMessageId, bindings.map((binding) => binding.token));
    } else {
      const messageId = await this.outbound.sendInteractiveCard(contextKey, card);
      if (messageId) {
        this.store.upsertCardActionBindings(messageId, bindings);
        this.store.retainCardActionBindings(messageId, bindings.map((binding) => binding.token));
      }
    }
  }

  private async listRemoteSessionsThroughCursor(
    runtime: AgentRuntime,
    searchTerm: string | undefined,
    limit: number,
  ): Promise<RemoteSessionPage> {
    const sessions: RemoteSessionSummary[] = [];
    const seenSessionIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    while (sessions.length < limit) {
      const page = await runtime.listRemoteSessions!({
        searchTerm,
        ...(cursor ? { cursor } : {}),
        limit: limit - sessions.length,
      });
      for (const session of page.sessions) {
        if (seenSessionIds.has(session.id)) continue;
        seenSessionIds.add(session.id);
        sessions.push(session);
      }

      const nextCursor = page.nextCursor?.trim() || undefined;
      if (!nextCursor) return { sessions };
      if (sessions.length >= limit) return { sessions, nextCursor };
      if (seenCursors.has(nextCursor)) {
        this.logger.warn({ cursor: nextCursor }, "App Server repeated a thread/list cursor; stopping pagination.");
        return { sessions };
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return { sessions };
  }

  private async refreshSessionsCardFromAction(
    action: CardAction,
    options: { forceSwitchTaskId?: string; page?: number } = {},
  ): Promise<void> {
    if (!action.messageId) return;
    const searchTerm = typeof action.value.searchTerm === "string" && action.value.searchTerm.trim()
      ? action.value.searchTerm
      : undefined;
    await this.listSessions(action.contextKey, searchTerm, {
      updateMessageId: action.messageId,
      forceSwitchTaskId: options.forceSwitchTaskId,
      page: options.page ?? parseSessionPage(action.value.page),
    });
  }

  private async refreshStatusCardFromAction(action: CardAction, forceSwitchTaskId?: string): Promise<void> {
    if (!action.messageId) return;
    const sessionId = typeof action.value.sessionId === "string" && action.value.sessionId.trim()
      ? action.value.sessionId
      : undefined;
    await this.status(action.contextKey, sessionId, {
      updateMessageId: action.messageId,
      forceSwitchTaskId,
    });
  }

  private findStoredSessionByReference(reference: string, contextKey?: string): SessionRecord | undefined {
    const scoped = parseRemoteSessionReference(reference);
    return scoped
      ? this.store.findSessionByRemoteSessionId(scoped.remoteSessionId, contextKey, scoped.agentName)
      : this.store.findSessionByRemoteSessionId(reference, contextKey);
  }

  private async resolveRemoteCodexSession(
    reference: string,
    options: { forFork?: boolean } = {},
  ): Promise<AgentRemoteSession> {
    const scoped = parseRemoteSessionReference(reference);
    const candidates = scoped
      ? [[scoped.agentName, this.runtimes.forAgent(scoped.agentName)] as const]
      : this.runtimes.entries("codex");
    if (candidates.length === 0) throw new Error("未配置 App Server Agent。");

    const reads = await Promise.allSettled(candidates.map(async ([agentName, runtime]) => {
      if (runtime.kind !== "codex" || !runtime.readRemoteSession) {
        throw new Error(`Agent ${agentName} 不支持读取远端任务。`);
      }
      const remoteSessionId = scoped?.remoteSessionId ?? reference;
      return {
        agentName,
        runtime,
        remote: options.forFork && runtime.readRemoteForkSource
          ? await runtime.readRemoteForkSource(remoteSessionId)
          : await runtime.readRemoteSession(remoteSessionId),
      } satisfies AgentRemoteSession;
    }));
    const matches = reads
      .filter((result): result is PromiseFulfilledResult<AgentRemoteSession> => result.status === "fulfilled")
      .map((result) => result.value);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(`多个 Agent 中存在相同任务 ID：${reference}。请先使用 /sessions，再通过序号选择任务。`);
    }
    const details = reads
      .map((result, index) => result.status === "rejected"
        ? `${candidates[index]?.[0] ?? "unknown"}: ${runtimeErrorMessage(result.reason)}`
        : undefined)
      .filter((detail): detail is string => Boolean(detail))
      .join("；");
    throw new Error(`找不到 App Server 任务：${scoped?.remoteSessionId ?? reference}${details ? `（${details}）` : ""}`);
  }

  private async switchSession(contextKey: string, reference?: string): Promise<void> {
    this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    const taskId = this.resolveSessionReference(contextKey, reference);
    const direct = this.store.getSession(taskId);
    if (direct?.status === "closed") {
      throw new Error(`找不到任务：${taskId}`);
    }
    const existing = direct ?? this.findStoredSessionByReference(taskId);
    if (existing) {
      const runtime = this.runtimes.forAgent(existing.agentName);
      await this.assertSessionTurnOwnership(existing, runtime);
      this.store.attachSessionToContext(contextKey, existing.localSessionId);
      this.store.setCurrentSession(contextKey, existing.localSessionId);
      this.outbound.registerSession(
        existing.localSessionId,
        contextKey,
        existing.title,
        existing.cwd,
        this.agentLabel(existing.agentName),
      );
      await this.outbound.sendText(contextKey, `已切换到任务：${existing.title ?? existing.remoteSessionId ?? taskId}`);
      return;
    }

    const { agentName, remote } = await this.resolveRemoteCodexSession(taskId);
    if (remote.status === "active" || remote.lastTurnStatus === "inProgress") {
      throw new Error(`这个任务正在外部 Agent 中执行，当前不会切换。可使用 /status ${taskId} 查看进度。`);
    }
    if (!remote.cwd) throw new Error("这个 App Server 任务没有可用的工作目录，暂时无法切换。");
    const localSessionId = createId("sess");
    this.store.createSession({
      localSessionId,
      contextKey,
      agentName,
      cwd: remote.cwd,
      status: "ready",
    });
    this.store.updateRuntimeSession(localSessionId, {
      runtimeKind: "codex",
      remoteSessionId: remote.id,
      title: remote.title ?? remote.preview,
      permissionMode: "auto",
      lastTurnId: remote.lastTurnId,
      lastTurnStatus: mapRemoteTurnStatus(remote.lastTurnStatus),
    });
    this.store.setCurrentSession(contextKey, localSessionId);
    this.outbound.registerSession(
      localSessionId,
      contextKey,
      remote.title ?? remote.preview,
      remote.cwd,
      this.agentLabel(agentName),
    );
    await this.outbound.sendText(
      contextKey,
      `已切换到任务：${remote.title ?? remote.preview ?? remote.id}。历史消息不会重新发送。`,
    );
  }

  private async stopSessionReference(contextKey: string, taskId: string): Promise<void> {
    const direct = this.store.getSession(taskId);
    if (direct) {
      if (direct.status === "closed") throw new Error(`找不到任务：${taskId}`);
      await this.cancelSession({ ...direct, contextKey });
      return;
    }

    const existing = this.findStoredSessionByReference(taskId);
    if (existing) {
      await this.cancelSession({ ...existing, contextKey });
      return;
    }

    const { runtime, remote } = await this.resolveRemoteCodexSession(taskId);
    if (!runtime.readRemoteSession || !runtime.interruptRemoteTurn) {
      throw new Error("当前 App Server Agent 不支持停止外部任务。");
    }
    const turnId = remote.status === "active" || remote.lastTurnStatus === "inProgress"
      ? remote.lastTurnId
      : undefined;
    if (!turnId) {
      await this.outbound.sendText(contextKey, "当前没有正在执行的任务。");
      return;
    }
    await runtime.interruptRemoteTurn(remote.id, turnId);
    this.store.audit(contextKey, "turn_interrupt_sent", {
      remoteSessionId: remote.id,
      turnId,
      source: "sessions_card",
    });
    await this.outbound.sendText(contextKey, TURN_STOP_REQUESTED_MESSAGE);
  }

  private async archiveSessionReference(
    contextKey: string,
    reference: string,
    options: { announce: boolean; source: "cli" | "command" | "dismiss" | "sessions_card" },
  ): Promise<{ localSessionId: string; remoteSessionId: string; title: string }> {
    const taskId = this.resolveSessionReference(contextKey, reference);
    const direct = this.store.getSession(taskId);
    if (direct?.status === "closed") throw new Error(`任务已经归档：${direct.title ?? taskId}`);
    const local = direct ?? this.findStoredSessionByReference(taskId);
    if (local && (!local.remoteSessionId || !this.isCodexSession(local))) {
      throw new Error("当前 Agent 不支持归档任务。");
    }
    if (local && (
      local.status === "running"
      || Boolean(this.runtimes.forAgent(local.agentName).getSession(local.localSessionId)?.activeTurnId)
    )) {
      throw new Error("任务正在执行，无法归档。请先停止任务或等待本轮完成。");
    }
    if (local && this.store.countQueuedPrompts(local.localSessionId) > 0) {
      throw new Error("任务仍有排队消息，无法归档。请先处理或取消排队消息。");
    }

    const remoteReference = local
      ? remoteSessionReference(local.agentName, local.remoteSessionId!)
      : taskId;
    const { agentName, runtime, remote } = await this.resolveRemoteCodexSession(remoteReference);
    if (isRemoteSessionActive(remote)) {
      throw new Error("任务正在执行，无法归档。请先停止任务或等待本轮完成。");
    }
    if (!runtime.archiveRemoteSession) {
      throw new Error(`Agent ${agentName} 不支持归档任务。`);
    }

    const wasCurrent = Boolean(local && this.store.getUserContext(contextKey)?.currentSessionId === local.localSessionId);
    await runtime.archiveRemoteSession(remote.id);
    const title = local?.title ?? remote.title ?? remote.preview ?? remote.id;
    if (local) {
      this.store.archiveSession(local.localSessionId);
      this.outbound.unregisterSession(local.localSessionId);
    }
    this.store.audit(contextKey, "session_archived", {
      ...(local ? { localSessionId: local.localSessionId } : {}),
      remoteSessionId: remote.id,
      agentName,
      source: options.source,
    });
    if (options.announce) {
      await this.outbound.sendText(
        contextKey,
        wasCurrent
          ? `已归档任务：${title}\n当前会话已没有绑定任务，直接发送消息即可创建新任务。`
          : `已归档任务：${title}`,
      );
    }
    return {
      localSessionId: local?.localSessionId ?? "",
      remoteSessionId: remote.id,
      title,
    };
  }

  private async openDismissGroupCard(contextKey: string, userId?: string): Promise<void> {
    const groupContextKey = this.dismissibleGroupContextKey(contextKey);
    if (!userId) throw new Error("无法识别当前用户，不能发起解散群操作。");
    const session = this.requireCurrentSession(groupContextKey);
    await this.outbound.sendInteractiveCard(groupContextKey, this.cardRenderer.renderDismissGroupConfirmation({
      contextKey: groupContextKey,
      sessionId: session.localSessionId,
      taskTitle: session.title ?? session.remoteSessionId ?? session.localSessionId,
      requestedBy: userId,
    }));
  }

  private assertDismissGroupRequester(action: CardAction): void {
    const requestedBy = String(action.value.requestedBy ?? "");
    if (!requestedBy || !action.userId || action.userId !== requestedBy) {
      throw new Error("只有发起解散操作的用户可以点击这张卡片。");
    }
  }

  private async dismissGroupAndArchiveTask(
    contextKey: string,
    localSessionId: string,
    source: "cli" | "command",
  ): Promise<{ localSessionId: string; remoteSessionId: string; title: string; chatId: string }> {
    const groupContextKey = this.dismissibleGroupContextKey(contextKey);
    const session = this.store.getSessionForContext(localSessionId, groupContextKey);
    if (!session) throw new Error("解散群卡片已失效，请重新发送 /dismiss。");

    const currentSessionId = this.store.getUserContext(groupContextKey)?.currentSessionId;
    if (session.status !== "closed" && currentSessionId !== localSessionId) {
      throw new Error("当前任务已经切换，解散群卡片已失效，请重新发送 /dismiss。");
    }
    this.assertNoOtherActiveGroupTasks(groupContextKey, localSessionId);

    const archived = session.status === "closed"
      ? {
          localSessionId: session.localSessionId,
          remoteSessionId: session.remoteSessionId ?? session.acpSessionId ?? "",
          title: session.title ?? session.remoteSessionId ?? session.localSessionId,
        }
      : await this.archiveSessionReference(groupContextKey, localSessionId, {
          announce: false,
          source: "dismiss",
        });
    const chatId = groupContextKey.slice("chat_id:".length);
    try {
      await this.outbound.deleteGroup(groupContextKey, chatId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`当前任务已归档，但解散群失败：${message}`);
    }

    const detachedSessionIds = this.store.removeChatContext(groupContextKey);
    for (const detachedSessionId of detachedSessionIds) {
      const linked = this.store.getSession(detachedSessionId);
      const routedContextKey = this.outbound.getSessionContextKey(detachedSessionId) ?? linked?.contextKey;
      if (routedContextKey && baseChatContextKey(routedContextKey) === groupContextKey) {
        this.outbound.unregisterSession(detachedSessionId);
      }
    }
    this.store.audit(groupContextKey, "group_dismissed", {
      chatId,
      localSessionId,
      remoteSessionId: archived.remoteSessionId,
      source,
    });
    return { ...archived, chatId };
  }

  private assertNoOtherActiveGroupTasks(contextKey: string, dismissedSessionId: string): void {
    const active = this.store.listSessionsForChat(contextKey).find((session) => (
      session.localSessionId !== dismissedSessionId
      && session.status !== "closed"
      && (
        session.status === "running"
        || Boolean(this.runtimes.forAgent(session.agentName).getSession(session.localSessionId)?.activeTurnId)
        || this.store.countQueuedPrompts(session.localSessionId) > 0
      )
    ));
    if (active) {
      throw new Error(`群内任务仍在执行或有排队消息，暂时不能解散：${active.title ?? active.localSessionId}`);
    }
  }

  private dismissibleGroupContextKey(contextKey: string): string {
    if (isThreadContextKey(contextKey)) {
      throw new Error("/dismiss 不能在话题中使用，请回到群聊正文后重试。");
    }
    const groupContextKey = baseChatContextKey(contextKey);
    if (!groupContextKey.startsWith("chat_id:") || this.store.getChatContext(groupContextKey)?.chatType !== "group") {
      throw new Error("/dismiss 仅适用于普通群聊。");
    }
    return groupContextKey;
  }

  private resolveSessionReference(contextKey: string, reference?: string): string {
    if (reference === undefined) {
      const previous = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!).previousSessionId;
      if (!previous) throw new Error("没有可切换的上一个任务。请先使用 /new 创建任务，或使用 /switch <序号或任务 ID> 切换任务。");
      return previous;
    }
    if (!/^\d+$/.test(reference)) return reference;
    const position = Number(reference);
    const listing = this.lastSessionListings.get(contextKey);
    if (!listing) throw new Error("请先发送 /sessions 获取任务列表，再使用任务序号。");
    if (!Number.isSafeInteger(position) || position < 1 || position > listing.length) {
      throw new Error(`任务序号超出范围：${reference}。当前列表共有 ${listing.length} 项，请重新发送 /sessions。`);
    }
    return listing[position - 1]!;
  }

  private async assertSessionTurnOwnership(
    record: SessionRecord,
    runtime: AgentRuntime,
  ): Promise<RemoteSessionActivity | undefined> {
    if (runtime.kind !== "codex" || !record.remoteSessionId || !runtime.readRemoteSession) return;
    if (runtime.inspectRemoteSessionActivity) {
      let activity: RemoteSessionActivity;
      try {
        activity = await runtime.inspectRemoteSessionActivity(record.remoteSessionId);
      } catch (error) {
        if (!record.lastTurnId && isUnmaterializedCodexThreadError(error)) return { active: false };
        throw error;
      }
      const localActiveTurnId = runtime.getSession(record.localSessionId)?.activeTurnId;
      const runtimeOwnsActiveTurn = Boolean(localActiveTurnId)
        && (!activity.activeTurnId || activity.activeTurnId === localActiveTurnId);
      const persistedTurnMatches = record.status === "running"
        && record.lastTurnStatus === "running"
        && Boolean(record.lastTurnId)
        && activity.activeTurnId === record.lastTurnId;
      const botOwnsActiveTurn = runtimeOwnsActiveTurn || persistedTurnMatches;
      if (activity.active && !botOwnsActiveTurn) {
        throw new Error("这个任务正在外部 Agent 中执行。Agent Bot 不会接管或追加消息，请等待外部执行完成。");
      }
      return activity;
    }
    let remote: RemoteSessionSummary;
    try {
      remote = await runtime.readRemoteSession(record.remoteSessionId);
    } catch (error) {
      // App Server does not materialize a new thread until its first user message.
      // Such a thread has no turn to take over, so allow turn/start to create it.
      if (!record.lastTurnId && isUnmaterializedCodexThreadError(error)) return;
      throw error;
    }
    const botOwnsActiveTurn = isBotOwnedActiveTurn(record, remote);
    if ((remote.status === "active" || remote.lastTurnStatus === "inProgress") && !botOwnsActiveTurn) {
      throw new Error("这个任务正在外部 Agent 中执行。Agent Bot 不会接管或追加消息，请等待外部执行完成。");
    }
    return undefined;
  }

  private async setDefaultAgent(
    contextKey: string,
    agentName: string,
    options: ExecutionSettingsCardOptions = {},
  ): Promise<void> {
    this.ensureAgent(agentName);
    this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    this.store.setDefaultAgent(contextKey, agentName);
    if (Object.keys(this.config.agents).length <= 1) {
      await this.outbound.sendText(contextKey, `当前 Agent：${agentName}\n当前没有其他 Agent 可以切换。`);
      return;
    }
    await this.openExecutionSettings(contextKey, "agent", {
      ...options,
      notice: `默认 Agent 已切换为 ${cardCode(agentName)}，从下一次新建任务生效。`,
    });
  }

  private async status(
    contextKey: string,
    sessionId?: string,
    options: StatusCardOptions = {},
  ): Promise<void> {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    const targetSessionId = sessionId === undefined ? undefined : this.resolveSessionReference(contextKey, sessionId);
    let current: SessionRecord | undefined;
    if (targetSessionId) {
      const direct = this.store.getSession(targetSessionId);
      current = direct
        ? { ...direct, contextKey }
        : this.findStoredSessionByReference(targetSessionId, contextKey);
      if (!current) {
        await this.statusForCodexTask(contextKey, targetSessionId, options);
        return;
      }
    } else {
      current = context.currentSessionId ? this.store.getSession(context.currentSessionId) : undefined;
    }

    if (current && current.status === "running") {
      try {
        const runtime = this.runtimes.forAgent(current.agentName);
        if (runtime.getSession(current.localSessionId)) {
          await runtime.synchronizeSession(current.localSessionId);
          current = this.store.getSession(current.localSessionId) ?? current;
        }
      } catch (error) {
        this.logger.warn({ error, sessionId: current.localSessionId }, "Failed to synchronize task status.");
      }
    }

    const localCurrent = current;
    let remote: RemoteSessionSummary | undefined;
    let goal: RuntimeGoal | undefined;
    if (current?.remoteSessionId) {
      const runtime = this.runtimes.forAgent(current.agentName);
      if (runtime.readRemoteSession) {
        try {
          remote = await runtime.readRemoteSession(current.remoteSessionId);
        } catch (error) {
          this.logger.warn({ error, sessionId: current.localSessionId }, "Failed to inspect App Server task status.");
        }
      }
      if (runtime.kind === "codex" && runtime.getGoal) {
        try {
          const loaded = runtime.getSession(current.localSessionId) ?? (await this.loadSession(current)).session;
          goal = await runtime.getGoal(loaded.localSessionId);
        } catch (error) {
          this.logger.warn({ error, sessionId: current.localSessionId }, "Failed to inspect Agent goal status.");
        }
      }
    }

    if (current) current = mergeRemoteTaskStatus(current, remote);

    const taskLines: string[] = [];
    let snapshot: TurnViewState | undefined;
    let activeTurnId: string | undefined;
    let queued = 0;
    if (!current) {
      taskLines.push(isThreadContextKey(contextKey)
        ? unboundThreadTaskMessage()
        : "无。直接发送消息即可创建一个未指定项目的 Agent 任务。");
    } else {
      const agent = this.ensureAgent(current.agentName);
      const runtimeSession = this.runtimes.forAgent(current.agentName).getSession(current.localSessionId);
      activeTurnId = runtimeSession?.activeTurnId;
      const remoteActive = isRemoteSessionActive(remote);
      activeTurnId = remoteActive ? remote?.lastTurnId ?? activeTurnId : activeTurnId;
      queued = this.store.countQueuedPrompts(current.localSessionId);
      snapshot = turnViewSnapshot(current.lastTurnId ? this.store.getTurnSnapshot(current.lastTurnId) : undefined);
      const statusLabel = remoteActive && remote && localCurrent && !isBotOwnedActiveTurn(localCurrent, remote)
        ? "外部执行中"
        : sessionStatusLabel(current.status, activeTurnId);
      const resultLabel = remoteActive
        ? "执行中"
        : remoteTurnStatusLabel(remote?.lastTurnStatus ?? current.lastTurnStatus);
      taskLines.push(
        `**标题**：${cardCode(current.title ?? "未命名任务")}`,
        `**工作目录**：${cardCode(current.cwd)}`,
        `**Provider / 模型 / 思考强度**：${cardCode(current.modelProvider ?? "Agent 默认")} / ${cardCode(current.model ?? "默认")} / ${cardCode(current.reasoningEffort ?? "自动")}`,
        `**状态 / 最近结果**：${statusLabel} / ${resultLabel}`,
        `**Agent**：${cardCode(agent.title)}`,
        `**权限 / 任务范围**：${current.permissionMode === "confirm" ? "执行前确认" : "自动执行"} / ${detectProjectlessWorkspace(current.cwd) ? "未指定项目" : "指定项目"}`,
        `**App Server 任务 ID**：${cardCode(current.remoteSessionId ?? "尚未创建")}`,
        `**当前执行 / 排队消息**：${activeTurnId ? cardCode(activeTurnId) : "无"} / ${queued} 条`,
        `**创建时间 / 最近活动**：${formatStatusTime(current.createdAt)} / ${formatStatusTime(current.updatedAt)}`,
      );
    }

    const sections: CardSection[] = [
      { title: targetSessionId ? "指定任务" : "当前任务", lines: taskLines },
      ...(current ? [{
        title: "Goal",
        lines: goal ? goalDetailLines(goal) : ["未设置。"],
      }] : []),
      ...(current ? [{
        title: "最终结果",
        lines: finalResultLines(snapshot, remote),
      }] : []),
      ...(current ? [{
        title: "执行详情",
        lines: executionDetailLines(localCurrent ?? current, snapshot, remote, activeTurnId, queued),
        collapsible: true,
        elementId: "status_execution_details",
      }] : []),
      {
        title: "Agent Bot",
        lines: [
          `**默认 Agent / 保活**：${cardCode(context.defaultAgent)} / ${this.lifecycle?.supervised ? "已启用" : "未启用"}`,
          "**交互方式**：普通消息继续当前任务；/new 创建新任务；/help 查看命令。",
        ],
      },
    ];
    const title = targetSessionId && current
      ? `Agent 状态：${truncateText((current.title ?? current.remoteSessionId ?? current.localSessionId).replace(/\s+/g, " "), 40)}`
      : "Agent 状态";
    const taskId = current?.remoteSessionId
      ? remoteSessionReference(current.agentName, current.remoteSessionId)
      : current?.localSessionId;
    const isCurrent = Boolean(current && current.localSessionId === context.currentSessionId);
    const remoteActive = isRemoteSessionActive(remote);
    const botOwnsActiveTurn = Boolean(localCurrent && remote && isBotOwnedActiveTurn(localCurrent, remote));
    const active = Boolean(activeTurnId || current?.status === "running" || remoteActive);
    const forceSwitch = Boolean(taskId && (
      options.forceSwitchTaskId === taskId
      || options.forceSwitchTaskId === current?.remoteSessionId
    ));
    const taskActions: TaskListCardAction[] = !taskId ? []
      : remoteActive && !botOwnsActiveTurn && !forceSwitch
        ? [statusCardAction("Stop", "danger", "session_stop", taskId, contextKey)]
        : isCurrent && active && !forceSwitch
          ? [statusCardAction("Stop", "danger", "session_stop", taskId, contextKey)]
          : !isCurrent
            ? [statusCardAction("Switch", "default", "session_switch", taskId, contextKey)]
            : [];
    const actions: TaskListCardAction[] = [
      statusRefreshAction(taskId, contextKey),
      ...taskActions,
    ];
    const card = this.cardRenderer.renderSectionsCard(title, sections, actions);
    if (options.updateMessageId) await this.outbound.updateInteractiveCard(contextKey, options.updateMessageId, card);
    else await this.outbound.sendInteractiveCard(contextKey, card);
  }

  private async statusForCodexTask(
    contextKey: string,
    reference: string,
    options: StatusCardOptions = {},
  ): Promise<void> {
    const { agentName, remote } = await this.resolveRemoteCodexSession(reference);
    const actionReference = remoteSessionReference(agentName, remote.id);
    const sections: CardSection[] = [
      {
        title: "指定任务",
        lines: [
          `**标题**：${cardCode(remote.title ?? remote.preview ?? "未命名任务")}`,
          `**工作目录**：${cardCode(remote.cwd || "目录未知")}`,
          `**状态 / 当前任务**：${remoteSessionDetailStatus(remote)} / 未切换`,
          `**Agent**：${cardCode(agentName)}`,
          `**App Server 任务 ID**：${cardCode(remote.id)}`,
          `**最近回合**：${cardCode(remote.lastTurnId ?? "无")}　${remoteTurnStatusLabel(remote.lastTurnStatus)}`,
          `**创建时间 / 最近活动**：${formatRemoteTime(remote.createdAt)} / ${formatRemoteTime(latestRemoteTimestamp(remote.recencyAt, remote.updatedAt))}`,
        ],
      },
      { title: "最终结果", lines: finalResultLines(undefined, remote) },
      {
        title: "执行详情",
        lines: [
          `**当前 / 最后步骤**：${statusExcerpt(remote.lastActivity ?? remoteStatusStep(remote), 500)}`,
          isRemoteSessionActive(remote)
            ? "外部 Agent 正在执行；Agent Bot 只读取状态，不会接管。"
            : `发送 **/switch ${cardText(remote.id)}** 切换到此任务。`,
        ],
        collapsible: true,
        elementId: "status_execution_details",
      },
    ];
    const title = `Agent 状态：${truncateText((remote.title ?? remote.preview ?? remote.id).replace(/\s+/g, " "), 40)}`;
    const showStop = isRemoteSessionActive(remote)
      && options.forceSwitchTaskId !== actionReference
      && options.forceSwitchTaskId !== remote.id;
    const actions = [
      statusRefreshAction(actionReference, contextKey),
      statusCardAction(
        showStop ? "Stop" : "Switch",
        showStop ? "danger" : "default",
        showStop ? "session_stop" : "session_switch",
        actionReference,
        contextKey,
      ),
    ];
    const card = this.cardRenderer.renderSectionsCard(title, sections, actions);
    if (options.updateMessageId) await this.outbound.updateInteractiveCard(contextKey, options.updateMessageId, card);
    else await this.outbound.sendInteractiveCard(contextKey, card);
  }

  private async executeHelpCommandAction(
    action: CardAction,
    contextKey: string,
    replyTarget?: MessageReplyTarget,
  ): Promise<void> {
    const commandText = typeof action.value.command === "string"
      ? action.value.command.trim()
      : "";
    if (!HELP_DEFAULT_COMMANDS.has(commandText)) {
      throw new Error("帮助卡片中的命令无效，请发送 /help 获取最新卡片。");
    }
    const command = this.router.parse(commandText);
    await this.execute(
      contextKey,
      command,
      undefined,
      replyTarget,
      undefined,
      action.userId,
    );
  }

  private async help(contextKey: string): Promise<void> {
    const sections: HelpCardSection[] = HELP_COMMAND_SECTIONS.map((section) => ({
      title: section.title,
      commands: section.commands.map((command) => ({
        text: command.command,
        ...(command.requiresArgument
          ? {}
          : {
              action: {
                text: command.command,
                value: {
                  action: "help_command",
                  command: command.command,
                  contextKey,
                },
              },
            }),
        ...(command.usage ? { usage: command.usage } : {}),
        description: command.description,
      })),
    }));
    const introLines = [
      "直接发送消息即可继续当前任务；执行中发送的新消息会追加到本次任务。",
      "点击命令按钮可执行默认形式；有必填参数的命令需要手动发送。",
      "> 命令前缀示例：/sess 等同于 /sessions。",
      "> 命令缩写示例：/fg 等同于 /forkgroup。",
      "前缀或缩写匹配多个命令时，需要输入更长的形式。",
      "**[参数]** 可选　**&#60;参数&#62;** 必填",
    ];
    try {
      await this.outbound.sendInteractiveCard(contextKey, this.cardRenderer.renderHelpCard(
        "Agent Bot 使用帮助",
        introLines,
        sections,
      ));
    } catch (cardError) {
      this.logger.warn(
        { error: cardError, contextKey, command: "help", phase: "help_card_send" },
        "Failed to send the help card; falling back to plain text.",
      );
      try {
        await this.outbound.sendText(contextKey, renderPlainHelp(introLines, sections));
      } catch (textError) {
        throw new AggregateError(
          [cardError, textError],
          "帮助卡片和纯文本帮助均发送失败。",
        );
      }
    }
  }

  private async setGroupMute(contextKey: string, enabled: boolean): Promise<void> {
    const chatContextKey = baseChatContextKey(contextKey);
    const chat = this.store.getChatContext(chatContextKey);
    if (chat?.chatType !== "group") {
      throw new Error("/mute 仅适用于群聊。");
    }
    this.store.setChatRequiresMention(chatContextKey, enabled);
    await this.outbound.sendText(
      contextKey,
      enabled
        ? "已开启当前群的静音模式。之后只有 @ 机器人的消息会被处理；发送 @机器人 /mute off 可恢复自动响应。"
        : "已关闭当前群的静音模式。机器人将恢复自动响应群消息。",
    );
  }

  private requireControlSession(localSessionId: string): SessionRecord {
    const record = this.store.getSession(localSessionId);
    if (!record || record.status === "closed") throw new Error(`Task not found: ${localSessionId}`);
    return record;
  }

  private controlSessionContextKey(record: SessionRecord): string {
    return this.outbound.getSessionContextKey(record.localSessionId)
      ?? (record.lastTurnId ? this.store.getTurnContextKey(record.lastTurnId) : undefined)
      ?? record.contextKey;
  }

  private controlSessionReplyTarget(record: SessionRecord): MessageReplyTarget | undefined {
    const routed = this.outbound.getSessionReplyTarget(record.localSessionId);
    if (routed) return routed;
    const snapshot = record.lastTurnId
      ? turnViewSnapshot(this.store.getTurnSnapshot(record.lastTurnId))
      : undefined;
    return snapshot?.replyTarget;
  }

  private ensureAgent(agentName: string) {
    const agent = this.config.agents[agentName];
    if (!agent) throw new Error(`未知 agent：${agentName}`);
    return agent;
  }

  private async persistAgentExecutionDefaults(localSessionId: string): Promise<void> {
    const session = this.store.getSession(localSessionId);
    if (!session) throw new Error(`找不到任务：${localSessionId}`);
    const agent = this.ensureAgent(session.agentName);
    const observed: AgentExecutionDefaults = {
      ...(session.modelProvider?.trim() ? { modelProvider: session.modelProvider } : {}),
      ...(session.model?.trim() ? { model: session.model } : {}),
      ...(session.reasoningEffort?.trim() ? { reasoningEffort: session.reasoningEffort } : {}),
      ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
    };
    const defaults = { ...(agent.defaults ?? {}), ...observed };
    await this.lifecycle?.persistAgentExecutionDefaults?.(session.agentName, defaults);
    agent.defaults = defaults;
  }

  private agentLabel(agentName: string): string {
    return this.ensureAgent(agentName).title;
  }

  private isCodexSession(session: SessionRecord): boolean {
    if (session.runtimeKind) return session.runtimeKind === "codex";
    return this.config.agents[session.agentName]?.kind === "app-server";
  }

  private currentSession(contextKey: string): SessionRecord | undefined {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    return context.currentSessionId
      ? this.store.getSessionForContext(context.currentSessionId, contextKey)
      : undefined;
  }

  private inheritedNewTaskCwd(contextKey: string): string | undefined {
    const current = this.currentSession(contextKey);
    if (!current) return this.store.getUserContext(contextKey)?.boundProjectCwd;
    return detectProjectlessWorkspace(current.cwd)
      ? createProjectlessWorkspace().cwd
      : current.cwd;
  }

  private inheritedExecutionSettings(contextKey: string, agentName: string): SessionExecutionSettings {
    const current = this.currentSession(contextKey);
    if (!current || current.agentName !== agentName) return {};
    return {
      modelProvider: current.modelProvider,
      model: current.model,
      reasoningEffort: current.reasoningEffort,
      permissionMode: current.permissionMode,
    };
  }

  private currentProjectCwd(contextKey: string): string | undefined {
    const current = this.currentSession(contextKey);
    return current && !detectProjectlessWorkspace(current.cwd) ? current.cwd : undefined;
  }

  private requireCurrentSession(contextKey: string): SessionRecord {
    const record = this.currentSession(contextKey);
    if (!record) {
      throw new Error(isThreadContextKey(contextKey)
        ? unboundThreadTaskMessage()
        : "当前没有任务，直接发送一条消息即可自动创建。");
    }
    return record;
  }

  private requireSession(contextKey: string, sessionId: string): SessionRecord {
    const record = this.store.getSessionForContext(sessionId, contextKey);
    if (!record) throw new Error(`找不到任务：${sessionId}`);
    return record;
  }

  private async requestAppServerRelease(
    contextKey: string,
    requestedRecord?: SessionRecord,
  ): Promise<{
    agentName: string;
    status: "waiting" | "released" | "failed";
    blockingTaskCount: number;
    error?: string;
  }> {
    const record = requestedRecord ?? this.requireCurrentSession(contextKey);
    const runtime = this.runtimes.forAgent(record.agentName);
    if (!this.isCodexSession(record) || runtime.kind !== "codex" || !runtime.release) {
      throw new Error("当前 Agent 不使用可释放的 App Server。");
    }

    let schedule = this.appServerReleaseSchedules.get(record.agentName);
    const created = !schedule;
    if (!schedule) {
      const blockers = this.appServerReleaseBlockers(record.agentName, runtime);
      const blockingTaskCount = blockers.length;
      schedule = {
        id: this.nextAppServerReleaseScheduleId++,
        agentName: record.agentName,
        runtime,
        status: "waiting",
        blockingTaskCount,
        blockingTaskTitles: this.appServerReleaseTaskTitles(blockers),
        targets: new Map(),
        forced: false,
      };
      this.appServerReleaseSchedules.set(record.agentName, schedule);
    }

    try {
      const messageId = await this.outbound.sendInteractiveCard(
        contextKey,
        this.cardRenderer.renderAppServerRelease(this.appServerReleaseCardView(schedule, contextKey)),
      );
      if (messageId) {
        schedule.targets.set(`${contextKey}\u0000${messageId}`, { contextKey, messageId });
      }
    } catch (error) {
      if (created && schedule.targets.size === 0) {
        this.clearAppServerReleaseSchedule(schedule);
      }
      throw error;
    }

    this.armAppServerReleaseCheck(schedule);
    return {
      agentName: schedule.agentName,
      status: schedule.status === "failed" ? "failed" : schedule.status === "released" ? "released" : "waiting",
      blockingTaskCount: schedule.blockingTaskCount,
      ...(schedule.error ? { error: schedule.error } : {}),
    };
  }

  private async releaseAppServerNow(action: CardAction): Promise<void> {
    const scheduleId = Number(action.value.scheduleId);
    const agentName = typeof action.value.agentName === "string" ? action.value.agentName : "";
    const schedule = this.appServerReleaseSchedules.get(agentName);
    if (!Number.isSafeInteger(scheduleId) || !schedule || schedule.id !== scheduleId || schedule.status !== "waiting") {
      throw new Error("释放卡片已失效，请重新发送 /release。");
    }
    await this.performAppServerRelease(schedule);
  }

  private async cancelAppServerRelease(action: CardAction): Promise<void> {
    const scheduleId = Number(action.value.scheduleId);
    const agentName = typeof action.value.agentName === "string" ? action.value.agentName : "";
    const schedule = this.appServerReleaseSchedules.get(agentName);
    const cancellable = schedule?.status === "waiting"
      || (schedule?.status === "releasing" && schedule.releaseStarted !== true);
    if (!Number.isSafeInteger(scheduleId) || !schedule || schedule.id !== scheduleId || !cancellable) {
      throw new Error("释放卡片已失效，请重新发送 /release。");
    }
    const pendingRelease = schedule.inFlight;
    schedule.status = "cancelled";
    if (schedule.timer) {
      clearTimeout(schedule.timer);
      schedule.timer = undefined;
    }
    if (pendingRelease) await pendingRelease;
    await this.publishAppServerReleaseSchedule(schedule);
    this.clearAppServerReleaseSchedule(schedule);
  }

  private appServerReleaseBlockers(agentName: string, runtime: AgentRuntime): SessionRecord[] {
    return this.store.listAllSessions().filter((session) => {
      if (session.agentName !== agentName || session.status === "closed") return false;
      return session.status === "starting"
        || session.status === "running"
        || this.store.countQueuedPrompts(session.localSessionId) > 0
        || this.queuedPromptStarts.has(session.localSessionId)
        || this.sessionLoads.has(session.localSessionId)
        || Boolean(runtime.getSession(session.localSessionId)?.activeTurnId);
    });
  }

  private appServerReleaseTaskTitles(blockers: SessionRecord[]): string[] {
    return blockers.map((session) => session.title?.trim() || "未命名任务");
  }

  private armAppServerReleaseCheck(schedule: AppServerReleaseSchedule): void {
    if (schedule.status !== "waiting" || schedule.timer || schedule.inFlight) return;
    schedule.timer = setTimeout(() => {
      schedule.timer = undefined;
      void this.refreshAppServerReleaseSchedule(schedule).catch((error: unknown) => {
        this.logger.warn({ error, agentName: schedule.agentName }, "Failed to refresh App Server release status.");
        this.armAppServerReleaseCheck(schedule);
      });
    }, APP_SERVER_RELEASE_POLL_INTERVAL_MS);
    schedule.timer.unref?.();
  }

  private async refreshAppServerReleaseSchedule(schedule: AppServerReleaseSchedule): Promise<void> {
    if (this.appServerReleaseSchedules.get(schedule.agentName) !== schedule || schedule.status !== "waiting") return;
    const blockers = this.appServerReleaseBlockers(schedule.agentName, schedule.runtime);
    const blockingTaskCount = blockers.length;
    const blockingTaskTitles = this.appServerReleaseTaskTitles(blockers);
    const titlesChanged = schedule.blockingTaskTitles.length !== blockingTaskTitles.length
      || schedule.blockingTaskTitles.some((title, index) => title !== blockingTaskTitles[index]);
    if (schedule.blockingTaskCount !== blockingTaskCount || titlesChanged) {
      schedule.blockingTaskCount = blockingTaskCount;
      schedule.blockingTaskTitles = blockingTaskTitles;
      await this.publishAppServerReleaseSchedule(schedule);
    }
    this.armAppServerReleaseCheck(schedule);
  }

  private async performAppServerRelease(schedule: AppServerReleaseSchedule): Promise<void> {
    if (schedule.inFlight) return schedule.inFlight;
    const operation = this.performAppServerReleaseNow(schedule);
    schedule.inFlight = operation;
    try {
      await operation;
    } finally {
      if (schedule.inFlight === operation) schedule.inFlight = undefined;
      if (schedule.status === "waiting") this.armAppServerReleaseCheck(schedule);
    }
  }

  private async performAppServerReleaseNow(schedule: AppServerReleaseSchedule): Promise<void> {
    if (schedule.timer) {
      clearTimeout(schedule.timer);
      schedule.timer = undefined;
    }
    const interruptedWork = this.appServerReleaseBlockers(schedule.agentName, schedule.runtime).length > 0;
    await this.cancelQueuedPromptsForAppServerRelease(schedule.agentName);

    schedule.status = "releasing";
    schedule.blockingTaskCount = 0;
    schedule.blockingTaskTitles = [];
    schedule.releaseStarted = false;
    schedule.forced = interruptedWork;
    await this.publishAppServerReleaseSchedule(schedule);
    if (
      this.appServerReleaseWasCancelled(schedule)
      || this.appServerReleaseSchedules.get(schedule.agentName) !== schedule
    ) return;
    schedule.releaseStarted = true;
    try {
      const result = await schedule.runtime.release?.({ force: true });
      if (!result) throw new Error("当前 Agent 不支持释放 App Server。");
      if (result.status === "busy") {
        const blockers = this.appServerReleaseBlockers(schedule.agentName, schedule.runtime);
        schedule.status = "waiting";
        schedule.blockingTaskCount = Math.max(
          result.activeSessionIds?.length ?? 0,
          blockers.length,
          1,
        );
        schedule.blockingTaskTitles = this.appServerReleaseTaskTitles(blockers);
        schedule.forced = false;
        schedule.releaseStarted = false;
        await this.publishAppServerReleaseSchedule(schedule);
        this.armAppServerReleaseCheck(schedule);
        return;
      }
      schedule.status = "released";
    } catch (error) {
      schedule.status = "failed";
      schedule.error = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error, agentName: schedule.agentName }, "Failed to release App Server tasks.");
    }
    await this.publishAppServerReleaseSchedule(schedule);
    this.clearAppServerReleaseSchedule(schedule);
  }

  private appServerReleaseWasCancelled(schedule: AppServerReleaseSchedule): boolean {
    return schedule.status === "cancelled";
  }

  private async cancelQueuedPromptsForAppServerRelease(agentName: string): Promise<void> {
    for (const session of this.store.listAllSessions()) {
      if (session.agentName !== agentName) continue;
      const retryTimer = this.queuedPromptRetryTimers.get(session.localSessionId);
      if (retryTimer) {
        clearTimeout(retryTimer);
        this.queuedPromptRetryTimers.delete(session.localSessionId);
      }
      const queued = this.store.listQueuedPrompts(session.localSessionId);
      for (const prompt of queued) {
        const cancelled = this.store.cancelQueuedPrompt(prompt.promptId, session.localSessionId);
        if (!cancelled?.messageId) continue;
        await this.finalizeStandaloneMessageReaction(cancelled.messageId, "cancelled").catch((error: unknown) => {
          this.logger.warn(
            { error, agentName, sessionId: session.localSessionId, promptId: cancelled.promptId },
            "Failed to finalize a queued Prompt reaction during App Server release.",
          );
        });
      }
      if (queued.length > 0) {
        await this.refreshPromptQueueCards(session.localSessionId).catch((error: unknown) => {
          this.logger.warn(
            { error, agentName, sessionId: session.localSessionId },
            "Failed to refresh queued Prompt cards during App Server release.",
          );
        });
      }
    }
  }

  private appServerReleaseCardView(
    schedule: AppServerReleaseSchedule,
    contextKey: string,
  ): AppServerReleaseCardView {
    return {
      status: schedule.status,
      contextKey,
      scheduleId: schedule.id,
      agentName: schedule.agentName,
      ...(schedule.blockingTaskCount > 0 ? { blockingTaskCount: schedule.blockingTaskCount } : {}),
      ...(schedule.blockingTaskTitles.length > 0 ? { blockingTaskTitles: schedule.blockingTaskTitles } : {}),
      ...(schedule.forced ? { forced: true } : {}),
      ...(schedule.error ? { error: schedule.error } : {}),
    };
  }

  private async publishAppServerReleaseSchedule(schedule: AppServerReleaseSchedule): Promise<void> {
    await Promise.all([...schedule.targets.values()].map(async (target) => {
      try {
        await this.outbound.updateInteractiveCard(
          target.contextKey,
          target.messageId,
          this.cardRenderer.renderAppServerRelease(this.appServerReleaseCardView(schedule, target.contextKey)),
        );
      } catch (error) {
        this.logger.warn(
          { error, agentName: schedule.agentName, messageId: target.messageId },
          "Failed to update App Server release card.",
        );
      }
    }));
  }

  private clearAppServerReleaseSchedule(schedule: AppServerReleaseSchedule): void {
    if (schedule.timer) clearTimeout(schedule.timer);
    schedule.timer = undefined;
    if (this.appServerReleaseSchedules.get(schedule.agentName) === schedule) {
      this.appServerReleaseSchedules.delete(schedule.agentName);
    }
  }

  private async presentThreadWriterConflict(
    record: SessionRecord,
    contextKey: string,
    error: unknown,
    replacePendingTurn: boolean,
  ): Promise<boolean> {
    if (contextKey.startsWith("console:")) return false;
    const threadId = activeWriterThreadId(error);
    if (!threadId || record.remoteSessionId !== threadId) return false;
    const runtime = this.runtimes.forAgent(record.agentName);
    const lockPath = runtime.getThreadWriterLockPath?.(threadId);
    let owners: ThreadWriterProcess[] = [];
    if (lockPath) {
      try {
        owners = await this.threadWriterProcesses.inspect(lockPath);
      } catch (inspectionError) {
        this.logger.warn(
          { error: inspectionError, threadId, lockPath },
          "Failed to inspect the process holding a thread writer lock.",
        );
      }
    }
    const owner = owners.length === 1 ? owners[0] : undefined;
    const applicationIdle = owner && lockPath
      ? await this.inspectThreadWriterApplicationIdle(runtime, lockPath, threadId, owner)
      : undefined;
    const card = this.cardRenderer.renderThreadWriterConflict(this.threadWriterConflictView(
      record,
      contextKey,
      threadId,
      owners,
      "occupied",
      lockPath
        ? undefined
        : "无法识别占用进程。",
      applicationIdle,
    ));
    if (replacePendingTurn) {
      const replaced = await this.outbound.failPendingTurn(
        record.localSessionId,
        "任务被占用。",
        card,
      );
      if (!replaced) await this.outbound.sendInteractiveCard(contextKey, card);
    } else {
      await this.outbound.sendInteractiveCard(contextKey, card);
    }
    return true;
  }

  private threadWriterConflictView(
    record: SessionRecord,
    contextKey: string,
    threadId: string,
    owners: ThreadWriterProcess[],
    status: ThreadWriterConflictCardView["status"],
    notice?: string,
    applicationIdle?: boolean,
  ): ThreadWriterConflictCardView {
    const owner = owners.length === 1 ? owners[0] : undefined;
    return {
      status,
      contextKey,
      sessionId: record.localSessionId,
      threadId,
      taskTitle: record.title,
      notice: notice ?? (owners.length > 1
        ? `检测到 ${owners.length} 个相关进程，无法安全地自动关闭。`
        : undefined),
      applicationIdle,
      ...(owner ? {
        owner: {
          displayName: owner.displayName,
          writerPid: owner.writerPid,
          writerProcessName: owner.writerProcessName,
          writerStartedAt: owner.writerStartedAt,
          applicationPid: owner.applicationPid,
          applicationProcessName: owner.applicationProcessName,
          applicationStartedAt: owner.applicationStartedAt,
          canClose: owner.canClose,
        },
      } : {}),
    };
  }

  private async closeThreadWriter(action: CardAction, contextKey: string): Promise<void> {
    const messageId = requiredCardMessageId(action.messageId);
    const sessionId = String(action.value.sessionId ?? "");
    const threadId = String(action.value.threadId ?? "");
    const expectedWriterPid = positiveActionPid(action.value.writerPid);
    const expectedApplicationPid = positiveActionPid(action.value.applicationPid);
    const expectedWriterStartedAt = String(action.value.writerStartedAt ?? "");
    const expectedApplicationStartedAt = String(action.value.applicationStartedAt ?? "");
    const force = action.value.force === true || action.value.force === "true";
    const record = this.requireSession(contextKey, sessionId);
    if (!threadId || record.remoteSessionId !== threadId) {
      throw new Error("任务占用卡片已经失效，请重新发送消息获取最新状态。");
    }
    const runtime = this.runtimes.forAgent(record.agentName);
    const lockPath = runtime.getThreadWriterLockPath?.(threadId);
    if (!lockPath) throw new Error("当前 Agent 不支持自动关闭占用程序。");

    let owners = await this.threadWriterProcesses.inspect(lockPath);
    const expectedOwner = owners.length === 1 && threadWriterMatches(
      owners[0],
      expectedWriterPid,
      expectedWriterStartedAt,
      expectedApplicationPid,
      expectedApplicationStartedAt,
    ) ? owners[0] : undefined;
    if (!expectedOwner) {
      const currentOwner = owners.length === 1 ? owners[0] : undefined;
      const applicationIdle = currentOwner
        ? await this.inspectThreadWriterApplicationIdle(runtime, lockPath, threadId, currentOwner)
        : undefined;
      await this.outbound.updateInteractiveCard(
        contextKey,
        messageId,
        this.cardRenderer.renderThreadWriterConflict(this.threadWriterConflictView(
          record,
          contextKey,
          threadId,
          owners,
          owners.length === 0 ? "released" : "occupied",
          owners.length === 0
            ? "请重新发送消息。"
            : "占用进程已变化，请重试。",
          applicationIdle,
        )),
      );
      return;
    }
    if (!expectedOwner.canClose) throw new Error("无法确认占用者是 Agent 程序，已拒绝关闭。");

    try {
      await this.threadWriterProcesses.close(expectedOwner, force);
    } catch (error) {
      owners = await this.threadWriterProcesses.inspect(lockPath);
      if (owners.some((owner) => threadWriterMatches(
        owner,
        expectedWriterPid,
        expectedWriterStartedAt,
        expectedApplicationPid,
        expectedApplicationStartedAt,
      ))) throw error;
    }
    owners = await this.waitForThreadWriterChange(lockPath, expectedOwner);
    const sameOwnerRemains = owners.some((owner) => threadWriterMatches(
      owner,
      expectedOwner.writerPid,
      expectedOwner.writerStartedAt ?? "",
      expectedOwner.applicationPid,
      expectedOwner.applicationStartedAt ?? "",
    ));
    if (sameOwnerRemains && force) {
      throw new Error(`无法关闭 ${expectedOwner.displayName}（PID ${expectedOwner.applicationPid}）。`);
    }
    const status: ThreadWriterConflictCardView["status"] = owners.length === 0
      ? "released"
      : sameOwnerRemains ? "force_required" : "occupied";
    const notice = owners.length === 0
      ? "请重新发送消息。"
      : sameOwnerRemains
        ? "普通关闭失败，可强制关闭。"
        : "占用进程已变化，请重试。";
    const currentOwner = owners.length === 1 ? owners[0] : undefined;
    const applicationIdle = currentOwner
      ? await this.inspectThreadWriterApplicationIdle(runtime, lockPath, threadId, currentOwner)
      : undefined;
    await this.outbound.updateInteractiveCard(
      contextKey,
      messageId,
      this.cardRenderer.renderThreadWriterConflict(this.threadWriterConflictView(
        record,
        contextKey,
        threadId,
        owners,
        status,
        notice,
        applicationIdle,
      )),
    );
  }

  private async inspectThreadWriterApplicationIdle(
    runtime: AgentRuntime,
    lockPath: string,
    threadId: string,
    owner: ThreadWriterProcess,
  ): Promise<boolean | undefined> {
    if (!owner.applicationStartedAt
      || !this.threadWriterProcesses.inspectApplicationThreadIds
      || !runtime.inspectRemoteSessionActivity) return undefined;
    try {
      const ownedThreadIds = await this.threadWriterProcesses.inspectApplicationThreadIds(lockPath, owner);
      if (!ownedThreadIds.includes(threadId)) return undefined;
      const activities = await Promise.all(
        ownedThreadIds.map((ownedThreadId) => runtime.inspectRemoteSessionActivity!(ownedThreadId)),
      );
      return activities.every((activity) => !activity.active);
    } catch (error) {
      this.logger.warn(
        { error, threadId, applicationPid: owner.applicationPid },
        "Failed to inspect thread-writer application activity.",
      );
      return undefined;
    }
  }

  private async waitForThreadWriterChange(
    lockPath: string,
    expectedOwner: ThreadWriterProcess,
  ): Promise<ThreadWriterProcess[]> {
    const deadline = Date.now() + 5_000;
    let owners: ThreadWriterProcess[] = [];
    do {
      owners = await this.threadWriterProcesses.inspect(lockPath);
      if (!owners.some((owner) => threadWriterMatches(
        owner,
        expectedOwner.writerPid,
        expectedOwner.writerStartedAt ?? "",
        expectedOwner.applicationPid,
        expectedOwner.applicationStartedAt ?? "",
      ))) return owners;
      await delay(250);
    } while (Date.now() < deadline);
    return owners;
  }

  private async sendError(
    contextKey: string,
    error: unknown,
    details: RequestFailureDetails = {},
  ): Promise<void> {
    if (error instanceof PresentedRequestError) {
      this.logger.warn(
        { error: errorLogValue(error.originalError), contextKey, ...details },
        "Request failed after a dedicated error card was presented.",
      );
      return;
    }
    const record = this.currentSession(contextKey);
    if (record) {
      try {
        if (await this.presentThreadWriterConflict(record, contextKey, error, false)) return;
      } catch (presentationError) {
        this.logger.warn(
          { error: presentationError, originalError: errorLogValue(error), contextKey, ...details },
          "Failed to present the thread writer conflict card.",
        );
      }
    }
    this.logger.warn({ error, contextKey, ...details }, "Request failed.");
    try {
      await this.outbound.sendText(contextKey, error instanceof Error ? error.message : String(error));
    } catch (deliveryError) {
      this.logger.error(
        {
          error: deliveryError,
          originalError: errorLogValue(error),
          contextKey,
          ...details,
          phase: "error_response_send",
        },
        "Failed to deliver the request failure to the user.",
      );
    }
  }
}

function activeWriterThreadId(error: unknown): string | undefined {
  const visited = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !visited.has(current)) {
    visited.add(current);
    const message = current instanceof Error
      ? current.message
      : typeof current === "string" ? current : undefined;
    const match = message?.match(
      /thread(?:\/resume failed:\s*thread)?\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+already has an active writer/iu,
    );
    if (match?.[1]) return match[1];
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

function positiveActionPid(value: unknown): number {
  const pid = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 4) {
    throw new Error("任务占用卡片中的进程信息无效，请重新发送消息获取最新状态。");
  }
  return pid;
}

function threadWriterMatches(
  owner: ThreadWriterProcess,
  writerPid: number,
  writerStartedAt: string,
  applicationPid: number,
  applicationStartedAt: string,
): boolean {
  return Boolean(writerStartedAt)
    && Boolean(applicationStartedAt)
    && owner.writerPid === writerPid
    && owner.writerStartedAt === writerStartedAt
    && owner.applicationPid === applicationPid
    && owner.applicationStartedAt === applicationStartedAt;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function renderPlainHelp(introLines: string[], sections: HelpCardSection[]): string {
  return [
    "Agent Bot 使用帮助",
    "",
    ...introLines.map((line) => decodeHelpEntities(line.replace(/^>\s*/u, "").replaceAll("**", ""))),
    ...sections.flatMap((section) => [
      "",
      section.title,
      ...section.commands.map((command) => [
        command.text,
        command.usage ? decodeHelpEntities(command.usage) : "",
        `- ${command.description}`,
      ].filter(Boolean).join(" ")),
    ]),
  ].join("\n");
}

function decodeHelpEntities(value: string): string {
  return value
    .replaceAll("&#60;", "<")
    .replaceAll("&#62;", ">")
    .replaceAll("&amp;", "&");
}

function threadForkAnchorMessageIds(message: IncomingMessage): string[] {
  return [...new Set([message.rootMessageId, message.parentMessageId]
    .filter((messageId): messageId is string => Boolean(messageId && messageId !== message.messageId)))];
}

function mergeExecutionSettings(
  defaults: AgentExecutionDefaults,
  overrides: SessionExecutionSettings,
): SessionExecutionSettings {
  return {
    modelProvider: overrides.modelProvider ?? defaults.modelProvider,
    model: overrides.model ?? defaults.model,
    reasoningEffort: overrides.reasoningEffort ?? defaults.reasoningEffort,
    permissionMode: overrides.permissionMode ?? defaults.permissionMode,
  };
}

function sessionStatusLabel(status: SessionRecord["status"], activeTurnId?: string): string {
  if (activeTurnId || status === "running") return "执行中";
  const labels: Record<SessionRecord["status"], string> = {
    starting: "正在启动",
    ready: "就绪",
    running: "执行中",
    closed: "已关闭",
    failed: "异常",
  };
  return labels[status];
}

function statusCardAction(
  text: "Stop" | "Switch",
  type: "danger" | "default",
  action: "session_stop" | "session_switch",
  sessionId: string,
  contextKey: string,
): TaskListCardAction {
  return {
    text,
    type,
    value: { action, sessionId, cardView: "status", contextKey },
  };
}

function statusRefreshAction(
  sessionId: string | undefined,
  contextKey: string,
): TaskListCardAction {
  return {
    text: "Refresh",
    value: {
      action: "session_status_refresh",
      ...(sessionId ? { sessionId } : {}),
      cardView: "status",
      contextKey,
    },
  };
}

interface UnifiedTaskListEntry {
  reference: string;
  id: string;
  agentName: string;
  title: string;
  cwd: string;
  status: string;
  active: boolean;
  current: boolean;
  lastUserPrompt?: string;
  updatedAt: number;
  updatedLabel: string;
}

interface TaskProjectInfo {
  key: string;
  title: string;
}

function orderTaskListByRecency(entries: UnifiedTaskListEntry[]): UnifiedTaskListEntry[] {
  return [...entries].sort(compareTaskListEntries);
}

function groupTaskListPagesByProject(
  entries: UnifiedTaskListEntry[],
  pageSize: number,
): UnifiedTaskListEntry[] {
  const result: UnifiedTaskListEntry[] = [];
  for (let offset = 0; offset < entries.length; offset += pageSize) {
    const groups = new Map<string, UnifiedTaskListEntry[]>();
    for (const entry of entries.slice(offset, offset + pageSize)) {
      const key = taskProjectInfo(entry).key;
      const group = groups.get(key);
      if (group) group.push(entry);
      else groups.set(key, [entry]);
    }
    for (const group of groups.values()) {
      result.push(...group.sort(compareTaskListEntries));
    }
  }
  return result;
}

function compareTaskListEntries(left: UnifiedTaskListEntry, right: UnifiedTaskListEntry): number {
  return Number(right.current) - Number(left.current)
    || Number(right.active) - Number(left.active)
    || right.updatedAt - left.updatedAt
    || left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
}

function taskProjectInfo(entry: UnifiedTaskListEntry): TaskProjectInfo {
  if (!entry.cwd) return { key: "unknown", title: "📁 目录未知" };
  if (detectProjectlessWorkspace(entry.cwd)) {
    return { key: "projectless", title: "🗒️ 未指定项目" };
  }
  const windowsPath = isWindowsAbsolutePath(entry.cwd);
  const normalized = windowsPath
    ? path.win32.normalize(entry.cwd).toLowerCase()
    : path.resolve(entry.cwd);
  return {
    key: `cwd:${normalized}`,
    title: `📁 ${abbreviateHomeDirectory(entry.cwd)}`,
  };
}

function mergeTaskList(
  localSessions: SessionRecord[],
  remoteSessions: AgentRemoteSessionSummary[],
  currentLocalSessionId?: string,
  latestLocalUserPrompts: ReadonlyMap<string, string> = new Map(),
  latestRemoteUserPrompts: ReadonlyMap<string, string> = new Map(),
): UnifiedTaskListEntry[] {
  const localByRemoteId = new Map(
    localSessions
      .filter((session) => session.runtimeKind === "codex" && session.remoteSessionId)
      .map((session) => [agentRemoteKey(session.agentName, session.remoteSessionId!), session]),
  );
  const representedLocalIds = new Set<string>();
  const entries = remoteSessions.map(({ agentName, session: remote }): UnifiedTaskListEntry => {
    const local = localByRemoteId.get(agentRemoteKey(agentName, remote.id));
    if (local) representedLocalIds.add(local.localSessionId);
    const active = remote.status === "active" || remote.lastTurnStatus === "inProgress";
    const status = remote.status === "active" || remote.lastTurnStatus === "inProgress"
      ? local && isBotOwnedActiveTurn(local, remote) ? "执行中" : "外部执行中"
      : remoteSessionStatusLabel(remote.status);
    const recencyAt = remote.recencyAt ?? remote.updatedAt;
    return {
      reference: remoteSessionReference(agentName, remote.id),
      id: remote.id,
      agentName,
      title: remote.title ?? remote.preview ?? local?.title ?? "未命名任务",
      cwd: remote.cwd || local?.cwd || "",
      status,
      active,
      current: Boolean(local && local.localSessionId === currentLocalSessionId),
      lastUserPrompt: remote.lastUserPrompt
        ?? (local ? latestLocalUserPrompts.get(local.localSessionId) : undefined)
        ?? latestRemoteUserPrompts.get(agentRemoteKey(agentName, remote.id)),
      updatedAt: (recencyAt ?? 0) * 1_000,
      updatedLabel: formatRemoteTime(recencyAt),
    };
  });

  for (const local of localSessions) {
    if (representedLocalIds.has(local.localSessionId)) continue;
    const updatedAt = Date.parse(local.updatedAt);
    entries.push({
      reference: local.remoteSessionId
        ? remoteSessionReference(local.agentName, local.remoteSessionId)
        : local.localSessionId,
      id: local.remoteSessionId ?? local.localSessionId,
      agentName: local.agentName,
      title: local.title ?? "未命名任务",
      cwd: local.cwd,
      status: sessionStatusLabel(local.status),
      active: local.status === "running",
      current: local.localSessionId === currentLocalSessionId,
      lastUserPrompt: latestLocalUserPrompts.get(local.localSessionId),
      updatedAt: Number.isNaN(updatedAt) ? 0 : updatedAt,
      updatedLabel: formatStatusTime(local.updatedAt),
    });
  }
  return entries;
}

function agentRemoteKey(agentName: string, remoteSessionId: string): string {
  return `${agentName}\u0000${remoteSessionId}`;
}

function remoteSessionReference(agentName: string, remoteSessionId: string): string {
  return `${REMOTE_SESSION_REFERENCE_PREFIX}${encodeURIComponent(agentName)}:${encodeURIComponent(remoteSessionId)}`;
}

function parseRemoteSessionReference(reference: string): { agentName: string; remoteSessionId: string } | undefined {
  if (!reference.startsWith(REMOTE_SESSION_REFERENCE_PREFIX)) return undefined;
  const value = reference.slice(REMOTE_SESSION_REFERENCE_PREFIX.length);
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  try {
    const agentName = decodeURIComponent(value.slice(0, separator));
    const remoteSessionId = decodeURIComponent(value.slice(separator + 1));
    return agentName && remoteSessionId ? { agentName, remoteSessionId } : undefined;
  } catch {
    return undefined;
  }
}

function bindSessionCardAction(
  action: TaskListCardAction,
  bindings: Map<string, CardActionBinding>,
): TaskListCardAction {
  const serialized = JSON.stringify(action.value);
  const token = createHash("sha256").update(serialized).digest("hex").slice(0, 16);
  const existing = bindings.get(token);
  if (existing && JSON.stringify(existing.value) !== serialized) {
    throw new Error("任务列表卡片操作令牌发生冲突，请重试。");
  }
  bindings.set(token, { token, value: action.value });
  return { ...action, value: { t: token } };
}

function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingRolloutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no rollout found|rollout[^\n]*(?:not found|missing)|thread\/resume failed/i.test(message);
}

function isUnmaterializedCodexThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /thread\/read failed:[^\n]*(?:not materialized|not loaded|includeTurns is unavailable before first user message)/i.test(message);
}

function turnViewSnapshot(value: unknown): TurnViewState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<TurnViewState>;
  return typeof candidate.turnId === "string" && typeof candidate.status === "string"
    ? candidate as TurnViewState
    : undefined;
}

function latestUserPromptFromTurnView(snapshot: TurnViewState | undefined): string | undefined {
  const latestUserActivity = [...(snapshot?.activities ?? [])]
    .reverse()
    .find((activity): activity is Extract<TurnActivity, { kind: "user" }> =>
      activity.kind === "user" && Boolean(activity.text.trim()));
  return latestUserActivity?.text.trim() || snapshot?.prompt?.trim() || undefined;
}

function sessionPromptPreview(prompt: string | undefined): string {
  const normalized = prompt?.replace(/\s+/gu, " ").trim() || "暂无用户 Prompt";
  const characters = Array.from(normalized);
  return characters.length > SESSION_PROMPT_PREVIEW_LENGTH
    ? `${characters.slice(0, SESSION_PROMPT_PREVIEW_LENGTH).join("")}...`
    : normalized;
}

function isTerminalTurnViewStatus(status: TurnViewState["status"]): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

function isIncompleteTurnAttemptStatus(status: TurnAttemptRecord["status"]): boolean {
  return status === "accepted" || status === "running" || status === "recovering";
}

function executionDetailLines(
  record: SessionRecord,
  snapshot: TurnViewState | undefined,
  remote: RemoteSessionSummary | undefined,
  activeTurnId: string | undefined,
  queued: number,
): string[] {
  const remoteActive = isRemoteSessionActive(remote);
  const turnId = remoteActive
    ? remote?.lastTurnId ?? activeTurnId
    : activeTurnId ?? remote?.lastTurnId ?? snapshot?.turnId ?? record.lastTurnId;
  if (!turnId) return ["尚无执行记录。"];
  const relevantSnapshot = snapshot?.turnId === turnId ? snapshot : undefined;
  const externallyActive = Boolean(remoteActive && remote && !isBotOwnedActiveTurn(record, remote));
  const lines = [
    `**回合 ID**：${cardText(turnId)}`,
    `**执行状态**：${externallyActive ? "外部执行中" : relevantSnapshot ? turnViewStatusLabel(relevantSnapshot.status) : remoteTurnStatusLabel(remote?.lastTurnStatus ?? remoteStatusToTurnStatus(remote?.status) ?? record.lastTurnStatus)}`,
    `**当前 / 最后步骤**：${statusExcerpt(currentOrLastStep(relevantSnapshot, remote), 600)}`,
  ];

  const remoteCountsApply = remote?.lastTurnId === turnId && remote.lastTurnToolCount !== undefined;
  if (relevantSnapshot || remoteCountsApply) {
    const lastTool = [...(relevantSnapshot?.activities ?? [])]
      .reverse()
      .find((activity): activity is Extract<TurnActivity, { kind: "tool" }> => activity.kind === "tool")?.tool;
    const tool = relevantSnapshot?.activeTool ?? lastTool;
    const completedTools = remoteCountsApply
      ? remote.lastTurnCompletedToolCount ?? 0
      : relevantSnapshot?.completedToolCount ?? relevantSnapshot?.completedTools?.length ?? 0;
    const failedTools = remoteCountsApply
      ? remote.lastTurnFailedToolCount ?? 0
      : relevantSnapshot?.failedToolCount ?? relevantSnapshot?.failedTools?.length ?? 0;
    const runningTools = remoteCountsApply
      ? remote.lastTurnRunningToolCount ?? 0
      : relevantSnapshot?.activeTool ? 1 : 0;
    lines.push(`**工具执行**：完成 ${completedTools}，失败 ${failedTools}${runningTools > 0 ? `，当前 ${runningTools}` : ""}`);
    if (tool) lines.push(`**当前 / 最后工具**：${statusExcerpt(tool.title, 400)}（${toolStatusLabel(tool.status)}）`);
    if (relevantSnapshot?.durationMs !== undefined) lines.push(`**耗时**：${formatDuration(relevantSnapshot.durationMs)}`);
  }
  if (queued > 0) lines.push(`**排队消息**：${queued} 条`);
  return lines;
}

function finalResultLines(snapshot?: TurnViewState, remote?: RemoteSessionSummary): string[] {
  const relevantSnapshot = !remote?.lastTurnId || snapshot?.turnId === remote.lastTurnId ? snapshot : undefined;
  if (relevantSnapshot?.status === "running" || relevantSnapshot?.status === "tool_running" || relevantSnapshot?.status === "waiting_for_approval"
    || isRemoteSessionActive(remote)) {
    return ["任务仍在执行，尚无最终结果。"];
  }
  const result = remote?.finalResponse?.trim() || relevantSnapshot?.finalResponse?.trim();
  if (result) return [statusExcerpt(result, 2_800)];
  const error = remote?.lastError?.trim() || relevantSnapshot?.error?.trim();
  if (error) return [`❌ ${statusExcerpt(error, 2_400)}`];
  if (relevantSnapshot?.status === "cancelled" || remote?.lastTurnStatus === "interrupted") {
    return ["任务已停止，未产生最终回答。"];
  }
  if (relevantSnapshot?.status === "failed" || remote?.lastTurnStatus === "failed") {
    return ["任务执行失败，未记录最终回答。"];
  }
  return ["没有保存到可展示的最终结果。"];
}

function currentOrLastStep(snapshot?: TurnViewState, remote?: RemoteSessionSummary): string {
  const snapshotActive = snapshot?.status === "running" || snapshot?.status === "tool_running" || snapshot?.status === "waiting_for_approval";
  if (isRemoteSessionActive(remote) && !snapshotActive) return remote?.lastActivity ?? remoteStatusStep(remote);
  if (snapshot?.approval) return `等待确认：${snapshot.approval.title}`;
  if (snapshot?.activeTool) return `正在执行：${snapshot.activeTool.title}`;
  const activePlan = snapshot?.plan?.find((step) => step.status === "in_progress");
  if (activePlan) return activePlan.text;
  const activity = [...(snapshot?.activities ?? [])].reverse().find((item) =>
    item.kind === "reasoning" ? Boolean(item.text.trim()) : true,
  );
  if (activity?.kind === "reasoning") return activity.text;
  if (activity?.kind === "tool") return `${toolStatusLabel(activity.tool.status)}：${activity.tool.title}`;
  if (snapshot?.progressText) return snapshot.progressText;
  if (remote?.lastActivity) return remote.lastActivity;
  return remoteStatusStep(remote);
}

function remoteStatusStep(remote?: RemoteSessionSummary): string {
  if (!remote) return "未记录执行步骤";
  if (isRemoteSessionActive(remote)) return "外部任务正在执行，实时步骤尚未同步到本进程";
  if (remote.lastTurnStatus === "completed") return "最近回合已完成";
  if (remote.lastTurnStatus === "interrupted") return "最近回合已停止";
  if (remote.lastTurnStatus === "failed") return "最近回合执行失败";
  return "尚无执行记录";
}

function remoteSessionDetailStatus(remote: RemoteSessionSummary): string {
  if (isRemoteSessionActive(remote)) return "🟢 外部执行中";
  return remoteSessionStatusLabel(remote.status);
}

function isRemoteSessionActive(remote?: RemoteSessionSummary): boolean {
  return remote?.status === "active" || remote?.lastTurnStatus === "inProgress";
}

function remoteTurnStatusLabel(status?: string): string {
  const labels: Record<string, string> = {
    inProgress: "执行中",
    completed: "已完成",
    interrupted: "已停止",
    failed: "失败",
    running: "执行中",
    cancelled: "已停止",
  };
  return status ? labels[status] ?? status : "尚无执行记录";
}

function remoteStatusToTurnStatus(status?: RemoteSessionSummary["status"]): string | undefined {
  if (status === "active") return "inProgress";
  if (status === "error") return "failed";
  return undefined;
}

function turnViewStatusLabel(status: TurnViewState["status"]): string {
  const labels: Record<TurnViewState["status"], string> = {
    starting: "正在启动",
    running: "执行中",
    tool_running: "工具执行中",
    waiting_for_approval: "等待确认",
    completed: "已完成",
    cancelled: "已停止",
    failed: "失败",
  };
  return labels[status];
}

function toolStatusLabel(status: "running" | "completed" | "failed"): string {
  return status === "running" ? "执行中" : status === "completed" ? "已完成" : "失败";
}

function statusExcerpt(value: string, maxLength: number): string {
  const clean = value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").trim();
  return cardText(truncateMiddle(clean || "未记录", maxLength));
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds}ms` : `${(milliseconds / 1_000).toFixed(1)}s`;
}

function formatStatusTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function formatResetTurnTime(value?: number): string {
  return value === undefined ? "完成时间未知" : formatStatusTime(new Date(value).toISOString());
}

function cardText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("`", "&#96;").replaceAll("<", "&#60;").replaceAll(">", "&#62;");
}

function cardCode(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

function permissionModeValue(value: unknown): PermissionMode {
  if (value === "auto" || value === "confirm") return value;
  throw new Error("权限模式只能是 auto 或 confirm。");
}

function executionSettingsTabValue(value: unknown): ExecutionSettingsTab {
  if (value === "agent" || value === "provider" || value === "model" || value === "thinking" || value === "permission") return value;
  throw new Error("设置卡片的 tab 无效，请重新发送设置命令。");
}

function resetHistoryPageValue(value: unknown): number {
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 0) throw new Error("历史轮次卡片页码无效，请重新发送 /turns。");
  return page;
}

function requiredCardMessageId(value: string | undefined): string {
  if (value) return value;
  throw new Error("无法更新卡片，请重新发送对应命令。");
}

function remoteSessionStatusLabel(status: RemoteSessionSummary["status"]): string {
  const labels: Record<RemoteSessionSummary["status"], string> = {
    active: "执行中",
    idle: "空闲",
    not_loaded: "未加载",
    error: "异常",
  };
  return labels[status];
}

function formatRemoteTime(value?: number): string {
  if (value === undefined) return "时间未知";
  return formatStatusTime(new Date(normalizeRemoteTimestamp(value)).toISOString());
}

function mapRemoteTurnStatus(status?: RemoteSessionSummary["lastTurnStatus"]): string | undefined {
  if (status === "interrupted") return "cancelled";
  if (status === "inProgress") return "running";
  return status;
}

function mergeRemoteTaskStatus(record: SessionRecord, remote?: RemoteSessionSummary): SessionRecord {
  if (!remote) return record;
  const remoteTurnStatus = mapRemoteTurnStatus(remote.lastTurnStatus);
  const createdAt = remote.createdAt === undefined
    ? record.createdAt
    : new Date(normalizeRemoteTimestamp(remote.createdAt)).toISOString();
  const remoteActivityAt = latestRemoteTimestamp(remote.recencyAt, remote.updatedAt);
  const updatedAt = remoteActivityAt === undefined
    ? record.updatedAt
    : new Date(remoteActivityAt).toISOString();
  return {
    ...record,
    title: remote.title ?? record.title,
    cwd: remote.cwd || record.cwd,
    modelProvider: remote.modelProvider ?? record.modelProvider,
    model: remote.model ?? record.model,
    reasoningEffort: remote.reasoningEffort ?? record.reasoningEffort,
    permissionMode: remote.permissionMode ?? record.permissionMode,
    status: isRemoteSessionActive(remote)
      ? "running"
      : remote.lastTurnStatus
        ? "ready"
        : record.status,
    lastTurnId: remote.lastTurnId ?? record.lastTurnId,
    lastTurnStatus: remoteTurnStatus ?? record.lastTurnStatus,
    createdAt,
    updatedAt,
  };
}

function normalizeRemoteTimestamp(value: number): number {
  return value >= 10_000_000_000 ? value : value * 1_000;
}

function parseIsoTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function latestRemoteTimestamp(...values: Array<number | undefined>): number | undefined {
  const timestamps = values
    .filter((value): value is number => value !== undefined)
    .map(normalizeRemoteTimestamp);
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}

function isTurnStillRunning(status?: TurnViewState["status"]): boolean {
  return status === "starting"
    || status === "running"
    || status === "tool_running"
    || status === "waiting_for_approval";
}

function forkedTurnStatus(status?: TurnViewState["status"]): string | undefined {
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  return undefined;
}

function needsFullSessionSynchronization(
  record: SessionRecord,
  session: RuntimeSession,
  remoteActivity: RemoteSessionActivity | undefined,
): boolean {
  if (!remoteActivity) return Boolean(record.lastTurnId || session.activeTurnId);
  return Boolean(session.activeTurnId && !remoteActivity.active);
}

function isBotOwnedActiveTurn(record: SessionRecord, remote: RemoteSessionSummary): boolean {
  return record.status === "running"
    && record.lastTurnStatus === "running"
    && Boolean(record.lastTurnId)
    && record.lastTurnId === remote.lastTurnId;
}

function isQueueIndependentCommand(command: Command): boolean {
  if (["archive", "dismiss", "stop", "status", "restart", "release", "mute", "help", "sessions", "dir", "file", "goal", "nosteer", "shell"].includes(command.type)) return true;
  if (command.type === "agent") return command.agent === undefined;
  if (["model", "provider", "thinking", "permissions"].includes(command.type)) return true;
  return false;
}

function shellCommandJobCardView(job: ShellCommandJobSnapshot): ShellCommandCardView {
  const status = job.status === "starting" ? "running" : job.status;
  return {
    jobId: job.id,
    contextKey: job.contextKey,
    command: job.command,
    cwd: job.cwd,
    output: [job.output.trimEnd(), job.error].filter(Boolean).join("\n"),
    status,
    exitCode: job.exitCode,
    elapsedMs: Math.max(0, (job.completedAt ?? Date.now()) - job.startedAt),
    outputTruncated: job.outputTruncated,
  };
}

function commandRequiresCurrentSession(command: Command): boolean {
  if (["dismiss", "stop", "title", "turns", "file", "model", "provider", "thinking", "permissions", "nosteer"].includes(command.type)) {
    return true;
  }
  if (command.type === "archive" || command.type === "fork") return command.sessionId === undefined;
  if (command.type === "goal") return command.action !== "set";
  return false;
}

function unboundThreadTaskMessage(): string {
  return "当前话题尚未绑定任务。发送普通消息后，Agent Bot 会从可识别的原始轮次创建分支；没有原始轮次时会创建全新任务。也可以使用 /new 创建全新任务，或使用 /sessions 绑定现有任务。";
}

function parseSessionPage(value: unknown): number {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function directoryPageValue(value: unknown): number {
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 0) throw new Error("文件浏览卡片页码无效，请重新发送 /dir。");
  return page;
}

function isWindowsDriveRoot(directory: string): boolean {
  return /^[a-z]:\\$/iu.test(path.win32.normalize(directory));
}

function directoryBrowserEntryKind(entry: Dirent, filePath: string): DirectoryBrowserCardEntry["kind"] {
  if (entry.isDirectory()) return "directory";
  try {
    if (classifyFileContent(filePath).kind === "text") return "file";
  } catch {
    return "file";
  }
  const extension = path.extname(entry.name).toLowerCase();
  if (IMAGE_FILE_EXTENSIONS.has(extension)) return "image";
  return "binary";
}

function directoryActionPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("文件浏览卡片中的目录无效，请重新发送 /dir。");
  }
  return value === WINDOWS_DRIVES_DIRECTORY ? value : path.resolve(value);
}

function directoryFileActionPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("文件浏览卡片中的文件无效，请重新发送 /dir。");
  }
  return path.resolve(value);
}

function cardFormValue(value: Record<string, unknown>, name: string): unknown {
  const formValue = value.formValue;
  return typeof formValue === "object" && formValue !== null
    ? (formValue as Record<string, unknown>)[name]
    : undefined;
}

function directoryFolderName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("请输入目录名。");
  const name = value.trim();
  if (name === "." || name === "..") throw new Error("目录名不能是 . 或 ..。");
  if (name.length > 255) throw new Error("目录名不能超过 255 个字符。");
  if (/[<>:"/\\|?*\u0000-\u001F]/u.test(name)) {
    throw new Error("目录名不能包含路径分隔符或以下字符：< > : \" / \\ | ? *");
  }
  if (/[. ]$/u.test(name)) throw new Error("目录名不能以空格或句点结尾。");
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(name)) {
    throw new Error("该名称是系统保留名称，请使用其他目录名。");
  }
  return name;
}

function directoryCreationActions(
  directory: string,
  contextKey: string,
  page: number,
): TaskListCardAction[] {
  return [
    {
      text: "NewFolder",
      value: {
        action: "directory_new_folder_prompt",
        directory,
        contextKey,
        page: String(page),
      },
    },
    {
      text: "NewTask",
      value: {
        action: "directory_new",
        directory,
        contextKey,
      },
    },
    {
      text: "NewGroupTask",
      value: {
        action: "directory_new_group",
        directory,
        contextKey,
      },
    },
  ];
}

function directoryPaginationActions(
  directory: string,
  page: number,
  totalPages: number,
  contextKey: string,
): TaskListCardAction[] {
  return [
    ...(page > 0 ? [{
      text: "Previous",
      value: {
        action: "directory_page",
        directory,
        page: String(page - 1),
        contextKey,
      },
    }] : []),
    ...(page < totalPages - 1 ? [{
      text: "Next",
      value: {
        action: "directory_page",
        directory,
        page: String(page + 1),
        contextKey,
      },
    }] : []),
  ];
}

function windowsDriveDisplayName(drive: WindowsDriveInfo): string {
  const driveLetter = drive.root.slice(0, 2).toUpperCase();
  const label = drive.label?.trim() || windowsDriveTypeLabel(drive.driveType);
  return `${label} (${driveLetter})`;
}

function windowsDriveTypeLabel(driveType?: string): string {
  switch (driveType?.toLowerCase()) {
    case "fixed": return "本地磁盘";
    case "network": return "网络驱动器";
    case "removable": return "可移动磁盘";
    case "cdrom": return "光驱";
    case "ram": return "RAM 磁盘";
    default: return "磁盘";
  }
}

async function listWindowsDriveRoots(): Promise<WindowsDriveInfo[]> {
  if (process.platform !== "win32") throw new Error("磁盘列表仅在 Windows 上可用。");
  const result = await executeShellCommand(
    "$drives = @([System.IO.DriveInfo]::GetDrives() | ForEach-Object { $label = ''; if ($_.IsReady) { try { $label = $_.VolumeLabel } catch {} }; [PSCustomObject]@{ root = $_.Name; label = $label; driveType = $_.DriveType.ToString() } }); ConvertTo-Json -Compress -InputObject $drives",
    os.homedir(),
    { timeoutMs: 10_000, maxOutputBytes: 16 * 1024, platform: "win32" },
  );
  if (result.timedOut || result.exitCode !== 0) {
    const detail = result.stderr.trim() || `退出码 ${result.exitCode ?? "未知"}`;
    throw new Error(`无法读取 Windows 磁盘列表：${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim().replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(`无法解析 Windows 磁盘列表：${runtimeErrorMessage(error)}`);
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const drives = values.flatMap((value): WindowsDriveInfo[] => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as Record<string, unknown>;
    if (typeof record.root !== "string") return [];
    const root = path.win32.normalize(record.root.trim());
    if (!isWindowsDriveRoot(root)) return [];
    return [{
      root,
      ...(typeof record.label === "string" && record.label.trim() ? { label: record.label.trim() } : {}),
      ...(typeof record.driveType === "string" ? { driveType: record.driveType } : {}),
    }];
  }).sort((left, right) => left.root.localeCompare(right.root, undefined, { sensitivity: "base" }));
  if (drives.length === 0) throw new Error("没有检测到可用的 Windows 磁盘。");
  return drives;
}

function commandDefersReactionFinalization(command: Command): boolean {
  return command.type === "prompt" || command.type === "nosteer" || command.type === "shell";
}

function runtimePrompt(text: string, localImagePaths?: string[]): RuntimePrompt {
  return localImagePaths?.length ? { text, localImagePaths } : text;
}

function mergedForwardPrompt(
  instruction: string,
  transcript: string,
): string {
  return `${instruction}\n\n参考聊天记录：\n${transcript}`;
}

function referencedMessagePrompt(instruction: string, referencedMessage: string): string {
  return `${instruction}\n\n引用消息：\n${referencedMessage}`;
}

function topicRootMessagePrompt(instruction: string, rootMessage: string): string {
  return `${instruction}\n\n话题根消息：\n${rootMessage}`;
}

function topicRootMessageId(message: IncomingMessage): string | undefined {
  if (!message.threadContext) return undefined;
  const rootMessageId = message.rootMessageId?.trim();
  if (!rootMessageId || rootMessageId === message.messageId) return undefined;
  return rootMessageId;
}

function quotedMessageId(message: IncomingMessage): string | undefined {
  const messageId = message.parentMessageId?.trim();
  if (!messageId || message.contextKey.startsWith("console:")) return undefined;
  if (message.mergedForwardMessageId) return undefined;
  const text = message.text.trimStart();
  if (text.startsWith("/") || text.startsWith("!")) return undefined;
  if (message.threadContext && message.rootMessageId === messageId) return undefined;
  return messageId;
}

function renderLocalTurnReference(
  snapshot: TurnViewState,
  messageKind: "progress" | "final",
): string | undefined {
  if (messageKind === "final") {
    const response = snapshot.finalResponse?.trim() || snapshot.assistantText?.trim();
    return response
      ? `[消息类型：AgentBot 回复]\n${truncateMiddle(response, 48_000)}`
      : undefined;
  }

  const activityText = (snapshot.activities ?? [])
    .filter((activity): activity is Extract<TurnActivity, { kind: "assistant" | "reasoning" }> =>
      activity.kind === "assistant" || activity.kind === "reasoning")
    .map((activity) => activity.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const content = [
    snapshot.prompt?.trim() ? `用户请求：\n${snapshot.prompt.trim()}` : "",
    activityText,
    snapshot.progressText?.trim() || "",
    snapshot.finalResponse?.trim() || snapshot.assistantText?.trim() || "",
    snapshot.error?.trim() ? `错误：${snapshot.error.trim()}` : "",
  ].filter(Boolean).join("\n\n");
  return content
    ? `[消息类型：AgentBot 思考卡片]\n${truncateMiddle(content, 48_000)}`
    : undefined;
}

function appendDownloadedFiles(
  prompt: string,
  files: Array<{ fileName: string; filePath: string }>,
): string {
  return `${prompt}\n\n参考文件（已下载到本地）：\n${files.map((file, index) =>
    `[文件 ${index + 1}：${file.fileName}] ${file.filePath}`).join("\n")}`;
}

function defaultResourcePrompt(message: IncomingMessage): string {
  return defaultResourcePromptFromCounts(message.images?.length ?? 0, message.files?.length ?? 0);
}

function defaultResourcePromptFromCounts(imageCount: number, fileCount: number): string {
  if (imageCount > 0 && fileCount > 0) return "请查看附带的图片和文件";
  if (fileCount > 0) return fileCount === 1 ? "请查看这个文件" : "请查看这些文件";
  return imageCount === 1 ? "请查看这张图片" : "请查看这些图片";
}

function isStandaloneResourceMessage(message: IncomingMessage): boolean {
  return !message.mergedForwardMessageId
    && message.text.trim().length === 0
    && ((message.images?.length ?? 0) > 0 || (message.files?.length ?? 0) > 0);
}

function deduplicateImageReferences(
  images: Array<{ messageId: string; imageKey: string }>,
): Array<{ messageId: string; imageKey: string }> {
  const seen = new Set<string>();
  return images.filter((image) => {
    const key = `${image.messageId}:${image.imageKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduplicateFileReferences(
  files: Array<{ messageId: string; fileKey: string; fileName: string }>,
): Array<{ messageId: string; fileKey: string; fileName: string }> {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.messageId}:${file.fileKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function recoveryCardPrompt(prompt: string): string {
  return `恢复重启前的任务：${prompt}`;
}

function recoveryRuntimePrompt(prompt: string): string {
  return [
    "Agent Bot restarted while the previous turn was still running.",
    "Continue the unfinished task in the current task and workspace.",
    "Inspect the existing conversation, files, and completed tool effects first. Do not repeat completed or irreversible actions.",
    "Finish the original request:",
    "",
    prompt,
  ].join("\n");
}

function llmRetryCardPrompt(prompt: string, retryNumber: number): string {
  return `自动重试 ${retryNumber}/${MAX_LLM_TURN_RETRIES}：${prompt}`;
}

function llmRetryRuntimePrompt(prompt: string, retryNumber: number): string {
  return [
    `Agent Bot is automatically retrying this request after a transient LLM service failure (${retryNumber}/${MAX_LLM_TURN_RETRIES}).`,
    "Continue in the current task and workspace. Inspect the conversation, files, and completed tool effects before acting.",
    "Do not repeat completed or irreversible actions. Finish the original request:",
    "",
    prompt,
  ].join("\n");
}

function isRetryableLlmTurnFailure(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  const permanentFailure = [
    /auth(?:entication|orization)?\b|unauthorized|forbidden|invalid api key|incorrect api key/u,
    /insufficient[_ -]?quota|quota (?:exceeded|exhausted)|usage limit|billing|credit balance/u,
    /context (?:length|window)|maximum context|too many tokens|token limit/u,
    /invalid request|bad request|invalid argument|malformed|unsupported|not supported/u,
    /model (?:not found|does not exist)|unknown model/u,
    /permission|approval|sandbox|policy violation|content policy/u,
  ].some((pattern) => pattern.test(normalized));
  if (permanentFailure) return false;

  return [
    /(?:^|\D)429(?:\D|$)|rate[_ -]?limit|too many requests/u,
    /overload|high demand|at capacity|capacity limit|temporar(?:y|ily) unavailable/u,
    /service unavailable|internal server error|bad gateway|gateway timeout/u,
    /(?:^|\D)(?:500|502|503|504)(?:\D|$)|upstream (?:error|failure|timeout)/u,
    /deadline exceeded|request timed out|request timeout|response timeout/u,
    /connection (?:reset|closed|aborted|disconnected)|network error|socket hang up/u,
    /app server .*(?:closed|disconnected|exited|reset|aborted)/u,
    /stream (?:closed|disconnected|interrupted|error)/u,
    /\b(?:llm|model|provider|inference)\b.*\b(?:error|failed|failure|unavailable|timeout|timed out)\b/u,
  ].some((pattern) => pattern.test(normalized));
}

function remoteTurnMatchesAttempt(remote: RemoteSessionSummary | undefined, attempt: TurnAttemptRecord): boolean {
  if (!remote?.lastTurnId) return false;
  if (attempt.turnId) return remote.lastTurnId === attempt.turnId;
  const remoteUpdatedAt = remote.updatedAt === undefined ? undefined : normalizeRemoteTimestamp(remote.updatedAt);
  const acceptedAt = Date.parse(attempt.createdAt);
  return remoteUpdatedAt !== undefined
    && Number.isFinite(acceptedAt)
    && remoteUpdatedAt >= acceptedAt - 1_000;
}

function isRecoveryAttemptRecent(attempt: TurnAttemptRecord, cutoff: number): boolean {
  const updatedAt = Date.parse(attempt.updatedAt);
  return Number.isFinite(updatedAt) && updatedAt >= cutoff;
}

function abbreviateHomeDirectory(value: string): string {
  const homeDirectory = os.homedir();
  const valueIsWindows = isWindowsAbsolutePath(value);
  const homeIsWindows = isWindowsAbsolutePath(homeDirectory);
  if (valueIsWindows !== homeIsWindows && (valueIsWindows || path.posix.isAbsolute(value))) return value;
  const pathApi = valueIsWindows ? path.win32 : path;
  const relative = pathApi.relative(homeDirectory, value);
  if (relative === "") return "~";
  if (pathApi.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${pathApi.sep}`)) return value;
  return `~${pathApi.sep}${relative}`;
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-z]:[\\/]|^\\\\/iu.test(value);
}

function parseAgentGroupName(value: string): { agentName: string; title: string } | undefined {
  const match = /^\[([^[\]]+)\]\s+(.+)$/.exec(value.trim());
  const agentName = match?.[1]?.trim();
  const remainder = match?.[2]?.trim();
  if (!agentName || !remainder) return undefined;
  const projectPrefix = /^\[([^[\]]+)\](?:\s+(.+))?$/.exec(remainder);
  const title = projectPrefix ? projectPrefix[2]?.trim() : remainder;
  return agentName && title ? { agentName, title } : undefined;
}

function isDefaultGroupNameFormat(format: AppConfig["feishu"]["groupNameFormat"]): boolean {
  return format.project === DEFAULT_GROUP_NAME_FORMAT.project
    && format.projectless === DEFAULT_GROUP_NAME_FORMAT.projectless;
}

function isLegacyGroupPrefixOnly(value: string): boolean {
  return /^\[[^[\]]+\]\s+\[[^[\]]+\]\s*$/u.test(value.trim());
}

function validateGoalObjective(objective: string): void {
  const length = Array.from(objective.trim()).length;
  if (length === 0) throw new Error("Goal 不能为空。");
  if (length > 4_000) {
    throw new Error("Goal 最多 4000 个字符。请把详细说明写入文件，并在 Goal 中引用该文件。");
  }
}

function goalDetailLines(goal: RuntimeGoal): string[] {
  return [
    `**状态**：${goalStatusLabel(goal.status)}`,
    `**目标**：${statusExcerpt(goal.objective, 2_800)}`,
    `**消耗**：${formatGoalTokenCount(goal.tokensUsed)} tokens / ${formatGoalElapsed(goal.timeUsedSeconds)}`,
    ...(goal.tokenBudget === null || goal.tokenBudget === undefined
      ? []
      : [`**Token 预算**：${formatGoalTokenCount(goal.tokenBudget)}`]),
    `**更新时间**：${formatUnixTime(goal.updatedAt)}`,
  ];
}

function goalStatusLabel(status: RuntimeGoal["status"]): string {
  const labels: Record<RuntimeGoal["status"], string> = {
    active: "执行中",
    paused: "已暂停",
    blocked: "已阻塞",
    usageLimited: "额度受限",
    budgetLimited: "Token 预算受限",
    complete: "已完成",
  };
  return labels[status];
}

function formatGoalTokenCount(tokens: number): string {
  const rounded = Math.max(0, Math.round(tokens));
  if (rounded < 10_000) return new Intl.NumberFormat("zh-CN").format(rounded);
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    compactDisplay: "short",
    maximumSignificantDigits: 3,
  }).format(rounded);
}

function formatGoalElapsed(seconds: number): string {
  const totalSeconds = Math.max(0, Math.round(seconds));
  const second = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minute = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  if (totalMinutes > 0) return `${String(totalMinutes).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  return `${totalSeconds}s`;
}

function formatUnixTime(seconds: number): string {
  return formatStatusTime(new Date(seconds * 1_000).toISOString());
}
