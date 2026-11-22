import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parse } from "yaml";
import {
  SETTINGS_SECTIONS,
  SettingsStore,
} from "../../src/config/SettingsStore.js";
import { appConfigSchema } from "../../src/config/schema.js";
import type { ModelListResult } from "../../src/runtime/types.js";

const catalog: ModelListResult = {
  models: [
    {
      id: "Upstream-ID",
      displayName: "Upstream Name",
      isDefault: true,
      supportedReasoningEfforts: [{ value: "high" }, { value: "xhigh" }],
    },
    { id: "Small-ID", supportedReasoningEfforts: [{ value: "low" }] },
    { id: "No-Reasoning", supportedReasoningEfforts: [] },
  ],
};

const directories: string[] = [];
const yaml = `# keep comments
feishu:
  appId: cli_test
  appSecret: "\${SETTINGS_TEST_SECRET}"
  userOpenId: ou_owner
agents:
  codex:
    kind: app-server
    title: Codex
    command: codex
    env: {TOKEN: "\${SETTINGS_TEST_SECRET}"}
    defaults: {modelProvider: openai, model: Model-UPPER, permissionMode: confirm}
  traex:
    kind: app-server
    title: TraeX
    command: traex
defaults: {agent: codex, cwd: .}
custom: keep
`;
const singleAgentYaml = yaml.replace(
  "  traex:\n    kind: app-server\n    title: TraeX\n    command: traex\n",
  "",
);

