#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, loadConfigWithoutEnvironmentMutation } from "./config/loadConfig.js";
import { sendControlRequest, isServerReachable } from "./cli/LocalControlClient.js";
import {
  controlEndpoint,
  type ControlResponse,
  type TaskAgentControlData,
  type TaskDirectoryControlData,
  type TaskDismissControlData,
  type TaskForkControlData,
  type TaskGoalControlData,
  type TaskGroupControlData,
  type TaskMuteControlData,
  type TaskReleaseControlData,
  type TaskSettingsControlData,
  type TaskShellControlData,
  type TaskStatusControlData,
  type TaskTurnsControlData,
} from "./cli/controlProtocol.js";
import {
  acquireInitializationLock,
  cleanupFeishuCredentialTemporaryFiles,
  initializeAgentBot,
  readConfiguredAgentSelection,
  readFeishuCredentials,
  readGroupMessageResponseMode,
  shouldCreateFeishuApp,
  shouldConfigureAgentsDuringInitialization,
  shouldConfigureGroupMessagesDuringInitialization,
  writeConfiguredAgentSelection,
  writeFeishuCredentials,
  writeGroupMessageResponseMode,
  type GroupMessageResponseMode,
  type InitializationResult,
  type InitializationStatus,
} from "./cli/Initializer.js";
import { parseInitCommandOptions, type InitCommandOptions } from "./cli/initOptions.js";
import {
  listenForManualPermissionSkip,
  listenForOptionalAuthorizationSkip,
  type OptionalAuthorizationSkipListener,
} from "./cli/OptionalAuthorizationSkip.js";
import {
  registerFeishuApp,
  type FeishuAppCredentials,
  type FeishuAppRegistrationChallenge,
} from "./cli/FeishuAppRegistration.js";
import {
  ensureFeishuAppConfiguration,
  ensureFeishuGroupMessagePermission,
  type EnsureFeishuAppConfigurationResult,
  type FeishuConfigurationChallenge,
} from "./cli/FeishuAppConfiguration.js";
import {
  feishuAffectedFeatures,
  formatFeishuConfigurationFeatureIntroduction,
} from "./cli/FeishuConfigurationFeatures.js";
import { renderCliHelp } from "./cli/help.js";
import { cliLanguage, cliText, localizeCliErrorMessage } from "./cli/i18n.js";
import {
  inspectSupportedAgent,
  inspectSupportedAgents,
  runSupportedAgentMaintenance,
  selectAgentMaintenanceActions,
  type SupportedAgentInspection,
} from "./cli/AgentPrerequisites.js";
import {
  selectableDefaultAgents,
} from "./cli/DefaultAgentSelection.js";
import {
  InitializationPromptCancelledError,
  InitUi,
  shouldUseInteractiveInitialization,
} from "./cli/InitUi.js";
import { formatServerStatus, withConfiguredFeishuAppId } from "./cli/serverStatus.js";
import { resolveSystemSkillsRoot, SkillRegistry, type SkillRegistrationStatus } from "./cli/SkillRegistry.js";
import { readPackageVersion } from "./cli/packageVersion.js";
import {
  readInitializationReceipt,
  resolveInitializationWelcomeKind,
  sendInitializationWelcome,
  writeInitializationReceipt,
  type InitializationWelcomeResult,
} from "./cli/InitializationWelcome.js";
import { applyExplicitProfile, parseGlobalOptions } from "./cli/profile.js";
import { printVerificationLink } from "./cli/VerificationOutput.js";
import {
  startInitializedServer,
  startServer,
  type InitializationServerResult,
  type ServerStartResult,
} from "./cli/ServerStarter.js";
import { taskChatRoute } from "./cli/taskChatRoute.js";
import {
  currentAppServerThreadIds,
  formatTaskList,
  taskStateLabel,
} from "./cli/taskListOutput.js";
import {
  resolveCurrentTaskFromEnvironment,
  resolveRestartNotificationTask,
  resolveTask,
  resolveTaskCommandTarget,
} from "./cli/taskTarget.js";
import { isThreadContextKey } from "./feishu/contextKey.js";
import { refreshedSystemEnvironment } from "./supervision/systemEnvironment.js";
import {
  parseTaskForkGroupOptions,
  parseTaskNewOptions,
  parseTaskNewGroupOptions,
} from "./cli/taskGroupOptions.js";
import { StateStore, type SessionRecord } from "./state/StateStore.js";
import {
  nodeDiagnosticReportArguments,
  prepareCrashReportDirectory,
  resolveSupervisorDiagnosticsPaths,
} from "./supervision/SupervisorDiagnostics.js";
import { agentBotHome, defaultSqlitePath } from "./config/paths.js";
import {
  finalizeSelfUpdatePlan,
  launchSelfUpdateRunner,
  parseSelfUpdateOptions,
  prepareSelfUpdate,
  releaseSelfUpdatePlan,
  requireNpmSelfUpdateInstallation,
} from "./cli/SelfUpdater.js";
import { createCurrentAutostartManager } from "./cli/AutostartManager.js";
import {
  formatAutostartStatus,
  type AutostartServerStatus,
  type CombinedAutostartStatus,
} from "./cli/autostartOutput.js";

const args = process.argv.slice(2);

void main(args).catch((error: unknown) => {
  if (error instanceof InitializationPromptCancelledError) {
    process.exitCode = 130;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${cliText("Error: ", "错误：")}${localizeCliErrorMessage(message)}\n`);
  process.exitCode = 1;
});

async function main(input: string[]): Promise<void> {
  const parsed = parseGlobalOptions(input);
  if (parsed.profilePath) applyExplicitProfile(parsed.profilePath);
  else if (parsed.configPath) process.env.AGENT_BOT_CONFIG = parsed.configPath;
  const [command, ...rest] = parsed.args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${readPackageVersion()}\n`);
    return;
  }
  if (command === "init") {
    await initCommand(rest, parsed.configPath);
    return;
  }
  if (command === "update") {
    await updateCommand(rest);
    return;
  }
  if (command === "console") {
    await consoleCommand(rest);
    return;
  }
  if (command === "server") {
    await serverCommand(rest);
    return;
  }
  if (command === "task" || command === "tasks") {
    await taskCommand(rest);
    return;
  }
  if (command === "skill" || command === "skills") {
    skillsCommand(rest);
    return;
  }
  throw new Error(cliText(
    `Unknown command: ${command}. Run agentbot --help for usage.`,
    `未知命令：${command}。运行 agentbot --help 查看用法。`,
  ));
}

async function updateCommand(input: string[]): Promise<void> {
  const options = parseSelfUpdateOptions(input);
  requireNpmSelfUpdateInstallation();
  const config = loadConfig();
  const endpoint = controlEndpoint(config.storage.sqlitePath);
  const serverRunning = await isServerReachable(endpoint);
  if (!options.json) process.stdout.write(cliText(
    "Checking the installed Agent Bot package and npm release channel...\n",
    "正在检查已安装的 Agent Bot 包和 npm 发布通道……\n",
  ));
  const prepared = await prepareSelfUpdate({
    channel: options.channel,
    version: options.version,
    allowDowngrade: options.allowDowngrade,
  });
  if (prepared.status === "current") {
    if (options.json) printJson(prepared);
    else process.stdout.write(cliText(
      `Agent Bot ${prepared.currentVersion} is already current on the ${prepared.channel} channel.\n`,
      `Agent Bot ${prepared.currentVersion} 已是 ${prepared.channel} 通道的当前版本。\n`,
    ));
    return;
  }

  const reason = cliText(
    `Update Agent Bot from ${prepared.currentVersion} to ${prepared.targetVersion}`,
    `将 Agent Bot 从 ${prepared.currentVersion} 更新到 ${prepared.targetVersion}`,
  );
  try {
    const notificationSessionId = serverRunning
      ? resolveRestartNotificationSessionId(
          config.storage.sqlitePath,
          options.taskReference ? ["--task", options.taskReference] : [],
        )
      : undefined;
    finalizeSelfUpdatePlan(prepared.planPath, {
      controlEndpoint: endpoint,
      databasePath: config.storage.sqlitePath,
      restartService: serverRunning,
      workingDirectory: process.cwd(),
      reason,
      notificationSessionId,
    });
    if (serverRunning) {
      ensureOk(await sendControlRequest(endpoint, {
        action: "server_update",
        planPath: prepared.planPath,
        reason,
        notificationSessionId,
      }, 15_000));
    } else {
      launchSelfUpdateRunner(prepared.planPath, { waitPids: [process.pid] });
    }
  } catch (error) {
    releaseSelfUpdatePlan(prepared.planPath);
    throw error;
  }

  const result = {
    status: serverRunning ? "scheduled" : "started",
    fromVersion: prepared.currentVersion,
    toVersion: prepared.targetVersion,
    channel: prepared.channel,
    serviceWasRunning: serverRunning,
    logPath: prepared.logPath,
    resultPath: prepared.resultPath,
  };
  if (options.json) printJson(result);
  else {
    process.stdout.write(serverRunning
      ? cliText(
          `Agent Bot ${prepared.targetVersion} is verified and ready. The update will run after active tasks finish and the server becomes idle.\n`,
          `Agent Bot ${prepared.targetVersion} 已通过预检。更新将在活动任务完成且服务空闲后执行。\n`,
        )
      : cliText(
          `Agent Bot ${prepared.targetVersion} is verified. Installation will continue after this command exits.\n`,
          `Agent Bot ${prepared.targetVersion} 已通过预检。本命令退出后将继续安装。\n`,
        ));
    process.stdout.write(`${cliText("Update log: ", "更新日志：")}${prepared.logPath}\n`);
  }
}

type FeishuInitializationStatus = "created" | "existing" | "skipped";

interface InitCommandResult extends InitializationResult {
  agents: InitializedAgent[];
  configuredAgents: string[];
  defaultAgent: {
    name: string;
    status: "selected" | "existing";
  };
  groupMessages: {
    mode: GroupMessageResponseMode;
    status: "selected" | "existing";
  };
  feishu: {
    status: FeishuInitializationStatus;
    appId?: string;
    userOpenIdStatus?: "configured" | "pending";
    configuration?: EnsureFeishuAppConfigurationResult;
  };
  skill: ReturnType<SkillRegistry["install"]>;
  server: InitializationServerResult;
  welcome: InitializationWelcomeResult;
}

interface InitializedAgent extends SupportedAgentInspection {
  configured?: boolean;
  assistance?: {
    status: "completed" | "skipped" | "unavailable" | "failed";
    error?: string;
  };
}

interface FeishuInitializationContext {
  result: InitCommandResult["feishu"];
  credentials?: FeishuAppCredentials;
}

