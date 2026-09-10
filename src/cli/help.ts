import { cliLanguage, type CliLanguage } from "./i18n.js";

export function renderCliHelp(version: string, language: CliLanguage = cliLanguage): string {
  if (language === "zh") {
    return `Agent Bot ${version}
通过飞书使用本地 Codex、TraeX 和兼容 ACP 的 Agent。

用法：
  agentbot [选项] <命令>

常用命令：
  init                              检查并配置 Agent，初始化飞书应用和服务
  init --reset                      重置并重新配置默认或指定的 Profile
  update                            安全更新 npm 安装的 Agent Bot
  console                           打开本地控制台
  server start                      在后台启动 Agent Bot
  server status                     显示服务、飞书 App ID、Agent 进程和安全重启状态
  server autostart <操作>           管理当前 Profile 的系统自启动
  server restart [--task <任务>]    安排安全重启；Agent 内通知来源任务，终端内通知私聊
  server stop                       停止 Agent Bot
  skills status                     显示内置 Skill 状态
  skills install                    安装内置 Skill

任务命令：
  task list                         列出任务；支持 --search，sessions 是别名
  task current [--json]             显示当前调用任务的详情
  task status|chat [任务]           显示任务状态或绑定的飞书会话
  task prompt [任务] <提示词>       向任务发送提示词；send 是别名
  task new [任务] [标题]            在同一会话新建任务；支持 --agent、--dir、--nodir
  task newgroup [任务] [标题]       创建新群；支持创建参数或 --session <ID> [--agent <名称>]
  task fork [任务]                  从任务最近完成的 Turn 创建分支
  task forkgroup [任务] [标题]      从任务 Fork 新群
  task switch [任务] [目标任务]     切换会话任务；--previous 切回上一任务
  task queue [任务] <提示词>        将提示词排队；nosteer 是别名
  task agent [任务] [名称]          查看或设置该会话的新任务默认 Agent
  task provider|model [任务] [值]    查看选项或设置 Provider、模型
  task thinking [任务] [强度]       查看或设置思考强度
  task permissions [任务] [模式]    查看或设置权限模式：auto、confirm
  task goal [任务] [操作或目标]     查看、设置、修改、暂停、恢复或清除 Goal
  task turns [任务]                 列出已完成的历史 Turn
  task reset [任务] <Turn ID>       将对话上下文 Reset 到指定 Turn
  task mute [任务] [on|off]         设置群聊仅 @ 响应模式；不传值等同于 on
  task dir [任务] [目录]            浏览任务目录；支持 --page、--json
  task file [任务] <路径>           将文件发送到任务绑定的飞书会话
  task shell [任务] <命令>          在任务目录执行本地命令
  task stop [任务]                  停止任务
  task archive [任务]               归档任务
  task release [任务]               发送共享 App Server 释放确认卡片
  task dismiss [任务] --yes         归档任务并解散其当前群聊
  task title [任务] <标题>          重命名任务
  task restart [任务] [--force]     从任务会话请求安全或立即重启

  在 Agent Bot 启动的 Agent 中可省略任务，CLI 会自动使用当前任务；--task <任务> 可显式覆盖。

选项：
  --profile <目录>                  使用独立的 Profile 目录
  --config <路径>                   使用指定的配置文件
  --json                            在支持时输出 JSON
  -h, --help                        显示帮助
  -v, --version                     显示版本

初始化选项：
  --reset                           备份并重置默认或指定的 Profile
  --skip-feishu                     仅初始化 Console 环境
  --reconfigure-feishu              仅替换现有飞书凭据

更新选项：
  --alpha                           更新到 Alpha 通道
  --stable                          更新到稳定通道
  --version <版本>                  更新到指定版本
  --task <任务>                     将更新和重启状态发回任务所在会话
  --allow-downgrade                 明确允许安装较旧版本

重启选项：
  --task <任务>                     覆盖自动识别的来源任务或默认私聊
  --reason <原因>                   设置重启原因
  --immediate                       立即重启，可能中断任务

自启动操作：
  server autostart enable           在用户登录时自动启动当前 Profile
  server autostart enable --linger  Linux：系统启动时自动启动，无需登录
  server autostart status           显示系统启动项及服务运行状态
  server autostart disable          移除启动项，不停止当前服务

示例：
  agentbot init
  agentbot update
  agentbot init --reset
  agentbot --profile ~/.agent-bot-rescue init
  agentbot server start
  agentbot server status
  agentbot server autostart enable
  agentbot task list
  agentbot server restart --reason "更新 Agent Bot"
`;
  }

  return `Agent Bot ${version}
Use Codex, TraeX, and compatible ACP agents from Lark/Feishu.

Usage:
  agentbot [options] <command>

Common commands:
  init                              Check and configure Agents; initialize the Lark app and service
  init --reset                      Reset and reconfigure the default or selected Profile
  update                            Safely update an npm-installed Agent Bot
  console                           Open the local console
  server start                      Start Agent Bot in the background
  server status                     Show the server, Lark App ID, Agent processes, and safe-restart status
  server autostart <action>         Manage OS autostart for the selected Profile
  server restart [--task <task>]    Restart safely; notify the source task or private chat
  server stop                       Stop Agent Bot
  skills status                     Show the built-in Skill status
  skills install                    Install the built-in Skill

Task commands:
  task list                         List tasks; supports --search; sessions is an alias
  task current [--json]             Show details for the task invoking the CLI
  task status|chat [task]           Show task status or its Lark chat binding
  task prompt [task] <prompt>       Send a Prompt to a task; send is an alias
  task new [task] [title]           Create a task in the same conversation; supports --agent, --dir, --nodir
  task newgroup [task] [title]      Create a group; supports creation options or --session <ID> [--agent <name>]
  task fork [task]                  Fork the task's latest completed Turn
  task forkgroup [task] [title]     Fork a task into a new group
  task switch [task] [target]       Switch the conversation task; --previous selects the prior task
  task queue [task] <prompt>        Queue a Prompt; nosteer is an alias
  task agent [task] [name]          Show or set the conversation's default Agent for new tasks
  task provider|model [task] [value]  Show choices or set the Provider or model
  task thinking [task] [effort]     Show or set reasoning effort
  task permissions [task] [mode]    Show or set permission mode: auto or confirm
  task goal [task] [action|goal]    Show, set, edit, pause, resume, or clear a Goal
  task turns [task]                 List completed historical Turns
  task reset [task] <Turn ID>       Reset conversation context to a Turn
  task mute [task] [on|off]         Set group mention-only mode; omitted means on
  task dir [task] [directory]       Browse task files; supports --page and --json
  task file [task] <path>           Send a file to the task's Lark conversation
  task shell [task] <command>       Run a local command in the task directory
  task stop [task]                  Stop a task
  task archive [task]               Archive a task
  task release [task]               Send a confirmation card to release the shared App Server
  task dismiss [task] --yes         Archive a task and dissolve its current group
  task title [task] <title>         Rename a task
  task restart [task] [--force]     Request a safe or immediate restart from a task

  Inside an Agent started by Agent Bot, omit task to use the current task; --task <task> overrides it.

Options:
  --profile <directory>             Use an isolated profile directory
  --config <path>                   Use a specific config file
  --json                            Print JSON when supported
  -h, --help                        Show help
  -v, --version                     Show version

Init options:
  --reset                           Back up and reset the default or selected Profile
  --skip-feishu                     Initialize for Console only
  --reconfigure-feishu              Replace only the existing Lark credentials

Update options:
  --alpha                           Update from the Alpha channel
  --stable                          Update from the stable channel
  --version <version>               Update to an exact version
  --task <task>                     Return update and restart status to the task's conversation
  --allow-downgrade                 Explicitly allow an older version

Restart options:
  --task <task>                     Override the inferred source task or default private chat
  --reason <reason>                 Set the restart reason
  --immediate                       Restart immediately and possibly interrupt tasks

Autostart actions:
  server autostart enable           Start this Profile automatically at user login
  server autostart enable --linger  Linux: start at system boot without a login
  server autostart status           Show OS registration and live server state
  server autostart disable          Remove registration without stopping the current server

Examples:
  agentbot init
  agentbot update
  agentbot init --reset
  agentbot --profile ~/.agent-bot-rescue init
  agentbot server start
  agentbot server status
  agentbot server autostart enable
  agentbot task list
  agentbot server restart --reason "Update Agent Bot"
`;
}
