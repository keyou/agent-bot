# Agent Bot Technical Reference

English | [简体中文](technical-reference.zh.md)

This document covers deployment, configuration, runtime behavior, persistence, and integration details. For installation and everyday commands, start with the [README](../README.md).

## Runtime Architecture

Agent Bot is a Node.js 22+ ESM TypeScript application built around these components:

- The supervisor owns the long-running service and restarts the worker.
- The worker starts the configured Agent runtimes, Feishu transport, Console transport, local control server, and SQLite store.
- Feishu events and Console input are normalized into the same task controller.
- Presentation components maintain one progress card per turn and send the final Markdown response separately.
- App Server agents use the App Server protocol over stdio; other configured agents use ACP.

Relevant source areas:

| Area                | Responsibility                                                            |
| ------------------- | ------------------------------------------------------------------------- |
| `src/config/`       | YAML loading, environment expansion, validation, and path resolution      |
| `src/cli/`          | Initialization, app registration, app auditing, and service/task commands |
| `src/feishu/`       | Feishu WebSocket events, API calls, cards, images, and context keys       |
| `src/runtime/`      | Shared runtime abstraction                                                |
| `src/codex/`        | App Server protocol integration for Codex, TraeX, and compatible Agents   |
| `src/acp/`          | ACP process and JSON-RPC integration                                      |
| `src/proxy/`        | Tasks, turns, steering, queues, forks, and command execution              |
| `src/presentation/` | Turn-state reduction and outbound routing                                 |
| `src/state/`        | SQLite schema, migrations, routing, and delivery state                    |
| `src/supervision/`  | Safe restart and restart notifications                                    |

## User Data And Path Resolution

The default user-data root is `~/.agent-bot`. `AGENT_BOT_HOME` replaces that root.

The CLI also supports explicit directory-based profiles. Without `--profile`, commands use the main profile and the normal environment-based path rules. `--profile <directory>` pins both `AGENT_BOT_HOME` and `AGENT_BOT_CONFIG` for the command and every spawned supervisor or worker, with the configuration fixed at `<directory>/config.yaml`. It also clears inherited Feishu credential variables before loading the selected profile's `.env`, which prevents a secondary service launched from inside the primary Agent Bot process tree from accidentally reusing the primary bot. It cannot be combined with `--config`. Alternative profiles must be selected explicitly on every command; Agent Bot does not maintain a named-profile registry.

The CLI reads the system locale through Node.js internationalization support. Locales beginning with `zh` use Chinese interface text; English and every unsupported locale use English. This applies to help, status, progress, prompts, and CLI-owned errors. JSON field names and enum values are not localized. System-generated restart reasons remain Chinese because they are rendered in Chinese Lark status cards; an explicit `--reason` is preserved verbatim. `agentbot server status` reports the running worker's Lark App ID as `feishuAppId` in JSON; when the server is stopped or predates that health field, the CLI falls back to the selected profile's configured App ID. Its `agents` array reports each configured Agent process's PID and protocol-reported version; both are `null` until that Agent starts.

| Default path                         | Contents                           |
| ------------------------------------ | ---------------------------------- |
| `~/.agent-bot/config.yaml`           | Main YAML configuration            |
| `~/.agent-bot/.env`                  | Feishu credentials                 |
| `~/.agent-bot/data/agent-bot.sqlite` | Persistent task and delivery state |
| `~/.agent-bot/data/inbound-images/`  | Cached incoming images             |
| `~/.agent-bot/logs/agent-bot.YYYY-MM-DD.log` | Daily structured runtime logs      |

Configuration path precedence:

1. CLI `--profile <directory>` selects `<directory>/config.yaml`
2. CLI `--config <path>`
3. `AGENT_BOT_CONFIG`
4. `<AGENT_BOT_HOME>/config.yaml`, defaulting to `~/.agent-bot/config.yaml`

The default `.env` is always loaded from the Agent Bot home. YAML values in the form `${NAME}` are expanded from the process environment after `.env` loading.

Relative `storage.sqlitePath` and `logging.path` values resolve against the directory containing the loaded configuration file. `defaults.cwd` resolves against the process startup directory.

## Initialization

Early in initialization, `agentbot init` checks the supported Codex and TraeX CLIs in parallel and reports each installed version. Codex is compared with the latest stable `@openai/codex` package, while TraeX is compared with its Alpha channel. Missing or outdated Agents are gathered into one numbered list containing their exact install or upgrade commands. An interactive user can enter comma- or space-separated action numbers, `all`, or an empty answer to skip maintenance. Selected commands run sequentially with inherited stdio; skipped and failed actions are recorded and initialization continues. In a non-interactive terminal, commands are printed for manual use. With `--json`, progress and prompts use stderr and the final `agents` array records detection and assistance results. Codex upgrades first use `codex update` and fall back to the current npm package command when an older updater fails.

The first fresh interactive `init` and every explicit `--reset` also ask how group messages should be handled. Selecting all group messages writes `feishu.respondToAllGroupMessages: true` and makes `im:message.group_msg` part of the configuration audit. Selecting explicit @ mentions writes `false` and excludes that permission from authorization links, polling, and missing-feature warnings. A non-interactive first initialization or reset selects mention-only mode. Later initialization runs preserve the configured value without prompting.

