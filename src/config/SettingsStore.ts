import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isMap, parseDocument } from "yaml";
import { z } from "zod";
import { appConfigSchema, type AppConfig } from "./schema.js";
import type { ModelListResult, ModelProviderOption } from "../runtime/types.js";

export interface SettingsCatalog extends ModelListResult {
  providers?: ModelProviderOption[];
}

export const SETTINGS_SECTIONS = {
  general: "常用",
  agents: "Agent",
  naming: "群名",
  services: "高级",
} as const;
export type SettingsSection = keyof typeof SETTINGS_SECTIONS;
export interface SettingsField {
  name: string;
  label: string;
  path: string[];
  kind: "text" | "boolean" | "select" | "number";
  fallback: string | boolean | number;
  optional?: boolean;
  options?: Array<{ value: string; label: string }>;
  schema: z.ZodType;
}
export interface SettingsSnapshot {
  section: SettingsSection;
  agentName?: string;
  agents: Array<{ name: string; title: string }>;
  revision: string;
  fieldRevisions: Record<string, string>;
  fields: SettingsField[];
  values: Record<string, string | boolean | number>;
  pendingRestart: boolean;
  modelProvider?: string;
  model?: string;
  reasoningEffort?: string;
  warning?: string;
}

const text = z
  .string()
  .trim()
  .max(1000)
  .refine((value) => !/[\r\n\0]/u.test(value), "不能包含换行或空字符");
const option = (value: string, label = value) => ({ value, label });
const field = (
  name: string,
  label: string,
  path: string[],
  kind: SettingsField["kind"],
  fallback: SettingsField["fallback"],
  schema: z.ZodType,
  extra: Partial<SettingsField> = {},
): SettingsField => ({ name, label, path, kind, fallback, schema, ...extra });

export function settingsSection(value: unknown): SettingsSection {
  if (typeof value !== "string" || !Object.hasOwn(SETTINGS_SECTIONS, value))
    throw new Error("无效的配置分组。");
  return value as SettingsSection;
}

