import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LocalControlServer } from "./cli/LocalControlServer.js";
import {
  assertCompatibleTaskNewGroupRequest,
  controlEndpoint,
  type ControlRequest,
  type ControlResponse,
} from "./cli/controlProtocol.js";
import { readPackageVersion } from "./cli/packageVersion.js";
import { loadConfig } from "./config/loadConfig.js";
import { persistFeishuUserOpenIdIfMissing } from "./config/FeishuUserOpenIdStore.js";
import { writeAgentExecutionDefaults } from "./config/AgentExecutionDefaultsStore.js";
import {
  agentBotHome,
  defaultConfigPath,
  defaultDotEnvPath,
  resolveUserPath,
} from "./config/paths.js";
import { ConsoleConnector } from "./console/ConsoleConnector.js";
import { ConsoleTurnPresenter } from "./console/ConsoleTurnPresenter.js";
import { CardRenderer } from "./feishu/CardRenderer.js";
import { ConsoleFeishuClient } from "./feishu/ConsoleFeishuClient.js";
import { FeishuConnector } from "./feishu/FeishuConnector.js";
import { FeishuMessageClient } from "./feishu/FeishuMessageClient.js";
import { FeishuTurnPresenter } from "./feishu/FeishuTurnPresenter.js";
import { isThreadContextKey } from "./feishu/contextKey.js";
import type { MessageReplyTarget } from "./feishu/types.js";
import { requireServerFeishuTransport } from "./feishu/transport.js";
import { createLogger } from "./logging/logger.js";
import { OutboundRouter, type OutboundRoute } from "./presentation/OutboundRouter.js";
import { ProxySessionController } from "./proxy/ProxySessionController.js";
import type { AgentEnvironmentContext } from "./runtime/agentEnvironment.js";
import { createAgentRuntimeRegistry } from "./runtime/createAgentRuntimeRegistry.js";
import { StateStore } from "./state/StateStore.js";
import { StartupNotifier } from "./startup/StartupNotifier.js";
import { SessionMetadataHydrator } from "./startup/SessionMetadataHydrator.js";
import { startFeishu } from "./startup/startFeishu.js";
import { STOP_EXIT_CODE } from "./supervision/restartPolicy.js";
import {
  RESTART_GROUP_CONTEXTS_ENV,
  RESTART_NOTIFICATION_TARGETS_ENV,
  replacementSupervisorEnvironment,
  restartGroupContextKeysFromEnvironment,
  restartNotificationTargetsFromEnvironment,
} from "./supervision/replacementSupervisor.js";
import { SafeRestartScheduler } from "./supervision/SafeRestartScheduler.js";
import type { RestartNotificationTarget } from "./supervision/SafeRestartScheduler.js";
import { SafeRestartNotifier } from "./supervision/SafeRestartNotifier.js";
import { privateRestartNotificationTarget } from "./supervision/restartNotificationTarget.js";
import { LocalFileViewerServer } from "./local-files/LocalFileViewerServer.js";
import {
  nodeDiagnosticReportArguments,
  prepareCrashReportDirectory,
  resolveSupervisorDiagnosticsPaths,
} from "./supervision/SupervisorDiagnostics.js";
import { refreshedSystemEnvironment } from "./supervision/systemEnvironment.js";
import {
  assertSelfUpdatePlanPath,
  launchSelfUpdateRunner,
  readPendingSelfUpdate,
  releaseSelfUpdatePlan,
} from "./cli/SelfUpdater.js";

const processStartedAt = new Date();
const agentBotVersion = readPackageVersion();
const supervised = process.env.AGENT_BOT_SUPERVISED === "1";
const startupReason = process.env.AGENT_BOT_RESTART_REASON?.trim()
  || (supervised ? "Supervisor 启动" : "直接启动");