async function initCommand(
  input: string[],
  configPath: string | undefined,
): Promise<void> {
  const options = parseInitCommandOptions(input);
  const version = readPackageVersion();
  const ui = new InitUi({
    interactive: shouldUseInteractiveInitialization(options.json),
  });
  ui.start(cliText(`AgentBot ${version} setup`, `AgentBot ${version} 初始化`));
  const previousInitialization = readInitializationReceipt(agentBotHome());
  let initializationLock = options.reset
    ? acquireInitializationLock(agentBotHome())
    : undefined;
  let paths: InitializationResult;
  let initialized: Omit<InitCommandResult, "server" | "welcome">;
  try {
    if (options.reset) await assertResetProfileServerStopped(configPath);
    paths = initializeAgentBot({ configPath, reset: options.reset });
    if (!options.json) printInitializationPaths(paths, ui);
    const inspectedAgents = await initializeSupportedAgents(options.json, ui);
    const defaultAgent = await configureAgentsAndDefault(
      paths.config.path,
      inspectedAgents,
      options.json,
      shouldConfigureAgentsDuringInitialization(paths.config.status),
      ui,
    );
    const configuredAgents = readConfiguredAgentSelection(paths.config.path).agents.map((agent) => agent.name);
    const configuredAgentNames = new Set(configuredAgents);
    for (const agent of inspectedAgents) {
      if (configuredAgentNames.has(agent.id) && agent.compatibilityIssue) throw new Error(agent.compatibilityIssue);
    }
    const agents = inspectedAgents.map((agent) => ({
      ...agent,
      configured: configuredAgentNames.has(agent.id),
    }));
    initializationLock ??= acquireInitializationLock(paths.home.path);
    cleanupFeishuCredentialTemporaryFiles(paths.env.path);
    const feishuContext = await initializeFeishu(
      paths,
      options,
      ui,
    );
    const groupMessages = await configureGroupMessageResponse(
      paths.config.path,
      options.json,
      shouldConfigureGroupMessagesDuringInitialization(paths.config.status),
      ui,
    );
    const feishu = await completeFeishuGroupMessageSetup(
      feishuContext,
      groupMessages.mode,
      ui,
    );
    ui.step(cliText("Installing the AgentBot Skill", "正在安装 AgentBot Skill"));
    const skill = bundledSkillRegistry().install();
    initialized = { ...paths, agents, configuredAgents, defaultAgent, groupMessages, feishu, skill };
  } finally {
    initializationLock?.release();
  }

  if (!options.json) printInitializationResult(initialized, ui);
  if (!options.json && !options.skipFeishu) {
    if (ui.interactive) ui.step(cliText("Starting AgentBot", "正在启动 AgentBot"));
    else process.stdout.write(cliText("\nStarting Agent Bot server...\n", "\n正在启动 Agent Bot 服务...\n"));
  }
  const server = await startInitializedServer({ skipFeishu: options.skipFeishu, configPath });
  const welcomeKind = resolveInitializationWelcomeKind({
    firstInitialization: paths.config.status === "created",
    previousVersion: previousInitialization?.version,
    currentVersion: version,
  });
  let welcome: InitializationWelcomeResult;
  if (options.skipFeishu) {
    welcome = { status: "skipped", kind: welcomeKind, reason: "feishu-skipped" };
  } else {
    try {
      welcome = await sendInitializationWelcome({
        configPath,
        version,
        previousVersion: previousInitialization?.version,
        kind: welcomeKind,
        activationPending: server.status === "restart-scheduled",
      });
    } catch (error) {
      welcome = {
        status: "failed",
        kind: welcomeKind,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  try {
    writeInitializationReceipt(paths.home.path, version);
  } catch (error) {
    process.stderr.write(`${cliText(
      "Warning: Could not save initialization version metadata: ",
      "警告：无法保存初始化版本信息：",
    )}${error instanceof Error ? error.message : String(error)}\n`);
  }
  const result: InitCommandResult = { ...initialized, server, welcome };
  if (options.json) printJson(result);
  else {
    printInitializationServerResult(server, ui);
    printInitializationWelcomeResult(welcome, ui);
    ui.finish(cliText("AgentBot initialization completed", "AgentBot 初始化完成"));
  }
}

async function initializeSupportedAgents(json: boolean, ui: InitUi): Promise<InitializedAgent[]> {
  const output = json ? process.stderr : process.stdout;
  if (ui.interactive) ui.step(cliText("Checking installed Agents", "正在检查已安装的 Agent"));
  else {
    output.write(cliText(
      "\nAgent setup\nChecking Codex and TraeX...\n",
      "\nAgent 设置\n正在检查 Codex 和 TraeX...\n",
    ));
  }
  const inspections = await inspectSupportedAgents();
  for (const inspection of inspections) {
    if (ui.interactive) printInteractiveAgentInspection(inspection, ui);
    else printAgentInspection(inspection, output);
  }
  const actionable = selectAgentMaintenanceActions(inspections);
  if (actionable.length === 0) return inspections;

  let selected = new Set<number>();
  if (ui.interactive) {
    selected = new Set(await ui.multiselect({
      message: cliText("Choose Agent maintenance actions", "请选择 Agent 安装或升级操作"),
      options: actionable.map((inspection, index) => ({
        value: index,
        label: cliText(
          `${inspection.action?.kind === "install" ? "Install" : "Upgrade"} ${inspection.name}`,
          `${inspection.action?.kind === "install" ? "安装" : "升级"} ${inspection.name}`,
        ),
        hint: inspection.action?.command,
      })),
      initialValues: [],
      required: false,
    }));
    if (selected.size === 0) {
      ui.info(cliText("Agent maintenance skipped", "已跳过 Agent 安装和升级"));
    }
  } else {
    output.write(cliText("\nAvailable actions:\n", "\n可执行的操作：\n"));
    for (const [index, inspection] of actionable.entries()) {
      output.write(cliText(
        `  ${index + 1}. ${inspection.action?.kind === "install" ? "Install" : "Upgrade"} ${inspection.name}: ${inspection.action?.command}\n`,
        `  ${index + 1}. ${inspection.action?.kind === "install" ? "安装" : "升级"} ${inspection.name}：${inspection.action?.command}\n`,
      ));
    }
    output.write(cliText(
      "No interactive terminal is available. Run the commands above manually if needed.\n",
      "当前没有交互式终端，如有需要请手动执行上面的命令。\n",
    ));
  }

  const initialized: InitializedAgent[] = [];
  for (const inspection of inspections) {
    if (!inspection.action) {
      initialized.push(inspection);
      continue;
    }
    const actionIndex = actionable.indexOf(inspection);
    if (!selected.has(actionIndex)) {
      initialized.push({
        ...inspection,
        assistance: { status: ui.interactive ? "skipped" : "unavailable" },
      });
      continue;
    }

    const actionMessage = cliText(
      `Running ${inspection.name} ${inspection.action.kind}: ${inspection.action.command}`,
      `正在${inspection.action.kind === "install" ? "安装" : "升级"} ${inspection.name}：${inspection.action.command}`,
    );
    if (ui.interactive) ui.step(actionMessage);
    else output.write(`\n${actionMessage}\n`);
    const maintenance = await runSupportedAgentMaintenance(inspection.id, inspection.action.kind);
    if (maintenance.status !== 0 || maintenance.error) {
      const error = maintenance.error ?? cliText(
        `Command exited with code ${maintenance.status ?? "unknown"}.`,
        `命令退出码为 ${maintenance.status ?? "未知"}。`,
      );
      const warning = cliText(
        `${inspection.name} ${inspection.action.kind} did not complete; initialization will continue.`,
        `${inspection.name}${inspection.action.kind === "install" ? "安装" : "升级"}未完成，初始化将继续。`,
      );
      if (ui.interactive) ui.warn(warning);
      else output.write(`${warning}\n`);
      initialized.push({ ...inspection, assistance: { status: "failed", error } });
      continue;
    }

    refreshCurrentProcessPath();
    const refreshed = await inspectSupportedAgent(inspection.id);
    if (refreshed.installedVersion) {
      const ready = cliText(
        `${inspection.name} is ready (${refreshed.installedVersion}).`,
        `${inspection.name} 已就绪（${refreshed.installedVersion}）。`,
      );
      if (ui.interactive) ui.success(ready);
      else output.write(`${ready}\n`);
    } else {
      const warning = cliText(
        `${inspection.name} command completed, but the CLI is not visible in this process. Open a new terminal and run agentbot init again.`,
        `${inspection.name} 命令已完成，但当前进程仍无法找到该 CLI。请打开新终端后重新运行 agentbot init。`,
      );
      if (ui.interactive) ui.warn(warning);
      else output.write(`${warning}\n`);
    }
    initialized.push({ ...refreshed, assistance: { status: "completed" } });
  }
  return initialized;
}

async function configureAgentsAndDefault(
  configPath: string,
  inspections: InitializedAgent[],
  json: boolean,
  configureAgents: boolean,
  ui: InitUi,
): Promise<InitCommandResult["defaultAgent"]> {
  const output = json ? process.stderr : process.stdout;
  const configured = readConfiguredAgentSelection(configPath);
  const configuredDefaultIsValid = Boolean(
    configured.defaultAgent
    && configured.agents.some((agent) => agent.name === configured.defaultAgent),
  );
  if (!configureAgents) {
    if (!configuredDefaultIsValid) {
      throw new Error(cliText(
        "The existing Profile has no valid default Agent. Set defaults.agent in config.yaml, then run agentbot init again.",
        "现有 Profile 没有有效的默认 Agent。请在 config.yaml 中设置 defaults.agent，然后重新运行 agentbot init。",
      ));
    }
    const message = cliText(
      `Default Agent: ${configured.defaultAgent} (unchanged)`,
      `默认 Agent：${configured.defaultAgent}（保持不变）`,
    );
    if (ui.interactive) ui.info(message);
    else output.write(`${message}\n`);
    return { name: configured.defaultAgent!, status: "existing" };
  }

  const choices = selectableDefaultAgents(configured.agents, inspections);
  if (choices.length === 0) {
    const issue = inspections.find((inspection) => inspection.compatibilityIssue)?.compatibilityIssue;
    if (issue) throw new Error(issue);
    throw new Error(cliText(
      "No installed supported Agent was detected. Install Codex or TraeX, then run agentbot init again.",
      "没有检测到已安装且受支持的 Agent。请安装 Codex 或 TraeX，然后重新运行 agentbot init。",
    ));
  }

  let selectedAgents = choices;
  if (ui.interactive && choices.length > 1) {
    const selectedIndexes = await ui.multiselect({
      message: cliText("Choose Agents to configure", "请选择要配置的 Agent"),
      options: choices.map((choice, index) => ({
        value: index,
        label: `${choice.name} - ${choice.title}`,
        hint: choice.installedVersion,
      })),
      initialValues: choices.map((_, index) => index),
      required: true,
    });
    selectedAgents = selectedIndexes.flatMap((index) => choices[index] ? [choices[index]!] : []);
  }

  const selectedNames = selectedAgents.map((agent) => agent.name);
  const configuredMessage = cliText(
    `Configured Agents: ${selectedNames.join(", ")}`,
    `已配置 Agent：${selectedNames.join("、")}`,
  );
  if (ui.interactive) ui.success(configuredMessage);
  else output.write(`${configuredMessage}\n`);

  let selectedDefault = selectedAgents[0]!;
  if (selectedAgents.length > 1) {
    if (ui.interactive) {
      const currentIndex = selectedAgents.findIndex((choice) => choice.name === configured.defaultAgent);
      const selectedIndex = await ui.select({
        message: cliText("Choose the default Agent", "请选择默认 Agent"),
        options: selectedAgents.map((choice, index) => ({
          value: index,
          label: `${choice.name} - ${choice.title}`,
          hint: choice.installedVersion,
        })),
        initialValue: currentIndex >= 0 ? currentIndex : 0,
      });
      selectedDefault = selectedAgents[selectedIndex]!;
    } else {
      selectedDefault = selectedAgents.find((agent) => agent.name === configured.defaultAgent)
        ?? selectedAgents[0]!;
    }
  }

  const updated = writeConfiguredAgentSelection(configPath, selectedNames, selectedDefault.name);
  const defaultMessage = cliText(
    `Default Agent: ${selectedDefault.name}${ui.interactive ? "" : " (selected automatically)"}`,
    `默认 Agent：${selectedDefault.name}${ui.interactive ? "" : "（已自动选择）"}`,
  );
  if (ui.interactive) ui.success(defaultMessage);
  else output.write(`${defaultMessage}\n`);
  return { name: selectedDefault.name, status: updated ? "selected" : "existing" };
}

async function configureGroupMessageResponse(
  configPath: string,
  json: boolean,
  configure: boolean,
  ui: InitUi,
): Promise<InitCommandResult["groupMessages"]> {
  const output = json ? process.stderr : process.stdout;
  if (!configure) {
    const mode = readGroupMessageResponseMode(configPath);
    if (ui.interactive) {
      ui.info(cliText(
        `Group message response: ${mode === "all" ? "receive all group messages" : "require an explicit @ mention"} (unchanged)`,
        `群消息响应方式：${mode === "all" ? "接收所有群消息" : "必须明确 @ 机器人"}（保持不变）`,
      ));
    }
    return { mode, status: "existing" };
  }

  let mode: GroupMessageResponseMode = "mention-only";
  if (ui.interactive) {
    mode = await ui.select({
      message: cliText(
        "Choose how AgentBot responds to group messages",
        "请选择 AgentBot 响应群消息的方式",
      ),
      options: [
        {
          value: "mention-only",
          label: cliText("Require an explicit @ mention", "必须明确 @ 机器人"),
          hint: cliText(
            "Recommended; no additional manual permission is required",
            "推荐；不需要额外手动申请权限",
          ),
        },
        {
          value: "all",
          label: cliText("Receive all group messages", "接收所有群消息"),
          hint: cliText(
            "Respond without @; requires a final manual Lark permission step",
            "无需 @ 即可响应；最后需要手动开通飞书权限",
          ),
        },
      ],
      initialValue: "mention-only",
    });
  } else {
    output.write(cliText(
      "No interactive terminal is available. Group messages will require an explicit @ mention, and the all-group-message permission will not be requested.\n",
      "当前没有交互式终端。群消息将要求明确 @ 机器人，并且不会申请接收所有群消息的额外权限。\n",
    ));
  }

  writeGroupMessageResponseMode(configPath, mode);
  const message = cliText(
    `Group message response: ${mode === "all" ? "receive all group messages" : "require an explicit @ mention"}`,
    `群消息响应方式：${mode === "all" ? "接收所有群消息" : "必须明确 @ 机器人"}`,
  );
  if (ui.interactive) ui.success(message);
  else output.write(`${message}\n`);
  return { mode, status: "selected" };
}

function printInteractiveAgentInspection(
  inspection: SupportedAgentInspection,
  ui: InitUi,
): void {
  if (inspection.compatibilityIssue) {
    ui.warn(inspection.compatibilityIssue);
    return;
  }
  if (inspection.state === "missing") {
    ui.info(cliText(
      `${inspection.name}: not installed`,
      `${inspection.name}：未安装`,
    ));
    return;
  }
  if (inspection.state === "outdated") {
    ui.warn(cliText(
      `${inspection.name}: ${inspection.installedVersion}; update available (${inspection.latestVersion})`,
      `${inspection.name}：${inspection.installedVersion}；可升级到 ${inspection.latestVersion}`,
    ));
    return;
  }
  if (inspection.latestCheckFailed) {
    ui.warn(cliText(
      `${inspection.name}: ${inspection.installedVersion}; latest-version check unavailable`,
      `${inspection.name}：${inspection.installedVersion}；无法检查最新版本`,
    ));
    return;
  }
  ui.success(cliText(
    `${inspection.name}: ${inspection.installedVersion} (up to date)`,
    `${inspection.name}：${inspection.installedVersion}（已是最新）`,
  ));
}

function printAgentInspection(
  inspection: SupportedAgentInspection,
  output: NodeJS.WriteStream,
): void {
  if (inspection.compatibilityIssue) {
    output.write(`  ${inspection.compatibilityIssue}\n`);
    return;
  }
  if (inspection.state === "missing") {
    output.write(cliText(
      `  ${inspection.name}: not installed\n`,
      `  ${inspection.name}：未安装\n`,
    ));
    return;
  }
  if (inspection.state === "outdated") {
    output.write(cliText(
      `  ${inspection.name}: ${inspection.installedVersion}; update available (${inspection.latestVersion})\n`,
      `  ${inspection.name}：${inspection.installedVersion}；可升级到 ${inspection.latestVersion}\n`,
    ));
    return;
  }
  if (inspection.latestCheckFailed) {
    output.write(cliText(
      `  ${inspection.name}: ${inspection.installedVersion}; latest-version check unavailable\n`,
      `  ${inspection.name}：${inspection.installedVersion}；无法检查最新版本\n`,
    ));
    return;
  }
  output.write(cliText(
    `  ${inspection.name}: ${inspection.installedVersion} (up to date)\n`,
    `  ${inspection.name}：${inspection.installedVersion}（已是最新）\n`,
  ));
}

function refreshCurrentProcessPath(): void {
  const refreshed = refreshedSystemEnvironment();
  if (!refreshed.refreshed) return;
  const pathEntry = Object.entries(refreshed.environment)
    .find(([name]) => name.toLowerCase() === "path");
  if (pathEntry?.[1]) process.env.PATH = pathEntry[1];
}

async function initializeFeishu(
  paths: InitializationResult,
  options: InitCommandOptions,
  ui: InitUi,
): Promise<FeishuInitializationContext> {
  const existing = readFeishuCredentials(paths.env.path);
  if (options.skipFeishu) {
    return {
      result: {
        status: "skipped",
        ...(existing.appId ? { appId: existing.appId } : {}),
        ...(existing.appId && existing.appSecret
          ? { userOpenIdStatus: existing.userOpenId ? "configured" as const : "pending" as const }
          : {}),
      },
    };
  }
  if (ui.interactive) ui.step(cliText("Creating or connecting the Lark bot", "正在创建或连接飞书机器人"));
  else if (!options.json) process.stdout.write(cliText("\nLark setup\n", "\n飞书设置\n"));

  return withInitializationCancellation(async (signal) => {
    let credentials: FeishuAppCredentials;
    let status: Exclude<FeishuInitializationStatus, "skipped">;
    if (!shouldCreateFeishuApp(existing, options.reconfigureFeishu)) {
      credentials = {
        appId: existing.appId!,
        appSecret: existing.appSecret!,
        userOpenId: existing.userOpenId,
      };
      status = "existing";
      if (ui.interactive) {
        ui.success(cliText(
          `Using the existing Lark bot (${credentials.appId})`,
          `正在使用已有飞书机器人（${credentials.appId}）`,
        ));
      }
    } else {
      if (existing.status === "incomplete" && !options.json) {
        const message = cliText(
          "Incomplete Lark credentials were found. A new bot will be created.",
          "发现不完整的飞书凭据，将创建一个新机器人。",
        );
        if (ui.interactive) ui.warn(message);
        else process.stdout.write(`\n${message}\n`);
      }
      credentials = await registerFeishuApp({
        signal,
        onVerification: (challenge) => printFeishuVerification(challenge, ui),
      });
      writeFeishuCredentials(paths.env.path, credentials);
      status = "created";
      if (ui.interactive) {
        ui.success(cliText(
          `Lark bot created (${credentials.appId})`,
          `飞书机器人已创建（${credentials.appId}）`,
        ));
      }
    }

    const checking = cliText(
      "Checking one-click Lark permissions, events, and callbacks",
      "正在检查可一键授权的飞书权限、事件和回调",
    );
    if (ui.interactive) ui.step(checking);
    else if (!options.json) process.stdout.write(`${checking}...\n`);
    const configuration = await runFeishuConfigurationInteraction(
      signal,
      ui,
      (interaction) => ensureFeishuAppConfiguration(credentials, {
        ...interaction,
        respondToAllGroupMessages: false,
      }),
    );
    if (ui.interactive) {
      if (configuration.status === "partial") {
        ui.warn(cliText(
          "Some optional one-click Lark configuration was skipped or is not active yet",
          "部分可选的一键飞书配置已跳过或尚未生效",
        ));
      } else {
        ui.success(cliText(
          "One-click Lark permissions, events, and callbacks are ready",
          "可一键授权的飞书权限、事件和回调已就绪",
        ));
      }
    }
    return {
      credentials,
      result: {
        status,
        appId: credentials.appId,
        userOpenIdStatus: credentials.userOpenId ? "configured" : "pending",
        configuration,
      },
    };
  });
}

async function completeFeishuGroupMessageSetup(
  context: FeishuInitializationContext,
  mode: GroupMessageResponseMode,
  ui: InitUi,
): Promise<InitCommandResult["feishu"]> {
  if (mode !== "all" || !context.credentials) return context.result;

  ui.step(cliText(
    "Configuring permission for group messages without @ mentions",
    "正在配置群消息免 @ 权限",
  ));
  const groupConfiguration = await withInitializationCancellation((signal) =>
    runFeishuConfigurationInteraction(
      signal,
      ui,
      (interaction) => ensureFeishuGroupMessagePermission(context.credentials!, interaction),
    )
  );
  if (ui.interactive) {
    if (groupConfiguration.status === "partial") {
      ui.warn(cliText(
        "The all-group-message permission is not active; group messages still require an @ mention",
        "接收所有群消息权限尚未生效；群消息仍需 @ 机器人",
      ));
    } else {
      ui.success(cliText(
        "Group messages can be received without @ mentions",
        "已可接收未 @ 机器人的群消息",
      ));
    }
  }
  return {
    ...context.result,
    configuration: mergeFeishuConfigurationResults(
      context.result.configuration,
      groupConfiguration,
    ),
  };
}

async function runFeishuConfigurationInteraction(
  signal: AbortSignal,
  ui: InitUi,
  operation: (options: {
    signal: AbortSignal;
    manualPermissionSkipSignal: AbortSignal;
    optionalSkipSignal: AbortSignal;
    onVerification: (challenge: FeishuConfigurationChallenge) => void;
  }) => Promise<EnsureFeishuAppConfigurationResult>,
): Promise<EnsureFeishuAppConfigurationResult> {
  const manualPermissionSkip = new AbortController();
  const optionalSkip = new AbortController();
  let skipListener: OptionalAuthorizationSkipListener | undefined;
  try {
    return await operation({
      signal,
      manualPermissionSkipSignal: manualPermissionSkip.signal,
      optionalSkipSignal: optionalSkip.signal,
      onVerification: (challenge) => {
        printFeishuConfigurationVerification(challenge, ui);
        if (challenge.kind === "manual_scope" && challenge.blocking) {
          skipListener?.close();
          skipListener = listenForManualPermissionSkip(() => manualPermissionSkip.abort());
        } else if (!challenge.blocking) {
          skipListener?.close();
          skipListener = listenForOptionalAuthorizationSkip(() => optionalSkip.abort());
        }
      },
    });
  } finally {
    skipListener?.close();
  }
}

async function withInitializationCancellation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort(new Error(cliText(
    "Initialization was cancelled.",
    "初始化已取消。",
  )));
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try {
    return await operation(controller.signal);
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}

function mergeFeishuConfigurationResults(
  first: EnsureFeishuAppConfigurationResult | undefined,
  second: EnsureFeishuAppConfigurationResult,
): EnsureFeishuAppConfigurationResult {
  if (!first) return second;
  const added = mergeFeishuConfigurationSets(first.added, second.added);
  const remaining = mergeFeishuConfigurationSets(first.remaining, second.remaining);
  const addedCount = added.scopes.length + added.events.length + added.callbacks.length;
  const remainingCount = remaining.scopes.length + remaining.events.length + remaining.callbacks.length;
  return {
    status: remainingCount > 0 ? "partial" : addedCount > 0 ? "updated" : "ready",
    configuration: second.configuration,
    added,
    remaining,
  };
}

function mergeFeishuConfigurationSets(
  first: FeishuConfigurationChallenge["missing"],
  second: FeishuConfigurationChallenge["missing"],
): FeishuConfigurationChallenge["missing"] {
  return {
    scopes: [...new Set([...first.scopes, ...second.scopes])],
    events: [...new Set([...first.events, ...second.events])],
    callbacks: [...new Set([...first.callbacks, ...second.callbacks])],
  };
}

async function assertResetProfileServerStopped(configPath?: string): Promise<void> {
  const endpoints = new Set<string>([controlEndpoint(defaultSqlitePath())]);
  const selectedConfigPath = configPath ?? process.env.AGENT_BOT_CONFIG;
  if (selectedConfigPath && fs.existsSync(selectedConfigPath)) {
    try {
      endpoints.add(controlEndpoint(
        loadConfigWithoutEnvironmentMutation(selectedConfigPath).storage.sqlitePath,
      ));
    } catch {
      // Reset must remain available when the existing configuration is invalid.
    }
  }
  for (const endpoint of endpoints) {
    if (await isServerReachable(endpoint)) {
      throw new Error(
        cliText(
          "Cannot reset a running profile. Stop it with the matching agentbot server stop command, then try again.",
          "无法重置正在运行的 Profile。请先使用对应 Profile 的 agentbot server stop 命令停止服务，然后重试。",
        ),
      );
    }
  }
}

function skillsCommand(input: string[]): void {
  const [action = "status", ...rest] = input;
  const targetRoot = optionValue(rest, "--target") ?? resolveSystemSkillsRoot();
  const registry = bundledSkillRegistry(targetRoot);
  const json = rest.includes("--json");

  if (action === "install" || action === "register") {
    const result = registry.install();
    if (json) printJson(result);
    else process.stdout.write(result.updated
      ? cliText(
          `Installed the Agent Bot Skill: ${result.status.targetPath}\n`,
          `已安装 Agent Bot Skill：${result.status.targetPath}\n`,
        )
      : cliText(
          `The Agent Bot Skill is already up to date: ${result.status.targetPath}\n`,
          `Agent Bot Skill 已是最新版本：${result.status.targetPath}\n`,
        ));
    return;
  }
  if (action === "uninstall" || action === "unregister") {
    const removed = registry.uninstall();
    if (json) printJson({ removed, targetPath: registry.targetPath });
    else process.stdout.write(removed
      ? cliText(
          `Uninstalled the Agent Bot Skill: ${registry.targetPath}\n`,
          `已卸载 Agent Bot Skill：${registry.targetPath}\n`,
        )
      : cliText(
          `The Agent Bot Skill is not installed: ${registry.targetPath}\n`,
          `Agent Bot Skill 尚未安装：${registry.targetPath}\n`,
        ));
    return;
  }
  if (action === "status") {
    const status = registry.status();
    if (json) printJson(status);
    else printSkillStatus(status);
    return;
  }
  if (action === "path") {
    const paths = { sourcePath: registry.sourcePath, skillsRoot: registry.skillsRoot, targetPath: registry.targetPath };
    if (json) printJson(paths);
    else {
      process.stdout.write(`${cliText("Built-in Skill: ", "内置 Skill：")}${paths.sourcePath}\n`);
      process.stdout.write(`${cliText("System Skills directory: ", "系统 Skills 目录：")}${paths.skillsRoot}\n`);
      process.stdout.write(`${cliText("Installation path: ", "安装路径：")}${paths.targetPath}\n`);
    }
    return;
  }
  throw new Error(cliText(`Unknown skills command: ${action}`, `未知的 skills 命令：${action}`));
}

function bundledSkillRegistry(targetRoot = resolveSystemSkillsRoot()): SkillRegistry {
  const sourcePath = fileURLToPath(new URL("../skills/agent-bot/", import.meta.url));
  return new SkillRegistry(sourcePath, targetRoot);
}

async function consoleCommand(input: string[]): Promise<void> {
  const config = loadConfig();
  const endpoint = controlEndpoint(config.storage.sqlitePath);
  const force = input.includes("--force");
  if (!force && await isServerReachable(endpoint)) {
    throw new Error(
      cliText(
        "The Agent Bot server is running. Stop it first to avoid concurrent task-state access, or explicitly use --force.",
        "Agent Bot 服务正在运行。请先停止服务以避免并发访问任务状态，或显式使用 --force。",
      ),
    );
  }
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  const reportDirectory = resolveSupervisorDiagnosticsPaths(config).crashReportDirectory;
  prepareCrashReportDirectory(reportDirectory);
  const result = spawnSync(process.execPath, [
    ...nodeDiagnosticReportArguments(reportDirectory),
    entry,
  ], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, AGENT_BOT_CONSOLE_ONLY: "1" },
  });
  if (result.error) throw result.error;
  if (result.status && result.status !== 0) process.exitCode = result.status;
}

async function serverCommand(input: string[]): Promise<void> {
  const [action = "status", ...rest] = input;
  const config = loadConfig();
  const endpoint = controlEndpoint(config.storage.sqlitePath);
  if (action === "status") {
    try {
      const response = await sendControlRequest(endpoint, { action: "health" }, 1_500);
      ensureOk(response);
      const status = withConfiguredFeishuAppId(response.data, config.feishu.appId);
      if (rest.includes("--json")) printJson(status);
      else process.stdout.write(formatServerStatus(status));
    } catch {
      const status = {
        running: false,
        feishuAppId: config.feishu.appId ?? null,
      };
      if (rest.includes("--json")) printJson(status);
      else process.stdout.write(formatServerStatus(status));
      process.exitCode = 3;
    }
    return;
  }
  if (action === "start") {
    printServerStartResult(await startServer(config));
    return;
  }
  if (action === "autostart") {
    await serverAutostartCommand(config, endpoint, rest);
    return;
  }
  if (action === "stop") {
    ensureOk(await sendControlRequest(endpoint, { action: "server_stop" }));
    process.stdout.write(cliText("Agent Bot server stop requested.\n", "已请求停止 Agent Bot 服务。\n"));
    return;
  }
  if (action === "restart") {
    const immediate = rest.includes("--immediate") || rest.includes("--force");
    const notificationSessionId = resolveRestartNotificationSessionId(config.storage.sqlitePath, rest);
    const reason = optionValue(rest, "--reason")
      ?? (immediate ? "通过 Agent Bot CLI 立即重启" : "通过 Agent Bot CLI 安全重启");
    ensureOk(await sendControlRequest(endpoint, {
      action: "server_restart",
      mode: immediate ? "immediate" : "safe",
      reason,
      notificationSessionId,
    }));
    process.stdout.write(immediate
      ? cliText("Immediate restart requested.\n", "已请求立即重启。\n")
      : cliText("Safe restart requested.\n", "已请求安全重启。\n"));
    return;
  }
  throw new Error(cliText(`Unknown server command: ${action}`, `未知的 server 命令：${action}`));
}

async function serverAutostartCommand(
  config: ReturnType<typeof loadConfig>,
  endpoint: string,
  input: string[],
): Promise<void> {
  const actionIndex = input.findIndex((value) => !value.startsWith("--"));
  const action = actionIndex < 0 ? "status" : input[actionIndex]!;
  const rest = input.filter((_value, index) => index !== actionIndex);
  const json = rest.includes("--json");
  const linger = rest.includes("--linger");
  const unsupported = rest.filter((value) => value !== "--json" && value !== "--linger");
  if (unsupported.length > 0) throw new Error(cliText(
    `Unsupported server autostart options: ${unsupported.join(" ")}`,
    `不支持这些 server autostart 参数：${unsupported.join(" ")}`,
  ));
  if (action !== "enable" && linger) {
    throw new Error(cliText(
      "--linger can be used only with server autostart enable.",
      "--linger 只能与 server autostart enable 一起使用。",
    ));
  }

  const manager = createCurrentAutostartManager(config);
  let registration;
  if (action === "enable") {
    registration = manager.enable({ linger });
  } else if (action === "disable") {
    registration = manager.disable();
  } else if (action === "status") {
    registration = manager.status();
  } else {
    throw new Error(cliText(
      `Unknown server autostart command: ${action}`,
      `未知的 server autostart 命令：${action}`,
    ));
  }

  const result: CombinedAutostartStatus = {
    registration,
    server: await readAutostartServerStatus(endpoint),
  };
  if (json) printJson(result);
  else process.stdout.write(formatAutostartStatus(result));
}

async function readAutostartServerStatus(endpoint: string): Promise<AutostartServerStatus> {
  try {
    const response = await sendControlRequest(endpoint, { action: "health" }, 1_500);
    if (!response.ok) return { running: true, ready: false };
    const data = response.data && typeof response.data === "object"
      ? response.data as Record<string, unknown>
      : {};
    return { running: true, ready: data.ready !== false };
  } catch {
    return { running: false, ready: false };
  }
}

function resolveRestartNotificationSessionId(sqlitePath: string, args: string[]): string | undefined {
  const store = new StateStore(sqlitePath);
  try {
    const sessions = store.listAllSessions();
    let explicitReference: string | undefined;
    if (args.includes("--task")) {
      const reference = optionValue(args, "--task")?.trim();
      if (!reference || reference.startsWith("--")) throw new Error(cliText(
        "server restart --task requires a task number or task ID.",
        "server restart --task 需要任务序号或任务 ID。",
      ));
      explicitReference = reference;
    }
    const session = resolveRestartNotificationTask(sessions, explicitReference);
    if (!session) return undefined;
    if (
      isThreadContextKey(session.contextKey)
      && !store.findLatestMessageIdForSession(session.localSessionId, session.contextKey)
      && !store.findLatestMessageIdForContext(session.contextKey)
    ) {
      throw new Error(cliText(
        "The task topic has no message anchor for restart notifications. Send /restart in that topic instead.",
        "该任务话题没有可用于重启通知的消息锚点，请直接在该话题中发送 /restart。",
      ));
    }
    return session.localSessionId;
  } finally {
    store.close();
  }
}

async function taskCommand(input: string[]): Promise<void> {
  const [action = "list", ...rest] = input;
  const config = loadConfig();
  const store = new StateStore(config.storage.sqlitePath);
  try {
    const allSessions = store.listAllSessions();
    if (action === "help" || action === "--help" || action === "-h") {
      printHelp();
      return;
    }
    if (action === "current") {
      const unsupported = rest.filter((value) => value !== "--json");
      if (unsupported.length > 0) throw new Error(cliText(
        `task current does not accept arguments: ${unsupported.join(" ")}`,
        `task current 不接受这些参数：${unsupported.join(" ")}`,
      ));
      const session = resolveCurrentTaskFromEnvironment(allSessions);
      await outputTaskStatus(config.storage.sqlitePath, store, session, rest.includes("--json"));
      return;
    }
    if (action === "prompt" || action === "send") {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const text = target.args.join(" ").trim();
      if (!text) throw new Error(cliText(
        `task ${action} requires a Prompt.`,
        `task ${action} 需要提示词。`,
      ));
      const endpoint = controlEndpoint(config.storage.sqlitePath);
      ensureOk(await sendControlRequest(endpoint, {
        action: "task_prompt",
        localSessionId: target.session.localSessionId,
        text,
      }, 60_000));
      process.stdout.write(cliText("Prompt submitted.\n", "提示词已提交。\n"));
      return;
    }
    if (action === "new") {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const options = parseTaskNewOptions([target.session.localSessionId, ...target.args]);
      const source = target.session;
      const targetAgent = options.agentName ? config.agents[options.agentName] : undefined;
      if (options.agentName && !targetAgent) throw new Error(cliText(
        `Unknown Agent standard name: ${options.agentName}.`,
        `未知的 Agent 标准名：${options.agentName}。`,
      ));
      if (options.projectless && targetAgent && targetAgent.kind !== "app-server") throw new Error(cliText(
        "task new --nodir is only available for App Server agents.",
        "task new --nodir 仅适用于 App Server Agent。",
      ));
      const created = controlData<SessionRecord>(await sendControlRequest(controlEndpoint(config.storage.sqlitePath), {
        action: "task_new",
        localSessionId: source.localSessionId,
        ...(options.title ? { title: options.title } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.agentName ? { agentName: options.agentName } : {}),
        ...(options.projectless ? { projectless: true } : {}),
      }, 120_000));
      if (options.json) printJson(created);
      else printCreatedTask(created, "Task created");
      return;
    }
    if (action === "fork") {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const options = target.args;
      rejectUnsupportedTaskOptions(action, options, ["--json"]);
      if (options.some((value) => !value.startsWith("--"))) throw new Error(cliText(
        "task fork accepts only one task reference.",
        "task fork 只接受一个任务引用。",
      ));
      const result = controlData<TaskForkControlData>(await sendControlRequest(controlEndpoint(config.storage.sqlitePath), {
        action: "task_fork",
        localSessionId: target.session.localSessionId,
      }, 120_000));
      if (options.includes("--json")) printJson(result);
      else {
        printCreatedTask(result.task, "Fork created");
        process.stdout.write(`${cliText("Source turn: ", "来源 Turn：")}${result.sourceTurnId}\n`);
      }
      return;
    }
    if (action === "archive") {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const options = target.args;
      rejectUnsupportedTaskOptions(action, options, ["--json"]);
      if (options.some((value) => !value.startsWith("--"))) throw new Error(cliText(
        "task archive accepts only one task reference.",
        "task archive 只接受一个任务引用。",
      ));
      const archived = controlData<{
        localSessionId: string;
        remoteSessionId: string;
        title: string;
      }>(await sendControlRequest(controlEndpoint(config.storage.sqlitePath), {
        action: "task_archive",
        localSessionId: target.session.localSessionId,
      }, 60_000));
      if (options.includes("--json")) printJson(archived);
      else process.stdout.write(cliText(
        `Task archived: ${archived.title} (${archived.remoteSessionId})\n`,
        `任务已归档：${archived.title}（${archived.remoteSessionId}）\n`,
      ));
      return;
    }
    if (action === "release") {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const options = target.args;
      rejectUnsupportedTaskOptions(action, options, ["--json"]);
      if (options.some((value) => !value.startsWith("--"))) throw new Error(cliText(
        "task release accepts only one task reference.",
        "task release 只接受一个任务引用。",
      ));
      const released = controlData<TaskReleaseControlData>(await sendControlRequest(
        controlEndpoint(config.storage.sqlitePath),
        { action: "task_release", localSessionId: target.session.localSessionId },
        60_000,
      ));
      if (options.includes("--json")) printJson(released);
      else if (released.status === "released") {
        process.stdout.write(cliText(
          `App Server tasks released for ${released.agentName}.\n`,
          `已释放 ${released.agentName} 的 App Server 任务。\n`,
        ));
      } else {
        process.stdout.write(cliText(
          released.blockingTaskCount > 0
            ? `App Server release card sent for ${released.agentName} (${released.blockingTaskCount} blocking). Confirm in Lark to release.\n`
            : `App Server release card sent for ${released.agentName}. Confirm in Lark to release.\n`,
          released.blockingTaskCount > 0
            ? `已发送 ${released.agentName} 的 App Server 释放卡片（${released.blockingTaskCount} 个任务阻塞）。请在飞书中确认释放。\n`
            : `已发送 ${released.agentName} 的 App Server 释放卡片。请在飞书中确认释放。\n`,
        ));
      }
      return;
    }
    if (action === "dismiss") {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const options = target.args;
      rejectUnsupportedTaskOptions(action, options, ["--yes", "--json"]);
      if (options.some((value) => !value.startsWith("--"))) throw new Error(cliText(
        "task dismiss accepts only one task reference.",
        "task dismiss 只接受一个任务引用。",
      ));
      if (!options.includes("--yes")) throw new Error(cliText(
        "task dismiss permanently dissolves the bound group and archives its current task. Re-run with --yes.",
        "task dismiss 会永久解散绑定群并归档其当前任务。请添加 --yes 后重试。",
      ));
      const dismissed = controlData<TaskDismissControlData>(await sendControlRequest(
        controlEndpoint(config.storage.sqlitePath),
        {
          action: "task_dismiss",
          localSessionId: target.session.localSessionId,
        },
        60_000,
      ));
      if (options.includes("--json")) printJson(dismissed);
      else process.stdout.write(cliText(
        `Group dissolved and task archived: ${dismissed.title} (${dismissed.chatId})\n`,
        `群已解散，任务已归档：${dismissed.title}（${dismissed.chatId}）\n`,
      ));
      return;
    }
    if (action === "switch") {
      const targetSelection = resolveTaskCommandTarget(allSessions, rest, action, { preferCurrent: true });
      const switchArgs = targetSelection.args;
      rejectUnsupportedTaskOptions(action, switchArgs, ["--json", "--previous"]);
      const previous = switchArgs.includes("--previous");
      const targetReferences = switchArgs.filter((value) => !value.startsWith("--"));
      if (targetReferences.length > 1) throw new Error(cliText(
        "task switch accepts at most one target task.",
        "task switch 最多接受一个目标任务。",
      ));
      const targetReference = targetReferences[0];
      if (previous && targetReference) throw new Error(cliText(
        "task switch cannot combine a target task with --previous.",
        "task switch 不能同时指定目标任务和 --previous。",
      ));
      const target = targetReference ? resolveTask(allSessions, targetReference) : undefined;
      const switched = controlData<SessionRecord>(await sendControlRequest(controlEndpoint(config.storage.sqlitePath), {
        action: "task_switch",
        localSessionId: targetSelection.session.localSessionId,
        ...(target ? { targetLocalSessionId: target.localSessionId } : {}),
        ...(previous ? { previous: true } : {}),
      }));
      if (switchArgs.includes("--json")) printJson(switched);
      else printCreatedTask(switched, "Current task");
      return;
    }
    if (action === "queue" || action === "nosteer") {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const text = target.args.join(" ").trim();
      if (!text) throw new Error(cliText(
        `task ${action} requires a Prompt.`,
        `task ${action} 需要提示词。`,
      ));
      const result = controlData<{ promptId: string; queued: number }>(await sendControlRequest(
        controlEndpoint(config.storage.sqlitePath),
        { action: "task_queue", localSessionId: target.session.localSessionId, text },
      ));
      process.stdout.write(cliText(
        `Prompt queued (${result.queued} waiting): ${result.promptId}\n`,
        `提示词已排队（当前 ${result.queued} 条）：${result.promptId}\n`,
      ));
      return;
    }
    if (action === "agent") {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const [agentName, ...options] = target.args;
      rejectUnsupportedTaskOptions(action, [agentName, ...options].filter((value): value is string => value !== undefined), ["--json"]);
      if (options.some((value) => !value.startsWith("--"))) throw new Error(cliText(
        "task agent accepts at most one Agent name.",
        "task agent 最多接受一个 Agent 名称。",
      ));
      const result = controlData<TaskAgentControlData>(await sendControlRequest(controlEndpoint(config.storage.sqlitePath), {
        action: "task_agent",
        localSessionId: target.session.localSessionId,
        ...(agentName && !agentName.startsWith("--") ? { agentName } : {}),
      }));
      const json = options.includes("--json") || agentName === "--json";
      if (json) printJson(result);
      else printTaskAgentSettings(result);
      return;
    }
    if (["provider", "model", "thinking", "permissions"].includes(action)) {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const [rawValue, ...options] = target.args;
      rejectUnsupportedTaskOptions(action, [rawValue, ...options].filter((value): value is string => value !== undefined), ["--json"]);
      if (options.some((value) => !value.startsWith("--"))) throw new Error(cliText(
        `task ${action} accepts at most one value.`,
        `task ${action} 最多接受一个值。`,
      ));
      const value = rawValue && !rawValue.startsWith("--") ? rawValue : undefined;
      const json = options.includes("--json") || rawValue === "--json";
      const result = controlData<TaskSettingsControlData>(await sendControlRequest(controlEndpoint(config.storage.sqlitePath), {
        action: "task_settings",
        localSessionId: target.session.localSessionId,
        ...(value ? { setting: action as "provider" | "model" | "thinking" | "permissions", value } : {}),
      }, 60_000));
      if (json) printJson(result);
      else printTaskSettings(result, action as "provider" | "model" | "thinking" | "permissions");
      return;
    }
    if (action === "goal") {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const goalArgs = target.args;
      const json = goalArgs.includes("--json");
      const args = goalArgs.filter((value) => value !== "--json");
      rejectUnsupportedTaskOptions(action, goalArgs, ["--json"]);
      const parsedGoal = parseTaskGoal(args);
      const result = controlData<TaskGoalControlData>(await sendControlRequest(controlEndpoint(config.storage.sqlitePath), {
        action: "task_goal",
        localSessionId: target.session.localSessionId,
        goalAction: parsedGoal.action,
        ...(parsedGoal.objective ? { objective: parsedGoal.objective } : {}),
      }));
      if (json) printJson(result);
      else printTaskGoal(result);
      return;
    }
    if (action === "turns") {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const options = target.args;
      rejectUnsupportedTaskOptions(action, options, ["--json"]);
      if (options.some((value) => !value.startsWith("--"))) throw new Error(cliText(
        "task turns accepts only one task reference.",
        "task turns 只接受一个任务引用。",
      ));
      const result = controlData<TaskTurnsControlData>(await sendControlRequest(controlEndpoint(config.storage.sqlitePath), {
        action: "task_turns",
        localSessionId: target.session.localSessionId,
      }, 60_000));
      if (options.includes("--json")) printJson(result);
      else printTaskTurns(result);
      return;
    }
    if (action === "reset") {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const [turnId, ...options] = target.args;
      if (!turnId || turnId.startsWith("--")) throw new Error(cliText(
        "task reset requires a Turn ID.",
        "task reset 需要 Turn ID。",
      ));
      rejectUnsupportedTaskOptions(action, options, ["--json"]);
      if (options.some((value) => !value.startsWith("--"))) throw new Error(cliText(
        "task reset accepts one task reference and one Turn ID.",
        "task reset 只接受一个任务引用和一个 Turn ID。",
      ));
      const result = controlData<SessionRecord>(await sendControlRequest(controlEndpoint(config.storage.sqlitePath), {
        action: "task_reset",
        localSessionId: target.session.localSessionId,
        turnId,
      }, 120_000));
      if (options.includes("--json")) printJson(result);
      else process.stdout.write(cliText(`Task reset to turn ${turnId}.\n`, `任务已 Reset 到 Turn ${turnId}。\n`));
      return;
    }
    if (action === "mute") {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const [rawMode, ...options] = target.args;
      rejectUnsupportedTaskOptions(action, [rawMode, ...options].filter((value): value is string => value !== undefined), ["--json"]);
      if (options.some((value) => !value.startsWith("--"))) throw new Error(cliText(
        "task mute accepts at most one mode.",
        "task mute 最多接受一个模式。",
      ));
      const mode = rawMode && !rawMode.startsWith("--") ? rawMode.toLowerCase() : "on";
      if (mode && mode !== "on" && mode !== "off") throw new Error(cliText(
        "task mute accepts on or off.",
        "task mute 只接受 on 或 off。",
      ));
      const result = controlData<TaskMuteControlData>(await sendControlRequest(controlEndpoint(config.storage.sqlitePath), {
        action: "task_mute",
        localSessionId: target.session.localSessionId,
        enabled: mode === "on",
      }));
      const json = options.includes("--json") || rawMode === "--json";
      if (json) printJson(result);
      else process.stdout.write(cliText(
        `Mention-only mode: ${result.enabled ? "on" : "off"}\n`,
        `仅 @ 响应模式：${result.enabled ? "开启" : "关闭"}\n`,
      ));
      return;
    }
    if (action === "shell") {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const command = target.args.join(" ").trim();
      if (!command) throw new Error(cliText("task shell requires a command.", "task shell 需要命令。"));
      const result = controlData<TaskShellControlData>(await sendControlRequest(controlEndpoint(config.storage.sqlitePath), {
        action: "task_shell",
        localSessionId: target.session.localSessionId,
        command,
      }, 130_000));
      printTaskShellResult(result);
      if (result.exitCode && result.exitCode !== 0) process.exitCode = result.exitCode;
      return;
    }
    if (action === "dir") {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const parsedDirectory = parseTaskDirectoryArgs([target.session.localSessionId, ...target.args]);
      const result = controlData<TaskDirectoryControlData>(await sendControlRequest(controlEndpoint(config.storage.sqlitePath), {
        action: "task_directory",
        localSessionId: target.session.localSessionId,
        ...(parsedDirectory.directory ? { directory: parsedDirectory.directory } : {}),
        ...(parsedDirectory.page !== undefined ? { page: parsedDirectory.page } : {}),
      }, 60_000));
      if (parsedDirectory.json) printJson(result);
      else printTaskDirectory(result);
      return;
    }
    if (action === "file") {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const filePath = target.args.join(" ").trim();
      if (!filePath) throw new Error(cliText("task file requires a path.", "task file 需要文件路径。"));
      ensureOk(await sendControlRequest(controlEndpoint(config.storage.sqlitePath), {
        action: "task_send_file",
        localSessionId: target.session.localSessionId,
        filePath,
      }, 120_000));
      process.stdout.write(cliText("File sent to the task conversation.\n", "文件已发送到任务会话。\n"));
      return;
    }
    if (action === "restart") {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const translated = target.args.flatMap((value) => value === "--force" ? ["--immediate"] : [value]);
      await serverCommand(["restart", "--task", target.session.localSessionId, ...translated]);
      return;
    }
    if (action === "newgroup") {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const options = parseTaskNewGroupOptions([target.session.localSessionId, ...target.args]);
      const session = target.session;
      if (!options.sessionId) {
        const targetAgentName = options.agentName ?? session.agentName;
        const targetAgent = config.agents[targetAgentName];
        if (!targetAgent) {
          throw new Error(cliText(
            `Unknown Agent standard name: ${targetAgentName}.`,
            `未知的 Agent 标准名：${targetAgentName}。`,
          ));
        }
        if (options.projectless && targetAgent.kind !== "app-server") {
          throw new Error(cliText(
            "task newgroup --nodir is only available for App Server agents.",
            "task newgroup --nodir 仅适用于 App Server Agent。",
          ));
        }
      }
      requireCliGroupUser(config.feishu.userOpenId);
      const response = await sendControlRequest(
        controlEndpoint(config.storage.sqlitePath),
        options.sessionId
          ? {
              action: "task_new_group_session",
              localSessionId: session.localSessionId,
              sessionId: options.sessionId,
              ...(options.title ? { title: options.title } : {}),
              ...(options.agentName ? { agentName: options.agentName } : {}),
            }
          : {
              action: "task_new_group",
              localSessionId: session.localSessionId,
              ...(options.title ? { title: options.title } : {}),
              ...(options.cwd ? { cwd: options.cwd } : {}),
              ...(options.agentName ? { agentName: options.agentName } : {}),
              ...(options.projectless ? { projectless: true } : {}),
            },
        120_000,
      );
      const result = taskGroupControlData(response, Boolean(options.sessionId));
      if (options.json) printJson(result);
      else printTaskGroupResult(result, "newgroup");
      return;
    }
    if (action === "forkgroup") {
      const target = resolveTaskCommandTarget(allSessions, rest, action);
      const options = parseTaskForkGroupOptions([target.session.localSessionId, ...target.args]);
      const session = target.session;
      requireCliGroupUser(config.feishu.userOpenId);
      const response = await sendControlRequest(controlEndpoint(config.storage.sqlitePath), {
        action: "task_fork_group",
        localSessionId: session.localSessionId,
        ...(options.title ? { title: options.title } : {}),
      }, 120_000);
      const result = taskGroupControlData(response);
      if (options.json) printJson(result);
      else printTaskGroupResult(result, "forkgroup");
      return;
    }
    const sessions = filterSessions(
      allSessions,
      rest,
      action === "sessions" ? taskSessionsSearchTerm(rest) : undefined,
    );
    if (action === "list" || action === "sessions") {
      if (rest.includes("--json")) printJson(sessions);
      else printTaskList(sessions);
      return;
    }
    const target = resolveTaskCommandTarget(allSessions, rest, action);
    const session = target.session;
    if (action === "chat") {
      rejectUnsupportedTaskOptions(action, target.args, ["--json"]);
      if (target.args.some((value) => !value.startsWith("--"))) throw new Error(cliText(
        "task chat accepts only one task reference.",
        "task chat 只接受一个任务引用。",
      ));
      const route = taskChatRoute(session);
      if (target.args.includes("--json")) printJson(route);
      else process.stdout.write(`${route.chatId}\n`);
      return;
    }
    if (action === "status") {
      rejectUnsupportedTaskOptions(action, target.args, ["--json"]);
      if (target.args.some((value) => !value.startsWith("--"))) throw new Error(cliText(
        "task status accepts only one task reference.",
        "task status 只接受一个任务引用。",
      ));
      await outputTaskStatus(config.storage.sqlitePath, store, session, target.args.includes("--json"));
      return;
    }
    const endpoint = controlEndpoint(config.storage.sqlitePath);
    if (action === "stop") {
      if (target.args.length > 0) throw new Error(cliText(
        "task stop accepts only one task reference.",
        "task stop 只接受一个任务引用。",
      ));
      ensureOk(await sendControlRequest(endpoint, { action: "task_stop", localSessionId: session.localSessionId }));
      process.stdout.write(cliText("Task stop requested.\n", "已请求停止任务。\n"));
      return;
    }
    if (action === "title") {
      const titleArgs = target.args;
      const optionIndex = titleArgs.findIndex((value) => value.startsWith("--"));
      const title = titleArgs.slice(0, optionIndex < 0 ? undefined : optionIndex).join(" ").trim();
      if (!title) throw new Error(cliText(
        "task title requires a new title.",
        "task title 需要新标题。",
      ));
      ensureOk(await sendControlRequest(endpoint, {
        action: "task_title",
        localSessionId: session.localSessionId,
        title,
      }));
      process.stdout.write(cliText("Task title updated.\n", "任务标题已更新。\n"));
      return;
    }
    throw new Error(cliText(`Unknown task command: ${action}`, `未知的 task 命令：${action}`));
  } finally {
    store.close();
  }
}

function requireTaskCommandReference(action: string, reference: string | undefined): asserts reference is string {
  if (reference && !reference.startsWith("--")) return;
  throw new Error(cliText(
    `task ${action} requires a task number or task ID.`,
    `task ${action} 需要任务序号或任务 ID。`,
  ));
}

function rejectUnsupportedTaskOptions(action: string, args: string[], supported: string[]): void {
  const unsupported = args.find((value) => value.startsWith("--") && !supported.includes(value));
  if (!unsupported) return;
  throw new Error(cliText(
    `task ${action} does not support option: ${unsupported}.`,
    `task ${action} 不支持参数：${unsupported}。`,
  ));
}

function parseTaskGoal(args: string[]): {
  action: "show" | "set" | "edit" | "pause" | "resume" | "clear";
  objective?: string;
} {
  if (args.length === 0 || args[0]?.toLowerCase() === "show") return { action: "show" };
  const first = args[0]!.toLowerCase();
  if (first === "pause" || first === "resume" || first === "clear") {
    if (args.length > 1) throw new Error(cliText(
      `task goal ${first} does not accept extra arguments.`,
      `task goal ${first} 不接受额外参数。`,
    ));
    return { action: first };
  }
  const action = first === "set" || first === "edit" ? first : "set";
  const objective = (action === "set" && first !== "set" ? args : args.slice(1)).join(" ").trim();
  if (!objective) throw new Error(cliText(
    `task goal ${action} requires an objective.`,
    `task goal ${action} 需要目标。`,
  ));
  return { action, objective };
}

function parseTaskDirectoryArgs(args: string[]): {
  reference: string;
  directory?: string;
  page?: number;
  json: boolean;
} {
  const positionals: string[] = [];
  let page: number | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--json") {
      json = true;
      continue;
    }
    if (value === "--page") {
      const rawPage = args[index + 1];
      const parsedPage = rawPage === undefined ? Number.NaN : Number(rawPage);
      if (!Number.isSafeInteger(parsedPage) || parsedPage < 1) throw new Error(cliText(
        "task dir --page requires a positive page number.",
        "task dir --page 需要正整数页码。",
      ));
      page = parsedPage - 1;
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw new Error(cliText(
      `task dir does not support option: ${value}.`,
      `task dir 不支持参数：${value}。`,
    ));
    positionals.push(value);
  }
  const [reference, ...directoryParts] = positionals;
  requireTaskCommandReference("dir", reference);
  return {
    reference,
    directory: directoryParts.join(" ").trim() || undefined,
    page,
    json,
  };
}

