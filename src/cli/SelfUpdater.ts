import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentBotHome } from "../config/paths.js";
import { cliText } from "./i18n.js";
import { readPackageVersion } from "./packageVersion.js";
import {
  runNpmCommand,
  SELF_UPDATE_PLAN_VERSION,
  validateInstalledPackage,
  type SelfUpdatePlan,
} from "./SelfUpdateRunner.js";

export const AGENT_BOT_PACKAGE_NAME = "@keyou007/agent-bot";

export type SelfUpdateChannel = "alpha" | "latest";

export interface SelfUpdateOptions {
  channel?: SelfUpdateChannel;
  version?: string;
  allowDowngrade?: boolean;
}

export interface PendingSelfUpdate {
  planPath: string;
  plan: SelfUpdatePlan;
}

export type PrepareSelfUpdateResult =
  | {
      status: "current";
      currentVersion: string;
      targetVersion: string;
      channel: SelfUpdateChannel;
    }
  | {
      status: "prepared";
      currentVersion: string;
      targetVersion: string;
      channel: SelfUpdateChannel;
      planPath: string;
      runnerPath: string;
      logPath: string;
      resultPath: string;
    };

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface SelfUpdaterDependencies {
  packageRoot: string;
  home: string;
  runnerEntry: string;
  runNpm(args: string[], cwd: string): CommandResult;
  validatePackage(
    packageRoot: string,
    packageName: string,
    version: string,
  ): void;
  now(): Date;
  randomId(): string;
}

export function parseSelfUpdateOptions(input: string[]): SelfUpdateOptions & {
  json: boolean;
  taskReference?: string;
} {
  const options: SelfUpdateOptions & { json: boolean; taskReference?: string } =
    { json: false };
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index]!;
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (value === "--alpha") {
      if (options.channel && options.channel !== "alpha")
        throw conflictingChannelError();
      options.channel = "alpha";
      continue;
    }
    if (value === "--stable") {
      if (options.channel && options.channel !== "latest")
        throw conflictingChannelError();
      options.channel = "latest";
      continue;
    }
    if (value === "--allow-downgrade") {
      options.allowDowngrade = true;
      continue;
    }
    if (value === "--version" || value === "--task") {
      const next = input[index + 1]?.trim();
      if (!next || next.startsWith("--"))
        throw new Error(
          cliText(`${value} requires a value.`, `${value} 需要提供值。`),
        );
      if (value === "--version") options.version = next;
      else options.taskReference = next;
      index += 1;
      continue;
    }
    throw new Error(
      cliText(
        `Unsupported update option: ${value}`,
        `不支持的 update 选项：${value}`,
      ),
    );
  }
  if (options.version && options.channel)
    throw new Error(
      cliText(
        "--version cannot be combined with --alpha or --stable.",
        "--version 不能与 --alpha 或 --stable 同时使用。",
      ),
    );
  return options;
}

