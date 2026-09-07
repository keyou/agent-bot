import { createHash } from "node:crypto";
import path from "node:path";
import type { JsonValue } from "../acp/acpTypes.js";
import type { RuntimeSession } from "../acp/AcpSessionManager.js";
import type {
  ApprovalDecision,
  ModelOption,
  ModelProviderOption,
  PermissionMode,
  ReasoningEffortOption,
  ToolState,
} from "../runtime/types.js";
import type { TurnActivity, TurnViewState, TurnViewStatus } from "../presentation/turnViewTypes.js";
import { truncateMiddle, truncateText } from "../utils/markdown.js";
import { localCardImage } from "./LocalCardImage.js";

export interface StartupStatusView {
  startedAt: Date;
  restartReason: string;
  agentBotVersion: string;
  defaultAgentName: string;
  defaultAgentTitle: string;
  cwd: string;
  workspaceKind?: "project" | "projectless";
  currentTask?: {
    id: string;
    title?: string;
    modelProvider?: string;
    model?: string;
    reasoningEffort?: string;
    permissionMode?: PermissionMode;
    agentName: string;
    sessionStatus: string;
    lastTurnStatus?: string;
  };
}

export type InitializationWelcomeKind = "first" | "upgrade" | "refresh";

export interface InitializationWelcomeFeature {
  icon: string;
  title: string;
  description: string;
}

export interface InitializationWelcomeView {
  kind: InitializationWelcomeKind;
  version: string;
  previousVersion?: string;
  activationPending?: boolean;
  defaultAgentName: string;
  defaultAgentTitle: string;
  availableAgents: string[];
  logoPath: string;
  features: InitializationWelcomeFeature[];
}

export interface SafeRestartStatusView {
  scheduleId: number;
  reason: string;
  phase: "waiting_tasks" | "waiting_delivery" | "countdown" | "restarting" | "cancelled" | "superseded";
  remainingMs?: number;
  pendingFinalDeliveries: number;
  waitingTasks: Array<{
    id: string;
    title?: string;
  }>;
}

export interface PromptQueueCardView {
  sessionId: string;
  contextKey: string;
  phase?: "active" | "superseded";
  prompts: Array<{
    id: string;
    text: string;
  }>;
}

export interface ModelSelectorCardView {
  sessionId: string;
  contextKey: string;
  currentModel?: string;
  reasoningEffort?: string;
  models: ModelOption[];
  modelProvider?: string;
  permissionMode?: PermissionMode;
  unifiedSettings?: boolean;
  notice?: string;
}

export interface ReasoningSelectorCardView {
  sessionId: string;
  contextKey: string;
  model: string;
  currentEffort?: string;
  options: ReasoningEffortOption[];
  modelProvider?: string;
  permissionMode?: PermissionMode;
  unifiedSettings?: boolean;
  notice?: string;
}

export interface ProviderSelectorCardView {
  sessionId: string;
  contextKey: string;
  currentProvider?: string;
  currentModel?: string;
  reasoningEffort?: string;
  permissionMode: PermissionMode;
  providers: ModelProviderOption[];
  notice?: string;
}

export interface PermissionSelectorCardView {
  sessionId: string;
  contextKey: string;
  modelProvider: string;
  model: string;
  reasoningEffort: string;
  currentMode: PermissionMode;
}

export type ExecutionSettingsTab = "agent" | "provider" | "model" | "thinking" | "permission";

export interface ExecutionSettingsAgentOption {
  name: string;
  title: string;
}

export interface ExecutionSettingsCardView {
  sessionId?: string;
  contextKey: string;
  activeTab: ExecutionSettingsTab;
  currentAgent: string;
  taskAgent?: string;
  agents: ExecutionSettingsAgentOption[];
  runtimeSettingsAvailable: boolean;
  currentProvider?: string;
  currentModel?: string;
  currentEffort?: string;
  currentPermissionMode: PermissionMode;
  providers: ModelProviderOption[];
  providerSupported: boolean;
  models: ModelOption[];
  reasoningOptions: ReasoningEffortOption[];
  notice?: string;
}

export interface CardSection {
  title?: string;
  lines: string[];
  collapsible?: boolean;
  elementId?: string;
}

export interface TaskListCardAction {
  text: string;
  type?: "default" | "primary" | "danger";
  value: Record<string, string>;
}

export interface HelpCardCommand {
  text: string;
  action?: TaskListCardAction;
  usage?: string;
  description: string;
}

export interface HelpCardSection {
  title: string;
  commands: HelpCardCommand[];
}

export interface TaskListCardEntry {
  lines: string[];
  actions?: TaskListCardAction[];
  current?: boolean;
}

export interface SessionTaskCardEntry {
  reference: string;
  summary: string;
  detailLines: string[];
  actions?: TaskListCardAction[];
  current?: boolean;
}

export interface SessionTaskCardGroup {
  title: string;
  entries: SessionTaskCardEntry[];
  actions?: TaskListCardAction[];
}

export interface DirectoryBrowserCardEntry {
  name: string;
  kind: "directory" | "drive" | "file" | "image" | "binary";
  openAction?: TaskListCardAction;
}

export interface DirectoryBrowserCardView {
  directory: string;
  entries: DirectoryBrowserCardEntry[];
  currentActions: TaskListCardAction[];
  navigationActions: TaskListCardAction[];
  footerLines: string[];
}

export interface DirectoryNewFolderCardView {
  directory: string;
  displayDirectory?: string;
  contextKey: string;
  page: number;
}

const DIRECTORY_BROWSER_ROW_COUNT = 16;

export type ThinkingCardLayout = "grouped" | "timeline";

export interface CardRendererOptions {
  thinkingCardLayout?: ThinkingCardLayout;
}

export interface ResetHistoryCardEntry extends TaskListCardEntry {
  sequence: number;
  graphNodeLine: string;
  graphConnectorLine?: string;
  timestamp?: string;
  running?: boolean;
  resetting?: boolean;
}

export interface ResetHistoryCardView {
  entries: ResetHistoryCardEntry[];
  footerLines: string[];
  pageActions: TaskListCardAction[];
}

export interface DismissGroupCardView {
  contextKey: string;
  sessionId: string;
  taskTitle: string;
  requestedBy: string;
}

export interface ShellCommandCardView {
  jobId?: string;
  contextKey?: string;
  command: string;
  cwd: string;
  output: string;
  status: "running" | "cancelling" | "completed" | "failed" | "cancelled" | "timed_out";
  exitCode?: number | null;
  elapsedMs: number;
  outputTruncated: boolean;
}

export interface ThreadWriterConflictCardView {
  status: "occupied" | "force_required" | "released";
  contextKey: string;
  sessionId: string;
  threadId: string;
  taskTitle?: string;
  notice?: string;
  applicationIdle?: boolean;
  owner?: {
    displayName: string;
    writerPid: number;
    writerProcessName: string;
    writerStartedAt?: string;
    applicationPid: number;
    applicationProcessName: string;
    applicationStartedAt?: string;
    canClose: boolean;
  };
}

export interface AppServerReleaseCardView {
  status: "waiting" | "releasing" | "released" | "cancelled" | "failed";
  contextKey: string;
  scheduleId: number;
  agentName: string;
  blockingTaskCount?: number;
  blockingTaskTitles?: string[];
  forced?: boolean;
  error?: string;
}

export class CardRenderer {
  private readonly thinkingCardLayout: ThinkingCardLayout;

  constructor(options: CardRendererOptions = {}) {
    this.thinkingCardLayout = options.thinkingCardLayout ?? "grouped";
  }

  renderThreadWriterConflict(view: ThreadWriterConflictCardView): Record<string, unknown> {
    if (view.status === "released") {
      return sectionCard("任务占用已解除", [markdown([
        view.taskTitle ? `**任务**：${inlineCode(view.taskTitle)}` : undefined,
        view.notice ?? "请重新发送消息。",
      ].filter((line): line is string => Boolean(line)).join("\n"))], "green");
    }

    const owner = view.owner;
    const lines = [
      view.taskTitle ? `**任务**：${inlineCode(view.taskTitle)}` : undefined,
      owner ? `**进程**：${inlineCode(`${owner.applicationProcessName} (${owner.applicationPid})`)}` : undefined,
      view.notice,
      owner
        ? view.applicationIdle === true
          ? "> 无执行中任务，可安全关闭；也可 **Fork** 后继续发送消息。"
          : view.applicationIdle === false
            ? "> 有任务执行中，关闭会中断任务；可 **Fork** 后继续发送消息。"
            : "> 可 **Fork** 后继续发送消息；关闭进程后请重发消息。"
        : "> 可 **Fork** 后继续发送消息；或手动关闭占用任务。",
    ].filter((line): line is string => Boolean(line));
    const elements: Record<string, unknown>[] = [markdown(lines.join("\n"))];
    const canClose = owner?.canClose
      && Boolean(owner.writerStartedAt)
      && Boolean(owner.applicationStartedAt);
    const actions: Record<string, unknown>[] = [{
      tag: "button",
      text: {
        tag: "plain_text",
        content: "Fork",
      },
      type: "default",
      size: "small",
      behaviors: [{
        type: "callback",
        value: {
          action: "thread_writer_fork",
          contextKey: view.contextKey,
          sessionId: view.sessionId,
          threadId: view.threadId,
        },
      }],
    }];
    if (canClose && owner) {
      actions.push({
        tag: "button",
        text: {
          tag: "plain_text",
          content: view.status === "force_required"
            ? `Force ${owner.applicationPid}`
            : `Close ${owner.applicationPid}`,
        },
        type: "danger",
        size: "small",
        behaviors: [{
          type: "callback",
          value: {
            action: "thread_writer_close",
            contextKey: view.contextKey,
            sessionId: view.sessionId,
            threadId: view.threadId,
            writerPid: owner.writerPid,
            writerStartedAt: owner.writerStartedAt,
            applicationPid: owner.applicationPid,
            applicationStartedAt: owner.applicationStartedAt,
            force: view.status === "force_required",
          },
        }],
      });
    }
    elements.push({
      tag: "column_set",
      flex_mode: "none",
      horizontal_spacing: "8px",
      vertical_align: "center",
      columns: actions.map((button) => ({
        tag: "column",
        width: "auto",
        vertical_align: "center",
        elements: [button],
      })),
    });
    return sectionCard(
      view.status === "force_required" ? "仍被占用" : "任务被占用",
      elements,
      view.status === "force_required" ? "red" : "orange",
    );
  }

  renderAppServerRelease(view: AppServerReleaseCardView): Record<string, unknown> {
    const agent = inlineCode(view.agentName);
    if (view.status === "released") {
      return sectionCard("任务已释放", [markdown([
        `**Agent**：${agent}`,
        view.forced ? "执行中的任务已中断。" : undefined,
        "> 请在 Codex Desktop 点击 **Retry**。",
      ].filter((line): line is string => Boolean(line)).join("\n"))], "green");
    }
    if (view.status === "cancelled") {
      return sectionCard("已取消释放", [markdown(`**Agent**：${agent}\n> Agent Bot 将继续保持当前任务连接。`)], "grey");
    }
    if (view.status === "failed") {
      return sectionCard("释放失败", [markdown([
        `**Agent**：${agent}`,
        view.error ? truncateText(view.error, 500) : "无法释放 App Server。",
      ].join("\n"))], "red");
    }
    if (view.status === "releasing") {
      return sectionCard("正在释放", [markdown(`**Agent**：${agent}\n正在停止 Agent Bot 的 App Server。`)], "blue");
    }

    const blockingTaskCount = Math.max(0, view.blockingTaskCount ?? 0);
    const blockingTaskLines = (view.blockingTaskTitles ?? []).map((title, index) => {
      const normalizedTitle = title.replace(/\s+/g, " ").trim() || "未命名任务";
      return `${index + 1}. ${inlineCode(truncateText(normalizedTitle, 80))}`;
    });
    return sectionCard(blockingTaskCount > 0 ? "等待释放" : "确认释放", [
      markdown([
        `**Agent**：${agent}`,
        blockingTaskCount > 0
          ? `**等待任务**：${blockingTaskCount}`
          : "**状态**：可以释放",
        ...blockingTaskLines,
        blockingTaskCount > 0
          ? "> 点击 **Release Now** 会中断执行；也可等待任务结束后再释放。"
          : "> 点击 **Release** 释放，或取消。",
      ].join("\n")),
      {
        tag: "column_set",
        flex_mode: "none",
        horizontal_spacing: "8px",
        vertical_align: "center",
        columns: [
          {
            tag: "column",
            width: "auto",
            vertical_align: "center",
            elements: [{
              tag: "button",
              text: { tag: "plain_text", content: blockingTaskCount > 0 ? "Release Now" : "Release" },
              type: "danger",
              size: "small",
              behaviors: [{
                type: "callback",
                value: {
                  action: "app_server_release_now",
                  contextKey: view.contextKey,
                  scheduleId: view.scheduleId,
                  agentName: view.agentName,
                },
              }],
            }],
          },
          {
            tag: "column",
            width: "auto",
            vertical_align: "center",
            elements: [{
              tag: "button",
              text: { tag: "plain_text", content: "Cancel" },
              type: "default",
              size: "small",
              behaviors: [{
                type: "callback",
                value: {
                  action: "app_server_release_cancel",
                  contextKey: view.contextKey,
                  scheduleId: view.scheduleId,
                  agentName: view.agentName,
                },
              }],
            }],
          },
        ],
      },
    ], "orange");
  }

