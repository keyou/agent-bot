import { describe, expect, test, vi } from "vitest";
import {
  AutostartManager,
  createAutostartPlan,
  type AutostartContext,
} from "../../src/cli/AutostartManager.js";

describe("autostart plans", () => {
  test("creates a profile-specific Windows logon task without credentials", () => {
    const plan = createAutostartPlan({
      profilePath: "C:\\Users\\tester\\.agent-bot-rescue",
      configPath: "C:\\Users\\tester\\.agent-bot-rescue\\config.yaml",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      supervisorPath: "C:\\npm\\node_modules\\@keyou007\\agent-bot\\dist\\supervisor.js",
      crashReportDirectory: "C:\\Users\\tester\\.agent-bot-rescue\\data\\crash-reports",
      pathValue: "C:\\Program Files\\nodejs;C:\\Users\\tester\\AppData\\Roaming\\npm",
    }, "win32", "C:\\Users\\tester");

    expect(plan.name).toMatch(/^AgentBot-agent-bot-rescue-[a-f0-9]{10}$/);
    expect(plan.bootstrapPath).toBe("C:\\Users\\tester\\.agent-bot-rescue\\autostart\\supervisor-bootstrap.mjs");
    expect(plan.windowsFallbackPath).toBe(`C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\${plan.name}.vbs`);
    expect(plan.windowsFallbackContent).toContain("WScript.Shell");
    expect(plan.windowsFallbackContent).toContain(", 0, False");
    expect(plan.bootstrapContent).toContain("file:///C:/npm/node_modules/%40keyou007/agent-bot/dist/supervisor.js");
    expect(plan.bootstrapContent).toContain("delete process.env.FEISHU_APP_SECRET");
    expect(plan.bootstrapContent).toContain("process.env.PATH");
    expect(plan.bootstrapContent).not.toContain("appSecret");
    expect(plan.commandArguments).toContain("--report-on-fatalerror");
  });

  test("creates a macOS LaunchAgent that starts once per login", () => {
    const context = posixContext("/Users/tester/.agent-bot");
    const plan = createAutostartPlan(context, "darwin", "/Users/tester");

    expect(plan.definitionPath).toMatch(/^\/Users\/tester\/Library\/LaunchAgents\/com\.keyou\.agent-bot\.[a-f0-9]{10}\.plist$/);
    expect(plan.definitionContent).toContain("<key>RunAtLoad</key>\n    <true/>");
    expect(plan.definitionContent).toContain("<key>KeepAlive</key>\n    <false/>");
    expect(plan.definitionContent).toContain("<key>ProcessType</key>\n    <string>Standard</string>");
    expect(plan.definitionContent).not.toContain("<string>Background</string>");
    expect(plan.definitionContent).toContain("/Users/tester/.agent-bot/autostart/supervisor-bootstrap.mjs");
  });

  test("creates a Linux user unit without service-manager restart loops", () => {
    const context = posixContext("/home/tester/.agent-bot-rescue");
    const plan = createAutostartPlan(context, "linux", "/home/tester");

    expect(plan.name).toMatch(/^agent-bot-[a-f0-9]{10}\.service$/);
    expect(plan.definitionPath).toBe(`/home/tester/.config/systemd/user/${plan.name}`);
    expect(plan.definitionContent).toContain("WantedBy=default.target");
    expect(plan.definitionContent).toContain("Restart=no");
    expect(plan.definitionContent).toContain("ExecStart=\"/usr/bin/node\"");
    expect(plan.definitionContent).toContain("supervisor-bootstrap.mjs\"");
  });
});

