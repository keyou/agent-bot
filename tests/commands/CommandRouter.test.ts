import { describe, expect, test } from "vitest";
import { CommandRouter } from "../../src/commands/CommandRouter.js";

describe("CommandRouter", () => {
  const router = new CommandRouter();

  test("parses local shell commands before prompt routing", () => {
    expect(router.parse("! ls")).toEqual({ type: "shell", command: "ls" });
    expect(router.parse("！git status")).toEqual({ type: "shell", command: "git status" });
    expect(router.parse("  ! Get-ChildItem | Select-Object -First 5  ")).toEqual({
      type: "shell",
      command: "Get-ChildItem | Select-Object -First 5",
    });
    expect(() => router.parse("!")).toThrow("请输入要执行的命令");
    expect(() => router.parse("！")).toThrow("请输入要执行的命令");
  });

  test("opens execution setting cards and rejects command arguments", () => {
    expect(router.parse("/provider")).toEqual({ type: "provider" });
    expect(router.parse("/model")).toEqual({ type: "model" });
    expect(router.parse("/thinking")).toEqual({ type: "thinking" });
    expect(router.parse("/permissions")).toEqual({ type: "permissions" });
    expect(() => router.parse("/provider azure gpt-next xhigh confirm")).toThrow("不接受参数");
    expect(() => router.parse("/model gpt-test")).toThrow("不接受参数");
    expect(() => router.parse("/thinking high")).toThrow("不接受参数");
    expect(() => router.parse("/permissions confirm")).toThrow("不接受参数");
  });

  test("parses safe and forced restart commands", () => {
    expect(router.parse("/restart")).toEqual({ type: "restart" });
    expect(router.parse("/restart --force")).toEqual({ type: "restart", force: true });
    expect(() => router.parse("/restart --immediate")).toThrow("只接受一个可选的 --force 参数");
    expect(() => router.parse("/restart --force extra")).toThrow("只接受一个可选的 --force 参数");
  });

  test("parses App Server release commands", () => {
    expect(router.parse("/release")).toEqual({ type: "release" });
    expect(router.parse("/rel")).toEqual({ type: "release" });
    expect(() => router.parse("/release now")).toThrow("不接受参数");
  });

  test("parses group mute commands", () => {
    expect(router.parse("/mute")).toEqual({ type: "mute", enabled: true });
    expect(router.parse("/mute on")).toEqual({ type: "mute", enabled: true });
    expect(router.parse("/mute ON")).toEqual({ type: "mute", enabled: true });
    expect(router.parse("/mute off")).toEqual({ type: "mute", enabled: false });
    expect(() => router.parse("/mute toggle")).toThrow("只接受 on 或 off");
    expect(() => router.parse("/mute on extra")).toThrow("只接受 on 或 off");
  });

  test("opens the turn history card without accepting arguments", () => {
    expect(router.parse("/turns")).toEqual({ type: "turns" });
    expect(() => router.parse("/turns turn_1")).toThrow("不接受参数");
  });

  test("opens the directory browser at the current or specified directory", () => {
    expect(router.parse("/dir")).toEqual({ type: "dir", directory: undefined });
    expect(router.parse('/dir "D:\\work space\\repo"')).toEqual({
      type: "dir",
      directory: "D:\\work space\\repo",
    });
    expect(router.parse("/dir ~/dev/project")).toEqual({
      type: "dir",
      directory: "~/dev/project",
    });
    expect(router.parse("/dir D:\\work space\\repo")).toEqual({
      type: "dir",
      directory: "D:\\work space\\repo",
    });
  });

  test("parses relative, absolute, and home-relative file paths", () => {
    expect(router.parse("/file report.txt")).toEqual({ type: "file", filePath: "report.txt" });
    expect(router.parse('/file "D:\\work space\\report.pdf"')).toEqual({
      type: "file",
      filePath: "D:\\work space\\report.pdf",
    });
    expect(router.parse("/file D:\\work space\\report.pdf")).toEqual({
      type: "file",
      filePath: "D:\\work space\\report.pdf",
    });
    expect(router.parse("/file ~/reports/latest.txt")).toEqual({
      type: "file",
      filePath: "~/reports/latest.txt",
    });
    expect(() => router.parse("/file")).toThrow("请输入文件路径");
  });

  test("parses current and specified task status", () => {
    expect(router.parse("/status")).toEqual({ type: "status" });
    expect(router.parse("/status sess_1")).toEqual({ type: "status", sessionId: "sess_1" });
  });

  test("parses archive with an optional task reference", () => {
    expect(router.parse("/archive")).toEqual({ type: "archive" });
    expect(router.parse("/archive 2")).toEqual({ type: "archive", sessionId: "2" });
    expect(router.parse("/archive 019f-thread")).toEqual({ type: "archive", sessionId: "019f-thread" });
    expect(() => router.parse("/archive 1 extra")).toThrow("只接受一个");
    expect(() => router.parse("/archive --force")).toThrow("不支持参数");
  });

  test("opens dismiss confirmation without accepting arguments", () => {
    expect(router.parse("/dismiss")).toEqual({ type: "dismiss" });
    expect(() => router.parse("/dismiss --force")).toThrow("不接受参数");
  });

  test("parses goal lifecycle commands", () => {
    expect(router.parse("/goal")).toEqual({ type: "goal", action: "show" });
    expect(router.parse("/goal 完成迁移并通过全部测试")).toEqual({
      type: "goal",
      action: "set",
      objective: "完成迁移并通过全部测试",
    });
    expect(router.parse('/goal edit "完成新的迁移"')).toEqual({
      type: "goal",
      action: "edit",
      objective: "完成新的迁移",
    });
    expect(router.parse("/goal pause")).toEqual({ type: "goal", action: "pause" });
    expect(router.parse("/goal resume")).toEqual({ type: "goal", action: "resume" });
    expect(router.parse("/goal clear")).toEqual({ type: "goal", action: "clear" });
    expect(() => router.parse("/goal edit")).toThrow("修改后的 Goal");
    expect(() => router.parse("/goal pause now")).toThrow("不接受额外参数");
  });

  test("creates new tasks with a title and an optional --dir working directory", () => {
    expect(router.parse("/new")).toEqual({ type: "new", title: undefined, cwd: undefined });
    expect(router.parse("/new 修复会话列表时间")).toEqual({
      type: "new",
      title: "修复会话列表时间",
      cwd: undefined,
    });
    expect(router.parse('/new "修复 会话列表" --dir "D:\\work space\\repo"')).toEqual({
      type: "new",
      title: "修复 会话列表",
      cwd: "D:\\work space\\repo",
    });
    expect(router.parse('/new --dir "D:\\work space\\repo" 修复会话列表')).toEqual({
      type: "new",
      title: "修复会话列表",
      cwd: "D:\\work space\\repo",
    });
    expect(router.parse('/new --dir "D:\\work space\\repo"')).toEqual({
      type: "new",
      title: undefined,
      cwd: "D:\\work space\\repo",
    });
    expect(() => router.parse("/new title --dir")).toThrow("--dir 后指定工作目录");
    expect(() => router.parse("/new --dir D:\\work --dir D:\\other")).toThrow("只能指定一次");
  });

  test("parses --nodir for a forced projectless task and rejects directory conflicts", () => {
    expect(router.parse("/new --nodir")).toEqual({
      type: "new",
      title: undefined,
      cwd: undefined,
      projectless: true,
    });
    expect(router.parse("/new Projectless task --nodir")).toEqual({
      type: "new",
      title: "Projectless task",
      cwd: undefined,
      projectless: true,
    });
    expect(router.parse("/new --nodir Projectless task")).toEqual({
      type: "new",
      title: "Projectless task",
      cwd: undefined,
      projectless: true,
    });
    expect(() => router.parse("/new --nodir --dir D:\\work")).toThrow("--dir 和 --nodir 不能同时使用");
    expect(() => router.parse("/new --dir D:\\work --nodir")).toThrow("--dir 和 --nodir 不能同时使用");
    expect(() => router.parse("/new --nodir --nodir")).toThrow("只能指定一次 --nodir");
  });

  test("creates a new group with an optional title and project directory", () => {
    expect(router.parse("/newgroup")).toEqual({
      type: "newgroup",
      title: undefined,
    });
    expect(router.parse("/newgroup 广州天气")).toEqual({
      type: "newgroup",
      title: "广州天气",
    });
    expect(router.parse('/newgroup "广州 天气"')).toEqual({
      type: "newgroup",
      title: "广州 天气",
    });
    expect(router.parse('/newgroup "广州 天气" --dir "~/dev/lark bot"')).toEqual({
      type: "newgroup",
      title: "广州 天气",
      cwd: "~/dev/lark bot",
    });
    expect(router.parse('/newgroup --dir "~\\dev\\agent-bot" 广州天气')).toEqual({
      type: "newgroup",
      title: "广州天气",
      cwd: "~\\dev\\agent-bot",
    });
    expect(router.parse("/newgroup --nodir")).toEqual({
      type: "newgroup",
      title: undefined,
      projectless: true,
    });
    expect(router.parse("/newgroup Projectless room --nodir")).toEqual({
      type: "newgroup",
      title: "Projectless room",
      projectless: true,
    });
    expect(() => router.parse("/newgroup 广州天气 --dir")).toThrow("--dir 后指定项目目录");
    expect(() => router.parse("/newgroup --dir D:\\work --dir D:\\other")).toThrow("只能指定一次");
    expect(() => router.parse("/newgroup --nodir --dir D:\\work")).toThrow("--dir 和 --nodir 不能同时使用");
    expect(() => router.parse("/newgroup --dir D:\\work --nodir")).toThrow("--dir 和 --nodir 不能同时使用");
    expect(() => router.parse("/newgroup --nodir --nodir")).toThrow("只能指定一次 --nodir");
  });

  test("parses fork with an optional session reference", () => {
    expect(router.parse("/fork")).toEqual({ type: "fork" });
    expect(router.parse("/fork 2")).toEqual({ type: "fork", sessionId: "2" });
    expect(router.parse("/fork 019f-thread")).toEqual({ type: "fork", sessionId: "019f-thread" });
    expect(() => router.parse("/fork 1 extra")).toThrow("只接受一个");
    expect(() => router.parse("/fork --exclude-turns")).toThrow("不支持参数");
    expect(() => router.parse("/fork --unknown")).toThrow("不支持参数");
  });

  test("parses forkgroup with an optional title", () => {
    expect(router.parse("/forkgroup")).toEqual({ type: "forkgroup", title: undefined });
    expect(router.parse("/forkgroup 并行修复")).toEqual({ type: "forkgroup", title: "并行修复" });
    expect(router.parse('/forkgroup "Parallel fix"')).toEqual({ type: "forkgroup", title: "Parallel fix" });
    expect(() => router.parse("/forkgroup --exclude-turns")).toThrow("不支持参数");
    expect(() => router.parse("/forkgroup --unknown")).toThrow("不支持参数");
  });

  test("parses newgroup session mode with an optional title", () => {
    expect(router.parse("/newgroup --session 019f-thread")).toEqual({
      type: "newgroup",
      sessionId: "019f-thread",
      title: undefined,
    });
    expect(router.parse('/newgroup "Existing task" --session codex://threads/019f-thread')).toEqual({
      type: "newgroup",
      sessionId: "codex://threads/019f-thread",
      title: "Existing task",
    });
    expect(router.parse("/newgroup --session 019f-thread --agent traex")).toEqual({
      type: "newgroup",
      sessionId: "019f-thread",
      agentName: "traex",
      title: undefined,
    });
    expect(() => router.parse("/newgroup --session")).toThrow("--session 后指定 App Server Session ID");
    expect(() => router.parse("/newgroup --session 019f-thread --session other")).toThrow("只能指定一次 --session");
    expect(() => router.parse("/newgroup --session 019f-thread --move")).toThrow("不支持参数：--move");
    expect(() => router.parse("/newgroup --session 019f-thread --dir ~/project")).toThrow("不能和 --dir 或 --nodir");
    expect(() => router.parse("/newgroup --session 019f-thread --nodir")).toThrow("不能和 --dir 或 --nodir");
    expect(() => router.parse("/newgroup --agent traex")).toThrow("只能和 --session 一起使用");
    expect(() => router.parse("/newgroup --session 019f-thread --agent")).toThrow("--agent 后指定 Agent 标准名");
    expect(() => router.parse("/attachgroup 019f-thread")).toThrow("未知命令：/attachgroup");
  });

  test("parses a title containing spaces", () => {
    expect(router.parse("/title 修复会话列表时间")).toEqual({ type: "title", title: "修复会话列表时间" });
    expect(router.parse('/title "Fix session title"')).toEqual({ type: "title", title: "Fix session title" });
    expect(() => router.parse("/title")).toThrow("请输入新标题");
  });

  test("parses stop without a cancel compatibility alias", () => {
    expect(router.parse("/stop")).toEqual({ type: "stop" });
    expect(() => router.parse("/cancel")).toThrow("未知命令：/cancel");
  });

  test("parses a no-steer queued prompt", () => {
    const expected = {
      type: "nosteer",
      text: "完成后再运行全部测试",
    };
    expect(router.parse("/queue 完成后再运行全部测试")).toEqual(expected);
    expect(router.parse("/nosteer 完成后再运行全部测试")).toEqual(expected);
    expect(() => router.parse("/queue")).toThrow("请输入要排队的 Prompt");
    expect(() => router.parse("/nosteer")).toThrow("请输入要排队的 Prompt");
  });

  test("does not retain removed commands", () => {
    expect(() => router.parse("/attach 019f-thread")).toThrow("未知命令：/attach");
    expect(() => router.parse("/agents")).toThrow("未知命令：/agents");
    expect(() => router.parse("/ask explain this")).toThrow("未知命令：/ask");
    expect(() => router.parse("/detach")).toThrow("未知命令：/detach");
    expect(() => router.parse("/close")).toThrow("未知命令：/close");
    expect(() => router.parse("/mode plan")).toThrow("未知命令：/mode");
    expect(() => router.parse("/modes")).toThrow("未知命令：/modes");
    expect(() => router.parse("/reset")).toThrow("未知命令：/reset");
    expect(() => router.parse("/use codex D:\\dev\\project")).toThrow("未知命令：/use");
  });

  test("rejects unknown slash commands instead of routing them as prompts", () => {
    expect(() => router.parse("/does-not-exist hello")).toThrow(
      "未知命令：/does-not-exist。发送 /help 查看可用命令。",
    );
    expect(() => router.parse("   /UNKNOWN")).toThrow("未知命令：/UNKNOWN");
    expect(() => router.parse("/")).toThrow("未知命令：/");
  });

  test("resolves unique command prefixes and preserves their arguments", () => {
    expect(router.parse("/sess desktop task")).toEqual({
      type: "sessions",
      searchTerm: "desktop task",
    });
    expect(router.parse("/forkg 并行修复")).toEqual({
      type: "forkgroup",
      title: "并行修复",
    });
    expect(router.parse("/fg 并行修复")).toEqual({
      type: "forkgroup",
      title: "并行修复",
    });
    expect(router.parse("/ng 新任务群")).toEqual({
      type: "newgroup",
      title: "新任务群",
    });
    expect(router.parse("/ns 完成后运行测试")).toEqual({
      type: "nosteer",
      text: "完成后运行测试",
    });
    expect(router.parse("/thi")).toEqual({ type: "thinking" });
    expect(router.parse("/per")).toEqual({ type: "permissions" });
    expect(router.parse("/pro")).toEqual({ type: "provider" });
    expect(router.parse("/tu")).toEqual({ type: "turns" });
    expect(router.parse("/di")).toEqual({ type: "dir", directory: undefined });
    expect(() => router.parse("/thi xhigh")).toThrow("不接受参数");
    expect(router.parse("/q 完成后运行测试")).toEqual({
      type: "nosteer",
      text: "完成后运行测试",
    });
  });

  test("prefers exact commands and rejects ambiguous prefixes", () => {
    expect(router.parse("/new title")).toEqual({ type: "new", title: "title", cwd: undefined });
    expect(router.parse("/fork 2")).toEqual({ type: "fork", sessionId: "2" });
    expect(router.parse("/mo")).toEqual({ type: "model" });
    expect(() => router.parse("/s")).toThrow(
      "命令前缀 /s 不唯一，可匹配：/sessions、/status、/stop、/switch",
    );
    expect(() => router.parse("/f")).toThrow(
      "命令前缀 /f 不唯一，可匹配：/file、/fork、/forkgroup",
    );
    expect(() => router.parse("/a")).toThrow("命令前缀 /a 不唯一，可匹配：/agent、/archive");
    expect(() => router.parse("/re")).toThrow(
      "命令前缀 /re 不唯一，可匹配：/release、/restart",
    );
    expect(router.parse("/res")).toEqual({ type: "restart" });
    expect(() => router.parse("/t")).toThrow(
      "命令前缀 /t 不唯一，可匹配：/thinking、/title、/turns",
    );
    expect(router.parse("/ag")).toEqual({ type: "agent" });
    expect(() => router.parse("/p")).toThrow(
      "命令前缀 /p 不唯一，可匹配：/permissions、/provider",
    );
  });

  test("parses Codex task discovery and unified switching", () => {
    expect(router.parse("/sessions desktop task")).toEqual({ type: "sessions", searchTerm: "desktop task" });
    expect(router.parse("/sessions")).toEqual({ type: "sessions" });
    expect(router.parse("/switch")).toEqual({ type: "switch" });
    expect(router.parse("/switch 019f-thread")).toEqual({ type: "switch", sessionId: "019f-thread" });
  });

  test("uses agent for both listing and selecting the default agent", () => {
    expect(router.parse("/agent")).toEqual({ type: "agent" });
    expect(router.parse("/agent codex")).toEqual({ type: "agent", agent: "codex" });
  });

});