function controlData<T>(response: ControlResponse): T {
  ensureOk(response);
  if (response.data === undefined) throw new Error(cliText(
    "Agent Bot returned no control result.",
    "Agent Bot 没有返回控制结果。",
  ));
  return response.data as T;
}

function printCreatedTask(session: SessionRecord, label: string): void {
  process.stdout.write(`${cliText(`${label}: `, `${label === "Current task" ? "当前任务" : label === "Fork created" ? "分支任务已创建" : "任务已创建"}：`)}${session.title ?? "-"}\n`);
  process.stdout.write(`${cliText("Local ID: ", "本地 ID：")}${session.localSessionId}\n`);
  if (session.remoteSessionId) process.stdout.write(`${cliText("Agent task ID: ", "Agent 任务 ID：")}${session.remoteSessionId}\n`);
  process.stdout.write(`${cliText("Agent: ", "Agent：")}${session.agentName}\n`);
  process.stdout.write(`${cliText("Directory: ", "目录：")}${session.cwd}\n`);
}

function printTaskAgentSettings(result: TaskAgentControlData): void {
  process.stdout.write(`${cliText("Default Agent: ", "默认 Agent：")}${result.current}\n`);
  process.stdout.write(`${cliText("Available Agents: ", "可用 Agent：")}${result.agents.map((agent) => `${agent.name} (${agent.title})`).join(", ")}\n`);
}