describe("AutostartManager", () => {
  test.each([".agent-bot", ".agent-bot-rescue"])("re-registers the existing macOS %s LaunchAgent as Standard without unloading active work", (profile) => {
    const context = posixContext(`/Users/tester/${profile}`);
    const previous = createAutostartPlan(context, "darwin", "/Users/tester");
    const files = new Map([[previous.definitionPath, previous.definitionContent!.replace("<string>Standard</string>", "<string>Background</string>")]]);
    const run = vi.fn(() => result(0));
    const manager = new AutostartManager(context, {
      platform: "darwin", homeDirectory: "/Users/tester", username: "tester", uid: 501,
      run, exists: (filePath) => files.has(filePath), write: (filePath, content) => files.set(filePath, content),
      remove: vi.fn(), removeDirectoryIfEmpty: vi.fn(),
    });

    expect(manager.enable()).toMatchObject({ enabled: true, loaded: true, definitionPath: previous.definitionPath, name: previous.name });
    expect(files.get(previous.definitionPath)).toContain("<key>ProcessType</key>\n    <string>Standard</string>");
    expect(files.get(previous.definitionPath)).not.toContain("<string>Background</string>");
    expect(files.get(previous.bootstrapPath)).toBe(manager.plan!.bootstrapContent);
    expect(run.mock.calls).toEqual([["launchctl", ["print", `gui/501/${previous.name}`]]]);
  });

  test("enables Linux autostart and optional user lingering, then disables only the unit", () => {
    const files = new Map<string, string>();
    const calls: Array<[string, string[]]> = [];
    let enabled = false;
    let linger = false;
    const run = vi.fn((command: string, args: string[]) => {
      calls.push([command, args]);
      if (command === "systemctl" && args.includes("enable")) enabled = true;
      if (command === "systemctl" && args.includes("disable")) enabled = false;
      if (command === "loginctl" && args[0] === "enable-linger") linger = true;
      if (command === "systemctl" && args.includes("is-enabled")) return result(enabled ? 0 : 1);
      if (command === "systemctl" && args.includes("is-active")) return result(3);
      if (command === "loginctl" && args[0] === "show-user") return result(0, linger ? "yes\n" : "no\n");
      return result(0);
    });
    const manager = new AutostartManager(posixContext("/home/tester/.agent-bot-rescue"), {
      platform: "linux",
      homeDirectory: "/home/tester",
      username: "tester",
      uid: 1000,
      run,
      exists: (filePath) => files.has(filePath),
      write: (filePath, content) => files.set(filePath, content),
      remove: (filePath) => files.delete(filePath),
      removeDirectoryIfEmpty: vi.fn(),
    });

    const active = manager.enable({ linger: true });

    expect(active).toMatchObject({ enabled: true, loaded: false, linger: true, trigger: "boot" });
    expect(files.get(manager.plan!.bootstrapPath)).toContain("AGENT_BOT_EXPLICIT_PROFILE");
    expect(files.get(manager.plan!.definitionPath)).toContain("WantedBy=default.target");
    expect(calls).toContainEqual(["loginctl", ["enable-linger", "tester"]]);

    const disabled = manager.disable();

    expect(disabled).toMatchObject({ enabled: false, linger: true });
    expect(files.has(manager.plan!.bootstrapPath)).toBe(false);
    expect(files.has(manager.plan!.definitionPath)).toBe(false);
    expect(calls).not.toContainEqual(["loginctl", ["disable-linger", "tester"]]);
  });

  test("uses a Windows ONLOGON task and quotes paths containing spaces", () => {
    let taskExists = false;
    const run = vi.fn((command: string, args: string[]) => {
      if (command === "schtasks.exe" && args.includes("/Create")) taskExists = true;
      if (command === "schtasks.exe" && args.includes("/Delete")) taskExists = false;
      if (command === "schtasks.exe" && args.includes("/Query")) return result(taskExists ? 0 : 1);
      return result(0);
    });
    const manager = new AutostartManager({
      profilePath: "C:\\Users\\Test User\\.agent-bot",
      configPath: "C:\\Users\\Test User\\.agent-bot\\config.yaml",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      supervisorPath: "C:\\npm\\agent-bot\\dist\\supervisor.js",
      crashReportDirectory: "C:\\Users\\Test User\\.agent-bot\\data\\crash-reports",
    }, {
      platform: "win32",
      homeDirectory: "C:\\Users\\Test User",
      username: "tester",
      run,
      exists: () => false,
      write: vi.fn(),
      remove: vi.fn(),
      removeDirectoryIfEmpty: vi.fn(),
    });

    expect(manager.enable()).toMatchObject({ enabled: true, trigger: "login", mechanism: "task-scheduler" });
    const createCall = run.mock.calls.find(([, args]) => args.includes("/Create"));
    const taskCommand = createCall?.[1][createCall[1].indexOf("/TR") + 1];
    expect(createCall?.[1]).toContain("ONLOGON");
    expect(taskCommand).toContain('"C:\\Program Files\\nodejs\\node.exe"');
    expect(taskCommand).toContain('"C:\\Users\\Test User\\.agent-bot\\autostart\\supervisor-bootstrap.mjs"');
  });

  test("falls back to the per-user Windows Startup folder when Task Scheduler is denied", () => {
    const files = new Map<string, string>();
    const run = vi.fn((_command: string, args: string[]) =>
      args.includes("/Create")
        ? { status: 1, stdout: "", stderr: "ERROR: Access is denied." }
        : result(1));
    const manager = new AutostartManager({
      profilePath: "C:\\Users\\tester\\.agent-bot",
      configPath: "C:\\Users\\tester\\.agent-bot\\config.yaml",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      supervisorPath: "C:\\npm\\agent-bot\\dist\\supervisor.js",
      crashReportDirectory: "C:\\Users\\tester\\.agent-bot\\data\\crash-reports",
    }, {
      platform: "win32",
      homeDirectory: "C:\\Users\\tester",
      appDataDirectory: "C:\\Users\\tester\\AppData\\Roaming",
      username: "tester",
      run,
      exists: (filePath) => files.has(filePath),
      write: (filePath, content) => files.set(filePath, content),
      remove: (filePath) => files.delete(filePath),
      removeDirectoryIfEmpty: vi.fn(),
    });

    const enabled = manager.enable();

    expect(enabled).toMatchObject({ enabled: true, mechanism: "startup-folder" });
    expect(enabled.definitionPath).toBe(manager.plan!.windowsFallbackPath);
    expect(files.get(manager.plan!.windowsFallbackPath!)).toContain("WScript.Shell");

    const disabled = manager.disable();

    expect(disabled.enabled).toBe(false);
    expect(files.has(manager.plan!.windowsFallbackPath!)).toBe(false);
    expect(run.mock.calls.some(([, args]) => args.includes("/Delete"))).toBe(false);
  });

  test("reports unsupported platforms without writing a registration", () => {
    const manager = new AutostartManager(posixContext("/home/tester/.agent-bot"), {
      platform: "freebsd",
      homeDirectory: "/home/tester",
      username: "tester",
      run: vi.fn(() => result(1)),
      exists: () => false,
      write: vi.fn(),
      remove: vi.fn(),
      removeDirectoryIfEmpty: vi.fn(),
    });

    expect(manager.status()).toMatchObject({ supported: false, enabled: false, platform: "freebsd" });
    expect(() => manager.enable()).toThrow("Autostart is not supported on freebsd");
  });
});

function posixContext(profilePath: string): AutostartContext {
  return {
    profilePath,
    configPath: `${profilePath}/config.yaml`,
    nodePath: "/usr/bin/node",
    supervisorPath: "/usr/lib/node_modules/@keyou007/agent-bot/dist/supervisor.js",
    crashReportDirectory: `${profilePath}/data/crash-reports`,
    pathValue: "/usr/local/bin:/usr/bin:/bin",
  };
}

function result(status: number, stdout = "") {
  return { status, stdout, stderr: "" };
}
