import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AppConfig } from "../config/schema.js";
import {
  AGENT_BOT_EXPLICIT_PROFILE_ENV,
  AGENT_BOT_HOME_ENV,
  agentBotHome,
  defaultConfigPath,
  resolveUserPath,
} from "../config/paths.js";
import {
  nodeDiagnosticReportArguments,
  resolveSupervisorDiagnosticsPaths,
} from "../supervision/SupervisorDiagnostics.js";

export type SupportedAutostartPlatform = "win32" | "darwin" | "linux";

export interface AutostartContext {
  profilePath: string;
  configPath: string;
  nodePath: string;
  supervisorPath: string;
  crashReportDirectory: string;
  pathValue?: string;
}

export interface AutostartPlan {
  platform: SupportedAutostartPlatform;
  name: string;
  profilePath: string;
  configPath: string;
  bootstrapPath: string;
  bootstrapContent: string;
  definitionPath: string;
  definitionContent?: string;
  command: string;
  commandArguments: string[];
  windowsFallbackPath?: string;
  windowsFallbackContent?: string;
}

export interface AutostartRegistrationStatus {
  supported: boolean;
  platform: NodeJS.Platform;
  profilePath: string;
  configPath: string;
  enabled: boolean;
  loaded?: boolean;
  linger?: boolean;
  name?: string;
  definitionPath?: string;
  trigger?: "login" | "boot";
  mechanism?: "task-scheduler" | "startup-folder" | "launch-agent" | "systemd";
}

export interface EnableAutostartOptions {
  linger?: boolean;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface AutostartDependencies {
  platform: NodeJS.Platform;
  homeDirectory: string;
  username: string;
  uid?: number;
  appDataDirectory?: string;
  run(command: string, args: string[]): CommandResult;
  exists(filePath: string): boolean;
  write(filePath: string, content: string): void;
  remove(filePath: string): void;
  removeDirectoryIfEmpty(directoryPath: string): void;
}

export type AutostartDependencyOverrides = Partial<AutostartDependencies>;

export class AutostartManager {
  readonly plan?: AutostartPlan;
  private readonly dependencies: AutostartDependencies;

  constructor(
    private readonly context: AutostartContext,
    overrides: AutostartDependencyOverrides = {},
  ) {
    this.dependencies = { ...defaultDependencies(), ...overrides };
    if (isSupportedPlatform(this.dependencies.platform)) {
      this.plan = createAutostartPlan(
        context,
        this.dependencies.platform,
        this.dependencies.homeDirectory,
        this.dependencies.appDataDirectory,
      );
    }
  }

  enable(options: EnableAutostartOptions = {}): AutostartRegistrationStatus {
    const plan = this.requirePlan();
    if (options.linger && plan.platform !== "linux") {
      throw new Error("--linger is supported only on Linux.");
    }

    this.dependencies.write(plan.bootstrapPath, plan.bootstrapContent);
    if (plan.definitionContent !== undefined) {
      this.dependencies.write(plan.definitionPath, plan.definitionContent);
    }

    if (plan.platform === "win32") {
      const task = this.dependencies.run("schtasks.exe", [
        "/Create",
        "/TN",
        plan.name,
        "/SC",
        "ONLOGON",
        "/TR",
        windowsCommandLine(plan.command, plan.commandArguments),
        "/RL",
        "LIMITED",
        "/F",
      ]);
      if (!task.error && task.status === 0) {
        if (plan.windowsFallbackPath) this.dependencies.remove(plan.windowsFallbackPath);
      } else if (plan.windowsFallbackPath && plan.windowsFallbackContent) {
        this.dependencies.write(plan.windowsFallbackPath, plan.windowsFallbackContent);
      } else {
        this.throwCommandError(task, "Could not register the Windows startup task");
      }
    } else if (plan.platform === "linux") {
      this.runChecked("systemctl", ["--user", "daemon-reload"], "Could not reload systemd user units");
      this.runChecked("systemctl", ["--user", "enable", plan.name], "Could not enable the systemd user unit");
      if (options.linger) {
        this.runChecked(
          "loginctl",
          ["enable-linger", this.dependencies.username],
          "Could not enable systemd user lingering",
        );
      }
    }

    return this.status();
  }