function printTaskSettings(
  result: TaskSettingsControlData,
  setting: "provider" | "model" | "thinking" | "permissions",
): void {
  const session = result.session;
  process.stdout.write(`${cliText("Provider: ", "Provider：")}${session.modelProvider ?? cliText("Agent default", "Agent 默认")}\n`);
  process.stdout.write(`${cliText("Model: ", "模型：")}${session.model ?? cliText("default", "默认")}\n`);
  process.stdout.write(`${cliText("Thinking: ", "思考强度：")}${session.reasoningEffort ?? cliText("automatic", "自动")}\n`);
  process.stdout.write(`${cliText("Permissions: ", "权限：")}${session.permissionMode ?? "auto"}\n`);
  if (setting === "provider") {
    process.stdout.write(`${cliText("Available Providers: ", "可用 Provider：")}${result.providers.map((item) => item.id).join(", ") || "-"}\n`);
  } else if (setting === "model") {
    process.stdout.write(`${cliText("Available Models: ", "可用模型：")}${result.models.map((item) => item.id).join(", ") || "-"}\n`);
  } else if (setting === "thinking") {
    process.stdout.write(`${cliText("Available Thinking Levels: ", "可用思考强度：")}${result.reasoningOptions.map((item) => item.value).join(", ") || "-"}\n`);
  } else {
    process.stdout.write(`${cliText("Available Permission Modes: ", "可用权限模式：")}${result.permissionModes.join(", ")}\n`);
  }
}

