# AgentHero

AgentHero is a local dashboard for working with multiple AI coding agents side by side. It supports Claude, Codex, and ChatGPT, with project-aware agent discovery, parallel chat sessions, live streaming output, tool and permission visibility, context handoff between agents, plugin management, and built-in project terminals.

The app is built for local development workflows. It starts an Express/WebSocket server, a Vite/React UI, and provider processes/API streams in the selected project folders.

![AgentHero dashboard](docs/screenshots/dashboard.png)

See [CHANGELOG.md](CHANGELOG.md) for a date-grouped history of changes with commit links.

## What It Does

- Launch Claude, Codex, or OpenAI API agents from project agent files or shipped built-in agents such as `general`, `frontend`, `backend`, `security`, and `qa`.
- Run multiple agents as resizable tiles, with minimize-to-header, maximize, drag/drop ordering, configurable tile height, and configurable tile columns.
- Use `/mobile` for a phone-first view of existing chats in the selected project, with a collapsible left nav, project switcher, new/close chat controls, transcript viewer, status indicators, stop control, and message sending.
- Switch between projects. Each project keeps its own open agents and terminal sessions.
- Open the current project folder from the top bar in Explorer/Finder/xdg-open.
- See provider icons, model, status, and last activity in the left nav and chat headers.
- Stream Claude responses from `--output-format stream-json`, including live assistant text, thinking timers, token usage when the provider reports it, simplified tool activity, and a raw stream view for diagnostics.
- Stream OpenAI Responses API sessions and run Codex CLI sessions through the provider selector.
- Show prominent permission prompts for gated Claude tools, then send Approve/Deny back to the running Claude process. Normal tool prompts can be remembered as model-specific always-allow rules that you can review and remove in Settings; shell tool rules are scoped to the command signature, such as `npm test` or `pnpm run build`.
- Show Claude clarification questions with tabbed selectable answers, including an Other response, then send the chosen answers back to the session.
- Show Claude plan-mode results as formatted plan cards, with options to approve and build in the same chat, delegate the approved plan to another agent, deny, keep planning, or send a custom response.
- After approving a plan, show small optional next-step suggestions based on available project agents first, then built-in agents. You can dismiss them, check them off, or launch/reuse a matching agent for QA, security, docs, performance, or product follow-up.
- While an approved plan is being executed in the current chat, show a muted `Executing Phase X` label above the thinking/streaming indicator.
- Control mode per agent: Ask before edits, Edit automatically, Plan mode, or Bypass permissions.
- Control effort per agent: low, medium, high, xhigh, or max.
- Toggle Claude thinking for a session.
- Use provider-aware slash command autocomplete from AgentHero commands, Claude built-ins, project commands, user commands, plugin commands, and session-reported commands. Commands that require the Claude TUI are shown disabled.
- Steer active chats from queued messages, and use `/btw` to inject a note into a running Claude CLI response.
- Add context from local files, drag/drop files into chat, paste images, and send selected transcript text to another agent.
- Inspect the selected project from a read-only, resizable File Explorer tile, dock, or popout with lazy file browsing, recursive search, collapsible file browser, line-numbered syntax-highlighted previews, raw/formatted markup previews, side-by-side Git diffs, external open actions, and right-click copy/send context actions.
- Run project terminals with tabs, command history, rename, split panes, resize, pop out, dock left/right/bottom/float, and kill-on-close behavior.
- Show Git status for the selected project, including changed files, unpushed commit count, and a Push action.
- Check the AgentHero GitHub repository on startup, show a quiet update notice beside the connection dot, and launch a terminal with customizable update commands.
- Browse, install, enable, and persist Claude/Codex plugins per agent definition when the provider exposes a local plugin catalog.
- Export/import dashboard config and export chats as Markdown, JSON, or raw Claude stream JSONL.
- Use light, dark, or automatic color mode.
- Start, restart, or shut down the AgentHero dev stack from the UI when running in supervised mode.

