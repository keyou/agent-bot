import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../../src/config/schema.js";
import {
  readInitializationReceipt,
  resolveInitializationWelcomeKind,
  sendInitializationWelcome,
  writeInitializationReceipt,
} from "../../src/cli/InitializationWelcome.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("initialization welcome", () => {
  test("distinguishes first setup, upgrade, and same-version refresh", () => {
    expect(resolveInitializationWelcomeKind({
      firstInitialization: true,
      currentVersion: "1.0.0",
    })).toBe("first");
    expect(resolveInitializationWelcomeKind({
      firstInitialization: false,
      previousVersion: "0.9.0",
      currentVersion: "1.0.0",
    })).toBe("upgrade");
    expect(resolveInitializationWelcomeKind({
      firstInitialization: false,
      previousVersion: "1.0.0",
      currentVersion: "1.0.0",
    })).toBe("refresh");
  });

  test("persists the last successfully initialized version in the Profile data directory", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-welcome-"));
    directories.push(home);

    expect(readInitializationReceipt(home)).toBeUndefined();
    writeInitializationReceipt(home, "1.2.3", new Date("2026-08-04T01:02:03.000Z"));

    expect(readInitializationReceipt(home)).toEqual({
      version: "1.2.3",
      initializedAt: "2026-08-04T01:02:03.000Z",
    });
  });

  test("sends a Chinese logo card to the configured Lark user", async () => {
    const sendCard = vi.fn(async (
      _config: AppConfig,
      _contextKey: string,
      _card: Record<string, unknown>,
    ) => undefined);
    const result = await sendInitializationWelcome({
      version: "1.2.3",
      previousVersion: "1.2.2",
      kind: "upgrade",
      activationPending: true,
    }, {
      loadConfig: () => config("ou_initializer"),
      logoPath: "D:\\package\\assets\\agent-bot-logo.png",
      sendCard,
    });

    expect(result).toEqual({ status: "sent", kind: "upgrade" });
    expect(sendCard).toHaveBeenCalledOnce();
    expect(sendCard.mock.calls[0]?.[1]).toBe("open_id:ou_initializer");
    const serialized = JSON.stringify(sendCard.mock.calls[0]?.[2]);
    expect(serialized).toContain("Agent Bot 已更新");
    expect(serialized).toContain("本版亮点");
    expect(serialized).toContain("安全重启后生效");
    expect(serialized).not.toContain("What's new");
    expect(serialized).toContain("D:\\\\package\\\\assets\\\\agent-bot-logo.png");
  });

  test("reports a skipped card when the authorizing user is not known", async () => {
    const sendCard = vi.fn(async (
      _config: AppConfig,
      _contextKey: string,
      _card: Record<string, unknown>,
    ) => undefined);
    const result = await sendInitializationWelcome({
      version: "1.2.3",
      kind: "refresh",
    }, {
      loadConfig: () => config(),
      logoPath: "logo.png",
      sendCard,
    });

    expect(result).toEqual({
      status: "skipped",
      kind: "refresh",
      reason: "missing-user-open-id",
    });
    expect(sendCard).not.toHaveBeenCalled();
  });
});

function config(userOpenId?: string): AppConfig {
  return {
    console: { enabled: true },
    fileViewer: { enabled: true, host: "127.0.0.1", port: 0 },
    feishu: {
      transport: "sdk",
      appId: "cli_app",
      appSecret: "secret",
      ...(userOpenId ? { userOpenId } : {}),
      respondToOwnerOnly: true,
      respondToAllGroupMessages: true,
      groupNameFormat: {
        project: "[{agent}] [{project}] {taskname}",
        projectless: "[{agent}] {taskname}",
        dateFormat: "MM-dd",
      },
      useConsoleWhenMissingCredentials: false,
    },
    agents: {
      codex: {
        kind: "app-server",
        title: "Codex",
        command: "codex",
        args: ["app-server"],
        env: {},
        defaults: {},
      },
      traex: {
        kind: "app-server",
        title: "TraeX",
        command: "traecli",
        args: ["app-server"],
        env: {},
        defaults: {},
      },
    },
    defaults: { agent: "codex", cwd: "." },
    storage: { sqlitePath: "state.sqlite" },
    logging: { level: "info", path: "agent-bot.log" },
  };
}