  renderShellCommandCard(view: ShellCommandCardView): Record<string, unknown> {
    const rawOutput = normalizeTerminalOutput(view.output).trimEnd();
    const displayOutput = truncateMiddle(
      rawOutput,
      6_000,
      "\n\n... 中间输出已截断 ...\n\n",
    );
    const command = truncateMiddle(view.command.trim(), 600, " ... ");
    const output = displayOutput || (view.status === "running" ? "等待输出..." : "（无输出）");
    const status = shellCommandStatus(view);
    const outputWasTruncated = view.outputTruncated || rawOutput.length > 6_000;
    const elements = [
      markdown(codeBlock(`$  ${command}\n${output}`, 6_700)),
      markdown([
        `${inlineCode(view.cwd)} · ${status.label} · ${formatTurnDuration(view.elapsedMs)}`,
        ...(outputWasTruncated ? ["输出过长，已保留开头和结尾并截断中间内容。"] : []),
      ].join("\n")),
    ];
    if (view.status === "running" && view.jobId && view.contextKey) {
      elements.push({
        tag: "button",
        text: { tag: "plain_text", content: "Cancel" },
        type: "danger",
        size: "small",
        behaviors: [{
          type: "callback",
          value: {
            action: "shell_command_cancel",
            jobId: view.jobId,
            contextKey: view.contextKey,
          },
        }],
      });
    }
    return sectionCard(
      status.title,
      elements,
      status.template,
    );
  }

  renderExecutionSettings(view: ExecutionSettingsCardView): Record<string, unknown> {
    const baseAction: Record<string, string> = {
      contextKey: view.contextKey,
      ...(view.sessionId ? { sessionId: view.sessionId } : {}),
    };
    const tabRow = settingsTabRow(
      view.activeTab,
      baseAction,
      view.agents.length > 1,
      view.runtimeSettingsAvailable,
    );
    const elements: Record<string, unknown>[] = [
      markdown([
        view.taskAgent
          ? `**默认 Agent / 当前任务 Agent**：${inlineCode(view.currentAgent)} / ${inlineCode(view.taskAgent)}`
          : `**默认 Agent**：${inlineCode(view.currentAgent)}`,
        ...(view.runtimeSettingsAvailable
          ? [
              `**Provider / 模型**：${inlineCode(view.currentProvider ?? "Agent 默认")} / ${inlineCode(view.currentModel ?? "默认")}`,
              `**思考强度 / 权限**：${inlineCode(view.currentEffort ?? "自动")} / ${inlineCode(permissionModeLabel(view.currentPermissionMode))}`,
            ]
          : []),
        ...(view.notice ? [view.notice] : []),
      ].join("\n")),
      ...(tabRow ? [tabRow] : []),
      { tag: "hr" },
    ];

    if (view.activeTab === "agent") {
      elements.push(...view.agents.map((agent) => settingsOptionRow({
        label: `${inlineCode(agent.name)} · ${escapeCardHtml(agent.title)}`,
        current: agent.name === view.currentAgent,
        action: {
          text: "Switch",
          value: {
            action: "settings_agent_select",
            ...baseAction,
            agent: agent.name,
          },
        },
      })));
    } else if (view.activeTab === "provider") {
      if (!view.providerSupported) {
        elements.push(markdown("当前运行时不支持 Provider 切换；其他设置仍可通过上方 tab 修改。"));
      } else if (view.providers.length === 0) {
        elements.push(markdown("当前 Agent 配置中没有可用的 Provider。"));
      } else {
        elements.push(...view.providers.map((provider) => settingsOptionRow({
          label: [
            inlineCode(provider.id),
            provider.displayName && provider.displayName !== provider.id
              ? ` · ${escapeCardHtml(provider.displayName)}`
              : "",
            provider.isDefault ? " · 默认" : "",
          ].join(""),
          current: provider.id === view.currentProvider,
          action: {
            text: "Switch",
            value: {
              action: "settings_provider_select",
              ...baseAction,
              provider: provider.id,
            },
          },
        })));
      }
    } else if (view.activeTab === "model") {
      if (view.models.length === 0) {
        elements.push(markdown("当前运行时未返回可用模型。"));
      } else {
        elements.push(...view.models.map((model) => settingsOptionRow({
          label: `${inlineCode(model.id)}${model.isDefault ? " · 默认" : ""}`,
          current: model.id === view.currentModel,
          action: {
            text: "Switch",
            value: {
              action: "settings_model_select",
              ...baseAction,
              model: model.id,
            },
          },
        })));
      }
    } else if (view.activeTab === "thinking") {
      if (!view.currentModel) {
        elements.push(markdown("请先选择模型。"));
      } else if (view.reasoningOptions.length === 0) {
        elements.push(markdown("当前模型没有可配置的思考强度。"));
      } else {
        const currentModel = view.currentModel;
        elements.push(...view.reasoningOptions.map((option) => settingsOptionRow({
          label: inlineCode(option.value),
          current: option.value === view.currentEffort,
          action: {
            text: "Switch",
            value: {
              action: "settings_thinking_select",
              ...baseAction,
              model: currentModel,
              effort: option.value,
            },
          },
        })));
      }
    } else {
      elements.push(...(["auto", "confirm"] as PermissionMode[]).map((mode) => settingsOptionRow({
        label: `${inlineCode(mode)} · ${permissionModeLabel(mode)}`,
        current: mode === view.currentPermissionMode,
        action: {
          text: "Switch",
          value: {
            action: "settings_permission_select",
            ...baseAction,
            permissionMode: mode,
          },
        },
      })));
    }

    return sectionCard("运行设置", elements, view.notice ? "green" : "blue");
  }