function printTaskGoal(result: TaskGoalControlData): void {
  if (!result.goal) {
    process.stdout.write(result.cleared
      ? cliText("Goal cleared.\n", "Goal 已清除。\n")
      : cliText("No Goal is configured.\n", "当前没有 Goal。\n"));
    return;
  }
  process.stdout.write(`${cliText("Goal: ", "Goal：")}${result.goal.objective}\n`);
  process.stdout.write(`${cliText("Status: ", "状态：")}${result.goal.status}\n`);
  process.stdout.write(`${cliText("Tokens used: ", "已用 Tokens：")}${result.goal.tokensUsed}\n`);
  process.stdout.write(`${cliText("Time used: ", "已用时间：")}${result.goal.timeUsedSeconds}s\n`);
}

function printTaskTurns(result: TaskTurnsControlData): void {
  process.stdout.write(`${cliText("Task: ", "任务：")}${result.session.title ?? result.session.localSessionId}\n`);
  if (result.turns.length === 0) {
    process.stdout.write(cliText("No completed turns.\n", "没有已完成的 Turn。\n"));
    return;
  }
  for (const turn of result.turns) {
    const marker = turn.current ? "*" : " ";
    const parent = turn.parentTurnId ? ` <- ${turn.parentTurnId}` : "";
    process.stdout.write(`${marker} ${turn.sequence}. ${turn.prompt?.replace(/\s+/g, " ").trim() || "-"}\n`);
    process.stdout.write(`    ${turn.turnId}${parent}\n`);
  }
}

