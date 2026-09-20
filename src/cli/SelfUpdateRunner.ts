import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SELF_UPDATE_PLAN_VERSION = 1;

export interface SelfUpdatePlan {
  schemaVersion: typeof SELF_UPDATE_PLAN_VERSION;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  packageRoot: string;
  candidateTarball: string;
  backupTarball: string;
  backupPackageRoot: string;
  lockPath: string;
  lockToken: string;
  pendingMarkerPath: string;
  databasePath: string;
  controlEndpoint: string;
  workingDirectory: string;
  restartService: boolean;
  reason?: string;
  notificationSessionId?: string;
  resultPath: string;
  logPath: string;
}

export interface SelfUpdateResult {
  status: "updated" | "rolled-back" | "failed";
  fromVersion: string;
  toVersion: string;
  activeVersion?: string;
  initialized?: boolean;
  serviceReady?: boolean;
  fallback?: "npm" | "backup";
  error?: string;
  rollbackError?: string;
  completedAt: string;
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface DatabaseBackup {
  directory: string;
  entries: Array<{ sourcePath: string; backupPath: string; existed: boolean }>;
}

export interface SelfUpdateRunnerDependencies {
  runNpm(args: string[], cwd: string): CommandResult;
  validatePackage(
    packageRoot: string,
    packageName: string,
    version: string,
  ): void;
  initializeProfile(packageRoot: string, cwd: string): CommandResult;
  startSupervisor(packageRoot: string, cwd: string): number | undefined;
  waitForServer(endpoint: string, timeoutMs: number): Promise<boolean>;
  stopServer(endpoint: string, supervisorPid?: number): Promise<void>;
  waitForProcesses(pids: number[], timeoutMs: number): Promise<void>;
  now(): Date;
}

export async function applySelfUpdatePlan(
  plan: SelfUpdatePlan,
  waitPids: number[] = [],
  dependencies: SelfUpdateRunnerDependencies = defaultDependencies,
): Promise<SelfUpdateResult> {
  validatePlan(plan);
  assertUpdateLock(plan);
  markUpdateRunning(plan);
  fs.mkdirSync(path.dirname(plan.logPath), { recursive: true });
  const log = (event: string, data: Record<string, unknown> = {}): void => {
    fs.appendFileSync(
      plan.logPath,
      `${JSON.stringify({
        timestamp: dependencies.now().toISOString(),
        event,
        ...data,
      })}\n`,
    );
  };

  try {
    log("update_started", {
      fromVersion: plan.fromVersion,
      toVersion: plan.toVersion,
      waitPids,
    });
    try {
      await dependencies.waitForProcesses(waitPids, 60_000);
    } catch (error) {
      return recoverBeforeInstallation(
        plan,
        errorMessage(error),
        dependencies,
        log,
      );
    }

    let databaseBackup: DatabaseBackup;
    try {
      databaseBackup = createDatabaseBackup(plan);
      log("database_backup_created", {
        directory: databaseBackup.directory,
        files: databaseBackup.entries.filter((entry) => entry.existed).length,
      });
    } catch (error) {
      return recoverBeforeInstallation(
        plan,
        `Could not back up Agent Bot state: ${errorMessage(error)}`,
        dependencies,
        log,
      );
    }

    let startedSupervisorPid: number | undefined;
    try {
      installTarball(
        plan.candidateTarball,
        plan.workingDirectory,
        dependencies,
        log,
      );
      dependencies.validatePackage(
        plan.packageRoot,
        plan.packageName,
        plan.toVersion,
      );
      initializeUpdatedProfile(plan, dependencies, log);
      if (plan.restartService) {
        startedSupervisorPid = dependencies.startSupervisor(
          plan.packageRoot,
          plan.workingDirectory,
        );
        if (!(await dependencies.waitForServer(plan.controlEndpoint, 60_000))) {
          throw new Error(
            "The updated Agent Bot service did not become ready within 60 seconds.",
          );
        }
      }
      const result: SelfUpdateResult = {
        status: "updated",
        fromVersion: plan.fromVersion,
        toVersion: plan.toVersion,
        activeVersion: plan.toVersion,
        initialized: true,
        ...(plan.restartService ? { serviceReady: true } : {}),
        completedAt: dependencies.now().toISOString(),
      };
      writeResult(plan.resultPath, result);
      log("update_completed", { ...result });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      log("update_failed", { error: message });
      if (plan.restartService) {
        await dependencies
          .stopServer(plan.controlEndpoint, startedSupervisorPid)
          .catch((stopError: unknown) => {
            log("updated_service_stop_failed", {
              error: errorMessage(stopError),
            });
          });
      }
      return rollback(plan, message, databaseBackup, dependencies, log);
    }
  } finally {
    releaseUpdateLock(plan);
  }
}

async function recoverBeforeInstallation(
  plan: SelfUpdatePlan,
  waitError: string,
  dependencies: SelfUpdateRunnerDependencies,
  log: (event: string, data?: Record<string, unknown>) => void,
): Promise<SelfUpdateResult> {
  log("update_aborted_before_install", { error: waitError });
  if (plan.restartService) {
    let ready = await dependencies.waitForServer(plan.controlEndpoint, 2_000);
    if (!ready) {
      process.env.AGENT_BOT_RESTART_REASON = `Agent Bot update aborted; running backup ${plan.fromVersion}`;
      dependencies.validatePackage(
        plan.backupPackageRoot,
        plan.packageName,
        plan.fromVersion,
      );
      dependencies.startSupervisor(
        plan.backupPackageRoot,
        plan.workingDirectory,
      );
      ready = await dependencies.waitForServer(plan.controlEndpoint, 60_000);
    }
    if (ready) {
      const result: SelfUpdateResult = {
        status: "rolled-back",
        fromVersion: plan.fromVersion,
        toVersion: plan.toVersion,
        activeVersion: plan.fromVersion,
        serviceReady: true,
        fallback: "backup",
        error: waitError,
        completedAt: dependencies.now().toISOString(),
      };
      writeResult(plan.resultPath, result);
      log("preinstall_recovery_completed", { ...result });
      return result;
    }
  }
  const result: SelfUpdateResult = {
    status: "failed",
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    error: waitError,
    completedAt: dependencies.now().toISOString(),
  };
  writeResult(plan.resultPath, result);
  log("preinstall_recovery_failed", { ...result });
  return result;
}

async function rollback(
  plan: SelfUpdatePlan,
  updateError: string,
  databaseBackup: DatabaseBackup,
  dependencies: SelfUpdateRunnerDependencies,
  log: (event: string, data?: Record<string, unknown>) => void,
): Promise<SelfUpdateResult> {
  let rollbackError: string | undefined;
  try {
    installTarball(
      plan.backupTarball,
      plan.workingDirectory,
      dependencies,
      log,
    );
    dependencies.validatePackage(
      plan.packageRoot,
      plan.packageName,
      plan.fromVersion,
    );
    restoreDatabase(databaseBackup);
    if (plan.restartService) {
      process.env.AGENT_BOT_RESTART_REASON = `Agent Bot update failed; restored ${plan.fromVersion}`;
      dependencies.startSupervisor(plan.packageRoot, plan.workingDirectory);
      if (!(await dependencies.waitForServer(plan.controlEndpoint, 60_000))) {
        throw new Error(
          "The restored Agent Bot service did not become ready within 60 seconds.",
        );
      }
    }
    const result: SelfUpdateResult = {
      status: "rolled-back",
      fromVersion: plan.fromVersion,
      toVersion: plan.toVersion,
      activeVersion: plan.fromVersion,
      ...(plan.restartService ? { serviceReady: true } : {}),
      fallback: "npm",
      error: updateError,
      completedAt: dependencies.now().toISOString(),
    };
    writeResult(plan.resultPath, result);
    log("rollback_completed", { ...result });
    return result;
  } catch (error) {
    rollbackError = errorMessage(error);
    log("npm_rollback_failed", { error: rollbackError });
  }

  if (plan.restartService) {
    try {
      dependencies.validatePackage(
        plan.backupPackageRoot,
        plan.packageName,
        plan.fromVersion,
      );
      restoreDatabase(databaseBackup);
      process.env.AGENT_BOT_RESTART_REASON = `Agent Bot update failed; running backup ${plan.fromVersion}`;
      dependencies.startSupervisor(
        plan.backupPackageRoot,
        plan.workingDirectory,
      );
      if (!(await dependencies.waitForServer(plan.controlEndpoint, 60_000))) {
        throw new Error(
          "The backup Agent Bot service did not become ready within 60 seconds.",
        );
      }
      const result: SelfUpdateResult = {
        status: "rolled-back",
        fromVersion: plan.fromVersion,
        toVersion: plan.toVersion,
        activeVersion: plan.fromVersion,
        serviceReady: true,
        fallback: "backup",
        error: updateError,
        rollbackError,
        completedAt: dependencies.now().toISOString(),
      };
      writeResult(plan.resultPath, result);
      log("backup_service_started", { ...result });
      return result;
    } catch (error) {
      rollbackError = `${rollbackError ?? "npm rollback failed"}; backup start failed: ${errorMessage(error)}`;
    }
  }

  const result: SelfUpdateResult = {
    status: "failed",
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    error: updateError,
    rollbackError,
    completedAt: dependencies.now().toISOString(),
  };
  writeResult(plan.resultPath, result);
  log("rollback_failed", { ...result });
  return result;
}

function installTarball(
  tarball: string,
  cwd: string,
  dependencies: SelfUpdateRunnerDependencies,
  log: (event: string, data?: Record<string, unknown>) => void,
): void {
  const result = dependencies.runNpm(
    ["install", "--global", "--no-audit", "--no-fund", tarball],
    cwd,
  );
  log("npm_install_finished", {
    tarball,
    status: result.status,
    stderr: result.stderr.trim().slice(-4_000),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `npm exited with ${result.status}.`,
    );
  }
}

function initializeUpdatedProfile(
  plan: SelfUpdatePlan,
  dependencies: SelfUpdateRunnerDependencies,
  log: (event: string, data?: Record<string, unknown>) => void,
): void {
  const result = dependencies.initializeProfile(plan.packageRoot, plan.workingDirectory);
  log("profile_initialization_finished", {
    status: result.status,
    stderr: result.stderr.trim().slice(-4_000),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim()
        || result.stdout.trim()
        || `agentbot init exited with ${result.status}.`,
    );
  }
}

export function validateInstalledPackage(
  packageRoot: string,
  packageName: string,
  version: string,
): void {
  const metadata = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as {
    name?: unknown;
    version?: unknown;
  };
  if (metadata.name !== packageName || metadata.version !== version) {
    throw new Error(
      `Installed package identity mismatch: expected ${packageName}@${version}, got ${String(metadata.name)}@${String(metadata.version)}.`,
    );
  }
  const cliEntry = path.join(packageRoot, "dist", "cli.js");
  const supervisorEntry = path.join(packageRoot, "dist", "supervisor.js");
  for (const required of [cliEntry, supervisorEntry]) {
    if (!fs.existsSync(required))
      throw new Error(`Updated package is missing ${required}.`);
  }
  const versionResult = runNode([cliEntry, "--version"], packageRoot);
  if (versionResult.status !== 0 || versionResult.stdout.trim() !== version) {
    throw new Error(
      `Updated CLI validation failed: ${versionResult.stderr.trim() || versionResult.stdout.trim()}.`,
    );
  }
  const helpResult = runNode([cliEntry, "--help"], packageRoot);
  if (helpResult.status !== 0 || !helpResult.stdout.includes("agentbot")) {
    throw new Error(
      `Updated CLI help validation failed: ${helpResult.stderr.trim() || helpResult.stdout.trim()}.`,
    );
  }
}

function startSupervisor(packageRoot: string, cwd: string): number | undefined {
  const child = spawn(
    process.execPath,
    [path.join(packageRoot, "dist", "supervisor.js")],
    {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: process.env,
    },
  );
  child.unref();
  return child.pid;
}

function initializeProfile(packageRoot: string, cwd: string): CommandResult {
  return runNode([
    path.join(packageRoot, "dist", "cli.js"),
    "init",
    "--skip-feishu",
    "--json",
  ], cwd);
}

async function waitForServer(
  endpoint: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await sendControlRequest(
      endpoint,
      { action: "health" },
      1_000,
    ).catch(() => undefined);
    if (
      response?.ok &&
      isRecord(response.data) &&
      response.data.ready !== false
    )
      return true;
    await delay(500);
  }
  return false;
}

