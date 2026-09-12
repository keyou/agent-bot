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

## 飞书命令

发送 `/` 开头的消息即可执行命令。使用飞书中的 `/help` 查看最新命令列表。

| 命令                                          | 作用                         |
| --------------------------------------------- | ---------------------------- |
| `/new [标题] [--dir <路径> \| --nodir]`       | 开始新任务                   |
| `/dir [路径]`                                 | 浏览文件，或在指定目录开始任务 |
| `/file <文件路径>`                            | 将指定文件发送到当前飞书会话 |
| `/sessions [关键词]`                          | 查找和管理任务               |
| `/archive [任务]`                             | 归档当前或指定任务           |
| `/dismiss`                                    | 确认后归档当前任务并解散群聊 |
| `/switch [任务]`                              | 切换任务，或返回上一个任务   |
| `/fork [任务]`                                | 创建任务分支                 |
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
| `/newgroup [标题] [--dir <路径> \| --nodir]`  | 在新私有群中开始任务         |
| `/forkgroup [标题]`                           | 将任务分支到新私有群         |
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

`/new` 和 `/newgroup` 会继承当前 Agent、项目和运行设置。使用 `--dir` 指定其他目录，或使用 `--nodir` 创建无项目目录的任务；`~` 表示用户主目录。

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

思考卡片底部操作区提供 `Preview` 按钮，可在浏览器中查看本轮已保存的执行时间线，采用紧凑布局并适配手机。连续的原生思考合并到同一个默认折叠的区域。命令以代码样式显示在 Header，输出默认折叠，相同的输出和错误日志只显示一次。工具状态、开始时间和耗时显示在输出行。执行中的 Turn 会自动实时更新，并保留你手动展开或折叠的步骤。点击文件变更列表或工具文件列表中的文件，可在新标签页预览其当前内容；已删除或不可用的文件保留为路径文字。Turn Preview 与本地文件链接共用相同的签名、访问地址和网络范围。

Turn Preview 顶部用点分隔各项信息，保留“耗时”标签，Token 数量使用 K、M、B 单位简写，窄屏下自动换行。Prompt、Commentary 和结果正文使用普通字重，字号比工具调用大一号。工具命令和输出保留换行与缩进，长行在工具块内横向滚动，不自动折行。命令区域最多显示 15 行，超出部分可在区域内纵向滚动查看。滚动条采用无箭头的浅色细条，鼠标设备上悬停或键盘聚焦时显示，触屏设备保留可用的滚动条。

Turn Preview 的 Prompt、Commentary 和结果中的本地图片通过签名文件链接加载，实时更新时同样生效。相对图片路径按任务的项目目录解析。

HTML 文件（`.html`、`.htm`）默认以预览模式打开，并支持切换代码、行号定位和实时更新。自包含 HTML 的内联样式、内联脚本和嵌入媒体可在隔离框架内运行；不开放外部资源、相对路径本地资源、网络请求、表单提交及对外层查看页的访问。预览会渲染完整文档，仅代码视图限制为开头 2 MiB。

Provider、模型、思考强度和权限设置会作用于当前任务，同时保存到对应 Agent 的 `defaults` 中。以后创建没有同 Agent 设置可继承的新任务时，会使用这些默认值；每个已配置 Agent 分别保存自己的设置。

运行设置卡片末尾以 Markdown 引用块显示当前选项页的一句重点提示，标明作用范围和生效时机。Agent 只改变本聊天或话题中新任务的默认 Agent，不迁移当前任务；模型、思考强度和权限从下一轮生效。Agent 和 Provider 选项只显示标识，去掉重复的展示名称，保留当前与默认状态标记。

切换 Provider 要求任务处于空闲状态；任务执行中请等待完成，或停止任务后再切换。对于自定义 Provider，Agent Bot 会在接口可用时读取其 OpenAI 兼容 `/models` 接口，并只展示该 Provider 返回的模型。切换时优先保留目标 Provider 也支持的原模型；否则选择目标 Provider 的默认模型，没有默认模型时选择返回列表中的第一个模型。未提供模型列表接口的 Provider 仍可使用：Agent Bot 会把当前或已配置模型作为唯一候选交给 Codex 应用。Agent Bot 只卸载选中的空闲任务，再使用解析出的 Provider 和模型恢复，校验两者后才保存设置并提示成功。确认由当前实例新建的空任务可以重建底层线程，但保留本地任务标识、标题和目录；Fork 或恢复的任务不会仅因尚未发送新消息而被当作空任务。切换失败时保留原设置并尝试恢复远端；如果恢复也失败，将阻止后续执行，直到重新切换 Provider 成功。

`feishu.groupNameFormat` 可分别设置 Project 与 Projectless 新群的名称模板，支持系统、Agent、项目、任务名和日期变量。完整格式说明见[技术参考](docs/technical-reference.zh.md#配置模型)。

Agent 进程会继承普通父进程变量及其显式配置的 `agents.<name>.env`。启动 Agent 前，Agent Bot 会移除继承的 `FEISHU_*` 凭据和内部 `AGENT_BOT_*` 状态，再仅提供带命名空间的非敏感 Profile 与 Lark 身份上下文；`FEISHU_APP_SECRET` 永远不会传入 Agent 进程。

默认配置 `feishu.respondToOwnerOnly: true` 只接受 `feishu.userOpenId` 所标识的机器人拥有者发送的消息和卡片操作；其他用户会在添加处理 reaction 之前被忽略。设为 `false` 可允许其他协作者使用。开启后若未配置拥有者 Open ID，Agent Bot 会忽略所有飞书用户输入，直到完成拥有者配置。

Agent Bot 会响应机器人所在群内拥有者发送的普通消息。将 `feishu.respondToAllGroupMessages` 设为 `false` 后，还会要求拥有者在群消息中 @ 当前机器人；私聊不受这一项影响。只有开启该配置时，初始化才会申请需要手动发布的“接收所有群消息”权限。从 `false` 改为 `true` 后，需要重新运行 `agentbot init` 并完成最后的权限步骤。

思考卡片默认使用分组布局：辅助 Commentary 和用户追加消息保持直接显示，每个执行组只显示最新一段原生思考，点击后可展开完整的工具命令和结果。显示命令时会省略常见的 PowerShell、zsh、bash 和 sh 启动包装前缀。失败工具仍会在自己的工具面板中标记，但不会让整个执行组显示失败图标或红色边框。执行组默认折叠，并使用稳定的组件标识，使用户在飞书中手动打开的面板在卡片更新后继续保持展开。Codex 压缩上下文时，卡片内部会把实时压缩状态显示为一条进度活动；协议提供数据时，还会显示耗时、压缩前后的上下文 token 数、已执行轮次和 rollout 磁盘占用。长任务会根据完整渲染后的卡片内容大小翻页，不再使用固定的消息数或工具数。将 `feishu.thinkingCardLayout` 设为 `timeline` 可临时恢复原版布局。

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
