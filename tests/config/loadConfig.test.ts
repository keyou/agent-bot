import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { applyExplicitProfile } from "../../src/cli/profile.js";
import {
  loadConfig,
  loadConfigWithoutEnvironmentMutation,
} from "../../src/config/loadConfig.js";
import {
  AGENT_BOT_EXPLICIT_PROFILE_ENV,
  defaultConfigPath,
} from "../../src/config/paths.js";
import { agentConfigSchema, appConfigSchema } from "../../src/config/schema.js";

describe("loadConfig", () => {
  test("enables daily stable updates by default and permits disabling them", () => {
    const minimal = { feishu: {}, agents: { codex: { title: "Codex", command: "codex" } } };
    expect(appConfigSchema.parse(minimal).updates).toEqual({ enabled: true });
    expect(appConfigSchema.parse({ ...minimal, updates: { enabled: false } }).updates).toEqual({ enabled: false });
    expect(() => appConfigSchema.parse({ ...minimal, updates: { enabled: "false" } })).toThrow();
  });
  test("creates and loads the default config from the user data directory", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-home-"));
    const previousHome = process.env.AGENT_BOT_HOME;
    const previousConfig = process.env.AGENT_BOT_CONFIG;
    process.env.AGENT_BOT_HOME = directory;
    process.env.AGENT_BOT_CONFIG = "";

    try {
      const config = loadConfig();

      expect(defaultConfigPath()).toBe(path.join(directory, "config.yaml"));
      expect(fs.existsSync(path.join(directory, "config.yaml"))).toBe(true);
      expect(config.feishu.transport).toBe("auto");
      expect(config.updates).toEqual({ enabled: true });
      expect(Object.keys(config.feishu).sort()).toEqual(
        [
          "appId",
          "appSecret",
          "groupNameFormat",
          "respondToAllGroupMessages",
          "respondToOwnerOnly",
          "thinkingCardLayout",
          "transport",
          "userOpenId",
          "useConsoleWhenMissingCredentials",
        ].sort(),
      );
      expect(config.feishu.respondToAllGroupMessages).toBe(true);
      expect(config.feishu.respondToOwnerOnly).toBe(true);
      expect(config.feishu.groupNameFormat).toEqual({
        project: "[{agent}] [{project}] {taskname}",
        projectless: "[{agent}] {taskname}",
        dateFormat: "MM-dd",
      });
      expect(config.feishu.thinkingCardLayout).toBe("grouped");
      expect(config.fileViewer).toEqual({
        enabled: true,
        host: "127.0.0.1",
        port: 0,
      });
      expect(config.agents.traex).toMatchObject({
        kind: "app-server",
        title: "TraeX",
        command: "traex",
        args: ["app-server", "--listen", "stdio://"],
      });
      expect(config.storage.sqlitePath).toBe(path.join(directory, "data", "agent-bot.sqlite"));
      expect(config.logging.path).toBe(path.join(directory, "logs", "agent-bot.log"));
    } finally {
      restoreEnv("AGENT_BOT_HOME", previousHome);
      restoreEnv("AGENT_BOT_CONFIG", previousConfig);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("loads the checked-in example config", () => {
    const config = loadConfig(path.resolve("config.example.yaml"));
    expect(config.updates).toEqual({ enabled: true });

    expect(config.defaults.agent).toBe("codex");
    expect(config.agents.codex?.kind).toBe("app-server");
    expect(config.agents.traex).toMatchObject({
      kind: "app-server",
      title: "TraeX",
      command: "traex",
      args: ["app-server", "--listen", "stdio://"],
    });
    expect(config.feishu.respondToAllGroupMessages).toBe(true);
    expect(config.feishu.respondToOwnerOnly).toBe(true);
    expect(config.feishu.groupNameFormat.project).toBe("[{agent}] [{project}] {taskname}");
    expect(config.feishu.thinkingCardLayout).toBe("grouped");
    expect(config.fileViewer).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
    });
    expect(config.storage.sqlitePath).toBe(path.resolve("data/agent-bot.sqlite"));
    expect(config.logging.path).toBe(path.resolve("logs/agent-bot.log"));
  });

  test("can require bot mentions for group messages", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-group-mentions-"));
    const configPath = path.join(directory, "config.yaml");
    fs.writeFileSync(configPath, [
      "feishu:",
      "  respondToAllGroupMessages: false",
      "agents:",
      "  codex:",
      "    kind: app-server",
      "    title: Codex",
      "    command: codex",
    ].join("\n"));

    try {
      expect(loadConfig(configPath).feishu.respondToAllGroupMessages).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("can allow Feishu messages from users other than the bot owner", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-owner-access-"));
    const configPath = path.join(directory, "config.yaml");
    fs.writeFileSync(configPath, [
      "feishu:",
      "  respondToOwnerOnly: false",
      "agents:",
      "  codex:",
      "    kind: app-server",
      "    title: Codex",
      "    command: codex",
    ].join("\n"));

    try {
      expect(loadConfig(configPath).feishu.respondToOwnerOnly).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("can restore the original thinking-card timeline layout", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-thinking-card-"));
    const configPath = path.join(directory, "config.yaml");
    fs.writeFileSync(configPath, [
      "feishu:",
      "  thinkingCardLayout: timeline",
      "agents:",
      "  codex:",
      "    kind: app-server",
      "    title: Codex",
      "    command: codex",
    ].join("\n"));

    try {
      expect(loadConfig(configPath).feishu.thinkingCardLayout).toBe("timeline");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("loads custom project and Projectless group name formats", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-group-name-format-"));
    const configPath = path.join(directory, "config.yaml");
    fs.writeFileSync(configPath, [
      "feishu:",
      "  groupNameFormat:",
      "    project: '{os}-{agent}-{project}-{taskname}-{date}'",
      "    projectless: '{os}-{agent}-{taskname}-{date:yyyyMMdd}'",
      "    dateFormat: yyyy-MM-dd",
      "agents:",
      "  codex:",
      "    kind: app-server",
      "    title: Codex",
      "    command: codex",
    ].join("\n"));

    try {
      expect(loadConfig(configPath).feishu.groupNameFormat).toEqual({
        project: "{os}-{agent}-{project}-{taskname}-{date}",
        projectless: "{os}-{agent}-{taskname}-{date:yyyyMMdd}",
        dateFormat: "yyyy-MM-dd",
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects unknown group name placeholders and formats without a task name", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-invalid-group-name-format-"));
    const configPath = path.join(directory, "config.yaml");
    fs.writeFileSync(configPath, [
      "feishu:",
      "  groupNameFormat:",
      "    project: '{agent}-{unknown}'",
      "agents:",
      "  codex:",
      "    title: Codex",
      "    command: codex",
    ].join("\n"));

    try {
      expect(() => loadConfig(configPath)).toThrow(/taskname|Unsupported group name placeholder/u);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("resolves configured storage and log paths relative to the config file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-config-"));
    const configPath = path.join(directory, "config.yaml");
    const existingPath = path.join(directory, "existing.sqlite");
    fs.writeFileSync(existingPath, "");
    fs.writeFileSync(configPath, [
      "agents:",
      "  codex:",
      "    kind: app-server",
      "    title: Codex",
      "    command: codex",
      "feishu: {}",
      "defaults:",
      "  agent: codex",
      "storage:",
      "  sqlitePath: ./state/agent-bot.sqlite",
      "logging:",
      "  path: ./logs/agent-bot.log",
    ].join("\n"));

    try {
      const config = loadConfig(configPath);
      expect(config.storage.sqlitePath).toBe(path.join(directory, "state", "agent-bot.sqlite"));
      expect(config.logging.path).toBe(path.join(directory, "logs", "agent-bot.log"));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("loads explicit profile credentials instead of inherited primary credentials", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-profile-"));
    const preserved = new Map([
      ["AGENT_BOT_HOME", process.env.AGENT_BOT_HOME],
      ["AGENT_BOT_CONFIG", process.env.AGENT_BOT_CONFIG],
      [AGENT_BOT_EXPLICIT_PROFILE_ENV, process.env[AGENT_BOT_EXPLICIT_PROFILE_ENV]],
      ["FEISHU_APP_ID", process.env.FEISHU_APP_ID],
      ["FEISHU_APP_SECRET", process.env.FEISHU_APP_SECRET],
      ["FEISHU_USER_OPEN_ID", process.env.FEISHU_USER_OPEN_ID],
    ]);
    process.env.FEISHU_APP_ID = "primary-app";
    process.env.FEISHU_APP_SECRET = "primary-secret";
    fs.writeFileSync(path.join(directory, "config.yaml"), [
      "feishu:",
      "  appId: ${FEISHU_APP_ID}",
      "  appSecret: ${FEISHU_APP_SECRET}",
      "  userOpenId: ${FEISHU_USER_OPEN_ID}",
      "agents:",
      "  codex:",
      "    kind: app-server",
      "    title: Codex",
      "    command: codex",
      "defaults:",
      "  agent: codex",
      "storage:",
      "  sqlitePath: ./data/agent-bot.sqlite",
      "logging:",
      "  path: ./logs/agent-bot.log",
    ].join("\n"));
    fs.writeFileSync(path.join(directory, ".env"), [
      "FEISHU_APP_ID=rescue-app",
      "FEISHU_APP_SECRET=rescue-secret",
      "FEISHU_USER_OPEN_ID=rescue-user",
    ].join("\n"));

    try {
      applyExplicitProfile(directory);
      const config = loadConfig();

      expect(config.feishu.appId).toBe("rescue-app");
      expect(config.feishu.appSecret).toBe("rescue-secret");
      expect(config.feishu.userOpenId).toBe("rescue-user");
      expect(config.storage.sqlitePath).toBe(path.join(directory, "data", "agent-bot.sqlite"));
    } finally {
      for (const [name, value] of preserved) restoreEnv(name, value);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("loads a persisted user Open ID when the inherited value is blank", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-blank-user-id-"));
    const previousHome = process.env.AGENT_BOT_HOME;
    const previousUserOpenId = process.env.FEISHU_USER_OPEN_ID;
    process.env.AGENT_BOT_HOME = directory;
    process.env.FEISHU_USER_OPEN_ID = "";
    fs.writeFileSync(path.join(directory, "config.yaml"), [
      "feishu:",
      "  userOpenId: ${FEISHU_USER_OPEN_ID}",
      "agents:",
      "  codex:",
      "    kind: app-server",
      "    title: Codex",
      "    command: codex",
      "defaults:",
      "  agent: codex",
    ].join("\n"));
    fs.writeFileSync(path.join(directory, ".env"), "FEISHU_USER_OPEN_ID=ou_persisted_user\n");

    try {
      expect(loadConfig(path.join(directory, "config.yaml")).feishu.userOpenId).toBe("ou_persisted_user");
    } finally {
      restoreEnv("AGENT_BOT_HOME", previousHome);
      restoreEnv("FEISHU_USER_OPEN_ID", previousUserOpenId);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("inspects an explicit profile without retaining values loaded from its environment file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-profile-inspection-"));
    const preserved = new Map([
      ["AGENT_BOT_HOME", process.env.AGENT_BOT_HOME],
      ["AGENT_BOT_CONFIG", process.env.AGENT_BOT_CONFIG],
      [AGENT_BOT_EXPLICIT_PROFILE_ENV, process.env[AGENT_BOT_EXPLICIT_PROFILE_ENV]],
      ["FEISHU_APP_ID", process.env.FEISHU_APP_ID],
      ["FEISHU_APP_SECRET", process.env.FEISHU_APP_SECRET],
      ["RESET_ONLY_VALUE", process.env.RESET_ONLY_VALUE],
    ]);
    fs.writeFileSync(path.join(directory, "config.yaml"), [
      "feishu:",
      "  appId: ${FEISHU_APP_ID}",
      "  appSecret: ${FEISHU_APP_SECRET}",
      "agents:",
      "  codex:",
      "    kind: app-server",
      "    title: Codex",
      "    command: codex",
      "defaults:",
      "  agent: codex",
      "storage:",
      "  sqlitePath: ./data/agent-bot.sqlite",
      "logging:",
      "  path: ./logs/agent-bot.log",
    ].join("\n"));
    fs.writeFileSync(path.join(directory, ".env"), [
      "FEISHU_APP_ID=rescue-app",
      "FEISHU_APP_SECRET=rescue-secret",
      "RESET_ONLY_VALUE=old-profile-value",
    ].join("\n"));

    try {
      applyExplicitProfile(directory);
      delete process.env.RESET_ONLY_VALUE;

      const config = loadConfigWithoutEnvironmentMutation();

      expect(config.feishu.appId).toBe("rescue-app");
      expect(config.feishu.appSecret).toBe("rescue-secret");
      expect(process.env.FEISHU_APP_ID).toBeUndefined();
      expect(process.env.FEISHU_APP_SECRET).toBeUndefined();
      expect(process.env.RESET_ONLY_VALUE).toBeUndefined();
    } finally {
      for (const [name, value] of preserved) restoreEnv(name, value);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

});

test("uses ACP when agent kind is omitted", () => {
  const parsed = agentConfigSchema.parse({ title: "Example", command: "node" });

  expect(parsed.kind).toBe("acp");
  expect(parsed.defaults).toEqual({});
});

test("parses per-Agent execution defaults", () => {
  const parsed = agentConfigSchema.parse({
    title: "Example",
    command: "node",
    defaults: {
      modelProvider: "openai",
      model: "gpt-next",
      reasoningEffort: "high",
      permissionMode: "confirm",
    },
  });

  expect(parsed.defaults).toEqual({
    modelProvider: "openai",
    model: "gpt-next",
    reasoningEffort: "high",
    permissionMode: "confirm",
  });
});

test("normalizes the previous Codex kind to App Server", () => {
  const parsed = agentConfigSchema.parse({ kind: "codex", title: "Codex", command: "codex" });

  expect(parsed.kind).toBe("app-server");
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