function fixture(contents = yaml) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-bot-settings-"),
  );
  directories.push(directory);
  const file = path.join(directory, "config.yaml");
  fs.writeFileSync(file, contents);
  const active = appConfigSchema.parse(parse(contents));
  return {
    directory,
    file,
    active,
    store: new SettingsStore(file, active),
    read: () => fs.readFileSync(file, "utf8"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  test("saves terminal passwords without exposing them in snapshots or overwriting them on blank saves", () => {
    const f = fixture();
    const initial = f.store.read("services");
    expect(initial.values.terminalPassword).toBe("");
    expect(initial.pendingRestart).toBe(false);
    const password = " custom terminal pass ";
    const saved = f.store.saveField("services", undefined, "terminalPassword", initial.fieldRevisions.terminalPassword, password);
    expect(parse(f.read()).terminal.password).toBe(password);
    expect(saved.values.terminalPassword).toBe("");
    expect(JSON.stringify(saved)).not.toContain(password);
    expect(saved.pendingRestart).toBe(true);
    const previous = f.read();
    f.store.saveField("services", undefined, "terminalPassword", saved.fieldRevisions.terminalPassword, "");
    expect(f.read()).toBe(previous);
    f.store.saveField("services", undefined, "logLevel", saved.fieldRevisions.logLevel, "warn");
    expect(parse(f.read()).terminal.password).toBe(password);
    expect(() => f.store.saveField("services", undefined, "terminalPassword", initial.fieldRevisions.terminalPassword, "new-value")).toThrow("已变化");
  });

  test.each(["bad\npassword", "bad\0password", "a".repeat(257)])("rejects invalid terminal passwords without saving or echoing their contents", (password) => {
    const f = fixture();
    const view = f.store.read("services");
    const previous = f.read();
    expect(() => f.store.saveField("services", undefined, "terminalPassword", view.fieldRevisions.terminalPassword, password)).toThrow("配置项无效");
    expect(f.read()).toBe(previous);
  });

  test("reads only allowlisted fields with defaults and no credentials", () => {
    vi.stubEnv("SETTINGS_TEST_SECRET", "never-show-this-secret");
    const f = fixture();
    for (const section of Object.keys(SETTINGS_SECTIONS)) {
      const view = f.store.read(section);
      expect(view.fields.length).toBeGreaterThan(0);
      expect(view.pendingRestart).toBe(false);
      expect(JSON.stringify(view)).not.toContain("never-show-this-secret");
      expect(Object.keys(view.values)).not.toContain("appSecret");
      expect(Object.keys(view.values)).not.toContain("command");
    }
    expect(f.store.read().values).toEqual({
      agent: "codex",
      updates: true,
      ownerOnly: true,
      allGroupMessages: true,
    });
    expect(f.store.read("agents", "codex").values.model).toBe("Model-UPPER");
    expect(f.store.read("agents", "traex").values.permissionMode).toBe("");
  });

  test("opens Common first and exposes every supported option exactly once", () => {
    const f = fixture();
    expect(Object.values(SETTINGS_SECTIONS)).toEqual([
      "常用",
      "Agent",
      "群名",
      "高级",
    ]);
    expect(f.store.read().section).toBe("general");
    expect(f.store.read().fields.map((entry) => entry.name)).toEqual([
      "agent",
      "ownerOnly",
      "allGroupMessages",
      "updates",
    ]);
    expect(f.store.read("services").fields.map((entry) => entry.name)).toEqual([
      "console",
      "terminal",
      "terminalPassword",
      "preview",
      "host",
      "port",
      "logLevel",
    ]);
    const paths = Object.keys(SETTINGS_SECTIONS).flatMap((section) =>
      f.store
        .read(section, "codex")
        .fields.map((entry) => entry.path.join(".")),
    );
    expect(paths).toHaveLength(17);
    expect(paths).not.toContain("fileViewer.publicBaseUrl");
    expect(paths).not.toContain("agents.codex.defaults.modelProvider");
    expect(paths).not.toContain("feishu.thinkingCardLayout");
    expect(paths).not.toContain("defaults.cwd");
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("saves only one section, preserves YAML and active settings, and detects pending restart", () => {
    const f = fixture(yaml.replace("cwd: .", "cwd: D:/work space"));
    const before = structuredClone(f.active);
    const view = f.store.read();
    const result = f.store.save("general", undefined, view.revision, {
      ...view.values,
      agent: "traex",
      updates: false,
      ownerOnly: false,
    });
    expect(result.pendingRestart).toBe(true);
    expect(result.revision).not.toBe(view.revision);
    expect(f.active).toEqual(before);
    expect(f.read()).toContain("# keep comments");
    expect(f.read()).toContain("${SETTINGS_TEST_SECRET}");
    expect(parse(f.read())).toMatchObject({
      defaults: { agent: "traex", cwd: "D:/work space" },
      updates: { enabled: false },
      feishu: { respondToOwnerOnly: false },
      agents: parse(yaml).agents,
      custom: "keep",
    });
    expect(fs.readdirSync(f.directory)).toEqual(["config.yaml"]);
    const restarted = new SettingsStore(
      f.file,
      appConfigSchema.parse(parse(f.read())),
    );
    expect(restarted.read().pendingRestart).toBe(false);
  });

  test("does not expose directory changes or allow old forms to edit the directory", () => {
    const f = fixture();
    f.active.defaults.cwd = "D:/other runtime directory";
    const view = f.store.read();
    expect(view.values).not.toHaveProperty("cwd");
    expect(view.pendingRestart).toBe(false);
    expect(() =>
      f.store.save("general", undefined, view.revision, {
        ...view.values,
        cwd: "D:/unexpected directory",
      }),
    ).toThrow("不允许修改");
    expect(f.read()).toBe(yaml);
  });

  test("does not rewrite no-op forms or materialize absent defaults", () => {
    const f = fixture(yaml.replaceAll("\n", "\r\n"));
    const original = f.read();
    for (const section of Object.keys(SETTINGS_SECTIONS)) {
      const view = f.store.read(section, "traex");
      const values = { ...view.values };
      if (section === "agents") values.permissionMode = "__agent_default__";
      if (section === "services") values.port = "0";
      f.store.save(section, view.agentName, view.revision, values);
      expect(f.read()).toBe(original);
    }
  });

  test("changes or clears one Agent's defaults without changing another Agent", () => {
    const f = fixture();
    const view = f.store.read("agents", "codex");
    f.store.save(
      "agents",
      "codex",
      view.revision,
      {
        model: "Upstream-ID",
        reasoningEffort: "xhigh",
        permissionMode: "auto",
      },
      catalog,
    );
    const edited = parse(f.read());
    expect(edited.agents.codex.defaults).toEqual({
      modelProvider: "openai",
      model: "Upstream-ID",
      reasoningEffort: "xhigh",
      permissionMode: "auto",
    });
    expect(edited.agents.traex).toEqual(parse(yaml).agents.traex);
    const current = f.store.read("agents", "codex");
    f.store.save("agents", "codex", current.revision, {
      model: "__agent_default__",
      reasoningEffort: "__agent_default__",
      permissionMode: "__agent_default__",
    });
    expect(parse(f.read()).agents.codex.defaults).toEqual({
      modelProvider: "openai",
    });
    expect(f.active.agents.codex!.defaults.model).toBe("Model-UPPER");
  });

  test.each([
    ["general", { ownerOnly: false, allGroupMessages: false }],
    [
      "naming",
      {
        project: "{project} {taskname}",
        projectless: "{taskname}",
        dateFormat: "yyyy-MM-dd",
      },
    ],
    [
      "services",
      {
        console: false,
        terminal: false,
        preview: true,
        host: "0.0.0.0",
        port: "1423",
        logLevel: "warn",
      },
    ],
  ])("persists %s options and reports restart needed", (section, values) => {
    const f = fixture();
    const view = f.store.read(section);
    expect(
      f.store.save(section, undefined, view.revision, {
        ...view.values,
        ...values,
      }).pendingRestart,
    ).toBe(true);
    const saved = f.store.read(section).values;
    expect(saved).toEqual({
      ...view.values,
      ...values,
      ...(section === "services" ? { port: 1423 } : {}),
    });
  });

  test("rejects stale forms, including external file changes, without writing", () => {
    const f = fixture();
    const old = f.store.read();
    fs.appendFileSync(f.file, "# external edit\n");
    const changed = f.read();
    expect(() =>
      f.store.save("general", undefined, old.revision, {
        ...old.values,
        updates: false,
      }),
    ).toThrow("配置已变化");
    expect(f.read()).toBe(changed);
  });

  test.each([
    ["general", "agent", "not-configured"],
    ["general", "updates", "false"],
    ["services", "logLevel", "all"],
    ["agents", "permissionMode", "admin"],
    ["agents", "model", { model: "wrong-type" }],
    ["services", "port", "-1"],
    ["services", "port", "65536"],
    ["services", "port", "1.5"],
    ["services", "port", ""],
    ["services", "host", "http://host/"],
    ["naming", "project", "missing-task"],
    ["naming", "projectless", "{taskname}{taskname}"],
    ["naming", "project", "{unknown}{taskname}"],
  ])("rejects invalid %s.%s atomically", (section, name, value) => {
    const f = fixture();
    const view = f.store.read(section, "codex");
    const before = f.read();
    expect(() =>
      f.store.save(section, view.agentName, view.revision, {
        ...view.values,
        [name]: value,
      }),
    ).toThrow();
    expect(f.read()).toBe(before);
  });

  test("rejects unknown sections, Agents, extra fields and incomplete forms", () => {
    const f = fixture();
    const view = f.store.read();
    for (const section of ["__proto__", "constructor", "secret", undefined]) {
      if (section === undefined) continue;
      expect(() => f.store.read(section)).toThrow("无效的配置分组");
    }
    expect(() => f.store.read("agents", "__proto__")).toThrow("请选择");
    expect(() =>
      f.store.save("general", undefined, view.revision, {
        ...view.values,
        appSecret: "override",
      }),
    ).toThrow("不允许");
    expect(() =>
      f.store.save("general", undefined, view.revision, { agent: "codex" }),
    ).toThrow("缺少配置项");
    expect(() => f.store.save("general", undefined, view.revision, [])).toThrow(
      "缺少配置表单",
    );
    expect(f.read()).toBe(yaml);
  });

  test("rejects the removed layout control while preserving an obsolete YAML key", () => {
    const f = fixture(
      yaml.replace("feishu:\n", "feishu:\n  thinkingCardLayout: timeline\n"),
    );
    const view = f.store.read();
    expect(view.values).not.toHaveProperty("layout");
    expect(() =>
      f.store.save("general", undefined, view.revision, {
        ...view.values,
        layout: "grouped",
      }),
    ).toThrow("不允许修改");
    f.store.save("general", undefined, view.revision, {
      ...view.values,
      updates: false,
    });
    expect(parse(f.read()).feishu.thinkingCardLayout).toBe("timeline");
  });

  test("preserves environment references on unrelated edits", () => {
    vi.stubEnv("SETTINGS_TEST_MODEL", "effective-model");
    const f = fixture(yaml.replace("Model-UPPER", '"${SETTINGS_TEST_MODEL}"'));
    const view = f.store.read("agents", "codex");
    expect(view.values.model).toBe("effective-model");
    f.store.save("agents", "codex", view.revision, {
      ...view.values,
      permissionMode: "auto",
    });
    expect(f.read()).toContain("${SETTINGS_TEST_MODEL}");
    expect(f.read()).not.toContain("effective-model");
  });

  test("exposes exactly three dropdowns with upstream identifiers and current fallback values", () => {
    const f = fixture();
    const view = f.store.read("agents", "codex", catalog);
    expect(
      view.fields.map(({ name, kind, label }) => ({ name, kind, label })),
    ).toEqual([
      { name: "model", kind: "select", label: "默认模型" },
      { name: "reasoningEffort", kind: "select", label: "默认思考强度" },
      { name: "permissionMode", kind: "select", label: "默认权限" },
    ]);
    expect(view.fields[0]!.options).toContainEqual({
      value: "Upstream-ID",
      label: "Upstream Name (Upstream-ID)",
    });
    expect(view.fields[0]!.options).toContainEqual({
      value: "Model-UPPER",
      label: "Model-UPPER（当前配置）",
    });
    expect(view.fields[1]!.options?.map((entry) => entry.value)).toEqual([
      "",
      "high",
      "xhigh",
      "low",
    ]);
    expect(view.values).not.toHaveProperty("modelProvider");
  });

  test.each([
    { model: "not-in-catalog", reasoningEffort: "" },
    { model: "upstream-id", reasoningEffort: "high" },
    { model: "Upstream-ID", reasoningEffort: "unsupported" },
    { model: "Small-ID", reasoningEffort: "high" },
    { model: "No-Reasoning", reasoningEffort: "high" },
    { model: "__agent_default__", reasoningEffort: "low" },
    { modelProvider: "changed" },
  ])("rejects invalid selections atomically: %j", (selection) => {
    const f = fixture();
    const view = f.store.read("agents", "codex", catalog);
    expect(() =>
      f.store.save(
        "agents",
        "codex",
        view.revision,
        { ...view.values, ...selection, permissionMode: "auto" },
        catalog,
      ),
    ).toThrow();
    expect(f.read()).toBe(yaml);
  });

  test("validates unchanged effort when the model changes and accepts the runtime default model", () => {
    const f = fixture(
      yaml.replace(
        "permissionMode: confirm",
        "reasoningEffort: high, permissionMode: confirm",
      ),
    );
    const view = f.store.read("agents", "codex", catalog);
    expect(() =>
      f.store.save(
        "agents",
        "codex",
        view.revision,
        { ...view.values, model: "Small-ID" },
        catalog,
      ),
    ).toThrow("不支持此思考强度");
    f.store.save(
      "agents",
      "codex",
      view.revision,
      { ...view.values, model: "__agent_default__" },
      catalog,
    );
    expect(parse(f.read()).agents.codex.defaults).toEqual({
      modelProvider: "openai",
      reasoningEffort: "high",
      permissionMode: "confirm",
    });
  });

  test("keeps unavailable model and effort defaults when editing only permissions", () => {
    const contents = yaml.replace(
      "permissionMode: confirm",
      "reasoningEffort: custom, permissionMode: confirm",
    );
    const f = fixture(contents);
    const view = f.store.read("agents", "codex", { models: [] });
    expect(view.fields[0]!.options?.map((entry) => entry.value)).toEqual([
      "",
      "Model-UPPER",
    ]);
    expect(view.fields[1]!.options?.map((entry) => entry.value)).toEqual([
      "",
      "custom",
    ]);
    f.store.save("agents", "codex", view.revision, view.values, { models: [] });
    expect(f.read()).toBe(contents);
    f.store.save(
      "agents",
      "codex",
      view.revision,
      { ...view.values, permissionMode: "auto" },
      { models: [] },
    );
    expect(parse(f.read()).agents.codex.defaults).toEqual({
      modelProvider: "openai",
      model: "Model-UPPER",
      reasoningEffort: "custom",
      permissionMode: "auto",
    });
  });

  test("shows effective environment-backed switches and preserves their references on no-op saves", () => {
    vi.stubEnv("SETTINGS_TEST_UPDATES", "true");
    vi.stubEnv("SETTINGS_TEST_AGENT", "traex");
    const contents =
      yaml.replace("agent: codex", "agent: '${SETTINGS_TEST_AGENT}'") +
      "updates:\n  enabled: ${SETTINGS_TEST_UPDATES}\n";
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-bot-settings-env-"),
    );
    directories.push(directory);
    const file = path.join(directory, "config.yaml");
    fs.writeFileSync(file, contents);
    const config = appConfigSchema.parse(
      parse(
        contents
          .replaceAll("${SETTINGS_TEST_UPDATES}", "true")
          .replaceAll("${SETTINGS_TEST_AGENT}", "traex"),
      ),
    );
    const store = new SettingsStore(file, config);
    const view = store.read();
    expect(view.values).toMatchObject({ updates: true, agent: "traex" });
    expect(view.pendingRestart).toBe(false);
    store.save("general", undefined, view.revision, view.values);
    expect(fs.readFileSync(file, "utf8")).toBe(contents);
  });

  test("keeps the original file and removes temporary output on rename failure", () => {
    const f = fixture();
    const view = f.store.read();
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated write failure");
    });
    expect(() =>
      f.store.save("general", undefined, view.revision, {
        ...view.values,
        updates: false,
      }),
    ).toThrow("simulated write failure");
    expect(f.read()).toBe(yaml);
    expect(fs.readdirSync(f.directory)).toEqual(["config.yaml"]);
  });

  test("hides and rejects the address control without changing the existing URL", () => {
    const contents =
      yaml + 'fileViewer:\n  publicBaseUrl: "https://bot.example/prefix"\n';
    const f = fixture(contents);
    const view = f.store.read("services");
    expect(view.values).not.toHaveProperty("publicBaseUrl");
    expect(() =>
      f.store.saveField(
        "services",
        undefined,
        "publicBaseUrl",
        view.revision,
        "",
      ),
    ).toThrow("不允许");
    f.store.saveField(
      "services",
      undefined,
      "logLevel",
      view.fieldRevisions.logLevel,
      "warn",
    );
    expect(parse(f.read()).fileViewer.publicBaseUrl).toBe(
      "https://bot.example/prefix",
    );
  });

  test("uses Provider and model defaults instead of the only configured Agent on Common", () => {
    const f = fixture(singleAgentYaml);
    const view = f.store.read();
    expect(view.agentName).toBe("codex");
    expect(view.fields.map((entry) => entry.name)).toEqual([
      "modelProvider",
      "model",
      "ownerOnly",
      "allGroupMessages",
      "updates",
    ]);
    expect(f.store.read("agents").fields.map((entry) => entry.name)).toEqual([
      "reasoningEffort",
      "permissionMode",
    ]);
    expect(() =>
      f.store.saveField("general", undefined, "agent", view.revision, "codex"),
    ).toThrow("不允许");
    expect(f.read()).toBe(singleAgentYaml);
  });

  test("atomically selects a new Provider's model and clears incompatible reasoning only for new tasks", () => {
    const f = fixture(
      singleAgentYaml.replace(
        "permissionMode: confirm",
        "reasoningEffort: old-effort, permissionMode: confirm",
      ),
    );
    const before = structuredClone(f.active);
    const target = {
      ...catalog,
      providers: [
        { id: "openai" },
        { id: "New-Provider", displayName: "New Provider" },
      ],
    };
    const view = f.store.read("general", undefined, target);
    expect(view.fields[0]!.options).toContainEqual({
      value: "New-Provider",
      label: "New Provider (New-Provider)",
    });
    const saved = f.store.saveField(
      "general",
      undefined,
      "modelProvider",
      view.fieldRevisions.modelProvider,
      "New-Provider",
      target,
    );
    expect(saved.values).toMatchObject({
      modelProvider: "New-Provider",
      model: "Upstream-ID",
    });
    expect(parse(f.read()).agents.codex.defaults).toEqual({
      modelProvider: "New-Provider",
      model: "Upstream-ID",
      permissionMode: "confirm",
    });
    expect(f.active).toEqual(before);
    const thinking = f.store.read("agents", "codex", target);
    f.store.saveField(
      "agents",
      "codex",
      "reasoningEffort",
      thinking.fieldRevisions.reasoningEffort,
      "high",
      target,
    );
    expect(f.store.read("agents").values.reasoningEffort).toBe("high");
  });

  test("preserves a supported model and rejects unknown Providers on single-Agent autosave", () => {
    const f = fixture(singleAgentYaml);
    const target = {
      models: [{ id: "Model-UPPER", supportedReasoningEfforts: [] }],
      providers: [{ id: "other" }],
    };
    const view = f.store.read();
    expect(() =>
      f.store.saveField(
        "general",
        undefined,
        "modelProvider",
        view.fieldRevisions.modelProvider,
        "unknown",
        target,
      ),
    ).toThrow("无效");
    expect(f.read()).toBe(singleAgentYaml);
    f.store.saveField(
      "general",
      undefined,
      "modelProvider",
      view.fieldRevisions.modelProvider,
      "other",
      target,
    );
    expect(f.store.read().values).toMatchObject({
      modelProvider: "other",
      model: "Model-UPPER",
    });
  });

  test("autosaves independent fields from the same card without overwriting other edits", () => {
    const f = fixture();
    const view = f.store.read();
    f.store.saveField(
      "general",
      undefined,
      "updates",
      view.fieldRevisions.updates,
      false,
    );
    f.store.saveField(
      "general",
      undefined,
      "ownerOnly",
      view.fieldRevisions.ownerOnly,
      false,
    );
    expect(f.store.read().values).toMatchObject({
      updates: false,
      ownerOnly: false,
    });
    expect(f.active.updates.enabled).toBe(true);
    expect(f.read()).toContain("${SETTINGS_TEST_SECRET}");
    expect(() =>
      f.store.saveField(
        "general",
        undefined,
        "updates",
        view.fieldRevisions.updates,
        true,
      ),
    ).toThrow("已变化");
    expect(f.store.read().values.updates).toBe(false);
  });

  test("rejects invalid individual input without writing", () => {
    const f = fixture();
    const view = f.store.read("naming");
    expect(() =>
      f.store.saveField(
        "naming",
        undefined,
        "project",
        view.fieldRevisions.project,
        "incomplete",
      ),
    ).toThrow();
    expect(f.read()).toBe(yaml);
    const services = f.store.read("services");
    expect(() =>
      f.store.saveField(
        "services",
        undefined,
        "port",
        services.fieldRevisions.port,
        "abc",
      ),
    ).toThrow();
    expect(f.read()).toBe(yaml);
    f.store.saveField(
      "services",
      undefined,
      "port",
      services.fieldRevisions.port,
      "1423",
    );
    expect(f.store.read("services").values.port).toBe(1423);
  });

  test("autosaves a model with compatible reasoning or restores the Agent reasoning default", () => {
    const f = fixture(
      yaml.replace(
        "permissionMode: confirm",
        "reasoningEffort: high, permissionMode: confirm",
      ),
    );
    const view = f.store.read("agents", "codex", catalog);
    const compatible = f.store.saveField(
      "agents",
      "codex",
      "model",
      view.fieldRevisions.model,
      "Upstream-ID",
      catalog,
    );
    expect(compatible.values).toMatchObject({
      model: "Upstream-ID",
      reasoningEffort: "high",
    });
    const next = f.store.saveField(
      "agents",
      "codex",
      "model",
      compatible.fieldRevisions.model,
      "Small-ID",
      catalog,
    );
    expect(next.values).toMatchObject({
      model: "Small-ID",
      reasoningEffort: "",
    });
    expect(() =>
      f.store.saveField(
        "agents",
        "codex",
        "reasoningEffort",
        compatible.fieldRevisions.reasoningEffort,
        "xhigh",
        catalog,
      ),
    ).toThrow("已变化");
    expect(parse(f.read()).agents.codex.defaults).toEqual({
      modelProvider: "openai",
      model: "Small-ID",
      permissionMode: "confirm",
    });
  });

  test("rejects broken YAML without echoing source or secrets", () => {
    const f = fixture();
    fs.writeFileSync(f.file, "appSecret: [very-sensitive,\n");
    expect(() => f.store.read()).toThrow("配置文件不是有效");
    try {
      f.store.read();
    } catch (error) {
      expect(String(error)).not.toContain("very-sensitive");
    }
  });
});
