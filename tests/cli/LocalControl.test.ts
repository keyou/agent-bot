import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { LocalControlServer } from "../../src/cli/LocalControlServer.js";
import {
  isServerReachable,
  isServerRunning,
  sendControlRequest,
} from "../../src/cli/LocalControlClient.js";
import {
  assertCompatibleTaskNewGroupRequest,
  controlEndpoint,
} from "../../src/cli/controlProtocol.js";

const servers: LocalControlServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("local CLI control", () => {
  test("uses a stable endpoint for one state database", () => {
    const sqlitePath = path.join(os.tmpdir(), "agent-bot-control", "state.sqlite");
    const endpoint = controlEndpoint(sqlitePath);
    expect(endpoint).toBe(controlEndpoint(sqlitePath));
    expect(endpoint).toContain("agent-bot-");
    expect(controlEndpoint(`${sqlitePath}.other`)).not.toBe(endpoint);
  });

  test("uses the Agent Bot namespace for every database name", () => {
    const custom = controlEndpoint(path.join(os.tmpdir(), "custom.sqlite"));
    const renamed = controlEndpoint(path.join(os.tmpdir(), "agent-bot.sqlite"));

    expect(custom).toContain("agent-bot-");
    expect(renamed).toContain("agent-bot-");
  });

  test("round-trips requests and reports handler failures", async () => {
    const endpoint = controlEndpoint(path.join(os.tmpdir(), `agent-bot-control-${process.pid}-${Date.now()}.sqlite`));
    const server = new LocalControlServer(endpoint, async (request) => {
      if (request.action === "health") return { ok: true, data: { pid: 42 } };
      throw new Error("rejected");
    });
    servers.push(server);
    await server.start();

    await expect(isServerRunning(endpoint)).resolves.toBe(true);
    await expect(isServerReachable(endpoint)).resolves.toBe(true);
    await expect(sendControlRequest(endpoint, { action: "health" })).resolves.toEqual({
      ok: true,
      data: { pid: 42 },
    });
    await expect(sendControlRequest(endpoint, { action: "server_stop" })).resolves.toEqual({
      ok: false,
      message: "rejected",
    });
  });

  test("survives a client disconnect while a control request is still running", async () => {
    const endpoint = controlEndpoint(path.join(os.tmpdir(), `agent-bot-control-disconnect-${process.pid}-${Date.now()}.sqlite`));
    let releaseRequest!: () => void;
    let markRequestStarted!: () => void;
    let requestCount = 0;
    const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
    const server = new LocalControlServer(endpoint, async () => {
      requestCount += 1;
      if (requestCount === 1) {
        markRequestStarted();
        await new Promise<void>((resolve) => { releaseRequest = resolve; });
      }
      return { ok: true };
    });
    servers.push(server);
    await server.start();

    const socket = net.createConnection(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(`${JSON.stringify({ action: "health" })}\n`);
    await requestStarted;
    socket.destroy();
    releaseRequest();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    await expect(isServerReachable(endpoint)).resolves.toBe(true);
  });

  test("distinguishes a reachable starting process from a ready server", async () => {
    const endpoint = controlEndpoint(path.join(os.tmpdir(), `agent-bot-starting-${process.pid}-${Date.now()}.sqlite`));
    const server = new LocalControlServer(endpoint, async () => ({
      ok: true,
      data: { ready: false, phase: "connecting_feishu" },
    }));
    servers.push(server);
    await server.start();

    await expect(isServerReachable(endpoint)).resolves.toBe(true);
    await expect(isServerRunning(endpoint)).resolves.toBe(false);
  });

  test("round-trips a targeted task prompt request", async () => {
    const endpoint = controlEndpoint(path.join(os.tmpdir(), `agent-bot-control-prompt-${process.pid}-${Date.now()}.sqlite`));
    const server = new LocalControlServer(endpoint, async (request) => ({ ok: true, data: request }));
    servers.push(server);
    await server.start();

    await expect(sendControlRequest(endpoint, {
      action: "task_prompt",
      localSessionId: "session_1",
      text: "continue from CLI",
    })).resolves.toEqual({
      ok: true,
      data: {
        action: "task_prompt",
        localSessionId: "session_1",
        text: "continue from CLI",
      },
    });
  });

  test("round-trips task group creation, fork, and existing Session requests", async () => {
    const endpoint = controlEndpoint(path.join(os.tmpdir(), `agent-bot-control-group-${process.pid}-${Date.now()}.sqlite`));
    const server = new LocalControlServer(endpoint, async (request) => ({ ok: true, data: request }));
    servers.push(server);
    await server.start();

    await expect(sendControlRequest(endpoint, {
      action: "task_new_group",
      localSessionId: "session_1",
      title: "Review fixes",
      cwd: "~/dev/project",
      agentName: "traex",
    })).resolves.toEqual({
      ok: true,
      data: {
        action: "task_new_group",
        localSessionId: "session_1",
        title: "Review fixes",
        cwd: "~/dev/project",
        agentName: "traex",
      },
    });
    await expect(sendControlRequest(endpoint, {
      action: "task_fork_group",
      localSessionId: "session_1",
      title: "Parallel fix",
    })).resolves.toEqual({
      ok: true,
      data: {
        action: "task_fork_group",
        localSessionId: "session_1",
        title: "Parallel fix",
      },
    });
    await expect(sendControlRequest(endpoint, {
      action: "task_new_group_session",
      localSessionId: "session_1",
      sessionId: "codex://threads/019f-thread",
      title: "Existing task",
      agentName: "traex",
    })).resolves.toEqual({
      ok: true,
      data: {
        action: "task_new_group_session",
        localSessionId: "session_1",
        sessionId: "codex://threads/019f-thread",
        title: "Existing task",
        agentName: "traex",
      },
    });
  });

  test("fails closed against a Worker that predates existing Session groups", async () => {
    const endpoint = controlEndpoint(path.join(
      os.tmpdir(),
      "agent-bot-control-legacy-group-" + process.pid + "-" + Date.now() + ".sqlite",
    ));
    let createdGroups = 0;
    const server = new LocalControlServer(endpoint, async (request) => {
      if (request.action === "task_new_group") {
        createdGroups += 1;
        return { ok: true };
      }
      return undefined as never;
    });
    servers.push(server);
    await server.start();

    await expect(sendControlRequest(endpoint, {
      action: "task_new_group_session",
      localSessionId: "session_1",
      sessionId: "019f-thread",
    })).rejects.toThrow();
    expect(createdGroups).toBe(0);
  });

  test("rejects the previous CLI session field before legacy newgroup dispatch", () => {
    expect(() => assertCompatibleTaskNewGroupRequest({
      action: "task_new_group",
      localSessionId: "session_1",
      sessionId: "019f-thread",
    })).toThrow("legacy newgroup protocol");
    expect(() => assertCompatibleTaskNewGroupRequest({
      action: "task_new_group",
      localSessionId: "session_1",
      title: "Regular group",
    })).not.toThrow();
  });

  test("round-trips a live task status request", async () => {
    const endpoint = controlEndpoint(path.join(os.tmpdir(), `agent-bot-control-status-${process.pid}-${Date.now()}.sqlite`));
    const server = new LocalControlServer(endpoint, async (request) => ({ ok: true, data: request }));
    servers.push(server);
    await server.start();

    await expect(sendControlRequest(endpoint, {
      action: "task_status",
      localSessionId: "session_status",
    })).resolves.toEqual({
      ok: true,
      data: {
        action: "task_status",
        localSessionId: "session_status",
      },
    });
  });

  test("round-trips a task archive request", async () => {
    const endpoint = controlEndpoint(path.join(os.tmpdir(), `agent-bot-control-archive-${process.pid}-${Date.now()}.sqlite`));
    const server = new LocalControlServer(endpoint, async (request) => ({ ok: true, data: request }));
    servers.push(server);
    await server.start();

    await expect(sendControlRequest(endpoint, {
      action: "task_archive",
      localSessionId: "session_archive",
    })).resolves.toEqual({
      ok: true,
      data: {
        action: "task_archive",
        localSessionId: "session_archive",
      },
    });
  });

  test("round-trips a task release request", async () => {
    const endpoint = controlEndpoint(path.join(os.tmpdir(), `agent-bot-control-release-${process.pid}-${Date.now()}.sqlite`));
    const server = new LocalControlServer(endpoint, async (request) => ({ ok: true, data: request }));
    servers.push(server);
    await server.start();

    await expect(sendControlRequest(endpoint, {
      action: "task_release",
      localSessionId: "session_release",
    })).resolves.toEqual({
      ok: true,
      data: {
        action: "task_release",
        localSessionId: "session_release",
      },
    });
  });

  test("round-trips a task dismiss request", async () => {
    const endpoint = controlEndpoint(path.join(os.tmpdir(), `agent-bot-control-dismiss-${process.pid}-${Date.now()}.sqlite`));
    const server = new LocalControlServer(endpoint, async (request) => ({ ok: true, data: request }));
    servers.push(server);
    await server.start();

    await expect(sendControlRequest(endpoint, {
      action: "task_dismiss",
      localSessionId: "session_dismiss",
    })).resolves.toEqual({
      ok: true,
      data: {
        action: "task_dismiss",
        localSessionId: "session_dismiss",
      },
    });
  });

  test.skipIf(process.platform !== "win32")("rejects a second server for the same Windows control pipe", async () => {
    const endpoint = controlEndpoint(path.join(os.tmpdir(), `agent-bot-control-exclusive-${process.pid}-${Date.now()}.sqlite`));
    const first = new LocalControlServer(endpoint, async () => ({ ok: true }));
    const duplicate = new LocalControlServer(endpoint, async () => ({ ok: true }));
    servers.push(first, duplicate);
    await first.start();

    await expect(duplicate.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    await expect(isServerRunning(endpoint)).resolves.toBe(true);
  });
});
