import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parse } from "yaml";
import { writeAgentExecutionDefaults } from "../../src/config/AgentExecutionDefaultsStore.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("writeAgentExecutionDefaults", () => {
  test("creates missing defaults in an older config and keeps subsequent writes idempotent", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-agent-defaults-"));
    directories.push(directory);
    const configPath = path.join(directory, "config.yaml");
    const original = [
      "# existing installation",
      "agents:",
      "  codex:",
      "    title: Codex",
      "    command: codex",
      "    env:",
      "      TOKEN: ${CODEX_TOKEN}",
      "  traex:",
      "    title: TraeX",
      "    command: traex",
      "custom: keep",
      "",
    ].join("\n");
    fs.writeFileSync(configPath, original, "utf8");
    const defaults = {
      modelProvider: "openai",
      model: "gpt-6-astra",
      reasoningEffort: "xhigh",
      permissionMode: "auto" as const,
    };

    expect(writeAgentExecutionDefaults(configPath, "codex", defaults)).toBe(true);
    const contents = fs.readFileSync(configPath, "utf8");
    const expected = parse(original);
    expected.agents.codex.defaults = defaults;
    expect(parse(contents)).toEqual(expected);
    expect(contents).toContain("# existing installation");
    expect(contents).toContain("${CODEX_TOKEN}");
    expect(writeAgentExecutionDefaults(configPath, "codex", defaults)).toBe(false);
    expect(fs.readFileSync(configPath, "utf8")).toBe(contents);
    expect(fs.readdirSync(directory)).toEqual(["config.yaml"]);
  });

  test("atomically updates one Agent while preserving comments and unrelated settings", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-agent-defaults-"));
    directories.push(directory);
    const configPath = path.join(directory, "config.yaml");
    fs.writeFileSync(configPath, [
      "# keep this comment",
      "agents:",
      "  codex:",
      "    title: Codex",
      "    command: codex",
      "    defaults:",
      "      permissionMode: auto",
      "  traex:",
      "    title: TraeX",
      "    command: traex",
      "custom: keep",
      "",
    ].join("\n"), "utf8");

    expect(writeAgentExecutionDefaults(configPath, "codex", {
      modelProvider: "openai",
      model: "gpt-next",
      reasoningEffort: "high",
      permissionMode: "confirm",
    })).toBe(true);
    expect(writeAgentExecutionDefaults(configPath, "codex", {
      modelProvider: "openai",
      model: "gpt-next",
      reasoningEffort: "high",
      permissionMode: "confirm",
    })).toBe(false);

    const contents = fs.readFileSync(configPath, "utf8");
    const parsed = parse(contents) as Record<string, unknown>;
    expect(contents).toContain("# keep this comment");
    expect(parsed).toMatchObject({
      agents: {
        codex: {
          defaults: {
            modelProvider: "openai",
            model: "gpt-next",
            reasoningEffort: "high",
            permissionMode: "confirm",
          },
        },
        traex: { title: "TraeX" },
      },
      custom: "keep",
    });
    expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("rejects an Agent that is not configured", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-agent-defaults-"));
    directories.push(directory);
    const configPath = path.join(directory, "config.yaml");
    fs.writeFileSync(configPath, "agents:\n  codex:\n    title: Codex\n", "utf8");

    expect(() => writeAgentExecutionDefaults(configPath, "traex", { model: "x" }))
      .toThrow("not configured");
  });
});