async function stopServer(
  endpoint: string,
  supervisorPid?: number,
): Promise<void> {
  await sendControlRequest(endpoint, { action: "server_stop" }, 2_000).catch(
    () => undefined,
  );
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await endpointReachable(endpoint))) break;
    await delay(250);
  }
  if (supervisorPid) {
    try {
      process.kill(supervisorPid, "SIGTERM");
    } catch {
      // The Supervisor may already have exited.
    }
  }
  if (supervisorPid) {
    const processDeadline = Date.now() + 5_000;
    while (processExists(supervisorPid) && Date.now() < processDeadline)
      await delay(250);
  }
}

async function waitForProcesses(
  pids: number[],
  timeoutMs: number,
): Promise<void> {
  const remaining = new Set(
    pids.filter((pid) => Number.isInteger(pid) && pid > 0),
  );
  const deadline = Date.now() + timeoutMs;
  while (remaining.size > 0 && Date.now() < deadline) {
    for (const pid of remaining) {
      if (!processExists(pid)) remaining.delete(pid);
    }
    if (remaining.size > 0) await delay(250);
  }
  if (remaining.size > 0) {
    throw new Error(
      `Timed out waiting for Agent Bot processes to exit: ${[...remaining].join(", ")}.`,
    );
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

function sendControlRequest(
  endpoint: string,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ ok?: boolean; data?: unknown }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let settled = false;
    let input = "";
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      operation();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("Control request timed out."))),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(() =>
          resolve(
            JSON.parse(input.slice(0, newline)) as {
              ok?: boolean;
              data?: unknown;
            },
          ),
        );
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("end", () =>
      finish(() => reject(new Error("Control endpoint returned no response."))),
    );
  });
}

