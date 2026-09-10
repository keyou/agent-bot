import { describe, expect, test } from "vitest";
import { renderCliHelp } from "../../src/cli/help.js";
import { COMMAND_NAMES } from "../../src/commands/CommandRouter.js";

describe("CLI help", () => {
  test("renders concise English help with common commands", () => {
    const help = renderCliHelp("1.2.3", "en");

    expect(help).toContain("Agent Bot 1.2.3");
    expect(help).toContain("Usage:");
    expect(help).toContain("Common commands:");
    expect(help).toContain("server restart [--task <task>]");
    expect(help).toContain("notify the source task or private chat");
    expect(help).toContain("agentbot [options] <command>");
    expect(help).toContain("Codex, TraeX, and compatible ACP agents");
    expect(help).toContain("Check and configure Agents; initialize the Lark app and service");
    expect(help).toContain("update                            Safely update an npm-installed Agent Bot");
    expect(help).toContain("--allow-downgrade");
    expect(help).toContain("init --reset");
    expect(help).toContain("Back up and reset the default or selected Profile");
    expect(help).toContain("agentbot init --reset");
    expect(help).toContain("Show the server, Lark App ID, Agent processes, and safe-restart status");
    expect(help).toContain("server autostart <action>");
    expect(help).toContain("server autostart enable --linger");
    expect(help).toContain("Remove registration without stopping the current server");
    expect(help).toContain("task prompt [task] <prompt>");
    expect(help).toContain("task current [--json]");
    expect(help).toContain("Show details for the task invoking the CLI");
    expect(help).toContain("task newgroup [task] [title]");
    expect(help).toContain("--session <ID>");
    expect(help).not.toContain("--move");
    expect(help).toContain("supports --agent, --dir, --nodir");
    expect(help).toContain("task forkgroup [task] [title]");
    expect(help).toContain("Task commands:");
    expect(help).toContain("task new [task] [title]");
    expect(help).toContain("task fork [task]");
    expect(help).toContain("task queue [task] <prompt>");
    expect(help).toContain("task provider|model [task] [value]");
    expect(help).toContain("task goal [task] [action|goal]");
    expect(help).toContain("task turns [task]");
    expect(help).toContain("task reset [task] <Turn ID>");
    expect(help).toContain("task mute [task] [on|off]");
    expect(help).toContain("task dir [task] [directory]");
    expect(help).toContain("task file [task] <path>");
    expect(help).toContain("task shell [task] <command>");
    expect(help).toContain("task archive [task]");
    expect(help).toContain("task release [task]");
    expect(help).toContain("task dismiss [task] --yes");
    expect(help).toContain("omit task to use the current task; --task <task> overrides it");
    expect(help).toContain("-h, --help");
    expect(help).not.toMatch(/[一-龥]/u);
  });

  test("renders Chinese help for a Chinese system language", () => {
    const help = renderCliHelp("1.2.3", "zh");

    expect(help).toContain("Agent Bot 1.2.3");
    expect(help).toContain("用法：");
    expect(help).toContain("常用命令：");
    expect(help).toContain("server restart [--task <任务>]");
    expect(help).toContain("Agent 内通知来源任务，终端内通知私聊");
    expect(help).toContain("agentbot [选项] <命令>");
    expect(help).toContain("Codex、TraeX 和兼容 ACP 的 Agent");
    expect(help).toContain("检查并配置 Agent，初始化飞书应用和服务");
    expect(help).toContain("update                            安全更新 npm 安装的 Agent Bot");
    expect(help).toContain("--allow-downgrade");
    expect(help).toContain("显示服务、飞书 App ID、Agent 进程和安全重启状态");
    expect(help).toContain("server autostart <操作>");
    expect(help).toContain("系统启动时自动启动，无需登录");
    expect(help).toContain("task prompt [任务] <提示词>");
    expect(help).toContain("task current [--json]");
    expect(help).toContain("显示当前调用任务的详情");
    expect(help).toContain("task newgroup [任务] [标题]");
    expect(help).toContain("--session <ID>");
    expect(help).not.toContain("--move");
    expect(help).toContain("支持 --agent、--dir、--nodir");
    expect(help).toContain("task forkgroup [任务] [标题]");
    expect(help).toContain("任务命令：");
    expect(help).toContain("task new [任务] [标题]");
    expect(help).toContain("task fork [任务]");
    expect(help).toContain("task queue [任务] <提示词>");
    expect(help).toContain("task goal [任务] [操作或目标]");
    expect(help).toContain("task turns [任务]");
    expect(help).toContain("task reset [任务] <Turn ID>");
    expect(help).toContain("task mute [任务] [on|off]");
    expect(help).toContain("task file [任务] <路径>");
    expect(help).toContain("task archive [任务]");
    expect(help).toContain("task release [任务]");
    expect(help).toContain("task dismiss [任务] --yes");
    expect(help).toContain("省略任务，CLI 会自动使用当前任务");
  });

  test("documents a CLI counterpart for every Feishu slash command", () => {
    const help = renderCliHelp("1.2.3", "en");
    const counterparts: Record<(typeof COMMAND_NAMES)[number], string> = {
      agent: "task agent",
      archive: "task archive",
      dir: "task dir",
      dismiss: "task dismiss",
      file: "task file",
      fork: "task fork",
      forkgroup: "task forkgroup",
      goal: "task goal",
      help: "-h, --help",
      model: "task provider|model",
      mute: "task mute",
      new: "task new",
      newgroup: "task newgroup",
      nosteer: "nosteer is an alias",
      permissions: "task permissions",
      provider: "task provider|model",
      queue: "task queue",
      release: "task release",
      restart: "task restart",
      sessions: "task list",
      status: "task status|chat",
      stop: "task stop",
      switch: "task switch",
      thinking: "task thinking",
      title: "task title",
      turns: "task turns",
    };

    expect(Object.keys(counterparts).sort()).toEqual([...COMMAND_NAMES].sort());
    for (const command of COMMAND_NAMES) expect(help).toContain(counterparts[command]);
  });
});
