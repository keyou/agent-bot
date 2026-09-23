import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import { describe, expect, test, vi } from "vitest";
import type { AcpProcessManager, ManagedAcpProcess } from "../../src/acp/AcpProcessManager.js";
import { AcpSessionManager } from "../../src/acp/AcpSessionManager.js";
import type { AgentConfig } from "../../src/config/schema.js";

describe("AcpSessionManager", () => {
  test("ignores unused mode metadata while preserving config and prompt handling", async () => {
    const connection = Object.assign(new EventEmitter(), {
      request: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ sessionId: "acp_1", modes: { currentModeId: "plan" }, configOptions: [] })
        .mockResolvedValueOnce({ stopReason: "end_turn" }),
      registerHandler: vi.fn(),
    });
    const managed = { connection } as unknown as ManagedAcpProcess;
    const processManager = { get: vi.fn(), start: vi.fn(() => managed) } as unknown as AcpProcessManager;
    const logger = { debug: vi.fn(), info: vi.fn() } as unknown as Logger;
    const agent = { kind: "acp", title: "Test", command: "test", args: [], env: {} } satisfies AgentConfig;
    const manager = new AcpSessionManager("test", agent, processManager, logger);
    const onUpdate = vi.fn();
    const session = await manager.create({
      localSessionId: "local_1", agentName: "test", cwd: process.cwd(), onUpdate,
      onPermissionRequest: vi.fn(async () => ({ outcome: "cancelled" })),
    });
    expect(session).not.toHaveProperty("modes");
    expect(session.configOptions).toEqual([]);
    const modeUpdate = { sessionUpdate: "current_mode_update", modeId: "code" };
    connection.emit("notification", "session/update", { sessionId: "acp_1", update: modeUpdate });
    expect(session).not.toHaveProperty("modes");
    expect(onUpdate).toHaveBeenCalledWith(session, modeUpdate);
    const configOptions = [{ id: "test", value: "enabled" }];
    connection.emit("notification", "session/update", {
      sessionId: "acp_1", update: { sessionUpdate: "config_option_update", configOptions },
    });
    expect(session.configOptions).toEqual(configOptions);
    await expect(manager.prompt("local_1", "hello")).resolves.toEqual({ stopReason: "end_turn" });
    expect(connection.request).toHaveBeenLastCalledWith("session/prompt", {
      sessionId: "acp_1", prompt: [{ type: "text", text: "hello" }],
    });
  });

  test("uses one long-lived process for all tasks belonging to the same Agent", async () => {
    let nextSession = 1;
    const request = vi.fn(async (method: string) => {
      if (method === "initialize") return { agentInfo: { version: "1.2.3" } };
      if (method === "session/new") return { sessionId: `acp_${nextSession++}` };
      return {};
    });
    const connection = {
      request,
      notify: vi.fn(),
      registerHandler: vi.fn(),
      on: vi.fn(),
      close: vi.fn(),
    };
    const managed = { connection, child: { pid: 5432 } } as unknown as ManagedAcpProcess;
    let running: ManagedAcpProcess | undefined;
    const processManager = {
      start: vi.fn(() => {
        running = managed;
        return managed;
      }),
      get: vi.fn(() => running),
      stop: vi.fn(() => {
        running = undefined;
      }),
      stopAll: vi.fn(() => {
        running = undefined;
      }),
    } as unknown as AcpProcessManager;
    const logger = { debug: vi.fn(), info: vi.fn() } as unknown as Logger;
    const agent = {
      kind: "acp",
      title: "Coco",
      command: "coco",
      args: [],
      env: {},
    } satisfies AgentConfig;
    const manager = new AcpSessionManager("coco", agent, processManager, logger);
    expect(manager.getProcessInfo()).toEqual({});
    const callbacks = {
      agentName: "coco",
      cwd: process.cwd(),
      onUpdate: vi.fn(),
      onPermissionRequest: vi.fn(async () => ({ outcome: "cancelled" })),
    };

    const first = await manager.create({ ...callbacks, localSessionId: "local_1" });
    const second = await manager.create({ ...callbacks, localSessionId: "local_2" });

    expect(first.acpSessionId).toBe("acp_1");
    expect(second.acpSessionId).toBe("acp_2");
    expect(processManager.start).toHaveBeenCalledOnce();
    expect(request.mock.calls.filter(([method]) => method === "initialize")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "session/new")).toHaveLength(2);
    expect(manager.getProcessInfo()).toEqual({ pid: 5432, version: "1.2.3" });

    await manager.close("local_1");
    expect(processManager.stop).not.toHaveBeenCalled();
    expect(manager.get("local_2")).toBe(second);

    manager.shutdown();
    expect(processManager.stopAll).toHaveBeenCalledOnce();
    expect(manager.getProcessInfo()).toEqual({});
  });
});
