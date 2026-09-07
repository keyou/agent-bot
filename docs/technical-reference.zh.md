# Agent Bot 技术参考

[English](technical-reference.md) | 简体中文

本文介绍部署、配置、运行机制、持久化和集成细节。安装与日常命令请先阅读 [README](../README.zh.md)。

## 运行架构

Agent Bot 是基于 Node.js 22+、ESM 和 TypeScript 的应用，主要组件如下：

- Supervisor 负责常驻服务和 worker 自动重启
- Worker 启动配置的 Agent Runtime、飞书传输、Console 传输、本地控制服务和 SQLite
- 飞书事件和 Console 输入统一进入任务控制器
- 展示层为每个 turn 维护一张进度卡，并单独发送 Markdown 最终回答
- App Server Agent 通过 stdio 连接 App Server，其他 Agent 使用 ACP

主要源码目录：

| 目录                | 职责                                       |
| ------------------- | ------------------------------------------ |
| `src/config/`       | YAML 加载、环境变量展开、校验和路径解析    |
| `src/cli/`          | 初始化、应用创建、配置审计及服务/任务命令  |
| `src/feishu/`       | 飞书长连接事件、API、卡片、图片和上下文键  |
| `src/runtime/`      | 通用 Runtime 抽象                          |
| `src/codex/`        | Codex、TraeX 及兼容 Agent 的 App Server 协议集成 |
| `src/acp/`          | ACP 进程与 JSON-RPC 集成                   |
| `src/proxy/`        | 任务、turn、steering、队列、分支和命令执行 |
| `src/presentation/` | Turn 状态归并和出站路由                    |
| `src/state/`        | SQLite schema、迁移、路由和投递状态        |
| `src/supervision/`  | 安全重启和重启通知                         |

## 用户数据与路径解析

默认用户数据根目录为 `~/.agent-bot`，可通过 `AGENT_BOT_HOME` 整体替换。

CLI 还支持显式指定目录的 Profile。不使用 `--profile` 时，命令使用主 Profile 以及原有的环境变量路径规则。`--profile <目录>` 会为当前命令及其启动的 Supervisor、Worker 固定 `AGENT_BOT_HOME` 和 `AGENT_BOT_CONFIG`，配置文件固定为 `<目录>/config.yaml`。它还会先清除继承的飞书凭据环境变量，再加载所选 Profile 的 `.env`，避免从主 Agent Bot 进程树中启动辅助实例时误用主机器人的凭据。`--profile` 不能和 `--config` 同时使用。其他 Profile 必须在每次命令中显式选择；Agent Bot 不维护按名称注册的 Profile。

CLI 通过 Node.js 国际化能力读取系统 Locale。以 `zh` 开头的 Locale 使用中文界面；英文及所有未支持 Locale 使用英文。帮助、状态、进度、交互提示和 CLI 自身错误都遵循此规则；JSON 字段名及枚举值不做本地化。系统生成的重启原因仍使用中文，因为它会显示在中文 Lark 状态卡中；显式传入的 `--reason` 保持原样。`agentbot server status` 会报告运行中 Worker 的 Lark App ID，JSON 字段名为 `feishuAppId`；服务停止或旧版健康协议尚未提供该字段时，CLI 会回退到当前 Profile 配置的 App ID。`agents` 数组会报告每个已配置 Agent 进程的 PID 和协议初始化返回的版本号；Agent 尚未启动时两者均为 `null`。

| 默认路径                             | 内容                 |
| ------------------------------------ | -------------------- |
| `~/.agent-bot/config.yaml`           | YAML 主配置          |
| `~/.agent-bot/.env`                  | 飞书凭据             |
| `~/.agent-bot/data/agent-bot.sqlite` | 任务和投递持久化状态 |
| `~/.agent-bot/data/inbound-images/`  | 接收图片缓存         |
| `~/.agent-bot/logs/agent-bot.YYYY-MM-DD.log` | 按天切分的结构化运行日志 |

配置文件优先级：

1. CLI `--profile <目录>` 选择 `<目录>/config.yaml`
2. CLI `--config <路径>`
3. `AGENT_BOT_CONFIG`
4. `<AGENT_BOT_HOME>/config.yaml`，默认为 `~/.agent-bot/config.yaml`

默认 `.env` 始终从 Agent Bot 用户目录加载。加载 `.env` 后，YAML 中的 `${NAME}` 会使用进程环境变量展开。

相对形式的 `storage.sqlitePath` 和 `logging.path` 按配置文件所在目录解析；`defaults.cwd` 按进程启动目录解析。

## 初始化

初始化开始阶段，`agentbot init` 会并行检查目前支持的 Codex 和 TraeX CLI，并显示各自已安装的版本。Codex 与最新稳定版 `@openai/codex` 比较，TraeX 与 Alpha 通道比较。未安装或版本较旧的 Agent 会汇总到一个编号列表，并显示准确的安装或升级命令。交互式用户可以输入用逗号或空格分隔的操作编号、输入 `all`，或直接回车跳过维护；所选命令按顺序执行并继承终端输入输出，跳过或失败的操作都会记录结果，初始化继续。非交互式终端只显示供手动执行的命令。使用 `--json` 时，进度与询问写入 stderr，最终 `agents` 数组记录检测和辅助执行结果。Codex 升级会先执行 `codex update`，旧版 updater 失败时回退到当前 npm 包安装命令。

第一次全新交互式 `init` 和每次显式 `--reset` 还会询问群消息响应方式。选择接收所有群消息会写入 `feishu.respondToAllGroupMessages: true`，并把 `im:message.group_msg` 纳入配置审计；选择明确 @ 机器人会写入 `false`，该权限不会出现在授权链接、轮询或缺失功能警告中。第一次非交互式初始化或 reset 默认选择仅 @ 响应。后续初始化保留已有配置，不再询问。