function printTaskShellResult(result: TaskShellControlData): void {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (!result.stdout && !result.stderr) process.stdout.write(cliText("(no output)\n", "（无输出）\n"));
  if (result.timedOut) process.stderr.write(cliText("Command timed out after 120 seconds.\n", "命令在 120 秒后超时。\n"));
}

function printTaskDirectory(result: TaskDirectoryControlData): void {
  process.stdout.write(`${cliText("Directory: ", "目录：")}${result.directory}\n`);
  if (result.parentDirectory) process.stdout.write(`  [D] .. -> ${result.parentDirectory}\n`);
  for (const entry of result.entries) {
    const marker = entry.kind === "directory" || entry.kind === "drive"
      ? "D"
      : entry.kind === "image"
        ? "I"
        : entry.kind === "binary"
          ? "B"
          : "F";
    process.stdout.write(`  [${marker}] ${entry.name}\n`);
  }
  process.stdout.write(cliText(
    `Page ${result.page + 1}/${result.totalPages}; ${result.totalEntries} entries.\n`,
    `第 ${result.page + 1}/${result.totalPages} 页；共 ${result.totalEntries} 项。\n`,
  ));
}

async function outputTaskStatus(
  sqlitePath: string,
  store: StateStore,
  session: SessionRecord,
  json: boolean,
): Promise<void> {
  const endpoint = controlEndpoint(sqlitePath);
  let live: TaskStatusControlData | undefined;
  let response: ControlResponse | undefined;
  try {
    response = await sendControlRequest(endpoint, {
      action: "task_status",
      localSessionId: session.localSessionId,
    });
  } catch {
    // The server can be stopped or still run an older control protocol
    // while a safe restart is pending. Preserve the local read-only fallback.
  }
  if (response) {
    ensureOk(response);
    live = response.data as TaskStatusControlData;
  }
  const statusSession = live?.session ?? session;
  const snapshot = live?.snapshot
    ?? (statusSession.lastTurnId ? store.getTurnSnapshot(statusSession.lastTurnId) : undefined);
  const result = { ...statusSession, snapshot, ...(live?.remote ? { remote: live.remote } : {}) };
  if (json) printJson(result);
  else printTaskStatus(statusSession, snapshot, live?.remote);
}