  renderProviderSelector(view: ProviderSelectorCardView): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [
      markdown([
        `**当前 Provider**：${inlineCode(view.currentProvider ?? "Agent 默认")}`,
        `**模型 / 思考强度 / 权限**：${inlineCode(view.currentModel ?? "默认")} / ${inlineCode(view.reasoningEffort ?? "自动")} / ${inlineCode(permissionModeLabel(view.permissionMode))}`,
        ...(view.notice ? [view.notice] : []),
      ].join("\n")),
      { tag: "hr" },
    ];
    if (view.providers.length === 0) {
      elements.push(markdown("当前 Agent 配置中没有可用的 Provider。"));
    } else {
      elements.push(...view.providers.map((provider) => ({
        tag: "column_set",
        flex_mode: "none",
        horizontal_spacing: "8px",
        vertical_align: "center",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            vertical_align: "center",
            elements: [markdown([
              inlineCode(provider.id),
              provider.displayName && provider.displayName !== provider.id ? ` · ${escapeCardHtml(provider.displayName)}` : "",
              provider.isDefault ? " · 默认" : "",
              provider.id === view.currentProvider ? " · ✅ 当前" : "",
            ].join(""))],
          },
          {
            tag: "column",
            width: "auto",
            vertical_align: "center",
            elements: [taskActionElement({
              text: provider.id === view.currentProvider ? "Configure" : "Select",
              value: {
                action: "provider_select",
                sessionId: view.sessionId,
                contextKey: view.contextKey,
                provider: provider.id,
                permissionMode: view.permissionMode,
              },
            })],
          },
        ],
      })));
    }
    return sectionCard("Provider 设置", elements, view.notice ? "green" : "blue");
  }

  renderReasoningSelector(view: ReasoningSelectorCardView): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [
      markdown([
        ...(view.modelProvider ? [`**Provider**：${inlineCode(view.modelProvider)}`] : []),
        `**模型**：${inlineCode(view.model)}`,
        `**当前思考模式**：${inlineCode(view.currentEffort ?? "默认")}`,
        ...(view.notice ? [view.notice] : []),
      ].join("\n")),
      { tag: "hr" },
    ];
    if (view.options.length === 0) {
      elements.push(markdown("该模型没有可配置的思考模式。"));
    } else {
      elements.push(...view.options.map((option) => {
        const isCurrent = option.value === view.currentEffort;
        return {
          tag: "column_set",
          flex_mode: "none",
          horizontal_spacing: "8px",
          vertical_align: "center",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              vertical_align: "center",
              elements: [markdown(inlineCode(option.value))],
            },
            {
              tag: "column",
              width: "auto",
              vertical_align: "center",
              elements: isCurrent && !view.unifiedSettings
                ? [markdown("✅ 当前")]
                : [taskActionElement({
                    text: view.unifiedSettings ? (isCurrent ? "Continue" : "Select") : "Switch",
                    value: {
                      action: view.unifiedSettings ? "provider_reasoning_select" : "reasoning_select",
                      sessionId: view.sessionId,
                      contextKey: view.contextKey,
                      ...(view.modelProvider ? { provider: view.modelProvider } : {}),
                      model: view.model,
                      effort: option.value,
                      ...(view.permissionMode ? { permissionMode: view.permissionMode } : {}),
                    },
                  })],
            },
          ],
        };
      }));
    }
    elements.push(
      { tag: "hr" },
      taskActionRow([{
        text: "Back",
        value: {
          action: view.unifiedSettings ? "provider_model_open" : "model_open",
          sessionId: view.sessionId,
          contextKey: view.contextKey,
          ...(view.modelProvider ? { provider: view.modelProvider } : {}),
          ...(view.permissionMode ? { permissionMode: view.permissionMode } : {}),
        },
      }]),
    );
    return sectionCard("思考模式", elements, view.notice ? "green" : "blue");
  }

  renderModelSelector(view: ModelSelectorCardView): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [
      markdown([
        ...(view.modelProvider ? [`**Provider**：${inlineCode(view.modelProvider)}`] : []),
        `**当前模型**：${inlineCode(view.currentModel ?? "默认")}`,
        `**思考强度**：${inlineCode(view.reasoningEffort ?? "默认")}`,
        ...(view.notice ? [view.notice] : []),
      ].join("\n")),
      { tag: "hr" },
    ];
    if (view.models.length === 0) {
      elements.push(markdown("当前运行时未返回可用模型。"));
    } else {
      elements.push(...view.models.map((model) => {
        const isCurrent = model.id === view.currentModel;
        return {
          tag: "column_set",
          flex_mode: "none",
          horizontal_spacing: "8px",
          vertical_align: "center",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              vertical_align: "center",
              elements: [markdown(
                `${inlineCode(model.id)}${model.isDefault ? " · 默认" : ""}`,
              )],
            },
            {
              tag: "column",
              width: "auto",
              vertical_align: "center",
              elements: isCurrent && !view.unifiedSettings
                ? [markdown("✅ 当前")]
                : [taskActionElement({
                    text: view.unifiedSettings ? (isCurrent ? "Continue" : "Select") : "Switch",
                    value: {
                      action: view.unifiedSettings ? "provider_model_select" : "model_select",
                      sessionId: view.sessionId,
                      contextKey: view.contextKey,
                      ...(view.modelProvider ? { provider: view.modelProvider } : {}),
                      model: model.id,
                      ...(view.permissionMode ? { permissionMode: view.permissionMode } : {}),
                    },
                  })],
            },
          ],
        };
      }));
    }
    if (view.unifiedSettings) {
      elements.push(
        { tag: "hr" },
        taskActionRow([{
          text: "Back",
          value: {
            action: "provider_open",
            sessionId: view.sessionId,
            contextKey: view.contextKey,
          },
        }]),
      );
    }
    return sectionCard(view.unifiedSettings ? "Provider 设置 · 模型" : "模型", elements, view.notice ? "green" : "blue");
  }

  renderPermissionSelector(view: PermissionSelectorCardView): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [
      markdown([
        `**Provider**：${inlineCode(view.modelProvider)}`,
        `**模型**：${inlineCode(view.model)}`,
        `**思考强度**：${inlineCode(view.reasoningEffort)}`,
        `**当前权限**：${inlineCode(permissionModeLabel(view.currentMode))}`,
      ].join("\n")),
      { tag: "hr" },
      ...(["auto", "confirm"] as PermissionMode[]).map((mode) => ({
        tag: "column_set",
        flex_mode: "none",
        horizontal_spacing: "8px",
        vertical_align: "center",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            vertical_align: "center",
            elements: [markdown(`${inlineCode(mode)} · ${permissionModeLabel(mode)}`)],
          },
          {
            tag: "column",
            width: "auto",
            vertical_align: "center",
            elements: [taskActionElement({
              text: mode === view.currentMode ? "Apply" : "Select",
              value: {
                action: "provider_permission_select",
                sessionId: view.sessionId,
                contextKey: view.contextKey,
                provider: view.modelProvider,
                model: view.model,
                effort: view.reasoningEffort,
                permissionMode: mode,
              },
            })],
          },
        ],
      })),
      { tag: "hr" },
      taskActionRow([{
        text: "Back",
        value: {
          action: "provider_reasoning_open",
          sessionId: view.sessionId,
          contextKey: view.contextKey,
          provider: view.modelProvider,
          model: view.model,
          permissionMode: view.currentMode,
        },
      }]),
    ];
    return sectionCard("Provider 设置 · 权限", elements);
  }

  renderPromptQueue(view: PromptQueueCardView): Record<string, unknown> {
    const superseded = view.phase === "superseded";
    const elements: Record<string, unknown>[] = view.prompts.length === 0
      ? [markdown("队列为空")]
      : view.prompts.map((prompt, index) => ({
          tag: "column_set",
          flex_mode: "stretch",
          horizontal_spacing: "8px",
          vertical_align: "center",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              vertical_align: "center",
              elements: [markdown(
                escapeCardHtml(
                  `${index + 1}. ${truncateText(prompt.text.replace(/\s+/g, " ").trim(), 180)}`,
                ),
              )],
            },
            {
              tag: "column",
              width: "auto",
              vertical_align: "center",
              elements: superseded ? [] : [{
                tag: "button",
                text: { tag: "plain_text", content: "Cancel" },
                type: "default",
                size: "tiny",
                behaviors: [{
                  type: "callback",
                  value: {
                    action: "queued_prompt_cancel",
                    promptId: prompt.id,
                    sessionId: view.sessionId,
                    contextKey: view.contextKey,
                  },
                }],
              }],
            },
          ],
        }));
    if (superseded) {
      elements.push({ tag: "hr" }, markdown("此卡片已由新的排队卡片替代。"));
    }
    return {
      schema: "2.0",
      config: {
        update_multi: true,
        width_mode: "fill",
      },
      header: {
        template: "grey",
        title: {
          tag: "plain_text",
          content: superseded ? "排队 Prompt · 已停止" : `排队 Prompt · ${view.prompts.length}`,
        },
        padding: "8px 12px 8px 12px",
      },
      body: {
        direction: "vertical",
        vertical_spacing: "4px",
        padding: "8px 12px 8px 12px",
        elements,
      },
    };
  }

  renderSafeRestartStatus(view: SafeRestartStatusView): Record<string, unknown> {
    const countdown = view.phase === "countdown"
      ? `${Math.max(0, Math.ceil((view.remainingMs ?? 0) / 1_000))}s`
      : view.phase === "restarting"
        ? "0s"
        : view.phase === "cancelled"
          ? "已取消"
          : view.phase === "superseded"
            ? "已停止"
        : "等待阻塞项清空后开始";
    const status = view.phase === "waiting_tasks"
      ? "🟠 等待任务完成"
      : view.phase === "waiting_delivery"
        ? "🟠 等待最终结果投递"
        : view.phase === "countdown"
          ? "🟡 空闲确认中"
          : view.phase === "restarting"
            ? "🔄 正在重启"
            : view.phase === "cancelled"
              ? "⚪ 已取消"
              : "⚪ 已停止";
    const lines = [
      `**状态**：${status}`,
      `**重启原因**：${inlineCode(view.reason)}`,
      `**重启倒计时**：${countdown}`,
      `**待投递结果**：${view.pendingFinalDeliveries} 条`,
    ];
    const elements: Record<string, unknown>[] = [markdown(lines.join("\n"))];
    if (view.waitingTasks.length > 0) {
      const visible = view.waitingTasks.slice(0, 10);
      const taskLines = visible.map((task, index) =>
        `${index + 1}. ${task.title ? `${inlineCode(truncateText(task.title, 80))} · ` : ""}${inlineCode(task.id)}`);
      if (view.waitingTasks.length > visible.length) {
        taskLines.push(`… 还有 ${view.waitingTasks.length - visible.length} 个任务`);
      }
      elements.push({ tag: "hr" }, markdown(`**当前等待的任务（${view.waitingTasks.length}）**\n${taskLines.join("\n")}`));
    } else {
      elements.push({ tag: "hr" }, markdown("**当前等待的任务**：无"));
    }
    if (view.phase !== "restarting" && view.phase !== "cancelled" && view.phase !== "superseded") {
      elements.push(
        { tag: "hr" },
        taskActionRow([{
          text: "Cancel",
          value: {
            action: "safe_restart_cancel",
            scheduleId: String(view.scheduleId),
          },
        }]),
      );
    }
    const template = view.phase === "restarting"
      ? "blue"
      : view.phase === "cancelled" || view.phase === "superseded"
        ? "grey"
        : "orange";
    return sectionCard("Agent Bot 安全重启", elements, template);
  }

  renderStartupStatus(view: StartupStatusView): Record<string, unknown> {
    const workspaceLine = view.workspaceKind === "projectless"
      ? "**任务范围**：未指定项目"
      : `**工作目录**：${inlineCode(view.cwd)}`;
    const lines = view.currentTask
      ? [
        `**当前任务**：${inlineCode(view.currentTask.title ?? view.currentTask.id)}`,
        workspaceLine,
        `**Provider / 模型 / 思考强度 / 权限**：${inlineCode(view.currentTask.modelProvider ?? "Agent 默认")} / ${inlineCode(view.currentTask.model ?? "默认")} / ${inlineCode(view.currentTask.reasoningEffort ?? "自动")} / ${inlineCode(permissionModeLabel(view.currentTask.permissionMode))}`,
        `**任务状态 / Agent**：${persistedTaskStatus(view.currentTask.sessionStatus, view.currentTask.lastTurnStatus)} / ${inlineCode(view.currentTask.agentName)}`,
        `**任务 ID**：${inlineCode(view.currentTask.id)}`,
      ]
      : [
        "**当前任务**：无，下一条普通消息会创建新任务",
        workspaceLine,
        `**Provider / 模型 / 思考强度 / 权限**：${inlineCode("Agent 默认")} / ${inlineCode("默认")} / ${inlineCode("自动")} / ${inlineCode(permissionModeLabel())}`,
        `**默认 Agent**：${view.defaultAgentTitle} (${inlineCode(view.defaultAgentName)})`,
      ];
    lines.push(
      `**Agent Bot 版本**：${inlineCode(view.agentBotVersion)}`,
      `**服务状态 / 启动时间**：🟢 在线 / ${formatStartupTime(view.startedAt)}`,
      `**重启原因**：${inlineCode(view.restartReason)}`,
      "> 发送消息即可开始对话；发送 `/new` 创建新任务；发送 `/help` 查看帮助。",
    );
    return sectionCard("Agent Bot 已启动", [markdown(lines.join("\n"))], "green");
  }

  renderInitializationWelcome(view: InitializationWelcomeView): Record<string, unknown> {
    const title = view.kind === "first"
      ? "欢迎使用 Agent Bot"
      : view.kind === "upgrade"
        ? "Agent Bot 已更新"
        : "Agent Bot 已准备就绪";
    const subtitle = view.activationPending
      ? "配置已完成，安全重启后生效"
      : view.kind === "first"
      ? "本地 Agent 已接入飞书"
      : view.kind === "upgrade"
        ? `新版本 ${view.version} 已生效`
        : "初始化配置已刷新";
    const activationNote = view.activationPending
      ? "当前任务完成并安全重启后生效。"
      : undefined;
    const intro = view.kind === "first"
      ? "**初始化完成**\n从现在起，你可以直接在飞书里把任务交给本机 Agent，并随时查看进度、切换任务或创建分支。"
      : view.kind === "upgrade"
        ? `**升级完成**\n${view.previousVersion ? `${inlineCode(view.previousVersion)} → ` : ""}${inlineCode(view.version)} 已准备好。${activationNote ?? "下面是本版值得关注的能力。"}`
        : `**配置刷新完成**\n${inlineCode(view.version)} 已重新检查配置、Agent 和飞书连接。${activationNote ?? ""}`;
    const logo = {
      ...localCardImage(view.logoPath, "Agent Bot logo"),
      preview: false,
    };
    const featureColumns = view.features.slice(0, 4).map((feature) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      vertical_align: "top",
      elements: [markdown([
        `${feature.icon} **${feature.title}**`,
        `<font color='grey'>${feature.description}</font>`,
      ].join("\n"))],
    }));
    const featureRows = [0, 2].flatMap((start) => {
      const columns = featureColumns.slice(start, start + 2);
      return columns.length > 0
        ? [{
            tag: "column_set",
            flex_mode: "none",
            horizontal_spacing: "16px",
            vertical_align: "top",
            columns,
          }]
        : [];
    });
    const availableAgents = view.availableAgents.length > 0
      ? view.availableAgents.map((agent) => inlineCode(agent)).join(" · ")
      : inlineCode(view.defaultAgentName);
    return {
      schema: "2.0",
      config: {
        update_multi: true,
      },
      header: {
        template: view.kind === "first" ? "turquoise" : view.kind === "upgrade" ? "blue" : "green",
        title: { tag: "plain_text", content: title },
        subtitle: { tag: "plain_text", content: subtitle },
        padding: "12px 12px 12px 12px",
      },
      body: {
        direction: "vertical",
        vertical_spacing: "12px",
        padding: "12px 12px 12px 12px",
        elements: [
          {
            tag: "column_set",
            flex_mode: "none",
            horizontal_spacing: "16px",
            vertical_align: "center",
            columns: [
              {
                tag: "column",
                width: "weighted",
                weight: 1,
                vertical_align: "center",
                elements: [logo],
              },
              {
                tag: "column",
                width: "weighted",
                weight: 3,
                vertical_align: "center",
                elements: [markdown(intro)],
              },
            ],
          },
          { tag: "hr" },
          markdown(`**${view.kind === "upgrade" ? "本版亮点" : "你可以这样使用"}**`),
          ...featureRows,
          { tag: "hr" },
          markdown("> 直接发送消息即可开始；发送 `/new` 创建新任务；发送 `/help` 查看全部命令。"),
          {
            ...markdown(`**版本** ${inlineCode(view.version)}　·　**默认 Agent** ${inlineCode(view.defaultAgentTitle)}　·　**可用 Agent** ${availableAgents}`),
            text_size: "notation",
          },
          {
            ...markdown("📋 [查看更新日志](https://github.com/keyou/agent-bot/blob/master/CHANGELOG.md)"),
            text_size: "notation",
          },
        ],
      },
    };
  }

  renderTurn(state: TurnViewState): Record<string, unknown> {
    const elements = this.thinkingCardLayout === "timeline"
      ? renderTurnElements(state, "hidden")
      : renderGroupedTurnElements(state, "hidden");
    const footerActions: TaskListCardAction[] = [];
    if (isTurnStoppable(state.status)) {
      footerActions.push({
        text: "Stop",
        type: "danger",
        value: { action: "turn_cancel", sessionId: state.sessionId, turnId: state.turnId },
      });
      elements.push(
        { tag: "hr" },
        taskActionRow(footerActions, renderTurnDuration(state)),
      );
    } else if (state.status === "completed") {
      footerActions.push({
        text: "Reset",
        value: { action: "turn_reset", sessionId: state.sessionId, turnId: state.turnId },
      });
      elements.push(
        { tag: "hr" },
        taskActionRow(footerActions),
      );
    } else if (state.status === "starting") {
      elements.push(
        { tag: "hr" },
        taskActionRow([], renderTurnDuration(state)),
      );
    }
    if (state.status === "completed") {
      elements.push(
        {
          ...markdown("<font color='grey'>Reset 会将当前任务的对话上下文恢复到本轮完成时；不会回退本地文件。</font>"),
          text_size: "notation",
        },
      );
    }
    return turnCard(
      turnTitle(state.status, state.prompt ?? state.taskTitle),
      turnTemplate(state.status),
      elements,
      renderTurnSubtitle(state),
    );
  }

  renderTurnDetails(state: TurnViewState): Record<string, unknown> {
    const title = state.taskTitle
      ? `任务执行详情：${truncateText(state.taskTitle.replace(/\s+/g, " ").trim(), 60)}`
      : "任务执行详情";
    return turnCard(title, "blue", renderTurnElements(state, "always"), renderTurnSubtitle(state));
  }

  renderActivityHistory(state: TurnViewState, requestedPage: number): Record<string, unknown> {
    const grouped = this.thinkingCardLayout === "grouped";
    const activities = turnActivities(state);
    const allGroups = grouped ? groupTurnActivities(activities).flatMap(splitGroupedExecutionActivity) : [];
    const historyGroups = grouped
      ? groupedLiveActivityPage(groupedActivityPagesFromGroups(allGroups, state.projectCwd), state.projectCwd).historyGroups
      : [];
    const usesHistoricalPrefixPages = historyGroups.length > 0;
    const pages = grouped
      ? groupedActivityPagesFromGroups(
        usesHistoricalPrefixPages ? historyGroups : allGroups,
        state.projectCwd,
        {
          fullActivityText: true,
        },
      )
      : activityPages(activities);
    if (pages.length === 0) {
      return this.renderSectionsCard("思考活动历史", [{ lines: ["没有保存到活动记录。"] }]);
    }
    const totalPages = usesHistoricalPrefixPages ? pages.length + 1 : pages.length;
    const page = Math.max(0, Math.min(Math.trunc(requestedPage), pages.length - 1));
    const actions: TaskListCardAction[] = [
      ...(usesHistoricalPrefixPages || pages.length > 1 ? [{
        text: "最新页",
        value: { action: "activity_history", turnId: state.turnId, page: "latest" },
      }] : []),
      ...(page > 0 ? [{
        text: "上一页",
        value: { action: "activity_history", turnId: state.turnId, page: String(page - 1) },
      }] : []),
      ...(page < pages.length - (usesHistoricalPrefixPages ? 1 : 2) ? [{
        text: "下一页",
        value: { action: "activity_history", turnId: state.turnId, page: String(page + 1) },
      }] : []),
    ];
    const elements: Record<string, unknown>[] = [];
    if (actions.length > 0) elements.push(taskActionRow(actions), { tag: "hr" });
    elements.push(...(grouped
      ? renderGroupedActivityGroups(pages[page] as GroupedTurnActivity[] | undefined ?? [], state.projectCwd, {
        fullActivityText: true,
      })
      : renderActivities(pages[page] as TurnActivity[] | undefined ?? [], state.projectCwd, true)));
    return sectionCard(`思考活动历史 · ${page + 1}/${totalPages}`, elements.length > 0 ? elements : [markdown("无")]);
  }

  renderSessionStarted(session: RuntimeSession): Record<string, unknown> {
    return this.baseCard("ACP 会话已创建", "green", [
      markdown(`**Agent**: ${session.agentName}\n**Session**: ${session.localSessionId}\n**CWD**: ${session.cwd}`),
    ]);
  }

  renderSessionUpdate(session: RuntimeSession, update: Record<string, JsonValue>): Record<string, unknown> {
    const updateType = String(update.sessionUpdate ?? "update");
    return this.baseCard(`ACP 更新：${updateType}`, "blue", [
      markdown(`**Agent**: ${session.agentName}\n**Session**: ${session.localSessionId}`),
      markdown(truncateText(formatUpdate(update), 6000)),
    ]);
  }

  renderPermissionRequest(
    session: RuntimeSession,
    permissionId: string,
    toolTitle: string,
    options: Array<{ optionId: string; name: string; kind: string }>,
  ): Record<string, unknown> {
    return this.baseCard("需要确认", "orange", [
      markdown(`**Session**: ${session.localSessionId}\n**Tool**: ${toolTitle}`),
      {
        tag: "action",
        actions: options.map((option) => ({
          tag: "button",
          text: {
            tag: "plain_text",
            content: acpPermissionOptionLabel(option),
          },
          type: option.kind.startsWith("allow") ? "primary" : "default",
          value: {
            action: "permission",
            permissionId,
            optionId: option.optionId,
          },
        })),
      },
    ]);
  }

  renderStatus(status: string): Record<string, unknown> {
    return this.baseCard("Agent Bot 状态", "blue", [markdown(status)]);
  }

  renderDismissGroupConfirmation(view: DismissGroupCardView): Record<string, unknown> {
    const actionValue = {
      contextKey: view.contextKey,
      sessionId: view.sessionId,
      requestedBy: view.requestedBy,
    };
    const button = (
      content: string,
      type: "default" | "danger",
      action: "group_dismiss_confirm" | "group_dismiss_keep",
    ): Record<string, unknown> => ({
      tag: "button",
      width: "fill",
      text: { tag: "plain_text", content },
      type,
      behaviors: [{
        type: "callback",
        value: { action, ...actionValue },
      }],
    });
    return compactCard("解散当前群聊", "blue", [
      markdown([
        "确定要解散当前群聊吗？",
        `当前任务「${escapeCardHtml(view.taskTitle)}」将同时归档。此操作无法撤销。`,
      ].join("\n")),
      {
        tag: "column_set",
        flex_mode: "none",
        horizontal_spacing: "8px",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [button("Dismiss", "danger", "group_dismiss_confirm")],
          },
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [button("Keep", "default", "group_dismiss_keep")],
          },
        ],
      },
    ]);
  }

  renderDismissGroupKept(): Record<string, unknown> {
    return compactCard("已保留当前群聊", "grey", [markdown("已取消解散群聊。")]);
  }

  renderSectionsCard(
    title: string,
    sections: CardSection[],
    actions: TaskListCardAction[] = [],
  ): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [];
    sections.forEach((section, index) => {
      if (index > 0) elements.push({ tag: "hr" });
      const content = section.lines.join("\n");
      if (section.collapsible && section.title) {
        elements.push(collapsiblePanel(section.title, content, { elementId: section.elementId }));
      } else {
        const heading = section.title ? `**${section.title}**\n` : "";
        elements.push(markdown(`${heading}${content}`));
      }
    });
    if (actions.length > 0) elements.push({ tag: "hr" }, taskActionRow(actions));
    return sectionCard(title, elements);
  }

  renderHelpCard(
    title: string,
    introLines: string[],
    sections: HelpCardSection[],
  ): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [markdown(introLines.join("\n"))];
    for (const section of sections) {
      elements.push({ tag: "hr" }, markdown(`**${section.title}**`));
      elements.push(...section.commands.map(helpCommandRow));
    }
    return sectionCard(title, elements);
  }

  renderTaskListCard(
    title: string,
    sectionTitle: string,
    entries: TaskListCardEntry[],
    footerLines: string[],
    footerActions: TaskListCardAction[] = [],
  ): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [markdown(`**${sectionTitle}**`)];
    if (entries.length === 0) {
      elements.push(markdown("无"));
    } else {
      entries.forEach((entry, index) => {
        elements.push(markdown(entry.lines.join("\n")));
        if (entry.actions?.length) {
          elements.push(taskActionRow(entry.actions));
        }
        if (index < entries.length - 1) elements.push({ tag: "hr" });
      });
    }
    if (footerActions.length > 0) {
      elements.push({ tag: "hr" }, taskActionRow(footerActions));
    }
    if (footerLines.length > 0) {
      elements.push({ tag: "hr" }, markdown(footerLines.join("\n")));
    }
    return {
      schema: "2.0",
      config: {
        update_multi: true,
        width_mode: "fill",
      },
      header: {
        template: "blue",
        title: {
          tag: "plain_text",
          content: title,
        },
      },
      body: {
        elements,
      },
    };
  }

  renderSessionTaskListCard(
    title: string,
    sectionTitle: string,
    groups: SessionTaskCardGroup[],
    footerLines: string[],
    footerActions: TaskListCardAction[] = [],
  ): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [markdown(`**${sectionTitle}**`)];
    if (groups.length === 0) {
      elements.push(markdown("无"));
    } else {
      groups.forEach((group) => {
        elements.push(sessionProjectRow(group));
        elements.push(...group.entries.map(sessionTaskPanel));
      });
    }
    if (footerActions.length > 0) {
      elements.push(taskActionRow(footerActions));
    }
    if (footerLines.length > 0) {
      elements.push(markdown(footerLines.join("\n")));
    }
    return {
      schema: "2.0",
      config: {
        update_multi: true,
        width_mode: "fill",
      },
      header: {
        template: "blue",
        title: {
          tag: "plain_text",
          content: title,
        },
      },
      body: {
        vertical_spacing: "4px",
        elements,
      },
    };
  }

  renderDirectoryBrowserCard(view: DirectoryBrowserCardView): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [
      markdown(`**当前目录**：${inlineCode(view.directory)}`),
      taskActionRow(view.currentActions, undefined, true),
      { tag: "hr" },
    ];
    const entryRows = view.entries.length === 0
      ? [directoryBrowserEmptyRow()]
      : view.entries.slice(0, DIRECTORY_BROWSER_ROW_COUNT).map(directoryBrowserEntryRow);
    while (entryRows.length < DIRECTORY_BROWSER_ROW_COUNT) entryRows.push(directoryBrowserPlaceholderRow());
    elements.push(...entryRows);
    if (view.navigationActions.length > 0) {
      elements.push({ tag: "hr" }, taskActionRow(view.navigationActions));
    }
    if (view.footerLines.length > 0) {
      elements.push({ tag: "hr" }, markdown(view.footerLines.join("\n")));
    }
    return sectionCard("文件浏览", elements, "blue", "2px");
  }

  renderDirectoryNewFolderCard(view: DirectoryNewFolderCardView): Record<string, unknown> {
    const actionValue = {
      action: "directory_new_folder_submit",
      directory: view.directory,
      contextKey: view.contextKey,
      page: String(view.page),
    };
    return compactCard("新建目录", "blue", [
      markdown(`将在当前目录下创建一个子目录：\n${inlineCode(view.displayDirectory ?? view.directory)}`),
      {
        tag: "form",
        name: "directory_new_folder_form",
        vertical_spacing: "8px",
        elements: [
          {
            tag: "input",
            element_id: "folder_name_input",
            name: "folderName",
            required: true,
            input_type: "text",
            width: "fill",
            max_length: 255,
            label: { tag: "plain_text", content: "目录名" },
            placeholder: { tag: "plain_text", content: "请输入目录名" },
          },
          {
            tag: "button",
            name: "directory_new_folder_create",
            text: { tag: "plain_text", content: "Create" },
            type: "primary",
            width: "fill",
            action_type: "form_submit",
            value: actionValue,
          },
        ],
      },
      taskActionRow([{
        text: "Back",
        value: {
          action: "directory_new_folder_cancel",
          directory: view.directory,
          contextKey: view.contextKey,
          page: String(view.page),
        },
      }]),
    ]);
  }

  renderResetHistoryCard(view: ResetHistoryCardView): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [
      {
        ...markdown("<font color='grey'>Reset 会将当前任务的对话上下文恢复到所选轮次完成时；不会回退本地文件。</font>"),
        text_size: "notation",
      },
      { tag: "hr" },
    ];
    if (view.entries.length === 0) {
      elements.push(markdown("当前任务还没有成功完成的 turn。"));
    } else {
      const sequenceWidth = `${Math.max(16, ...view.entries.map((entry) => String(entry.sequence).length * 10))}px`;
      view.entries.forEach((entry) => {
        elements.push(resetHistoryEntryRow(entry, sequenceWidth));
      });
    }
    if (view.footerLines.length > 0) {
      elements.push({ tag: "hr" }, {
        ...markdown(view.footerLines.join("\n")),
        text_size: "notation",
      });
    }
    if (view.pageActions.length > 0) elements.push(taskActionRow(view.pageActions));
    return sectionCard("历史对话轮次", elements);
  }

  private baseCard(title: string, template: string, elements: unknown[]): Record<string, unknown> {
    return {
      config: {
        wide_screen_mode: true,
        update_multi: true,
      },
      header: {
        template,
        title: {
          tag: "plain_text",
          content: title,
        },
      },
      elements,
    };
  }
}

