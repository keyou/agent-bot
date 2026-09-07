import { describe, expect, test } from "vitest";
import type { RuntimeSession } from "../../src/acp/AcpSessionManager.js";
import { CardRenderer } from "../../src/feishu/CardRenderer.js";
import type { TurnViewState } from "../../src/presentation/turnViewTypes.js";

function collectObjects(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(collectObjects);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(collectObjects)];
}

function state(): TurnViewState {
  const completed = {
    id: "ok",
    title: "npm test",
    kind: "command",
    status: "completed" as const,
    command: "npm test",
    output: "\u001b[32mall passed\u001b[0m",
    exitCode: 0,
  };
  const failed = {
    id: "bad",
    title: "npm run lint",
    kind: "command",
    status: "failed" as const,
    command: "npm run lint",
    error: "命令失败",
    exitCode: 1,
  };
  return {
    sessionId: "s1",
    turnId: "turn_1",
    agentLabel: "Codex",
    prompt: "检查卡片渲染",
    status: "running",
    startedAt: 1_000,
    durationMs: 51_600,
    progressText: "正在运行测试",
    assistantText: "",
    plan: [{ text: "执行测试", status: "in_progress" }],
    activities: [
      { kind: "reasoning", id: "reasoning:r1:0", text: "先检查测试配置" },
      { kind: "tool", id: "ok", tool: completed },
      { kind: "reasoning", id: "reasoning:r2:0", text: "再检查代码风格" },
      { kind: "tool", id: "bad", tool: failed },
    ],
    completedTools: [completed],
    failedTools: [failed],
    fileSummary: [{ path: "src/index.ts", additions: 5, deletions: 2 }],
  };
}