function filterSessions(sessions: SessionRecord[], args: string[], aliasSearchTerm?: string): SessionRecord[] {
  const context = optionValue(args, "--context");
  const status = optionValue(args, "--status");
  const search = (optionValue(args, "--search") ?? aliasSearchTerm)?.trim().toLowerCase();
  return sessions.filter((session) =>
    (!context || session.contextKey === context)
    && (!status || session.status === status || session.lastTurnStatus === status)
    && (!search || [
      session.localSessionId,
      session.remoteSessionId,
      session.acpSessionId,
      session.title,
      session.agentName,
      session.cwd,
    ].some((value) => value?.toLowerCase().includes(search))));
}

function taskSessionsSearchTerm(args: string[]): string | undefined {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--json") continue;
    if (value === "--context" || value === "--status" || value === "--search") {
      index += 1;
      continue;
    }
    if (!value.startsWith("--")) positionals.push(value);
  }
  return positionals.join(" ").trim() || undefined;
}

function printTaskList(sessions: SessionRecord[]): void {
  process.stdout.write(formatTaskList(sessions, cliLanguage, currentAppServerThreadIds(process.env)));
}

function printTaskStatus(session: SessionRecord, snapshot: unknown, remote?: TaskStatusControlData["remote"]): void {
  process.stdout.write(`${cliText("Title: ", "标题：")}${session.title ?? cliText("Untitled task", "未命名任务")}\n`);
  process.stdout.write(`${cliText("Agent: ", "Agent：")}${session.agentName}\n`);
  process.stdout.write(`${cliText("Task ID: ", "任务 ID：")}${session.remoteSessionId ?? session.acpSessionId ?? session.localSessionId}\n`);
  process.stdout.write(`${cliText("Local ID: ", "本地 ID：")}${session.localSessionId}\n`);
  process.stdout.write(`${cliText("Context: ", "上下文：")}${session.contextKey}\n`);
  process.stdout.write(`${cliText("Status: ", "状态：")}${taskStateLabel(session.status)} / ${taskStateLabel(session.lastTurnStatus)}\n`);
  process.stdout.write(`${cliText("Directory: ", "目录：")}${session.cwd}\n`);
  process.stdout.write(`${cliText("Last turn: ", "上一轮：")}${session.lastTurnId ?? "-"}\n`);
  let displayedFinalResponse: string | undefined;
  if (snapshot && typeof snapshot === "object") {
    const state = snapshot as Record<string, unknown>;
    if (typeof state.durationMs === "number") {
      process.stdout.write(`${cliText("Duration: ", "耗时：")}${Math.round(state.durationMs / 1_000)}s\n`);
    }
    if (typeof state.totalTokens === "number") {
      process.stdout.write(`${cliText("Tokens: ", "Tokens：")}${state.totalTokens}\n`);
    }
    if (typeof state.totalToolCount === "number") {
      process.stdout.write(`${cliText("Tool calls: ", "工具调用：")}${state.totalToolCount}\n`);
    }
    if (typeof state.finalResponse === "string" && state.finalResponse.trim()) displayedFinalResponse = state.finalResponse.trim();
  }
  if (!snapshot && remote?.lastTurnToolCount !== undefined) {
    process.stdout.write(`${cliText("Tool calls: ", "工具调用：")}${remote.lastTurnToolCount}\n`);
  }
  displayedFinalResponse = remote?.finalResponse?.trim() || displayedFinalResponse;
  if (displayedFinalResponse) {
    process.stdout.write(`${cliText("Final response:\n", "最终回答：\n")}${displayedFinalResponse}\n`);
  }
}

function printSkillStatus(status: SkillRegistrationStatus): void {
  process.stdout.write(`${cliText("Agent Bot Skill: ", "Agent Bot Skill：")}${status.registered ? cliText("installed", "已安装") : cliText("not installed", "未安装")}\n`);
  process.stdout.write(`${cliText("System directory: ", "系统目录：")}${status.skillsRoot}\n`);
  process.stdout.write(`${cliText("Installation path: ", "安装路径：")}${status.targetPath}\n`);
  if (status.registered) {
    process.stdout.write(`${cliText("Ownership: ", "所有权：")}${status.managed
      ? cliText("managed by Agent Bot", "由 Agent Bot 管理")
      : cliText("external directory (will not be modified or removed)", "外部目录（不会修改或删除）")}\n`);
    process.stdout.write(`${cliText("Version: ", "版本：")}${status.upToDate
      ? cliText("up to date", "已是最新")
      : cliText("update required", "需要更新")}\n`);
  }
}

function printInitializationPaths(result: InitializationResult, ui: InitUi): void {
  if (ui.interactive) {
    const lines = [
      ...(result.reset
        ? [`${cliText("Reset backup", "重置备份")}: ${result.reset.backupPath}`]
        : []),
      `${cliText("Home directory", "主目录")}: ${result.home.path} (${initializationStatusLabel(result.home.status)})`,
      `${cliText("Config file", "配置文件")}: ${result.config.path} (${initializationStatusLabel(result.config.status)})`,
      `${cliText("Environment file", "环境文件")}: ${result.env.path} (${initializationStatusLabel(result.env.status)})`,
      `${cliText("Data directory", "数据目录")}: ${result.data.path} (${initializationStatusLabel(result.data.status)})`,
      `${cliText("Log directory", "日志目录")}: ${result.logs.path} (${initializationStatusLabel(result.logs.status)})`,
    ];
    ui.note(cliText("Profile", "Profile"), lines.join("\n"));
    return;
  }
  process.stdout.write(cliText(
    "Profile setup\n",
    "Profile 设置\n",
  ));
  if (result.reset) {
    process.stdout.write(`${cliText("Reset backup: ", "重置备份：")}${result.reset.backupPath}\n`);
  }
  process.stdout.write(`${cliText("Home directory: ", "主目录：")}${result.home.path} (${initializationStatusLabel(result.home.status)})\n`);
  process.stdout.write(`${cliText("Config file: ", "配置文件：")}${result.config.path} (${initializationStatusLabel(result.config.status)})\n`);
  process.stdout.write(`${cliText("Environment file: ", "环境文件：")}${result.env.path} (${initializationStatusLabel(result.env.status)})\n`);
  process.stdout.write(`${cliText("Data directory: ", "数据目录：")}${result.data.path} (${initializationStatusLabel(result.data.status)})\n`);
  process.stdout.write(`${cliText("Log directory: ", "日志目录：")}${result.logs.path} (${initializationStatusLabel(result.logs.status)})\n`);
}

function printInitializationResult(
  result: Omit<InitCommandResult, "server" | "welcome">,
  ui: InitUi,
): void {
  if (ui.interactive) {
    const feishuStatus = result.feishu.status === "created"
      ? cliText(`created (${result.feishu.appId})`, `已创建（${result.feishu.appId}）`)
      : result.feishu.status === "existing"
        ? cliText(`existing (${result.feishu.appId})`, `已配置（${result.feishu.appId}）`)
        : cliText("skipped", "已跳过");
    const configuration = result.feishu.configuration;
    const configurationStatus = configuration?.status === "partial"
      ? cliText("partially configured", "部分配置未完成")
      : configuration
        ? cliText("ready", "已就绪")
        : cliText("not checked", "未检查");
    ui.note(cliText("Initialization summary", "初始化摘要"), [
      `${cliText("Configured Agents", "已配置 Agent")}: ${result.configuredAgents.join(", ")}`,
      `${cliText("Default Agent", "默认 Agent")}: ${result.defaultAgent.name}`,
      `${cliText("Group messages", "群消息")}: ${result.groupMessages.mode === "all"
        ? cliText("receive all", "接收所有消息")
        : cliText("require @ mention", "需要 @ 机器人")}`,
      `${cliText("Lark bot", "飞书机器人")}: ${feishuStatus}`,
      `${cliText("Lark configuration", "飞书配置")}: ${configurationStatus}`,
      `${cliText("AgentBot Skill", "AgentBot Skill")}: ${result.skill.status.targetPath}`,
      `${cliText("Config file", "配置文件")}: ${result.config.path}`,
    ].join("\n"));
    if (configuration?.status === "partial") {
      ui.warn(cliText(
        "Initialization continued with some unavailable Lark features.",
        "部分飞书功能尚不可用，但初始化已继续。",
      ));
      for (const feature of feishuAffectedFeatures(configuration.remaining)) {
        ui.warn(`${cliText("Affected feature", "受影响功能")}: ${feature}`);
      }
    }
    return;
  }
  process.stdout.write(cliText(
    "\nAgent Bot initialization completed.\n",
    "\nAgent Bot 初始化完成。\n",
  ));
  process.stdout.write(`${cliText("Configured Agents: ", "已配置 Agent：")}${result.configuredAgents.join(", ")}\n`);
  process.stdout.write(`${cliText("Default Agent: ", "默认 Agent：")}${result.defaultAgent.name}\n`);
  process.stdout.write(cliText(
    `Group message response: ${result.groupMessages.mode === "all" ? "receive all group messages" : "require an explicit @ mention"}\n`,
    `群消息响应方式：${result.groupMessages.mode === "all" ? "接收所有群消息" : "必须明确 @ 机器人"}\n`,
  ));
  process.stdout.write(result.skill.updated
    ? `${cliText("Agent Bot Skill: installed or updated at ", "Agent Bot Skill：已安装或更新至 ")}${result.skill.status.targetPath}\n`
    : `${cliText("Agent Bot Skill: already up to date at ", "Agent Bot Skill：已是最新版本，位于 ")}${result.skill.status.targetPath}\n`);
  if (result.feishu.status === "created") {
    process.stdout.write(cliText(
      `Lark app: created and credentials saved (${result.feishu.appId})\n`,
      `飞书应用：已创建并保存凭据 (${result.feishu.appId})\n`,
    ));
  } else if (result.feishu.status === "existing") {
    process.stdout.write(cliText(
      `Lark app: already configured and unchanged (${result.feishu.appId})\n`,
      `飞书应用：已配置，未做修改 (${result.feishu.appId})\n`,
    ));
  } else {
    process.stdout.write(cliText(
      "Lark app: skipped; use Console mode or run init again later.\n",
      "飞书应用：已跳过；请使用 Console 模式或稍后重新运行 init。\n",
    ));
  }
  if (result.feishu.userOpenIdStatus === "pending") {
    process.stdout.write(cliText(
      "Lark user: pending; send the bot a direct message to save FEISHU_USER_OPEN_ID\n",
      "飞书用户：等待补全；请私聊机器人以保存 FEISHU_USER_OPEN_ID\n",
    ));
  }
  if (result.feishu.configuration?.status === "updated") {
    const added = result.feishu.configuration.added;
    process.stdout.write(cliText(
      `Lark configuration: added ${added.scopes.length} scopes, ${added.events.length} events, and ${added.callbacks.length} callbacks\n`,
      `飞书配置：已新增 ${added.scopes.length} 项权限、${added.events.length} 个事件和 ${added.callbacks.length} 个回调\n`,
    ));
  } else if (result.feishu.configuration?.status === "partial") {
    const configuration = result.feishu.configuration;
    const addedCount =
      configuration.added.scopes.length + configuration.added.events.length + configuration.added.callbacks.length;
    if (addedCount > 0) {
      process.stdout.write(cliText(
        `Lark configuration: initialization continued with missing configuration; added ${configuration.added.scopes.length} scopes, ${configuration.added.events.length} events, and ${configuration.added.callbacks.length} callbacks\n`,
        `飞书配置：仍有配置缺失，初始化已继续；新增 ${configuration.added.scopes.length} 项权限、${configuration.added.events.length} 个事件和 ${configuration.added.callbacks.length} 个回调\n`,
      ));
    } else {
      process.stdout.write(cliText(
        "Lark configuration: initialization continued with missing configuration\n",
        "飞书配置：仍有配置缺失，初始化已继续\n",
      ));
    }
    printFeishuConfigurationWarnings(configuration.remaining);
  } else if (result.feishu.configuration?.status === "ready") {
    process.stdout.write(cliText(
      "Lark configuration: scopes, events, and callbacks are ready\n",
      "飞书配置：权限、事件和回调均已就绪\n",
    ));
  }
  process.stdout.write(`${cliText("Config file: ", "配置文件：")}${result.config.path}\n`);
}