## Technology

This is a TypeScript workspace with three packages:

- `server`: Express 4, `ws`, `node-pty`, `qrcode`, `gray-matter`, provider process management, and API streaming.
- `web`: React 19, Vite 6, Zustand, Radix UI primitives, Tailwind CSS, Lucide icons, and xterm.js.
- `shared`: shared TypeScript protocol and data types.

Runtime requirements:

- Node.js 20 or newer.
- npm.
- Claude Code CLI available on `PATH`, configured in Settings, or configured with `CLAUDE_CODE_CLI`.
- Codex CLI available on `PATH`, configured in Settings, or configured with `CODEX_CLI`, if you want Codex sessions.
- `OPENAI_API_KEY`, if you want OpenAI API sessions.
- `ANTHROPIC_API_KEY`, if you want Claude Code API-key auth instead of interactive Claude auth.
- Git, if you want Git status/push integration.
- Git for Windows is recommended on native Windows so Claude Code can use Bash tools; otherwise Claude Code may fall back to PowerShell.

## Install Claude Code

Install Claude Code using Anthropic's official instructions: https://code.claude.com/docs/en/quickstart

Common current options include:

```powershell
# Windows PowerShell
irm https://claude.ai/install.ps1 | iex
```

```bash
# macOS, Linux, or WSL
curl -fsSL https://claude.ai/install.sh | bash
```

You can also use package managers such as Homebrew or WinGet when appropriate. After installing, verify that AgentHero can find it:

```bash
claude --version
```

On Windows, verify from the same shell you will use to start AgentHero:

```powershell
where.exe claude
where.exe claude.cmd
claude --version
```

If `claude` is not on `PATH`, set:

```powershell
$env:CLAUDE_CODE_CLI="C:\path\to\claude.exe"
```

```bash
export CLAUDE_CODE_CLI="/path/to/claude"
```

## Authenticate Claude

AgentHero uses your existing Claude Code authentication. Authenticate in a normal terminal before launching agents:

```bash
claude auth login
claude auth status --text
```

You can also run `claude` interactively and use `/login` if prompted.

Claude Code supports several auth methods, including Claude.ai subscription login, Claude Console/API credentials, and enterprise cloud providers. Standard AgentHero agents can use whatever Claude Code can use in your terminal environment. See Anthropic's auth reference for current details: https://code.claude.com/docs/en/authentication

Remote Control is temporarily unavailable in AgentHero. Claude Code can start `claude remote-control`, but AgentHero cannot reliably mirror the live chat transcript from the current CLI. Use claude.ai/code or the Claude mobile app directly for Remote Control sessions until Claude exposes more CLI control.

AgentHero requests the selected Claude model on launch. If Claude later reports a different model in stream metadata, AgentHero keeps the selected model visible and adds a system note so you can inspect the raw stream and investigate the mismatch.

## Install Codex CLI

Install OpenAI Codex CLI with npm:

```bash
npm install -g @openai/codex@latest
```

Then verify it from the same shell you will use to start AgentHero:

```bash
codex --version
codex login
```

On Windows, also check where the command resolves:

```powershell
where.exe codex
where.exe codex.cmd
codex --version
```

If `codex` is not on `PATH`, set:

```powershell
$env:CODEX_CLI="C:\path\to\codex.exe"
```

```bash
export CODEX_CLI="/path/to/codex"
```

Codex CLI can also be installed from the OpenAI Codex GitHub releases if you prefer a platform binary: https://github.com/openai/codex

## Windows And WSL Provider CLIs

Windows and WSL use separate command environments. If you add a WSL project, install and authenticate the provider CLI inside that WSL distro too. A Windows `claude.exe` or `codex.exe` does not automatically make `claude` or `codex` available inside WSL.

Verify WSL commands from PowerShell:

```powershell
wsl.exe -l -v
wsl.exe -d Ubuntu --exec sh -lc 'command -v claude; claude --version'
wsl.exe -d Ubuntu --exec sh -lc 'command -v codex; codex --version'
```

Replace `Ubuntu` with the distro shown in AgentHero. If a command is missing, open that distro and install it there:

```bash
npm install -g @openai/codex@latest
codex login
```

For Claude Code in WSL, use Anthropic's Linux install command from the Claude Code quickstart, then run:

```bash
claude auth login
```

## Install AgentHero

```bash
npm install
```

## Run In Development

```bash
npm run dev
```

This starts:

- Server/API/WebSocket: http://localhost:4317
- Vite web app: http://localhost:4318

For the best everyday experience, install AgentHero as a browser app from your browser's address bar or app menu after opening the local URL. This gives it its own window, keeps terminals and popouts feeling app-like, and avoids losing the dashboard among regular browser tabs.

The Vite app proxies API and WebSocket traffic to the server. The server binds to `127.0.0.1` by default. You can enable a required access token from Settings > General > Security; when enabled, the browser must unlock with that token before API or WebSocket control traffic works. The top-bar connection dot is green when connected and red when disconnected. Use `HOST`, `PORT`, `AGENTHERO_ACCESS_TOKEN`, and `AGENTHERO_ALLOWED_ORIGINS` only when you intentionally need a different local setup.

For UI-controlled restart/shutdown, run supervised mode instead:

```bash
npm run dev:supervised
```

When supervised mode is active, the connection-dot menu can restart or shut down AgentHero.

## Production Build

```bash
npm start
```

`npm start` builds the workspace first, then starts the Express server. In production, there is no separate Vite web process: the Express server serves the built React app from `web/dist` at http://localhost:4317.

If you already built the app and only want to start the server, use:

```bash
npm run start:server
```

## Windows Installed Mode

Developer checkouts can keep using `git pull` updates. For a normal Windows install, build a release bundle and install from a release manifest instead:

```powershell
npm run bundle:windows
.\scripts\windows\install-agent-hero.ps1 -ManifestUrl "https://example.com/agent-hero/manifest.json"
```

The bundle script creates `artifacts\agent-hero-<version>-windows-<arch>.zip`, writes `version.json` into the bundle, and emits a `manifest.json` with the Windows asset URL, SHA256 checksum, version, release tag, commit SHA, platform, architecture, and build timestamp.

The installer downloads the manifest asset, verifies its checksum, installs to `%LocalAppData%\Programs\AgentHero` by default, registers a per-user Scheduled Task named `AgentHero` at logon, creates a desktop URL shortcut, and writes an uninstall entry under the current user. The Scheduled Task runs AgentHero as the interactive Windows user, which is required for the folder selector, OneDrive paths, user-scoped PATH entries, and Claude/Codex credentials to resolve correctly.

Installed mode uses these scripts:

- `scripts/windows/start-installed-agent-hero.ps1`: starts the bundled server with `AGENTHERO_INSTALL_MODE=installed`.
- `scripts/windows/start-installed-update.ps1`: launches the installed updater through UAC.
- `scripts/windows/update-installed-agent-hero.ps1`: downloads the latest bundle, verifies SHA256, stages it, stops AgentHero, swaps files, restarts, checks `/api/health`, and rolls back if startup fails.

Set the release manifest URL with `AGENTHERO_UPDATE_MANIFEST_URL` or Settings > Updates > Release manifest URL. Settings > Updates also shows the install mode, current version/SHA, latest manifest version, matching release asset, and the configured update commands.

## Install As A Service

Installing AgentHero as a WinSW service is optional and mainly useful for advanced checkout installs. The polished Windows install path above should use the per-user Scheduled Task so AgentHero runs in the same Windows profile that owns your projects and CLI credentials. Build once before installing the service:

```bash
npm install
npm run build
```

Windows PowerShell can install a WinSW-backed service from the repo template. Run this from an elevated PowerShell window to install and start the service:

```powershell
.\scripts\windows\install-service.ps1 -RunAsCurrentUser
```

On Windows, Settings also shows Windows service buttons under App updates. Those buttons launch the same installer/uninstaller scripts through a UAC prompt using the configured AgentHero project location. The Install/Reinstall button runs the service as the current Windows user, prompts for that user's credentials, and passes `-NoStart` so the service does not collide with the currently running app. After installing from the app, restart AgentHero or start the service after closing the current instance.

By default this creates:

```text
C:\Users\<you>\Services\AgentHero\AgentHero.exe
C:\Users\<you>\Services\AgentHero\AgentHero.xml
C:\Users\<you>\Services\AgentHero\logs\
```

`AgentHero.exe` is the WinSW service wrapper renamed for this service. The script downloads it from WinSW's GitHub release URL, renders `scripts/windows/AgentHero.xml.template` with your repo path, detected `npm.cmd`, PowerShell path, and log directory, installs the service, and starts it unless `-NoStart` is used. To use a local WinSW executable instead of downloading, pass `-WinSWPath`:

The installer also creates a Windows Scheduled Task named `AgentHeroUpdate`. The task runs `scripts/update-agent-hero.ps1` in the logged-in user's interactive session with highest privileges, so service-triggered updates can show a visible PowerShell window instead of trying to display UI from the non-interactive service session.

If you installed the Windows service before scheduled-task updates were added, rerun the installer to create the task:

```powershell
.\scripts\windows\install-service.ps1 -Force -RunAsCurrentUser -NoStart
```

You can verify or trigger the update task manually:

```powershell
Get-ScheduledTask -TaskName AgentHeroUpdate
Start-ScheduledTask -TaskName AgentHeroUpdate
```

```powershell
.\scripts\windows\install-service.ps1 -RunAsCurrentUser -WinSWPath "C:\path\to\WinSW-x64.exe"
```

Use `-Force` to reinstall an existing service:

```powershell
.\scripts\windows\install-service.ps1 -Force -RunAsCurrentUser
```

When installing from the running app, use `-NoStart` to avoid a port conflict:

```powershell
.\scripts\windows\install-service.ps1 -Force -RunAsCurrentUser -NoStart
```

To uninstall:

```powershell
.\scripts\windows\uninstall-service.ps1
```

Running as your user account lets the service use your user profile, Claude/Codex credentials, OneDrive folders, and user-scoped PATH entries. Windows stores the supplied service password in the Service Control Manager; the generated XML does not include it.

Useful Windows installer options:

- `-RunAsCurrentUser`: prompts for the current user's credentials and configures the service logon account.
- `-NoStart`: installs/configures the service without starting it.
- `-Force`: uninstalls/reinstalls an existing service with the same name.
- `-ServiceName <name>`: installs a differently named service.
- `-UpdateTaskName <name>`: uses a differently named scheduled update task.
- `-ServiceDir <path>`: writes the generated service files somewhere other than `~/Services/AgentHero`.
- `-WinSWPath <path>`: copies a local WinSW executable instead of downloading one.
- `-SkipUpdateTask`: skips scheduled update task registration.

macOS can run AgentHero as a LaunchAgent. Save this as `~/Library/LaunchAgents/com.agenthero.plist`, replacing `/path/to/AgentHero`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agenthero</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd /path/to/AgentHero &amp;&amp; npm run start:server</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

Then load it:

```bash
launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/com.agenthero.plist
launchctl kickstart -k "gui/$UID/com.agenthero"
```

Linux user services work well with systemd. Save this as `~/.config/systemd/user/AgentHero.service`, replacing `/path/to/AgentHero`:

```ini
[Unit]
Description=AgentHero

[Service]
WorkingDirectory=/path/to/AgentHero
ExecStart=/usr/bin/env npm run start:server
Restart=on-failure

[Install]
WantedBy=default.target
```