function renderTurnSubtitle(state: TurnViewState): string {
  const activityTools = turnActivities(state).filter((activity) => activity.kind === "tool").length;
  const totalTools = state.totalToolCount ?? activityTools;
  return [
    `耗时 ${renderTurnDuration(state)}`,
    state.totalTokens !== undefined ? `${formatTokenCount(state.totalTokens)} tokens` : undefined,
    totalTools > 0 ? `${totalTools} 个工具` : undefined,
    state.fileSummary.length > 0 ? `${state.fileSummary.length} 个文件` : undefined,
  ].filter(Boolean).join(" · ");
}

function renderTurnDuration(state: TurnViewState): string {
  const endedAt = state.completedAt ?? Date.now();
  return formatTurnDuration(state.durationMs ?? Math.max(0, endedAt - state.startedAt));
}

function isTurnStoppable(status: TurnViewStatus): boolean {
  return status === "running" || status === "tool_running" || status === "waiting_for_approval";
}

function renderTurnElements(
  state: TurnViewState,
  assistantTextMode: "hidden" | "always",
): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  const allActivities = turnActivities(state);
  const pages = activityPages(allActivities);
  const visibleActivities = pages.at(-1) ?? [];
  if (state.plan.length > 0) elements.push(planPanel(state.plan));
  if (pages.length > 1) {
    elements.push(taskActionRow([{
      text: `查看历史思考（共 ${pages.length} 页）`,
      value: {
        action: "activity_history",
        turnId: state.turnId,
        page: String(pages.length - 2),
      },
    }]));
  }
  if (state.activitiesTruncated || pages.length > 1) elements.push(markdown("…"));
  elements.push(...renderActivities(visibleActivities, state.projectCwd));
  if (state.fileSummary.length > 0) elements.push(fileSummaryPanel(state));

  if (state.approval) {
    const request = state.approval;
    elements.push(markdown([
      `**${request.title}**`,
      request.command ? codeBlock(request.command, 800) : undefined,
      request.reason,
    ].filter(Boolean).join("\n")));
    elements.push({
      tag: "column_set",
      flex_mode: "flow",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      columns: request.options.map((option) => ({
        tag: "column",
        width: "auto",
        elements: [{
          tag: "button",
          text: { tag: "plain_text", content: approvalDecisionLabel(option.id) },
          type: option.id === "accept" || option.id === "acceptForSession" ? "primary" : option.id === "cancel" ? "danger" : "default",
          behaviors: [{
            type: "callback",
            value: {
              action: "approval",
              sessionId: state.sessionId,
              turnId: state.turnId,
              requestId: request.id,
              decision: option.id,
            },
          }],
        }],
      })),
    });
  }
  if (state.error) elements.push(markdown(codeBlock(state.error, 2_000)));
  const showAssistantText = state.assistantText && assistantTextMode === "always";
  if (showAssistantText) {
    if (elements.length > 0) elements.push({ tag: "hr" });
    const heading = state.status === "completed" ? "回答" : "回答生成中";
    elements.push(markdown(`**${heading}**\n${truncateText(state.assistantText, 3_000)}`));
  }
  if (elements.length === 0) elements.push(markdown(emptyTurnText(state.status, state.agentLabel)));
  return elements;
}

