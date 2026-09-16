import fs from "node:fs";
import path from "node:path";
import { config as loadDotEnv } from "dotenv";
import YAML from "yaml";
import { appConfigSchema, type AppConfig } from "./schema.js";
import {
  AGENT_BOT_EXPLICIT_PROFILE_ENV,
  defaultConfigPath,
  defaultDotEnvPath,
  resolveUserPath,
} from "./paths.js";

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/gi;
const DEFAULT_CONFIG = `feishu:
  appId: "\${FEISHU_APP_ID}"
  appSecret: "\${FEISHU_APP_SECRET}"
  userOpenId: "\${FEISHU_USER_OPEN_ID}"
  respondToOwnerOnly: true
  respondToAllGroupMessages: true
  groupNameFormat:
    project: "[{agent}] [{project}] {taskname}"
    projectless: "[{agent}] {taskname}"
    dateFormat: "MM-dd"
  thinkingCardLayout: "grouped"

console:
  enabled: true

updates:
  # Daily stable update check, private 60-second cancellation window, then safe update.
  enabled: true

fileViewer:
  enabled: true
  # Use 0.0.0.0 to accept LAN connections and automatically prefer
  # wired, Wi-Fi, other physical, then VPN addresses in generated links.
  host: "127.0.0.1"
  # 0 selects a free port once and reuses it for this Profile.
  port: 0
  # Overrides the automatically selected URL for domains or reverse proxies.
  # publicBaseUrl: "https://agentbot.example.com/files"

agents:
  codex:
    kind: "app-server"
    title: "Codex"
    command: "codex"
    args:
      - "app-server"
      - "--enable"
      - "goals"
      - "--listen"
      - "stdio://"
    env: {}
    # Updated automatically by the Provider, Model, Thinking, and Permission settings.
    defaults:
      # modelProvider: "openai"
      # model: "gpt-5"
      # reasoningEffort: "high"
      permissionMode: "auto"

  traex:
    kind: "app-server"
    title: "TraeX"
    command: "traex"
    args:
      - "app-server"
      - "--listen"
      - "stdio://"
    env: {}
    defaults:
      permissionMode: "auto"

defaults:
  agent: "codex"
  cwd: "."

storage:
  sqlitePath: "./data/agent-bot.sqlite"

logging:
  level: "info"
  path: "./logs/agent-bot.log"
`;

export function loadConfig(
  configPath?: string,
): AppConfig {
  if (process.env.FEISHU_USER_OPEN_ID !== undefined && !process.env.FEISHU_USER_OPEN_ID.trim()) {
    delete process.env.FEISHU_USER_OPEN_ID;
  }
  loadDotEnv({
    path: defaultDotEnvPath(),
    quiet: true,
    override: process.env[AGENT_BOT_EXPLICIT_PROFILE_ENV] === "1",
  });

  const configuredPath = firstNonBlank(configPath, process.env.AGENT_BOT_CONFIG);
  const absolutePath = resolveUserPath(configuredPath ?? defaultConfigPath());
  if (!fs.existsSync(absolutePath)) {
    if (configuredPath) throw new Error(`Config file does not exist: ${absolutePath}`);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, DEFAULT_CONFIG);
  }

  const raw = fs.readFileSync(absolutePath, "utf8");
  const expanded = expandEnv(raw);
  const parsed = YAML.parse(expanded) as unknown;
  const config = appConfigSchema.parse(parsed);

  const defaultAgent = config.defaults.agent ?? Object.keys(config.agents)[0];
  if (!config.agents[defaultAgent]) {
    throw new Error(`Default agent "${defaultAgent}" is not configured.`);
  }

  const configDirectory = path.dirname(absolutePath);
  const sqlitePath = resolveUserPath(config.storage.sqlitePath, configDirectory);
  return {
    ...config,
    defaults: {
      ...config.defaults,
      agent: defaultAgent,
      cwd: path.resolve(config.defaults.cwd),
    },
    storage: {
      sqlitePath,
    },
    logging: {
      ...config.logging,
      path: resolveUserPath(config.logging.path, configDirectory),
    },
  };
}

export function loadConfigWithoutEnvironmentMutation(configPath?: string): AppConfig {
  const environment = new Map(Object.entries(process.env));
  try {
    return loadConfig(configPath);
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!environment.has(name)) delete process.env[name];
    }
    for (const [name, value] of environment) {
      process.env[name] = value;
    }
  }
}

function expandEnv(raw: string): string {
  return raw.replace(ENV_PATTERN, (_match, name: string) => process.env[name] ?? "");
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}