function fieldsFor(
  section: SettingsSection,
  config: AppConfig,
  agentName?: string,
  catalog?: SettingsCatalog,
  allAgentFields = false,
): SettingsField[] {
  const bool = (name: string, label: string, path: string[], fallback = true) =>
    field(name, label, path, "boolean", fallback, z.boolean());
  switch (section) {
    case "general":
      return [
        ...(Object.keys(config.agents).length === 1
          ? fieldsFor(
              "agents",
              config,
              Object.keys(config.agents)[0],
              catalog,
              true,
            ).filter((entry) => ["modelProvider", "model"].includes(entry.name))
          : [
              field(
                "agent",
                "默认 Agent",
                ["defaults", "agent"],
                "select",
                Object.keys(config.agents)[0]!,
                text.refine(
                  (value) => Object.hasOwn(config.agents, value),
                  "Agent 未配置",
                ),
                {
                  options: Object.entries(config.agents).map(([name, agent]) =>
                    option(name, `${agent.title} (${name})`),
                  ),
                },
              ),
            ]),
        bool("ownerOnly", "仅响应所有者", ["feishu", "respondToOwnerOnly"]),
        bool("allGroupMessages", "响应群内所有消息", [
          "feishu",
          "respondToAllGroupMessages",
        ]),
        bool("updates", "自动检查并安装正式版更新", ["updates", "enabled"]),
      ];
    case "agents": {
      if (!agentName || !Object.hasOwn(config.agents, agentName))
        throw new Error("请选择已配置的 Agent。");
      const prefix = ["agents", agentName, "defaults"];
      const defaults = config.agents[agentName]!.defaults;
      const models = catalog?.models ?? [];
      const choices = (
        entries: Array<{ value: string; label: string }>,
        current?: string,
      ) => {
        const unique = new Map(entries.map((entry) => [entry.value, entry]));
        unique.delete("");
        if (current && !unique.has(current))
          unique.set(current, option(current, `${current}（当前配置）`));
        return [option("", "使用 Agent 默认"), ...unique.values()];
      };
      const modelChoices = choices(
        models.map((model) =>
          option(
            model.id,
            model.displayName && model.displayName !== model.id
              ? `${model.displayName} (${model.id})`
              : model.id,
          ),
        ),
        defaults.model,
      );
      const providerChoices = choices(
        (catalog?.providers ?? []).map((provider) =>
          option(
            provider.id,
            provider.displayName && provider.displayName !== provider.id
              ? `${provider.displayName} (${provider.id})`
              : provider.id,
          ),
        ),
        defaults.modelProvider,
      );
      const effortChoices = choices(
        models.flatMap((model) =>
          model.supportedReasoningEfforts.map((effort) => option(effort.value)),
        ),
        defaults.reasoningEffort,
      );
      const selection = (options: typeof modelChoices) =>
        z
          .string()
          .refine((value) => options.some((entry) => entry.value === value));
      const fields = [
        field(
          "modelProvider",
          "默认 Provider",
          [...prefix, "modelProvider"],
          "select",
          "",
          selection(providerChoices),
          { optional: true, options: providerChoices },
        ),
        field(
          "model",
          "默认模型",
          [...prefix, "model"],
          "select",
          "",
          selection(modelChoices),
          { optional: true, options: modelChoices },
        ),
        field(
          "reasoningEffort",
          "默认思考强度",
          [...prefix, "reasoningEffort"],
          "select",
          "",
          selection(effortChoices),
          { optional: true, options: effortChoices },
        ),
        field(
          "permissionMode",
          "默认权限",
          [...prefix, "permissionMode"],
          "select",
          "",
          z.enum(["", "auto", "confirm"]),
          {
            optional: true,
            options: [
              option("", "使用 Agent 默认"),
              option("confirm", "操作前确认"),
              option("auto", "自动执行"),
            ],
          },
        ),
      ];
      return allAgentFields
        ? fields
        : fields.filter((entry) =>
            Object.keys(config.agents).length === 1
              ? ["reasoningEffort", "permissionMode"].includes(entry.name)
              : entry.name !== "modelProvider",
          );
    }
    case "naming":
      return [
        field(
          "project",
          "项目群命名格式",
          ["feishu", "groupNameFormat", "project"],
          "text",
          "[{agent}] [{project}] {taskname}",
          text.min(1).max(240),
        ),
        field(
          "projectless",
          "无项目群命名格式",
          ["feishu", "groupNameFormat", "projectless"],
          "text",
          "[{agent}] {taskname}",
          text.min(1).max(240),
        ),
        field(
          "dateFormat",
          "日期格式",
          ["feishu", "groupNameFormat", "dateFormat"],
          "text",
          "MM-dd",
          text.min(1).max(80),
        ),
      ];
    case "services":
      return [
        bool("console", "本地控制台", ["console", "enabled"]),
        bool("terminal", "网页终端", ["terminal", "enabled"]),
        bool("preview", "文件与 Turn 预览", ["fileViewer", "enabled"]),
        field(
          "host",
          "监听地址",
          ["fileViewer", "host"],
          "text",
          "127.0.0.1",
          text
            .min(1)
            .refine(
              (value) => !/[\s/\\?#@]/u.test(value),
              "请输入主机名或 IP 地址",
            ),
        ),
        field(
          "port",
          "端口",
          ["fileViewer", "port"],
          "number",
          0,
          z.number().int().min(0).max(65535),
        ),
        field(
          "logLevel",
          "日志级别",
          ["logging", "level"],
          "select",
          "info",
          z.enum(["trace", "debug", "info", "warn", "error", "fatal"]),
          {
            options: ["trace", "debug", "info", "warn", "error", "fatal"].map(
              (value) => option(value),
            ),
          },
        ),
      ];
  }
}

function getValue(root: unknown, keys: string[]): unknown {
  let value = root;
  for (const key of keys) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
const revisionOf = (contents: string) =>
  createHash("sha256").update(contents).digest("hex");

export class SettingsStore {
  constructor(
    private readonly configPath: string,
    private readonly activeConfig: AppConfig,
  ) {}

  private readDocument() {
    const original = fs.readFileSync(this.configPath, "utf8");
    const document = parseDocument(original);
    if (document.errors.length || !isMap(document.contents))
      throw new Error("配置文件不是有效的 YAML 对象，请先在本机修复。");
    // Validate without including YAML source, environment values or secrets in errors/cards.
    const expanded = parseDocument(
      original.replace(
        /\$\{([A-Z0-9_]+)\}/gi,
        (_match, name: string) => process.env[name] ?? "",
      ),
    );
    let data: unknown;
    try {
      data = expanded.toJS();
    } catch {
      throw new Error("配置文件无法解析，请先在本机修复。");
    }
    const result = appConfigSchema.safeParse(data);
    if (expanded.errors.length || !result.success)
      throw new Error("配置文件校验失败，请先在本机修复。");
    return { original, document, config: result.data };
  }

  read(
    sectionValue: unknown = "general",
    requestedAgent?: string,
    catalog?: SettingsCatalog,
  ): SettingsSnapshot {
    return this.readSnapshot(sectionValue, requestedAgent, catalog);
  }

  private readSnapshot(
    sectionValue: unknown,
    requestedAgent?: string,
    catalog?: SettingsCatalog,
    allAgentFields = false,
  ): SettingsSnapshot {
    const section = settingsSection(sectionValue);
    const { original, document, config } = this.readDocument();
    const agentName =
      section === "agents"
        ? (requestedAgent ??
          config.defaults.agent ??
          Object.keys(config.agents)[0])
        : section === "general" && Object.keys(config.agents).length === 1
          ? Object.keys(config.agents)[0]
          : undefined;
    const fields = fieldsFor(
      section,
      config,
      agentName,
      catalog,
      allAgentFields,
    );
    const values: SettingsSnapshot["values"] = {};
    const fieldRevisions: Record<string, string> = {};
    let pendingRestart = false;
    for (const entry of fields) {
      const raw = document.getIn(entry.path);
      const effective = getValue(config, entry.path) ?? entry.fallback;
      values[entry.name] =
        entry.kind === "text" && typeof raw === "string"
          ? raw
          : typeof effective === "string" ||
              typeof effective === "boolean" ||
              typeof effective === "number"
            ? effective
            : entry.fallback;
      const active = getValue(this.activeConfig, entry.path) ?? entry.fallback;
      pendingRestart ||= effective !== active;
      fieldRevisions[entry.name] = revisionOf(
        JSON.stringify([
          entry.path,
          raw,
          effective,
          agentName &&
          ["modelProvider", "model", "reasoningEffort"].includes(entry.name)
            ? {
                provider: config.agents[agentName]!.defaults.modelProvider,
                dependentValue:
                  entry.name === "modelProvider"
                    ? config.agents[agentName]!.defaults
                    : entry.name === "model"
                      ? config.agents[agentName]!.defaults.reasoningEffort
                      : config.agents[agentName]!.defaults.model,
              }
            : undefined,
        ]),
      );
    }
    return {
      section,
      agentName,
      fields,
      values,
      fieldRevisions,
      pendingRestart,
      ...(agentName
        ? {
            modelProvider: config.agents[agentName]!.defaults.modelProvider,
            model: config.agents[agentName]!.defaults.model,
            reasoningEffort: config.agents[agentName]!.defaults.reasoningEffort,
            warning: catalog?.warning,
          }
        : {}),
      revision: revisionOf(original),
      agents: Object.entries(config.agents).map(([name, agent]) => ({
        name,
        title: agent.title,
      })),
    };
  }

  saveField(
    sectionValue: unknown,
    agentName: string | undefined,
    name: unknown,
    revision: unknown,
    value: unknown,
    catalog?: SettingsCatalog,
  ): SettingsSnapshot {
    const view = this.read(sectionValue, agentName, catalog);
    if (
      typeof name !== "string" ||
      !view.fields.some((entry) => entry.name === name)
    )
      throw new Error("不允许修改此配置项。");
    if (typeof revision !== "string" || revision !== view.fieldRevisions[name])
      throw new Error("此配置项已变化，请刷新后重新选择。");
    const snapshot =
      view.agentName &&
      ["modelProvider", "model", "reasoningEffort", "permissionMode"].includes(
        name,
      )
        ? this.readSnapshot("agents", view.agentName, catalog, true)
        : view;
    if (revision !== snapshot.fieldRevisions[name])
      throw new Error("此配置项已变化，请刷新后重新选择。");
    const next: Record<string, unknown> = { ...snapshot.values, [name]: value };
    const normalized = value === "__agent_default__" ? "" : value;
    if (
      name === "modelProvider" &&
      normalized !== snapshot.values.modelProvider
    ) {
      next.model =
        catalog?.models.find((model) => model.id === snapshot.values.model)
          ?.id ??
        catalog?.models.find((model) => model.isDefault)?.id ??
        catalog?.models[0]?.id ??
        "";
    }
    if (
      snapshot.agentName &&
      ["modelProvider", "model"].includes(name) &&
      normalized !== snapshot.values[name]
    ) {
      const selected =
        next.model === "__agent_default__" || next.model === ""
          ? catalog?.models.find((model) => model.isDefault)
          : catalog?.models.find((model) => model.id === next.model);
      if (
        next.reasoningEffort &&
        !selected?.supportedReasoningEfforts.some(
          (effort) => effort.value === next.reasoningEffort,
        )
      )
        next.reasoningEffort = "";
    }
    this.saveSnapshot(snapshot, snapshot.revision, next, catalog);
    return this.read(view.section, view.agentName, catalog);
  }

  save(
    sectionValue: unknown,
    agentName: string | undefined,
    revision: unknown,
    form: unknown,
    catalog?: SettingsCatalog,
  ): SettingsSnapshot {
    const snapshot = this.read(sectionValue, agentName, catalog);
    return this.saveSnapshot(snapshot, revision, form, catalog);
  }

  private saveSnapshot(
    snapshot: SettingsSnapshot,
    revision: unknown,
    form: unknown,
    catalog?: SettingsCatalog,
  ): SettingsSnapshot {
    if (typeof revision !== "string" || revision !== snapshot.revision)
      throw new Error("配置已变化，请刷新面板后重新编辑。");
    if (!form || typeof form !== "object" || Array.isArray(form))
      throw new Error("缺少配置表单。");
    const input = form as Record<string, unknown>;
    const allowed = new Set(snapshot.fields.map((entry) => entry.name));
    if (Object.keys(input).some((name) => !allowed.has(name)))
      throw new Error("表单包含不允许修改的配置项。");
    const { original, document } = this.readDocument();
    if (revisionOf(original) !== revision)
      throw new Error("配置已变化，请刷新面板后重新编辑。");
    let changed = false;
    const next = { ...snapshot.values };
    for (const entry of snapshot.fields) {
      if (!Object.hasOwn(input, entry.name))
        throw new Error(`缺少配置项：${entry.label}。`);
      let value = input[entry.name];
      if (entry.kind === "select" && value === "__agent_default__") value = "";
      // Do not materialize defaults or replace existing environment references on a no-op save.
      if (value === snapshot.values[entry.name]) continue;
      if (
        entry.kind === "number" &&
        typeof value === "string" &&
        /^\d+$/u.test(value.trim())
      )
        value = Number(value);
      const parsed = entry.schema.safeParse(value);
      if (!parsed.success) throw new Error(`配置项无效：${entry.label}。`);
      if (parsed.data === snapshot.values[entry.name]) continue;
      changed = true;
      next[entry.name] = parsed.data as string | number | boolean;
      if (entry.optional && parsed.data === "") document.deleteIn(entry.path);
      else document.setIn(entry.path, parsed.data);
    }
    if (
      snapshot.section === "agents" &&
      next.reasoningEffort &&
      (next.model !== snapshot.values.model ||
        next.reasoningEffort !== snapshot.values.reasoningEffort)
    ) {
      const selected = next.model
        ? catalog?.models.find((model) => model.id === next.model)
        : catalog?.models.find((model) => model.isDefault);
      if (!selected)
        throw new Error(
          "无法确认此模型支持的思考强度，请选择已列出的模型或将思考强度设为使用 Agent 默认。",
        );
      if (
        !selected.supportedReasoningEfforts.some(
          (effort) => effort.value === next.reasoningEffort,
        )
      )
        throw new Error(
          `所选模型不支持此思考强度；请选择 ${selected.supportedReasoningEfforts.map((effort) => effort.value).join("、") || "使用 Agent 默认"}，或使用 Agent 默认。`,
        );
    }
    if (!changed) return snapshot;
    const updated = document.toString();
    const candidate = parseDocument(
      updated.replace(
        /\$\{([A-Z0-9_]+)\}/gi,
        (_match, name: string) => process.env[name] ?? "",
      ),
    );
    let candidateData: unknown;
    try {
      candidateData = candidate.toJS();
    } catch {
      throw new Error("修改后的配置无法解析。");
    }
    if (
      candidate.errors.length ||
      !appConfigSchema.safeParse(candidateData).success
    )
      throw new Error(
        "配置校验失败：请检查群名格式等字段，群名必须包含且仅包含一个 {taskname}。",
      );
    if (updated !== original) this.write(original, updated);
    return this.read(snapshot.section, snapshot.agentName, catalog);
  }

  private write(original: string, updated: string): void {
    const temporary = `${this.configPath}.${randomUUID()}.tmp`;
    let handle: number | undefined;
    try {
      handle = fs.openSync(temporary, "wx", fs.statSync(this.configPath).mode);
      fs.writeFileSync(handle, updated, "utf8");
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = undefined;
      if (fs.readFileSync(this.configPath, "utf8") !== original)
        throw new Error("配置已变化，请刷新面板后重新编辑。");
      fs.renameSync(temporary, this.configPath);
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
      fs.rmSync(temporary, { force: true });
    }
  }
}