Then enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now AgentHero
loginctl enable-linger "$USER"
```

For a system-wide Linux service, place the unit in `/etc/systemd/system/AgentHero.service`, set `User=<your-user>`, and use `sudo systemctl enable --now AgentHero`.

## App Updates

AgentHero has two update modes:

- `checkout`: developer installs update from Git.
- `installed`: release-bundle installs update from a manifest and local `version.json`.

AgentHero can check for updates on startup and show the update icon in the top bar. The update dialog runs the configured command list from the AgentHero folder in Settings.

Default update behavior is OS-specific:

- Windows checkout mode runs `scripts/windows/start-update.ps1`. If the `AgentHeroUpdate` scheduled task exists, the script starts that task so update output appears in the logged-in user's desktop session. If the task is missing, it falls back to an elevated PowerShell/UAC handoff. The updater runs `git pull`, stops the `AgentHero` service, runs `npm ci` and `npm run build`, then starts the service. This avoids Windows file locks on native modules such as `node-pty`.
- Windows installed mode runs `scripts/windows/start-installed-update.ps1`, then the installed updater downloads the manifest asset, verifies the SHA256 checksum, swaps the installed bundle, restarts the per-user Scheduled Task, health-checks `http://127.0.0.1:4317/api/health`, and rolls back if the health check fails.
- macOS and Linux run `bash ./scripts/update-agent-hero.sh`. Unix filesystems generally allow replacing loaded files, so the script runs `git pull`, `npm ci`, and `npm run build`, then attempts to restart a detected service.

Both updater scripts write logs to the system temp directory:

```text
agent-hero-update.log
```

You can customize service names and restart behavior:

```bash
# macOS/Linux
AGENTHERO_SERVICE_NAME=AgentHero bash ./scripts/update-agent-hero.sh
AGENTHERO_LAUNCH_LABEL=com.agenthero bash ./scripts/update-agent-hero.sh
AGENTHERO_RESTART_COMMAND="systemctl --user restart AgentHero" bash ./scripts/update-agent-hero.sh
```

```powershell
# Windows
.\scripts\update-agent-hero.ps1 -ServiceName AgentHero
```

If your service manager uses a different service name, update the command in Settings or set the relevant environment variable for the updater script.

## Projects

Add a project from the project menu in the top bar. The folder selector can browse your home folder, configured project roots, existing project folders, and configured agent directories; you can also paste a path manually. The folder icon next to the project controls opens the selected project in the system file manager.

Project behavior:

- The selected project controls which agents and terminals are visible.
- Closing a project closes that project's agents and terminals.
- If a project has no project agent files, AgentHero shows a message and defaults the Available Agents panel to Built-In agents.
- Worktree projects are indented under their parent project in the selector.
- Project paths are persisted in `~/.agent-hero/config.json`.

## Agent Definitions

Project agent files are discovered from the provider-specific agent directory for the selected project. By default those are `.claude/agents`, `.codex/agents`, and `.agent-hero/openai-agents`. Worktree projects inherit project agents from the root project folder, so local agent definitions remain visible when switching into a worktree.

Built-in agent files ship with the repo in `.agent-hero/built-in-agents`. They are app-level defaults, not project files. You can add, edit, remove, recolor, or point to a different built-in agent directory from Settings.

Each Markdown agent file becomes an available agent tile.

Example:

```yaml
---
name: Reviewer
description: Reviews code changes and suggests fixes
color: hsl(180 65% 55%)
defaultModel: claude-sonnet-4-6
tools:
  - Read
  - Bash
plugins:
  - frontend-design@claude-plugins-official
---

You are a careful code reviewer. Focus on correctness, security, and tests.
```

Supported frontmatter:

- `name`: display name and launch type.
- `description`: shown in the launch/available-agent UI.
- `color`: tile/nav accent color. If omitted, a stable color is generated.
- `defaultModel`, `default_model`, or `model`: selected by default when launching.
- `tools`: metadata for the agent definition.
- `plugins`: plugin IDs selected by default for that agent.

