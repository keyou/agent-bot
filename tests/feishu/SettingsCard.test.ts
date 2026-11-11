import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { stringify } from "yaml";
import { appConfigSchema } from "../../src/config/schema.js";
import {
  SETTINGS_SECTIONS,
  SettingsStore,
} from "../../src/config/SettingsStore.js";
import { renderSettingsCard } from "../../src/feishu/SettingsCard.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function fixture(singleAgent = false) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-bot-settings-card-"),
  );
  dirs.push(dir);
  const file = path.join(dir, "config.yaml");
  const config = appConfigSchema.parse({
    feishu: { appSecret: "private-secret" },
    agents: {
      codex: {
        title: "Codex",
        command: "private-launch-command",
        env: { SECRET: "private-token" },
      },
      ...(singleAgent ? {} : { traex: { title: "TraeX", command: "traex" } }),
    },
  });
  fs.writeFileSync(file, stringify(config));
  return new SettingsStore(file, config);
}
function nodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [
    value as Record<string, unknown>,
    ...Object.values(value).flatMap(nodes),
  ];
}

describe("renderSettingsCard", () => {
  test.each(Object.keys(SETTINGS_SECTIONS))(
    "renders %s with every field and scoped callbacks",
    (section) => {
      const view = fixture().read(section);
      const card = renderSettingsCard(view, "chat_id:c1:thread:t1");
      const all = nodes(card);
      expect(card.schema).toBe("2.0");
      expect(
        all
          .filter(
            (node) =>
              node.name &&
              ["input", "select_static", "checker"].includes(String(node.tag)),
          )
          .map((node) => node.name),
      ).toEqual(view.fields.map((entry) => entry.name));
      for (const field of view.fields)
        expect(
          all.find(
            (node) =>
              node.action === "bot_settings_change" &&
              node.field === field.name,
          ),
        ).toMatchObject({
          section,
          contextKey: "chat_id:c1:thread:t1",
          revision: view.fieldRevisions[field.name],
        });
      expect(
        all
          .filter(
            (node) =>
              typeof node.action === "string" &&
              node.action.startsWith("bot_settings_"),
          )
          .every((node) => node.contextKey === "chat_id:c1:thread:t1"),
      ).toBe(true);
      expect(
        all.filter((node) => node.action_type === "form_submit"),
      ).toHaveLength(0);
      expect(
        all.some(
          (node) =>
            node.tag === "form" ||
            node.required !== undefined ||
            node.action === "bot_settings_save",
        ),
      ).toBe(false);
      expect(
        all.filter((node) => node.action === "bot_settings_restart"),
      ).toHaveLength(1);
      const serialized = JSON.stringify(card);
      expect(serialized).toContain("自动保存，安全重启后生效");
      expect(all.some((node) => node.name === "publicBaseUrl")).toBe(false);
      expect(serialized).not.toContain("对外访问地址");
      for (const secret of [
        "private-secret",
        "private-token",
        "private-launch-command",
      ])
        expect(serialized).not.toContain(secret);
    },
  );

  test("autosaves individual controls with only a separate safe restart button", () => {
    const card = renderSettingsCard(fixture().read(), "chat_id:c1");
    const all = nodes(card);
    expect(
      all.find((node) => node.tag === "checker" && node.name === "updates"),
    ).toMatchObject({
      name: "updates",
      checked: true,
      behaviors: [
        {
          type: "callback",
          value: { action: "bot_settings_change", field: "updates" },
        },
      ],
    });
    expect(all.find((node) => node.tag === "button")).toHaveProperty("confirm");
    expect(
      all.filter((node) => node.tag === "button").map((node) => node.text),
    ).toEqual([{ tag: "plain_text", content: "安全重启" }]);
  });

  test("uses four compact tabs and paired controls without a directory setting", () => {
    const card = renderSettingsCard(fixture().read(), "chat_id:c1");
    const all = nodes(card);
    expect(card.header).toMatchObject({ title: { content: "Agent Bot 设置" } });
    const navigation = all.find(
      (node) =>
        node.tag === "column_set" &&
        Array.isArray(node.columns) &&
        node.columns.length === 4,
    )!;
    expect(
      nodes(navigation)
        .filter((node) => node.tag === "markdown")
        .map((node) => node.content),
    ).toEqual([
      "**常用**",
      "<font color='blue'>Agent</font>",
      "<font color='blue'>群名</font>",
      "<font color='blue'>高级</font>",
    ]);
    expect(
      all.some(
        (node) =>
          node.tag === "column_set" &&
          JSON.stringify(
            nodes(node)
              .filter((child) => child.name)
              .map((child) => child.name),
          ) === '["ownerOnly","allGroupMessages"]',
      ),
    ).toBe(true);
    expect(all.some((node) => node.name === "cwd")).toBe(false);
    expect(JSON.stringify(card)).not.toContain("默认工作目录");
    expect(all.some((node) => node.name === "layout")).toBe(false);
    expect(JSON.stringify(card)).not.toContain("思考卡片布局");
    expect(all.filter((node) => node.tag === "form")).toHaveLength(0);
    expect(
      all.filter((node) => node.tag === "button" && node.type === "primary"),
    ).toHaveLength(0);
  });

  test("selects an Agent and allows clearing its permission default", () => {
    const view = fixture().read("agents", "traex", {
      models: [
        {
          id: "Model-ID",
          displayName: "Model Name",
          supportedReasoningEfforts: [{ value: "high" }],
        },
      ],
    });
    const all = nodes(renderSettingsCard(view, "chat_id:c1"));
    expect(
      all.find((node) => node.tag === "select_static" && !node.name),
    ).toMatchObject({ initial_option: "traex" });
    expect(all.find((node) => node.name === "permissionMode")).toMatchObject({
      initial_option: "__agent_default__",
    });
    expect(
      all
        .filter((node) => node.tag === "select_static" && node.name)
        .map((node) => node.name),
    ).toEqual(["model", "reasoningEffort", "permissionMode"]);
    expect(
      all.some((node) => node.tag === "input" || node.name === "modelProvider"),
    ).toBe(false);
    expect(all.find((node) => node.name === "model")).toMatchObject({
      initial_option: "__agent_default__",
      options: [
        { text: { content: "使用 Agent 默认" }, value: "__agent_default__" },
        { text: { content: "Model Name (Model-ID)" }, value: "Model-ID" },
      ],
    });
    for (const label of ["默认模型", "默认思考强度", "默认权限"])
      expect(
        all.some((node) => node.tag === "markdown" && node.content === label),
      ).toBe(true);
    expect(
      all.find((node) => node.action === "bot_settings_change"),
    ).toMatchObject({ agentName: "traex" });
  });

  test("shows discovery warnings and retains current selections", () => {
    const store = fixture();
    const view = store.read("agents", "codex");
    store.save(
      "agents",
      "codex",
      view.revision,
      { ...view.values, model: "Model-ID" },
      {
        models: [{ id: "Model-ID", supportedReasoningEfforts: [] }],
      },
    );
    const snapshot = store.read("agents", "codex", {
      models: [],
      warning: "无法获取模型列表",
    });
    const all = nodes(renderSettingsCard(snapshot, "chat_id:c1"));
    expect(all.find((node) => node.name === "model")).toMatchObject({
      initial_option: "Model-ID",
    });
    expect(
      all.filter((node) => node.content === "> 无法获取模型列表"),
    ).toHaveLength(1);
  });

  test("shows the saved-pending state without claiming to have applied or restarted", () => {
    const view = fixture().read();
    const rendered = renderSettingsCard(
      { ...view, pendingRestart: true },
      "chat_id:c1",
    );
    const card = JSON.stringify(rendered);
    expect(card).toContain("待安全重启生效");
    expect(
      nodes(rendered).filter(
        (node) =>
          typeof node.content === "string" && node.content.includes("已保存"),
      ),
    ).toHaveLength(1);
    expect(card).not.toContain("已重启");
    expect(
      JSON.stringify(
        renderSettingsCard(
          { ...view, pendingRestart: true },
          "chat_id:c1",
          "未保存：输入无效",
        ),
      ),
    ).toContain("未保存：输入无效");
  });

  test("shows Provider and model on Common without an Agent selector for a single Agent", () => {
    const store = fixture(true);
    const common = nodes(renderSettingsCard(store.read(), "chat_id:c1"));
    expect(
      common
        .filter((node) => node.tag === "select_static")
        .map((node) => node.name),
    ).toEqual(["modelProvider", "model"]);
    const agent = nodes(renderSettingsCard(store.read("agents"), "chat_id:c1"));
    expect(
      agent
        .filter((node) => node.tag === "select_static")
        .map((node) => node.name),
    ).toEqual(["reasoningEffort", "permissionMode"]);
    expect(agent.some((node) => node.action === "bot_settings_agent")).toBe(
      false,
    );
  });
});
