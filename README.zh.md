<p align="center">
  <img src="assets/agent-bot-logo.png" alt="Agent Bot Logo" width="180">
</p>

# Agent Bot

通过飞书使用本机上的 Codex、TraeX 和兼容 ACP 的 Agent。

[项目主页](https://keyou.github.io/agent-bot/) | [English](README.md) | 简体中文

Agent Bot 运行在你的电脑上，把飞书机器人连接到本机编程 Agent。发送消息即可开始工作；执行过程中机器人会更新进度卡，完成后发送 Markdown 最终回答。

## 可以做什么

- 在飞书中使用本机已有的 Codex 或 TraeX 登录
- 创建、继续、切换、分支和停止任务
- 从任意成功完成的思考卡片重置当前对话
- 使用文字、图片、文件、引用消息、合并转发记录、群聊和话题协作
- 排队后续 Prompt，或在任务运行中追加指令
- 模型服务临时失败时自动重试
- Agent Bot 重启后继续已有工作
- 不使用飞书时通过本地 Console UI 运行

## 快速开始

### 使用前提

- Node.js 22 或更高版本
- 使用 Codex 时要求版本不低于 `0.153.4`；此版本限制不适用于 TraeX 和 ACP Agent
- 至少安装一个支持的 App Server Agent：Codex 或 TraeX
- 已完成准备使用的 Agent 的本机登录

检查已安装的 Agent 和登录状态：

```bash
codex --version
codex login status
traex --version
traex login status
```

Codex 或 TraeX 中任意一个准备完成后即可继续初始化。`agentbot init` 会检查两者，并可帮助安装或升级。

### 安装

```bash
# 安装正式版
npm install --global @keyou007/agent-bot
# 如果想要使用最新功能，可以安装 Alpha 版本
# npm install --global @keyou007/agent-bot@alpha
agentbot --version
agentbot --help
```

从源码安装的方法见[技术参考](docs/technical-reference.zh.md#开发与源码安装)。

### 初始化

```bash
agentbot init
```

初始化会检测 Codex 和 TraeX，并显示已安装的版本。未安装或版本较旧的 Agent 会汇总显示对应的安装或升级命令。Agent Bot 会把配置保存到 `~/.agent-bot/config.yaml` 中。

即使 npm registry 不可用，也会在本地检查 Codex 最低版本。首次初始化不能选择过旧的 Codex；已有配置使用过旧 Codex 时，需要先升级再继续初始化。运行时还会校验实际启动的 App Server 版本，版本过低会提示升级，不再回退到旧版全量历史协议。请执行 `codex update`（或 `npm install -g @openai/codex@latest`），然后安全重启 Agent Bot。

在交互式终端中，初始化会通过分步向导完成 Agent 选择、飞书机器人创建和权限配置。常规的一键授权完成后，向导才会询问群消息响应方式；只有选择“接收所有群消息”时，最后才会进入需要手动发布应用版本的额外权限步骤。

1. **创建机器人。** 创建带有标准基础消息配置的飞书应用，并保存 App ID、App Secret 和授权用户。该步骤不能跳过，否则 Agent Bot 无法连接飞书。创建时已经提供的权限不再在下方重复列出。
2. **补充剩余权限、事件和回调。** 这一步实际只新增：

    | 类型 | 权限、事件或回调 | 功能 |
    | ---- | ---------------- | ------------------ |
    | 权限 | `im:chat:delete` | 允许 `/dismiss` 解散由机器人创建并担任群主的群；缺失时不影响其他功能。 |
    | 事件 | `im.chat.updated_v1` | 检测群改名，把群名同步到 agent 任务标题。 |
    | 回调 | `card.action.trigger` | 卡片按钮交互。 |

3. **按需添加“接收所有群消息”权限。** 只有选择“接收所有群消息”时才会在最后出现这一步。`im:message.group_msg` 用于接收未 @ 机器人的普通群消息，飞书要求用户在开发者后台手动添加并发布应用版本。输入 `Y` 跳过、等待超时或没有完成发布都不会导致初始化失败，只会让群聊保持仅 @ 响应。选择“明确 @ 机器人”时不会申请该权限。

完成这些步骤后，即完成了 `~/.agent-bot` 目录的初始化，Agent Bot 会立即启动。每次 `agentbot init` 成功后，机器人都会向授权用户私聊发送一张包含 Agent Bot Logo 的欢迎卡片：首次初始化会介绍主要能力，升级后初始化会展示新版亮点，同版本再次初始化则会确认 Profile 已刷新。

Agent Bot 自带保活机制，确保在 Agent Bot，Codex 或 TraeX 崩溃后能够自动重新连接。

### 启动与停止

启动服务：

```bash
# agentbot init 会自动启动 Server，一般不需要手动启动。
agentbot server start
```

查看服务状态：

```bash
agentbot server status
```

停止服务：

```bash
agentbot server stop
```

安全重启服务：

```bash
agentbot server restart
```

它会等待当前运行中的 Agent 任务完成后自动重启，确保所有任务都能正常执行。Agent 调用 CLI 时，状态卡返回其来源任务；普通终端调用时，状态卡发送到配置用户的私聊。传入 `--task <任务>` 可覆盖这两种默认目标。在飞书话题中触发时，重启状态和重启后的启动卡都会返回原话题。

安全重启卡片提供 `Cancel` 和 `ForceRestart`。点击 `ForceRestart` 后立即执行待处理的重启，不再等待任务、最终结果投递或空闲确认，可能中断正在执行的任务。如果已有准备完成的更新等待应用，则立即应用更新并重启。已取消、被新计划替代或已触发的计划不能再次强制执行。

卡片中每个显示的运行中任务后都有 `Stop`，点击只停止对应任务，包括其他会话中的任务。任务停止后卡片自动刷新，安全重启继续等待剩余阻塞项。

如需在用户登录后自动启动 Agent Bot：

```bash
agentbot server autostart enable
agentbot server autostart status
agentbot server autostart disable
```

每个 Profile 的自启动设置相互独立；关闭自启动不会停止当前正在运行的 Server。

### 更新或卸载

全局 npm 安装推荐使用以下命令更新：

```bash
agentbot update
```

正式版默认检查稳定通道，Alpha 版默认检查 Alpha 通道。也可以使用 `--stable`、`--alpha` 或 `--version <版本>` 明确选择。服务正在运行时，Agent Bot 会发送安全重启卡片，等待当前任务完成后更新并自动恢复服务；如果没有任务在执行，则立即重启更新。源码目录和 `npm link` 安装不会被自更新命令修改。

Windows 下，更新检查、安装及校验使用的内部 npm 和 Node 子进程隐藏命令窗口，命令输出和错误仍正常捕获。

飞书服务运行期间，默认每天按服务器本地时区在 10:00–17:00 随机检查一次，只查询 npm 正式版 `latest`，检查时间会持久化。发现新版本后，向配置的用户私聊发送一张更新提醒卡片，包含本版新功能说明、60 秒倒计时和“取消本次更新”按钮。未取消则在后台下载并校验，等任务执行、最终结果投递及入站消息静默窗口全部结束后，再安装并自动重启；保留原有失败回滚保护。同一 Profile 中每个版本只提醒一次，取消后即使重启也不会再次自动更新该版本。倒计时期间重启会在原卡片上重新给足 60 秒，不另发提醒。

在 Profile 配置中设置 `updates.enabled: false` 并安全重启，可关闭自动检查。没有配置私聊用户、没有确认卡片投递成功或无法读取版本说明时，不会自动安装。检查失败等待次日检查，安装失败不会对同一版本自动重试。自动更新不安装 Alpha、不降级，仍只支持 npm 全局安装，保留源码目录和 `npm link` 保护。手动 `agentbot update` 行为不变。

如需手动替换全局包，请先停止正在运行的服务：

```bash
agentbot server stop
npm install --global @keyou007/agent-bot@latest
agentbot init # 更新 Profile 并启动 Server
```

卸载前，请先移除自动启动项并停止服务：

```bash
agentbot server autostart disable
agentbot server stop
npm uninstall --global @keyou007/agent-bot
```

卸载 npm 包不会删除 `~/.agent-bot` 中的用户数据。

### 多 Profile

多 Profile 支持在同一台设备上运行多个 Agent Bot 机器人，它们互相独立，互不干扰。

使用以下命令创建新 Profile：

```bash
# 指定新 profile 目录，初始化新机器人
agentbot --profile ~/.agent-bot-rescue init
agentbot --profile ~/.agent-bot-rescue server start
agentbot --profile ~/.agent-bot-rescue server status
agentbot --profile ~/.agent-bot-rescue server autostart enable
```

不指定 `--profile` 时使用位于 `~/.agent-bot` 的主 Profile。

每个 Profile 都在所选目录内保存自己的 `config.yaml`、`.env`、`data/` 和 `logs/`，飞书凭据与本地控制端点也相互隔离。

### 重置 Profile

如需完整重新配置默认 Profile，请先停止它的 Server，然后直接执行重置：

```bash
agentbot server stop # 停止默认 Profile 的 Server
agentbot init --reset # 重置默认 Profile
```

如需重置其他 Profile，请为两条命令同时指定 `--profile <目录>`。

重置会把当前 `config.yaml`、`.env`、`data/` 和 `logs/` 移入 `.reset-backups` 目录中，再创建干净的新文件和目录。已有备份会永久保留，不会被后续重置覆盖或清理。远端旧飞书应用不会被删除。

重置不会清理 Codex 或 TraeX 的聊天会话，只会重建飞书机器人以及清理 Agent Bot 的本地数据。

## 日常命令

### Console UI/TUI

```bash
agentbot console
```

Console UI 不需要飞书凭据。除非传入 `--force`，否则不会与正在运行的 Server 共享任务状态。

### 任务管理

```bash
agentbot task list
agentbot task current [--json]
agentbot task status [任务]
agentbot task prompt [任务] "<prompt>"
agentbot task new [任务] [标题] [--agent <标准名>] [--dir <路径> | --nodir]
agentbot task newgroup [任务] [标题] [--agent <标准名>] [--dir <路径> | --nodir]
agentbot task fork [任务]
agentbot task forkgroup [任务] [标题]
agentbot task clone [任务] [标题] [--agent <标准名>]
agentbot task clonegroup [任务] [标题] [--agent <标准名>]
agentbot task queue [任务] "<prompt>"
agentbot task model [任务] [模型]
agentbot task goal [任务] [操作或目标]
agentbot task turns [任务]
agentbot task reset [任务] <Turn ID>
agentbot task dir [任务] [目录]
agentbot task file [任务] <路径>
agentbot task title [任务] "<标题>"
agentbot task stop [任务]
agentbot task archive [任务]
agentbot task dismiss [任务] --yes
```

在 Agent Bot 启动的 Agent 中，省略 `[任务]` 会自动使用当前任务；需要操作其他任务时可传入 `--task <任务>`。普通终端仍必须指定任务。`task current` 用于查看自动识别出的任务详情。任务引用可以是 `task list` 中的序号、任务 ID 或唯一的任务 ID 前缀。飞书中的任务、分支、排队、Agent、Provider、模型、思考强度、权限、Goal、历史 Turn、Reset、群静音、解散群、目录、文件、Shell 和重启能力都有对应的 CLI 命令；运行 `agentbot --help` 查看完整列表和参数。

`task newgroup` 会创建飞书群和新任务。默认继承源任务的 Agent 和运行设置；`--agent <标准名>` 可选择另一个已配置的 Agent，此时仍继承源任务的项目形态，但 Provider、模型、思考强度和权限模式使用目标 Agent 已保存的默认值。`--dir` 可覆盖项目目录并支持 `~`，`--nodir` 会强制创建 Projectless App Server 任务。Project 与 Projectless 群名可在 `feishu.groupNameFormat` 中分别自定义。`task forkgroup` 从源任务最新可用的已完成 turn 创建分支，不会中断正在执行的 turn。两个命令都要求 Server 正在运行，邀请 Profile 中保存的授权用户，不会切换源会话的当前任务，并支持 `--json`。

`task clone` 和 `task clonegroup`（飞书命令为 `/clone` 和 `/clonegroup`，后者可缩写为 `/cg`）支持跨 Agent 的轻量上下文迁移：按时间顺序将截至最近已完成 Turn 的用户 Prompt 和最终回答导出为本地文本文件，再自动让新 Agent 阅读、简短确认并等待后续指令。不调用模型生成摘要，不复制思考过程、工具调用及输出、图片数据或原生会话文件；大文本文件可分段读取。App Server 通过摘要分页读取历史，ACP 来源只导出 Agent Bot 已保存的对话。

目标 Agent 默认取当前会话设置的默认 Agent，不一定与源任务相同；可用 `--agent` 显式指定。Provider、模型和思考强度使用目标 Agent 已保存的默认值，权限和项目目录继承源任务；Projectless App Server 任务会使用新的工作目录。`clone` 在新任务创建并启动上下文读取后切换当前任务，`clonegroup` 新建私有群且不切换源会话。两者都不中断源任务，也不导出未完成轮次；话题尚无已完成任务历史时，以对应的原始 Turn 为截止点。CLI 均支持 `--json`，建群需要 Profile 中的授权用户。文件保存在配置的 SQLite 旁的 `context-transfers` 目录，通常为 `~/.agent-bot/data/context-transfers`；克隆任务仍需使用时请保留文件。这是文本上下文迁移，不是原生会话状态或工作文件的复制。

## 飞书命令

发送 `/` 开头的消息即可执行命令。使用飞书中的 `/help` 查看最新命令列表。

| 命令                                          | 作用                         |
| --------------------------------------------- | ---------------------------- |
| `/new [标题] [--agent <名称>] [--dir <路径> \| --nodir]`       | 开始新任务                   |
| `/dir [路径]`                                 | 浏览文件，或在指定目录开始任务 |
| `/file <文件路径>`                            | 将指定文件发送到当前飞书会话 |
| `/sessions [关键词]`                          | 查找和管理任务               |
| `/archive [任务]`                             | 归档当前或指定任务           |
| `/dismiss`                                    | 确认后归档当前任务并解散群聊 |
| `/switch [任务]`                              | 切换任务，或返回上一个任务   |
| `/fork [任务]`                                | 创建任务分支                 |
| `/clone [标题] [--agent <名称>]`               | 将对话上下文迁移到新任务     |
| `/turn [Turn ID 或序号]`                       | 浏览历史轮次或查看指定轮次的运行信息 |
| `/status [任务]`                              | 查看任务状态、轮次和磁盘占用 |
| `/title <标题>`                               | 修改当前任务标题             |
| `/stop`                                       | 停止当前执行                 |
| `/queue <prompt>`                             | 在当前轮次结束后执行 Prompt  |
| `/nosteer <prompt>`                           | 与 `/queue` 相同             |
| `/goal [目标]`                                | 管理长期目标                 |
| `/provider`                                   | 选择 Provider                |
| `/model`                                      | 选择模型                     |
| `/thinking`                                   | 设置思考强度                 |
| `/permissions`                                | 设置执行权限                 |
| `/agent [名称]`                               | 选择新任务使用的 Agent       |
| `/newgroup [标题] [--agent <名称>] [--dir <路径> \| --nodir]`  | 在新私有群中开始任务         |
| `/forkgroup [标题]`                           | 将任务分支到新私有群         |
| `/clonegroup [标题] [--agent <名称>]`          | 将对话上下文迁移到新私有群   |
| `/restart [--force]`                          | 安全重启；`--force` 会中断任务 |
| `/release`                                    | 释放 Agent Bot 占用的 App Server 任务 |
| `/mute [on\|off]`                            | 设置当前群仅响应 @ 消息      |
| `/help`                                       | 显示命令帮助                 |

私聊、群正文和话题分别维护当前任务。新话题在执行 `/help`、`/status` 或 `/sessions` 等命令时保持未绑定状态，不会暗中创建分支；收到第一条普通消息后，才会从可识别的原始 turn 创建分支，无法识别来源时则创建全新任务。使用 `/new` 可以直接创建全新话题任务，使用 `/sessions` 可以绑定现有任务；依赖当前任务的命令会提示如何绑定，而不会操作父会话任务。任务运行时发送普通消息会向当前轮次追加指令；需要在本轮结束后独立执行时，使用 `/queue`。

`/release` 会发送当前任务所属 Agent 共享 App Server 的释放卡片，以便在 Codex Desktop 中打开这些任务。卡片会列出并持续刷新阻塞释放的任务名。Agent Bot 不会自动释放：空闲时点击 **Release**，有活动任务时点击 **Release Now** 会中断执行并清除排队 Prompt；**Cancel** 会取消本次释放。释放不会归档或删除任务历史，但会影响该 App Server 已加载的所有任务。

Fork 只记录来源任务和分支轮次，不同步完整历史。普通任务和分支任务的 `/turns` 都按需要读取摘要分页，翻页才继续读取较早轮次；分支历史不会越过分支轮次。本地卡片只读取关系索引和当前页 Prompt 摘要，不加载历史工具输出。任务列表只读最近一轮摘要，目录等元数据查询不读轮次；状态与恢复只读最近一轮的完整结果，并复用状态校准结果。活跃检测复用未变化的日志，只增量扫描追加内容。

`/turn` 与 `/turns` 等价。不带参数时打开历史卡片；`/turn 3` 使用卡片中从 1 开始、由新到旧的序号（运行中的轮次排在最前），`/turn <Turn ID>` 查看当前任务历史中的指定轮次。查看详情不会 Reset、恢复执行、停止或切换任务。已有 ID 直接读取；缺失历史只按摘要分页查找，到达指定序号或找到 ID 所在页就停止，Fork 查询不会越过分支点。详情展示已保存的 Prompt、状态、耗时、活动和结果，并在已配置时提供 Preview；仅有摘要的外部轮次不会补拉未记录的工具过程。

历史轮次图使用固定宽度的分支列，序号单独排布，确保节点和分支连接线对齐，同时不为普通延续线增加空行。

在群聊中发送 `/mute` 或 `/mute on` 后，机器人只处理 @ 它的消息；@ 机器人并发送 `/mute off` 可恢复自动响应。该设置对群内所有话题生效。

`/new` 和 `/newgroup` 默认使用当前会话设置的默认 Agent，也可用 `--agent <名称>` 为本次任务指定已配置的 Agent，不改变源会话的默认值。例如：`/new 修复测试 --agent codex`、`/newgroup 代码审查 --agent traex --dir ~/dev/project`。项目目录仍继承当前任务；选中的 Agent 与当前任务相同时继承运行设置，不同时使用目标 Agent 已保存的 Provider、模型、思考强度和权限默认值。使用 `--dir` 指定其他目录，或使用 `--nodir` 创建无项目目录的任务；`--nodir` 要求选中的 Agent 为 App Server，`~` 表示用户主目录。

`/file` 支持相对路径、绝对路径和以 `~` 开头的用户目录路径；相对路径以当前任务目录为基准。

`/fork` 和 `/forkgroup` 会从已完成的工作创建分支，不会中断正在执行的轮次。`/sessions` 用于跨项目、跨 Provider 管理任务，每页最多显示 10 个任务；切换 Provider 不会让任务从列表或搜索结果中消失。项目菜单提供 `New` 和 `NewGroup`。展开任务后会直接显示最后一个用户 Prompt 的前 50 个字符、更新时间以及任务级操作。`/turns` 用于恢复对话上下文，不会回退本地文件。

## 本地命令

在飞书聊天框直接输入 `!` 开头的消息会作为本地命令处理，命令会在当前任务目录执行。

比如 `! ls` 会列出当前目录下的文件，`! git status` 会显示当前 Git 仓库的状态。
本地命令由独立后台进程执行，不设运行超时，也不会阻塞当前会话中的其他消息或命令。运行期间会动态刷新同一张输出卡片，并按观察到的先后顺序显示正常输出和诊断输出；可通过卡片中的 `Cancel` 停止命令。Agent Bot Worker 重启后会自动恢复监控仍在运行的命令。内容过长时会保留开头和结尾，并截断中间部分。

## 配置与数据

Agent Bot 将用户相关文件保存在仓库之外：

| 路径                       | 用途               |
| -------------------------- | ------------------ |
| `~/.agent-bot/config.yaml` | Agent Bot 配置     |
| `~/.agent-bot/.env`        | 飞书凭据           |
| `~/.agent-bot/data/`       | 任务数据和输入缓存 |
| `~/.agent-bot/logs/`       | 按天切分的运行日志 |

可通过 `AGENT_BOT_HOME` 修改用户数据目录。配置示例见 [config.example.yaml](config.example.yaml)。

回答中引用的本地非图片文件或目录会自动变成只读查看链接，可在浏览器中查看源码、Markdown、日志、PDF、常见媒体文件，或向下浏览目录内容。默认链接只在运行 Agent Bot 的电脑上打开；将 `fileViewer.host` 设为 `0.0.0.0` 后，会按有线、Wi-Fi、其他物理网卡、VPN 的顺序自动选择局域网地址。域名、HTTPS 反向代理或端口映射可通过 `fileViewer.publicBaseUrl` 覆盖自动地址。链接带有当前 Profile 独立的签名。

飞书回答和思考卡片中的相对文件链接（例如 `outputs/report.md`）按该轮保存的项目目录解析后，转换为签名查看链接。支持 Windows/POSIX 路径、编码空格和行号引用；解析后无法访问的文件显示为路径文字，网页链接、图片和代码保持不变。

`/status` 状态卡片底部也提供 **Preview**，与 Refresh、Stop/Switch 放在同一行。点击可查看正在执行的轮次，空闲时则查看最近一轮；刷新卡片后会更新目标。对应轮次尚无已保存的预览或文件预览服务不可用时不显示按钮。查看其他任务的状态不会切换或接管任务。

思考卡片底部操作区提供 `Preview` 按钮，可在浏览器中查看本轮已保存的执行时间线，采用紧凑布局并适配手机，思考块直接以内容标题作为折叠标题，展开后显示内容。工具块只有一级折叠，默认只显示有意义的单行命令摘要、简短耗时（如 `58s` 或 `2:32`）和完成状态。展开后先显示以 `$` 开头的完整命令，随后直接显示结果、图片和修改文件。相同的输出和错误日志只显示一次。执行中的 Turn 会通过局部更新实时显示变化，保留手动展开状态、滚动位置和未变化的图片节点，避免图片反复加载；Token 等元数据更新不会替换时间线。折叠工具块和文件变更汇总首屏只加载摘要，展开时才请求命令、日志、图片和文件列表；再次展开复用已加载内容，运行中只刷新已展开且内容变化的详情，加载失败可点击重试。已结束的 Turn 不再建立 SSE 实时连接。“正在等待 Agent 返回进度”只在尚无可显示进度时出现，已有回答、其他可见进展或 Turn 已结束时不再显示。点击文件变更列表或工具文件列表中的文件，可在新标签页预览其当前内容；已删除或不可用的文件保留为路径文字。Turn Preview 与本地文件链接共用相同的签名、访问地址和网络范围。

通过 `/turn <ID 或序号>` 或 Preview 打开仅导入摘要的历史轮次时，会从原始 Agent 会话按需读取该轮执行详情并缓存。仅请求摘要分页和目标轮次的完整记录，不拉取整个会话的完整历史，也不恢复或打断源任务。读取失败会单独显示原因，不改变本轮执行状态；重新打开详情或刷新 Preview 即可重试。已有详细快照保持不变，历史中缺失的耗时、Token 等数据不作推算。

Turn Preview 支持 JavaScript/TypeScript、Python、Shell/PowerShell、JSON/YAML、SQL、HTML/CSS、Go、Rust、Java、C/C++ 等常见语言的代码块高亮，配色跟随系统浅色/深色主题。在代码块开头指定语言即可；未指定、未知语言或超大代码块仍完整显示为纯文本。行内代码和工具日志保持原样。

Turn Preview 中的 Mermaid 图表支持「预览 / 源码」切换，默认显示预览。使用 `mermaid` 代码块和 `flowchart` 或 `graph` 语法即可，也支持 `flowchart` 代码块。实时更新会保留手动选择的模式；语法错误或尚未完整的图表会回退到源码。图表在本地浏览器中渲染，不上传外部服务；图表默认按可用宽度等比缩小，不会放大小图。手机端预览高度最多约半屏，长图可纵向滑动；点击「原大 / 适应」可查看细节或恢复适配，实时更新会保留该选择。

Turn Preview 顶部用点分隔各项信息，保留“耗时”标签，Token 数量使用 K、M、B 单位简写，窄屏下自动换行。Prompt、Commentary 和结果正文使用普通字重，字号比工具调用大一号。展开后的工具命令和输出保留换行与缩进，长行在工具块内横向滚动，不自动折行。命令和结果共用一个最多 30 行高的滚动区域。页面为占宽度的竖向滚动条预留空间，展开或收起工具时，顶部和正文不再左右跳动。滚动条采用无箭头的浅色细条，鼠标设备上悬停或键盘聚焦时显示，触屏设备隐藏滚动条，仍可用手势滚动。

工具块保留浅色边框。Prompt 之后、文件变更汇总之前和答案之前显示横向分隔线，最终答案之后不再显示分隔线。文件变更汇总默认折叠，标题显示文件数量，实时更新时保留手动展开状态。文件变更汇总和工具文件列表中，项目内的文件显示相对路径，项目外的文件显示绝对路径。

当 App Server 仅返回 `Read` 或 `Grep` 工具名时，会使用已有动作元数据，在标题摘要和展开命令中补充文件路径或搜索内容与范围。完整命令保持不变，缺失的目标不作推测，已保存的历史 Preview 不会回填。

工具标题开头使用与思考卡片相同的状态图标：执行中为沙漏，成功为对号，失败为叉号；执行中的工具边框突出显示。标题摘要省略命令续行符，保留文件路径和展开后的完整命令。时长为 0 秒时隐藏。展开后的底部显示执行状态、开始时间、耗时和结果字符数，不随内容滚动；执行中标题和底部的耗时都会实时更新。

TraeX 请求进入规划模式或确认方案开始执行时，现有思考卡片会显示“等待确认”、方案正文，以及 `Approve Plan`（或 `Enter Plan Mode`）、`Reject`、`Cancel Request` 操作。即使使用自动执行权限，也必须明确确认；取消确认请求不等同于停止任务。Turn Preview 会展示方案及待确认提示，但保持只读，请在飞书卡片中操作。等待确认的轮次仍是活动任务，在完成或被明确停止前继续阻止安全重启。旧版本运行时已经丢失的确认通知无法通过此次适配自动补回。

Turn Preview 的 Prompt、Commentary 和结果中的本地图片通过签名文件链接加载，实时更新时同样生效。相对图片路径按任务的项目目录解析。

首条及追加用户消息携带的图片会随 Turn 快照保存，在 Preview 中通过签名链接显示，支持 SSE 更新以及重启后重新打开。缓存文件已删除时会显示不可用提示；旧快照未记录的附件路径不会自动补回。

切换模型或 Provider 后，后续轮次的 Preview 会显示更新后的模型。执行过程中切换模型不会改变当前轮次或历史轮次的模型标记。

Agent 提供数据时，Turn Preview 在原有非缓存 Token 数量旁显示本轮总计（输入加输出，包含缓存命中）和缓存命中的输入 Token 数。数值实时更新，使用简写单位，悬停可查看精确值；重复用量通知不会重复累计。缺失的明细和旧快照不作推算，也不会读取任务历史补填；飞书卡片的 Token 统计口径保持不变。

HTML 文件（`.html`、`.htm`）默认以预览模式打开，并支持切换代码、行号定位和实时更新。自包含 HTML 的内联样式、内联脚本和嵌入媒体可在隔离框架内运行；不开放外部资源、相对路径本地资源、网络请求、表单提交及对外层查看页的访问。预览会渲染完整文档，仅代码视图限制为开头 2 MiB。

Provider、模型、思考强度和权限设置会作用于当前任务，同时保存到对应 Agent 的 `defaults` 中。以后创建没有同 Agent 设置可继承的新任务时，会使用这些默认值；每个已配置 Agent 分别保存自己的设置。

运行设置卡片末尾以 Markdown 引用块显示当前选项页的一句重点提示，标明作用范围和生效时机。Agent 只改变本聊天或话题中新任务的默认 Agent，不迁移当前任务；模型、思考强度和权限从下一轮生效。Agent 和 Provider 选项只显示标识，去掉重复的展示名称，保留当前与默认状态标记。只有一个 Provider 时，`/provider` 仍会打开运行设置卡片，可以继续切换到 Model、Thinking 和 Permission 页。

切换 Provider 要求任务处于空闲状态；任务执行中请等待完成，或停止任务后再切换。对于自定义 Provider，Agent Bot 会在接口可用时读取其 OpenAI 兼容 `/models` 接口，并只展示该 Provider 返回的模型。切换时优先保留目标 Provider 也支持的原模型；否则选择目标 Provider 的默认模型，没有默认模型时选择返回列表中的第一个模型。未提供模型列表接口的 Provider 仍可使用：Agent Bot 会把当前或已配置模型作为唯一候选交给 Codex 应用。Agent Bot 只卸载选中的空闲任务，再使用解析出的 Provider 和模型恢复，校验两者后才保存设置并提示成功。确认由当前实例新建的空任务可以重建底层线程，但保留本地任务标识、标题和目录；Fork 或恢复的任务不会仅因尚未发送新消息而被当作空任务。切换失败时保留原设置并尝试恢复远端；如果恢复也失败，将阻止后续执行，直到重新切换 Provider 成功。

`feishu.groupNameFormat` 可分别设置 Project 与 Projectless 新群的名称模板，支持系统、Agent、项目、任务名和日期变量。完整格式说明见[技术参考](docs/technical-reference.zh.md#配置模型)。

TraeX 内置的 `trae` Provider 直接使用原生 `model/list` 返回的完整模型列表，保留模型名称和思考强度选项，不要求配置自定义 Provider 的 `base_url`。其他自定义 Provider 的模型发现和降级行为保持不变。

Provider 模型列表读取失败时，设置卡片保留降级候选模型，同时显示失败原因并提示服务可用性未确认。切换成功只代表配置已通过校验，不代表实际模型请求可用。App Server 执行错误和原生重试通知会在同一张思考卡片和 Preview 中显示消息及 `additionalDetails`，包括 Agent 提供的上游错误码和重试等待时间。错误按纯文本展示，重复详情不重复显示，长原因可在 Preview 和思考活动历史中查看。缺少详情时不猜测原因，不自动回填此前保存的快照。重试不会新建卡片或提前结束任务，最终完成通知仍决定成功、失败或取消状态。

部分 Responses 兼容 Provider 不返回助手消息阶段。这类文本先按顺序显示在进度时间线，不再提前拼接成最终回答；轮次成功结束时，只有最后一条且之后未开始工具调用的未标记消息会成为最终回答。明确的 `commentary` 和 `final_answer` 标记优先。思考卡片和 Preview 使用同一分类结果，不自动改写此前保存的快照。

如果 Codex 在恢复已有任务时忽略指定的 Provider 或模型，Agent Bot 会从最新已完成轮次创建新的 Codex 分支重试。本地任务、标题和目录保持不变，之后失败或中断的轮次仅保留在原线程中。新线程的设置通过校验后才会被采用。

Agent 进程会继承普通父进程变量及其显式配置的 `agents.<name>.env`。启动 Agent 前，Agent Bot 会移除继承的 `FEISHU_*` 凭据和内部 `AGENT_BOT_*` 状态，再仅提供带命名空间的非敏感 Profile 与 Lark 身份上下文；`FEISHU_APP_SECRET` 永远不会传入 Agent 进程。

Agent Bot 启动时还会读取每个 Codex Agent 的 `CODEX_HOME/.env`（默认 `~/.codex/.env`），供 Provider 模型发现和 Codex 进程使用，无需把这些密钥重复写入 Agent Bot 的 `.env`。已有环境变量和 Agent 显式配置优先。修改该文件后需安全重启 Agent Bot。

默认配置 `feishu.respondToOwnerOnly: true` 只接受 `feishu.userOpenId` 所标识的机器人拥有者发送的消息和卡片操作；其他用户会在添加处理 reaction 之前被忽略。设为 `false` 可允许其他协作者使用。开启后若未配置拥有者 Open ID，Agent Bot 会忽略所有飞书用户输入，直到完成拥有者配置。

Agent Bot 会响应机器人所在群内拥有者发送的普通消息。将 `feishu.respondToAllGroupMessages` 设为 `false` 后，还会要求拥有者在群消息中 @ 当前机器人；私聊不受这一项影响。只有开启该配置时，初始化才会申请需要手动发布的“接收所有群消息”权限。从 `false` 改为 `true` 后，需要重新运行 `agentbot init` 并完成最后的权限步骤。

思考卡片默认使用分组布局：辅助 Commentary 和用户追加消息保持直接显示，每个执行组只显示最新一段原生思考，点击后可展开完整的工具命令和结果。显示命令时会省略常见的 PowerShell、zsh、bash 和 sh 启动包装前缀。失败工具仍会在自己的工具面板中标记，但不会让整个执行组显示失败图标或红色边框。执行组默认折叠，并使用稳定的组件标识，使用户在飞书中手动打开的面板在卡片更新后继续保持展开。Codex 压缩上下文时，卡片内部会把实时压缩状态显示为一条进度活动；协议提供数据时，还会显示耗时、压缩前后的上下文 token 数、已执行轮次和 rollout 磁盘占用。长任务会根据完整渲染后的卡片内容大小翻页，不再使用固定的消息数或工具数。将 `feishu.thinkingCardLayout` 设为 `timeline` 可临时恢复原版布局。

纯空白 Commentary 不占用固定展示名额。卡片生成的连续省略标记只显示一次，不会删除消息正文中的省略号，也不会改动已保存的历史记录。

Turn Preview 中每个已保存的思考项默认折叠，开头的 Markdown 标题或独立加粗标题直接显示在折叠栏；展开后显示剩余摘要和正文，不再添加“摘要 / 正文”标签或重复同一标题。没有明确标题时保留“思考”作为标题，原文完整保留。折叠时不加载全文，展开后按需加载 Markdown，实时更新保留展开状态。思考正文及完成事件中的权威内容单独保存，不改变思考卡片的标题、分组或最终回答。旧快照中已保存的摘要仍可查看，此前未记录的正文不会从 Agent 历史自动回填。

引用卡片或合并转发中的卡片时，Agent 会收到可读取的原始文字和图片。

文件变更摘要中的路径保持普通文本样式，完整保留 Windows 路径分隔符和下划线（包括 `\__init__.py`），不会将其解析为 Markdown 格式。

## 常见问题

- **机器人没有响应：** 运行 `agentbot server status`，并查看当天的 `~/.agent-bot/logs/agent-bot.YYYY-MM-DD.log`
- **Node 崩溃后 Worker 被自动重启：** 查看 `~/.agent-bot/data/last-crash.json`、崩溃当天的 `~/.agent-bot/logs/worker.stderr.YYYY-MM-DD.log` 和 `~/.agent-bot/data/crash-reports/`
- **飞书权限不完整：** 重新运行 `agentbot init`，完成显示的授权步骤
- **Agent 无法启动：** 使用运行 Agent Bot 的同一操作系统用户执行 `codex login status` 或 `traex login status`，然后重新运行 `agentbot init` 检查版本
- **只需要本地测试：** 运行 `agentbot init --skip-feishu`，然后执行 `agentbot console`
- **安全重启一直等待：** 使用 `agentbot task list --status running` 检查活动任务

## 更多文档

- [技术参考](docs/technical-reference.zh.md)：配置、权限、路由、持久化、恢复和运行机制
- [配置示例](config.example.yaml)
- [更新日志](CHANGELOG.md)
- [Agent 开发指南](https://github.com/keyou/agent-bot/blob/master/AGENTS.md)