  disable(): AutostartRegistrationStatus {
    const plan = this.requirePlan();
    const current = this.status();

    if (plan.platform === "win32") {
      const taskRegistered = this.dependencies.run("schtasks.exe", ["/Query", "/TN", plan.name]).status === 0;
      if (taskRegistered) {
        this.runChecked(
          "schtasks.exe",
          ["/Delete", "/TN", plan.name, "/F"],
          "Could not remove the Windows startup task",
        );
      }
      if (plan.windowsFallbackPath) this.dependencies.remove(plan.windowsFallbackPath);
    } else if (plan.platform === "linux") {
      if (current.enabled) {
        this.runChecked(
          "systemctl",
          ["--user", "disable", plan.name],
          "Could not disable the systemd user unit",
        );
      }
      this.dependencies.remove(plan.definitionPath);
      this.runChecked("systemctl", ["--user", "daemon-reload"], "Could not reload systemd user units");
    } else if (plan.platform === "darwin") {
      this.dependencies.remove(plan.definitionPath);
    }

    this.dependencies.remove(plan.bootstrapPath);
    this.dependencies.removeDirectoryIfEmpty(path.dirname(plan.bootstrapPath));
    return this.status();
  }

  status(): AutostartRegistrationStatus {
    const platform = this.dependencies.platform;
    if (!this.plan) {
      return {
        supported: false,
        platform,
        profilePath: this.context.profilePath,
        configPath: this.context.configPath,
        enabled: false,
      };
    }

    const plan = this.plan;
    if (plan.platform === "win32") {
      const task = this.dependencies.run("schtasks.exe", ["/Query", "/TN", plan.name]);
      const fallback = plan.windowsFallbackPath
        ? this.dependencies.exists(plan.windowsFallbackPath)
        : false;
      return this.registrationStatus(task.status === 0 || fallback, {
        mechanism: task.status === 0 ? "task-scheduler" : fallback ? "startup-folder" : undefined,
        definitionPath: fallback ? plan.windowsFallbackPath : plan.definitionPath,
      });
    }

    if (plan.platform === "darwin") {
      const domain = `gui/${this.dependencies.uid ?? 0}/${plan.name}`;
      const loaded = this.dependencies.run("launchctl", ["print", domain]).status === 0;
      return this.registrationStatus(this.dependencies.exists(plan.definitionPath), {
        loaded,
        mechanism: "launch-agent",
      });
    }

    const enabled = this.dependencies.run("systemctl", ["--user", "is-enabled", plan.name]).status === 0;
    const loaded = this.dependencies.run("systemctl", ["--user", "is-active", plan.name]).status === 0;
    const lingerResult = this.dependencies.run("loginctl", [
      "show-user",
      this.dependencies.username,
      "--property=Linger",
      "--value",
    ]);
    const linger = lingerResult.status === 0 && lingerResult.stdout.trim().toLowerCase() === "yes";
    return this.registrationStatus(enabled, {
      loaded,
      linger,
      trigger: linger ? "boot" : "login",
      mechanism: "systemd",
    });
  }

  private requirePlan(): AutostartPlan {
    if (!this.plan) {
      throw new Error(`Autostart is not supported on ${this.dependencies.platform}.`);
    }
    return this.plan;
  }

  private registrationStatus(
    enabled: boolean,
    details: Pick<
      AutostartRegistrationStatus,
      "loaded" | "linger" | "trigger" | "mechanism" | "definitionPath"
    > = {},
  ): AutostartRegistrationStatus {
    const plan = this.requirePlan();
    return {
      supported: true,
      platform: plan.platform,
      profilePath: plan.profilePath,
      configPath: plan.configPath,
      enabled,
      name: plan.name,
      definitionPath: details.definitionPath ?? plan.definitionPath,
      trigger: details.trigger ?? "login",
      ...(details.mechanism === undefined ? {} : { mechanism: details.mechanism }),
      ...(details.loaded === undefined ? {} : { loaded: details.loaded }),
      ...(details.linger === undefined ? {} : { linger: details.linger }),
    };
  }