describe("CardRenderer", () => {
  test("renders waiting and completed App Server release cards", () => {
    const renderer = new CardRenderer();
    const waiting = renderer.renderAppServerRelease({
      status: "waiting",
      contextKey: "chat_id:c1",
      scheduleId: 7,
      agentName: "codex",
      blockingTaskCount: 2,
      blockingTaskTitles: ["Fix release card", "Run\nverification"],
    });
    const button = collectObjects(waiting).find(
      (item) => item.tag === "button" && (item.text as { content?: unknown } | undefined)?.content === "Release Now",
    );

    expect(waiting).toMatchObject({
      header: { template: "orange", title: { content: "等待释放" } },
    });
    expect(JSON.stringify(waiting)).toContain("**等待任务**：2");
    expect(JSON.stringify(waiting)).toContain("1. `Fix release card`");
    expect(JSON.stringify(waiting)).toContain("2. `Run verification`");
    expect(button).toMatchObject({
      type: "danger",
      behaviors: [{
        type: "callback",
        value: {
          action: "app_server_release_now",
          contextKey: "chat_id:c1",
          scheduleId: 7,
          agentName: "codex",
        },
      }],
    });

    const countdown = renderer.renderAppServerRelease({
      status: "waiting",
      contextKey: "chat_id:c1",
      scheduleId: 8,
      agentName: "codex",
    });
    const cancelButton = collectObjects(countdown).find(
      (item) => item.tag === "button" && (item.text as { content?: unknown } | undefined)?.content === "Cancel",
    );
    expect(countdown).toMatchObject({
      header: { template: "orange", title: { content: "确认释放" } },
    });
    expect(JSON.stringify(countdown)).toContain("**状态**：可以释放");
    expect(JSON.stringify(countdown)).toContain('"content":"Release"');
    expect(cancelButton).toMatchObject({
      type: "default",
      behaviors: [{
        type: "callback",
        value: {
          action: "app_server_release_cancel",
          contextKey: "chat_id:c1",
          scheduleId: 8,
          agentName: "codex",
        },
      }],
    });

    const released = renderer.renderAppServerRelease({
      status: "released",
      contextKey: "chat_id:c1",
      scheduleId: 7,
      agentName: "codex",
      forced: true,
    });
    expect(released).toMatchObject({
      header: { template: "green", title: { content: "任务已释放" } },
    });
    expect(JSON.stringify(released)).toContain("执行中的任务已中断");
    expect(JSON.stringify(released)).toContain("Retry");

    const cancelled = renderer.renderAppServerRelease({
      status: "cancelled",
      contextKey: "chat_id:c1",
      scheduleId: 8,
      agentName: "codex",
    });
    expect(cancelled).toMatchObject({
      header: { template: "grey", title: { content: "已取消释放" } },
    });
    expect(JSON.stringify(cancelled)).toContain("Agent Bot 将继续保持当前任务连接");
  });

  test("renders a thread-writer conflict with the owning process and a safe close action", () => {
    const card = new CardRenderer().renderThreadWriterConflict({
      status: "occupied",
      contextKey: "chat_id:c1",
      sessionId: "s1",
      threadId: "01a05543-1cfd-75b1-9eba-1ce331ab4230",
      taskTitle: "Desktop task",
      applicationIdle: true,
      owner: {
        displayName: "Codex Desktop",
        writerPid: 53704,
        writerProcessName: "codex.exe",
        writerStartedAt: "2026-09-05T10:00:00.000Z",
        applicationPid: 81552,
        applicationProcessName: "ChatGPT.exe",
        applicationStartedAt: "2026-09-05T09:00:00.000Z",
        canClose: true,
      },
    });
    const buttons = collectObjects(card).filter((item) => item.tag === "button");
    const forkButton = buttons.find((item) => (item.text as { content?: unknown } | undefined)?.content === "Fork");
    const closeButton = buttons.find(
      (item) => (item.text as { content?: unknown } | undefined)?.content === "Close 81552",
    );

    expect(card).toMatchObject({
      header: {
        template: "orange",
        title: { tag: "plain_text", content: "任务被占用" },
      },
    });
    expect(JSON.stringify(card)).toContain("ChatGPT.exe (81552)");
    expect(JSON.stringify(card)).not.toContain("Codex Desktop");
    expect(JSON.stringify(card)).not.toContain("任务 ID");
    expect(JSON.stringify(card)).not.toContain("Writer");
    expect(JSON.stringify(card)).toContain("无执行中任务，可安全关闭");
    expect(forkButton).toMatchObject({
      text: { tag: "plain_text", content: "Fork" },
      behaviors: [{
        type: "callback",
        value: expect.objectContaining({
          action: "thread_writer_fork",
          sessionId: "s1",
        }),
      }],
    });
    expect(closeButton).toMatchObject({
      text: { tag: "plain_text", content: "Close 81552" },
      type: "danger",
      behaviors: [{
        type: "callback",
        value: expect.objectContaining({
          action: "thread_writer_close",
          writerPid: 53704,
          applicationPid: 81552,
          force: false,
        }),
      }],
    });
  });

  test("offers Force Close only after a normal close request leaves the writer active", () => {
    const card = new CardRenderer().renderThreadWriterConflict({
      status: "force_required",
      contextKey: "chat_id:c1",
      sessionId: "s1",
      threadId: "01a05543-1cfd-75b1-9eba-1ce331ab4230",
      applicationIdle: false,
      owner: {
        displayName: "Codex CLI",
        writerPid: 53704,
        writerProcessName: "codex.exe",
        writerStartedAt: "2026-09-05T10:00:00.000Z",
        applicationPid: 53704,
        applicationProcessName: "codex.exe",
        applicationStartedAt: "2026-09-05T10:00:00.000Z",
        canClose: true,
      },
    });

    expect(card).toMatchObject({ header: { template: "red" } });
    expect(JSON.stringify(card)).toContain("Force 53704");
    expect(JSON.stringify(card)).toContain("有任务执行中，关闭会中断任务");
  });

  test("does not offer a close action without a stable process fingerprint", () => {
    const card = new CardRenderer().renderThreadWriterConflict({
      status: "occupied",
      contextKey: "chat_id:c1",
      sessionId: "s1",
      threadId: "01a05543-1cfd-75b1-9eba-1ce331ab4230",
      owner: {
        displayName: "Unknown process",
        writerPid: 53704,
        writerProcessName: "unknown.exe",
        applicationPid: 53704,
        applicationProcessName: "unknown.exe",
        canClose: false,
      },
    });

    const buttons = collectObjects(card).filter((item) => item.tag === "button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatchObject({ text: { content: "Fork" } });
  });

  test("renders live shell output with head-and-tail truncation", () => {
    const card = new CardRenderer().renderShellCommandCard({
      command: "npm run noisy",
      cwd: "D:\\dev\\agent-bot",
      output: `HEAD-${"x".repeat(7_000)}-TAIL`,
      status: "running",
      elapsedMs: 12_300,
      outputTruncated: false,
    });
    const serialized = JSON.stringify(card);

    expect(card).toMatchObject({
      config: { update_multi: true },
      header: { template: "blue", title: { content: "正在执行命令" } },
    });
    expect(serialized).toContain("HEAD-");
    expect(serialized).toContain("中间输出已截断");
    expect(serialized).toContain("-TAIL");
    expect(serialized).toContain("输出过长，已保留开头和结尾并截断中间内容");
  });

  test("normalizes cross-platform lines and carriage-return progress in merged shell output", () => {
    const card = new CardRenderer().renderShellCommandCard({
      command: "git clone repository",
      cwd: "/tmp/repository",
      output: [
        "windows line\r\n",
        "linux line\n",
        "macOS progress 10%\r",
        "macOS progress 20%\n",
        "remote progress 40%\r",
        "remote progress 50%\r",
      ].join(""),
      status: "running",
      elapsedMs: 1_000,
      outputTruncated: false,
    });
    const content = collectObjects(card)
      .filter((item) => item.tag === "markdown")
      .map((item) => String(item.content ?? ""))
      .join("\n");

    expect(content).toContain("windows line\nlinux line\nmacOS progress 20%");
    expect(content).toContain("remote progress 50%");
    expect(content).not.toContain("[stderr]");
    expect(content).not.toContain("macOS progress 10%");
    expect(content).not.toContain("remote progress 40%");
    expect(content).not.toContain("\r");
  });

  test("removes terminal title and hyperlink control sequences from shell output", () => {
    const card = new CardRenderer().renderShellCommandCard({
      command: "node task.mjs",
      cwd: "D:\\dev\\agent-bot",
      output: [
        "load shell init\n",
        "\u001b]0;C:\\Program Files\\PowerShell\\7\\pwsh.exe\u0007",
        "{\n  \"ok\": false\n}\n",
        "\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\\n",
        "\u0000plain output",
      ].join(""),
      status: "failed",
      elapsedMs: 2_700,
      exitCode: 1,
      outputTruncated: false,
    });
    const content = collectObjects(card)
      .filter((item) => item.tag === "markdown")
      .map((item) => String(item.content ?? ""))
      .join("\n");

    expect(content).toContain("load shell init\n{\n  \"ok\": false");
    expect(content).toContain("link\nplain output");
    expect(content).not.toContain("pwsh.exe");
    expect(content).not.toContain("example.com");
    expect(content).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/);
  });

  test("keeps auto-sized execution-setting tabs on one dot-separated row", () => {
    const card = new CardRenderer().renderExecutionSettings({
      sessionId: "session_1",
      contextKey: "chat_id:c1",
      activeTab: "permission",
      currentAgent: "codex",
      taskAgent: "codex",
      agents: [
        { name: "codex", title: "Codex" },
        { name: "traex", title: "TraeX" },
      ],
      runtimeSettingsAvailable: true,
      currentProvider: "openai",
      currentModel: "gpt-test",
      currentEffort: "high",
      currentPermissionMode: "auto",
      providers: [],
      providerSupported: true,
      models: [],
      reasoningOptions: [],
    });
    const tabRow = collectObjects(card).find((item) => (
      item.tag === "column_set"
      && Array.isArray(item.columns)
      && item.columns.length === 9
    ));
    const columns = tabRow?.columns as Array<Record<string, unknown>>;

    expect(columns).toHaveLength(9);
    expect(tabRow).toMatchObject({ flex_mode: "none", horizontal_spacing: "2px" });
    expect(columns.every((column) => column.width === "auto")).toBe(true);
    expect(columns.filter((_, index) => index % 2 === 1).map((column) => (
      (column.elements as Array<Record<string, unknown>>)[0]?.content
    ))).toEqual(["·", "·", "·", "·"]);
    const tabActions = collectObjects(tabRow).filter((item) => item.tag === "interactive_container");
    expect(tabActions).toHaveLength(4);
    expect(tabActions.every((action) => action.padding === "6px 0px")).toBe(true);
    expect(collectObjects(tabRow)
      .filter((item) => item.tag === "markdown")
      .every((label) => label.text_align === "center" && label.text_size === "notation")).toBe(true);
    expect(JSON.stringify(tabRow)).toContain("Permission");
  });

  test("renders ACP permission buttons in English regardless of supplied names", () => {
    const card = new CardRenderer().renderPermissionRequest(
      { localSessionId: "session_1" } as RuntimeSession,
      "permission_1",
      "npm test",
      [
        { optionId: "once", name: "允许一次", kind: "allow_once" },
        { optionId: "always", name: "始终允许", kind: "allow_always" },
        { optionId: "reject", name: "拒绝一次", kind: "reject_once" },
        { optionId: "never", name: "始终拒绝", kind: "reject_always" },
      ],
    );
    const labels = collectObjects(card)
      .filter((item) => item.tag === "button")
      .map((item) => (item.text as { content: string }).content);

    expect(labels).toEqual(["Allow Once", "Always Allow", "Deny Once", "Always Deny"]);
  });

  test("renders a compact cancellable prompt queue", () => {
    const card = new CardRenderer().renderPromptQueue({
      sessionId: "session_1",
      contextKey: "chat_id:c1",
      prompts: [
        { id: "queue_1", text: "先运行全部测试" },
        { id: "queue_2", text: "然后更新文档" },
      ],
    });
    const objects = collectObjects(card);
    const buttons = objects.filter((item) => item.tag === "button");
    const columns = objects.filter((item) => item.tag === "column");

    expect(card).toMatchObject({
      schema: "2.0",
      config: { width_mode: "fill" },
      header: { title: { content: "排队 Prompt · 2" }, padding: "8px 12px 8px 12px" },
      body: { vertical_spacing: "4px", padding: "8px 12px 8px 12px" },
    });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toMatchObject({
      size: "tiny",
      text: { content: "Cancel" },
      behaviors: [{
        type: "callback",
        value: { action: "queued_prompt_cancel", promptId: "queue_1", sessionId: "session_1" },
      }],
    });
    expect(JSON.stringify(card)).toContain("1. 先运行全部测试");
    expect(JSON.stringify(card)).toContain("2. 然后更新文档");
    expect(columns.every((column) => (
      (column.elements as Array<Record<string, unknown>>)
        .every((element) => element.tag !== "plain_text")
    ))).toBe(true);
  });

  test("renders an empty prompt queue without unsupported plain_text body elements", () => {
    const card = new CardRenderer().renderPromptQueue({
      sessionId: "session_1",
      contextKey: "chat_id:c1",
      prompts: [],
    });

    expect(card).toMatchObject({
      body: {
        elements: [{ tag: "markdown", content: "队列为空" }],
      },
    });
  });

  test("renders a superseded prompt queue without active callbacks", () => {
    const card = new CardRenderer().renderPromptQueue({
      sessionId: "session_1",
      contextKey: "chat_id:c1",
      phase: "superseded",
      prompts: [{ id: "queue_1", text: "先运行全部测试" }],
    });
    const serialized = JSON.stringify(card);

    expect(card).toMatchObject({
      header: { title: { content: "排队 Prompt · 已停止" } },
    });
    expect(serialized).toContain("此卡片已由新的排队卡片替代");
    expect(serialized).not.toContain("queued_prompt_cancel");
    expect(serialized).not.toContain("Cancel");
  });

  test("renders a callback-free startup status card with resumable task state", () => {
    const card = new CardRenderer().renderStartupStatus({
      startedAt: new Date("2026-07-15T05:45:00.000Z"),
      restartReason: "用户执行 /restart 命令",
      agentBotVersion: "1.2.3",
      defaultAgentName: "codex",
      defaultAgentTitle: "Codex",
      cwd: "D:\\dev\\agent-bot",
      currentTask: {
        id: "sess_1",
        title: "Startup task metadata",
        model: "gpt-test",
        reasoningEffort: "high",
        permissionMode: "confirm",
        agentName: "codex",
        sessionStatus: "running",
        lastTurnStatus: "running",
      },
    });
    const serialized = JSON.stringify(card);
    const objects = collectObjects(card);

    expect(card).toMatchObject({
      schema: "2.0",
      config: { update_multi: true, width_mode: "fill" },
      header: { template: "green" },
      body: { elements: expect.any(Array) },
    });
    expect(card).not.toHaveProperty("elements");
    expect(serialized).toContain("Agent Bot 已启动");
    expect(serialized).toContain("Agent Bot 版本");
    expect(serialized).toContain("1.2.3");
    expect(serialized).toContain("在线");
    expect(serialized).toContain("重启原因");
    expect(serialized).toContain("用户执行 /restart 命令");
    expect(serialized).toContain("codex");
    expect(serialized).toContain("D:\\\\dev\\\\agent-bot");
    expect(serialized).toContain("sess_1");
    expect(serialized).toContain("模型 / 思考强度 / 权限");
    expect(serialized).toContain("gpt-test");
    expect(serialized).toContain("high");
    expect(serialized).toContain("执行前确认");
    expect(serialized).toContain("Startup task metadata");
    expect(serialized).toContain("任务 ID");
    expect(serialized).toContain("任务状态 / Agent");
    expect(serialized).toContain("服务状态 / 启动时间");
    expect(serialized).toContain("下一条消息时恢复");
    expect(serialized).toContain("> 发送消息即可开始对话；发送 `/new` 创建新任务；发送 `/help` 查看帮助。");
    expect(serialized).not.toContain("发送 /status 查看详情");
    expect(objects.filter((item) => item.tag === "button" || item.tag === "action")).toHaveLength(0);
    const content = String(objects.find((item) => item.tag === "markdown")?.content);
    expect(content.indexOf("当前任务")).toBeLessThan(content.indexOf("工作目录"));
    expect(content.indexOf("工作目录")).toBeLessThan(content.indexOf("模型 / 思考强度 / 权限"));
    expect(content.indexOf("模型 / 思考强度 / 权限")).toBeLessThan(content.indexOf("Agent Bot 版本"));
    expect(content.indexOf("Agent Bot 版本")).toBeLessThan(content.indexOf("服务状态 / 启动时间"));
  });

  test("renders default model and automatic effort when there is no current task", () => {
    const card = new CardRenderer().renderStartupStatus({
      startedAt: new Date("2026-07-15T05:45:00.000Z"),
      restartReason: "Supervisor 启动",
      agentBotVersion: "1.2.3",
      defaultAgentName: "codex",
      defaultAgentTitle: "Codex",
      cwd: "D:\\dev\\agent-bot",
      workspaceKind: "projectless",
    });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("模型 / 思考强度 / 权限");
    expect(serialized).toContain("默认");
    expect(serialized).toContain("自动");
    expect(serialized).toContain("自动执行");
    expect(serialized).toContain("任务范围");
    expect(serialized).toContain("未指定项目");
    expect(serialized).not.toContain("D:\\\\dev\\\\agent-bot");
    expect(serialized).toContain("下一条普通消息会创建新任务");
  });

  test("renders a polished initialization welcome card with the project logo", () => {
    const card = new CardRenderer().renderInitializationWelcome({
      kind: "first",
      version: "1.2.3",
      defaultAgentName: "codex",
      defaultAgentTitle: "Codex",
      availableAgents: ["Codex", "TraeX"],
      logoPath: "D:\\agent-bot\\assets\\agent-bot-logo.png",
      features: [
        { icon: "💬", title: "飞书直接对话", description: "私聊、群聊和话题分别维护上下文。" },
        { icon: "🤖", title: "连接本地 Agent", description: "使用 Codex 或 TraeX。" },
        { icon: "🌿", title: "新建与分支", description: "并行推进多个任务。" },
        { icon: "📍", title: "进度始终可见", description: "查看工具和文件变更。" },
      ],
    });
    const objects = collectObjects(card);
    const serialized = JSON.stringify(card);
    const image = objects.find((item) => item.tag === "img");

    expect(card).toMatchObject({
      schema: "2.0",
      config: { update_multi: true },
      header: {
        template: "turquoise",
        title: { content: "欢迎使用 Agent Bot" },
        subtitle: { content: "本地 Agent 已接入飞书" },
      },
    });
    expect(image).toMatchObject({
      img_key: "",
      __acp_local_image_path: "D:\\agent-bot\\assets\\agent-bot-logo.png",
      preview: false,
    });
    expect(serialized).toContain("初始化完成");
    expect(serialized).toContain("飞书直接对话");
    expect(serialized).toContain("Codex");
    expect(serialized).toContain("TraeX");
    expect(serialized).toContain("/new");
    expect(serialized).toContain("[查看更新日志](https://github.com/keyou/agent-bot/blob/master/CHANGELOG.md)");
    expect(objects.filter((item) => item.tag === "button" || item.tag === "interactive_container"))
      .toHaveLength(0);
    expect((card.config as Record<string, unknown>).width_mode).toBeUndefined();
    const featureRows = objects.filter((item) => (
      item.tag === "column_set"
      && Array.isArray(item.columns)
      && (item.columns as unknown[]).every((column) => (
        typeof column === "object"
        && column !== null
        && (column as Record<string, unknown>).width === "weighted"
      ))
    ));
    expect(featureRows).toHaveLength(3);
    expect(featureRows.every((row) => (row.columns as unknown[]).length === 2)).toBe(true);
  });

  test("shows the previous and current versions in an upgrade welcome card", () => {
    const card = new CardRenderer().renderInitializationWelcome({
      kind: "upgrade",
      version: "1.3.0",
      previousVersion: "1.2.3",
      activationPending: true,
      defaultAgentName: "traex",
      defaultAgentTitle: "TraeX",
      availableAgents: ["TraeX"],
      logoPath: "C:\\agent-bot-logo.png",
      features: [{ icon: "🛡️", title: "Recovery", description: "Turn links are repaired." }],
    });
    const serialized = JSON.stringify(card);

    expect(card).toMatchObject({
      header: {
        template: "blue",
        title: { content: "Agent Bot 已更新" },
        subtitle: { content: "配置已完成，安全重启后生效" },
      },
    });
    expect(serialized).toContain("1.2.3");
    expect(serialized).toContain("1.3.0");
    expect(serialized).toContain("本版亮点");
    expect(serialized).toContain("当前任务完成并安全重启后生效");
    expect(serialized).toContain("[查看更新日志](https://github.com/keyou/agent-bot/blob/master/CHANGELOG.md)");
  });

  test("renders safe restart blockers and countdown", () => {
    const renderer = new CardRenderer();
    const waiting = renderer.renderSafeRestartStatus({
      scheduleId: 7,
      reason: "更新卡片分页",
      phase: "waiting_tasks",
      pendingFinalDeliveries: 1,
      waitingTasks: [{ id: "thread_1", title: "Long build" }],
    });
    const countdown = renderer.renderSafeRestartStatus({
      scheduleId: 7,
      reason: "更新卡片分页",
      phase: "countdown",
      remainingMs: 12_350,
      pendingFinalDeliveries: 0,
      waitingTasks: [],
    });

    expect(JSON.stringify(waiting)).toContain("等待任务完成");
    expect(JSON.stringify(waiting)).toContain("Long build");
    expect(JSON.stringify(waiting)).toContain("thread_1");
    expect(JSON.stringify(waiting)).toContain("等待阻塞项清空后开始");
    expect(JSON.stringify(waiting)).toContain("<font color='blue'>Cancel</font>");
    expect(JSON.stringify(waiting)).toContain('"action":"safe_restart_cancel","scheduleId":"7"');
    expect(JSON.stringify(countdown)).toContain("13s");
    expect(countdown).toMatchObject({ header: { template: "orange" } });

    const cancelled = renderer.renderSafeRestartStatus({
      scheduleId: 7,
      reason: "更新卡片分页",
      phase: "cancelled",
      pendingFinalDeliveries: 0,
      waitingTasks: [],
    });
    expect(JSON.stringify(cancelled)).toContain("已取消");
    expect(JSON.stringify(cancelled)).not.toContain(">Cancel</font>");
    expect(cancelled).toMatchObject({ header: { template: "grey" } });

    const superseded = renderer.renderSafeRestartStatus({
      scheduleId: 7,
      reason: "更新卡片分页",
      phase: "superseded",
      pendingFinalDeliveries: 0,
      waitingTasks: [],
    });
    expect(JSON.stringify(superseded)).toContain("已停止");
    expect(JSON.stringify(superseded)).not.toContain(">Cancel</font>");
    expect(superseded).toMatchObject({ header: { template: "grey" } });

    const restarting = renderer.renderSafeRestartStatus({
      scheduleId: 7,
      reason: "更新卡片分页",
      phase: "restarting",
      remainingMs: 0,
      pendingFinalDeliveries: 0,
      waitingTasks: [],
    });
    expect(JSON.stringify(restarting)).not.toContain(">Cancel</font>");
  });

  test("keeps the original timeline layout available with unchanged chronological rendering", () => {
    const card = new CardRenderer({ thinkingCardLayout: "timeline" }).renderTurn(state());
    const objects = collectObjects(card);
    const panels = objects.filter((item) => item.tag === "collapsible_panel");
    const toolPanels = panels.filter((panel) => !panelTitle(panel).startsWith("文件变更") && !panelTitle(panel).startsWith("计划"));
    const serialized = JSON.stringify(card);
    const markdownContents = objects
      .filter((item) => item.tag === "markdown")
      .map((item) => String(item.content ?? ""))
      .join("\n");
    const topLevel = ((card as { body: { elements: unknown[] } }).body.elements).map((element) => JSON.stringify(element));
    const activityOrder = ["先检查测试配置", "npm test", "再检查代码风格", "npm run lint"].map((text) =>
      topLevel.findIndex((element) => element.includes(text)),
    );

    expect(toolPanels).toHaveLength(2);
    expect(toolPanels.every((panel) => panel.expanded === false)).toBe(true);
    expect(toolPanels.every((panel) => JSON.stringify(panel.border) === JSON.stringify({ color: "grey", corner_radius: "5px" }))).toBe(true);
    expect(panels.every((panel) => (panel.header as { padding?: string }).padding === "4px 8px 4px 8px")).toBe(true);
    expect(panels.find((panel) => panelTitle(panel).startsWith("文件变更"))).toMatchObject({
      tag: "collapsible_panel",
      element_id: "turn_files",
      expanded: false,
    });
    expect(panels).toContainEqual(expect.objectContaining({
      tag: "collapsible_panel",
      expanded: true,
      direction: "vertical",
      vertical_spacing: "4px",
      padding: "8px",
      border: { color: "blue", corner_radius: "5px" },
    }));
    const completedPanel = toolPanels.find((panel) => panelTitle(panel).includes("npm test"));
    const detailElements = (completedPanel?.elements ?? []) as Array<{ content?: string }>;
    expect(detailElements).toHaveLength(1);
    expect(detailElements[0]?.content).toBe("```\n$ npm test\nall passed\n```");
    expect(activityOrder).toEqual([...activityOrder].sort((left, right) => left - right));
    expect(new Set(activityOrder).size).toBe(4);
    expect(card).toMatchObject({
      schema: "2.0",
      config: { width_mode: "fill" },
      header: {
        subtitle: { tag: "plain_text", content: "耗时 52s · 2 个工具 · 1 个文件" },
        padding: "12px 12px 12px 12px",
      },
      body: {
        direction: "vertical",
        vertical_spacing: "8px",
        padding: "12px 12px 12px 12px",
        elements: expect.any(Array),
      },
    });
    expect(markdownContents).toContain("先检查测试配置");
    expect(markdownContents).toContain("> 💭 先检查测试配置");
    expect(markdownContents).toContain("```\n$ npm test\nall passed\n```");
    expect(markdownContents).toContain("```\n$ npm run lint\n命令失败\n```");
    for (const label of [
      "**状态**",
      "**耗时**",
      "**💭 思考**",
      "**工具**",
      "**命令**",
      "**退出码**",
      "**结果摘要**",
      "**错误摘要**",
    ]) {
      expect(markdownContents).not.toContain(label);
    }
    expect(markdownContents).not.toContain("\u001b");
    expect(markdownContents).not.toContain("完整内容请查看本地日志");
    expect(serialized).not.toContain("turn_details");
    expect(serialized).not.toContain("查看详情");
    expect(serialized).toContain("<font color='red'>Stop</font>");
    expect(serialized).toContain("<font color='grey'>· 52s</font>");
    expect(serialized).toContain('"action":"turn_cancel","sessionId":"s1","turnId":"turn_1"');
    expect(serialized).not.toContain('"action":"turn_reset"');
    expect(serialized).not.toContain("已完成的工具（");
    expect(serialized).not.toContain("失败的工具（");
    expect(serialized).not.toContain("/cancel");
  });

  test("uses grouped thinking cards by default and keeps only the latest native reasoning per execution group", () => {
    const running = state();
    const activeTool = {
      ...running.completedTools[0]!,
      id: "active-tool",
      title: "npm test --runInBand",
      command: "npm test --runInBand",
      status: "running" as const,
    };
    running.status = "tool_running";
    running.plan = [];
    running.fileSummary = [];
    running.activities = [
      { kind: "assistant", id: "commentary:1", text: "先确认项目结构。" },
      { kind: "reasoning", id: "reasoning:1", text: "第一段原生思考" },
      { kind: "tool", id: running.completedTools[0]!.id, tool: running.completedTools[0]! },
      { kind: "reasoning", id: "reasoning:2", text: "第二段原生思考" },
      { kind: "tool", id: running.failedTools[0]!.id, tool: running.failedTools[0]! },
      { kind: "assistant", id: "commentary:2", text: "结构已经明确，开始验证。" },
      { kind: "reasoning", id: "reasoning:3", text: "运行完整测试" },
      { kind: "tool", id: activeTool.id, tool: activeTool },
    ];

    const renderer = new CardRenderer();
    const card = renderer.renderTurn(running);
    const objects = collectObjects(card);
    const executionPanels = objects.filter((item) =>
      item.tag === "collapsible_panel" && String(item.element_id ?? "").startsWith("turn_exec_"));
    const serialized = JSON.stringify(card);

    expect(executionPanels).toHaveLength(2);
    expect(panelTitle(executionPanels[0]!)).toContain("第二段原生思考 · 2 个工具");
    expect(panelTitle(executionPanels[0]!)).not.toContain("第一段原生思考");
    expect(executionPanels[0]).toMatchObject({ expanded: false, border: { color: "grey" } });
    expect(panelTitle(executionPanels[0]!)).toMatch(/^💭 /);
    expect(panelTitle(executionPanels[0]!)).not.toContain("❌");
    expect((executionPanels[0]!.elements as unknown[])).toHaveLength(2);
    const failedToolPanel = collectObjects(executionPanels[0]).find((item) =>
      item.tag === "collapsible_panel" && String(item.element_id ?? "").startsWith("turn_tool_")
      && panelTitle(item).startsWith("❌"));
    expect(failedToolPanel).toBeDefined();
    expect(panelTitle(executionPanels[1]!)).toContain("运行完整测试 · 1 个工具");
    expect(executionPanels[1]).toMatchObject({ expanded: false, border: { color: "blue" } });
    expect(executionPanels.every((panel) => String(panel.element_id).length <= 20)).toBe(true);
    expect(serialized).toContain("先确认项目结构。");
    expect(serialized).toContain("结构已经明确，开始验证。");
    expect(serialized).not.toContain("第一段原生思考");

    const history = JSON.stringify(renderer.renderActivityHistory(running, 0));
    expect(history).not.toContain("第一段原生思考");
    expect(history).toContain("第二段原生思考");
    expect(history).toContain("运行完整测试");
  });

  test("shows only the latest native reasoning when an execution group has no tools", () => {
    const running = state();
    running.plan = [];
    running.fileSummary = [];
    running.activities = [
      { kind: "reasoning", id: "reasoning:1", text: "较早的原生思考" },
      { kind: "reasoning", id: "reasoning:2", text: "最新的原生思考" },
    ];

    const card = new CardRenderer().renderTurn(running);
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("较早的原生思考");
    expect(serialized).toContain("最新的原生思考");
    expect(serialized).not.toContain("turn_exec_");
  });

  test("keeps many small grouped activities together when their rendered content fits", () => {
    const running = state();
    running.plan = [];
    running.fileSummary = [];
    running.activities = Array.from({ length: 7 }, (_value, segmentIndex) => {
      const segment = segmentIndex + 1;
      const tool = {
        ...running.completedTools[0]!,
        id: `segment-tool:${segment}`,
        title: `Tool ${segment}`,
        command: `tool-${segment}`,
      };
      return [
        { kind: "assistant" as const, id: `commentary:${segment}`, text: `Commentary ${segment}` },
        ...Array.from({ length: 19 }, (_entry, reasoningIndex) => ({
          kind: "reasoning" as const,
          id: `reasoning:${segment}:${reasoningIndex + 1}`,
          text: `Reasoning ${segment}.${reasoningIndex + 1}`,
        })),
        { kind: "tool" as const, id: tool.id, tool },
      ];
    }).flat();

    const renderer = new CardRenderer();
    const card = renderer.renderTurn(running);
    const serialized = JSON.stringify(card);
    const executionPanels = collectObjects(card).filter((item) =>
      item.tag === "collapsible_panel" && String(item.element_id ?? "").startsWith("turn_exec_"));

    expect(serialized).not.toContain("查看历史思考");
    expect(serialized).toContain("Commentary 1");
    expect(serialized).toContain("Commentary 7");
    expect(executionPanels).toHaveLength(7);
    expect(serialized).not.toContain("Reasoning 1.5");
    expect(serialized).toContain("Reasoning 1.19");

    const history = JSON.stringify(renderer.renderActivityHistory(running, 0));
    expect(history).toContain("思考活动历史 · 1/1");
    expect(history).toContain("Commentary 1");
    expect(history).not.toMatch(/Reasoning 1\.1(?!9)/);
    expect(history).toContain("Reasoning 1.19");
    expect(history).toContain("Commentary 7");
  });

  test("paginates complete tool results by rendered card size instead of tool count", () => {
    const running = state();
    running.plan = [];
    running.fileSummary = [];
    running.activities = Array.from({ length: 52 }, (_value, index) => {
      const position = index + 1;
      const tool = {
        ...running.completedTools[0]!,
        id: `long-tool:${position}`,
        title: `Long tool ${position}`,
        command: `long-tool-${position}`,
      };
      return { kind: "tool" as const, id: tool.id, tool };
    });

    const renderer = new CardRenderer();
    const card = renderer.renderTurn(running);
    const serialized = JSON.stringify(card);
    const executionPanels = collectObjects(card).filter((item) =>
      item.tag === "collapsible_panel" && String(item.element_id ?? "").startsWith("turn_exec_"));
    const toolPanels = collectObjects(card).filter((item) =>
      item.tag === "collapsible_panel" && String(item.element_id ?? "").startsWith("turn_tool_"));
    const toolTitles = toolPanels.map(panelTitle);

    expect(serialized).toContain("查看历史思考（共 2 页）");
    expect(executionPanels).toHaveLength(6);
    expect(toolPanels).toHaveLength(44);
    expect(toolTitles).not.toContain("✅ Long tool 1");
    expect(toolTitles).toContain("✅ Long tool 9");
    expect(toolTitles).toContain("✅ Long tool 17");
    expect(toolTitles).toContain("✅ Long tool 52");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(30 * 1024);

    const historyCard = renderer.renderActivityHistory(running, 0);
    const history = JSON.stringify(historyCard);
    const historyToolTitles = collectObjects(historyCard)
      .filter((item) => item.tag === "collapsible_panel" && String(item.element_id ?? "").startsWith("turn_tool_"))
      .map(panelTitle);
    expect(historyToolTitles).toContain("✅ Long tool 1");
    expect(historyToolTitles).toContain("✅ Long tool 8");
    expect(historyToolTitles).not.toContain("✅ Long tool 9");
    expect(history).toContain("思考活动历史 · 1/2");
    expect(history).toContain("最新页");
    expect(history).toContain('"page":"latest"');
  });

  test("uses more pages for larger rendered results with the same tool count", () => {
    const renderTools = (output: string): Record<string, unknown> => {
      const running = state();
      running.plan = [];
      running.fileSummary = [];
      running.activities = Array.from({ length: 20 }, (_value, index) => {
        const position = index + 1;
        const tool = {
          ...running.completedTools[0]!,
          id: `sized-tool:${position}`,
          title: `Sized tool ${position}`,
          command: `sized-tool-${position}`,
          output,
        };
        return { kind: "tool" as const, id: tool.id, tool };
      });
      return new CardRenderer().renderTurn(running);
    };

    const shortCard = renderTools("ok");
    const verboseCard = renderTools(`${"result-".repeat(170)}tail`);
    const shortSerialized = JSON.stringify(shortCard);
    const verboseSerialized = JSON.stringify(verboseCard);

    expect(shortSerialized).not.toContain("查看历史思考");
    expect(verboseSerialized).toContain("查看历史思考（共 2 页）");
    expect(verboseSerialized).toContain("tail");
    expect(Buffer.byteLength(shortSerialized, "utf8")).toBeLessThanOrEqual(30 * 1024);
    expect(Buffer.byteLength(verboseSerialized, "utf8")).toBeLessThanOrEqual(30 * 1024);
  });

  test("chooses one execution-group cutoff and pins the three nearest earlier commentaries", () => {
    const running = state();
    running.plan = [];
    running.fileSummary = [];
    const segment = (position: number) => {
      const commentary = {
        kind: "assistant" as const,
        id: `commentary:${position}`,
        text: `Commentary ${position}`,
      };
      const tools = Array.from({ length: 6 }, (_value, toolIndex) => {
        const toolPosition = toolIndex + 1;
        const tool = {
          ...running.completedTools[0]!,
          id: `segment-${position}-tool-${toolPosition}`,
          title: `Segment ${position} tool ${toolPosition}`,
          command: `segment-${position}-tool-${toolPosition}`,
          output: `SEGMENT_${position}_RESULT_${toolPosition}\n${"result-data-".repeat(140)}`,
        };
        return { kind: "tool" as const, id: tool.id, tool };
      });
      return [
        commentary,
        {
          kind: "reasoning" as const,
          id: `reasoning:${position}`,
          text: `Native reasoning ${position}`,
        },
        ...tools,
      ];
    };
    const imageTool = {
      ...running.completedTools[0]!,
      id: "segment-1-image",
      title: "View generated preview",
      kind: "image_view",
      command: "view_image preview.png",
      output: "IMAGE_RESULT_KEEP",
      imagePath: "D:\\tmp\\preview.png",
    };
    running.activities = [
      ...segment(1),
      { kind: "tool", id: imageTool.id, tool: imageTool } as const,
      ...segment(2),
      ...segment(3),
      ...segment(4),
    ];

    const renderer = new CardRenderer();
    const card = renderer.renderTurn(running);
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("查看历史思考");
    expect(serialized).toContain("Commentary 1");
    expect(serialized).toContain("Commentary 2");
    expect(serialized).toContain("Commentary 3");
    expect(serialized).toContain("Commentary 4");
    expect(serialized).not.toContain("segment-1-tool-1");
    expect(serialized).not.toContain("SEGMENT_1_RESULT_1");
    expect(serialized).not.toContain("segment-2-tool-1");
    expect(serialized).not.toContain("SEGMENT_2_RESULT_1");
    expect(serialized).toContain("segment-3-tool-1");
    expect(serialized).toContain("SEGMENT_3_RESULT_1");
    expect(serialized).not.toContain("Native reasoning 1");
    expect(serialized).not.toContain("Native reasoning 2");
    expect(serialized).toContain("Native reasoning 3");
    expect(serialized).toContain("Native reasoning 4");
    expect(serialized).toContain("SEGMENT_4_RESULT_1");
    expect(serialized).not.toContain("IMAGE_RESULT_KEEP");
    expect(serialized).not.toContain("D:\\\\tmp\\\\preview.png");
    expect(serialized).not.toContain("View generated preview");
    expect(collectObjects(card).filter((item) => item.tag === "markdown" && item.content === "…").length)
      .toBeGreaterThanOrEqual(2);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(30 * 1024);

    const history = JSON.stringify(renderer.renderActivityHistory(running, 0));
    expect(history).toContain("Commentary 1");
    expect(history).toContain("SEGMENT_1_RESULT_1");
    expect(history).toContain("IMAGE_RESULT_KEEP");

    const historyAction = collectObjects(card).find((item) => item.action === "activity_history");
    expect(historyAction?.page).toEqual(expect.any(String));
    const cutoffHistory = JSON.stringify(renderer.renderActivityHistory(running, Number(historyAction?.page)));
    expect(cutoffHistory).toContain("Commentary 1");
    expect(cutoffHistory).toContain("Commentary 2");
    expect(cutoffHistory).toContain("Commentary 3");
    expect(cutoffHistory).toContain("SEGMENT_2_RESULT_1");
    expect(cutoffHistory).not.toContain("SEGMENT_3_RESULT_1");
    expect(cutoffHistory).not.toContain("SEGMENT_4_RESULT_1");
  });

  test("keeps a single tool before the latest commentary when the rendered card has room", () => {
    const running = state();
    running.plan = [];
    running.fileSummary = [];
    const verboseTools = (segment: number) => Array.from({ length: 10 }, (_value, index) => {
      const position = index + 1;
      const tool = {
        ...running.completedTools[0]!,
        id: `verbose-${segment}-${position}`,
        title: `Verbose ${segment}.${position}`,
        command: `verbose-${segment}-${position}`,
        output: `VERBOSE_${segment}_${position}\n${"result-data-".repeat(180)}`,
      };
      return { kind: "tool" as const, id: tool.id, tool };
    });
    const targetTool = {
      ...running.completedTools[0]!,
      id: "single-before-latest",
      title: "Single before latest",
      command: "single-before-latest",
      output: "SINGLE_RESULT",
    };
    const latestTool = {
      ...running.completedTools[0]!,
      id: "latest-tool",
      title: "Latest tool",
      command: "latest-tool",
      output: "LATEST_RESULT",
    };
    running.activities = [
      { kind: "assistant", id: "commentary:1", text: "Commentary 1" },
      ...verboseTools(1),
      { kind: "assistant", id: "commentary:2", text: "Commentary 2" },
      ...verboseTools(2),
      { kind: "assistant", id: "commentary:3", text: "Commentary 3" },
      { kind: "reasoning", id: "reasoning:target", text: "Target native reasoning" },
      { kind: "tool", id: targetTool.id, tool: targetTool },
      { kind: "assistant", id: "commentary:4", text: "Commentary 4" },
      { kind: "reasoning", id: "reasoning:latest", text: "Latest native reasoning" },
      { kind: "tool", id: latestTool.id, tool: latestTool },
    ];

    const card = new CardRenderer().renderTurn(running);
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("查看历史思考");
    expect(serialized).not.toContain('"content":"✅ Verbose 1.1"');
    expect(serialized).toContain("single-before-latest");
    expect(serialized).toContain("SINGLE_RESULT");
    expect(serialized).toContain("Target native reasoning");
    expect(serialized).toContain("Latest native reasoning");
    expect(serialized).toContain("LATEST_RESULT");
  });

  test("keeps a stable collapsed default so the client can preserve manual expansion", () => {
    const running = state();
    const command = {
      ...running.completedTools[0]!,
      id: "stable-command",
      status: "running" as const,
    };
    running.plan = [];
    running.fileSummary = [];
    running.activities = [
      { kind: "reasoning", id: "reasoning:stable", text: "正在验证结果" },
      { kind: "tool", id: command.id, tool: command },
    ];

    const renderer = new CardRenderer();
    const runningPanel = collectObjects(renderer.renderTurn(running)).find((item) =>
      item.tag === "collapsible_panel" && String(item.element_id ?? "").startsWith("turn_exec_"));
    expect(runningPanel).toMatchObject({ expanded: false, border: { color: "blue" } });

    running.activities[1] = {
      kind: "tool",
      id: command.id,
      tool: { ...command, status: "completed" },
    };
    const completedPanel = collectObjects(renderer.renderTurn(running)).find((item) =>
      item.tag === "collapsible_panel" && String(item.element_id ?? "").startsWith("turn_exec_"));
    expect(completedPanel).toMatchObject({
      element_id: runningPanel?.element_id,
      expanded: false,
      border: { color: "grey" },
    });

    running.activities.push({
      kind: "user",
      id: "steer:next",
      text: "同时检查边界情况。",
    });
    const steeredPanel = collectObjects(renderer.renderTurn(running)).find((item) =>
      item.tag === "collapsible_panel" && String(item.element_id ?? "").startsWith("turn_exec_"));
    expect(steeredPanel).toMatchObject({
      element_id: runningPanel?.element_id,
      expanded: false,
      border: { color: "grey" },
    });

    const followUpTool = {
      ...command,
      id: "follow-up-command",
      title: "npm run typecheck",
      status: "running" as const,
    };
    running.activities.push(
      { kind: "reasoning", id: "reasoning:follow-up", text: "继续检查边界情况" },
      { kind: "tool", id: followUpTool.id, tool: followUpTool },
    );
    const continuedCard = renderer.renderTurn(running);
    const continuedPanel = collectObjects(continuedCard).find((item) =>
      item.tag === "collapsible_panel" && String(item.element_id ?? "").startsWith("turn_exec_"));
    expect(continuedPanel).toMatchObject({
      element_id: runningPanel?.element_id,
      expanded: false,
      border: { color: "blue" },
    });
    expect((continuedPanel?.elements as unknown[])).toHaveLength(2);
    expect(panelTitle(continuedPanel!)).toContain("继续检查边界情况 · 2 个工具");
    const continuedSerialized = JSON.stringify(continuedCard);
    expect(continuedSerialized.indexOf("同时检查边界情况。")).toBeLessThan(
      continuedSerialized.indexOf("继续检查边界情况 · 2 个工具"),
    );

    running.activities.push({
      kind: "assistant",
      id: "commentary:next",
      text: "验证完成，继续整理结论。",
    });
    const settledPanel = collectObjects(renderer.renderTurn(running)).find((item) =>
      item.tag === "collapsible_panel" && String(item.element_id ?? "").startsWith("turn_exec_"));
    expect(settledPanel).toMatchObject({
      element_id: runningPanel?.element_id,
      expanded: false,
      border: { color: "blue" },
    });
  });

  test("shows Reset with a compact explanation only after a turn completes successfully", () => {
    const renderer = new CardRenderer();
    const completed = renderer.renderTurn({
      ...state(),
      status: "completed",
      completedAt: 2_000,
    });
    const completedObjects = collectObjects(completed);
    const resetNote = completedObjects.find((item) =>
      item.tag === "markdown" && String(item.content ?? "").includes("不会回退本地文件"));
    const completedSerialized = JSON.stringify(completed);
    const completedElements = (completed as {
      body: { elements: Array<Record<string, unknown>> };
    }).body.elements;
    const resetActionIndex = completedElements.findIndex((item) => JSON.stringify(item).includes('"action":"turn_reset"'));
    const resetNoteIndex = completedElements.findIndex((item) => String(item.content ?? "").includes("不会回退本地文件"));

    expect(resetNote).toMatchObject({ text_size: "notation" });
    expect(resetNoteIndex).toBe(resetActionIndex + 1);
    expect(completedSerialized).toContain("<font color='blue'>Reset</font>");
    expect(completedSerialized).not.toContain("<font color='grey'>· 52s</font>");
    expect(completedSerialized).toContain('"action":"turn_reset","sessionId":"s1","turnId":"turn_1"');
    expect(completedSerialized).not.toContain('"action":"turn_cancel"');

    const failedSerialized = JSON.stringify(renderer.renderTurn({
      ...state(),
      status: "failed",
      error: "failed",
    }));
    expect(failedSerialized).not.toContain('"action":"turn_reset"');
  });

  test("renders each Reset history action beside its completed turn", () => {
    const card = new CardRenderer().renderResetHistoryCard({
      entries: [
        {
          sequence: 1,
          graphNodeLine: "● 1",
          graphConnectorLine: "│",
          lines: ["First prompt"],
          timestamp: "08/03 10:00",
          current: true,
        },
        {
          sequence: 2,
          graphNodeLine: "● 2",
          lines: ["Earlier prompt"],
          timestamp: "08/03 09:00",
          actions: [{ text: "Reset", value: { action: "turn_reset", turnId: "turn_1" } }],
        },
      ],
      footerLines: ["第 1/1 页 · 共 2 个已完成 turn"],
      pageActions: [],
    });
    const elements = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
    const rows = elements.filter((item) =>
      item.tag === "column_set"
      && item.flex_mode === "none"
      && Array.isArray(item.columns)
      && item.columns.length === 3);

    expect(rows).toHaveLength(2);
    expect(elements[0]).toMatchObject({ tag: "markdown", text_size: "notation" });
    expect(String(elements[0]?.content)).toContain("不会回退本地文件");
    expect(elements[1]).toEqual({ tag: "hr" });
    expect(JSON.stringify(rows[0])).toContain("<font color='green'>●</font>");
    expect(JSON.stringify(rows[0])).toContain("<font color='green'>1</font>");
    expect(JSON.stringify(rows[0])).not.toContain("<font color='grey'>│</font>");
    expect(JSON.stringify(rows[1])).toContain("<font color='blue'>●</font>");
    expect(JSON.stringify(rows[1])).toContain("<font color='blue'>2</font>");
    expect(JSON.stringify(rows[1])).not.toContain("<font color='grey'>│</font>");
    const promptContents = rows.map((row) => {
      const columns = row.columns as Array<{ elements?: Array<Record<string, unknown>> }>;
      expect(columns[1]?.elements?.[0]).not.toHaveProperty("padding");
      expect(columns[1]?.elements?.[0]?.content).not.toMatch(/^\*\*/);
      expect(columns[1]?.elements).toHaveLength(1);
      expect(columns[1]?.elements?.[0]?.content).not.toContain("turn_");
      return columns[1]?.elements?.[0]?.content;
    });
    expect(promptContents).toEqual([
      "First prompt <font color='grey'>08/03 10:00</font>",
      "Earlier prompt <font color='grey'>08/03 09:00</font>",
    ]);
    expect(card).toMatchObject({ header: { title: { content: "历史对话轮次" } } });
    expect(JSON.stringify(card)).toContain("✅ 当前");
    expect(JSON.stringify(card).match(/"action":"turn_reset"/g)).toHaveLength(1);
  });

  test("only renders graph connector rows for branch transitions", () => {
    const card = new CardRenderer().renderResetHistoryCard({
      entries: [{
        sequence: 1,
        graphNodeLine: "│ ● 1",
        graphConnectorLine: "│ ╱",
        lines: ["Branch prompt"],
        timestamp: "08/03 10:00",
      }],
      footerLines: [],
      pageActions: [],
    });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("<font color='blue'>│</font>");
    expect(serialized).toContain("<font color='blue'>●</font>");
    expect(serialized).toContain("<font color='grey'>│</font>");
    expect(serialized).toContain("<font color='grey'>╱</font>");
  });

  test("aligns branch connectors in fixed lanes independently of turn number width", () => {
    const card = new CardRenderer().renderResetHistoryCard({
      entries: [{
        sequence: 9, graphNodeLine: "│ ● 9", graphConnectorLine: "│ ╱", lines: ["Branch prompt"],
      }, {
        sequence: 10, graphNodeLine: "● │ 10", graphConnectorLine: "╲ │", lines: ["Another branch"],
      }, {
        sequence: 100, graphNodeLine: "│ │ ● 100", graphConnectorLine: "│ │ ╱", lines: ["Deep branch"],
      }],
      footerLines: [], pageActions: [],
    });
    const graphs = collectObjects(card)
      .filter((element) => element.tag === "column_set" && element.horizontal_spacing === "0px")
      .map((row) => row.columns as Array<{
        width: string; elements: Array<{ content: string; text_align: string }>;
      }>);
    expect(graphs.map((columns) => columns.map((column) => column.width))).toEqual([
      ["16px", "16px", "30px"], ["16px", "16px", "30px"], ["16px", "16px", "16px", "30px"],
    ]);
    expect(graphs.map((columns) => columns.slice(0, -1).map((column) => column.elements[0]!.content))).toEqual([
      ["<font color='blue'>│</font>\n<font color='grey'>│</font>", "<font color='blue'>●</font>\n<font color='grey'>╱</font>"],
      ["<font color='blue'>●</font>\n<font color='grey'>╲</font>", "<font color='blue'>│</font>\n<font color='grey'>│</font>"],
      ["<font color='blue'>│</font>\n<font color='grey'>│</font>", "<font color='blue'>│</font>\n<font color='grey'>│</font>",
        "<font color='blue'>●</font>\n<font color='grey'>╱</font>"],
    ]);
    for (const columns of graphs) {
      expect(columns.slice(0, -1).every((column) => column.elements[0]?.text_align === "center")).toBe(true);
      expect(columns.at(-1)?.elements[0]?.text_align).toBe("left");
    }
  });

  test("renders a running turn without a Reset action", () => {
    const card = new CardRenderer().renderResetHistoryCard({
      entries: [{
        sequence: 1,
        graphNodeLine: "● 1",
        graphConnectorLine: "│",
        lines: ["Active prompt"],
        timestamp: "08/03 10:00",
        running: true,
      }],
      footerLines: ["第 1/1 页 · 共 1 个 turn（0 个已完成，1 个运行中）"],
      pageActions: [],
    });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("<font color='orange'>●</font>");
    expect(serialized).toContain("Active prompt <font color='grey'>08/03 10:00</font>");
    expect(serialized).not.toContain("turn_active");
    expect(serialized).toContain("⏳ 运行中");
    expect(serialized).not.toContain('"action":"turn_reset"');
  });

  test("renders the selected turn as resetting without a Reset action", () => {
    const card = new CardRenderer().renderResetHistoryCard({
      entries: [{
        sequence: 1,
        graphNodeLine: "● 1",
        graphConnectorLine: "│",
        lines: ["Reset target"],
        timestamp: "08/03 10:00",
        resetting: true,
      }, {
        sequence: 2,
        graphNodeLine: "● 2",
        lines: ["Another completed turn"],
        timestamp: "08/03 09:00",
      }],
      footerLines: ["正在 Reset 到所选轮次，请稍候…"],
      pageActions: [{ text: "Next", value: { action: "turn_reset_page", page: "1" } }],
    });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("<font color='orange'>●</font>");
    expect(serialized).toContain("⏳ 正在 Reset");
    expect(serialized).toContain("正在 Reset 到所选轮次，请稍候…");
    expect(serialized).not.toContain('"action":"turn_reset"');
    expect(serialized).toContain('"action":"turn_reset_page"');
    const rows = ((card.body as { elements: Array<Record<string, unknown>> }).elements)
      .filter((item) => item.tag === "column_set" && item.flex_mode === "none");
    expect(rows).toHaveLength(2);
    expect((rows[1]?.columns as unknown[])).toHaveLength(2);
  });

  test.each([
    [850, "0.9s"],
    [9_849, "9.8s"],
    [9_950, "10s"],
    [10_400, "10s"],
    [10_500, "11s"],
    [188_000, "03:08"],
    [4_320_000, "01:12:00"],
    [93_600_000, "26:00:00"],
  ])("formats a %i ms turn duration with adaptive precision", (durationMs, expectedDuration) => {
    const current = { ...state(), durationMs, totalTokens: 12_345 };
    const card = new CardRenderer().renderTurn(current) as { header: { subtitle: { content: string } } };

    expect(card.header.subtitle.content).toBe(`耗时 ${expectedDuration} · 12.3K tokens · 2 个工具 · 1 个文件`);
    expect(JSON.stringify(card)).toContain(`<font color='grey'>· ${expectedDuration}</font>`);
  });

  test("uses a terminal timestamp to freeze elapsed time for legacy snapshots without durationMs", () => {
    const failed = {
      ...state(),
      status: "failed" as const,
      startedAt: 1_000,
      completedAt: 94_000,
      durationMs: undefined,
      error: "connection lost",
    };

    const serialized = JSON.stringify(new CardRenderer().renderTurn(failed));

    expect(serialized).toContain('"content":"耗时 01:33 · 2 个工具 · 1 个文件"');
    expect(serialized).not.toContain("<font color='grey'>01:33</font>");
    expect(serialized).not.toContain("Stop");
  });

  test.each([
    [9_999, "9,999 tokens"],
    [10_000, "10K tokens"],
    [12_345, "12.3K tokens"],
    [2_242_908, "2.24M tokens"],
    [117_476_956, "117M tokens"],
    [1_234_567_890, "1.23B tokens"],
  ])("formats %i tokens compactly as %s", (totalTokens, expected) => {
    const current = { ...state(), totalTokens };
    const card = new CardRenderer().renderTurn(current) as { header: { subtitle: { content: string } } };

    expect(card.header.subtitle.content).toContain(expected);
  });

  test("uses the unbounded tool counter in the subtitle", () => {
    const current = { ...state(), totalToolCount: 778 };
    const card = new CardRenderer().renderTurn(current) as { header: { subtitle: { content: string } } };

    expect(card.header.subtitle.content).toContain("778 个工具");
  });

  test.each([
    [12_400, "12.4s"],
    [72_400, "01:12.4s"],
    [7_272_400, "02:01:12.4s"],
    [59_960, "01:00.0s"],
  ])("adds a compact %s ms duration to completed tool titles", (durationMs, expectedDuration) => {
    const current = state();
    const completed = {
      id: "timed",
      title: "npm test",
      kind: "command",
      status: "completed" as const,
      command: "npm test",
      startedAt: 1_000,
      completedAt: 1_000 + durationMs,
    };
    current.activities = [{ kind: "tool", id: completed.id, tool: completed }];

    const card = new CardRenderer().renderTurn(current);
    const panel = collectObjects(card).find((item) =>
      item.tag === "collapsible_panel" && panelTitle(item).includes("npm test"));

    expect(panelTitle(panel ?? {})).toBe(`✅ npm test · ${expectedDuration}`);
  });

  test("uses a compact trailing ellipsis in long tool headers", () => {
    const running = state();
    const command = `Get-Content ${"x".repeat(150)}`;
    const active = { id: "long", title: command, kind: "command", status: "running" as const, command };
    running.activities = [{ kind: "tool", id: active.id, tool: active }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => item.tag === "collapsible_panel" && panelTitle(item).includes("Get-Content"));

    expect(panelTitle(panel ?? {})).toMatch(/\.\.\.$/);
    expect(panelTitle(panel ?? {})).not.toContain("已截断");
  });

  test("unwraps PowerShell launchers in both tool titles and expanded command details", () => {
    const running = state();
    const command = '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "Get-Content src/index.ts | Select-Object -First 20"';
    const active = { id: "wrapped", title: command, kind: "command", status: "running" as const, command };
    running.activities = [{ kind: "tool", id: active.id, tool: active }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => item.tag === "collapsible_panel" && panelTitle(item).includes("Get-Content"));
    const details = String(((panel?.elements as Array<{ content?: string }> | undefined)?.[0]?.content) ?? "");

    expect(panelTitle(panel ?? {})).toBe("⏳ Get-Content src/index.ts | Select-Object -First 20");
    expect(panelTitle(panel ?? {})).not.toMatch(/powershell|pwsh/i);
    expect(details).toContain("$ Get-Content src/index.ts | \\\n  Select-Object -First 20");
    expect(details).not.toMatch(/powershell|pwsh/i);
  });

  test("unwraps single-quoted multiline PowerShell commands into compact titles", () => {
    const running = state();
    const command = "powershell.exe -Command 'npm test -- --run\nif ($LASTEXITCODE -ne 0) { exit 1 }'";
    const tool = { id: "multiline", title: command, kind: "command", status: "completed" as const, command };
    running.activities = [{ kind: "tool", id: tool.id, tool }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => item.tag === "collapsible_panel" && panelTitle(item).includes("npm test"));
    const details = String(((panel?.elements as Array<{ content?: string }> | undefined)?.[0]?.content) ?? "");

    expect(panelTitle(panel ?? {})).toBe("✅ npm test -- --run if ($LASTEXITCODE -ne 0) { exit 1 }");
    expect(details).toContain("$ npm test -- --run\nif ($LASTEXITCODE -ne 0) { exit 1 }");
    expect(details).not.toMatch(/powershell|pwsh/i);
  });

  test("decodes adjacent shell-quoted PowerShell command fragments", () => {
    const running = state();
    const command = String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command 'Start-Sleep -Seconds 40; $ps=Get-CimInstance Win32_Process | Where-Object {$_.Name -eq '"'blazecache.exe' -and "'$_.CommandLine -like '"'*pull*--repo*./*--product*doubao*'}; [pscustomobject]@{Running=[bool]"'$ps;Pids=($ps.ProcessId -join '"',')} | Format-List; Get-Content '.cache\\m147_bua_update_build_20260824\\blazecache_pull.stderr.log' -Tail 28"`;
    const tool = { id: "quoted-fragments", title: command, kind: "command", status: "running" as const, command };
    running.activities = [{ kind: "tool", id: tool.id, tool }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) =>
      item.tag === "collapsible_panel" && panelTitle(item).includes("Start-Sleep"));
    const title = panelTitle(panel ?? {});
    const details = String(((panel?.elements as Array<{ content?: string }> | undefined)?.[0]?.content) ?? "");

    expect(title).not.toMatch(/powershell|pwsh/i);
    expect(title).not.toContain("\"'");
    expect(details).toContain("$ Start-Sleep -Seconds 40; \\\n  $ps=Get-CimInstance Win32_Process | \\\n  Where-Object {$_.Name -eq 'blazecache.exe' -and $_.CommandLine -like '*pull*--repo*./*--product*doubao*'}; \\");
    expect(details).toContain("[pscustomobject]@{Running=[bool]$ps;");
    expect(details).not.toMatch(/powershell|pwsh/i);
    expect(details).not.toContain("\"'");
  });

  test("keeps the shell launcher when a quoted command payload cannot be fully decoded", () => {
    const running = state();
    const command = "powershell.exe -Command 'Write-Output unterminated";
    const tool = { id: "invalid-payload", title: command, kind: "command", status: "running" as const, command };
    running.activities = [{ kind: "tool", id: tool.id, tool }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) =>
      item.tag === "collapsible_panel" && panelTitle(item).includes("powershell.exe"));
    const details = String(((panel?.elements as Array<{ content?: string }> | undefined)?.[0]?.content) ?? "");

    expect(panelTitle(panel ?? {})).toContain(command);
    expect(details).toContain(`$ ${command}`);
  });

  test.each([
    ["macOS zsh", "/bin/zsh -lc 'npm run typecheck && npm test'", "npm run typecheck && npm test"],
    ["Linux bash", "/bin/bash -c \"git status --short\"", "git status --short"],
    ["POSIX sh", "sh -c 'pwd && ls -la'", "pwd && ls -la"],
    ["env zsh", "/usr/bin/env zsh -lc 'npm run build'", "npm run build"],
  ])("unwraps %s launchers in tool titles and expanded command details", (_name, command, expected) => {
    const running = state();
    const tool = { id: "posix-shell", title: command, kind: "command", status: "running" as const, command };
    running.activities = [{ kind: "tool", id: tool.id, tool }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) =>
      item.tag === "collapsible_panel" && panelTitle(item).includes(expected));
    const details = String(((panel?.elements as Array<{ content?: string }> | undefined)?.[0]?.content) ?? "");

    expect(panelTitle(panel ?? {})).toBe(`⏳ ${expected}`);
    expect(panelTitle(panel ?? {})).not.toMatch(/(?:^|\s)(?:zsh|bash|sh)\b|\/bin\/|\/usr\/bin\/env|\s-l?c\b/i);
    expect(details).toContain(`$ ${expected.replaceAll(" && ", " && \\\n  ")}`);
    expect(details).not.toContain(command);
  });

  test("wraps shell command separators in expanded tool details", () => {
    const running = state();
    const command = "git status --short; git remote -v | Select-String origin && npm test || Write-Output 'failed | keep; together'";
    const tool = { id: "compound", title: command, kind: "command", status: "running" as const, command };
    running.activities = [{ kind: "tool", id: tool.id, tool }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) =>
      item.tag === "collapsible_panel" && panelTitle(item).includes("git status"));
    const details = String(((panel?.elements as Array<{ content?: string }> | undefined)?.[0]?.content) ?? "");

    expect(details).toContain([
      "$ git status --short; \\",
      "  git remote -v | \\",
      "  Select-String origin && \\",
      "  npm test || \\",
      "  Write-Output 'failed | keep; together'",
    ].join("\n"));
  });

  test("keeps POSIX shell invocations without a command-string flag intact", () => {
    const running = state();
    const command = "/bin/bash scripts/check.sh";
    const tool = { id: "shell-script", title: command, kind: "command", status: "running" as const, command };
    running.activities = [{ kind: "tool", id: tool.id, tool }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) =>
      item.tag === "collapsible_panel" && panelTitle(item).includes(command));
    const details = String(((panel?.elements as Array<{ content?: string }> | undefined)?.[0]?.content) ?? "");

    expect(panelTitle(panel ?? {})).toBe(`⏳ ${command}`);
    expect(details).toContain(`$ ${command}`);
  });

  test("uses the useful web-search action title while keeping full details expandable", () => {
    const running = state();
    const tool = {
      id: "web_1",
      title: "打开网页 · developers.openai.com/codex/app-server",
      kind: "web_search",
      status: "completed" as const,
      command: "open_page https://developers.openai.com/codex/app-server?source=test",
    };
    running.activities = [{ kind: "tool", id: tool.id, tool }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => panelTitle(item).includes("打开网页"));
    const details = String(((panel?.elements as Array<{ content?: string }> | undefined)?.[0]?.content) ?? "");

    expect(panelTitle(panel ?? {})).toBe("✅ 打开网页 · developers.openai.com/codex/app-server");
    expect(details).toContain("$ open_page https://developers.openai.com/codex/app-server?source=test");
  });

  test("renders a view_image preview inside the collapsed tool panel", () => {
    const running = state();
    const imagePath = "D:\\dev\\agent-bot\\.tmp\\preview.png";
    const tool = {
      id: "image_1",
      title: `查看图片 ${imagePath}`,
      kind: "image_view",
      status: "completed" as const,
      command: `view_image ${imagePath}`,
      imagePath,
    };
    running.activities = [{ kind: "tool", id: tool.id, tool }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => panelTitle(item).includes("查看图片"));
    const elements = panel?.elements as Array<Record<string, unknown>> | undefined;

    expect(panel).toMatchObject({ tag: "collapsible_panel", expanded: false });
    expect(elements?.map((element) => element.tag)).toEqual(["markdown", "img"]);
    expect(elements?.[1]).toMatchObject({
      tag: "img",
      img_key: "",
      __acp_local_image_path: imagePath,
      preview: true,
    });
  });

  test("renders a generated image preview inside its tool panel", () => {
    const running = state();
    const imagePath = "D:\\dev\\agent-bot\\.tmp\\generated.png";
    const tool = {
      id: "generated_1",
      title: "生成图片",
      kind: "image_generation",
      status: "completed" as const,
      imagePath,
    };
    running.activities = [{ kind: "tool", id: tool.id, tool }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => panelTitle(item).includes("生成图片"));
    const elements = panel?.elements as Array<Record<string, unknown>> | undefined;

    expect(elements?.[1]).toMatchObject({
      tag: "img",
      __acp_local_image_path: imagePath,
      preview: true,
    });
  });

  test("keeps a stable identity for the trailing file panel as activities are inserted before it", () => {
    const running = state();
    const renderer = new CardRenderer();
    const before = collectObjects(renderer.renderTurn(running)).find((item) => panelTitle(item).startsWith("文件变更"));

    running.activities.push({ kind: "reasoning", id: "reasoning:new", text: "新增进度" });
    const after = collectObjects(renderer.renderTurn(running)).find((item) => panelTitle(item).startsWith("文件变更"));

    expect(before).toMatchObject({ element_id: "turn_files" });
    expect(after).toMatchObject({ element_id: "turn_files" });
  });

  test("shows project files as relative paths and external files as absolute paths", () => {
    const running = state();
    running.projectCwd = "D:\\dev\\agent-bot";
    const files = [
      { path: "D:\\dev\\agent-bot\\src\\index.ts", additions: 1 },
      { path: "src/relative.ts", additions: 2 },
      { path: "..\\shared\\config.ts", deletions: 1 },
      { path: "E:\\external\\other.ts", additions: 3 },
    ];
    const tool = {
      id: "file_change_1",
      title: "更新文件",
      kind: "file_change",
      status: "completed" as const,
      files,
    };
    running.activities = [{ kind: "tool", id: tool.id, tool }];
    running.fileSummary = files;

    const card = new CardRenderer().renderTurn(running);
    const markdownContents = collectObjects(card)
      .filter((item) => item.tag === "markdown")
      .map((item) => String(item.content ?? ""))
      .join("\n");

    expect(markdownContents).toContain("src\\index.ts  +1 -0");
    expect(markdownContents).toContain("src\\relative.ts  +2 -0");
    expect(markdownContents).toContain("D:\\dev\\shared\\config.ts  +0 -1");
    expect(markdownContents).toContain("E:\\external\\other.ts  +3 -0");
    expect(markdownContents).not.toContain("D:\\dev\\agent-bot\\src\\index.ts");
  });

  test("preserves the Windows separator before a dot directory in the file summary", () => {
    const running = state();
    running.projectCwd = "D:\\dev\\agent-bot";
    running.fileSummary = [{
      path: "C:\\Users\\Admin\\.agent-bot\\config.yaml",
      additions: 28,
      deletions: 4,
    }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => panelTitle(item).startsWith("文件变更"));
    const content = String((panel?.elements as Array<{ content?: string }> | undefined)?.[0]?.content ?? "");

    expect(content).toContain("C:\\Users\\Admin\\\\.agent-bot\\config.yaml  +28 -4");
    expect(content).not.toContain("`");
  });

  test("keeps a stable identity for a tool panel while command output is updated", () => {
    const running = state();
    const renderer = new CardRenderer();
    const command = { id: "command:with/slashes", title: "npm test", kind: "command", status: "running" as const, command: "npm test" };
    running.activities = [{ kind: "tool", id: command.id, tool: command }];
    const before = collectObjects(renderer.renderTurn(running)).find((item) => panelTitle(item).includes("npm test"));

    running.activities = [{ kind: "tool", id: command.id, tool: { ...command, output: "test 1 passed" } }];
    const after = collectObjects(renderer.renderTurn(running)).find((item) => panelTitle(item).includes("npm test"));

    expect(before?.element_id).toMatch(/^turn_tool_[a-f0-9]{16}$/);
    expect(after?.element_id).toBe(before?.element_id);
  });

  test("preserves raw command formatting and both ends of oversized tool results", () => {
    const running = state();
    const command = `Write-Output 'first'\n${"x".repeat(900)}`;
    const output = `RESULT_HEAD\n${"a".repeat(700)}MIDDLE_SENTINEL${"b".repeat(700)}\nRESULT_TAIL`;
    const tool = { id: "long-output", title: "long output", kind: "command", status: "completed" as const, command, output };
    running.activities = [{ kind: "tool", id: tool.id, tool }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => item.tag === "collapsible_panel" && panelTitle(item).includes("long output"));
    const content = String(((panel?.elements as Array<{ content?: string }> | undefined)?.[0]?.content) ?? "");
    const inner = content.slice(4, -4);
    const resultStart = inner.indexOf("\nRESULT_HEAD");
    const renderedCommand = inner.slice(2, resultStart);
    const renderedResult = inner.slice(resultStart + 1);

    expect(renderedCommand).toHaveLength(600);
    expect(renderedCommand).toMatch(/^Write-Output 'first'\n/);
    expect(renderedCommand).toMatch(/\.\.\.$/);
    expect(renderedResult).toHaveLength(900);
    expect(renderedResult).toContain("RESULT_HEAD");
    expect(renderedResult).toContain("RESULT_TAIL");
    expect(renderedResult).toContain("\n...\n");
    expect(renderedResult).not.toContain("MIDDLE_SENTINEL");
    expect(renderedResult.slice(-600)).toBe(output.slice(-600));
  });

  test("collapses carriage-return progress updates into separate latest-status lines", () => {
    const running = state();
    const output = [
      "Cloning into '.'...\r\n",
      "remote: Counting objects: 94% (431234/458759)\r",
      "remote: Counting objects: 95% (435821/458759)\r",
      "remote: Counting objects: 100% (458759/458759), done.\n",
      "remote: Compressing objects: 36% (43662/119295)\r",
      "remote: Compressing objects: 37% (45277/119295)\r",
    ].join("");
    const tool = {
      id: "git-progress",
      title: "git clone",
      kind: "command",
      status: "running" as const,
      command: "git clone repository",
      output,
    };
    running.activities = [{ kind: "tool", id: tool.id, tool }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) =>
      item.tag === "collapsible_panel" && panelTitle(item).includes("git clone"));
    const content = String(((panel?.elements as Array<{ content?: string }> | undefined)?.[0]?.content) ?? "");

    expect(content).toContain("Cloning into '.'...\nremote: Counting objects: 100% (458759/458759), done.\nremote: Compressing objects: 37% (45277/119295)");
    expect(content).not.toContain("Counting objects: 94%");
    expect(content).not.toContain("Counting objects: 95%");
    expect(content).not.toContain("Compressing objects: 36%");
    expect(content).not.toContain("\r");
  });

  test("shows the active tool prominently and uses a completed header on completion", () => {
    const running = state();
    running.activeTool = { id: "active", title: "查看仓库", kind: "command", status: "running", command: "rg --files" };
    running.activities.push({ kind: "tool", id: "active", tool: running.activeTool });
    const runningCard = new CardRenderer().renderTurn(running);
    const runningPanel = collectObjects(runningCard).find((item) => panelTitle(item).includes("查看仓库"));
    expect(panelTitle(runningPanel ?? {})).toBe("⏳ 查看仓库");
    expect(runningPanel).toMatchObject({ border: { color: "grey", corner_radius: "5px" } });

    const completed = { ...state(), status: "completed" as const, completedAt: 4_000, durationMs: 3_000 };
    const completedCard = JSON.stringify(new CardRenderer().renderTurn(completed));
    expect(completedCard).toContain("已完成");
    expect(completedCard).not.toContain("turn_cancel");
  });

  test("uses the current status and prompt in every turn card header", () => {
    const completed = {
      ...state(),
      taskTitle: "任务标题不应出现在思考卡片中",
      prompt: "优化飞书交互体验",
      status: "completed" as const,
      completedAt: 4_000,
      durationMs: 3_000,
    };

    const card = new CardRenderer().renderTurn(completed) as {
      header: { title: { content: string } };
    };

    expect(card.header.title).toEqual({
      tag: "plain_text",
      content: "✅ 已完成：优化飞书交互体验",
    });
  });

  test.each([
    ["starting", "⏳ 正在处理"],
    ["running", "⏳ 正在处理"],
    ["tool_running", "⏳ 正在处理"],
    ["waiting_for_approval", "🙋 等待确认"],
    ["completed", "✅ 已完成"],
    ["failed", "❌ 执行失败"],
    ["cancelled", "⏹️ 已停止"],
  ] as const)("prefixes the %s turn title with its reaction emoji", (status, expectedTitle) => {
    const card = new CardRenderer().renderTurn({
      ...state(),
      prompt: undefined,
      taskTitle: undefined,
      status,
    }) as { header: { title: { content: string } } };

    expect(card.header.title.content).toBe(expectedTitle);
  });

  test("limits the prompt part of the turn title to 40 characters with three trailing dots", () => {
    const exact = new CardRenderer().renderTurn({
      ...state(),
      prompt: "问".repeat(40),
    }) as { header: { title: { content: string } } };
    const truncated = new CardRenderer().renderTurn({
      ...state(),
      prompt: `${"问".repeat(40)}🙂`,
    }) as { header: { title: { content: string } } };

    expect(exact.header.title.content).toBe(`⏳ 正在处理：${"问".repeat(40)}`);
    expect(truncated.header.title.content).toBe(`⏳ 正在处理：${"问".repeat(37)}...`);
  });

  test("keeps markup-like prompt text literal in a plain-text turn title", () => {
    const card = new CardRenderer().renderTurn({
      ...state(),
      prompt: "<at id=all></at> :DONE:",
    }) as { header: { title: { tag: string; content: string } } };

    expect(card.header.title).toEqual({
      tag: "plain_text",
      content: "⏳ 正在处理：<at id=all></at> :DONE:",
    });
  });

  test("renders approval controls with Card 2.0 callback behaviors", () => {
    const waiting = state();
    waiting.status = "waiting_for_approval";
    waiting.approval = {
      id: "approval_1",
      title: "允许运行命令？",
      command: "npm test",
      options: [
        { id: "accept", label: "允许" },
        { id: "cancel", label: "取消" },
      ],
    };

    const card = new CardRenderer().renderTurn(waiting);
    const objects = collectObjects(card);

    expect(card).toMatchObject({
      schema: "2.0",
      config: { width_mode: "fill" },
      body: { elements: expect.any(Array) },
    });
    expect(objects.some((item) => item.tag === "action")).toBe(false);
    expect(objects).toContainEqual(expect.objectContaining({
      tag: "column_set",
      flex_mode: "flow",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
    }));
    expect(objects).toContainEqual(expect.objectContaining({
      tag: "button",
      text: { tag: "plain_text", content: "Allow Once" },
      type: "primary",
      behaviors: [{
        type: "callback",
        value: {
          action: "approval",
          sessionId: "s1",
          turnId: "turn_1",
          requestId: "approval_1",
          decision: "accept",
        },
      }],
    }));
    expect(objects).toContainEqual(expect.objectContaining({
      tag: "button",
      text: { tag: "plain_text", content: "Cancel Task" },
      type: "danger",
    }));
  });

  test("renders a useful Card 2.0 placeholder before the first progress event", () => {
    const starting = state();
    starting.status = "starting";
    starting.progressText = undefined;
    starting.activeTool = undefined;
    starting.plan = [];
    starting.activities = [];
    starting.completedTools = [];
    starting.failedTools = [];
    starting.fileSummary = [];

    const card = new CardRenderer().renderTurn(starting) as {
      schema: string;
      body: { elements: Array<{ tag: string; content: string }> };
    };

    expect(card.schema).toBe("2.0");
    expect(card.body.elements[0]).toEqual({ tag: "markdown", content: "正在连接 Codex…" });
    expect(JSON.stringify(card.body.elements.at(-1))).toContain("<font color='grey'>52s</font>");
  });

  test("uses the current Agent label in empty progress states", () => {
    const starting = state();
    starting.agentLabel = "TraeX";
    starting.status = "starting";
    starting.progressText = undefined;
    starting.activeTool = undefined;
    starting.plan = [];
    starting.activities = [];
    starting.completedTools = [];
    starting.failedTools = [];
    starting.fileSummary = [];

    const card = new CardRenderer().renderTurn(starting) as {
      body: { elements: Array<{ tag: string; content: string }> };
    };

    expect(card.body.elements[0]).toEqual({ tag: "markdown", content: "正在连接 TraeX…" });
    expect(JSON.stringify(card.body.elements.at(-1))).toContain("<font color='grey'>52s</font>");

    starting.status = "running";
    const waitingCard = new CardRenderer().renderTurn(starting) as {
      body: { elements: Array<{ tag: string; content: string }> };
    };
    expect(waitingCard.body.elements[0]).toEqual({ tag: "markdown", content: "正在等待 TraeX 返回进度…" });
  });

  test("renders commentary assistant text as plain Markdown and keeps final-answer text out of progress cards", () => {
    const generating = state();
    generating.progressText = undefined;
    generating.activeTool = undefined;
    generating.plan = [];
    generating.activities = [{
      kind: "reasoning",
      id: "commentary:1",
      text: "正在组织回答",
    }];
    generating.completedTools = [];
    generating.failedTools = [];
    generating.fileSummary = [];
    generating.assistantText = "正在组织回答正文";

    const runningCard = new CardRenderer().renderTurn(generating) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(runningCard.body.elements[0]).toEqual({
      tag: "markdown",
      content: "正在组织回答",
    });
    expect(JSON.stringify(runningCard.body.elements)).toContain('"action":"turn_cancel"');

    generating.status = "completed";
    const completedCard = new CardRenderer().renderTurn(generating) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(completedCard.body.elements[0]).toEqual({
      tag: "markdown",
      content: "正在组织回答",
    });
    expect(JSON.stringify(completedCard.body.elements)).toContain('"action":"turn_reset"');
    expect(JSON.stringify(completedCard.body.elements)).not.toContain("正在组织回答正文");

    const detailsCard = new CardRenderer().renderTurnDetails(generating) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(detailsCard.body.elements).toEqual([
      { tag: "markdown", content: "正在组织回答" },
      { tag: "hr" },
      { tag: "markdown", content: "**回答**\n正在组织回答正文" },
    ]);
  });

  test("renders reasoning lines without Markdown bold styling", () => {
    const running = state();
    running.activities = [{
      kind: "reasoning",
      id: "reasoning:bold:0",
      text: "**规划实现步骤**\n继续 __检查测试__",
    }];

    const card = new CardRenderer().renderTurn(running);
    const reasoning = collectObjects(card).find(
      (item) => item.tag === "markdown" && String(item.content).startsWith("> 💭"),
    );

    expect(reasoning).toEqual({
      tag: "markdown",
      content: "> 💭 规划实现步骤\n> 继续 检查测试",
    });
    expect(String(reasoning?.content)).not.toContain("**");
    expect(String(reasoning?.content)).not.toContain("__");
  });

  test("merges consecutive reasoning entries while preserving activity boundaries", () => {
    const running = state();
    running.plan = [];
    running.fileSummary = [];
    const tool = { ...running.completedTools[0]!, id: "boundary-tool", title: "Boundary tool" };
    running.activities = [
      { kind: "reasoning", id: "reasoning:1", text: "第一段思考" },
      { kind: "reasoning", id: "reasoning:2", text: "第二段思考" },
      { kind: "tool", id: tool.id, tool },
      { kind: "reasoning", id: "reasoning:3", text: "第三段思考" },
      { kind: "reasoning", id: "reasoning:4", text: "第四段思考" },
      { kind: "assistant", id: "commentary:1", text: "Assistant text" },
      { kind: "reasoning", id: "reasoning:5", text: "第五段思考" },
    ];

    const renderer = new CardRenderer({ thinkingCardLayout: "timeline" });
    const card = renderer.renderTurn(running);
    const reasoning = collectObjects(card)
      .filter((item) => item.tag === "markdown" && String(item.content).startsWith("> 💭"))
      .map((item) => String(item.content));

    expect(reasoning).toEqual([
      "> 💭 第一段思考\n> 💭 第二段思考",
      "> 💭 第三段思考\n> 💭 第四段思考",
      "> 💭 第五段思考",
    ]);
    const serialized = JSON.stringify(card);
    expect(serialized.indexOf("第二段思考")).toBeLessThan(serialized.indexOf("Boundary tool"));
    expect(serialized.indexOf("Boundary tool")).toBeLessThan(serialized.indexOf("第三段思考"));
    expect(serialized.indexOf("第四段思考")).toBeLessThan(serialized.indexOf("Assistant text"));
    expect(serialized.indexOf("Assistant text")).toBeLessThan(serialized.indexOf("第五段思考"));

    const history = renderer.renderActivityHistory(running, 0);
    const historyReasoning = collectObjects(history)
      .filter((item) => item.tag === "markdown" && String(item.content).startsWith("> 💭"));
    expect(historyReasoning).toHaveLength(3);
  });

  test("renders steer messages inline and preserves their activity order", () => {
    const running = state();
    running.plan = [];
    running.fileSummary = [];
    running.activities = [
      { kind: "reasoning", id: "reasoning:1", text: "先检查代码" },
      { kind: "user", id: "steer:m1", text: "同时补充测试\n并检查结果" },
      { kind: "reasoning", id: "reasoning:2", text: "继续处理" },
    ];

    const renderer = new CardRenderer({ thinkingCardLayout: "timeline" });
    const card = renderer.renderTurn(running);
    const serialized = JSON.stringify(card);
    expect(collectObjects(card)).toContainEqual({
      tag: "markdown",
      content: "**🙋 同时补充测试**\n**并检查结果**",
    });
    expect(serialized).not.toContain("用户追加");
    expect(serialized.indexOf("先检查代码")).toBeLessThan(serialized.indexOf("同时补充测试"));
    expect(serialized.indexOf("同时补充测试")).toBeLessThan(serialized.indexOf("继续处理"));

    const history = renderer.renderActivityHistory(running, 0);
    expect(collectObjects(history)).toContainEqual({
      tag: "markdown",
      content: "**🙋 同时补充测试**\n**并检查结果**",
    });
  });

  test("shows an ellipsis before retained activities when older history was discarded", () => {
    const running = state();
    running.plan = [];
    running.activitiesTruncated = true;
    running.activities = [{ kind: "reasoning", id: "reasoning:recent", text: "最近的思考" }];

    const card = new CardRenderer().renderTurn(running) as {
      body: { elements: Array<Record<string, unknown>> };
    };

    expect(card.body.elements.slice(0, 2)).toEqual([
      { tag: "markdown", content: "…" },
      { tag: "markdown", content: "> 💭 最近的思考" },
    ]);
  });

  test("keeps the latest 40 mixed activities in the timeline compatibility layout", () => {
    const running = state();
    running.plan = [];
    running.fileSummary = [];
    running.activities = Array.from({ length: 45 }, (_value, index) => {
      const position = index + 1;
      if (position % 3 === 1) {
        return { kind: "assistant" as const, id: `commentary:${position}`, text: `Assistant ${position}` };
      }
      if (position % 3 === 2) {
        return {
          kind: "tool" as const,
          id: `tool:${position}`,
          tool: { ...running.completedTools[0]!, id: `tool:${position}`, title: `Tool ${position}` },
        };
      }
      return { kind: "reasoning" as const, id: `reasoning:${position}`, text: `Reasoning ${position}` };
    });

    const card = new CardRenderer({ thinkingCardLayout: "timeline" }).renderTurn(running);
    const serialized = JSON.stringify(card);

    expect(serialized).not.toContain("Tool 5");
    expect(serialized).toContain("Reasoning 6");
    expect(serialized).toContain("Assistant 7");
    expect(serialized).toContain("Tool 44");
    expect(serialized).toContain("Reasoning 45");
    expect(serialized).toContain("查看历史思考（共 2 页）");
    expect(serialized).toContain('"action":"activity_history"');
    const elements = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
    const historyLinkIndex = elements.findIndex((element) => element.tag === "column_set");
    const firstActivityIndex = elements.findIndex((element) => element.tag === "markdown");
    expect(historyLinkIndex).toBeGreaterThanOrEqual(0);
    expect(historyLinkIndex).toBeLessThan(firstActivityIndex);
  });

  test("paginates timeline activities from oldest to newest in 40-item pages", () => {
    const running = state();
    running.activities = Array.from({ length: 81 }, (_value, index) => ({
      kind: "assistant" as const,
      id: `commentary:${index + 1}`,
      text: index === 0 ? `FIRST-${"a".repeat(5_000)}` : index === 80 ? "LAST-81" : `Activity ${index + 1}`,
    }));
    const renderer = new CardRenderer({ thinkingCardLayout: "timeline" });
    const firstPage = JSON.stringify(renderer.renderActivityHistory(running, 0));
    const middlePage = JSON.stringify(renderer.renderActivityHistory(running, 1));
    const lastPage = JSON.stringify(renderer.renderActivityHistory(running, 2));

    expect(firstPage).toContain("思考活动历史 · 1/3");
    expect(firstPage).toContain("FIRST-");
    expect(firstPage).not.toContain("Activity 2");
    expect(firstPage).toContain("下一页");
    expect(firstPage).toContain("最新页");
    expect(middlePage).toContain("Activity 2");
    expect(middlePage).toContain("Activity 41");
    expect(middlePage).not.toContain("Activity 42");
    expect(middlePage).not.toContain("下一页");
    expect(middlePage).toContain('"page":"latest"');
    expect(lastPage).toContain("思考活动历史 · 3/3");
    expect(lastPage).toContain("Activity 42");
    expect(lastPage).toContain("LAST-81");
    expect(lastPage).toContain("上一页");
    expect(lastPage).toContain("最新页");

    const firstPageElements = (renderer.renderActivityHistory(running, 0) as {
      body: { elements: Array<Record<string, unknown>> };
    }).body.elements;
    expect(firstPageElements[0]?.tag).toBe("column_set");
    expect(firstPageElements[1]?.tag).toBe("hr");
    expect(firstPageElements[2]?.tag).toBe("markdown");
    const firstPageLabels = collectObjects(renderer.renderActivityHistory(running, 0))
      .filter((item) => item.tag === "interactive_container")
      .map((item) => JSON.stringify(item));
    expect(firstPageLabels[0]).toContain("最新页");
    expect(firstPageLabels[1]).toContain("下一页");

    const lastPageLabels = collectObjects(renderer.renderActivityHistory(running, 2))
      .filter((item) => item.tag === "interactive_container")
      .map((item) => JSON.stringify(item));
    expect(lastPageLabels[0]).toContain("最新页");
    expect(lastPageLabels[1]).toContain("上一页");
  });

  test("renders task actions as colored callback links below the body", () => {
    const card = new CardRenderer().renderTaskListCard("Codex 任务", "任务", [{
      lines: ["**Task**", "就绪"],
      actions: [
        {
          text: "Switch",
          value: { action: "session_switch", sessionId: "thr_1" },
        },
        {
          text: "Status",
          value: { action: "session_status", sessionId: "thr_1" },
        },
      ],
    }], ["说明"]);
    const objects = collectObjects(card);
    const links = objects.filter((item) => item.tag === "interactive_container");

    expect(links).toContainEqual(expect.objectContaining({
      margin: "0px",
      padding: "0px",
      has_border: false,
      elements: [{
        tag: "markdown",
        content: "<font color='blue'>Switch</font>",
      }],
      behaviors: [{
        type: "callback",
        value: { action: "session_switch", sessionId: "thr_1" },
      }],
    }));
    expect(links).toContainEqual(expect.objectContaining({
      elements: [{
        tag: "markdown",
        content: "<font color='blue'>Status</font>",
      }],
      behaviors: [{
        type: "callback",
        value: { action: "session_status", sessionId: "thr_1" },
      }],
    }));
    expect(card).toMatchObject({
      schema: "2.0",
      config: { width_mode: "fill" },
      body: { elements: expect.any(Array) },
    });
    expect(objects).toContainEqual(expect.objectContaining({
      tag: "column_set",
      flex_mode: "flow",
      horizontal_spacing: "8px",
      margin: "2px 0 0 0",
    }));
    expect(objects.filter((item) => item.tag === "column")).toHaveLength(2);
    expect(objects.filter((item) => item.tag === "column")).toEqual(expect.arrayContaining([expect.objectContaining({
      tag: "column",
      width: "auto",
    })]));

    const bodyElements = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
    const taskBodyIndex = bodyElements.findIndex((item) => item.tag === "markdown" && item.content === "**Task**\n就绪");
    const actionRowIndex = bodyElements.findIndex((item) => item.tag === "column_set");
    expect(actionRowIndex).toBe(taskBodyIndex + 1);
  });

  test("renders compact clickable directory rows without per-directory creation actions", () => {
    const card = new CardRenderer().renderDirectoryBrowserCard({
      directory: "D:\\dev\\agent-bot",
      entries: [
        {
          name: "..",
          kind: "directory",
          openAction: {
            text: "..",
            value: { action: "directory_open", directory: "D:\\dev" },
          },
        },
        {
          name: "src",
          kind: "directory",
          openAction: {
            text: "src",
            value: { action: "directory_open", directory: "D:\\dev\\agent-bot\\src" },
          },
        },
        {
          name: "Windows (C:)",
          kind: "drive",
          openAction: {
            text: "Windows (C:)",
            value: { action: "directory_open", directory: "C:\\" },
          },
        },
        {
          name: "README.md",
          kind: "file",
          openAction: {
            text: "README.md",
            value: { action: "directory_send_file", filePath: "D:\\dev\\agent-bot\\README.md" },
          },
        },
        {
          name: "logo.png",
          kind: "image",
          openAction: {
            text: "logo.png",
            value: { action: "directory_send_file", filePath: "D:\\dev\\agent-bot\\logo.png" },
          },
        },
        {
          name: "agentbot.exe",
          kind: "binary",
          openAction: {
            text: "agentbot.exe",
            value: { action: "directory_send_file", filePath: "D:\\dev\\agent-bot\\agentbot.exe" },
          },
        },
      ],
      currentActions: [
        { text: "NewFolder", value: { action: "directory_new_folder_prompt", directory: "D:\\dev\\agent-bot" } },
        { text: "NewTask", value: { action: "directory_new", directory: "D:\\dev\\agent-bot" } },
        { text: "NewGroupTask", value: { action: "directory_new_group", directory: "D:\\dev\\agent-bot" } },
      ],
      navigationActions: [],
      footerLines: ["第 1/1 页 · 1 个目录 · 1 个文件"],
    });
    const objects = collectObjects(card);
    const directoryRow = objects.find((item) =>
      item.tag === "column_set"
      && item.flex_mode === "none"
      && JSON.stringify(item).includes("📁 src"));
    const fileRow = objects.find((item) =>
      item.tag === "column_set"
      && item.flex_mode === "none"
      && JSON.stringify(item).includes("📄 README.md"));
    const creationRow = objects.find((item) =>
      item.tag === "column_set"
      && JSON.stringify(item).includes("NewFolder")
      && JSON.stringify(item).includes("NewGroupTask"));

    expect(card).toMatchObject({ header: { title: { content: "文件浏览" } } });
    expect(card).toMatchObject({ body: { vertical_spacing: "2px" } });
    expect(JSON.stringify(card)).toContain("**当前目录**：`D:\\\\dev\\\\agent-bot`");
    expect(JSON.stringify(card)).toContain("📁 ..");
    expect(JSON.stringify(card)).not.toContain("Parent");
    expect(directoryRow).toMatchObject({
      margin: "0px",
      columns: [expect.objectContaining({ width: "weighted" })],
    });
    expect(JSON.stringify(directoryRow)).toContain('"action":"directory_open"');
    expect(JSON.stringify(directoryRow)).not.toContain('"action":"directory_new"');
    expect(JSON.stringify(directoryRow)).not.toContain('"action":"directory_new_group"');
    expect(fileRow).toMatchObject({ columns: [expect.objectContaining({ width: "weighted" })] });
    expect(JSON.stringify(fileRow)).toContain('"action":"directory_send_file"');
    expect(JSON.stringify(card)).toContain("🖼️ logo.png");
    expect(JSON.stringify(card)).toContain("📦 agentbot.exe");
    expect(JSON.stringify(card)).toContain("💽 Windows (C:)");
    expect(JSON.stringify(card)).toContain("NewFolder");
    expect(JSON.stringify(card)).toContain("NewTask");
    expect(JSON.stringify(card)).toContain("NewGroupTask");
    expect(JSON.stringify(card)).toContain('"action":"directory_new_folder_prompt"');
    expect(creationRow).toMatchObject({
      columns: [
        expect.any(Object),
        { elements: [{ content: "<font color='grey'>·</font>" }] },
        expect.any(Object),
        { elements: [{ content: "<font color='grey'>·</font>" }] },
        expect.any(Object),
      ],
    });
    const browserRows = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements.filter((item) =>
      item.tag === "column_set"
      && item.flex_mode === "none"
      && item.horizontal_spacing === "12px"
      && item.margin === "0px");
    expect(browserRows).toHaveLength(16);
    expect(browserRows.at(-1)).toMatchObject({
      columns: [{ elements: [{ tag: "markdown", content: "\u00a0" }] }],
    });
  });

  test("renders a required new-folder form with English actions", () => {
    const card = new CardRenderer().renderDirectoryNewFolderCard({
      directory: "C:\\Users\\Admin\\work",
      displayDirectory: "~\\work",
      contextKey: "chat_id:c1",
      page: 2,
    });
    const objects = collectObjects(card);
    const input = objects.find((item) => item.tag === "input");
    const create = objects.find((item) => item.tag === "button" && item.action_type === "form_submit");

    expect(card).toMatchObject({
      config: { width_mode: "compact" },
      header: { title: { content: "新建目录" } },
    });
    expect(JSON.stringify(card)).toContain("`~\\\\work`");
    expect(input).toMatchObject({ name: "folderName", required: true, max_length: 255 });
    expect(create).toMatchObject({
      text: { content: "Create" },
      value: {
        action: "directory_new_folder_submit",
        directory: "C:\\Users\\Admin\\work",
        contextKey: "chat_id:c1",
        page: "2",
      },
    });
    expect(JSON.stringify(card)).toContain("Back");
    expect(JSON.stringify(card)).toContain('"action":"directory_new_folder_cancel"');
  });

  test("renders status card actions as callback links after the sections", () => {
    const card = new CardRenderer().renderSectionsCard("Codex 状态", [
      {
        title: "指定任务",
        lines: ["空闲"],
      },
      {
        title: "执行详情",
        lines: ["最近步骤"],
        collapsible: true,
        elementId: "status_execution_details",
      },
    ], [{
      text: "Switch",
      value: { action: "session_switch", sessionId: "thr_1", cardView: "status" },
    }]);
    const bodyElements = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;

    expect(collectObjects(card)).toContainEqual(expect.objectContaining({
      tag: "collapsible_panel",
      element_id: "status_execution_details",
      expanded: false,
      header: expect.objectContaining({
        title: { tag: "plain_text", content: "执行详情" },
      }),
    }));
    expect(bodyElements.at(-1)).toMatchObject({
      tag: "column_set",
      columns: [expect.objectContaining({
        elements: [expect.objectContaining({
          tag: "interactive_container",
          elements: [{ tag: "markdown", content: "<font color='blue'>Switch</font>" }],
          behaviors: [{
            type: "callback",
            value: { action: "session_switch", sessionId: "thr_1", cardView: "status" },
          }],
        })],
      })],
    });
    expect(bodyElements.at(-2)).toEqual({ tag: "hr" });
  });

  test("renders each help command as a callback control beside its description", () => {
    const card = new CardRenderer().renderHelpCard(
      "Agent Bot 使用帮助",
      ["点击命令按钮执行默认命令。"],
      [{
        title: "任务管理",
        commands: [
          {
            text: "/sessions",
            action: {
              text: "/sessions",
              value: { action: "help_command", command: "/sessions", contextKey: "chat_id:c1" },
            },
            usage: "[关键词]",
            description: "查找本机任务",
          },
          {
            text: "/turns",
            action: {
              text: "/turns",
              value: { action: "help_command", command: "/turns", contextKey: "chat_id:c1" },
            },
            description: "浏览历史轮次",
          },
          {
            text: "/title",
            usage: "&#60;新标题&#62;",
            description: "修改当前任务标题",
          },
        ],
      }],
    );
    const objects = collectObjects(card);
    const controls = objects.filter((item) => item.tag === "interactive_container");

    expect(controls).toHaveLength(2);
    expect(controls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        elements: [{ tag: "markdown", content: "<font color='blue'>/sessions</font>" }],
        behaviors: [{
          type: "callback",
          value: { action: "help_command", command: "/sessions", contextKey: "chat_id:c1" },
        }],
      }),
      expect.objectContaining({
        elements: [{ tag: "markdown", content: "<font color='blue'>/turns</font>" }],
      }),
    ]));
    expect(objects).toContainEqual(expect.objectContaining({
      tag: "markdown",
      content: "**[关键词]**　查找本机任务",
    }));
    expect(objects).toContainEqual(expect.objectContaining({
      tag: "markdown",
      content: "**/title**",
    }));
    expect(objects.filter((item) => item.tag === "column_set" && item.flex_mode === "none")).toHaveLength(3);
  });

  test("renders destructive task actions as red callback links", () => {
    const card = new CardRenderer().renderTaskListCard("Codex 任务", "任务", [{
      lines: ["**Task**"],
      actions: [{
        text: "Stop",
        type: "danger",
        value: { action: "session_stop", sessionId: "thr_1" },
      }],
    }], []);

    expect(collectObjects(card)).toContainEqual(expect.objectContaining({
      tag: "interactive_container",
      elements: [{
        tag: "markdown",
        content: "<font color='red'>Stop</font>",
      }],
      behaviors: [{
        type: "callback",
        value: { action: "session_stop", sessionId: "thr_1" },
      }],
    }));
  });

  test("allows the current task to render without an action control", () => {
    const card = new CardRenderer().renderTaskListCard("Codex 任务", "任务", [{
      lines: ["✅ **Current task**", "执行中"],
    }], []);

    expect(collectObjects(card).some((item) => item.tag === "button" || item.tag === "interactive_container")).toBe(false);
  });

  test("renders compact Previous and Next actions for task pagination", () => {
    const card = new CardRenderer().renderTaskListCard("Codex 任务", "任务", [], [
      "第 2 页",
      "",
      "> **Next** 查看下一页。",
    ], [
      { text: "Previous", value: { action: "session_page", page: "0" } },
      { text: "Next", value: { action: "session_page", page: "2" } },
    ]);
    const serialized = JSON.stringify(card);
    const bodyElements = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
    const paginationIndex = bodyElements.findIndex((item) => JSON.stringify(item).includes('"action":"session_page"'));
    const footerIndex = bodyElements.findIndex((item) => item.tag === "markdown" && item.content === [
      "第 2 页",
      "",
      "> **Next** 查看下一页。",
    ].join("\n"));

    expect(serialized).toContain("<font color='blue'>Previous</font>");
    expect(serialized).toContain('"action":"session_page","page":"0"');
    expect(serialized).toContain("<font color='blue'>Next</font>");
    expect(serialized).toContain('"action":"session_page","page":"2"');
    expect(serialized).not.toContain('"tag":"button"');
    expect(paginationIndex).toBeGreaterThan(-1);
    expect(footerIndex).toBeGreaterThan(paginationIndex);
    expect(bodyElements.at(-1)).toMatchObject({
      tag: "markdown",
      content: "第 2 页\n\n> **Next** 查看下一页。",
    });
  });

  test("renders project-grouped sessions as compact collapsed task rows", () => {
    const card = new CardRenderer().renderSessionTaskListCard("任务列表", "任务", [{
      title: "📁 D:\\work\\agent-bot",
      actions: [
        { text: "New", value: { action: "session_new", sessionId: "thr_1" } },
        { text: "NewGroup", value: { action: "session_new_group", sessionId: "thr_1" } },
      ],
      entries: [{
        reference: "agent-runtime:codex:thr_1",
        summary: "1. ✅ Improve sessions · codex",
        detailLines: [
          "**最新 Prompt**：优化任务列表",
          "<font color='grey'>最近更新：刚刚</font>",
        ],
        actions: [{ text: "Status", value: { action: "session_status", sessionId: "thr_1" } }],
        current: true,
      }],
    }], ["> 点击任务行展开详情与操作。"]);
    const objects = collectObjects(card);
    const panel = objects.find((item) => item.tag === "collapsible_panel");
    const projectRow = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements
      .find((item) => JSON.stringify(item).includes("📁 D:&#92;work&#92;agent-bot"));

    expect(JSON.stringify(card)).toContain("📁 D:&#92;work&#92;agent-bot");
    expect(projectRow).toMatchObject({ tag: "column_set", flex_mode: "none" });
    expect(JSON.stringify(projectRow)).toContain("session_new_group");
    expect(JSON.stringify(projectRow)).toContain("thr_1");
    expect(JSON.stringify(projectRow)).toContain(
      '"tag":"overflow","options":[{"text":{"tag":"plain_text","content":"New"}',
    );
    expect(panel).toMatchObject({
      tag: "collapsible_panel",
      expanded: false,
      vertical_spacing: "2px",
      padding: "4px 6px",
      header: {
        title: { tag: "plain_text", content: "1. ✅ Improve sessions · codex" },
        padding: "2px 4px 2px 4px",
      },
      border: { color: "green" },
    });
    expect(JSON.stringify(panel)).toContain("最新 Prompt");
    expect(JSON.stringify(panel)).toContain("优化任务列表");
    expect(JSON.stringify(panel)).not.toContain("最后一个用户 Prompt");
    expect(JSON.stringify(panel)).toContain("<font color='grey'>最近更新：刚刚</font>");
    expect(JSON.stringify(panel)).not.toContain("**更新时间**");
    expect(JSON.stringify(panel)).not.toContain("任务 ID");
    expect(JSON.stringify(panel)).not.toContain("目录");
    expect(JSON.stringify(panel)).toContain('"tag":"overflow"');
    expect(JSON.stringify(panel)).toContain('"content":"Status"');
    expect(JSON.stringify(panel)).toContain('session_status');
    expect(JSON.stringify(panel)).toContain('thr_1');
    expect(JSON.stringify(panel)).not.toContain('"action":"session_new"');
    expect(JSON.stringify(panel)).not.toContain('"tag":"interactive_container"');
    expect((card as { body: { elements: Array<Record<string, unknown>> } }).body.elements)
      .not.toContainEqual(expect.objectContaining({ tag: "hr" }));
  });

  test("keeps a ten-project sessions page within Feishu card limits", () => {
    const groups = Array.from({ length: 10 }, (_, index) => ({
      title: `📁 D:\\work\\organization\\project-${index + 1}`,
      actions: [
        { text: "New", value: { t: `project-new-${index + 1}` } },
        { text: "NewGroup", value: { t: `project-group-${index + 1}` } },
      ],
      entries: [{
        reference: `agent-runtime:codex:thr_${index + 1}`,
        summary: `${index + 1}. Task ${index + 1} · codex`,
        detailLines: [
          `**最新 Prompt**：Review project ${index + 1} ${"x".repeat(50)}`,
          "<font color='grey'>最近更新：2026/08/15 10:00:00</font>",
        ],
        actions: [
          { text: "Switch", value: { t: `switch-${index + 1}` } },
          { text: "Fork", value: { t: `fork-${index + 1}` } },
          { text: "ForkGroup", value: { t: `fork-group-${index + 1}` } },
          { text: "Status", value: { t: `status-${index + 1}` } },
          { text: "Archive", value: { t: `archive-${index + 1}` } },
        ],
      }],
    }));
    const card = new CardRenderer().renderSessionTaskListCard(
      "任务列表",
      "任务",
      groups,
      ["第 2 页 · 每页 10 个任务"],
      [
        { text: "Previous", value: { t: "previous" } },
        { text: "Next", value: { t: "next" } },
      ],
    );
    const taggedElements = collectObjects(card).filter((item) => typeof item.tag === "string");
    const serialized = JSON.stringify(card);

    expect(taggedElements.filter((item) => item.tag === "collapsible_panel")).toHaveLength(10);
    expect(taggedElements.filter((item) => item.tag === "overflow")).toHaveLength(20);
    expect(taggedElements.length).toBeLessThan(200);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(30 * 1024);
  });

  test("renders a compact Chinese group-dismiss confirmation with equal action buttons", () => {
    const card = new CardRenderer().renderDismissGroupConfirmation({
      contextKey: "chat_id:oc_group",
      sessionId: "session_1",
      taskTitle: "修复登录流程",
      requestedBy: "ou_owner",
    });
    const objects = collectObjects(card);
    const buttonLabels = objects
      .filter((item) => item.tag === "button")
      .map((item) => (item.text as { content?: string } | undefined)?.content);
    const actionValues = objects
      .filter((item) => item.type === "callback")
      .map((item) => item.value);

    expect(card).toMatchObject({
      schema: "2.0",
      config: { width_mode: "compact", update_multi: true },
      header: { title: { content: "解散当前群聊" } },
    });
    expect(JSON.stringify(card)).toContain("当前任务「修复登录流程」将同时归档");
    expect(buttonLabels).toEqual(["Dismiss", "Keep"]);
    expect(actionValues).toContainEqual({
      action: "group_dismiss_confirm",
      contextKey: "chat_id:oc_group",
      sessionId: "session_1",
      requestedBy: "ou_owner",
    });
    expect(actionValues).toContainEqual(expect.objectContaining({ action: "group_dismiss_keep" }));
    const buttonRow = objects.find((item) => (
      item.tag === "column_set" && JSON.stringify(item).includes("group_dismiss_confirm")
    ));
    expect(buttonRow).toMatchObject({
      flex_mode: "none",
      columns: [
        { width: "weighted", weight: 1 },
        { width: "weighted", weight: 1 },
      ],
    });
  });
});

function panelTitle(panel: Record<string, unknown>): string {
  const header = panel.header as { title?: { content?: string } } | undefined;
  return header?.title?.content ?? "";
}