const restartNotificationTargets = mergeRestartNotificationTargets(
  restartNotificationTargetsFromEnvironment(process.env[RESTART_NOTIFICATION_TARGETS_ENV]),
  restartGroupContextKeysFromEnvironment(process.env[RESTART_GROUP_CONTEXTS_ENV])
    .map((contextKey) => ({ contextKey })),
);
const consoleOnly = process.env.AGENT_BOT_CONSOLE_ONLY === "1";
const config = loadConfig();
const transport = consoleOnly ? "console" : requireServerFeishuTransport(config.feishu);
const logger = createLogger(config);
const store = new StateStore(config.storage.sqlitePath);
let localFileViewer: LocalFileViewerServer | undefined;
if (config.fileViewer.enabled) {
  const viewer = new LocalFileViewerServer({
    host: config.fileViewer.host,
    port: config.fileViewer.port,
    publicBaseUrl: config.fileViewer.publicBaseUrl,
    stateDirectory: path.join(path.dirname(config.storage.sqlitePath), "file-viewer"),
  });
  try {
    const address = await viewer.start();
    localFileViewer = viewer;
    logger.info(address, "Local file viewer started.");
  } catch (error) {
    logger.warn({ error }, "Local file viewer failed to start; local file links will remain plain text.");
  }
}

const configuredConfigPath = process.env.AGENT_BOT_CONFIG?.trim();
const activeConfigPath = configuredConfigPath ? resolveUserPath(configuredConfigPath) : defaultConfigPath();
const agentEnvironmentContext: AgentEnvironmentContext = {
  profilePath: agentBotHome(),
  configPath: activeConfigPath,
  larkAppId: config.feishu.appId,
  larkUserOpenId: config.feishu.userOpenId,
};
const runtimes = createAgentRuntimeRegistry(config, logger, agentEnvironmentContext);

const routes: OutboundRoute[] = [];
let feishuConnector: FeishuConnector | undefined;
let consoleConnector: ConsoleConnector | undefined;
let startupNotifier: StartupNotifier | undefined;
let safeRestartNotifier: SafeRestartNotifier | undefined;
let controlServer: LocalControlServer | undefined;
let serverReady = false;

const feishuOutbound = transport === "sdk" ? new FeishuMessageClient(config, logger) : undefined;
if (feishuOutbound) {
  const renderer = new CardRenderer({ thinkingCardLayout: config.feishu.thinkingCardLayout });
  const presenter = new FeishuTurnPresenter(feishuOutbound, store, renderer, {
    normalIntervalMs: 2_000,
    criticalGapMs: 500,
    onError: (error) => logger.warn({ error }, "Failed to update Agent progress card."),
    localFileUrl: (filePath, reference) => localFileViewer?.createFileUrl(filePath, reference),
  });
  routes.push({ matches: (contextKey) => !contextKey.startsWith("console:"), outbound: feishuOutbound, presenter });
  const defaultAgentName = config.defaults.agent!;
  const defaultAgent = config.agents[defaultAgentName];
  const metadataHydrator = new SessionMetadataHydrator(store, runtimes);
  startupNotifier = new StartupNotifier(store, feishuOutbound, renderer, logger, {
    agentBotVersion,
    defaultAgentName,
    defaultAgentTitle: defaultAgent?.title ?? defaultAgentName,
    cwd: path.resolve(config.defaults.cwd),
    workspaceKind: defaultAgent?.kind === "app-server" ? "projectless" : "project",
    defaultUserOpenId: config.feishu.userOpenId,
  }, metadataHydrator);
  safeRestartNotifier = new SafeRestartNotifier(store, feishuOutbound, renderer, logger);
}

const consoleEnabled = consoleOnly || config.console.enabled || transport === "console";
const consoleOutbound = consoleEnabled ? new ConsoleFeishuClient() : undefined;
if (consoleOutbound) {
  routes.push({
    matches: (contextKey) => contextKey.startsWith("console:"),
    outbound: consoleOutbound,
    presenter: new ConsoleTurnPresenter(consoleOutbound),
  });
}