版本与维护检查完成后，第一次全新交互式 `init` 和每次显式 `--reset` 都会根据实际检测到安装版本的受支持 Agent 生成 Profile 的 Agent 配置；仍未安装的 Codex 或 TraeX 不会进入候选列表。检测到多个 Agent 时，用户可以通过编号或标准名选择一个或多个，输入 `all` 或直接回车选择全部。未选择的 Agent 定义会通过保留注释的 YAML 原子更新从新配置中移除。只选择一个 Agent 时自动将其设为默认值；选择多个时再显示一次默认 Agent 选择，可输入编号或标准名写入 `defaults.agent`。后续升级和同版本刷新直接保留已配置 Agent 列表与默认值，不再显示这两类选择器，已有自定义 Agent 也会保留。第一次非交互式初始化或 reset 会配置所有检测到且已安装的 Agent；模板默认值在所选列表中时继续使用，否则选择第一个检测结果。已有 Profile 没有有效默认值时会失败，并提示在 `config.yaml` 中设置 `defaults.agent`。JSON 输出通过 `configuredAgents` 报告最终列表，在每个受支持 Agent 的检测结果中增加 `configured`，并通过 `defaultAgent.name` 和 `defaultAgent.status`（`selected` 或 `existing`）报告默认值。

目标文件不存在时，`agentbot init` 会复制随包提供的 `config.example.yaml` 和 `.env.example`，创建数据和日志目录，并在平台支持时把 `.env` 权限限制为 POSIX `0600`。

`config.yaml` 已存在时，`init` 会把当前版本随包提供的 `config.example.yaml` 作为配置升级模板。它会解析两个 YAML 文件并递归补齐缺失的映射项，同时保留已有标量值、序列、注释和自定义配置。已有的 `agents` 映射视为用户配置：不会重新加入用户已删除的模板 Agent，但会为同名 Agent 补齐缺失字段。缺失的 `defaults.agent` 不会被推断，避免静默改变当前默认 Agent。YAML 无效时会直接报错，不会覆盖原文件；发生变更时通过原子替换写入，再次执行保持幂等。需要完全使用当前模板重新生成配置时，请使用 `--reset`。

`.env` 已存在时，`init` 会追加随包 `.env.example` 中存在、但当前文件缺少的有效赋值。已有值、注释、顺序和换行风格保持不变，注释状态的可选变量不会被自动启用。更新同样通过原子替换写入，并保持幂等。

凭据处理规则：

- 进程环境变量优先于 `~/.agent-bot/.env`
- `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 必须同时存在
- 一键注册还会把授权用户的 `open_id` 保存为 `FEISHU_USER_OPEN_ID`
- 已有应用凭据但缺少用户 Open ID 时，第一条发送者为有效 `ou_` 标识的私聊消息会把该用户原子写入 Profile 的 `.env`；群消息和后续用户都不会覆盖它
- 除非使用 `--reconfigure-feishu`，完整凭据不会被替换
- 缺少凭据或只有一项时会重新创建应用
- 新创建的凭据经过 fsync、原子替换写入 `.env`，并在配置权限前读回校验

初始化期间会持有 `~/.agent-bot/init.lock`，避免使用不同配置路径的并发命令重复创建应用。进程异常退出遗留的锁会在下次运行时恢复，凭据写入中断留下的临时文件也会被清理。

没有完整凭据时，初始化会启动飞书一键创建流程，并显示验证链接。注册中的设备码不会恢复：如果进程在完整凭据持久化前退出，下次会重新创建应用。凭据持久化后会检查应用当前已发布版本；这一权限审计阶段中断后可以安全继续。

缺失配置分三阶段处理：

1. 请求核心配置并轮询，直到基础消息能力生效
2. 请求其余可选配置。CLI 会显示授权链接，然后立即开始最多 5 分钟的轮询。交互式终端只提供 `Y` 选项，用于跳过可选授权并继续；否则用户直接在浏览器中完成授权，轮询会持续进行
3. 仅在选择接收所有群消息时，最后请求需要手动配置并发布的 `im:message.group_msg`。这一步可输入 `Y` 跳过，等待超时也只返回部分配置结果，不会让初始化失败；仅 @ 响应模式会完全排除该权限

一键配置支持的内容会编码到 launcher 的 `addons` 清单中。选择接收所有群消息时，手动权限 `im:message.group_msg` 不会放入该清单，因为飞书无法通过一键配置新增它。CLI 会在最后阶段显示当前应用已筛选该权限的开发者后台直达链接：

```text
https://open.feishu.cn/app/<appId>/auth?q=im%3Amessage.group_msg&op_from=openapi&token_type=tenant
```

用户需要手动新增权限、发布应用版本，并在需要时完成租户管理员审批。最后阶段会等待最多 5 分钟，在已发布版本中检测到该权限后完成；输入 `Y`、等待超时或没有完成发布都会返回部分配置结果，并提示机器人无法响应未 @ 它的普通群消息。

可选配置轮询失败或超时会返回部分配置结果，不会导致初始化失败。stdin 不是交互式终端时无法输入跳过指令，轮询会持续到配置生效或超时。验证链接和提示写入 stderr，因此 `--json` 的最终 stdout 仍可直接供程序读取。

生成的授权链接不包含 App Secret。

`agentbot --profile <目录> init --reset` 会完整重置显式指定的 Profile。执行前必须先停止该 Profile 的 Server。命令会把当前 `config.yaml`、`.env`、`data/` 和 `logs/` 移入 `<profile>/.reset-backups/` 下唯一的时间戳目录，从随包模板创建干净的新文件和目录，再继续正常初始化。已有重置备份及其他无关文件会保留。备份中可能含有旧 App Secret 和会话数据，应妥善保护 Profile 目录。远端旧飞书应用不会被删除。`--reset --skip-feishu` 可创建干净的 Console-only Profile，`--reset` 不能与 `--reconfigure-feishu` 同时使用。

飞书初始化成功后，CLI 会先释放初始化锁，再通过与 `agentbot server start` 相同的就绪检查流程启动后台 Supervisor，并等待最多 45 秒，直到 Worker 连接飞书并进入就绪状态。如果当前 Profile 的服务已经运行，不会创建第二个 Supervisor，而是安排安全重启，在活动任务和最终结果投递完成后加载当前安装的代码及更新后的配置；JSON 结果将其表示为 `server.status: "restart-scheduled"`。`--skip-feishu` 会跳过自动启动；`--json` 会把结果写入 `server.status`，不会混入非 JSON 文本。

Server 成功启动或安全重启成功安排后，`init` 会直接向 `feishu.userOpenId` 发送 Card 2.0 私聊欢迎卡。无论 CLI 使用什么系统语言，欢迎卡都固定显示中文；卡片会上传随包提供的 `assets/agent-bot-logo.png`，并显示当前安装版本、默认 Agent 和已配置 Agent。如果安全重启仍在等待，卡片会明确说明刷新后的版本将在重启完成后生效，而不会声称新版已经接管。`<profile>/data/initialization.json` 会记录上次成功初始化的包版本，用于区分首次初始化、版本升级和同版本配置刷新。JSON 输出通过 `welcome` 对象报告发送结果。缺少用户 Open ID 或卡片发送失败时会明确警告，但不会撤销已完成的配置，也不会停止已经就绪的 Server；`--skip-feishu` 会记录欢迎卡已跳过。

`agentbot server autostart enable|status|disable` 管理每个 Profile 独立的操作系统启动项。Windows 会先创建 `ONLOGON` 任务计划；如果系统拒绝创建任务，则自动回退到隐藏窗口启动的当前用户启动文件夹脚本。macOS 写入 `RunAtLoad` LaunchAgent，Linux 启用 systemd 用户单元。启动项通过 `<profile>/autostart/supervisor-bootstrap.mjs` 直接启动 Supervisor；bootstrap 只保存 Node 可执行文件、已安装 Supervisor、Profile、配置文件路径和安全的可执行文件搜索路径，会清除继承的飞书凭据变量，再由目标 Profile 自己的 `.env` 加载密钥。LaunchAgent 的 `KeepAlive` 和 systemd 的 `Restart` 均保持关闭，因为 Worker 恢复已经由 Supervisor 负责，同时必须保证 `server stop` 后直到下次登录或开机前不会被立刻拉起。Linux 的 `--linger` 会执行 `loginctl enable-linger`，让用户单元可在登录前启动；禁用 Agent Bot 自启动时不会关闭这个用户级全局设置。禁用自启动也不会停止当前 Server。状态命令会同时显示操作系统注册/加载状态和 Agent Bot 实际就绪状态。不支持的平台可以查看状态，但不能启用启动项。

## 飞书应用要求

基础消息能力依赖以下核心配置：

- 机器人能力
- 长连接事件接收
- `im.message.receive_v1`
- `im:message.group_msg`，仅在选择接收所有群消息时申请，用于接收机器人所在群内的全部用户消息
- 接收私聊消息所需的租户权限
- `im:message:send_as_bot` 或覆盖它的更大权限
- `application:application:self_manage`，供初始化检查已发布版本

可选配置：

| 配置                              | 启用的行为                  |
| --------------------------------- | --------------------------- |
| `im:chat:create`                  | `/newgroup` 和 `/forkgroup` |
| `im:chat:read`                    | 读取群元数据                |
| `im.chat.updated_v1`              | 同步群标题                  |
| `im:message.reactions:write_only` | 消息处理状态表情            |
| 消息读取和资源权限                | 接收与发送图片              |
| 图片和群权限                      | 生成并设置群头像            |
| `card.action.trigger`             | 交互卡片操作                |

可选授权失败时，最终初始化结果会列出受影响功能。重新运行 `agentbot init` 会再次审计。

## 配置模型

完整示例见 [config.example.yaml](../config.example.yaml)。主要配置段：

```yaml
feishu:
  appId: "${FEISHU_APP_ID}"
  appSecret: "${FEISHU_APP_SECRET}"
  userOpenId: "${FEISHU_USER_OPEN_ID}"
  respondToOwnerOnly: true
  respondToAllGroupMessages: true
  groupNameFormat:
    project: "[{agent}] [{project}] {taskname}"
    projectless: "[{agent}] {taskname}"
    dateFormat: "MM-dd"
  thinkingCardLayout: "grouped"