function renderGroupedTurnElements(
  state: TurnViewState,
  assistantTextMode: "hidden" | "always",
): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  const allActivities = turnActivities(state);
  const livePages = groupedActivityPages(allActivities, state.projectCwd);
  const visible = groupedLiveActivityPage(livePages, state.projectCwd);
  const historyPages = groupedActivityPagesFromGroups(visible.historyGroups, state.projectCwd, {
    fullActivityText: true,
  });
  if (state.plan.length > 0) elements.push(planPanel(state.plan));
  if (historyPages.length > 0) {
    elements.push(taskActionRow([{
      text: `查看历史思考（共 ${historyPages.length + 1} 页）`,
      value: {
        action: "activity_history",
        turnId: state.turnId,
        page: String(historyPages.length - 1),
      },
    }]));
  }
  if (state.activitiesTruncated && visible.groups[0]?.kind !== "gap") elements.push(markdown("…"));
  elements.push(...renderGroupedActivityGroups(visible.groups, state.projectCwd));
  if (state.fileSummary.length > 0) elements.push(fileSummaryPanel(state));

  if (state.approval) {
    const request = state.approval;
    elements.push(markdown([
      `**${request.title}**`,
      request.command ? codeBlock(request.command, 800) : undefined,
      request.reason,
    ].filter(Boolean).join("\n")));
    elements.push({
      tag: "column_set",
      flex_mode: "flow",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      columns: request.options.map((option) => ({
        tag: "column",
        width: "auto",
        elements: [{
          tag: "button",
          text: { tag: "plain_text", content: approvalDecisionLabel(option.id) },
          type: option.id === "accept" || option.id === "acceptForSession" ? "primary" : option.id === "cancel" ? "danger" : "default",
          behaviors: [{
            type: "callback",
            value: {
              action: "approval",
              sessionId: state.sessionId,
              turnId: state.turnId,
              requestId: request.id,
              decision: option.id,
            },
          }],
        }],
      })),
    });
  }
  if (state.error) elements.push(markdown(codeBlock(state.error, 2_000)));
  const showAssistantText = state.assistantText && assistantTextMode === "always";
  if (showAssistantText) {
    if (elements.length > 0) elements.push({ tag: "hr" });
    const heading = state.status === "completed" ? "回答" : "回答生成中";
    elements.push(markdown(`**${heading}**\n${truncateText(state.assistantText, 3_000)}`));
  }
  if (elements.length === 0) elements.push(markdown(emptyTurnText(state.status, state.agentLabel)));
  return elements;
}

function emptyTurnText(status: TurnViewStatus, agentLabel?: string): string {
  const label = agentLabel?.trim().replace(/[\r\n]+/g, " ") || "Agent";
  if (status === "starting") return `正在连接 ${label}…`;
  if (status === "completed") return "本轮已完成。";
  if (status === "cancelled") return "本轮已停止。";
  return `正在等待 ${label} 返回进度…`;
}

function planPanel(plan: TurnViewState["plan"]): Record<string, unknown> {
  const completed = plan.filter((step) => step.status === "completed").length;
  return collapsiblePanel(`计划 · ${completed}/${plan.length}`, plan.map(renderPlanStep).join("\n"), {
    expanded: true,
    borderColor: "blue",
  });
}

function fileSummaryPanel(state: TurnViewState): Record<string, unknown> {
  return collapsiblePanel(
    `文件变更 · ${state.fileSummary.length}`,
    state.fileSummary
      .map((file) => `- ${escapeMarkdownFilePath(displayFilePath(file.path, state.projectCwd))}  +${file.additions ?? 0} -${file.deletions ?? 0}`)
      .join("\n"),
    { elementId: "turn_files" },
  );
}

function renderPlanStep(step: TurnViewState["plan"][number]): string {
  const marker = step.status === "completed" ? "✅" : step.status === "in_progress" ? "🔄" : "○";
  return `${marker} ${step.text}`;
}

function renderActivity(
  activity: TurnActivity,
  projectCwd?: string,
  fullAssistantText = false,
): Record<string, unknown>[] {
  if (activity.kind === "user") {
    const text = activity.text.trim();
    if (!text) return [];
    const chunks = fullAssistantText
      ? splitText(text, ACTIVITY_TEXT_CHUNK)
      : [truncateText(text, MAX_LIVE_ASSISTANT_TEXT)];
    return chunks.map((chunk, index) => markdown(boldUserActivity(chunk, index === 0)));
  }
  if (activity.kind === "assistant" || (activity.kind === "reasoning" && activity.id.startsWith("commentary:"))) {
    const text = activity.text.trim();
    if (!text) return [];
    return fullAssistantText
      ? splitText(text, ACTIVITY_TEXT_CHUNK).map(markdown)
      : [markdown(truncateText(text, MAX_LIVE_ASSISTANT_TEXT))];
  }
  if (activity.kind === "reasoning") {
    return renderReasoningGroup([activity]);
  }
  return [toolPanel(activity.tool, projectCwd)];
}

function boldUserActivity(text: string, showIcon: boolean): string {
  return text
    .split("\n")
    .map((line, index) => {
      const content = showIcon && index === 0 ? `🙋 ${line}` : line;
      return content ? `**${content}**` : "";
    })
    .join("\n");
}

function renderActivities(
  activities: TurnActivity[],
  projectCwd?: string,
  fullAssistantText = false,
): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  let reasoningGroup: Array<Extract<TurnActivity, { kind: "reasoning" }>> = [];
  const flushReasoning = (): void => {
    if (reasoningGroup.length === 0) return;
    elements.push(...renderReasoningGroup(reasoningGroup));
    reasoningGroup = [];
  };

  for (const activity of activities) {
    if (isRawReasoning(activity)) {
      reasoningGroup.push(activity);
      continue;
    }
    flushReasoning();
    elements.push(...renderActivity(activity, projectCwd, fullAssistantText));
  }
  flushReasoning();
  return elements;
}

type GroupedTurnActivity =
  | { kind: "activity"; activity: TurnActivity }
  | { kind: "gap"; id: string }
  | {
      kind: "execution";
      id: string;
      latestReasoning?: Extract<TurnActivity, { kind: "reasoning" }>;
      tools: ToolState[];
    };

function renderGroupedActivityGroups(
  groups: GroupedTurnActivity[],
  projectCwd?: string,
  options: {
    fullActivityText?: boolean;
  } = {},
): Record<string, unknown>[] {
  return groups.flatMap((group) => {
    if (group.kind === "gap") return [markdown("…")];
    if (group.kind === "activity") {
      return renderActivity(group.activity, projectCwd, options.fullActivityText === true);
    }
    if (group.tools.length === 0) {
      const reasonings = group.latestReasoning ? [group.latestReasoning] : [];
      return renderReasoningGroup(reasonings);
    }
    return [executionActivityPanel(group, projectCwd)];
  });
}

function groupTurnActivities(activities: TurnActivity[]): GroupedTurnActivity[] {
  const groups: GroupedTurnActivity[] = [];
  let segment: TurnActivity[] = [];
  const flushSegment = (): void => {
    if (segment.length === 0) return;
    let execution: Extract<GroupedTurnActivity, { kind: "execution" }> | undefined;
    let executionPosition = -1;
    for (let index = 0; index < segment.length; index += 1) {
      const activity = segment[index]!;
      if (isRawReasoning(activity)) {
        execution ??= { kind: "execution", id: activity.id, tools: [] };
        execution.latestReasoning = activity;
        executionPosition = index;
      } else if (activity.kind === "tool") {
        execution ??= { kind: "execution", id: activity.id, tools: [] };
        execution.tools.push(activity.tool);
        executionPosition = index;
      }
    }
    for (let index = 0; index < segment.length; index += 1) {
      const activity = segment[index]!;
      if (index === executionPosition && execution) groups.push(execution);
      if (!isRawReasoning(activity) && activity.kind !== "tool") {
        groups.push({ kind: "activity", activity });
      }
    }
    segment = [];
  };

  for (const activity of activities) {
    if (!isCommentaryActivity(activity)) {
      segment.push(activity);
      continue;
    }
    flushSegment();
    groups.push({ kind: "activity", activity });
  }
  flushSegment();
  return groups;
}