if (routes.length === 0) throw new Error("Neither Feishu nor console input is enabled.");
const outbound = new OutboundRouter(routes);
let shuttingDown = false;
let restartRequested = false;
let pendingSelfUpdatePlanPath: string | undefined;
const safeRestart = new SafeRestartScheduler({
  readActivity: () => store.getServerActivityState(),
  onReady: (reason, notificationTargets) => pendingSelfUpdatePlanPath
    ? initiateSelfUpdate(reason, notificationTargets)
    : initiateRestart(reason, notificationTargets),
  onStatus: (status) => safeRestartNotifier?.update(status),
  onStatusError: (error) => logger.warn({ error }, "Failed to publish safe restart status."),
});
const controller = new ProxySessionController(config, store, runtimes, outbound, logger, {
  supervised,
  restart: requestRestart,
  cancelSafeRestart: async (scheduleId) => {
    const cancelled = await safeRestart.cancelScheduled(scheduleId);
    if (cancelled && pendingSelfUpdatePlanPath) {
      releaseSelfUpdatePlan(pendingSelfUpdatePlanPath);
      pendingSelfUpdatePlanPath = undefined;
    }
    return cancelled;
  },
  rememberFeishuUserOpenId: (userOpenId) => {
    if (config.feishu.userOpenId?.startsWith("ou_")) return;
    const persisted = persistFeishuUserOpenIdIfMissing(defaultDotEnvPath(), userOpenId);
    config.feishu.userOpenId = persisted.userOpenId;
    agentEnvironmentContext.larkUserOpenId = persisted.userOpenId;
    process.env.FEISHU_USER_OPEN_ID = persisted.userOpenId;
    logger.info(
      { status: persisted.status },
      "Stored the default Lark user Open ID from the first private chat message.",
    );
  },
  persistAgentExecutionDefaults: (agentName, defaults) => {
    const changed = writeAgentExecutionDefaults(activeConfigPath, agentName, defaults);
    logger.info({ agentName, changed }, "Stored Agent execution defaults.");
  },
});

if (feishuOutbound) {
  feishuConnector = new FeishuConnector(
    config,
    controller,
    logger,
    undefined,
    (botOpenId) => { agentEnvironmentContext.larkBotOpenId = botOpenId; },
  );
}
if (consoleEnabled) consoleConnector = new ConsoleConnector(controller, logger);

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

const startControlServer = async (): Promise<void> => {
  if (consoleOnly || controlServer) return;
  controlServer = new LocalControlServer(
    controlEndpoint(config.storage.sqlitePath),
    handleControlRequest,
  );
  await controlServer.start();
  logger.info({ endpoint: controlEndpoint(config.storage.sqlitePath) }, "Local Agent Bot control endpoint started.");
};

if (feishuConnector && startupNotifier) {
  await startFeishu(
    feishuConnector,
    startupNotifier,
    processStartedAt,
    startupReason,
    startControlServer,
    () => { serverReady = true; },
    restartNotificationTargets,
  );
} else {
  await startControlServer();
  await feishuConnector?.start();
  serverReady = true;
}
await controller.recoverInterruptedTasks().catch((error: unknown) => {
  logger.error({ error }, "Startup task recovery failed; the server will remain available.");
});
consoleConnector?.start();
recoverPendingSelfUpdate();

function recoverPendingSelfUpdate(): void {
  const pending = readPendingSelfUpdate(agentBotHome());
  if (!pending || pendingSelfUpdatePlanPath || restartRequested || safeRestart.scheduled) return;
  let notificationTarget: RestartNotificationTarget | undefined;
  try {
    notificationTarget = inferServerRestartTarget(pending.plan.notificationSessionId);
  } catch (error) {
    logger.warn({ error }, "Could not restore the self-update notification target; update recovery will continue.");
  }
  pendingSelfUpdatePlanPath = pending.planPath;
  safeRestart.schedule(
    pending.plan.reason ?? `Resume Agent Bot update to ${pending.plan.toVersion}`,
    notificationTarget,
    {
      restartImmediatelyIfIdle: isServerIdle(store.getServerActivityState()),
    },
  );
  logger.warn(
    { planPath: pending.planPath, toVersion: pending.plan.toVersion },
    "Recovered a prepared Agent Bot self-update after Worker restart.",
  );
}

