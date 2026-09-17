import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawnStdioCommand: vi.fn(),
}));

vi.mock("../../src/utils/spawnCommand.js", () => ({
  spawnStdioCommand: mocks.spawnStdioCommand,
}));

import { CodexProcessManager } from "../../src/codex/CodexProcessManager.js";
import { CodexRuntime } from "../../src/codex/CodexRuntime.js";
import { loadConfig } from "../../src/config/loadConfig.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-codex-env-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.stubEnv("CODEX_HOME", undefined);
  vi.stubEnv("TEST_CODEX_FILE_KEY", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("CodexProcessManager", () => {
  test("loads the default Codex .env at startup without mutating the Worker environment", async () => {
    const directory = path.join(home, ".codex");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, ".env"), [
      '# Provider credentials',
      'TEST_CODEX_FILE_KEY="file-value"',
      'FEISHU_APP_SECRET=must-not-reach-agent',
      'AGENT_BOT_RESTART_REASON=must-not-reach-agent',
      'CODEX_HOME=must-not-redirect-the-child',
    ].join("\n"));
    const workerHome = process.env.AGENT_BOT_HOME;
    const manager = new CodexProcessManager("codex", ["app-server"], {}, logger());
    expect(manager.getEnvironmentVariable("TEST_CODEX_FILE_KEY")).toBe("file-value");
    expect(manager.getEnvironmentVariable("CODEX_HOME")).toBe(directory);
    expect(process.env.TEST_CODEX_FILE_KEY).toBeUndefined();
    expect(process.env.AGENT_BOT_HOME).toBe(workerHome);

    const child = fakeChildProcess();
    mocks.spawnStdioCommand.mockReturnValue(child.child);
    const starting = manager.getClient();
    const environment = mocks.spawnStdioCommand.mock.calls[0]?.[2] as NodeJS.ProcessEnv;
    expect(environment.TEST_CODEX_FILE_KEY).toBe("file-value");
    expect(environment.CODEX_HOME).toBe(directory);
    expect(environment.FEISHU_APP_SECRET).toBeUndefined();
    expect(environment.AGENT_BOT_RESTART_REASON).toBeUndefined();
    child.pushStdout({ id: 1, result: { userAgent: "codex-cli/0.153.4" } });
    await starting;
    manager.close();
  });

  test("prefers Agent settings and Profile environment over Codex .env, including empty values", () => {
    const directory = path.join(home, ".codex");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, ".env"), "TEST_CODEX_FILE_KEY=file-value\n");
    vi.stubEnv("AGENT_BOT_HOME", path.join(home, "profile"));
    vi.stubEnv("AGENT_BOT_CONFIG", "");
    vi.stubEnv("TEST_CODEX_FILE_KEY", undefined);
    fs.mkdirSync(path.join(home, "profile"));
    fs.writeFileSync(path.join(home, "profile", ".env"), "TEST_CODEX_FILE_KEY=profile-value\n");
    loadConfig();
    expect(new CodexProcessManager("codex", [], {}, logger())
      .getEnvironmentVariable("TEST_CODEX_FILE_KEY")).toBe("profile-value");
    expect(new CodexProcessManager("codex", [], { TEST_CODEX_FILE_KEY: "agent-value" }, logger())
      .getEnvironmentVariable("TEST_CODEX_FILE_KEY")).toBe("agent-value");
    vi.stubEnv("TEST_CODEX_FILE_KEY", "");
    expect(new CodexProcessManager("codex", [], {}, logger())
      .getEnvironmentVariable("TEST_CODEX_FILE_KEY")).toBe("");
  });

  test("keeps separate CODEX_HOME files isolated and does not load them for other Agents", () => {
    const primary = path.join(home, "primary");
    const rescue = path.join(home, "rescue");
    for (const [directory, value] of [[primary, "primary-value"], [rescue, "rescue-value"]] as const) {
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, ".env"), `TEST_CODEX_FILE_KEY=${value}\n`);
    }
    vi.stubEnv("CODEX_HOME", primary);
    expect(new CodexProcessManager("codex", [], {}, logger())
      .getEnvironmentVariable("TEST_CODEX_FILE_KEY")).toBe("primary-value");
    const isolated = new CodexProcessManager("codex", [], { CODEX_HOME: rescue }, logger());
    expect(isolated.getCodexHome()).toBe(rescue);
    expect(isolated.getEnvironmentVariable("TEST_CODEX_FILE_KEY")).toBe("rescue-value");
    for (const command of ["traex", "custom-app-server"]) {
      expect(new CodexProcessManager(command, [], {}, logger())
        .getEnvironmentVariable("TEST_CODEX_FILE_KEY")).toBeUndefined();
    }
    expect(process.env.TEST_CODEX_FILE_KEY).toBeUndefined();
  });

  test.each(["~/settings", "settings"])("resolves CODEX_HOME %s consistently with the child working directory", (configured) => {
    const directory = path.join(home, "settings");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, ".env"), "TEST_CODEX_FILE_KEY=resolved\n");
    const manager = new CodexProcessManager("node", ["codex.js"], { CODEX_HOME: configured }, logger(),
      () => ({ profilePath: home }));
    expect(manager.getCodexHome()).toBe(directory);
    expect(manager.getEnvironmentVariable("TEST_CODEX_FILE_KEY")).toBe("resolved");
  });

  test("tolerates a missing file and warns about unreadable files without logging contents", () => {
    const log = logger();
    new CodexProcessManager("codex", [], {}, log);
    expect(log.warn).not.toHaveBeenCalled();
    fs.mkdirSync(path.join(home, ".codex", ".env"), { recursive: true });
    expect(() => new CodexProcessManager("codex", [], {}, log)).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(
      { path: path.join(home, ".codex", ".env"), code: "EISDIR" },
      expect.any(String),
    );
  });

  test("uses a key from Codex .env when Agent Bot queries the Provider model endpoint", async () => {
    const directory = path.join(home, ".codex");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, ".env"), "TEST_CODEX_FILE_KEY=provider-token\n");
    const child = fakeChildProcess();
    mocks.spawnStdioCommand.mockReturnValue(child.child);
    const manager = new CodexProcessManager("codex", ["app-server"], {}, logger());
    const runtime = new CodexRuntime(manager, logger());
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "provider-model" }] })));
    vi.stubGlobal("fetch", fetchMock);
    const models = runtime.listModels("private-provider");
    child.pushStdout({ id: 1, result: { userAgent: "codex-cli/0.153.4" } });
    await vi.waitFor(() => expect(child.writtenJson()).toContainEqual(expect.objectContaining({ method: "config/read" })));
    child.pushStdout({ id: 2, result: { config: { model_providers: { "private-provider": {
      base_url: "https://provider.example/v1", env_key: "TEST_CODEX_FILE_KEY",
    } } } } });
    await vi.waitFor(() => expect(child.writtenJson()).toContainEqual(expect.objectContaining({ method: "model/list" })));
    child.pushStdout({ id: 3, result: { data: [] } });
    expect(await models).toEqual([expect.objectContaining({ id: "provider-model" })]);
    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe("https://provider.example/v1/models");
    expect((fetchMock.mock.calls[0]?.[1].headers as Headers).get("Authorization")).toBe("Bearer provider-token");
    expect(process.env.TEST_CODEX_FILE_KEY).toBeUndefined();
    runtime.close();
  });

  test("resolves Agent-specific environment values before inherited values", () => {
    vi.stubEnv("INHERITED_PROVIDER_KEY", "parent-value");
    vi.stubEnv("OVERRIDDEN_PROVIDER_KEY", "parent-value");
    const manager = new CodexProcessManager("codex", ["app-server"], {
      OVERRIDDEN_PROVIDER_KEY: "agent-value",
    }, logger());

    expect(manager.getEnvironmentVariable("INHERITED_PROVIDER_KEY")).toBe("parent-value");
    expect(manager.getEnvironmentVariable("OVERRIDDEN_PROVIDER_KEY")).toBe("agent-value");
    expect(manager.getEnvironmentVariable("MISSING_PROVIDER_KEY")).toBeUndefined();
  });

  test.each(["0.153.3", "0.153.4-alpha.1", undefined])("rejects unsupported Codex %s before exposing a client", async (version) => {
    const process = fakeChildProcess();
    mocks.spawnStdioCommand.mockReturnValue(process.child);
    const manager = new CodexProcessManager("C:\\tools\\codex.exe", ["app-server"], {}, logger());
    const first = manager.getClient();
    const second = manager.getClient();
    const outcomes = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(process.writtenJson()).toHaveLength(1));
    process.pushStdout({ id: 1, result: { serverInfo: { version } } });
    for (const outcome of await outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason.message).toContain("Codex >= 0.153.4");
        expect(outcome.reason.message).toContain("codex update");
      }
    }
    expect(mocks.spawnStdioCommand).toHaveBeenCalledOnce();
    expect(process.writtenJson()).toHaveLength(1);
    expect(process.child.kill).toHaveBeenCalledOnce();
    expect(manager.getProcessInfo()).toEqual({});
  });

  test("does not apply the Codex minimum version to TraeX", async () => {
    const process = fakeChildProcess();
    mocks.spawnStdioCommand.mockReturnValue(process.child);
    const manager = new CodexProcessManager("traex", ["app-server"], {}, logger());
    const client = manager.getClient();
    await vi.waitFor(() => expect(process.writtenJson()).toHaveLength(1));
    process.pushStdout({ id: 1, result: { userAgent: "traex/0.1.0" } });
    await expect(client).resolves.toBeDefined();
    manager.close();
  });

  test("declares experimental API support during initialization", async () => {
    const process = fakeChildProcess();
    mocks.spawnStdioCommand.mockReturnValue(process.child);
    const manager = new CodexProcessManager("codex", ["app-server"], {}, logger());
    expect(manager.getProcessInfo()).toEqual({});

    const client = manager.getClient();
    await vi.waitFor(() => expect(process.writtenJson()).toHaveLength(1));
    expect(manager.getProcessInfo()).toEqual({ pid: 4321 });

    expect(process.writtenJson()[0]).toEqual({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "agent-bot", title: "Agent Bot", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    });

    process.pushStdout({ id: 1, result: { userAgent: "codex-cli/0.153.4" } });
    await expect(client).resolves.toBeDefined();
    expect(process.writtenJson()[1]).toEqual({ method: "initialized", params: {} });
    expect(manager.getProcessInfo()).toEqual({ pid: 4321, version: "0.153.4" });

    manager.close();
  });

  test("resolves safe Agent Bot context lazily without exposing the Feishu App Secret", async () => {
    vi.stubEnv("FEISHU_APP_SECRET", "worker-secret");
    vi.stubEnv("PARENT_VALUE", "preserved");
    const process = fakeChildProcess();
    mocks.spawnStdioCommand.mockReturnValue(process.child);
    const context = { larkBotOpenId: undefined as string | undefined };
    const manager = new CodexProcessManager(
      "codex",
      ["app-server"],
      {},
      logger(),
      () => ({
        profilePath: "C:\\Users\\tester\\.agent-bot",
        larkAppId: "cli_app",
        larkBotOpenId: context.larkBotOpenId,
      }),
    );
    context.larkBotOpenId = "ou_bot";

    const client = manager.getClient();
    await vi.waitFor(() => expect(mocks.spawnStdioCommand).toHaveBeenCalledOnce());
    const environment = mocks.spawnStdioCommand.mock.calls[0]?.[2] as NodeJS.ProcessEnv;
    expect(environment).toMatchObject({
      PARENT_VALUE: "preserved",
      AGENT_BOT: "1",
      AGENT_BOT_HOME: "C:\\Users\\tester\\.agent-bot",
      AGENT_BOT_LARK_APP_ID: "cli_app",
      AGENT_BOT_LARK_BOT_OPEN_ID: "ou_bot",
    });
    expect(environment.FEISHU_APP_SECRET).toBeUndefined();
    expect(mocks.spawnStdioCommand.mock.calls[0]?.[3]).toBe("C:\\Users\\tester\\.agent-bot");

    process.pushStdout({ id: 1, result: { userAgent: "codex-cli/0.153.4" } });
    await client;
    manager.close();
  });

  test("releases the current App Server process and can start a fresh one later", async () => {
    const first = fakeChildProcess();
    const second = fakeChildProcess(4322);
    mocks.spawnStdioCommand.mockReturnValueOnce(first.child).mockReturnValueOnce(second.child);
    const manager = new CodexProcessManager("codex", ["app-server"], {}, logger());

    const firstClient = manager.getClient();
    await vi.waitFor(() => expect(first.writtenJson()).toHaveLength(1));
    first.pushStdout({ id: 1, result: { userAgent: "codex-cli/0.153.4" } });
    await firstClient;

    const released = manager.release();
    expect(first.child.stdin.writableEnded).toBe(true);
    expect(first.child.kill).not.toHaveBeenCalled();
    first.exit(0);
    await expect(released).resolves.toBeUndefined();
    expect(manager.getProcessInfo()).toEqual({});

    const secondClient = manager.getClient();
    await vi.waitFor(() => expect(second.writtenJson()).toHaveLength(1));
    second.pushStdout({ id: 1, result: { userAgent: "codex-cli/0.153.4" } });
    await secondClient;
    expect(manager.getProcessInfo()).toEqual({ pid: 4322, version: "0.153.4" });
    manager.close();
  });
});

function fakeChildProcess(pid = 4321) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const processState: EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  } = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    killed: false,
    exitCode: null,
    signalCode: null,
    pid,
    kill: vi.fn(() => {
      processState.killed = true;
      return true;
    }),
  });
  const child = processState as unknown as ChildProcessWithoutNullStreams;
  const writes: string[] = [];
  stdin.on("data", (chunk) => writes.push(chunk.toString("utf8")));
  return {
    child,
    pushStdout(value: unknown) {
      stdout.write(`${JSON.stringify(value)}\n`);
    },
    writtenJson() {
      return writes
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
    },
    exit(code: number | null, signal: NodeJS.Signals | null = null) {
      processState.exitCode = code;
      processState.signalCode = signal;
      processState.emit("exit", code, signal);
    },
  };
}

function logger(): Logger {
  const childLogger = {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  return {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => childLogger),
  } as unknown as Logger;
}