function isCommentaryActivity(activity: TurnActivity): boolean {
  return activity.kind === "assistant"
    || (activity.kind === "reasoning" && activity.id.startsWith("commentary:"));
}

function executionActivityPanel(
  group: Extract<GroupedTurnActivity, { kind: "execution" }>,
  projectCwd: string | undefined,
): Record<string, unknown> {
  const status = executionActivityStatus(group.tools);
  const elements = group.tools.map((tool) => toolPanel(tool, projectCwd));
  return collapsiblePanel(
    executionActivityTitle(group, status),
    elements,
    {
      elementId: executionActivityPanelElementId(group.id),
      expanded: false,
      borderColor: status === "running" ? "blue" : "grey",
      compact: true,
    },
  );
}

function executionActivityStatus(tools: ToolState[]): ToolState["status"] {
  if (tools.some((tool) => tool.status === "running")) return "running";
  return "completed";
}

function executionActivityTitle(
  group: Extract<GroupedTurnActivity, { kind: "execution" }>,
  status: ToolState["status"],
): string {
  const icon = status === "running" ? "⏳" : "💭";
  const latestReasoning = group.latestReasoning?.text
    ? removeMarkdownBold(group.latestReasoning.text).replace(/\s+/g, " ").trim()
    : "";
  const summary = latestReasoning
    ? truncateText(latestReasoning, 90)
    : status === "running"
      ? "正在执行工具"
      : "已执行工具";
  return `${icon} ${summary} · ${group.tools.length} 个工具`;
}

function executionActivityPanelElementId(activityId: string): string {
  const digest = createHash("sha256").update(activityId).digest("hex").slice(0, 10);
  return `turn_exec_${digest}`;
}

function renderReasoningGroup(
  activities: Array<Extract<TurnActivity, { kind: "reasoning" }>>,
): Record<string, unknown>[] {
  const sections = activities
    .map((activity) => activity.text.trim())
    .filter(Boolean)
    .map((text) => removeMarkdownBold(truncateText(text, 2_000)));
  if (sections.length === 0) return [];
  const quotedReasoning = sections
    .map((text) => `💭 ${text.replaceAll("\n", "\n> ")}`)
    .join("\n> ");
  return [markdown(`> ${quotedReasoning}`)];
}

function isRawReasoning(
  activity: TurnActivity,
): activity is Extract<TurnActivity, { kind: "reasoning" }> {
  return activity.kind === "reasoning" && !activity.id.startsWith("commentary:");
}

const ACTIVITIES_PER_PAGE = 40;
const GROUPED_TOOLS_PER_PANEL = 8;
const GROUPED_PAGE_ACTIVITY_BYTES = 24 * 1024;
const GROUPED_PAGE_ACTIVITY_COMPONENTS = 160;
const PINNED_LIVE_COMMENTARIES = 3;
const MAX_LIVE_ASSISTANT_TEXT = 2_000;
const ACTIVITY_TEXT_CHUNK = 2_500;

function activityPages(activities: TurnActivity[]): TurnActivity[][] {
  if (activities.length === 0) return [];
  if (activities.length <= ACTIVITIES_PER_PAGE) return [activities];
  const pages: TurnActivity[][] = [];
  const firstPageSize = activities.length % ACTIVITIES_PER_PAGE || ACTIVITIES_PER_PAGE;
  pages.push(activities.slice(0, firstPageSize));
  for (let index = firstPageSize; index < activities.length; index += ACTIVITIES_PER_PAGE) {
    pages.push(activities.slice(index, index + ACTIVITIES_PER_PAGE));
  }
  return pages;
}

function groupedActivityPages(
  activities: TurnActivity[],
  projectCwd?: string,
  renderOptions: {
    fullActivityText?: boolean;
  } = {},
): GroupedTurnActivity[][] {
  const groups = groupTurnActivities(activities).flatMap(splitGroupedExecutionActivity);
  return groupedActivityPagesFromGroups(groups, projectCwd, renderOptions);
}

function groupedActivityPagesFromGroups(
  groups: GroupedTurnActivity[],
  projectCwd?: string,
  renderOptions: {
    fullActivityText?: boolean;
  } = {},
): GroupedTurnActivity[][] {
  if (groups.length === 0) return [];

  const newestFirst: GroupedTurnActivity[][] = [];
  let page: GroupedTurnActivity[] = [];
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    const candidate = [group, ...page];
    if (page.length > 0 && !groupedActivityPageFits(candidate, projectCwd, renderOptions)) {
      newestFirst.push(page);
      page = [];
    }
    page.unshift(group);
  }
  if (page.length > 0) newestFirst.push(page);
  return newestFirst.reverse();
}

function groupedActivityPageFits(
  groups: GroupedTurnActivity[],
  projectCwd: string | undefined,
  renderOptions: {
    fullActivityText?: boolean;
  },
): boolean {
  const elements = renderGroupedActivityGroups(groups, projectCwd, renderOptions);
  return Buffer.byteLength(JSON.stringify(elements), "utf8") <= GROUPED_PAGE_ACTIVITY_BYTES
    && countCardComponents(elements) <= GROUPED_PAGE_ACTIVITY_COMPONENTS;
}

interface LiveGroupedActivityPage {
  groups: GroupedTurnActivity[];
  historyGroups: GroupedTurnActivity[];
}

function groupedLiveActivityPage(
  pages: GroupedTurnActivity[][],
  projectCwd?: string,
): LiveGroupedActivityPage {
  const latest = pages.at(-1) ?? [];
  if (pages.length <= 1) return { groups: latest, historyGroups: [] };

  const groups = pages.flat();
  const latestStart = groups.length - latest.length;
  const commentaryIndexes = groups
    .map((group, index) => isCommentaryGroup(group) ? index : -1)
    .filter((index) => index >= 0);
  const renderCutoff = (cutoff: number): LiveGroupedActivityPage => {
    const selected = new Set<number>(commentaryIndexes
      .filter((index) => index < cutoff)
      .slice(-PINNED_LIVE_COMMENTARIES));
    for (let index = cutoff; index < groups.length; index += 1) selected.add(index);
    return {
      groups: groupsWithGaps(groups, selected),
      historyGroups: groups.slice(0, cutoff),
    };
  };

  const executionCutoffs = groups
    .map((group, index) => group.kind === "execution" && group.tools.length > 0 ? index : -1)
    .filter((index) => index > 0);
  for (const cutoff of executionCutoffs) {
    const view = renderCutoff(cutoff);
    if (groupedActivityPageFits(view.groups, projectCwd, {})) return view;
  }

  if (executionCutoffs.length > 0) return renderCutoff(executionCutoffs.at(-1)!);
  return { groups: latest, historyGroups: groups.slice(0, latestStart) };
}

function isCommentaryGroup(group: GroupedTurnActivity): boolean {
  return group.kind === "activity" && isCommentaryActivity(group.activity);
}

function groupsWithGaps(
  groups: GroupedTurnActivity[],
  selected: ReadonlySet<number>,
): GroupedTurnActivity[] {
  const indexes = [...selected].sort((left, right) => left - right);
  const visible: GroupedTurnActivity[] = [];
  const append = (group: GroupedTurnActivity): void => {
    if (group.kind === "gap" && visible.at(-1)?.kind === "gap") return;
    visible.push(group);
  };
  let previous = -1;
  for (const index of indexes) {
    if (previous >= 0 && index > previous + 1) {
      append({ kind: "gap", id: `gap:${previous}:${index}` });
    }
    const group = groups[index];
    if (group) append(group);
    previous = index;
  }
  return visible;
}

function countCardComponents(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, entry) => total + countCardComponents(entry), 0);
  }
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  return (typeof record.tag === "string" ? 1 : 0)
    + Object.values(record).reduce<number>((total, entry) => total + countCardComponents(entry), 0);
}

function splitGroupedExecutionActivity(group: GroupedTurnActivity): GroupedTurnActivity[] {
  if (group.kind !== "execution" || group.tools.length <= GROUPED_TOOLS_PER_PANEL) return [group];
  const chunks: Array<Extract<GroupedTurnActivity, { kind: "execution" }>> = [];
  for (let index = 0; index < group.tools.length; index += GROUPED_TOOLS_PER_PANEL) {
    const tools = group.tools.slice(index, index + GROUPED_TOOLS_PER_PANEL);
    const isLast = index + GROUPED_TOOLS_PER_PANEL >= group.tools.length;
    chunks.push({
      kind: "execution",
      id: index === 0 ? group.id : tools[0]?.id ?? `${group.id}:${index}`,
      ...(isLast && group.latestReasoning ? { latestReasoning: group.latestReasoning } : {}),
      tools,
    });
  }
  return chunks;
}

function splitText(value: string, maxLength: number): string[] {
  if (!value) return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += maxLength) {
    chunks.push(value.slice(offset, offset + maxLength));
  }
  return chunks;
}

function removeMarkdownBold(value: string): string {
  return value
    .replace(/\*\*([\s\S]+?)\*\*/g, "$1")
    .replace(/__([\s\S]+?)__/g, "$1");
}

function turnActivities(state: TurnViewState): TurnActivity[] {
  if (state.activities?.length) return state.activities;

  const activities: TurnActivity[] = [];
  if (state.progressText) {
    activities.push({ kind: "reasoning", id: "legacy-progress", text: state.progressText });
  }
  const tools = [state.activeTool, ...state.failedTools, ...state.completedTools].filter(
    (tool): tool is ToolState => tool !== undefined,
  );
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.id)) continue;
    seen.add(tool.id);
    activities.push({ kind: "tool", id: tool.id, tool });
  }
  return activities;
}

function toolPanel(tool: ToolState, projectCwd?: string): Record<string, unknown> {
  const elements = [markdown(renderToolDetails(tool, projectCwd))];
  if ((tool.kind === "image_view" || tool.kind === "image_generation") && tool.imagePath) {
    elements.push(localCardImage(tool.imagePath, tool.kind === "image_generation" ? "生成图片" : "view_image 图片"));
  }
  return collapsiblePanel(toolPanelTitle(tool), elements, { elementId: toolPanelElementId(tool.id) });
}

function toolPanelElementId(toolId: string): string {
  const digest = createHash("sha256").update(toolId).digest("hex").slice(0, 16);
  return `turn_tool_${digest}`;
}

function collapsiblePanel(
  title: string,
  content: string | Record<string, unknown>[],
  options: {
    expanded?: boolean;
    borderColor?: string;
    elementId?: string;
    compact?: boolean;
  } = {},
): Record<string, unknown> {
  const compact = options.compact === true;
  return {
    tag: "collapsible_panel",
    ...(options.elementId ? { element_id: options.elementId } : {}),
    direction: "vertical",
    vertical_spacing: compact ? "2px" : "4px",
    padding: compact ? "4px 6px" : "8px",
    margin: "0px",
    expanded: options.expanded ?? false,
    header: {
      title: { tag: "plain_text", content: title },
      vertical_align: "center",
      padding: compact ? "2px 4px 2px 4px" : "4px 8px 4px 8px",
    },
    border: {
      color: options.borderColor ?? "grey",
      corner_radius: "5px",
    },
    elements: typeof content === "string" ? [markdown(content)] : content,
  };
}

function sessionTaskPanel(entry: SessionTaskCardEntry): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [markdown(entry.detailLines.join("\n"))];
  if (entry.actions?.length) elements.push(sessionActionOverflow(entry.actions));
  return collapsiblePanel(entry.summary, elements, {
    elementId: sessionTaskPanelElementId(entry.reference),
    borderColor: entry.current ? "green" : "grey",
    compact: true,
  });
}

function sessionProjectRow(group: SessionTaskCardGroup): Record<string, unknown> {
  const actions = group.actions ?? [];
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    vertical_align: "center",
    margin: "6px 0px 0px 0px",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "center",
        elements: [markdown(`**${escapeCardActionText(group.title)}**`)],
      },
      ...(actions.length > 0 ? [{
        tag: "column",
        width: "auto",
        vertical_align: "center",
        elements: [sessionActionOverflow(actions)],
      }] : []),
    ],
  };
}