function endpointReachable(endpoint: string): Promise<boolean> {
  return sendControlRequest(endpoint, { action: "health" }, 500).then(
    () => true,
    () => false,
  );
}

export function runNpmCommand(args: string[], cwd: string): CommandResult {
  const npmCli = resolveNpmCli();
  if (npmCli) return runNode([npmCli, ...args], cwd);
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    args,
    {
      cwd,
      env: process.env,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      shell: process.platform === "win32",
    },
  );
  return commandResult(result);
}

function resolveNpmCli(): string | undefined {
  const candidates = [
    process.env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
    process.env.APPDATA
      ? path.join(
          process.env.APPDATA,
          "npm",
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        )
      : undefined,
  ];
  return candidates.find((candidate): candidate is string =>
    Boolean(candidate && fs.existsSync(candidate)),
  );
}

function runNode(args: string[], cwd: string): CommandResult {
  return commandResult(
    spawnSync(process.execPath, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
}

function commandResult(result: ReturnType<typeof spawnSync>): CommandResult {
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout:
      typeof result.stdout === "string"
        ? result.stdout
        : (result.stdout?.toString("utf8") ?? ""),
    stderr:
      typeof result.stderr === "string"
        ? result.stderr
        : (result.stderr?.toString("utf8") ?? ""),
    ...(result.error ? { error: result.error } : {}),
  };
}

function validatePlan(plan: SelfUpdatePlan): void {
  if (plan.schemaVersion !== SELF_UPDATE_PLAN_VERSION)
    throw new Error("Unsupported Agent Bot update plan.");
  for (const value of [
    plan.packageName,
    plan.fromVersion,
    plan.toVersion,
    plan.packageRoot,
    plan.candidateTarball,
    plan.backupTarball,
    plan.backupPackageRoot,
    plan.lockPath,
    plan.lockToken,
    plan.pendingMarkerPath,
    plan.databasePath,
    plan.controlEndpoint,
    plan.workingDirectory,
    plan.resultPath,
    plan.logPath,
  ]) {
    if (!value?.trim()) throw new Error("Agent Bot update plan is incomplete.");
  }
}

function createDatabaseBackup(plan: SelfUpdatePlan): DatabaseBackup {
  const directory = path.join(path.dirname(plan.resultPath), "database-backup");
  fs.mkdirSync(directory, { recursive: true });
  const sourcePaths = [
    plan.databasePath,
    `${plan.databasePath}-wal`,
    `${plan.databasePath}-shm`,
  ];
  const entries = sourcePaths.map((sourcePath, index) => {
    const existed = fs.existsSync(sourcePath);
    const backupPath = path.join(
      directory,
      `${index}-${path.basename(sourcePath)}`,
    );
    if (existed) fs.copyFileSync(sourcePath, backupPath);
    return { sourcePath, backupPath, existed };
  });
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    `${JSON.stringify({ entries }, null, 2)}\n`,
  );
  return { directory, entries };
}