function printInitializationServerResult(result: InitCommandResult["server"], ui: InitUi): void {
  if (result.status === "skipped") {
    const message = cliText(
      "Agent Bot server: skipped (Lark is not configured; Console mode is available)",
      "Agent Bot 服务：已跳过（未配置飞书；可使用 Console 模式）",
    );
    if (ui.interactive) ui.warn(message);
    else process.stdout.write(`${message}\n`);
    return;
  }
  if (result.status === "restart-scheduled") {
    const message = cliText(
      "Agent Bot server: safe restart scheduled to load the current version.",
      "Agent Bot 服务：已安排安全重启，以加载当前版本。",
    );
    if (ui.interactive) ui.success(message);
    else process.stdout.write(`${message}\n`);
    return;
  }
  if (ui.interactive) {
    ui.success(result.status === "already-running"
      ? cliText("Agent Bot server is already running.", "Agent Bot 服务已在运行。")
      : cliText("Agent Bot server started.", "Agent Bot 服务已启动。"));
  } else {
    printServerStartResult(result);
  }
}

function printInitializationWelcomeResult(result: InitializationWelcomeResult, ui: InitUi): void {
  if (result.status === "sent") {
    const message = cliText(
      "Welcome card: sent to your Lark private chat.",
      "欢迎卡片：已发送到你的飞书私聊。",
    );
    if (ui.interactive) ui.success(message);
    else process.stdout.write(`${message}\n`);
    return;
  }
  if (result.status === "failed") {
    const message = cliText(
      `The private welcome card could not be sent: ${result.message}`,
      `无法发送私聊欢迎卡片：${result.message}`,
    );
    if (ui.interactive) ui.warn(message);
    else process.stderr.write(`${cliText("Warning: ", "警告：")}${message}\n`);
    return;
  }
  if (result.reason === "missing-user-open-id") {
    const message = cliText(
      "The private welcome card was skipped because FEISHU_USER_OPEN_ID is not available. Send the bot a private message, then run agentbot init again.",
      "尚未获得 FEISHU_USER_OPEN_ID，无法发送私聊欢迎卡片。请先私聊机器人，再次运行 agentbot init。",
    );
    if (ui.interactive) ui.warn(message);
    else process.stderr.write(`${cliText("Warning: ", "警告：")}${message}\n`);
  }
}

function printServerStartResult(result: ServerStartResult): void {
  process.stdout.write(
    result.status === "already-running"
      ? cliText("Agent Bot server is already running.\n", "Agent Bot 服务已在运行。\n")
      : cliText("Agent Bot server started.\n", "Agent Bot 服务已启动。\n"),
  );
}

function printFeishuVerification(challenge: FeishuAppRegistrationChallenge, ui: InitUi): void {
  if (ui.interactive) {
    ui.note(
      cliText("Create Lark bot", "创建飞书机器人"),
      cliText(
        "Open the link below and confirm creation. AgentBot will save the App ID and App Secret after Lark returns them.",
        "请打开下方链接并确认创建。飞书返回 App ID 和 App Secret 后，AgentBot 会自动保存。",
      ),
    );
  }
  printVerificationLink(
    {
      verificationUrl: challenge.verificationUrl,
    },
  );
  const waiting = cliText(
    `The link expires in about ${Math.ceil(challenge.expiresIn / 60)} minutes. Waiting for confirmation...`,
    `链接将在约 ${Math.ceil(challenge.expiresIn / 60)} 分钟后过期，正在等待确认...`,
  );
  if (ui.interactive) ui.info(waiting);
  else process.stderr.write(`${waiting}\n`);
}

function printFeishuConfigurationVerification(
  challenge: FeishuConfigurationChallenge,
  ui: InitUi,
): void {
  const title = challenge.kind === "manual_scope"
    ? cliText("Manual Lark permission", "手动开通飞书权限")
    : cliText("Lark authorization required", "需要飞书授权");
  const details = [
    ...(challenge.missing.scopes.length > 0
      ? [`${cliText("Scopes", "权限")}: ${challenge.missing.scopes.join(", ")}`]
      : []),
    ...(challenge.missing.events.length > 0
      ? [`${cliText("Events", "事件")}: ${challenge.missing.events.join(", ")}`]
      : []),
    ...(challenge.missing.callbacks.length > 0
      ? [`${cliText("Callbacks", "回调")}: ${challenge.missing.callbacks.join(", ")}`]
      : []),
    formatFeishuConfigurationFeatureIntroduction(challenge.missing).trim(),
  ].filter(Boolean).join("\n");
  if (ui.interactive) {
    ui.note(title, details);
  } else {
    process.stderr.write(challenge.kind === "manual_scope"
      ? cliText(
          "\nThe following Lark permission must be added manually in Developer Console:\n",
          "\n必须在飞书开发者后台手动添加以下权限：\n",
        )
      : cliText(
          "\nThe Lark app is missing the following configuration:\n",
          "\n飞书应用缺少以下配置：\n",
        ));
    process.stderr.write(`${details}\n`);
  }
  printVerificationLink(
    {
      verificationUrl: challenge.verificationUrl,
      linkLabel: challenge.kind === "manual_scope"
        ? cliText("Permission page", "权限页面")
        : undefined,
    },
  );
  if (challenge.kind === "manual_scope") {
    const guidance = cliText(
      "Add the filtered permission, publish the app version, and complete tenant approval if required.",
      "请添加已筛选的权限、发布应用版本，并在需要时完成租户管理员审批。",
    );
    if (ui.interactive) ui.info(guidance);
    else process.stderr.write(`${guidance}\n`);
  }
  let waiting: string;
  if (challenge.kind === "manual_scope") {
    waiting = cliText(
      "Waiting up to 5 minutes for this permission to appear in the published app version...",
      "将等待最多 5 分钟，直到该权限出现在已发布的应用版本中...",
    );
  } else if (challenge.blocking) {
    waiting = cliText(
      "Waiting for the core scopes and message event to become active...",
      "正在等待核心权限和消息事件生效...",
    );
  } else {
    waiting = cliText(
      "Waiting up to 5 minutes for these optional items to become active...",
      "将等待最多 5 分钟，直到这些可选配置生效...",
    );
  }
  if (ui.interactive) ui.info(waiting);
  else process.stderr.write(`${waiting}\n`);
}

function printFeishuConfigurationWarnings(missing: FeishuConfigurationChallenge["missing"]): void {
  process.stdout.write(cliText(
    "Warning: some Lark configuration is not active, so some features may be unavailable.\n",
    "警告：部分飞书配置尚未生效，某些功能可能不可用。\n",
  ));
  if (missing.scopes.length > 0) {
    process.stdout.write(`${cliText("Inactive scopes: ", "未生效权限：")}${missing.scopes.join(", ")}\n`);
  }
  if (missing.events.length > 0) {
    process.stdout.write(`${cliText("Inactive events: ", "未生效事件：")}${missing.events.join(", ")}\n`);
  }
  if (missing.callbacks.length > 0) {
    process.stdout.write(`${cliText("Inactive callbacks: ", "未生效回调：")}${missing.callbacks.join(", ")}\n`);
  }
  for (const feature of feishuAffectedFeatures(missing)) {
    process.stdout.write(`${cliText("Affected feature: ", "受影响功能：")}${feature}\n`);
  }
}

function initializationStatusLabel(status: InitializationStatus): string {
  if (status === "created") return cliText("created", "已创建");
  if (status === "updated") return cliText("updated with missing settings", "已补全缺失配置");
  if (status === "reset") return cliText("reset from template", "已从模板重置");
  return cliText("already exists; unchanged", "已存在，未修改");
}

function ensureOk(response: ControlResponse): void {
  if (response.ok) return;
  const message = response.message?.trim();
  const matchesLanguage = cliLanguage === "zh"
    ? Boolean(message && /[一-龥]/u.test(message))
    : Boolean(message && !/[一-龥]/u.test(message));
  throw new Error(matchesLanguage
    ? message!
    : cliText(
        "Agent Bot control operation failed. Check the server logs for details.",
        "Agent Bot 控制操作失败，请查看服务日志了解详情。",
      ));
}

function requireCliGroupUser(userOpenId: string | undefined): asserts userOpenId is string {
  if (userOpenId?.startsWith("ou_")) return;
  throw new Error(cliText(
    "The profile has no authorizing Lark user to invite. Run agentbot init again or configure FEISHU_USER_OPEN_ID.",
    "当前 Profile 没有可邀请的飞书授权用户。请重新运行 agentbot init，或配置 FEISHU_USER_OPEN_ID。",
  ));
}

function taskGroupControlData(
  response: ControlResponse,
  preserveServerError = false,
): TaskGroupControlData {
  if (!response.ok && preserveServerError && response.message?.trim()) {
    throw new Error(response.message.trim());
  }
  ensureOk(response);
  const data = response.data as Partial<TaskGroupControlData> | undefined;
  if (
    !data
    || typeof data.sourceLocalSessionId !== "string"
    || !data.group
    || typeof data.group.chatId !== "string"
    || typeof data.group.contextKey !== "string"
    || typeof data.group.name !== "string"
    || !data.task
    || typeof data.task.localSessionId !== "string"
  ) {
    throw new Error(cliText(
      "Agent Bot returned an invalid task-group result.",
      "Agent Bot 返回了无效的任务群结果。",
    ));
  }
  return data as TaskGroupControlData;
}

function printTaskGroupResult(
  result: TaskGroupControlData,
  action: "newgroup" | "forkgroup",
): void {
  process.stdout.write(cliText(
    `${action === "forkgroup" ? "Fork group" : "Lark group"} created: ${result.group.name}\n`,
    `${action === "forkgroup" ? "Fork 群" : "飞书群"}已创建：${result.group.name}\n`,
  ));
  process.stdout.write(`${cliText("Chat ID: ", "群 ID：")}${result.group.chatId}\n`);
  process.stdout.write(`${cliText("Task ID: ", "任务 ID：")}${result.task.localSessionId}\n`);
  if (result.task.remoteSessionId) {
    process.stdout.write(`${cliText("Agent task ID: ", "Agent 任务 ID：")}${result.task.remoteSessionId}\n`);
  }
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(renderCliHelp(readPackageVersion()));
}