function sessionTaskPanelElementId(reference: string): string {
  return `session_task_${createHash("sha256").update(reference).digest("hex").slice(0, 16)}`;
}

function sessionActionOverflow(actions: TaskListCardAction[]): Record<string, unknown> {
  return {
    tag: "overflow",
    options: actions.map((action) => ({
      text: { tag: "plain_text", content: action.text },
      value: JSON.stringify(action.value),
    })),
  };
}

function sessionActionButton(action: TaskListCardAction): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: action.text },
    type: action.type === "danger" ? "danger" : "default",
    size: "tiny",
    behaviors: [{
      type: "callback",
      value: action.value,
    }],
  };
}

function renderToolDetails(tool: ToolState, projectCwd?: string): string {
  const command = tool.command ?? tool.title;
  const fileSummary = tool.files?.length
    ? tool.files
      .map((file) => `${displayFilePath(file.path, projectCwd)}  +${file.additions ?? 0} -${file.deletions ?? 0}`)
      .join("\n")
    : undefined;
  const result = tool.error ?? tool.output ?? fileSummary;
  const normalizedCommand = stripAnsi(command).trim();
  const displayCommand = tool.kind === "command"
    ? unwrapShellCommand(normalizedCommand) ?? normalizedCommand
    : normalizedCommand;
  const commandText = truncateText(
    tool.kind === "command" ? formatShellCommandForDisplay(displayCommand) : displayCommand,
    600,
  );
  const resultText = result ? truncateToolResult(normalizeTerminalOutput(result).trim()) : undefined;
  return codeBlock([`$ ${commandText}`, resultText].filter((part): part is string => part !== undefined).join("\n"), 2_003);
}

function formatShellCommandForDisplay(command: string): string {
  const normalized = command.replace(/\r\n/g, "\n");
  let result = "";
  let quote: "'" | "\"" | undefined;

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index] ?? "";

    if (quote) {
      result += character;
      if ((character === "\\" || character === "`") && quote === "\"") {
        if (index + 1 < normalized.length) result += normalized[++index];
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      result += character;
      continue;
    }

    if (character === "\\" || character === "`" || character === "^") {
      result += character;
      if (index + 1 < normalized.length) result += normalized[++index];
      continue;
    }

    const operator = readShellDisplayOperator(normalized, index);
    if (!operator) {
      result += character;
      continue;
    }

    result += operator;
    index += operator.length - 1;
    while (index + 1 < normalized.length && /\s/.test(normalized[index + 1] ?? "")) index += 1;
    if (index + 1 < normalized.length) result += " \\\n  ";
  }

  return result;
}

function readShellDisplayOperator(command: string, index: number): string | undefined {
  for (const operator of ["&&", "||", "|&", ";", "|"]) {
    if (command.startsWith(operator, index)) return operator;
  }
  return undefined;
}

function normalizeTerminalOutput(value: string): string {
  const clean = stripAnsi(value).replace(/\r\n/g, "\n");
  return clean
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const updates = line.split("\r");
      for (let index = updates.length - 1; index >= 0; index -= 1) {
        const update = updates[index];
        if (update) return update;
      }
      return "";
    })
    .join("\n");
}

function truncateToolResult(result: string): string {
  const maxLength = 900;
  const marker = "\n...\n";
  const tailLength = 600;
  if (result.length <= maxLength) return result;
  const headLength = maxLength - marker.length - tailLength;
  return `${result.slice(0, headLength)}${marker}${result.slice(-tailLength)}`;
}

function displayFilePath(filePath: string, projectCwd?: string): string {
  if (!projectCwd) return filePath;
  const pathApi = usesWindowsPaths(projectCwd, filePath) ? path.win32 : path;
  const normalizedCwd = pathApi.resolve(projectCwd);
  const absolutePath = pathApi.isAbsolute(filePath)
    ? pathApi.normalize(filePath)
    : pathApi.resolve(normalizedCwd, filePath);
  const relativePath = pathApi.relative(normalizedCwd, absolutePath);
  const isInsideProject = relativePath === ""
    || (!pathApi.isAbsolute(relativePath)
      && relativePath !== ".."
      && !relativePath.startsWith(`..${pathApi.sep}`));
  return isInsideProject ? relativePath || "." : absolutePath;
}

function escapeMarkdownFilePath(filePath: string): string {
  return filePath.replaceAll("\\.", "\\\\.");
}

function usesWindowsPaths(...values: string[]): boolean {
  return values.some((value) => /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value));
}

function toolPanelTitle(tool: ToolState): string {
  const icon = tool.status === "failed" ? "❌" : tool.status === "running" ? "⏳" : "✅";
  const command = stripAnsi(tool.command ?? tool.title).trim();
  const meaningfulCommand = tool.kind === "web_search"
    ? tool.title
    : unwrapShellCommand(command) ?? tool.title;
  const duration = toolDuration(tool);
  const prefix = `${icon} `;
  const suffix = duration ? ` · ${duration}` : "";
  const title = truncateText(
    meaningfulCommand.replace(/\s+/g, " ").trim(),
    Math.max(20, 100 - prefix.length - suffix.length),
  );
  return `${prefix}${title}${suffix}`;
}

function toolDuration(tool: ToolState): string | undefined {
  if (tool.startedAt === undefined) return undefined;
  const endedAt = tool.status === "running" ? Date.now() : tool.completedAt;
  if (endedAt === undefined) return undefined;
  return formatCompactDuration(endedAt - tool.startedAt);
}

function formatCompactDuration(durationMs: number): string {
  const totalTenths = Math.max(0, Math.round(durationMs / 100));
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const secondsText = `${String(seconds).padStart(2, "0")}.${tenths}s`;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${secondsText}`;
  }
  if (totalMinutes > 0) return `${String(totalMinutes).padStart(2, "0")}:${secondsText}`;
  return `${seconds}.${tenths}s`;
}

function formatTurnDuration(durationMs: number): string {
  const normalized = Math.max(0, durationMs);
  if (Math.round(normalized / 100) < 100) return formatCompactDuration(normalized);
  const totalSeconds = Math.round(normalized / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  if (totalMinutes > 0) return `${String(totalMinutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${seconds}s`;
}

function shellCommandStatus(view: ShellCommandCardView): {
  title: string;
  label: string;
  template: string;
} {
  if (view.status === "running") {
    return { title: "正在执行命令", label: "运行中", template: "blue" };
  }
  if (view.status === "cancelling") {
    return { title: "正在取消命令", label: "正在取消", template: "orange" };
  }
  if (view.status === "cancelled") {
    return { title: "命令已取消", label: "已取消", template: "grey" };
  }
  if (view.status === "timed_out") {
    return { title: "命令执行超时", label: "已超时（120s）", template: "orange" };
  }
  if (view.status === "completed") {
    return { title: "命令执行完成", label: `退出码 ${view.exitCode ?? 0}`, template: "green" };
  }
  return { title: "命令执行失败", label: `退出码 ${view.exitCode ?? "未知"}`, template: "red" };
}

function unwrapShellCommand(command: string): string | undefined {
  return unwrapPowerShellCommand(command) ?? unwrapPosixShellCommand(command);
}

function unwrapPowerShellCommand(command: string): string | undefined {
  const executable = command.match(
    /^(?:"[^"]*(?:pwsh|powershell)\.exe"|(?:\S*[\\/])?(?:pwsh|powershell)(?:\.exe)?)(?=\s|$)/i,
  );
  if (!executable) return undefined;
  const args = command.slice(executable[0].length);
  const commandFlag = /(?:^|\s)-(?:Command|c)(?:\s+|$)/i.exec(args);
  if (!commandFlag) return undefined;
  const payload = args.slice(commandFlag.index + commandFlag[0].length).trim();
  if (!payload) return undefined;
  return unwrapShellPayload(payload);
}

function unwrapPosixShellCommand(command: string): string | undefined {
  let executable = readCommandWord(command, 0);
  if (!executable) return undefined;

  if (posixExecutableName(executable.value) === "env") {
    let cursor = executable.end;
    while (true) {
      const candidate = readCommandWord(command, cursor);
      if (!candidate) return undefined;
      const name = posixExecutableName(candidate.value);
      if (isPosixShell(name)) {
        executable = candidate;
        break;
      }
      if (!candidate.value.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(candidate.value)) {
        return undefined;
      }
      cursor = candidate.end;
    }
  } else if (!isPosixShell(posixExecutableName(executable.value))) {
    return undefined;
  }

  const args = command.slice(executable.end);
  const commandFlag = /(?:^|\s)(?:-[A-Za-z]*c[A-Za-z]*|--command)(?:\s+|=)/.exec(args);
  if (!commandFlag) return undefined;
  const payload = args.slice(commandFlag.index + commandFlag[0].length).trim();
  if (!payload) return undefined;
  return unwrapShellPayload(payload);
}

function readCommandWord(command: string, start: number): { value: string; end: number } | undefined {
  let cursor = start;
  while (cursor < command.length && /\s/.test(command[cursor] ?? "")) cursor += 1;
  if (cursor >= command.length) return undefined;

  const quote = command[cursor];
  if (quote === "\"" || quote === "'") {
    const endQuote = command.indexOf(quote, cursor + 1);
    if (endQuote < 0) return undefined;
    return { value: command.slice(cursor + 1, endQuote), end: endQuote + 1 };
  }

  const word = /^\S+/.exec(command.slice(cursor));
  if (!word) return undefined;
  return { value: word[0], end: cursor + word[0].length };
}

function posixExecutableName(executable: string): string {
  return executable.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
}

function isPosixShell(executable: string): boolean {
  return executable === "sh"
    || executable === "bash"
    || executable === "zsh"
    || executable === "dash"
    || executable === "ksh"
    || executable === "fish";
}

function unwrapShellPayload(payload: string): string | undefined {
  if (payload[0] !== "\"" && payload[0] !== "'") return payload;
  const decoded = decodeQuotedShellWord(payload)?.trim();
  return decoded || undefined;
}

function decodeQuotedShellWord(value: string): string | undefined {
  let result = "";
  let quote: "'" | "\"" | undefined;
  let sawQuote = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";

    if (quote === "'") {
      if (character === "'") quote = undefined;
      else result += character;
      continue;
    }

    if (quote === "\"") {
      if (character === "\"") {
        quote = undefined;
        continue;
      }
      if (character === "\\") {
        const next = value[index + 1];
        if (next === "\n") {
          index += 1;
          continue;
        }
        if (next === "$" || next === "`" || next === "\"" || next === "\\") {
          result += next;
          index += 1;
          continue;
        }
      }
      result += character;
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      sawQuote = true;
      continue;
    }
    if (/\s/.test(character)) return undefined;
    if (character === "\\") {
      const next = value[index + 1];
      if (next === undefined) return undefined;
      result += next;
      index += 1;
      continue;
    }
    result += character;
  }

  return sawQuote && quote === undefined ? result : undefined;
}