console:
  enabled: true

fileViewer:
  enabled: true
  host: "127.0.0.1"
  port: 0
  # publicBaseUrl: "https://agentbot.example.com/files"

agents:
  codex:
    kind: "app-server"
    title: "Codex"
    command: "codex"
    args: ["app-server", "--enable", "goals", "--listen", "stdio://"]
    env: {}
    defaults:
      permissionMode: "auto"

  traex:
    kind: "app-server"
    title: "TraeX"
    command: "traex"
    args: ["app-server", "--listen", "stdio://"]
    env: {}
    defaults:
      permissionMode: "auto"

defaults:
  agent: "codex"
  cwd: "."

storage:
  sqlitePath: "./data/agent-bot.sqlite"

logging:
  level: "info"
  path: "./logs/agent-bot.log"
```

新查看链接使用 `/preview/<短 token>?path=<绝对路径>` 格式。Windows 路径使用便于复制的正斜杠，例如 `D:/project/file.md`；只有空格和 URL 分隔符等必要字符会进行百分号编码。短 token 是与规范化绝对路径绑定的截断 HMAC，因此修改 token 或路径都会校验失败，也不再需要链接注册表。每个 Profile 持久化的签名密钥可保证重启后原链接仍然有效；旧的 `/view/<编码路径>?sig=...` 链接也保持兼容。查看页会在紧凑的置顶头部显示本地绝对路径。常见源码、配置、标记、Shell 和数据格式会在服务端完成语法高亮，较大文件则回退为纯文本；行号锚点会动态避开悬浮头部，在标题路径后显示所选行号，并持续高亮目标行。文件页面通过带签名的 SSE 流订阅更新，正文和元信息会原地刷新，并保留阅读位置、末尾跟随状态、代码区域的横向滚动位置和目标行高亮。

`fileViewer` 为最终回答中的本地非图片文件和目录生成带签名的只读 HTTP 链接。默认 `host: "127.0.0.1"`，只能从运行 Agent Bot 的机器访问。设为 `0.0.0.0` 或 `::` 时，服务会监听所有网卡，并从非内部 IPv4 地址中按有线、Wi-Fi、其他物理网卡、VPN 的顺序自动选择链接地址；Docker、Hyper-V、VMware、VirtualBox、WSL、回环和链路本地地址会被排除，没有候选地址时回退到本机环回地址。`publicBaseUrl` 的优先级最高，用于域名、HTTPS 反向代理、NAT 或端口映射。`port: 0` 会在第一次启动时选择空闲端口，并保存到 `<data>/file-viewer/port`，以后重启继续使用，同一机器上的多个 Profile 不会争用固定端口。签名密钥保存在同目录的 `secret` 文件中。文件 URL 只能读取签发时对应的绝对路径；目录 URL 会列出其直接子项并允许继续向下浏览，但不提供向父目录跳转。文本身份由内容采样识别，页面显示带行号的开头 2 MiB；图片、PDF、音视频使用浏览器原生预览，其他二进制文件提供原始打开和下载入口。签名 URL 是持有者凭证，不应公开分享。

`feishu.respondToOwnerOnly` 默认为 `true`。每条消息的发送者及卡片操作人的 Open ID 都会与 `feishu.userOpenId` 比较；非拥有者输入会在持久化事件、添加 reaction、下载图片、执行命令或启动 Agent 前被忽略。设为 `false` 可允许其他用户。开启后若未配置拥有者 Open ID，所有飞书消息和卡片操作都会被忽略；需先配置 `FEISHU_USER_OPEN_ID`，或临时关闭限制后通过私聊完成补全。

`feishu.respondToAllGroupMessages` 在模板中默认为 `true`，第一次初始化和 `init --reset` 会按用户选择写入实际值。设为 `false` 后，拥有者未 @ 当前机器人的群消息也会被忽略；Worker 启动时会解析机器人的 Open ID，因此 @ 其他成员不会误触发。拥有者私聊不受影响。初始化只在该值为 `true` 时申请接收全部群消息的权限；仅 @ 响应的 Profile 后续改为 `true` 时，需要重新运行 `agentbot init` 补充权限。

`/mute` 或 `/mute on` 会为当前基础群聊持久化仅 @ 响应模式，`/mute off` 会关闭。群正文及其所有话题共享该状态；静音期间未 @ 当前机器人的消息会在事件去重、reaction、活跃时间、图片下载、命令解析和 Agent 调用之前被忽略。关闭静音的命令本身也必须 @ 机器人。私聊不支持 `/mute`。

`feishu.groupNameFormat.project` 和 `projectless` 分别控制 Project 与 Projectless 任务通过 NewGroup 或 ForkGroup 创建的群名。每个模板必须且只能包含一个 `{taskname}`，并可使用以下变量：

| 变量 | 内容 |
| --- | --- |
| `{os}` | 当前系统：Windows 为 `win`、macOS 为 `mac`、Linux 为 `linux` |
| `{agent}` | Agent 配置标准名，例如 `codex` 或 `traex` |
| `{project}` | Project 目录末尾最多两级，最长 15 个字符；Projectless 模板通常不使用 |
| `{taskname}` | 新任务或 Fork 任务的标题 |
| `{date}` | 按 `dateFormat` 格式化的本地日期时间 |
| `{date:yyyy-MM-dd}` | 只为当前位置指定日期格式，不修改全局 `dateFormat` |

日期格式支持 `yyyy`/`yy` 年、`MM`/`M` 月、`dd`/`d` 日、`HH`/`H` 时、`mm`/`m` 分和 `ss`/`s` 秒，也兼容大写 `YYYY`、`YY`、`DD`、`D`。其他字符按原样输出。最终群名遵循飞书 60 字符限制；超长时优先截断 `{taskname}`，保留模板的前后固定部分。默认模板与旧版群名完全一致。重新运行 `agentbot init` 会为已有配置补齐这一配置段，不覆盖用户已有设置。

`feishu.thinkingCardLayout` 默认为 `grouped`。分组渲染器保持 Commentary 和用户追加消息可见，只把 Commentary 作为执行组边界；每个执行组只用最新原生思考作为标题，展开后仍可查看组内全部工具。命令面板会从标题和展开后的命令正文中去掉 PowerShell 启动器，以及 `/bin/zsh -lc`、`/bin/bash -c`、`/usr/bin/env sh -c` 等 POSIX 命令字符串启动器，但不会修改实际执行的命令。执行组状态不会聚合为失败：存在运行中工具时使用运行中样式，否则回到中性样式；失败工具仍在组内保留自己的失败图标。所有执行面板都以折叠状态作为默认值，并使用稳定的 `element_id`；Agent Bot 不再根据工具状态、用户追加或后续 Commentary 改写展开属性，让飞书客户端能够在整卡更新时保留用户手动展开的状态。分组分页会先完整渲染工具面板，再根据生成内容的 UTF-8 JSON 大小和组件数量从最新端向前装页。活动区上限为 24KB 和 160 个组件，为飞书建议的 30KB 卡片大小及 200 个组件硬限制预留标题、计划、文件变更和操作按钮空间。超过 8 个工具的单个执行组会拆成标识稳定的子面板，但每个工具都继续保留可展开的命令、结果和图片内容。历史页会包含完整原生思考并独立测量。新版布局完善期间，可将该配置设为 `timeline` 使用保持不变的原版渲染器及其每页 40 条活动规则。

以 `!` 开头的飞书本地命令会写入 SQLite 文件同级的 `command-jobs/` 目录，并由脱离 Worker 的独立 Runner 进程执行。命令没有运行超时，提交成功后立即释放当前会话消息队列；不同命令可以并发运行。Runner 将状态持久化到任务目录，并把 stdout 和 stderr 数据块按照观察到的到达顺序写入同一个 `output.log`；日志达到 8 MiB 后保留头尾并压缩中间内容。Worker 只轮询这些文件并更新原卡片，重启后通过未完成状态重新接管监控。运行卡片的 `Cancel` 操作写入持久化取消请求，由 Runner 终止命令进程树。该后台模式仅用于飞书 `!` 命令；CLI 的同步 `agentbot task shell` 行为保持不变。

`agentbot server start` 要求同时配置飞书 `appId` 和 `appSecret`。Worker 启动 SDK 长连接时不读取 SDK 日志或私有连接状态，随后通过发送启动状态卡片检查出站能力。每张启动卡片都会显示从已安装包元数据读取的 Agent Bot 版本。每次启动都会向所有已知私聊发送卡片，不受最近活跃时间影响；同时向本次 Worker 启动前 1 分钟内活跃的非话题群聊发送卡片。安全重启后，还会向所有已加入本次重启通知范围的会话发送，不受活跃时间限制；话题路由及其原始消息锚点会完整经过替换 Supervisor，启动卡以回复形式返回原话题，不会在父群创建新的根话题。安全重启进度卡的范围更窄：只有明确触发本次安全重启的会话会收到并持续更新，最近活跃会话不会被自动加入。数据库里尚无符合条件的会话时，启动卡改用 `feishu.userOpenId`，按 `open_id` 私聊发送。存在启动通知目标时，至少一张卡片发送成功后 Server 才报告就绪，单个目标发送失败仍相互隔离。如果既没有已知会话，也没有 `feishu.userOpenId`，启动会跳过出站检查并继续；仅当 `respondToOwnerOnly: false` 时，之后收到的第一条私聊消息可以补全用户 Open ID，供后续启动通知和 CLI 建群使用。默认的仅拥有者模式要求先配置拥有者 Open ID。缺少凭据时仍会启动失败并提示先初始化。`agentbot console` 是明确的纯本地入口，不需要飞书凭据。

必须至少配置一个 Agent，`defaults.agent` 必须指向已配置的 Agent。

## Agent Runtime

Agent 配置的标准名是运行时隔离键。每个配置的 Agent 都拥有独立、按需启动的子进程和 Runtime 实例，即使多个 Agent 使用相同的 `kind` 也不会合并。不同 Agent 的任务不会共享命令、环境变量、协议连接、会话映射或事件流；同一 Agent 的多个任务共享该 Agent 进程，但使用独立的协议会话。

`kind` 只用于选择连接适配器。`kind: "app-server"` 的每个 Agent 使用各自的 App Server 进程，不论其可执行程序是 Codex、TraeX 还是其他兼容产品。Agent Bot 通过 App Server 协议传递项目目录、模型、思考强度、权限模式、文字输入和本地图片。`/sessions` 会聚合所有 App Server Agent 返回的任务，同时保留任务所属 Agent，确保 Switch、Status、Stop、New 和 Fork 操作回到正确进程。加载已有 Profile 时，旧的 `kind: "codex"` 会被规范化为 `app-server`。

`kind: "acp"` 或未填写 `kind` 的 Agent 使用各自的 ACP 进程。同一 Agent 的多个任务会在该连接上创建独立 ACP session。Agent 配置中的 `env` 只会加入该 Agent 的环境变量。

Agent 进程会继承普通父进程变量。启动 App Server 或 ACP 进程前，Agent Bot 会移除继承环境及 Agent 配置中名称不区分大小写匹配 `FEISHU_*` 或 `AGENT_BOT_*` 的全部变量，然后注入以下受控的非敏感上下文：

```text
AGENT_BOT=1
AGENT_BOT_HOME=<当前 Profile 根目录>
AGENT_BOT_CONFIG=<当前 config.yaml 路径>
AGENT_BOT_AGENT_NAME=<Agent 配置标准名>
AGENT_BOT_LARK_APP_ID=<Lark App ID>
AGENT_BOT_LARK_BOT_OPEN_ID=<Lark 机器人 open_id，可用时提供>
AGENT_BOT_LARK_USER_OPEN_ID=<已保存的授权用户 open_id，可用时提供>
```

内置 Skill 使用 `AGENT_BOT` 判断自己是否运行在 Agent Bot 中。Lark App Secret、Supervisor 状态、重启原因和重启通知路由不会传给 Agent。`agents.<name>.env` 中不使用保留命名空间的变量，仍是显式配置该 Agent 专用环境的方式。

## 聊天路由

消息路由决定当前任务：

- 私聊正文按飞书 chat ID 隔离
- 群正文按飞书 chat ID 隔离
- 带 thread ID 的消息按独立话题上下文隔离
- Console 使用独立的本地上下文

命令、卡片回调、进度卡和最终回答都保留在来源路由。

从已映射的用户消息、进度卡或最终回答创建飞书话题时，不会立即创建任务。斜杠命令可以在话题保持未绑定状态时执行；依赖当前任务的命令会返回绑定指引，不会操作父会话任务。收到第一条普通 Prompt 后，才会从关联的已完成 App Server turn 延迟创建分支；无法可靠确定来源 turn 时则创建全新任务。`/new` 也会直接创建全新任务，`/sessions` 或 `/switch` 可以绑定现有任务，均不会产生中间分支。

`/forkgroup` 会根据话题状态选择来源。话题尚未绑定任务，或者已绑定任务但尚未完成过自己的 turn 时，直接从话题原始锚点 turn fork，不创建中间话题任务。话题任务完成过 turn 后，使用本地持久化的最近完成 turn；更晚的执行中 turn 不会阻塞命令，也不会成为 fork 点。

Fork 从未绑定过 Agent Bot 的任务前，Agent Bot 会先读取不含 Turns 的元数据，再通过轻量的 `summary` Turn 视图从新到旧分页，只读到最近一个已完成 Turn，不再把完整工具历史作为 Fork 前置条件。随后每个 `thread/fork` 请求仍默认发送实验性的 `excludeTurns: true`；它只阻止响应填充 `thread.turns`，不会改变复制到分支中的历史。App Server 连接已启用 `experimentalApi`，不需要用户提供命令参数。如果旧版 App Server 明确不支持轻量 Turn 列表或 `excludeTurns` 字段，Agent Bot 会分别回退到兼容的完整历史读取或 Fork 请求。超时、断连和无关的 Fork 错误绝不重试，因为超时的 Fork 请求可能已经创建分支。

新群欢迎消息会显示分支任务持久化后的 Provider、模型、思考强度和权限类型；权限类型显示为自动执行或执行前确认。

## Turn 与消息行为

- 路由没有当前任务时，普通文本会自动创建任务
- App Server turn 活跃时收到的文字通过 steering 追加
- Steering 与 turn 完成发生竞态时，文字变为下一条排队请求
- `/nosteer` 始终创建持久化 FIFO 队列项
- 队列卡操作可以取消单个待执行项
- 完整斜杠命令名优先；否则在解析参数前展开唯一的命令名前缀或已登记的复合命令首字母缩写，匹配多个命令时会拒绝并列出候选命令。当前缩写为 `fg` → `forkgroup`、`ng` → `newgroup`、`ns` → `nosteer`
- 未知斜杠命令会被拒绝，不会作为 Prompt 转发

每个 turn 只有一张进度卡。普通更新最多每两秒一次，关键更新最短间隔 500 毫秒。完成时先把进度卡更新为终态，再单独发送 Markdown 最终回答。分组思考卡片只在渲染时派生执行组，持久化的时间线活动不依赖布局，因此切换布局或 Worker 重启都不会丢失思考和工具历史。

成功完成的思考卡片包含 `Reset` 操作，其作用提示紧跟在按钮下方。`/turns` 卡片把相同的作用提示放在最上方，按需从 App Server 刷新当前任务的已完成 turn，并在不覆盖 Agent Bot 富内容快照的前提下补齐缺失的本地索引，随后按时间倒序展示，每页 10 条。远端刷新会短暂缓存，卡片翻页不会重复读取同一份完整历史；刷新失败时仍使用已有本地记录。每次 `turn_started` 都会把前一个已完成 turn 保存为父节点；现有任务会结合快照时间和 `session_reset_to_turn` 审计记录回填，因此历史 Reset 后的第一轮会指向所选 turn，而不是时间上相邻的废弃路径。渲染器先基于完整历史计算 lane，再切分页面，从而跨分页正确显示延续和合并；内容缩进到第二列，状态或操作位于第三列。当前对话位置显示“当前”标记，其余 turn 提供 `Reset` 按钮。翻页和成功的 Reset 都会更新同一张卡片、保持与打开卡片时的任务绑定，并把“当前”标记移动到所选 turn；成功提示会用 Prompt 摘要、完成时间和 Turn ID 标明目标轮次。Agent Bot 会持久化每个 turn 原本所属的 App Server thread，从所选 turn fork，并替换当前任务的远端 thread 绑定；本地任务 ID、标题、Agent、项目目录、运行设置和聊天路由保持不变。所选 turn 之后已经完成的快照不会被删除，因此卡片会同时显示旧路径保留的轮次和 Reset 后新分支产生的轮次。当前任务仍在执行时会拒绝 Reset，本地文件修改也不会被回退。Reset 开始时 Agent Bot 会立即发送提示；在 Reset 完成前到达的每条消息都会先获得 Reaction，再等待新的 thread 绑定完成后继续处理。

完成持久化消息去重占位后，Agent Bot 会等待 `OnIt` 表情添加成功，再进行聊天信息持久化、图片下载、队列等待、命令执行或 Runtime 调用。Turn 成功、失败或取消时分别替换为 `DONE`、`ERROR` 或 `CrossMark`。表情操作失败会记录日志，但不会阻塞任务。

可能等待 App Server、飞书接口、进程控制或文件传输的命令，会在第一次潜在长耗时调用前先发送一句简短提示。范围包括创建与切换任务、Fork 与建群、切换 Provider、读取任务与 Turn、状态与 Goal 操作、修改标题、归档与解散群、停止任务、关闭任务占用进程和上传文件。普通 Prompt、Shell、Reset、App Server Release 和安全重启继续使用已有进度卡或专用启动提示，不重复发送通知。

接收飞书富文本时，`code_block` 节点会转换为带语言标记的 Markdown 代码块，并保留原始缩进；`md` 节点会继续保留 Markdown 格式。引用消息或合并转发中的富文本也使用相同转换。富文本图片会下载到输入图片缓存，并以 `localImage` 传给 App Server。纯图片消息使用默认 Prompt `请查看这张图片`。ACP Runtime 不支持图片输入时会明确报错。

## 任务、项目与外部 App Server 工作

`/sessions` 通过 `thread/list` 读取每个已配置 App Server Agent 的任务。对于 Codex，可发现同一 `CODEX_HOME` 下由 Codex Desktop、CLI、Agent Bot 或其他 App Server 客户端创建的任务；其他 Agent 通过同一协议暴露各自的任务存储。任务会在分页前进行全局排序：当前任务最优先，其次是其他活跃任务，其余任务按最后活跃时间倒序排列。全局前 10 个任务只用于确定当前页成员；展示时再按项目首次出现顺序聚拢，每个项目内部继续按活跃时间倒序。展开任务后会直接显示最后一个用户 Prompt 的前 50 个 Unicode 字符，不再显示字段标签，之后是更新时间和操作菜单；运行时任务 ID、目录、加载状态等详情统一留在专门的 Status 视图中。`Previous` 和 `Next` 会替换当前卡片内容而不是继续追加任务，同时保留搜索条件以及与展示顺序一致的任务序号。

每个项目行通过一个紧凑菜单提供 `New` 和 `NewGroup`，每个任务仍保留原有的任务操作。卡片中只携带短操作令牌；所选任务 ID、来源上下文、搜索条件和页码按卡片消息 ID 持久化到 SQLite，并在飞书回调到达时还原，因此卡片体积保持稳定，服务重启后已有卡片仍可继续使用。创建新群时使用飞书操作者的 `open_id` 邀请用户。`NewGroup` 解析所选任务的项目和执行设置；`ForkGroup` 解析该任务最新可用的已完成 turn。

所有 `agentbot task` 操作都支持 `--task <任务>`，并继续兼容原有的首个位置任务参数。在 Agent Bot 启动的 Agent 中，两者均省略时会通过 Codex 或 TraeX 的 App Server Thread ID 自动解析当前任务；在 Agent Bot 外执行时仍必须显式指定任务。CLI 通过 `agentbot task newgroup [任务] [标题] [--agent <标准名>] [--dir <目录> | --nodir]` 和 `agentbot task forkgroup [任务] [标题]` 提供相同的指定任务操作。两个命令都要求 Server 正在运行，并通过当前 Profile 的本地控制端点发送稳定的本地任务 ID。CLI 进程没有飞书操作者，因此 Server 会邀请 `feishu.userOpenId`，该值由初始化保存为 `FEISHU_USER_OPEN_ID`。NewGroup 默认继承指定任务的 Agent 和执行设置；`--agent <标准名>` 可选择另一个已配置的 Runtime，同时继续继承来源项目形态，并省略执行设置以采用目标 Runtime 自己的默认值。ForkGroup 使用来源任务最新可用的已完成 turn，并让来源任务的活动 turn 继续执行。两类控制响应都包含新群、群上下文、来源任务和新任务；`--json` 会输出不做本地化的结构化结果。

## App Server Provider 设置

Provider 会与模型、思考强度和权限模式一起保存在任务中；每个 Agent 还可以在 `agents.<name>.defaults` 下分别保存这些默认值。新任务先读取所选 Agent 的默认值，再由显式设置或同 Agent 任务继承值覆盖。Agent Bot 会通过 `thread/start`、`thread/resume` 和 `thread/fork` 传递最终设置，并把运行时返回的实际值保存到任务。

`/provider`、`/model`、`/thinking` 和 `/permissions` 打开同一张 Card 2.0 运行设置卡片，并激活对应的 tab。四个命令都拒绝参数，tab 切换和设置修改只通过卡片回调完成。Provider 选项来自 App Server 的 `config/read`；对于 Codex，即使隐式内置的 `openai` 没有出现在显式 `model_providers` 配置中，Agent Bot 也会保留该选项。切换 Provider 时使用当前兼容的模型、思考强度和权限模式恢复 thread。每次成功修改 Provider、模型、思考强度或权限后，Agent Bot 都会更新当前任务，把完整生效设置原子写入该 Agent 在 `config.yaml` 中的默认值，就地刷新卡片，并从下一次请求生效；对应 CLI 任务设置命令使用相同的持久化路径。

Agent Bot 内部保留本地路由键以关联飞书卡片和投递状态，但对用户展示所属 App Server 的任务 ID。没有明确用户操作时，不会续写、steer、停止或分支其他客户端正在运行的 Agent 工作。

项目规则：

- `/new --dir <路径>` 创建项目任务
- `/new --nodir` 创建 Projectless 任务
- `/new` 继承当前任务的项目或 Projectless 形态
- 首个 Projectless 任务创建在 `~/Documents/Codex/<日期>/<任务名>`
- 已有任务的工作目录不可变

分支使用最新可用的已完成 turn，不会中断来源任务的活动 turn。

## 持久化与恢复

SQLite 保存：

- 每条路由的当前任务和上一个任务
- 本地任务标识与 App Server task/thread 标识
- 模型、思考强度和权限模式
- 排队 Prompt
- 已接受/运行中的 turn 执行记录，包括原会话路由、Prompt、图片和消息锚点
- 进度快照和消息绑定
- 最终消息投递记录

每次 Worker 启动时，Agent Bot 都会先扫描未终结的 turn 执行记录，再放行持久化的 Prompt 队列。只有前 5 分钟内仍有活动的执行才具备恢复资格；turn 运行期间的运行时事件和每分钟心跳会刷新持久化的活动时间。更早的未完成执行会被标记为已中断，不发送恢复通知，也不创建续跑 turn。符合条件的恢复会先通知原私聊、群聊或话题；远端已完成的 turn 只同步状态并继续未完成的最终消息投递；远端仍活动的 turn 会换用新的进度卡并持续轮询到终态；已失效的 App Server turn 或被中断的 ACP 进程会在同一任务和工作目录中创建新的续跑 turn，续跑 Prompt 会要求 Agent 先检查已有副作用，避免重复操作。恢复状态在连续多次重启之间保持持久化。

当 turn 因临时 LLM 服务错误失败时，Agent Bot 会在同一任务中自动再创建最多 3 个 turn。限流、临时过载、上游 5xx、超时和模型服务流中断可以重试；认证失败、额度耗尽、上下文超限、无效请求、不支持的模型、权限或策略错误以及工具错误会立即终止。每次重试使用新的思考卡片，重试 Prompt 会要求 Agent 先检查已有副作用再继续，避免重复操作。重试次数和待处理消息绑定会持久化；原始消息及追加消息的 Reaction 会保持处理中，并跟随最新的重试 turn，直到成功或耗尽重试次数。

Turn 标识变化、收到终态通知或控制请求失败时也会重新校准。除非 App Server thread 自身报告活动状态，否则持久化的陈旧 `inProgress` turn 不会被视为仍在运行。

最终消息投递账本用于避免重复发送成功回答。App Server 请求使用有限超时，避免阻塞的请求永久占用消息路由。会话生命周期请求允许 60 秒，因为兼容的第三方 Agent 完成 `thread/start` 可能需要超过 30 秒；控制请求仍使用更短的超时。

## Supervisor 与重启

`agentbot server start` 启动后台 supervisor。Worker 意外退出后会自动拉起；连续崩溃时使用 1 到 30 秒的指数退避。

Windows 下，CLI 在首次启动 Supervisor 前、Worker 在启动替换 Supervisor 前，以及 Supervisor 在每次启动 Worker 前，都会重新读取系统和用户环境变量。新值会覆盖继承值，`PATH` 在最新系统和用户路径之后保留进程专用条目。`AGENT_BOT_*` 和 `FEISHU_*` 仍保持进程级隔离，避免正在运行的 Profile 意外切换数据目录或机器人凭据。注册表读取失败时会回退到继承环境而不阻止启动，在运行时日志可用时会记录该错误。

Supervisor 的崩溃诊断文件按当前 Profile 隔离：

- `logs/supervisor.YYYY-MM-DD.log` 持久记录 Worker PID、退出码、运行时长、重启延迟和诊断文件路径
- `logs/worker.stderr.YYYY-MM-DD.log` 保存后台进程原本会丢失的 Node/V8 fatal 输出；两类诊断日志会按本地自然日切分，并在单日文件达到 10 MiB 时继续使用原有备份轮转
- `data/last-crash.json` 指向最近一次 Worker 异常退出，带时间戳的 `data/crash-reports/crash-*.json` 保留历史记录
- Node 能生成报告时，写入 `data/crash-reports/report.*.json`

Supervisor、Worker、替换 Supervisor 和 Console Worker 默认启用 Node fatal error 与未捕获异常报告。Node 版本支持时还会排除环境变量和网络接口，避免凭据进入报告。主动重启退出码 `75` 和停止退出码 `76` 不会创建崩溃清单。

安全重启会等待：

1. 活动任务完成
2. 最终回答完成投递
3. 连续 15 秒没有新消息

飞书 `/restart` 命令默认使用这条安全重启路径；`/restart --force` 会立即重启，并可能中断正在执行的任务。该命令拒绝其他所有参数。新消息会重置静默计时，CLI 的 `--immediate` 和 `--force` 也会跳过这些检查。退出码 `75` 表示主动 worker 重启。

待执行的安全重启计划会收集每一个触发它的精确会话路由。收到任何用户消息时，包括斜杠命令，都会把所属基础私聊或群聊标为活跃。每个已加入的会话都会收到各自的状态卡片和真正开始重启前的提示，并一直保留到本次计划结束。同一路由会去重；如果话题路由最初缺少消息锚点，后续带锚点的触发会补全它。话题请求会保留原消息 ID，并通过话题回复发送，避免重启状态落到群主会话。每条路由还会保留该会话自己的重启原因，其他会话的后续请求不会用无关原因覆盖旧卡片。替换进程前，Agent Bot 会把包含话题消息锚点在内的完整路由经替换 Supervisor 传给 Worker，并用同一路由发送重启后的启动卡。Supervisor 会保留这些路由，直到 Worker 连续稳定运行 60 秒，避免启动阶段异常退出并重新拉起时丢失必发会话。

使用 `agentbot server restart --task <任务>` 可以覆盖 CLI 重启的通知目标。任务序号、完整 ID 和不冲突的 ID 前缀会在发送控制请求前解析。未传 `--task` 时，Agent Bot 启动的 Agent 会通过注入的 Codex 或 TraeX App Server Thread ID 解析来源任务，并把状态卡返回该任务会话；普通终端没有来源任务，因此 Server 把卡片发送到 `feishu.userOpenId` 对应的私聊。若普通终端执行时未配置用户 Open ID，请求会明确提示重新初始化，而不会静默丢失卡片。

首次安全重启状态卡会延迟 3 秒发送，让任务最终回答尽可能先到达；延迟期间的状态变化会合并到首张卡片。该延迟不阻塞调度器轮询，真正关闭前会立即 flush 尚未发送的卡片。

等待中的安全重启状态卡底部带有 `Cancel` 操作。回调会携带调度器单调递增的计划 ID，因此旧卡片不会取消较新的重启。取消成功后，所有已加入会话中的状态卡都会原地更新并移除按钮；调度器进入不可逆的正在重启阶段后也不再显示该按钮。

本地控制服务负责修改任务、执行指定任务的 NewGroup 和 ForkGroup，以及请求服务重启；只读任务查询直接访问 SQLite。

## 权限模式

- `auto`：App Server Agent 使用 `approvalPolicy=never` 和 `danger-full-access`
- `confirm`：通过卡片提供单次允许、会话允许、拒绝和取消任务操作

创建或分支任务时，会按适用场景继承模型、思考强度、权限模式和项目形态。

## 受管系统 Skill

每次 `agentbot init` 成功时，都会把随包提供的 Agent Bot Skill 安装或刷新到共享 Agent Skill 目录。也可以通过以下命令显式管理这份受管安装：

```powershell
agentbot skills install
agentbot skills status
agentbot skills uninstall
```

默认目标为 `~/.agents/skills`，可通过 `AGENT_BOT_SKILLS_DIR` 或 `--target` 修改。安装使用受管复制；卸载不会删除无关的同名目录。

## npm 包与发布

公开包名为 `@keyou007/agent-bot`，安装后的主命令为 `agentbot`。已弃用的 `agent-bot` 作为转发兼容入口暂时保留，每次调用前都会根据系统语言显示警告。包使用 `files` 白名单，只发布运行代码、模板、受管 Skill、源码和用户文档，不包含测试及内部设计计划。

CLI 随包发布 `npm-shrinkwrap.json`，以固定传递运行依赖；直接运行依赖和开发依赖也使用精确版本。

包生命周期：

- `prepublishOnly` 执行类型检查和完整测试
- `prepack` 清理并构建 `dist/`，然后检查 tarball 清单
- `npm run package:smoke` 打包项目、在临时目录安装 tarball、运行 CLI，并执行仅 Console 的初始化

在干净工作树中准备下一个 Alpha 版本：

```powershell
npm run release
git add package.json npm-shrinkwrap.json CHANGELOG.md
git commit -m "release: v0.1.13-alpha.0"
git push origin master
```

`npm run release` 现在默认使用 Alpha 通道：稳定版 `0.1.12` 会变为 `0.1.13-alpha.0`，当前版本 `0.1.13-alpha.0` 会变为 `0.1.13-alpha.1`。`npm run release:alpha` 是对应的显式命令。`npm run release:stable` 会把当前 Alpha 提升为相同核心版本的稳定版；当前已经是稳定版时则递增 patch。仍可通过 `npm run release -- <version>` 使用 `patch`、`minor`、`major`，或指定完整的稳定版及 `-alpha.N` 版本。每次发布都会把当前 `Unreleased` 条目归档到带日期的版本小节。工作树不干净或 `Unreleased` 没有内容时，命令会拒绝修改文件。

推送完成后无需再执行本地发布命令。本仓库自身对 `master` 的 push 通过 CI 后，`publish.yml` 会查询 npm 中的包版本：版本已存在时正常跳过；发现尚未发布的稳定版或 Alpha 版时，要求 `CHANGELOG.md` 存在匹配小节，并在发布前再次执行完整验证和包安装 smoke test。Alpha 版发布到 npm 的 `alpha` dist-tag，并创建 GitHub prerelease；稳定版发布到 `latest`，并创建普通 GitHub Release。

需要补跑时，可以在 **GitHub Actions → Publish to npm → Run workflow** 中选择 `master` 手动执行。Pull Request、外部 fork、CI 失败以及其他分支的 push 都不能进入发布 job。

npm Trusted Publisher 配置为：

- GitHub 所有者：`keyou`
- 仓库：`agent-bot`
- Workflow：`publish.yml`
- 允许操作：`npm publish`

发布 workflow 使用 GitHub OIDC，不保存长期 npm token，并从 GitHub 托管的 Node.js 24 runner 发布。

### npm 安装包自更新

`agentbot update` 只接受包目录与 `npm root --global` 一致的真实 npm 全局安装。源码 checkout、npm link、使用符号链接的全局包以及其他包管理器布局都会被拒绝。预发布版本默认跟随 npm 的 `alpha` 标签，稳定版默认跟随 `latest`；可用 `--alpha`、`--stable` 或 `--version` 显式选择，降级还必须传入 `--allow-downgrade`。

修改当前安装前，CLI 会下载精确版本的 npm tarball，在当前 Profile 的 `updates` 目录中独立安装候选包，验证包身份以及 CLI 的版本和帮助输出，并同时保存当前包的完整副本与 npm 回滚 tarball。服务运行时会复用安全重启调度，等待活动任务、最终结果投递和静默窗口。随后，复制到安装目录外的独立执行器等待 Worker 和 Supervisor 退出，备份 SQLite 主文件及 WAL/SHM 文件，再安装已经验证的 tarball、复验全局安装，并在启动服务前调用新版本 CLI 的非交互式 `init --skip-feishu --json`。这个步骤会补齐 Profile 文件并刷新受管 Skill，但不会重复启动 Server，也不会在后台等待飞书授权。安装、初始化或启动失败时会恢复数据库并重新安装旧 tarball；如果 npm 回滚仍不能恢复可用服务，则直接从完整包备份启动旧版。`update.log`、`result.json`、包备份和数据库备份都会保留在 Profile 中用于排查。

## 开发与源码安装

```powershell
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npm link
```

`npm link` 会把当前 checkout 的 `agentbot` 主命令和已弃用的 `agent-bot` 兼容命令注册到全局。未执行时，可通过 `npm run cli --` 调用构建后的 CLI。`npm run dev` 运行单个前台 worker，`npm start` 在当前终端运行 supervisor。