async function requestRestart(
  contextKey: string,
  force: boolean,
  replyTarget?: MessageReplyTarget,
): Promise<void> {
  const notificationTarget: RestartNotificationTarget = {
    contextKey,
    ...(replyTarget ? { replyMessageId: replyTarget.messageId } : {}),
  };
  if (restartRequested) {
    await outbound.sendText(contextKey, "Agent Bot 已在重启中，请稍候。").catch(() => undefined);
    return;
  }
  if (pendingSelfUpdatePlanPath) {
    await outbound.sendText(contextKey, "Agent Bot 更新已在等待中；更新完成后服务会自动恢复。").catch(() => undefined);
    return;
  }
  if (force) {
    await initiateRestart("用户执行 /restart --force 命令", [notificationTarget]);
    return;
  }
  const newlyScheduled = safeRestart.schedule("用户执行 /restart 命令", notificationTarget);
  await outbound.sendText(
    contextKey,
    newlyScheduled
      ? "已安排安全重启。Agent Bot 会等待所有任务完成、最终结果投递完成，并保持 5 秒无新消息后重启。"
      : "安全重启已在等待中；当前会话已加入通知范围，并已更新重启原因。",
  ).catch((error: unknown) => {
    logger.warn({ error, contextKey }, "Failed to send safe restart acknowledgement.");
  });
}

async function initiateRestart(
  reason: string,
  notificationTargets: RestartNotificationTarget[] = [],
): Promise<void> {
  if (restartRequested) {
    await sendRestartTexts(notificationTargets, "Agent Bot 已在重启中，请稍候。");
    return;
  }
  restartRequested = true;
  pendingSelfUpdatePlanPath = undefined;
  await safeRestart.cancelCurrent();
  await safeRestartNotifier?.flush();
  const allNotificationTargets = mergeRestartNotificationTargets(
    notificationTargets,
    safeRestartNotifier?.getNotificationTargets() ?? [],
  );
  await sendRestartTexts(
    allNotificationTargets,
    "Agent Bot 正在重启，恢复在线后会发送启动状态通知。",
  );
  setTimeout(() => void shutdown(
    supervised ? STOP_EXIT_CODE : 0,
    reason,
    allNotificationTargets,
  ), 100);
}