function restoreDatabase(backup: DatabaseBackup): void {
  for (const entry of backup.entries) {
    fs.rmSync(entry.sourcePath, { force: true });
    if (!entry.existed) continue;
    fs.mkdirSync(path.dirname(entry.sourcePath), { recursive: true });
    fs.copyFileSync(entry.backupPath, entry.sourcePath);
  }
}

function assertUpdateLock(plan: SelfUpdatePlan): void {
  const lock = JSON.parse(fs.readFileSync(plan.lockPath, "utf8")) as {
    token?: unknown;
  };
  if (lock.token !== plan.lockToken)
    throw new Error("Agent Bot update lock is not owned by this operation.");
}

function releaseUpdateLock(plan: SelfUpdatePlan): void {
  try {
    const lock = JSON.parse(fs.readFileSync(plan.lockPath, "utf8")) as {
      token?: unknown;
    };
    if (lock.token === plan.lockToken)
      fs.rmSync(plan.lockPath, { force: true });
  } catch {
    // A missing or replaced lock belongs to no recoverable update operation.
  }
  try {
    const marker = JSON.parse(
      fs.readFileSync(plan.pendingMarkerPath, "utf8"),
    ) as { token?: unknown };
    if (marker.token === plan.lockToken)
      fs.rmSync(plan.pendingMarkerPath, { force: true });
  } catch {
    // A missing or replaced marker belongs to no recoverable update operation.
  }
}

