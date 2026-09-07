import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawnStdioCommand: vi.fn(),
}));

vi.mock("../../src/utils/spawnCommand.js", () => ({
  spawnStdioCommand: mocks.spawnStdioCommand,
}));

import { CodexProcessManager } from "../../src/codex/CodexProcessManager.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("CodexProcessManager", () => {
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