The Markdown body is used as the agent system prompt. The launch modal includes a "view agent file" link so you can inspect the full prompt and open the actual file in your default editor/file handler; edit the agents file to change it.

## Launching Agents

Use the `+` button next to Running or click an Available Agent tile. The Available Agents panel has Project and Built-In tabs; Project agents appear first when present, and duplicate agent names are disambiguated by source.

Launch options include:

- Agent type.
- Display name.
- Model.
- Initial prompt.
- Selected plugins.

New agents are selected after launch and focus moves to the chat box. "Launch All" starts every available definition with its default model, default plugins, and app default mode.

## Modes, Permissions, Thinking, And Effort

The composer includes provider-aware mode controls. Claude CLI/API sessions expose Claude-style modes:

- Ask before edits: Claude asks before making edits.
- Edit automatically: Claude can edit selected text or files with fewer prompts.
- Plan mode: Claude explores and proposes a plan before editing.
- Bypass permissions: Claude will not ask before potentially dangerous commands.

The app also exposes provider-specific equivalents where available:

- Thinking toggle for Claude.
- Codex-oriented speed/intelligence style choices when supported by the selected Codex runtime.
- OpenAI deep-research oriented options when using deep-research models.
- Effort selector: low, medium, high, xhigh, max.

Changing mode, thinking, or effort updates the running session immediately when Claude supports it. If a change requires a session restart, AgentHero applies it after the active turn.

## Permission Prompts

Standard agents launch Claude with a small AgentHero MCP permission tool:

- Claude emits a permission-gated tool request.
- AgentHero marks the matching tool card as awaiting permission.
- The agent status changes to `awaiting-permission`.
- Approve/Deny sends the decision back to the running Claude process.

This is used for gated write/edit/tool calls in modes that require approval.

The helper retries permission callbacks across common local hostnames so WSL and native Windows launches can still reach the AgentHero backend when `127.0.0.1` resolves differently inside the provider process.

## Plans And Questions

Claude clarification questions and plan-mode prompts are rendered as first-class chat cards instead of raw tool output.

Question cards:

- Show one question at a time in a tabbed interface.
- Advance automatically after single-choice answers.
- Support multi-select questions.
- Support an Other option with custom text.

Plan cards:

- Render Markdown plans as normal chat content with a popout button.
- Offer Approve and build here, Deny, Keep planning, and Other.
- Offer Approve and launch agent, which starts a new project or built-in agent with the approved plan as its initial prompt and tells the planning chat not to implement it there.
- Hide the handled plan/question tool plumbing from the main chat.

## Chat And Transcript UX

- Enter sends the message.
- The send button becomes Stop while Claude is active.
- Queued messages can be expanded, edited, deleted, and reordered before they are sent.
- Tool output is summarized as one-line activity in normal chat view; use the agent menu's View Raw Stream option for provider JSONL and detailed tool payloads.
- Long questions and responses can collapse/expand.
- Streaming output auto-scrolls.
- Last sent message can pin while scrolling; clicking the pinned message jumps back to the original message, and long pinned messages can expand/collapse.
- Long chat responses include popout and expand/collapse controls when needed.
- Right-click selected text to copy or send it to another agent. If nothing is selected, the current message/tool card under the pointer is used; outside a block, the whole chat is used.
- Long chat blocks include a popout button. The popout supports Markdown view, raw-text view, copy, and send-to-agent, including selected text.
- Clear Chat clears only the transcript. Close Chat exits the agent and removes the tile.
- Exit All closes all agents for the current project after confirmation.

## Attachments And Context

The `+` button in the composer supports:

- Upload from computer.
- Add context from the current project.

Add Context shows folders and files from the repo. Folders expand so you can choose individual files. Text-like context files are included in the prompt payload with a size cap; images are sent as image content when supported by Claude.