  private runChecked(command: string, args: string[], description: string): void {
    const result = this.dependencies.run(command, args);
    if (!result.error && result.status === 0) return;
    this.throwCommandError(result, description);
  }

  private throwCommandError(result: CommandResult, description: string): never {
    const detail = result.error?.message || result.stderr.trim() || result.stdout.trim()
      || `exit code ${result.status ?? "unknown"}`;
    throw new Error(`${description}: ${detail}`);
  }
}

export function createCurrentAutostartManager(
  config: AppConfig,
  overrides: AutostartDependencyOverrides = {},
): AutostartManager {
  const configuredPath = process.env.AGENT_BOT_CONFIG?.trim();
  const profilePath = agentBotHome();
  const configPath = configuredPath ? resolveUserPath(configuredPath) : defaultConfigPath();
  return new AutostartManager({
    profilePath,
    configPath,
    nodePath: process.execPath,
    supervisorPath: fileURLToPath(new URL("../supervisor.js", import.meta.url)),
    crashReportDirectory: resolveSupervisorDiagnosticsPaths(config).crashReportDirectory,
    pathValue: process.env.PATH,
  }, overrides);
}

export function createAutostartPlan(
  context: AutostartContext,
  platform: SupportedAutostartPlatform,
  homeDirectory: string,
  appDataDirectory?: string,
): AutostartPlan {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const profilePath = pathApi.resolve(context.profilePath);
  const configPath = pathApi.resolve(context.configPath);
  const bootstrapPath = pathApi.join(profilePath, "autostart", "supervisor-bootstrap.mjs");
  const identity = createHash("sha256")
    .update(`${platform}\0${profilePath}\0${configPath}`)
    .digest("hex")
    .slice(0, 10);
  const bootstrapContent = renderBootstrap({ ...context, profilePath, configPath }, platform);
  const commandArguments = [
    ...nodeDiagnosticReportArguments(context.crashReportDirectory),
    bootstrapPath,
  ];

  if (platform === "win32") {
    const profileName = sanitizeName(pathApi.basename(profilePath).replace(/^\.+/, "") || "main");
    const name = `AgentBot-${profileName}-${identity}`;
    const fallbackPath = pathApi.join(
      appDataDirectory ?? pathApi.join(homeDirectory, "AppData", "Roaming"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      `${name}.vbs`,
    );
    return {
      platform,
      name,
      profilePath,
      configPath,
      bootstrapPath,
      bootstrapContent,
      definitionPath: bootstrapPath,
      command: context.nodePath,
      commandArguments,
      windowsFallbackPath: fallbackPath,
      windowsFallbackContent: renderWindowsStartupScript(context.nodePath, commandArguments),
    };
  }

  if (platform === "darwin") {
    const name = `com.keyou.agent-bot.${identity}`;
    const definitionPath = pathApi.join(homeDirectory, "Library", "LaunchAgents", `${name}.plist`);
    const stdoutPath = pathApi.join(profilePath, "logs", "autostart.stdout.log");
    const stderrPath = pathApi.join(profilePath, "logs", "autostart.stderr.log");
    return {
      platform,
      name,
      profilePath,
      configPath,
      bootstrapPath,
      bootstrapContent,
      definitionPath,
      definitionContent: renderLaunchAgent({
        name,
        command: context.nodePath,
        commandArguments,
        workingDirectory: profilePath,
        stdoutPath,
        stderrPath,
      }),
      command: context.nodePath,
      commandArguments,
    };
  }

  const name = `agent-bot-${identity}.service`;
  const definitionPath = pathApi.join(homeDirectory, ".config", "systemd", "user", name);
  return {
    platform,
    name,
    profilePath,
    configPath,
    bootstrapPath,
    bootstrapContent,
    definitionPath,
    definitionContent: renderSystemdUnit({
      profilePath,
      command: context.nodePath,
      commandArguments,
    }),
    command: context.nodePath,
    commandArguments,
  };
}

function renderBootstrap(context: AutostartContext, platform: SupportedAutostartPlatform): string {
  return [
    `process.env.${AGENT_BOT_HOME_ENV} = ${JSON.stringify(context.profilePath)};`,
    `process.env.AGENT_BOT_CONFIG = ${JSON.stringify(context.configPath)};`,
    `process.env.${AGENT_BOT_EXPLICIT_PROFILE_ENV} = "1";`,
    ...(context.pathValue?.trim()
      ? [`process.env.PATH = ${JSON.stringify(context.pathValue)};`]
      : []),
    "delete process.env.FEISHU_APP_ID;",
    "delete process.env.FEISHU_APP_SECRET;",
    "delete process.env.FEISHU_USER_OPEN_ID;",
    `process.chdir(${JSON.stringify(context.profilePath)});`,
    `await import(${JSON.stringify(fileUrlForPlatform(context.supervisorPath, platform))});`,
    "",
  ].join("\n");
}

function fileUrlForPlatform(filePath: string, platform: SupportedAutostartPlatform): string {
  if (platform !== "win32") return pathToFileURL(filePath).href;
  const normalized = filePath.replaceAll("\\", "/");
  if (normalized.startsWith("//")) {
    const [host = "", ...segments] = normalized.slice(2).split("/");
    return `file://${host}/${segments.map(encodeURIComponent).join("/")}`;
  }
  const drivePath = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!drivePath) return pathToFileURL(filePath).href;
  return `file:///${drivePath[1]}:/${(drivePath[2] ?? "").split("/").map(encodeURIComponent).join("/")}`;
}

function renderLaunchAgent(input: {
  name: string;
  command: string;
  commandArguments: string[];
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
}): string {
  const argumentsXml = [input.command, ...input.commandArguments]
    .map((value) => `      <string>${escapeXml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(input.name)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(input.workingDirectory)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>ProcessType</key>
    <string>Standard</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(input.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(input.stderrPath)}</string>
  </dict>
</plist>
`;
}

function renderSystemdUnit(input: {
  profilePath: string;
  command: string;
  commandArguments: string[];
}): string {
  const commandLine = [input.command, ...input.commandArguments].map(systemdQuote).join(" ");
  return `[Unit]
Description=Agent Bot Supervisor
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdQuote(input.profilePath)}
ExecStart=${commandLine}
Restart=no

[Install]
WantedBy=default.target
`;
}

function defaultDependencies(): AutostartDependencies {
  return {
    platform: process.platform,
    homeDirectory: os.homedir(),
    username: currentUsername(),
    uid: process.getuid?.(),
    appDataDirectory: process.env.APPDATA?.trim(),
    run: (command, args) => {
      const result = spawnSync(command, args, {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
      });
      return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        ...(result.error ? { error: result.error } : {}),
      };
    },
    exists: (filePath) => fs.existsSync(filePath),
    write: (filePath, content) => writePrivateFile(filePath, content),
    remove: (filePath) => fs.rmSync(filePath, { force: true }),
    removeDirectoryIfEmpty: (directoryPath) => {
      try {
        fs.rmdirSync(directoryPath);
      } catch {
        // The directory is shared with a newer registration or contains user files.
      }
    },
  };
}

function writePrivateFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows and some mounted filesystems do not implement POSIX modes.
  }
}

function currentUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER?.trim() || process.env.USERNAME?.trim() || "";
  }
}

function isSupportedPlatform(platform: NodeJS.Platform): platform is SupportedAutostartPlatform {
  return platform === "win32" || platform === "darwin" || platform === "linux";
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "main";
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("%", "%%")}"`;
}

function windowsCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteWindowsArgument).join(" ");
}

function renderWindowsStartupScript(command: string, args: string[]): string {
  const commandLine = windowsCommandLine(command, args).replaceAll("\"", "\"\"");
  return [
    "Set shell = CreateObject(\"WScript.Shell\")",
    `shell.Run "${commandLine}", 0, False`,
    "",
  ].join("\r\n");
}

function quoteWindowsArgument(value: string): string {
  if (value && !/[\s"]/u.test(value)) return value;
  let result = "\"";
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === "\"") {
      result += "\\".repeat(backslashes * 2 + 1) + "\"";
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return `${result}${"\\".repeat(backslashes * 2)}\"`;
}