function markUpdateRunning(plan: SelfUpdatePlan): void {
  fs.writeFileSync(
    plan.pendingMarkerPath,
    `${JSON.stringify(
      {
        token: plan.lockToken,
        phase: "running",
        planPath: path.join(path.dirname(plan.resultPath), "plan.json"),
        runnerPid: process.pid,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

function writeResult(resultPath: string, result: SelfUpdateResult): void {
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

function readPlan(planPath: string): SelfUpdatePlan {
  return JSON.parse(fs.readFileSync(planPath, "utf8")) as SelfUpdatePlan;
}

function writeFatalResult(
  plan: SelfUpdatePlan | undefined,
  error: unknown,
): void {
  if (!plan) return;
  const result: SelfUpdateResult = {
    status: "failed",
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    error: errorMessage(error),
    completedAt: new Date().toISOString(),
  };
  try {
    writeResult(plan.resultPath, result);
  } catch {
    // There is no further recovery path if even the result file cannot be written.
  }
}

function parseWaitPids(args: string[]): number[] {
  const pids: number[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--wait-pid") continue;
    const pid = Number(args[index + 1]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
    index += 1;
  }
  return pids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const defaultDependencies: SelfUpdateRunnerDependencies = {
  runNpm: runNpmCommand,
  validatePackage: validateInstalledPackage,
  initializeProfile,
  startSupervisor,
  waitForServer,
  stopServer,
  waitForProcesses,
  now: () => new Date(),
};

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const planPath = process.argv[2];
  let plan: SelfUpdatePlan | undefined;
  void (async () => {
    if (!planPath) throw new Error("Missing Agent Bot update plan path.");
    plan = readPlan(planPath);
    const result = await applySelfUpdatePlan(
      plan,
      parseWaitPids(process.argv.slice(3)),
    );
    if (result.status === "failed") process.exitCode = 1;
  })().catch((error: unknown) => {
    writeFatalResult(plan, error);
    process.exitCode = 1;
  });
}