export async function prepareSelfUpdate(
  options: SelfUpdateOptions = {},
  dependencies: SelfUpdaterDependencies = defaultDependencies(),
): Promise<PrepareSelfUpdateResult> {
  const currentVersion = readVersionFromRoot(dependencies.packageRoot);
  const installation = requireNpmSelfUpdateInstallation(
    dependencies.packageRoot,
    dependencies.runNpm,
  );

  const channel = options.channel ?? defaultUpdateChannel(currentVersion);
  const targetVersion = options.version
    ? normalizeVersion(options.version)
    : resolvePublishedVersion(
        channel,
        dependencies.runNpm,
        dependencies.packageRoot,
      );
  const comparison = compareSemver(targetVersion, currentVersion);
  if (comparison === 0)
    return { status: "current", currentVersion, targetVersion, channel };
  if (comparison < 0 && !options.allowDowngrade)
    throw new Error(
      cliText(
        `Refusing to downgrade Agent Bot from ${currentVersion} to ${targetVersion}. Pass --allow-downgrade to confirm.`,
        `拒绝将 Agent Bot 从 ${currentVersion} 降级到 ${targetVersion}。如需确认降级，请传入 --allow-downgrade。`,
      ),
    );

  const lockToken = dependencies.randomId();
  const lockPath = acquireUpdateLock(
    installation.packageRoot,
    lockToken,
    dependencies.now(),
  );

  const operationName = `${timestamp(dependencies.now())}-${dependencies.randomId()}`;
  const operationRoot = path.join(dependencies.home, "updates", operationName);
  const downloadRoot = path.join(operationRoot, "packages");
  const candidateInstallRoot = path.join(operationRoot, "candidate");
  const backupPackageRoot = path.join(operationRoot, "backup", "package");
  const pendingMarkerPath = path.join(
    dependencies.home,
    "updates",
    "pending-update.json",
  );
  try {
    fs.mkdirSync(downloadRoot, { recursive: true });
    fs.mkdirSync(candidateInstallRoot, { recursive: true });
    fs.mkdirSync(path.dirname(backupPackageRoot), { recursive: true });

    const candidateTarball = packPackage(
      `${AGENT_BOT_PACKAGE_NAME}@${targetVersion}`,
      downloadRoot,
      dependencies.packageRoot,
      dependencies.runNpm,
    );
    runRequiredNpm(
      [
        "install",
        "--prefix",
        candidateInstallRoot,
        "--no-save",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        candidateTarball,
      ],
      dependencies.packageRoot,
      dependencies.runNpm,
    );
    const candidatePackageRoot = path.join(
      candidateInstallRoot,
      "node_modules",
      ...AGENT_BOT_PACKAGE_NAME.split("/"),
    );
    dependencies.validatePackage(
      candidatePackageRoot,
      AGENT_BOT_PACKAGE_NAME,
      targetVersion,
    );

    fs.cpSync(dependencies.packageRoot, backupPackageRoot, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
    });
    dependencies.validatePackage(
      backupPackageRoot,
      AGENT_BOT_PACKAGE_NAME,
      currentVersion,
    );
    const backupTarball = packPackage(
      dependencies.packageRoot,
      downloadRoot,
      dependencies.packageRoot,
      dependencies.runNpm,
      ["--ignore-scripts"],
    );

    const runnerPath = path.join(operationRoot, "update-runner.mjs");
    fs.copyFileSync(dependencies.runnerEntry, runnerPath);
    const planPath = path.join(operationRoot, "plan.json");
    const resultPath = path.join(operationRoot, "result.json");
    const logPath = path.join(operationRoot, "update.log");
    const plan: SelfUpdatePlan = {
      schemaVersion: SELF_UPDATE_PLAN_VERSION,
      packageName: AGENT_BOT_PACKAGE_NAME,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      packageRoot: installation.packageRoot,
      candidateTarball,
      backupTarball,
      backupPackageRoot,
      lockPath,
      lockToken,
      pendingMarkerPath,
      databasePath: "pending",
      controlEndpoint: "pending",
      workingDirectory: process.cwd(),
      restartService: false,
      resultPath,
      logPath,
    };
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    fs.writeFileSync(
      pendingMarkerPath,
      `${JSON.stringify(
        {
          token: lockToken,
          phase: "prepared",
          planPath,
          createdAt: dependencies.now().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    writeUpdateLock(lockPath, {
      token: lockToken,
      phase: "prepared",
      pid: process.pid,
      planPath,
      createdAt: dependencies.now().toISOString(),
    });
    return {
      status: "prepared",
      currentVersion,
      targetVersion,
      channel,
      planPath,
      runnerPath,
      logPath,
      resultPath,
    };
  } catch (error) {
    releaseSelfUpdateLock(lockPath, lockToken);
    releasePendingMarker(pendingMarkerPath, lockToken);
    throw error;
  }
}

export function requireNpmSelfUpdateInstallation(
  packageRoot = fileURLToPath(new URL("../../", import.meta.url)),
  runNpm: (args: string[], cwd: string) => CommandResult = runNpmCommand,
): { kind: "global"; packageRoot: string } {
  const installation = inspectNpmInstallation(packageRoot, runNpm);
  if (installation.kind === "linked")
    throw new Error(
      cliText(
        "Agent Bot is running from npm link or a linked source directory and will not update itself. Update the source checkout manually.",
        "Agent Bot 当前通过 npm link 或链接的源码目录运行，不会执行自更新。请手动更新源码目录。",
      ),
    );
  if (installation.kind !== "global")
    throw new Error(
      cliText(
        "Agent Bot is not running from a global npm installation and will not update itself. Update the source checkout manually.",
        "Agent Bot 当前不是通过 npm 全局安装运行，不会执行自更新。请手动更新源码目录。",
      ),
    );
  return { kind: "global", packageRoot: installation.packageRoot };
}

export function finalizeSelfUpdatePlan(
  planPath: string,
  values: {
    controlEndpoint: string;
    databasePath: string;
    restartService: boolean;
    workingDirectory?: string;
    reason?: string;
    notificationSessionId?: string;
    notificationTarget?: SelfUpdatePlan["notificationTarget"];
  },
): void {
  const plan = readSelfUpdatePlan(planPath);
  plan.controlEndpoint = values.controlEndpoint;
  plan.databasePath = values.databasePath;
  plan.restartService = values.restartService;
  if (values.workingDirectory) plan.workingDirectory = values.workingDirectory;
  if (values.reason) plan.reason = values.reason;
  if (values.notificationTarget) plan.notificationTarget = values.notificationTarget;
  if (values.notificationSessionId)
    plan.notificationSessionId = values.notificationSessionId;
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
}

export function readSelfUpdatePlan(planPath: string): SelfUpdatePlan {
  return JSON.parse(fs.readFileSync(planPath, "utf8")) as SelfUpdatePlan;
}

export function releaseSelfUpdatePlan(planPath: string): void {
  try {
    const plan = readSelfUpdatePlan(planPath);
    releaseSelfUpdateLock(plan.lockPath, plan.lockToken);
    releasePendingMarker(plan.pendingMarkerPath, plan.lockToken);
  } catch {
    // An incomplete plan may not have acquired a durable update reservation.
  }
}

export function readPendingSelfUpdate(
  home = agentBotHome(),
): PendingSelfUpdate | undefined {
  const markerPath = path.join(home, "updates", "pending-update.json");
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
      token?: unknown;
      phase?: unknown;
      planPath?: unknown;
    };
    if (
      marker.phase !== "prepared" ||
      typeof marker.token !== "string" ||
      typeof marker.planPath !== "string"
    )
      return undefined;
    assertSelfUpdatePlanPath(marker.planPath, home);
    const plan = readSelfUpdatePlan(marker.planPath);
    if (
      plan.lockToken !== marker.token ||
      plan.pendingMarkerPath !== markerPath
    )
      return undefined;
    const lock = JSON.parse(fs.readFileSync(plan.lockPath, "utf8")) as {
      token?: unknown;
    };
    if (lock.token !== marker.token) return undefined;
    return { planPath: marker.planPath, plan };
  } catch {
    return undefined;
  }
}

export function assertSelfUpdatePlanPath(
  planPath: string,
  home = agentBotHome(),
): void {
  const updatesRoot = path.resolve(home, "updates");
  const resolved = path.resolve(planPath);
  const relative = path.relative(updatesRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      "Agent Bot update plan must be stored under the active Profile's updates directory.",
    );
  }
  const plan = readSelfUpdatePlan(resolved);
  if (
    plan.schemaVersion !== SELF_UPDATE_PLAN_VERSION ||
    plan.packageName !== AGENT_BOT_PACKAGE_NAME
  ) {
    throw new Error("Invalid Agent Bot update plan.");
  }
  const expectedRunner = path.join(path.dirname(resolved), "update-runner.mjs");
  if (!fs.existsSync(expectedRunner))
    throw new Error("Agent Bot update runner is missing.");
}

export function launchSelfUpdateRunner(
  planPath: string,
  options: { waitPids?: number[]; environment?: NodeJS.ProcessEnv } = {},
): number | undefined {
  const runnerPath = path.join(path.dirname(planPath), "update-runner.mjs");
  const waitArguments = (options.waitPids ?? []).flatMap((pid) => [
    "--wait-pid",
    String(pid),
  ]);
  const child = spawn(
    process.execPath,
    [runnerPath, planPath, ...waitArguments],
    {
      cwd: path.dirname(planPath),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: options.environment ?? process.env,
    },
  );
  child.unref();
  return child.pid;
}

export function inspectNpmInstallation(
  packageRoot: string,
  runNpm: (args: string[], cwd: string) => CommandResult = runNpmCommand,
): { kind: "global" | "linked" | "source"; packageRoot: string } {
  const result = runNpm(["root", "--global"], packageRoot);
  if (result.error || result.status !== 0)
    return { kind: "source", packageRoot };
  const globalRoot = lastMatchingLine(result.stdout, () => true);
  if (!globalRoot) return { kind: "source", packageRoot };
  const expected = path.join(globalRoot, ...AGENT_BOT_PACKAGE_NAME.split("/"));
  if (!fs.existsSync(expected)) return { kind: "source", packageRoot };
  const linked = fs.lstatSync(expected).isSymbolicLink();
  const expectedReal = fs.realpathSync.native(expected);
  const packageReal = fs.realpathSync.native(packageRoot);
  if (!samePath(expectedReal, packageReal))
    return { kind: "source", packageRoot };
  return { kind: linked ? "linked" : "global", packageRoot: expectedReal };
}

export function defaultUpdateChannel(version: string): SelfUpdateChannel {
  return version.includes("-") ? "alpha" : "latest";
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index])
      return a.core[index]! > b.core[index]! ? 1 : -1;
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    if (a.pre.length === b.pre.length) return 0;
    return a.pre.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.pre[index];
    const rightPart = b.pre[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined)
      return leftNumber > rightNumber ? 1 : -1;
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function resolvePublishedVersion(
  channel: SelfUpdateChannel,
  runNpm: (args: string[], cwd: string) => CommandResult,
  cwd: string,
): string {
  const result = runNpm(
    ["view", `${AGENT_BOT_PACKAGE_NAME}@${channel}`, "version", "--json"],
    cwd,
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      result.stderr.trim() || `npm view exited with ${result.status}.`,
    );
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    value = result.stdout.trim();
  }
  if (Array.isArray(value)) value = value.at(-1);
  if (typeof value !== "string")
    throw new Error("npm did not return a valid Agent Bot version.");
  return normalizeVersion(value);
}

function packPackage(
  spec: string,
  destination: string,
  cwd: string,
  runNpm: (args: string[], cwd: string) => CommandResult,
  extra: string[] = [],
): string {
  const result = runRequiredNpm(
    ["pack", spec, "--pack-destination", destination, "--silent", ...extra],
    cwd,
    runNpm,
  );
  const filename = lastMatchingLine(result.stdout, (line) =>
    line.endsWith(".tgz"),
  );
  if (!filename)
    throw new Error(
      `Could not determine npm package archive from: ${result.stdout.trim()}`,
    );
  const tarball = path.resolve(destination, filename);
  if (!fs.existsSync(tarball))
    throw new Error(`npm package archive was not created: ${tarball}`);
  return tarball;
}

function runRequiredNpm(
  args: string[],
  cwd: string,
  runNpm: (args: string[], cwd: string) => CommandResult,
): CommandResult {
  const result = runNpm(args, cwd);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `npm exited with ${result.status}.`,
    );
  }
  return result;
}

function readVersionFromRoot(packageRoot: string): string {
  return normalizeVersion(
    readPackageVersion(pathToFileURL(path.join(packageRoot, "package.json"))),
  );
}

function normalizeVersion(version: string): string {
  const normalized = version.trim().replace(/^v/, "");
  parseSemver(normalized);
  return normalized;
}

function parseSemver(version: string): {
  core: [number, number, number];
  pre: string[];
} {
  const match =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      version,
    );
  if (!match) throw new Error(`Invalid Agent Bot version: ${version}.`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4]?.split(".") ?? [],
  };
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function timestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, "-");
}

function acquireUpdateLock(
  packageRoot: string,
  token: string,
  now: Date,
): string {
  const globalModulesRoot = path.dirname(path.dirname(packageRoot));
  const lockPath = path.join(globalModulesRoot, ".agent-bot-update.lock");
  try {
    const handle = fs.openSync(lockPath, "wx");
    try {
      fs.writeFileSync(
        handle,
        `${JSON.stringify(
          {
            token,
            phase: "preparing",
            pid: process.pid,
            createdAt: now.toISOString(),
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      fs.closeSync(handle);
    }
    return lockPath;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    throw new Error(
      cliText(
        `Another Agent Bot update is already prepared or running. Lock: ${lockPath}`,
        `另一个 Agent Bot 更新已在准备或执行中。锁文件：${lockPath}`,
      ),
    );
  }
}

function writeUpdateLock(
  lockPath: string,
  value: Record<string, unknown>,
): void {
  fs.writeFileSync(lockPath, `${JSON.stringify(value, null, 2)}\n`);
}

function releaseSelfUpdateLock(lockPath: string, token: string): void {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      token?: unknown;
    };
    if (lock.token === token) fs.rmSync(lockPath, { force: true });
  } catch {
    // Never remove a lock that cannot be verified as belonging to this operation.
  }
}

function releasePendingMarker(markerPath: string, token: string): void {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
      token?: unknown;
    };
    if (marker.token === token) fs.rmSync(markerPath, { force: true });
  } catch {
    // Never remove a marker that cannot be verified as belonging to this operation.
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function lastMatchingLine(
  value: string,
  predicate: (line: string) => boolean,
): string | undefined {
  const lines = value.trim().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line && predicate(line)) return line;
  }
  return undefined;
}

function conflictingChannelError(): Error {
  return new Error(
    cliText(
      "--alpha and --stable cannot be combined.",
      "--alpha 和 --stable 不能同时使用。",
    ),
  );
}

function defaultDependencies(): SelfUpdaterDependencies {
  return {
    packageRoot: fileURLToPath(new URL("../../", import.meta.url)),
    home: agentBotHome(),
    runnerEntry: fileURLToPath(
      new URL("./SelfUpdateRunner.js", import.meta.url),
    ),
    runNpm: runNpmCommand,
    validatePackage: validateInstalledPackage,
    now: () => new Date(),
    randomId: randomUUID,
  };
}