You can also drag/drop files into chat or paste images.

## Slash Commands

Slash command autocomplete merges several sources:

- AgentHero-native commands such as `/clear`, `/exit`, `/status`, `/stop`, and `/interrupt`.
- Claude built-ins where they work in non-interactive stream-json mode.
- Project commands from `.claude/commands`.
- User commands from Claude's user command directories.
- Plugin commands and skills.
- Session-reported commands from Claude.

Commands known to require the Claude TUI, such as login/config-style commands, are shown disabled instead of being passed through and failing in the dashboard.

## Plugins And MCP

Provider plugin support is shown in the relevant Settings tab and in the launch flow. The plugin UI can:

- Show installed, enabled, and available plugins.
- Browse plugin marketplaces.
- Add a marketplace by GitHub repo, URL, or local path where supported.
- Install plugins.
- Enable plugins.

Agent definitions can persist selected plugin IDs in their frontmatter. On launch, AgentHero attempts to ensure selected plugins are enabled before starting the session. Claude and Codex plugin catalogs are shown when the local CLI exposes them; OpenAI API sessions do not expose a local plugin catalog. Running sessions can also show active plugins, MCP servers, and available tools when the provider reports them.

## Remote Control

Remote Control is intentionally hidden from the launch flow for now.

Claude Code can start `claude remote-control --name <agent name> --spawn session`, but the local CLI currently does not provide stable bidirectional transcript/input control for AgentHero. AgentHero can start a usable session, but it cannot reliably show the chat, so new Remote Control launches are disabled until Claude exposes more complete CLI control.

## Terminals

The terminal panel uses `node-pty` on the server and xterm.js in the browser.

Features:

- One or more terminal tabs per project.
- Real shell input, command history, and resize.
- Rename tabs.
- Split panes.
- Dock bottom, left, right, or float.
- Pop out to a separate browser window and dock back.
- Collapsed terminal stream shows the last output line from the last active session.
- Closing a terminal kills whatever is running in it.

Terminal history is stored per project under `~/.agent-hero/terminal-history`.

## Git Menu

The Git button shows:

- Current branch/upstream.
- Changed files.
- Ahead/behind counts.
- A badge for unpushed commits.
- Push button when commits are ahead of upstream.

Git operations run in the selected project's folder.

## Git Worktrees

The Worktrees button next to the Git menu opens a tabbed worktree view for the selected repository:

- List all worktrees for the repo and switch to any worktree already open as a project.
- Open and switch to unopened worktrees that are descendants of the current project folder.
- Create a new worktree from a branch/base ref; created worktrees are added to AgentHero as projects automatically.
- Use the default sibling worktree folder pattern `<project>-worktrees/<branch>`, with the resolved path shown before creation.
- Optionally copy local agent files into the worktree when those project agent files are untracked.
- Merge another worktree's branch into the current project when the current project is clean.
- Remove or close non-current worktree tabs; related agents and terminals are closed if that worktree was open as a project.

## Settings And Stored Data

Settings use a left navigation and wider right-side content area. Save stays visible, is disabled until something changes, and Cancel discards unsaved edits.

Settings include:

- General configuration, including project folders, built-in agent directory, config export/import, app paths, and theme.
- Optional access-token protection, with token generation and first-run setup when enabled before a token is saved.
- App update checks and commands used by the top-bar update notice.
- Provider-specific tabs for Claude, Codex, and OpenAI.
- Provider model lists with "Get Current Models" for the active provider.
- Claude runtime selection: Claude CLI or Anthropic API.
- Claude, Codex, Git, and agent directory paths.
- Built-in agent management.
- Default mode for new agents.
- Auto-approve tool use behavior.
- Layout defaults, including tile height, columns, and icon-only or icon-with-text top menu buttons.
- Sidebar width.
- Show last message pinned.

Stored local files:

- `.agent-hero/built-in-agents`: built-in agents shipped with the repo.
- `~/.agent-hero/config.json`: app settings and project paths.
- `~/.agent-hero/secrets.json`: optional locally saved Anthropic/OpenAI API keys and the access token. This file is not included in settings export.
- `~/.agent-hero/state.json`: persisted agents and recent transcripts.
- `~/.agent-hero/attachments`: uploaded/pasted attachments.
- `~/.agent-hero/terminal-history`: shell history per project.
- `~/.agent-hero/mcp`: generated MCP config for AgentHero permission prompts.
- `~/.agent-control` and `~/.agent-dashboard`: legacy storage directories copied into `~/.agent-hero` on first use when matching files are missing.
- `~/.claude`: Claude Code credentials, settings, plugins, and command files managed by Claude Code.

## Environment Variables

- `PORT`: server port. Defaults to `4317`.
- `CLAUDE_CODE_CLI`: path to the Claude Code CLI executable or shim.
- `CODEX_CLI`: path to the Codex CLI executable or shim.
- `OPENAI_API_KEY`: OpenAI API key used by OpenAI API sessions and Codex where applicable.
- `ANTHROPIC_API_KEY`: Anthropic API key available to Claude Code.
- `GIT_PATH`: path to the Git executable.
- `PROJECTS_ROOT`: fallback projects root used before projects are added manually. Defaults to `~/projects`.
- `FORCE_FALLBACK_MODEL_SWITCH=1`: forces resume-based model switching for testing.
- `AGENT_HERO_SHELL`: shell used for embedded terminals.
- `AGENTHERO_PERMISSION_URL`: override the permission callback URL used by the permission MCP helper.
- `AGENTHERO_ACCESS_TOKEN`: access token to require when token protection is enabled. `AGENTHERO_AUTH_TOKEN` is also accepted.

## Security Notes

AgentHero is a powerful local tool. It can launch Claude Code, run shells, read selected project files as context, install plugins, push Git commits, and stop/restart its own dev server.

Use it on a trusted machine and avoid exposing port `4317` to a network. The development server is intended for localhost use. Enable the Settings access token before binding beyond localhost. Be careful with Bypass permissions, plugin marketplaces, uploaded attachments, and projects that contain secrets.

## Disclaimer

AgentHero is provided as-is, without warranties or guarantees of any kind. Use it at your own risk. The authors and contributors are not liable for any loss, damage, data loss, security issue, provider charge, or unintended code change resulting from use of this software or from actions taken by connected AI agents, CLIs, plugins, terminals, or APIs.

## Troubleshooting

Claude CLI not found:

- Run `claude --version`.
- Make sure the Claude Code install directory is on `PATH`.
- Set `CLAUDE_CODE_CLI` to the full executable path.

Not authenticated:

- Run `claude auth login`.
- Check `claude auth status --text`.
- If an old `ANTHROPIC_API_KEY` is taking precedence, unset it or adjust your Claude Code auth settings.

Remote Control unavailable:

- This is expected. Remote Control is temporarily hidden and blocked in AgentHero because the dashboard cannot reliably mirror the chat transcript from the current Claude CLI.
- Use claude.ai/code or the Claude mobile app directly for Remote Control sessions.

No streaming text:

- Export Raw Stream from the agent menu and inspect whether Claude is emitting text deltas or only tool activity.
- Tool-heavy responses may show Bash/tool cards before assistant text arrives.

Plugin appears missing after install:

- Refresh the plugin picker or the provider's Settings tab.
- Confirm the exact plugin ID, including marketplace suffix, matches the ID in the agent file.
- Run `claude plugin list --available --json` in a terminal if Claude's plugin catalog looks stale.

Open project folder does nothing:

- Restart AgentHero after updating, because the folder opener lives in the backend server.
- On Windows, AgentHero opens folders through `explorer.exe`; if Explorer is blocked by policy or another process is intercepting folders, test with `explorer.exe <project path>` from PowerShell.
