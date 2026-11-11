import {
  SETTINGS_SECTIONS,
  type SettingsField,
  type SettingsSnapshot,
} from "../config/SettingsStore.js";

const plain = (content: string) => ({ tag: "plain_text", content });
const md = (content: string) => ({ tag: "markdown", content });
const button = (
  content: string,
  value: Record<string, string>,
  type = "default",
) => ({ tag: "button", text: plain(content), type, value });
const row = (columns: unknown[][], weighted = false) => ({
  tag: "column_set",
  flex_mode: weighted ? "none" : "flow",
  horizontal_spacing: "12px",
  columns: columns.map((elements) => ({
    tag: "column",
    width: weighted ? "weighted" : "auto",
    ...(weighted ? { weight: 1 } : {}),
    vertical_align: "center",
    elements,
  })),
});
const link = (title: string, value: Record<string, string>) => ({
  tag: "interactive_container",
  padding: "4px 0px",
  margin: "0px",
  has_border: false,
  elements: [md(title)],
  behaviors: [{ type: "callback", value }],
});

const NOTES = {
  general: "默认值仅影响新任务；群消息响应仍受 /mute 与飞书权限限制。",
  agents: "仅影响新任务，继承的任务设置优先。",
  naming:
    "仅影响新群。必须包含一个 {taskname}；可用 {agent}、{project}、{os}、{date}。",
  services: "终端与预览共用地址；更改地址或端口可能使旧链接失效。",
};

const PAIRED_FIELDS: Record<string, string> = {
  ownerOnly: "allGroupMessages",
  reasoningEffort: "permissionMode",
  host: "port",
};

function renderField(
  entry: SettingsField,
  value: string | boolean | number,
  callback: Record<string, string>,
): unknown[] {
  const behaviors = [{ type: "callback", value: callback }];
  if (entry.kind === "boolean")
    return [
      {
        tag: "checker",
        name: entry.name,
        checked: value === true,
        text: plain(entry.label),
        overall_checkable: true,
        behaviors,
      },
    ];
  const label = md(entry.label);
  if (entry.kind === "select")
    return [
      label,
      {
        tag: "select_static",
        name: entry.name,
        behaviors,
        width: "fill",
        initial_option: String(value) || "__agent_default__",
        options: (entry.options ?? []).map((item) => ({
          text: plain(item.label),
          value: item.value || "__agent_default__",
        })),
      },
    ];
  return [
    label,
    {
      tag: "input",
      name: entry.name,
      default_value: String(value),
      behaviors,
      input_type: "text",
      ...(entry.kind === "number"
        ? { placeholder: plain("0：自动分配并复用") }
        : {}),
      width: "fill",
      max_length: entry.kind === "number" ? 5 : 1000,
    },
  ];
}

export function renderSettingsCard(
  snapshot: SettingsSnapshot,
  contextKey: string,
  notice?: string,
): Record<string, unknown> {
  const common = {
    contextKey,
    section: snapshot.section,
    ...(snapshot.agentName ? { agentName: snapshot.agentName } : {}),
  };
  const navigation = row(
    Object.entries(SETTINGS_SECTIONS).map(([section, title]) => [
      link(
        section === snapshot.section
          ? `**${title}**`
          : `<font color='blue'>${title}</font>`,
        { action: "bot_settings_show", contextKey, section },
      ),
    ]),
    true,
  );
  const elements: unknown[] = [
    {
      tag: "column_set",
      flex_mode: "none",
      horizontal_spacing: "16px",
      columns: [
        { tag: "column", width: "weighted", weight: 1, elements: [navigation] },
        {
          tag: "column",
          width: "auto",
          elements: [
            link("<font color='grey'>刷新</font>", {
              ...common,
              action: "bot_settings_show",
            }),
          ],
        },
      ],
    },
    { tag: "hr" },
  ];
  if (snapshot.section === "agents" && snapshot.agents.length > 1)
    elements.push({
      tag: "select_static",
      placeholder: plain("选择 Agent"),
      initial_option: snapshot.agentName,
      width: "fill",
      options: snapshot.agents.map((agent) => ({
        text: plain(`${agent.title} (${agent.name})`),
        value: agent.name,
      })),
      behaviors: [
        {
          type: "callback",
          value: {
            action: "bot_settings_agent",
            contextKey,
            section: "agents",
          },
        },
      ],
    });
  if (snapshot.warning) elements.push(md(`> ${snapshot.warning}`));
  const controlsFor = (entry: SettingsField) =>
    renderField(entry, snapshot.values[entry.name]!, {
      ...common,
      action: "bot_settings_change",
      field: entry.name,
      revision: snapshot.fieldRevisions[entry.name]!,
    });
  for (let index = 0; index < snapshot.fields.length; index++) {
    const entry = snapshot.fields[index]!;
    const controls = controlsFor(entry);
    const next = snapshot.fields[index + 1];
    if (next && PAIRED_FIELDS[entry.name] === next.name) {
      elements.push(row([controls, controlsFor(next)], true));
      index++;
    } else {
      elements.push(...controls);
    }
  }
  elements.push(
    { tag: "hr" },
    {
      tag: "column_set",
      flex_mode: "none",
      horizontal_spacing: "12px",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          vertical_align: "center",
          elements: [
            md(
              notice ??
                (snapshot.pendingRestart
                  ? "<font color='orange'>已保存，待安全重启生效</font>"
                  : "自动保存，安全重启后生效"),
            ),
          ],
        },
        {
          tag: "column",
          width: "auto",
          elements: [
            {
              ...button("安全重启", {
                ...common,
                action: "bot_settings_restart",
              }),
              confirm: {
                title: plain("安全重启 Agent Bot？"),
                text: plain("等待活跃任务、终端和结果投递完成后重启。"),
              },
            },
          ],
        },
      ],
    },
    md(`> ${NOTES[snapshot.section]}`),
  );
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "fill" },
    header: {
      template: "blue",
      title: plain("Agent Bot 设置"),
    },
    body: { padding: "12px", vertical_spacing: "8px", elements },
  };
}
