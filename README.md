<p align="center">
  <img src="assets/agent-bot-logo.png" alt="Agent Bot Logo" width="180">
</p>

# Agent Bot

Use local Codex, TraeX, and compatible ACP agents through Feishu.

[Website](https://keyou.github.io/agent-bot/) | English | [简体中文](README.zh.md)

Agent Bot runs on your computer and connects a Feishu bot to your local coding agents. Send a message to start working; the bot updates a progress card while the agent runs and sends the final answer as Markdown.

## What You Can Do

- Use your existing local Codex or TraeX login from Feishu
- Create, continue, switch, fork, and stop tasks
- Reset the current conversation from any successfully completed progress card
- Collaborate with text, images, files, quoted messages, merged-forwarded chat records, group chats, and topics
- Queue follow-up Prompts or add instructions while a task is running
- Automatically retry temporary model-service failures
- Continue existing work after Agent Bot restarts
- Run through the local Console UI without Feishu

## Quick Start

### Requirements

- Node.js 22 or later
- At least one supported App Server Agent: Codex or TraeX
- Codex 0.153.4 or later when using Codex (TraeX and ACP Agents have separate versions)
- A completed local login for the Agent you plan to use

Check the installed Agents and their login status:

```bash
codex --version
codex login status
traex --version
traex login status
```

You can continue once either Codex or TraeX is ready. `agentbot init` checks both and can help install or upgrade them.

### Install

```bash
# Install the stable version
npm install --global @keyou007/agent-bot
# Install the Alpha version to try the latest features
# npm install --global @keyou007/agent-bot@alpha
agentbot --version
agentbot --help
```

See the [technical reference](docs/technical-reference.md#development-and-source-installation) to install from source.

### Initialize

```bash
agentbot init
```

Initialization detects Codex and TraeX and reports their installed versions. Missing or outdated Agents are listed with the appropriate install or upgrade commands. Agent Bot saves its configuration to `~/.agent-bot/config.yaml`.

Codex's minimum supported version is checked locally even when the npm registry is unavailable. An older Codex cannot be selected during fresh setup; existing Profiles using it must upgrade before initialization continues. The runtime also checks the actual App Server version at startup and reports an upgrade instruction instead of using legacy full-history fallbacks. Run `codex update` (or `npm install -g @openai/codex@latest`), then safely restart Agent Bot.

In an interactive terminal, initialization uses a guided flow for Agent selection, Lark bot creation, and permissions. After the ordinary one-click authorization is complete, the wizard asks how group messages should be handled. The final permission that requires manually publishing an app version appears only when receiving every group message is selected.

1. **Create the bot.** This creates a Feishu app with the standard basic messaging configuration and saves its App ID, App Secret, and authorizing user. This step cannot be skipped because Agent Bot cannot connect to Feishu without it. Permissions already provided during creation are not repeated below.
2. **Add the remaining permission, event, and callback.** This step adds only:

    | Type | Permission, event, or callback | Purpose |
    | ---- | ------------------------------ | ------- |
    | Permission | `im:chat:delete` | Let `/dismiss` dissolve a group created and owned by the bot. Without it, other Agent Bot features still work. |
    | Event | `im.chat.updated_v1` | Detect group renames and synchronize them to Agent task titles. |
    | Callback | `card.action.trigger` | Enable card button interactions. |

3. **Optionally add the all-group-message permission.** This final step appears only after choosing to receive all group messages. The `im:message.group_msg` permission lets Agent Bot receive ordinary group messages that do not @ the bot, and Feishu requires it to be added manually in the Developer Console and published in an app version. Entering `Y`, reaching the timeout, or leaving the version unpublished does not fail initialization; group conversations simply remain mention-only. Mention-only mode never requests this permission.

After these steps, the `~/.agent-bot` directory is initialized and Agent Bot starts immediately. Every successful `agentbot init` sends a private welcome card containing the Agent Bot logo. The first card introduces the main capabilities; after an upgrade it highlights the new version, while a same-version rerun confirms that the Profile was refreshed.

Agent Bot includes a keepalive mechanism that automatically reconnects after Agent Bot, Codex, or TraeX crashes.

### Start And Stop

Start the service:

```bash
# agentbot init starts the Server automatically, so manual startup is usually unnecessary.
agentbot server start
```

Check the service status:

```bash
agentbot server status
```

Stop the service:

```bash
agentbot server stop
```

Safely restart the service:

```bash
agentbot server restart
```

It waits for currently running Agent tasks to finish before restarting, allowing every task to complete normally. When an Agent invokes the CLI, the status card returns to its source task; from an ordinary terminal it goes to the configured user's private chat. Add `--task <task>` to override either destination. When triggered from a Feishu topic, both restart status and the post-restart startup card return to that topic.

To start Agent Bot automatically at user login:

```bash
agentbot server autostart enable
agentbot server autostart status
agentbot server autostart disable
```

Autostart is configured separately for each Profile. Disabling it does not stop the currently running Server.

### Update Or Uninstall

The recommended way to update a global npm installation is:

```bash
agentbot update
```

Stable installations check the stable channel by default; Alpha installations stay on the Alpha channel. Use `--stable`, `--alpha`, or `--version <version>` to choose explicitly. When the service is running, Agent Bot sends a safe-restart card, waits for active tasks to finish, updates, and restores the service automatically. If no task is active, the update restarts the service immediately. Source checkouts and `npm link` installations are never modified by self-update.

To replace the global package manually, stop the running service first:

```bash
agentbot server stop
npm install --global @keyou007/agent-bot@latest
agentbot init # Update the Profile and start the Server
```

To uninstall, remove the startup registration and stop the service first:

```bash
agentbot server autostart disable
agentbot server stop
npm uninstall --global @keyou007/agent-bot
```

Uninstalling the npm package does not delete user data under `~/.agent-bot`.

### Multiple Profiles

Multiple Profiles let you run several independent Agent Bot instances on the same device without interfering with one another.

Create a new Profile with:

```bash
# Select a new Profile directory and initialize a new bot
agentbot --profile ~/.agent-bot-rescue init
agentbot --profile ~/.agent-bot-rescue server start
agentbot --profile ~/.agent-bot-rescue server status
agentbot --profile ~/.agent-bot-rescue server autostart enable
```

Commands without `--profile` use the main Profile at `~/.agent-bot`.

Each Profile stores its own `config.yaml`, `.env`, `data/`, and `logs/` in the selected directory. Feishu credentials and local control endpoints are isolated as well.

### Reset A Profile

To completely reconfigure the default Profile, stop its Server and run reset without `--profile`:

```bash
agentbot server stop # Stop the default Profile Server
agentbot init --reset # Reset the default Profile
```

Use `--profile <directory>` with both commands to reset another Profile.

Reset moves the current `config.yaml`, `.env`, `data/`, and `logs/` into `.reset-backups`, then creates clean files and directories. Existing backups are retained permanently and are not overwritten or cleaned by later resets. The old remote Feishu app is not deleted.

Reset does not remove Codex or TraeX chat sessions. It only recreates the Feishu bot and clears Agent Bot's local data.

## Daily Commands

### Console UI/TUI

```bash
agentbot console
```

The Console UI does not require Feishu credentials. It does not share task state with a running Server unless `--force` is supplied.

### Task Management

```bash
agentbot task list
agentbot task current [--json]
agentbot task status [task]
agentbot task prompt [task] "<prompt>"
agentbot task new [task] [title] [--agent <standard-name>] [--dir <path> | --nodir]
agentbot task newgroup [task] [title] [--agent <standard-name>] [--dir <path> | --nodir]
agentbot task fork [task]
agentbot task forkgroup [task] [title]
agentbot task queue [task] "<prompt>"
agentbot task model [task] [model]
agentbot task goal [task] [action-or-objective]
agentbot task turns [task]
agentbot task reset [task] <Turn ID>
agentbot task dir [task] [directory]
agentbot task file [task] <path>
agentbot task title [task] "<title>"
agentbot task stop [task]
agentbot task archive [task]
agentbot task dismiss [task] --yes
```

Inside an Agent started by Agent Bot, `[task]` defaults to the current task; use `--task <task>` to target another task explicitly. A regular terminal must supply a task. `task current` shows the automatically detected task details. A task reference can be a number from `task list`, a task ID, or an unambiguous task-ID prefix. Every Feishu task, fork, queue, Agent, Provider, model, thinking, permission, Goal, historical Turn, Reset, group mute, group dismissal, directory, file, shell, and restart operation has a CLI counterpart. Run `agentbot --help` for the complete list and options.

`task newgroup` creates a Feishu group and a new task. By default, it inherits the source task's Agent and execution settings. `--agent <standard-name>` selects another configured Agent; the source project shape is still inherited, while Provider, model, reasoning effort, and permission mode use the target Agent's saved defaults. `--dir` overrides the project directory and supports `~`; `--nodir` forces a Projectless App Server task. Project and Projectless group names can be customized separately through `feishu.groupNameFormat`. `task forkgroup` forks from the source task's latest available completed turn without interrupting an active turn. Both commands require the Server to be running, invite the authorizing user saved in the Profile, leave the source conversation on its current task, and support `--json`.

## Feishu Commands

Send a message beginning with `/` to run a command. Use `/help` in Feishu for the latest command list.

| Command                                       | Purpose                              |
| --------------------------------------------- | ------------------------------------ |
| `/new [title] [--dir <path> \| --nodir]`      | Start a new task                     |
| `/dir [path]`                                 | Browse files or start work in a directory |
| `/file <file-path>`                           | Send a file to the current Feishu conversation |
| `/sessions [keyword]`                         | Find and manage tasks                |
| `/archive [task]`                             | Archive the current or selected task |
| `/dismiss`                                    | Archive the current task and dissolve the group after confirmation |
| `/switch [task]`                              | Switch tasks or return to the previous task |
| `/fork [task]`                                | Branch a task                        |
| `/turns`                                      | Restore an earlier conversation turn |
| `/status [task]`                              | View task status                     |
| `/title <title>`                              | Rename the current task              |
| `/stop`                                       | Stop the current execution           |
| `/queue <prompt>`                             | Run a Prompt after the current turn  |
| `/nosteer <prompt>`                           | Same as `/queue`                     |
| `/goal [objective]`                           | Manage a long-running objective      |
| `/provider`                                   | Choose a Provider                    |
| `/model`                                      | Choose a model                       |
| `/thinking`                                   | Set reasoning effort                 |
| `/permissions`                                | Set execution permissions            |
| `/agent [name]`                               | Choose the Agent for new tasks       |
| `/newgroup [title] [--dir <path> \| --nodir]` | Start a task in a new private group  |
| `/forkgroup [title]`                          | Branch a task into a new private group |
| `/restart [--force]`                          | Restart safely, or interrupt with `--force` |
| `/release`                                    | Release Agent Bot's App Server tasks for Desktop |
| `/mute [on\|off]`                            | Require @ mentions in the current group |
| `/help`                                       | Show command help                    |

Private chats, group timelines, and topics keep separate current tasks. A new topic remains unbound while you use commands such as `/help`, `/status`, or `/sessions`; those commands do not create a hidden fork. Its first ordinary message forks from the mapped source turn, or starts a fresh task when no source turn can be identified. `/new` starts a fresh topic task, while `/sessions` can bind an existing task. Commands that require a current task explain how to bind one instead of operating on the parent conversation. Ordinary messages sent while a task is running add instructions to that turn; use `/queue` when the message should run afterward as a separate turn.

`/release` sends a card for releasing the shared App Server used by the current task's Agent so its tasks can be opened in Codex Desktop. The card lists blocking task names and keeps them updated. Agent Bot never releases automatically: click **Release** when idle, or **Release Now** to interrupt active work and clear queued Prompts. **Cancel** cancels the pending release. Releasing does not archive or delete task history, but it affects every task loaded by that shared App Server.

Topic replies check whether the root message is already in the task's history using lightweight Turn links, without loading the full history before sending the thinking card. Legacy parent links are repaired only when needed.

In a group, `/mute` and `/mute on` make the bot process only messages that mention it. Mention the bot and send `/mute off` to restore automatic responses. The setting applies to every topic in that group.

`/new` and `/newgroup` inherit the current Agent, project, and execution settings. Use `--dir` to choose another directory or `--nodir` to start without a project directory; `~` represents your home directory.

`/file` accepts relative paths, absolute paths, and paths beginning with `~`; relative paths resolve from the current task directory.

`/fork` and `/forkgroup` branch from completed work without interrupting a running turn. `/sessions` manages tasks across projects in pages of up to 10 tasks; use each project menu for `New` and `NewGroup`. Expanding a task directly shows the first 50 characters of its latest user Prompt, its update time, and task-specific actions. `/turns` restores conversation context without reverting local files.

Fork creation records the source task and branch Turn without synchronizing the local history list. Agent-side conversation inheritance is unchanged. Opening `/turns` reuses local history first and requests only the Turn-summary pages needed for the selected card page, bounded by the branch Turn. Older history is loaded only when needed for later pages; `agentbot task turns` loads the first page if necessary and returns the available local records. Failed history reads remain retryable, and Agents without summary pagination do not trigger a full-history fallback.

Ordinary tasks also load history as summary pages on demand. Task lists read only the latest Turn summary; metadata lookups do not request Turns. Status and recovery read at most the latest Turn's complete result and reuse the reconciliation result when available. Local Turn cards read the graph's IDs and timestamps, then only the visible page's Prompt summaries, without loading historical tool outputs. Codex activity detection caches unchanged rollout files and incrementally scans appended content.

## Local Commands

Enter a message beginning with `!` directly in the Feishu chat box to run a local command in the current task directory.

For example, `! ls` lists files in the current directory, and `! git status` shows the state of the current Git repository.
Local commands run in independent background processes without a time limit, so they do not block other messages or commands in the current conversation. The same output card refreshes while a command runs, preserves the observed order of normal and diagnostic output, and includes a `Cancel` action. Agent Bot resumes monitoring commands that are still running after a Worker restart. Long output keeps its beginning and end while the middle is truncated.

## Configuration And Data

Agent Bot keeps user-owned files outside the repository:

| Path                       | Purpose                     |
| -------------------------- | --------------------------- |
| `~/.agent-bot/config.yaml` | Agent Bot configuration     |
| `~/.agent-bot/.env`        | Feishu credentials          |
| `~/.agent-bot/data/`       | Task data and cached inputs |
| `~/.agent-bot/logs/`       | Daily runtime logs          |

Set `AGENT_BOT_HOME` to use another user-data directory. See [config.example.yaml](config.example.yaml) for configuration examples.

Local non-image files and directories referenced in Agent replies become signed, read-only viewer links for source code, Markdown, logs, PDFs, common media files, or downward directory browsing. By default, links open only on the computer running Agent Bot. Setting `fileViewer.host` to `0.0.0.0` automatically selects a LAN address in wired, Wi-Fi, other physical, then VPN order. Use `fileViewer.publicBaseUrl` to override that address for a domain, HTTPS reverse proxy, or port mapping.

Markdown previews keep table cells at their content width. Wide tables scroll horizontally within the preview instead of squeezing columns on narrow screens, and live updates preserve each table's horizontal scroll position.

Local links in rendered Markdown open signed viewer pages for the referenced files or directories. Relative paths resolve from the Markdown file's directory; absolute paths, `file://` URLs, and line references are supported, and local images load through the same read-only service. Web links and the original code view are unchanged. Sharing a Markdown viewer link also gives its readers access to the local paths referenced in that document, so only share trusted documents.

Provider, model, reasoning effort, and permission choices apply to the current task and are also saved under that Agent's `defaults`. If an older configuration has no `defaults` section for that Agent, it is created automatically on the first change. Future tasks that have no same-Agent settings to inherit start with those saved defaults; each configured Agent keeps its own values.

`feishu.groupNameFormat` defines separate name templates for new Project and Projectless groups, with variables for the operating system, Agent, project, task name, and date. See the [technical reference](docs/technical-reference.md#configuration-model) for the complete format.

Agent processes inherit ordinary parent-process variables and their explicit `agents.<name>.env` settings. Before starting an Agent, Agent Bot removes inherited `FEISHU_*` credentials and internal `AGENT_BOT_*` state, then provides only namespaced, non-secret Profile and Lark identity context. `FEISHU_APP_SECRET` is never forwarded to an Agent process.

By default, `feishu.respondToOwnerOnly: true` accepts only messages and card actions from the bot owner identified by `feishu.userOpenId`; other users are ignored before any processing reaction is added. Set it to `false` to allow collaborators. When enabled without an owner Open ID, all Feishu user input is ignored until the owner is configured.

Agent Bot responds to ordinary owner messages in groups containing the bot. Set `feishu.respondToAllGroupMessages` to `false` to additionally require the owner to @ the bot in groups; private chats are unchanged. Initialization requests the manually published all-group-message permission only when this option is enabled. After changing it from `false` to `true`, rerun `agentbot init` and complete the final permission step.

Thinking cards use the grouped layout by default: auxiliary Commentary and user steering remain visible, while each execution group shows only its latest native reasoning and expands to reveal complete tool commands and results. Common PowerShell, zsh, bash, and sh launcher prefixes are omitted from the displayed commands. A failed tool remains marked inside its own tool panel but does not turn the complete execution group red or give the group a failure icon. Execution groups start collapsed and keep stable component identities so a group manually opened in Feishu stays open across card updates. On long turns, pagination measures the fully rendered card content instead of using fixed message or tool counts. Set `feishu.thinkingCardLayout` to `timeline` to temporarily restore the original layout.

## Troubleshooting

- **The bot does not respond:** run `agentbot server status` and check today's `~/.agent-bot/logs/agent-bot.YYYY-MM-DD.log`
- **The Worker restarted after a Node crash:** check `~/.agent-bot/data/last-crash.json`, that day's `~/.agent-bot/logs/worker.stderr.YYYY-MM-DD.log`, and `~/.agent-bot/data/crash-reports/`
- **Feishu permissions are incomplete:** rerun `agentbot init` and follow the displayed authorization steps
- **An Agent cannot start:** run `codex login status` or `traex login status` as the same operating-system user that runs Agent Bot, then rerun `agentbot init` to check its version
- **You only need local testing:** run `agentbot init --skip-feishu`, then run `agentbot console`
- **A safe restart keeps waiting:** inspect active tasks with `agentbot task list --status running`

## More Documentation

- [Technical Reference](docs/technical-reference.md): configuration, permissions, routing, persistence, recovery, and runtime behavior
- [Example Configuration](config.example.yaml)
- [Changelog](CHANGELOG.md)
- [Agent Development Guide](https://github.com/keyou/agent-bot/blob/master/AGENTS.md)