function codeBlock(value: string, maxLength: number): string {
  const clean = stripAnsi(value).trim();
  return `\`\`\`\n${truncateText(clean, maxLength).replaceAll("```", "''' ")}\n\`\`\``;
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\|$)/g, "")
    .replace(/\u001B[P^_X][\s\S]*?(?:\u001B\\|$)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F-\u009F]/g, "");
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

function formatStartupTime(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}/${pad(value.getMonth() + 1)}/${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

function permissionModeLabel(mode?: PermissionMode): string {
  return mode === "confirm" ? "执行前确认" : "自动执行";
}

function persistedTaskStatus(sessionStatus: string, lastTurnStatus?: string): string {
  if (sessionStatus === "running" || lastTurnStatus === "running") {
    return "上次运行中，可在下一条消息时恢复";
  }
  const labels: Record<string, string> = {
    starting: "上次正在启动",
    ready: "就绪",
    completed: "上次已完成",
    cancelled: "上次已停止",
    closed: "已关闭",
    failed: "上次失败",
  };
  return labels[lastTurnStatus ?? sessionStatus] ?? lastTurnStatus ?? sessionStatus;
}

function turnTitle(status: TurnViewStatus, prompt?: string): string {
  const reactionEmoji = status === "completed"
    ? "✅"
    : status === "failed"
      ? "❌"
      : status === "cancelled"
        ? "⏹️"
        : status === "waiting_for_approval"
          ? "🙋"
          : "⏳";
  const currentStatus = status === "completed"
    ? "已完成"
    : status === "failed"
      ? "执行失败"
      : status === "cancelled"
        ? "已停止"
        : status === "waiting_for_approval"
          ? "等待确认"
          : "正在处理";
  const compactPrompt = truncateTurnPrompt(prompt);
  const title = compactPrompt ? `${currentStatus}：${compactPrompt}` : currentStatus;
  return `${reactionEmoji} ${title}`;
}

function truncateTurnPrompt(prompt?: string): string {
  const characters = Array.from(prompt?.replace(/\s+/g, " ").trim() ?? "");
  if (characters.length <= 40) return characters.join("");
  return `${characters.slice(0, 37).join("")}...`;
}

function turnTemplate(status: TurnViewStatus): string {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "cancelled") return "grey";
  if (status === "waiting_for_approval") return "orange";
  return "blue";
}

function formatTokenCount(tokens: number): string {
  const rounded = Math.max(0, Math.round(tokens));
  if (rounded < 10_000) {
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(rounded);
  }
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    compactDisplay: "short",
    maximumSignificantDigits: 3,
  }).format(rounded);
}

function markdown(content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
  };
}

function escapeCardHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function approvalDecisionLabel(decision: ApprovalDecision): string {
  const labels: Record<ApprovalDecision, string> = {
    accept: "Allow Once",
    acceptForSession: "Allow for Session",
    decline: "Deny",
    cancel: "Cancel Task",
  };
  return labels[decision];
}

function acpPermissionOptionLabel(option: { name: string; kind: string }): string {
  const labels: Record<string, string> = {
    allow_once: "Allow Once",
    allow_always: "Always Allow",
    reject_once: "Deny Once",
    reject_always: "Always Deny",
  };
  return labels[option.kind] ?? (/^[\x20-\x7E]+$/.test(option.name) ? option.name : "Select");
}

function settingsTabRow(
  activeTab: ExecutionSettingsTab,
  baseAction: Record<string, string>,
  showAgentTab: boolean,
  showRuntimeTabs: boolean,
): Record<string, unknown> | undefined {
  const tabs: Array<{ id: ExecutionSettingsTab; label: string }> = [
    ...(showAgentTab ? [{ id: "agent" as const, label: "Agent" }] : []),
    ...(showRuntimeTabs
      ? [
          { id: "provider" as const, label: "Provider" },
          { id: "model" as const, label: "Model" },
          { id: "thinking" as const, label: "Thinking" },
          { id: "permission" as const, label: "Permission" },
        ]
      : []),
  ];
  if (tabs.length === 0) return undefined;
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "2px",
    margin: "8px 0 0 0",
    columns: tabs.flatMap((tab, index) => [
      ...(index > 0
        ? [{
            tag: "column",
            width: "auto",
            vertical_align: "center",
            elements: [{ ...markdown("·"), text_align: "center", text_size: "notation" }],
          }]
        : []),
      {
        tag: "column",
        width: "auto",
        vertical_align: "center",
        elements: [settingsTabElement(tab.label, tab.id === activeTab, {
          action: "settings_tab_open",
          ...baseAction,
          tab: tab.id,
        })],
      },
    ]),
  };
}

function settingsTabElement(
  label: string,
  active: boolean,
  value: Record<string, string>,
): Record<string, unknown> {
  if (active) {
    return {
      ...markdown(escapeCardHtml(label)),
      text_align: "center",
      text_size: "notation",
    };
  }
  const action = taskActionElement({ text: label, value });
  return {
    ...action,
    padding: "6px 0px",
    elements: (action.elements as Array<Record<string, unknown>>).map((element) => ({
      ...element,
      text_align: "center",
      text_size: "notation",
    })),
  };
}

function settingsOptionRow(input: {
  label: string;
  current: boolean;
  action: TaskListCardAction;
}): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    vertical_align: "center",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "center",
        elements: [markdown(input.label)],
      },
      {
        tag: "column",
        width: "auto",
        vertical_align: "center",
        elements: input.current ? [markdown("✅ 当前")] : [taskActionElement(input.action)],
      },
    ],
  };
}

function resetHistoryEntryRow(
  entry: ResetHistoryCardEntry,
  sequenceWidth: string,
): Record<string, unknown> {
  const { graphNodeLine, graphConnectorLine, lines, timestamp, current, running, resetting } = entry;
  const action = entry.actions?.[0];
  const branchConnectorLine = graphConnectorLine && /[╱╲]/u.test(graphConnectorLine)
    ? graphConnectorLine
    : undefined;
  const color = current ? "green" : running || resetting ? "orange" : "blue";
  const nodeLanes = graphNodeLine.match(/[●│]/gu) ?? [];
  const connectorLanes = branchConnectorLine?.split(" ");
  // Each lane has its own center; shorter connectors and wider turn numbers cannot shift it.
  const graphColumns = nodeLanes.map((node, lane) => ({
    tag: "column",
    width: "16px",
    vertical_align: "top",
    padding: "0px",
    elements: [{
      ...markdown([
        `<font color='${color}'>${node}</font>`,
        ...(connectorLanes?.[lane] ? [`<font color='grey'>${escapeCardHtml(connectorLanes[lane])}</font>`] : []),
      ].join("\n")),
      text_align: "center",
    }],
  }));
  const trailingElements = current
    ? [markdown("✅ 当前")]
    : resetting
      ? [markdown("⏳ 正在 Reset")]
      : running
        ? [markdown("⏳ 运行中")]
        : action
          ? [taskActionElement(action)]
          : [];
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "12px",
    vertical_align: "top",
    columns: [
      {
        tag: "column",
        width: "auto",
        vertical_align: "top",
        elements: [{
          tag: "column_set",
          flex_mode: "none",
          horizontal_spacing: "0px",
          horizontal_align: "left",
          columns: [
            ...graphColumns,
            {
              tag: "column",
              width: sequenceWidth,
              vertical_align: "top",
              padding: "0px",
              elements: [{ ...markdown(`<font color='${color}'>${entry.sequence}</font>`), text_align: "left" }],
            },
          ],
        }],
      },
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "top",
        elements: [
          markdown([
            lines[0] ?? "",
            ...(timestamp ? [`<font color='grey'>${escapeCardHtml(timestamp)}</font>`] : []),
          ].join(" ")),
          ...lines.slice(1).map((line) => ({
            ...markdown(`<font color='grey'>${line}</font>`),
            text_size: "notation",
          })),
        ],
      },
      ...(trailingElements.length > 0 ? [{
        tag: "column",
        width: "auto",
        vertical_align: "top",
        elements: trailingElements,
      }] : []),
    ],
  };
}

function taskActionRow(
  actions: TaskListCardAction[],
  trailingText?: string,
  dotSeparated = false,
): Record<string, unknown> {
  const columns = actions.flatMap((action, index) => [
    ...(dotSeparated && index > 0 ? [{
      tag: "column",
      width: "auto",
      vertical_align: "center",
      elements: [markdown("<font color='grey'>·</font>")],
    }] : []),
    {
      tag: "column",
      width: "auto",
      vertical_align: "center",
      elements: [taskActionElement(action)],
    },
  ]);
  if (trailingText) {
    columns.push({
      tag: "column",
      width: "auto",
      vertical_align: "center",
      elements: [markdown(
        `<font color='grey'>${actions.length > 0 ? "· " : ""}${escapeCardHtml(trailingText)}</font>`,
      )],
    });
  }
  return {
    tag: "column_set",
    flex_mode: "flow",
    horizontal_spacing: "8px",
    margin: "2px 0 0 0",
    columns,
  };
}

function directoryBrowserEntryRow(entry: DirectoryBrowserCardEntry): Record<string, unknown> {
  const label = `${directoryBrowserEntryIcon(entry.kind)} ${entry.name}`;
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "12px",
    vertical_align: "center",
    margin: "0px",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "center",
        elements: entry.openAction
          ? [taskActionElement({ ...entry.openAction, text: label })]
          : [markdown(escapeCardHtml(label))],
      },
    ],
  };
}

function directoryBrowserEmptyRow(): Record<string, unknown> {
  return directoryBrowserStaticRow("这个目录为空。");
}

function directoryBrowserPlaceholderRow(): Record<string, unknown> {
  return directoryBrowserStaticRow("\u00a0");
}

function directoryBrowserStaticRow(content: string): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "12px",
    vertical_align: "center",
    margin: "0px",
    columns: [{
      tag: "column",
      width: "weighted",
      weight: 1,
      vertical_align: "center",
      elements: [markdown(content)],
    }],
  };
}

function directoryBrowserEntryIcon(kind: DirectoryBrowserCardEntry["kind"]): string {
  switch (kind) {
    case "directory": return "📁";
    case "drive": return "💽";
    case "image": return "🖼️";
    case "binary": return "📦";
    case "file": return "📄";
  }
}

function taskActionElement(action: TaskListCardAction): Record<string, unknown> {
  return {
    tag: "interactive_container",
    margin: "0px",
    padding: "0px",
    has_border: false,
    elements: [markdown(
      `<font color='${action.type === "danger" ? "red" : "blue"}'>${escapeCardActionText(action.text)}</font>`,
    )],
    behaviors: [{
      type: "callback",
      value: action.value,
    }],
  };
}

function escapeCardActionText(value: string): string {
  return escapeCardHtml(value).replaceAll("\\", "&#92;");
}

function helpCommandRow(command: HelpCardCommand): Record<string, unknown> {
  const details = [
    command.usage ? `**${command.usage}**` : undefined,
    command.description,
  ].filter((line): line is string => Boolean(line)).join("　");
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "12px",
    vertical_align: "top",
    margin: "2px 0 0 0",
    columns: [
      {
        tag: "column",
        width: "auto",
        vertical_align: "top",
        elements: [
          command.action
            ? taskActionElement(command.action)
            : markdown(`**${escapeCardHtml(command.text)}**`),
        ],
      },
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "top",
        elements: [markdown(details)],
      },
    ],
  };
}

function turnCard(
  title: string,
  template: string,
  elements: Record<string, unknown>[],
  subtitle: string,
): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "fill",
    },
    header: {
      template,
      title: {
        tag: "plain_text",
        content: title,
      },
      ...(subtitle ? {
        subtitle: {
          tag: "plain_text",
          content: subtitle,
        },
      } : {}),
      padding: "12px 12px 12px 12px",
    },
    body: {
      direction: "vertical",
      vertical_spacing: "8px",
      padding: "12px 12px 12px 12px",
      elements,
    },
  };
}

function sectionCard(
  title: string,
  elements: Record<string, unknown>[],
  template = "blue",
  verticalSpacing = "8px",
): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "fill",
    },
    header: {
      template,
      title: {
        tag: "plain_text",
        content: title,
      },
      padding: "12px 12px 12px 12px",
    },
    body: {
      direction: "vertical",
      vertical_spacing: verticalSpacing,
      padding: "12px 12px 12px 12px",
      elements,
    },
  };
}

function compactCard(
  title: string,
  template: string,
  elements: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "compact",
    },
    header: {
      template,
      title: {
        tag: "plain_text",
        content: title,
      },
      padding: "12px 12px 12px 12px",
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      padding: "12px 12px 12px 12px",
      elements,
    },
  };
}

function formatUpdate(update: Record<string, JsonValue>): string {
  const updateType = update.sessionUpdate;
  if (updateType === "agent_message_chunk" && isObject(update.content)) {
    const content = update.content;
    if (content.type === "text" && typeof content.text === "string") {
      return content.text;
    }
  }

  if (updateType === "tool_call" || updateType === "tool_call_update") {
    return [
      update.title ? `**${String(update.title)}**` : undefined,
      update.status ? `状态：${String(update.status)}` : undefined,
      update.kind ? `类型：${String(update.kind)}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return `\`\`\`json\n${JSON.stringify(update, null, 2)}\n\`\`\``;
}

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