After version and maintenance checks, a first fresh interactive `init` and every explicit `--reset` build the Profile's Agent configuration from the supported Agents that were actually detected with an installed version. Missing Codex or TraeX entries are not selectable. When multiple Agents are available, the user may select one or more by number or standard name; `all` or an empty answer selects all. Unselected Agent definitions are removed from the new configuration through a comment-preserving atomic YAML update. One selected Agent becomes the default automatically. When multiple Agents are selected, a second prompt chooses `defaults.agent` by number or standard name. Later upgrades and refreshes preserve both the configured Agent list and default without showing either selector, including custom Agents already present in the Profile. A non-interactive first initialization or reset configures every detected installed Agent and keeps the template default when selected, otherwise the first detected Agent. An existing Profile without a valid configured default fails with an instruction to set `defaults.agent` in `config.yaml`. JSON output reports the final names in `configuredAgents`, adds `configured` to each supported-Agent inspection, and returns `defaultAgent.name` plus `defaultAgent.status` (`selected` or `existing`).

`agentbot init` copies the packaged `config.example.yaml` and `.env.example` when their target files do not exist, creates the data and log directories, and restricts `.env` permissions where the platform supports POSIX modes.

When `config.yaml` already exists, `init` treats the packaged `config.example.yaml` as the configuration upgrade template. It parses both files as YAML and recursively adds missing mapping entries while preserving existing scalar values, sequences, comments, and custom entries. An existing `agents` mapping is treated as user-owned: template Agents that the user omitted are not re-added, while missing fields are filled for same-named Agents. A missing `defaults.agent` is not inferred because doing so could silently change the selected Agent. Invalid YAML is reported without replacing the existing file. Changed configuration is written through an atomic replacement, and a second run is idempotent. Use `--reset` when a complete replacement from the current template is intended.

When `.env` already exists, `init` appends active assignments missing from the packaged `.env.example`. Existing values, comments, ordering, and line endings are preserved, and commented optional examples are not enabled. The update uses the same atomic replacement behavior and is idempotent.

Credential behavior:

- Environment values take precedence over values in `~/.agent-bot/.env`.
- Both `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are required.
- One-click registration also stores the authorizing user's `open_id` as `FEISHU_USER_OPEN_ID`.
- When existing app credentials have no user Open ID, the first private-chat message with a valid `ou_` sender persists that sender atomically to the Profile `.env`; group messages and later users never replace it.
- Complete credentials are preserved unless `--reconfigure-feishu` is used.
- Missing or incomplete credentials cause a new app registration.
- Newly registered credentials are fsynced, atomically replaced in `.env`, and read back before configuration begins.

Initialization holds `~/.agent-bot/init.lock` so concurrent commands cannot create multiple apps, including commands that use different config paths. A lock left by a dead process is recovered on the next run, and credential temporary files left by an interrupted write are removed.

When complete credentials are absent, initialization uses Feishu one-click registration and prints its verification URL. In-progress registration codes are not resumed: if the process exits before the complete credential pair is persisted, the next run starts a new app registration. After credentials are persisted, initialization audits the currently published app version and can safely resume that audit after interruption.

Missing app configuration is handled in three stages:

1. Core configuration is requested and polled until basic messaging becomes available.
2. Remaining optional configuration is requested. The CLI prints the authorization URL, then immediately polls for up to five minutes. An interactive terminal offers only `Y` to skip optional authorization and continue; otherwise the user completes authorization in the browser while polling continues.
3. Only in all-group-message mode, the manually configured and published `im:message.group_msg` scope is requested last. Entering `Y` skips this step, and a timeout returns a partial result instead of failing initialization. Mention-only mode excludes the permission entirely.

Configuration supported by the one-click launcher is encoded in its `addons` manifest. When all-group-message mode is selected, the manual `im:message.group_msg` scope is excluded from that manifest because Feishu does not add it through one-click configuration. Instead, the CLI prints this app-specific, pre-filtered Developer Console URL during the final stage:

```text
https://open.feishu.cn/app/<appId>/auth?q=im%3Amessage.group_msg&op_from=openapi&token_type=tenant
```

The user must add the permission, publish the app version, and complete tenant approval when required. The final stage waits for up to five minutes for the permission to appear in the published version. Entering `Y`, reaching the timeout, or leaving the version unpublished returns a partial configuration result and warns that ordinary group messages which do not mention the bot are unavailable.

Optional polling failures and timeouts return a partial configuration result instead of failing initialization. When stdin is not an interactive terminal, no skip input is available and polling continues until configuration becomes active or times out. Verification URLs and prompts use stderr, so `--json` keeps its final stdout machine-readable.

The generated authorization links do not contain the app secret.

`agentbot --profile <directory> init --reset` fully resets an explicitly selected Profile. The Profile server must be stopped first. The command moves the active `config.yaml`, `.env`, `data/`, and `logs/` into a unique timestamped directory under `<profile>/.reset-backups/`, creates clean replacements from the packaged templates, and proceeds through normal initialization. Existing reset backups and unrelated files are retained. Because backups can contain old app secrets and conversation data, protect the Profile directory accordingly. The remote Feishu app is not deleted. `--reset --skip-feishu` creates a clean Console-only Profile, while `--reset` and `--reconfigure-feishu` cannot be combined.

After Feishu initialization succeeds, the CLI releases the initialization lock and starts the detached supervisor through the same readiness path as `agentbot server start`. It waits up to 45 seconds for the worker to connect to Feishu and become ready. If the selected profile is already running, no second supervisor is created; instead, initialization requests a safe restart so the current installed code and refreshed configuration are loaded after active work and final delivery finish. The JSON result reports this as `server.status: "restart-scheduled"`. `--skip-feishu` skips automatic server startup, and `--json` includes the resulting `server.status` without adding non-JSON output.

After the Server starts or a safe restart is successfully scheduled, `init` sends a Card 2.0 welcome card directly to `feishu.userOpenId`. The card uploads the packaged `assets/agent-bot-logo.png`, is always rendered in Chinese regardless of the CLI locale, and reports the installed version, default Agent, and configured Agents. When a safe restart is pending, the card says that the refreshed version takes effect after that restart instead of claiming it is already active. A Profile receipt at `<profile>/data/initialization.json` records the last successfully initialized package version so the card can distinguish first setup, version upgrade, and same-version refresh. Welcome delivery is reported in the JSON `welcome` object. A missing user Open ID or delivery failure produces an explicit warning without undoing completed configuration or stopping an already-ready Server; `--skip-feishu` records a skipped welcome.

`agentbot server autostart enable|status|disable` manages a Profile-specific operating-system registration. Windows first creates an `ONLOGON` Task Scheduler entry and falls back to a hidden per-user Startup-folder script when task creation is denied, macOS writes a `RunAtLoad` LaunchAgent, and Linux enables a systemd user unit. The registered command starts the Supervisor directly through `<profile>/autostart/supervisor-bootstrap.mjs`; the bootstrap stores only the Node executable, installed Supervisor path, Profile path, config path, and safe executable search path, clears inherited Feishu credential variables, and then lets the selected Profile load its own `.env`. LaunchAgent `KeepAlive` and systemd `Restart` are disabled because the Supervisor already owns Worker recovery and `server stop` must remain stopped until the next login or boot. Linux `--linger` runs `loginctl enable-linger` so the user unit can start before login; disabling Agent Bot autostart deliberately leaves this user-wide setting unchanged. Disabling autostart never stops the currently running Server. Status reports both OS registration/loading state and live Agent Bot readiness. Unsupported operating systems can inspect status but cannot enable registration.

## Feishu App Requirements

Core configuration required for basic messaging:

- Bot capability
- Persistent-connection event delivery
- `im.message.receive_v1`
- `im:message.group_msg` for all user messages in groups containing the bot, only when all-group-message mode is selected
- Tenant permission for private messages
- `im:message:send_as_bot` or a broader equivalent
- `application:application:self_manage` so initialization can inspect the published version

Optional configuration:

| Configuration                         | Enabled behavior             |
| ------------------------------------- | ---------------------------- |
| `im:chat:create`                      | `/newgroup` and `/forkgroup` |
| `im:chat:read`                        | Reading group metadata       |
| `im.chat.updated_v1`                  | Group-title synchronization  |
| `im:message.reactions:write_only`     | Processing-status reactions  |
| Message-read and resource permissions | Incoming and outgoing images |
| Image and chat permissions            | Generated group avatars      |
| `card.action.trigger`                 | Interactive card actions     |

Optional authorization failures are returned in the final initialization result with the affected feature names. Rerunning `agentbot init` repeats the audit.

## Configuration Model

The complete example is [config.example.yaml](../config.example.yaml). The main sections are:

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

New viewer links use a `/preview/<short-token>?path=<absolute-path>` shape. Windows paths use readable forward slashes, such as `D:/project/file.md`; only spaces and URL delimiter characters are percent-encoded. The short token is a truncated HMAC bound to the normalized absolute path, so changing either the token or path fails validation without requiring a link registry. The per-Profile signing secret keeps links valid after restart; legacy `/view/<encoded-path>?sig=...` links remain accepted. Viewer pages show the absolute local path in a compact sticky header. Common source, configuration, markup, shell, and data formats receive server-side syntax highlighting; large files fall back to plain text. Line anchors dynamically account for the sticky header height, append the selected line number to the header path, and keep that line visibly highlighted. File pages subscribe to a signed Server-Sent Events stream; content and metadata update in place while preserving the reader's vertical position, bottom-follow state, horizontal code scroll, and selected-line highlight.

`fileViewer` turns local non-image files and directories in final replies into signed, read-only HTTP links. The default `host: "127.0.0.1"` accepts connections only from the Agent Bot machine. With `0.0.0.0` or `::`, the server listens on every interface and automatically chooses a non-internal IPv4 link address in wired, Wi-Fi, other physical, then VPN order. Docker, Hyper-V, VMware, VirtualBox, WSL, loopback, and link-local interfaces are excluded; if no candidate remains, links fall back to loopback. `publicBaseUrl` has the highest priority and overrides automatic selection for domains, HTTPS reverse proxies, NAT, or port mappings. With `port: 0`, the first startup selects a free port and stores it in `<data>/file-viewer/port`; later restarts reuse it, while separate Profiles avoid a shared fixed port. The signing key is stored beside it as `secret`. File URLs can read only their signed absolute path. Directory URLs list direct children and allow downward navigation without exposing a parent-directory action. Text identity is detected from a content sample, and text pages preview the first 2 MiB with line anchors; images, PDFs, audio, and video use native browser previews; other binary files expose raw and download actions. Treat each signed URL as a bearer credential and do not share it publicly.

`feishu.respondToOwnerOnly` defaults to `true`. It compares each message sender and card-action operator Open ID with `feishu.userOpenId`, ignoring non-owner input before durable event claims, reactions, downloads, commands, or Agent work. Set it to `false` to allow other users. If it is enabled without a configured owner Open ID, all Feishu messages and card actions are ignored; configure `FEISHU_USER_OPEN_ID` or temporarily disable the restriction to bootstrap from a private message.

`feishu.respondToAllGroupMessages` defaults to `true` in the template, while first initialization and `init --reset` write the user's selected mode. Set it to `false` to ignore owner group messages unless they mention the current bot. The worker resolves the bot's Open ID at startup so mentioning another member does not trigger it. Owner private messages are unaffected. Initialization requests all-user group-message delivery only when this value is `true`; changing a mention-only Profile to `true` later requires rerunning `agentbot init` to add the permission.

`/mute` and `/mute on` persist mention-only response mode for the current base group; `/mute off` disables it. The group timeline and every topic share this state. While muted, messages that do not mention the current bot are ignored before event claims, reactions, activity tracking, image downloads, command parsing, or Agent calls. The command that disables mute must itself mention the bot. Private chats do not support `/mute`.

`feishu.groupNameFormat.project` and `projectless` control names created by NewGroup or ForkGroup for Project and Projectless tasks. Each template must contain exactly one `{taskname}` and may use these variables:

| Variable | Value |
| --- | --- |
| `{os}` | Current system: `win` on Windows, `mac` on macOS, and `linux` on Linux |
| `{agent}` | Configured Agent standard name, such as `codex` or `traex` |
| `{project}` | At most the final two Project path levels, limited to 15 characters; normally omitted from the Projectless template |
| `{taskname}` | New-task or fork-task title |
| `{date}` | Local date and time rendered with `dateFormat` |
| `{date:yyyy-MM-dd}` | A format override for this placeholder only |

Date formats support `yyyy`/`yy` for year, `MM`/`M` for month, `dd`/`d` for day, `HH`/`H` for hour, `mm`/`m` for minute, and `ss`/`s` for second. Uppercase `YYYY`, `YY`, `DD`, and `D` are also accepted. Other characters are emitted literally. Feishu's 60-character group-name limit still applies; Agent Bot truncates `{taskname}` first so configured prefixes and suffixes remain visible. The defaults exactly preserve previous group names. Rerunning `agentbot init` adds this section to an existing config without replacing user settings.

`feishu.thinkingCardLayout` defaults to `grouped`. The grouped renderer keeps Commentary and user steering messages visible, uses Commentary as the only execution-group boundary, uses only the latest native reasoning as each group title, and keeps every tool available inside the group. Command panels remove PowerShell launchers and POSIX command-string launchers such as `/bin/zsh -lc`, `/bin/bash -c`, and `/usr/bin/env sh -c` from both their titles and expanded command text without changing the command that is executed. Execution-group status is intentionally non-failing: while any child tool is running the group uses the running treatment, otherwise it settles to the neutral treatment; failed tools retain their own failure icon inside the group. Every execution panel is rendered with a collapsed default and a stable `element_id`; Agent Bot never changes the expanded flag based on tool status, user steering, or later Commentary, allowing the Feishu client to retain a user's manual expansion across full-card updates. Grouped pagination first renders complete tool panels, then fills pages from the newest end according to the rendered UTF-8 JSON size and component count. The activity area is limited to 24KB and 160 components, leaving headroom under Feishu's recommended 30KB card size and 200-component hard limit for the header, plan, files, and actions. Execution groups above eight tools are split into stable subpanels, but every tool keeps its expandable command, result, and image content. History pages are measured separately with complete native reasoning included. Set the option to `timeline` to use the unchanged original renderer and its 40-activity pages while the grouped layout is being refined.

Feishu local commands beginning with `!` are persisted under `command-jobs/` beside the configured SQLite file and run in detached Runner processes. They have no execution timeout and release the conversation message queue immediately after submission, so multiple commands may run concurrently. Each Runner persists status and writes both stdout and stderr chunks to one `output.log` in observed arrival order; the log compacts its middle after reaching 8 MiB while retaining the beginning and end. The Worker only polls these files and updates the original card, then reattaches to unfinished jobs after restart. The running card's `Cancel` action persists a cancellation request that makes the Runner terminate the command process tree. This background mode applies only to Feishu `!` commands; the synchronous `agentbot task shell` CLI behavior is unchanged.

`agentbot server start` requires both Feishu credentials. The worker starts the SDK's persistent connection without inspecting SDK logs or private connection state, then sends startup status cards as an outbound readiness check. Each startup card includes the Agent Bot version read from the installed package metadata. Every startup sends a card to every known private chat, regardless of recent activity, plus each non-topic group active during the minute before this Worker started. After a safe restart, it also sends to every conversation enrolled in that restart's notification set regardless of activity age. Topic routes retain their originating message anchor across the replacement Supervisor and receive the startup card as a reply in the original topic instead of creating a new root topic in the parent group. Safe-restart progress cards have a narrower audience: only conversations that explicitly requested the current restart receive and update them; recently active chats are not enrolled automatically. If the database has no eligible chat yet, it sends the startup card to `feishu.userOpenId` using an `open_id` private message. When startup notification targets exist, at least one card must be delivered before the server reports ready; individual target failures remain isolated. If neither a known chat nor `feishu.userOpenId` is available, startup continues without the outbound check. With `respondToOwnerOnly: false`, the first subsequent private message can persist the missing user Open ID for later startup notifications and CLI-created groups; the default owner-only mode requires the owner Open ID to be configured first. Missing credentials still fail startup with an initialization hint. `agentbot console` is the explicit local-only path and does not require Feishu credentials.

At least one agent must be configured. `defaults.agent` must name a configured agent.

## Agent Runtimes

The configured Agent standard name is the runtime isolation key. Every configured Agent owns a separate, lazily started child process and runtime instance, even when multiple Agents use the same `kind`. Tasks using different Agents never share a command, environment, protocol connection, session map, or event stream. Tasks using the same Agent share that Agent process while keeping separate protocol sessions.

`kind` selects only the connection adapter. An agent with `kind: "app-server"` uses its own App Server process, whether the executable is Codex, TraeX, or another compatible product. Agent Bot passes project directory, model, reasoning effort, permission mode, text input, and local images through the App Server protocol. `/sessions` aggregates tasks reported by every configured App Server Agent while preserving the owning Agent for Switch, Status, Stop, New, and Fork actions. The previous `kind: "codex"` value is normalized to `app-server` when existing profiles are loaded.

An agent with `kind: "acp"`, or without a `kind`, uses its own ACP process. Multiple tasks create separate ACP sessions on that connection. Agent-specific `env` values are added only to that Agent's environment.

Agent processes inherit ordinary parent-process variables. Before an App Server or ACP process is spawned, Agent Bot removes every inherited or Agent-configured variable whose name case-insensitively matches `FEISHU_*` or `AGENT_BOT_*`. It then injects this controlled, non-secret context:

```text
AGENT_BOT=1
AGENT_BOT_HOME=<active Profile root>
AGENT_BOT_CONFIG=<active config.yaml path>
AGENT_BOT_AGENT_NAME=<configured Agent standard name>
AGENT_BOT_LARK_APP_ID=<Lark App ID>
AGENT_BOT_LARK_BOT_OPEN_ID=<Lark bot open_id, when available>
AGENT_BOT_LARK_USER_OPEN_ID=<saved authorizing user open_id, when available>
```

The bundled skill uses `AGENT_BOT` to detect that it is running inside Agent Bot. The Lark App Secret, Supervisor state, restart reasons, and restart notification routes are never forwarded. Non-reserved values in `agents.<name>.env` remain the explicit way to configure environment required only by that Agent.

## Chat Routing

The message route determines the current task:

- A private chat body is isolated by its Feishu chat ID.
- A group timeline is isolated by its Feishu chat ID.
- A message with a thread ID is isolated as its own thread context.
- Console input uses a separate local context.

Commands, card callbacks, progress cards, and final responses stay on the originating route.

Starting a Feishu thread from a mapped user message, progress card, or final response does not immediately create a task. Slash commands execute while the thread remains unbound; commands that require a current task return binding guidance instead of targeting the parent conversation. The first ordinary Prompt lazily forks from the associated completed App Server turn. If no reliable source turn exists, it starts a fresh task. `/new` also starts a fresh task directly, and `/sessions` or `/switch` can bind an existing task without creating an intermediate fork.

`/forkgroup` has thread-aware source selection. An unbound thread, or a bound thread task with no completed turn of its own, forks directly from the thread's original anchor turn without creating an intermediate thread task. Once the thread task has completed a turn, `/forkgroup` uses its latest locally persisted completed turn. A newer active turn does not block the command and is excluded from the fork point.

Before forking a task that has never been bound to Agent Bot, Agent Bot reads metadata without Turns and pages backward through the lightweight `summary` Turn view only until it finds the latest completed Turn. It does not load the task's complete tool history as a Fork prerequisite. Agent Bot then sends the experimental `excludeTurns: true` field on every `thread/fork` request. This suppresses populated `thread.turns` in the response without changing the history copied into the fork. The App Server connection enables `experimentalApi`; no user-facing command option is required. If an older App Server explicitly rejects the lightweight Turn-list method or the `excludeTurns` field, Agent Bot falls back to the compatible complete-history read or Fork request. Timeouts, disconnects, and unrelated Fork errors are never retried because a timed-out Fork request may already have created a branch.

The new group's welcome message reports the persisted fork settings: Provider, model, reasoning effort, and permission type. Permission type is rendered as automatic execution or confirmation before execution.

## Turn And Message Behavior

- Plain text creates a task when the route has no current task.
- Text received during an active App Server turn is sent through steering.
- A steering race at turn completion becomes the next queued request.
- `/nosteer` always creates a persistent FIFO queue item.
- Queue card actions can cancel individual pending items.
- Exact slash command names take priority. Otherwise, a unique command-name prefix or registered compound-command initialism is expanded before argument parsing; ambiguous matches are rejected with their candidate commands. Registered initialisms are `fg` for `forkgroup`, `ng` for `newgroup`, and `ns` for `nosteer`.
- Unknown slash commands are rejected and never forwarded as Prompts.

Each turn owns one progress card. Normal updates are throttled to one every two seconds; critical updates have a 500 ms minimum gap. On completion, Agent Bot updates the progress card to a terminal state before sending a separate final Markdown message. Grouped thinking cards derive execution groups only while rendering; the persisted chronological activity stream remains layout-independent, so changing layouts or restarting a Worker does not discard reasoning or tool history.

Successfully completed progress cards include a `Reset` action with its compact effect warning directly below the action. `/turns` places the same effect warning at the top, refreshes the current task's completed Turns from App Server when needed, fills missing local index entries without replacing richer Agent Bot snapshots, and then presents the completed-turn snapshots in reverse chronological order, 10 per page. Remote refreshes are cached briefly so card pagination does not repeatedly load the same history; a failed refresh falls back to the locally available entries. Each `turn_started` event persists the previous completed turn as its parent. Existing tasks are backfilled from snapshot timestamps and `session_reset_to_turn` audits, so the first turn after a historical Reset points to the selected turn instead of the time-adjacent abandoned branch. The renderer computes lanes across the complete history before slicing a page, then displays true continuations and merges in the graph column, indented content in the second column, and state or action in the third. The current conversation point is marked instead of showing an action; every other turn has a `Reset` action. Pagination and successful Reset actions update the same card, remain bound to the task that opened it, and move the current marker to the selected turn. The success text identifies the target with its Prompt summary, completion time, and Turn ID. Agent Bot records the App Server thread that originally owned each turn, forks that thread through the selected turn, and replaces the current task's remote thread binding without changing its local task ID, title, Agent, project directory, execution settings, or chat routing. Existing snapshots after the selected turn are not deleted, so the card shows retained turns from the old path together with turns later completed on the new branch. Reset is rejected while the current task is active, and it never reverts local file changes. When a Reset begins, Agent Bot sends a notice immediately. Every message that arrives before the Reset finishes is acknowledged with a reaction, then waits for the new thread binding before further processing.

After the durable message-deduplication claim, Agent Bot awaits the `OnIt` reaction before chat persistence, image downloads, queue waits, command execution, or runtime calls. It replaces that reaction with `DONE`, `ERROR`, or `CrossMark` when the turn succeeds, fails, or is canceled. Reaction failures are logged but do not block task execution.

Commands that can wait on App Server, Feishu, process control, or file transfer send a short operation notice before the first potentially long call. This covers task creation and switching, Fork and group creation, Provider changes, task and Turn reads, status and Goal operations, title changes, archive and dismissal, stop, closing a thread writer, and file upload. Prompt turns, Shell commands, Reset, App Server release, and safe restart keep their existing progress cards or dedicated start notices instead of sending a duplicate notice.

Incoming Feishu rich-text `code_block` elements are converted to fenced Markdown with their language and original indentation preserved; `md` elements remain Markdown. The same conversion applies when rich-text messages are quoted or included in merged forwards. Rich-text images are downloaded into the inbound image cache and passed to the App Server as `localImage` inputs. An image-only message uses the default Prompt `请查看这张图片`. An ACP runtime that cannot accept image input returns an explicit error.

## Tasks, Projects, And External App Server Work

`/sessions` reads tasks through `thread/list` from every configured App Server Agent. For Codex, this includes tasks created by Codex Desktop, CLI, Agent Bot, or another App Server client under the same `CODEX_HOME`; other Agents expose their own task stores through the same protocol. Tasks are sorted globally before pagination: the current task first, then other active tasks, followed by idle tasks in descending last-activity order. The first ten global results determine page membership. Those visible tasks are then grouped by project in first-appearance order, with each project's tasks kept in descending activity order. Expanding a task directly shows the first 50 Unicode characters of its latest user Prompt without a field label, followed by its update time and action menu; runtime IDs, directory, loading state, and other status details remain in the dedicated Status view. `Previous` and `Next` replace the current card contents instead of appending more tasks, while preserving search terms and task numbers that match the displayed order.

Each project row exposes `New` and `NewGroup` through one compact menu, while each task keeps its existing task actions. Cards carry only short action tokens. The selected task ID, source context, search term, and page are stored in SQLite by card message ID and restored when Lark sends the callback, so card payloads remain bounded and existing cards continue to work after a service restart. The Lark operator `open_id` is used to invite the user to a new group. `NewGroup` resolves the selected task's project and execution settings; `ForkGroup` resolves its latest available completed turn.

Every `agentbot task` operation accepts `--task <task>` and retains the legacy leading positional task reference. Inside an Agent Bot-started Agent, omitting both resolves the current task from the Codex or TraeX App Server Thread ID. Outside Agent Bot, an explicit task remains required. The CLI exposes group operations through `agentbot task newgroup [task] [title] [--agent <name>] [--dir <cwd> | --nodir]` and `agentbot task forkgroup [task] [title]`. Both commands require a running Server and send the stable local task ID over the Profile's local control endpoint. Since a CLI process has no Lark operator, the Server invites `feishu.userOpenId`, which initialization stores as `FEISHU_USER_OPEN_ID`. New-group creation inherits the selected task's Agent and execution settings by default. `--agent <standard-name>` selects another configured runtime while retaining the source project shape; execution settings are omitted so that runtime applies its own defaults. ForkGroup uses the source task's latest available completed turn and leaves an active source turn running. Both control responses include the new chat, group context, source task, and created task; `--json` prints that structure without localization.

## App Server Provider Settings

Provider is stored on each task alongside model, reasoning effort, and permission mode. Each Agent can also keep these values under `agents.<name>.defaults`. New tasks start from the selected Agent's saved defaults, then override them with explicit or same-Agent inherited task settings. Agent Bot passes the resolved settings through `thread/start`, `thread/resume`, and `thread/fork` and persists the effective values returned by the runtime on the task.

`/provider`, `/model`, `/thinking`, and `/permissions` open one Card 2.0 execution-settings surface with the matching tab active. All four commands reject arguments; tab navigation and setting changes use card callbacks only. Provider choices come from App Server `config/read`; for Codex, Agent Bot also keeps the implicit built-in `openai` Provider available when it is absent from the explicit `model_providers` map. A Provider change resumes the thread with the selected Provider and the current compatible model, reasoning effort, and permission mode. Every successful Provider, model, reasoning, or permission change updates the current task, atomically writes the complete effective setting group to that Agent's defaults in `config.yaml`, refreshes the same card in place, and applies from the next request. The equivalent CLI task-setting commands use the same persistence path.

Agent Bot keeps a local routing key for Feishu cards and delivery state, but presents the owning App Server's task ID to users. It does not resume, steer, stop, or fork externally running Agent work without an explicit user action.

Project behavior:

- `/new --dir <path>` creates a project task.
- `/new --nodir` creates a Projectless task.
- `/new` inherits the current task's project or Projectless shape.
- A first Projectless task is created under `~/Documents/Codex/<date>/<task-name>`.
- An existing task's working directory is immutable.

Forks use the latest available completed turn and do not interrupt an active source turn.

## Persistence And Recovery

SQLite stores:

- Current and previous tasks for each route
- Local and App Server task/thread identifiers
- Model, reasoning effort, and permission mode
- Queued Prompts
- Accepted/running turn attempts, including the original route, Prompt, images, and message anchor
- Progress snapshots and message bindings
- Final-message delivery records

On every Worker startup, Agent Bot scans nonterminal turn attempts before releasing persisted Prompt queues. Only attempts with activity during the preceding five minutes are eligible; runtime events and a one-minute heartbeat refresh the durable activity timestamp while a turn remains active. Older unfinished attempts are marked interrupted without a recovery notification or continuation. Eligible recovery first notifies the original private chat, group, or topic. A remotely completed turn is synchronized and only its pending final delivery is resumed. A remotely active turn is reattached to a new progress card and polled until terminal. A stale App Server turn or an interrupted ACP process is continued in the same task and workspace with a new turn and a new progress card; the continuation Prompt tells the Agent to inspect existing effects before repeating work. Recovery retries remain durable across repeated restarts.

When a turn ends with a transient LLM-service failure, Agent Bot automatically starts up to three additional turns in the same task. Rate limits, temporary overload, upstream 5xx responses, timeouts, and interrupted provider streams are retryable. Authentication, quota exhaustion, context limits, invalid requests, unsupported models, permissions, policy failures, and tool errors are terminal immediately. Every retry gets a fresh progress card and a Prompt that warns the Agent to inspect existing effects before repeating work. The retry count and pending message bindings are persisted; original and steering-message reactions remain pending and follow the newest retry turn until it succeeds or exhausts the retry budget.

Agent Bot also reconciles when turn identifiers change, terminal notifications arrive, or control requests fail. Stale persisted `inProgress` turns are not considered active unless the App Server thread itself reports an active status.

The final-delivery ledger prevents duplicate successful replies. App Server requests use finite timeouts so a stalled request cannot permanently occupy a message route. Session lifecycle requests allow 60 seconds because compatible third-party Agents may need more than 30 seconds for `thread/start`; control requests remain shorter.

## Supervisor And Restart

`agentbot server start` starts a detached supervisor. The supervisor restarts the worker after unexpected exits and applies exponential backoff from one to 30 seconds after repeated crashes.

On Windows, the CLI refreshes Machine and User environment variables before the initial Supervisor launch, a Worker refreshes them before launching a replacement Supervisor, and the Supervisor refreshes them before every Worker launch. Fresh values override inherited values, while `PATH` retains process-only entries after the current Machine and User paths. `AGENT_BOT_*` and `FEISHU_*` values remain process-local so an active Profile cannot accidentally switch data roots or bot credentials. A registry-read failure falls back to the inherited environment without blocking startup and is recorded when a runtime logger is available.

Supervisor crash diagnostics are isolated to the selected profile:

- `logs/supervisor.YYYY-MM-DD.log` permanently records worker PIDs, exit codes, uptime, restart delays, and diagnostic artifact paths.
- `logs/worker.stderr.YYYY-MM-DD.log` captures Node/V8 fatal output that would otherwise be lost by the detached process. Both diagnostic logs are split by local calendar day and retain the existing 10 MiB backup rotation within a day.
- `data/last-crash.json` points to the latest unexpected worker exit, while timestamped `data/crash-reports/crash-*.json` files preserve the history.
- `data/crash-reports/report.*.json` contains Node diagnostic reports when Node can generate one.

The supervisor, worker, replacement supervisor, and Console worker enable Node reports for fatal runtime errors and uncaught exceptions by default. Supported Node versions also exclude environment variables and network interfaces so credentials are not copied into reports. Intentional restart exit code `75` and stop exit code `76` do not create crash manifests.

A safe restart waits for:

1. Active tasks to finish
2. Final responses to be delivered
3. A 15-second quiet inbound-message window

The Feishu `/restart` command uses this safe path by default; `/restart --force` restarts immediately and may interrupt active work. The command rejects every other argument. New messages reset the quiet timer. CLI `--immediate` and `--force` also skip these checks. Exit code `75` identifies an intentional worker restart.

A pending safe-restart schedule accumulates the exact notification route of every conversation that triggers it. Every inbound user message, including slash commands, marks its base private or group conversation active. Each enrolled route receives its own status card and final restarting acknowledgement and remains enrolled until the schedule ends. Repeated routes are deduplicated; when a topic route was first discovered without a message anchor, a later anchored trigger upgrades it. Topic requests retain the originating message ID and use a thread reply so restart updates cannot fall back to the group body. Each route also retains the reason supplied by that conversation, so a later request elsewhere cannot overwrite an earlier card with an unrelated reason. Before replacement, Agent Bot passes every complete route, including topic message anchors, through the replacement Supervisor and uses the same route for the post-restart startup card. The Supervisor retains the routes until the Worker has remained stable for 60 seconds, so an early crash-driven relaunch does not lose required recipients.

Use `agentbot server restart --task <task>` to override a CLI restart's notification target. Task numbers, full IDs, and unambiguous ID prefixes are resolved before the control request is sent. Without `--task`, an Agent Bot-started Agent resolves its source task through the injected Codex or TraeX App Server Thread ID and returns the status card to that task conversation. An ordinary terminal has no source task, so the Server sends the card to the configured `feishu.userOpenId` private chat. If no user Open ID is configured, that terminal request fails with an initialization hint instead of silently dropping the card.

The first safe-restart status card is delayed by three seconds so a task's final response can usually arrive first. Status changes during that window are coalesced into the initial card. The delay does not block scheduler polling, and shutdown flushes any pending card immediately.

Pending safe-restart cards include a bottom `Cancel` action. The action carries the scheduler's monotonic schedule ID, so an old card cannot cancel a newer restart. A successful cancellation updates every enrolled conversation's existing status card in place and removes the action; the action is also absent once the scheduler enters the irreversible restarting phase.

The local control server implements task mutations, task-targeted NewGroup and ForkGroup operations, and service restart requests. Read-only task queries access SQLite directly.

## Permission Modes

- `auto`: the App Server Agent runs with `approvalPolicy=never` and `danger-full-access`.
- `confirm`: approval requests are presented through card actions for one-time approval, session approval, denial, or task cancellation.

Model, reasoning effort, permission mode, and project shape are inherited where applicable when creating or forking tasks.

## Managed System Skill

Every successful `agentbot init` installs or refreshes the packaged Agent Bot skill in the shared agent skill directory. The same managed installation can also be controlled explicitly:

```powershell
agentbot skills install
agentbot skills status
agentbot skills uninstall
```

The default target is `~/.agents/skills`. `AGENT_BOT_SKILLS_DIR` or `--target` selects another root. Installation is a managed copy; uninstall does not remove an unrelated same-named directory.

## npm Package And Releases

The public package is `@keyou007/agent-bot`; its primary executable is `agentbot`. The deprecated `agent-bot` executable remains as a forwarding compatibility entry and prints a localized warning before each invocation. The package uses a `files` allowlist so runtime code, templates, the managed skill, source code, and user-facing documentation are published without tests or internal design plans.

`npm-shrinkwrap.json` is published with the CLI to keep transitive runtime dependencies reproducible. Direct runtime and development dependencies are also pinned to exact versions.

Package lifecycle:

- `prepublishOnly` runs type checking and the full test suite.
- `prepack` builds a clean `dist/` and validates the tarball manifest.
- `npm run package:smoke` packs the project, installs the tarball into a temporary directory, runs the CLI, and performs Console-only initialization.

Prepare the next Alpha release from a clean worktree:

```powershell
npm run release
git add package.json npm-shrinkwrap.json CHANGELOG.md
git commit -m "release: v0.1.13-alpha.0"
git push origin master
```

`npm run release` now defaults to the Alpha channel. A stable `0.1.12` becomes `0.1.13-alpha.0`; a current `0.1.13-alpha.0` becomes `0.1.13-alpha.1`. `npm run release:alpha` is the explicit equivalent. Use `npm run release:stable` to promote the current Alpha to its stable core version, or to increment the patch when the current version is already stable. `patch`, `minor`, `major`, and exact stable or `-alpha.N` versions remain available through `npm run release -- <version>`. Every release moves the current `Unreleased` entries into a dated version section. The command refuses to modify a dirty worktree or publish an empty changelog.

No local publish command is required after the push. When CI succeeds for a first-party push to `master`, `publish.yml` checks the package version against npm. An existing version is skipped successfully. An unpublished stable or Alpha version requires a matching `CHANGELOG.md` section, then runs verification and the package smoke test before publishing. Alpha versions use npm's `alpha` dist-tag and create a GitHub prerelease; stable versions use `latest` and create a regular GitHub Release.

The workflow can also be retried manually from **GitHub Actions → Publish to npm → Run workflow** on `master`. Pull requests, forked repositories, failed CI runs, and pushes to other branches cannot enter the publish job.

The npm Trusted Publisher is configured for:

- GitHub owner: `keyou`
- Repository: `agent-bot`
- Workflow: `publish.yml`
- Allowed action: `npm publish`

The publish workflow uses GitHub OIDC instead of a long-lived npm token and publishes from a GitHub-hosted Node.js 24 runner.

### Installed-package self-update

`agentbot update` accepts only a real global npm installation whose package directory matches `npm root --global`. It refuses source checkouts, npm links, symlinked global packages, and other package-manager layouts. A prerelease installation follows npm's `alpha` tag by default; a stable installation follows `latest`. `--alpha`, `--stable`, and `--version` override selection, while a downgrade additionally requires `--allow-downgrade`.

Before touching the active installation, the CLI downloads the exact npm tarball, installs it under the active Profile's `updates` directory, validates package identity plus CLI version/help, copies the complete current package, and creates an npm rollback tarball. If the service is running, the existing safe-restart scheduler waits for active tasks, final delivery, and the quiet window. A standalone copied runner then waits for the Worker and Supervisor to exit, backs up the SQLite database together with its WAL/SHM files, installs the already-validated tarball globally, validates the installed files again, and runs the updated CLI's non-interactive `init --skip-feishu --json` before starting the service. This refreshes Profile files and the managed Skill without starting a duplicate Server or waiting for Lark authorization. Failed installation, initialization, or activation restores the database and reinstalls the old tarball; if that rollback cannot restore a runnable service, the runner starts the complete package backup directly. The operation's `update.log`, `result.json`, package backup, and database backup remain under the Profile for diagnosis.

## Development And Source Installation

```powershell
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npm link
```

`npm link` registers the checkout's `agentbot` executable and deprecated `agent-bot` compatibility executable globally. Without it, built CLI commands can be invoked through `npm run cli --`. `npm run dev` runs one foreground worker, while `npm start` runs the supervisor in the current terminal.