async function initiateSelfUpdate(
  reason: string,
  notificationTargets: RestartNotificationTarget[] = [],
): Promise<void> {
  if (restartRequested) {
    await sendRestartTexts(notificationTargets, "Agent Bot 已在重启或更新中，请稍候。");
    return;
  }
  const planPath = pendingSelfUpdatePlanPath;
  if (!planPath) return;
  restartRequested = true;
  await safeRestartNotifier?.flush();
  const allNotificationTargets = mergeRestartNotificationTargets(
    notificationTargets,
    safeRestartNotifier?.getNotificationTargets() ?? [],
  );
  await sendRestartTexts(
    allNotificationTargets,
    "Agent Bot 正在更新，完成或回滚后会自动恢复服务并发送启动状态通知。",
  );
  const environmentRefresh = refreshedSystemEnvironment();
  if (environmentRefresh.error) {
    logger.warn({ error: environmentRefresh.error }, "Failed to refresh the environment for Agent Bot update.");
  }
  try {
    assertSelfUpdatePlanPath(planPath, agentBotHome());
    launchSelfUpdateRunner(planPath, {
      waitPids: [process.pid, ...(supervised ? [process.ppid] : [])],
      environment: replacementSupervisorEnvironment(
        reason,
        environmentRefresh.environment,
        allNotificationTargets,
      ),
    });
  } catch (error) {
    restartRequested = false;
    releaseSelfUpdatePlan(planPath);
    pendingSelfUpdatePlanPath = undefined;
    logger.error({ error, planPath }, "Failed to launch Agent Bot self-update; keeping the current service online.");
    await sendRestartTexts(
      allNotificationTargets,
      `Agent Bot 更新未启动，当前服务保持在线：${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  pendingSelfUpdatePlanPath = undefined;
  setTimeout(() => void shutdown(STOP_EXIT_CODE), 100);
}

async function handleControlRequest(request: ControlRequest): Promise<ControlResponse> {
  switch (request.action) {
    case "health":
      return {
        ok: true,
        data: {
          ready: serverReady,
          phase: serverReady ? "ready" : "connecting_feishu",
          pid: process.pid,
          startedAt: processStartedAt.toISOString(),
          supervised,
          feishuAppId: config.feishu.appId ?? null,
          agents: runtimes.entries().map(([name, runtime]) => {
            const processInfo = runtime.getProcessInfo?.() ?? {};
            return {
              name,
              title: config.agents[name]?.title ?? name,
              kind: config.agents[name]?.kind ?? runtime.kind,
              pid: processInfo.pid ?? null,
              version: processInfo.version ?? null,
            };
          }),
          safeRestartScheduled: safeRestart.scheduled,
          safeRestartReason: safeRestart.pendingReason,
          activity: store.getServerActivityState(),
        },
      };
    case "server_restart": {
      if (pendingSelfUpdatePlanPath) {
        return { ok: false, message: "An Agent Bot update is already pending." };
      }
      const notificationTarget = inferServerRestartTarget(request.notificationSessionId);
      if (request.mode === "safe") {
        const newlyScheduled = safeRestart.schedule(request.reason, notificationTarget);
        return {
          ok: true,
          message: newlyScheduled
            ? "Safe restart scheduled. It will run after all tasks finish and the server stays idle for 5 seconds."
            : "A safe restart is already pending. Its reason has been updated.",
        };
      }
      setTimeout(() => void initiateRestart(
        request.reason,
        notificationTarget ? [notificationTarget] : [],
      ), 25);
      return { ok: true, message: "Immediate restart requested." };
    }
    case "server_update": {
      if (restartRequested || pendingSelfUpdatePlanPath || safeRestart.scheduled) {
        return { ok: false, message: "A restart or update is already pending." };
      }
      assertSelfUpdatePlanPath(request.planPath, agentBotHome());
      const notificationTarget = inferServerRestartTarget(request.notificationSessionId);
      const restartImmediatelyIfIdle = isServerIdle(store.getServerActivityState());
      pendingSelfUpdatePlanPath = request.planPath;
      safeRestart.schedule(request.reason, notificationTarget, { restartImmediatelyIfIdle });
      return {
        ok: true,
        message: restartImmediatelyIfIdle
          ? "Agent Bot update will start immediately because the server is idle."
          : "Agent Bot update scheduled after active tasks finish and the server becomes idle.",
      };
    }
    case "server_stop":
      safeRestart.cancel();
      if (pendingSelfUpdatePlanPath) releaseSelfUpdatePlan(pendingSelfUpdatePlanPath);
      pendingSelfUpdatePlanPath = undefined;
      setTimeout(() => void shutdown(STOP_EXIT_CODE), 25);
      return { ok: true, message: "Agent Bot server stop requested." };
    case "task_status":
      return { ok: true, data: await controller.controlGetTaskStatus(request.localSessionId) };
    case "task_stop":
      return { ok: true, message: await controller.controlStopTask(request.localSessionId) };
    case "task_release":
      return { ok: true, data: await controller.controlReleaseTask(request.localSessionId) };
    case "task_archive":
      return { ok: true, data: await controller.controlArchiveTask(request.localSessionId) };
    case "task_dismiss":
      return { ok: true, data: await controller.controlDismissTask(request.localSessionId) };
    case "task_title":
      return { ok: true, message: await controller.controlSetTaskTitle(request.localSessionId, request.title) };
    case "task_prompt":
      return { ok: true, message: await controller.controlSendTaskPrompt(request.localSessionId, request.text) };
    case "task_new":
      return {
        ok: true,
        data: await controller.controlCreateTask(
          request.localSessionId,
          request.title,
          request.cwd,
          request.projectless === true,
          request.agentName,
        ),
      };
    case "task_fork":
      return { ok: true, data: await controller.controlForkTask(request.localSessionId) };
    case "task_switch":
      return {
        ok: true,
        data: await controller.controlSwitchTask(
          request.localSessionId,
          request.targetLocalSessionId,
          request.previous === true,
        ),
      };
    case "task_queue":
      return { ok: true, data: await controller.controlQueueTaskPrompt(request.localSessionId, request.text) };
    case "task_agent":
      return { ok: true, data: controller.controlTaskAgent(request.localSessionId, request.agentName) };
    case "task_settings":
      return {
        ok: true,
        data: await controller.controlTaskSettings(request.localSessionId, request.setting, request.value),
      };
    case "task_goal":
      return {
        ok: true,
        data: await controller.controlTaskGoal(
          request.localSessionId,
          request.goalAction,
          request.objective,
        ),
      };
    case "task_turns":
      return { ok: true, data: await controller.controlListTaskTurns(request.localSessionId) };
    case "task_reset":
      return { ok: true, data: await controller.controlResetTaskToTurn(request.localSessionId, request.turnId) };
    case "task_mute":
      return { ok: true, data: controller.controlTaskMute(request.localSessionId, request.enabled) };
    case "task_shell":
      return { ok: true, data: await controller.controlRunTaskShell(request.localSessionId, request.command) };
    case "task_directory":
      return {
        ok: true,
        data: await controller.controlListTaskDirectory(request.localSessionId, request.directory, request.page),
      };
    case "task_send_file":
      return { ok: true, data: { messageId: await controller.controlSendTaskFile(request.localSessionId, request.filePath) } };
    case "task_new_group": {
      assertCompatibleTaskNewGroupRequest(request);
      return {
        ok: true,
        data: await controller.controlCreateTaskGroup(
          request.localSessionId,
          request.title,
          config.feishu.userOpenId,
          request.cwd,
          request.projectless === true,
          request.agentName,
        ),
      };
    }
    case "task_new_group_session": {
      return {
        ok: true,
        data: await controller.controlCreateTaskGroup(
          request.localSessionId,
          request.title,
          config.feishu.userOpenId,
          undefined,
          false,
          request.agentName,
          { sessionId: request.sessionId },
        ),
      };
    }
    case "task_fork_group":
      return {
        ok: true,
        data: await controller.controlForkTaskGroup(
          request.localSessionId,
          request.title,
          config.feishu.userOpenId,
        ),
      };
  }
}

async function shutdown(
  exitCode: number,
  restartReason?: string,
  restartNotificationTargets: RestartNotificationTarget[] = [],
): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (pendingSelfUpdatePlanPath) {
    releaseSelfUpdatePlan(pendingSelfUpdatePlanPath);
    pendingSelfUpdatePlanPath = undefined;
  }
  logger.info({ exitCode }, "Shutting down Agent Bot.");
  safeRestart.cancel();
  feishuConnector?.stop();
  consoleConnector?.stop();
  controller.close();
  await Promise.race([
    outbound.flushAll().catch((error: unknown) => logger.warn({ error }, "Failed to flush presenters.")),
    delay(5_000),
  ]);
  runtimes.close();
  await controlServer?.close().catch((error: unknown) => logger.warn({ error }, "Failed to close local control endpoint."));
  await localFileViewer?.close().catch((error: unknown) => logger.warn({ error }, "Failed to close local file viewer."));
  store.close();
  if (restartReason) startReplacementSupervisor(restartReason, restartNotificationTargets);
  process.exit(exitCode);
}

function startReplacementSupervisor(
  restartReason: string,
  restartNotificationTargets: RestartNotificationTarget[],
): void {
  const supervisorEntry = fileURLToPath(new URL("./supervisor.js", import.meta.url));
  const reportDirectory = resolveSupervisorDiagnosticsPaths(config).crashReportDirectory;
  prepareCrashReportDirectory(reportDirectory);
  const environmentRefresh = refreshedSystemEnvironment();
  if (environmentRefresh.error) {
    logger.warn({ error: environmentRefresh.error }, "Failed to refresh the Windows environment for the replacement Supervisor.");
  } else if (environmentRefresh.refreshed) {
    logger.info(
      { pathChanged: environmentRefresh.pathChanged },
      "Refreshed the Windows environment for the replacement Supervisor.",
    );
  }
  const supervisor = spawn(process.execPath, [
    ...nodeDiagnosticReportArguments(reportDirectory),
    supervisorEntry,
  ], {
    cwd: process.cwd(),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: replacementSupervisorEnvironment(
      restartReason,
      environmentRefresh.environment,
      restartNotificationTargets,
    ),
  });
  supervisor.unref();
}

function inferControlRestartTarget(notificationSessionId?: string): RestartNotificationTarget | undefined {
  const requestedSessionId = notificationSessionId?.trim();
  if (requestedSessionId) {
    const requested = store.getSession(requestedSessionId)
      ?? store.findSessionByRemoteSessionId(requestedSessionId);
    if (!requested) throw new Error(`Cannot route restart notifications: unknown task ${requestedSessionId}.`);
    return restartNotificationTargetForSession(requested);
  }

  const runningSessions = store.listAllSessions().filter((session) => session.status === "running");
  const runningContexts = new Set(runningSessions.map((session) => session.contextKey));
  if (runningContexts.size > 1) {
    throw new Error(
      "Cannot determine which conversation requested the restart because multiple conversations are running. Pass --task <task>.",
    );
  }
  const contextKey = runningContexts.size === 1 ? runningContexts.values().next().value : undefined;
  const session = contextKey
    ? runningSessions.find((candidate) => candidate.contextKey === contextKey)
    : undefined;
  return session ? restartNotificationTargetForSession(session) : undefined;
}

function inferServerRestartTarget(notificationSessionId?: string): RestartNotificationTarget {
  if (notificationSessionId?.trim()) {
    const target = inferControlRestartTarget(notificationSessionId);
    if (target) return target;
  }
  return privateRestartNotificationTarget(config.feishu.userOpenId);
}

function isServerIdle(activity: { runningSessions: number; pendingFinalDeliveries: number }): boolean {
  return activity.runningSessions === 0 && activity.pendingFinalDeliveries === 0;
}

function restartNotificationTargetForSession(
  session: { localSessionId: string; contextKey: string },
): RestartNotificationTarget {
  const replyMessageId = isThreadContextKey(session.contextKey)
    ? store.findLatestMessageIdForSession(session.localSessionId, session.contextKey)
      ?? store.findLatestMessageIdForContext(session.contextKey)
    : undefined;
  if (isThreadContextKey(session.contextKey) && !replyMessageId) {
    throw new Error(
      "Cannot route restart notifications to the task topic because it has no message anchor. Send /restart in that topic instead.",
    );
  }
  return {
    contextKey: session.contextKey,
    ...(replyMessageId ? { replyMessageId } : {}),
  };
}

async function sendRestartText(target: RestartNotificationTarget, text: string): Promise<string | undefined> {
  if (isThreadContextKey(target.contextKey) && !target.replyMessageId) {
    throw new Error("Cannot send a restart notice to a topic without a reply message anchor.");
  }
  const replyTarget = target.replyMessageId
    ? { messageId: target.replyMessageId, replyInThread: true as const }
    : undefined;
  return outbound.withReplyTarget(target.contextKey, replyTarget, () =>
    outbound.sendText(target.contextKey, text));
}

async function sendRestartTexts(targets: RestartNotificationTarget[], text: string): Promise<void> {
  await Promise.all(targets.map(async (target) => {
    await sendRestartText(target, text).catch((error: unknown) => {
      logger.warn(
        { error, contextKey: target.contextKey },
        "Failed to send restart acknowledgement.",
      );
    });
  }));
}

function mergeRestartNotificationTargets(
  ...targetGroups: RestartNotificationTarget[][]
): RestartNotificationTarget[] {
  const targets = new Map<string, RestartNotificationTarget>();
  for (const target of targetGroups.flat()) {
    const existing = targets.get(target.contextKey);
    if (!existing || (!existing.replyMessageId && target.replyMessageId)) {
      targets.set(target.contextKey, { ...target });
    }
  }
  return [...targets.values()];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
