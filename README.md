# AgentHero

AgentHero is a local dashboard for running coding agents against your own project folders. It starts a localhost Express/WebSocket server, serves a React UI, and launches Claude, Codex, or OpenAI API sessions from the selected project directory.

![AgentHero dashboard](docs/screenshots/dashboard.png)

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Top Features

- Run multiple agents across multiple local projects, with each project keeping its own chats, terminals, and state.
- Launch Claude Code, Codex CLI, or OpenAI API sessions with project-specific agent definitions.
- Use built-in agents as reusable defaults across every project.
- Keep a read-only file explorer, file search, previews, diffs, and context attachment flow next to the chat.
- Run terminals in project folders with the same project switching model as agents.
- Inspect Git status, incoming commits, unpushed commits, push, pull, fetch, and worktrees from the UI.
- Use a mobile-friendly view for existing chats at `/mobile`.
- Install locally on Windows with a setup EXE, or run manually from a checkout.

AgentHero is designed for trusted local use. Keep it bound to `127.0.0.1` unless you intentionally configure access controls for another setup.

## Mobile And Remote Access

AgentHero includes a mobile-friendly chat view at:

```text
http://127.0.0.1:4317/mobile
```

For access from a phone, tablet, laptop, or another machine, do not expose the AgentHero port directly to the public internet. The server can control local terminals, project files, and agent processes, so treat it like a private developer tool.

Recommended remote access:

- Use Tailscale, ZeroTier, WireGuard, or a similar private VPN/overlay network.
- Keep AgentHero bound to `127.0.0.1` for local-only use.
- If you intentionally bind beyond localhost, enable the access token requirement first.
- Limit firewall rules to trusted private network addresses.

Avoid port-forwarding `4317` or `4318` from a router or cloud firewall to the open internet.

## Agent Files

Agent files define launchable agents. They are Markdown files with optional frontmatter plus the prompt body.

```md
---
name: backend-reviewer
description: Review backend changes for correctness and operability.
provider: claude
defaultModel: claude-sonnet-4-6
permissionMode: acceptEdits
---

Review the current project for backend bugs, missing validation, and risky error handling.
```

Common fields:

- `name`: stable id shown in launch menus.
- `description`: short human-readable summary.
- `provider`: `claude`, `codex`, or `openai`.
- `defaultModel`, `default_model`, or `model`: selected by default on launch.
- `permissionMode`: default permission mode for the launched session.
- `plugins`: plugin ids to enable for Claude or Codex sessions.

The body becomes the agent prompt. Keep agent files focused and reusable; put project-specific assumptions in project agents and general workflows in built-in agents.

## Project Agents

Project agents live inside the selected project:

```text
<project>/.claude/agents
<project>/.codex/agents
<project>/.agent-hero/openai-agents
```

AgentHero scans those folders when you add or refresh a project. Worktree projects inherit project agents from the root project folder, so the same local agent definitions remain available when switching into a worktree.

Use project agents for prompts that depend on that repository's stack, conventions, services, or deployment process.

## Built-In Agents

Built-in agents are app-level defaults available to every project. The repo ships them in:

```text
.agent-hero/built-in-agents
```

You can manage the built-in agent directory from Settings. Built-in agents are useful for general roles such as backend reviewer, frontend implementer, test fixer, documentation updater, or release-note writer.

If a project agent and a built-in agent share a similar purpose, prefer the project agent for repository-specific behavior.

## Manual Checkout Run

Requirements:

- Node.js 20+
- Git
- Claude Code CLI and/or Codex CLI if you want local CLI providers

Install and run from a checkout:

```bash
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:4318
```

For a production-style local run:

```bash
npm install
npm run build
npm run start:server
```

Open:

```text
http://127.0.0.1:4317
```

The server serves `web/dist` directly in production-style mode.

## Windows Install

Download the checked-in graphical installer:

[Download AgentHeroSetup.exe](https://github.com/yohaas/AgentHero/raw/main/installer/AgentHeroSetup.exe)

The setup wizard is built with Inno Setup and runs the AgentHero install steps behind its normal installer UI. To regenerate it, install Inno Setup 6 so `ISCC.exe` is available, then build a Windows release bundle and copy the setup EXE into `installer/`:

```powershell
winget install --id JRSoftware.InnoSetup -e
npm run bundle:windows
npm run installer:windows -- -ManifestUrl .\artifacts\manifest.json -OutputPath .\artifacts\AgentHeroSetup.exe
Copy-Item .\artifacts\AgentHeroSetup.exe .\installer\AgentHeroSetup.exe -Force
New-Item -ItemType Directory -Path .\installer\releases\v0.1.0 -Force
Copy-Item .\artifacts\agent-hero-0.1.0-windows-x64.zip .\installer\releases\v0.1.0\agent-hero-0.1.0-windows-x64.zip -Force
```

The generated build output also remains in the ignored artifacts folder:

```text
artifacts\AgentHeroSetup.exe
```

The installer places AgentHero in:

```text
%LocalAppData%\Programs\AgentHero
```

It also creates:

- A per-user Scheduled Task named `AgentHero`.
- A desktop shortcut to `http://127.0.0.1:4317`.
- A Start Menu shortcut under `AgentHero`.
- An uninstall entry for the current Windows user.
- Logs and update state under `%LocalAppData%\AgentHero`.

The Scheduled Task runs as the interactive Windows user. That matters because AgentHero needs the same user profile that owns your project folders, OneDrive paths, PATH entries, Claude credentials, and Codex credentials.

To build a small web bootstrapper instead of an offline EXE, pass a hosted manifest URL:

```powershell
npm run installer:windows -- -ManifestUrl "https://example.com/agent-hero/manifest.json"
```

## macOS Install

Build macOS artifacts on a Mac. The package tools and native dependencies need Darwin/macOS binaries.

```bash
npm run bundle:mac
npm run installer:mac -- --manifest-url ./artifacts/manifest.json --output-path ./artifacts/AgentHeroSetup.pkg
```

The installer package creates a per-user LaunchAgent:

```text
~/Library/LaunchAgents/com.agenthero.plist
```

Default installed files:

```text
~/Applications/AgentHero.app
~/Applications/AgentHero
~/Library/Application Support/AgentHero
~/Library/Logs/AgentHero
```

The LaunchAgent runs as the logged-in macOS user so shell paths, local projects, and provider credentials resolve from that user's environment. `AgentHero.app` is a small launcher that starts the LaunchAgent if needed and opens `http://127.0.0.1:4317`.

For a hosted bootstrap package, pass a hosted manifest URL:

```bash
npm run installer:mac -- --manifest-url "https://example.com/agent-hero/manifest.json"
```

## Updates

AgentHero has two update modes:

- `checkout`: developer installs update from Git.
- `installed`: release-bundle installs update from a manifest and local `version.json`.

Windows installed mode uses:

```text
scripts/windows/start-installed-update.ps1
scripts/windows/update-installed-agent-hero.ps1
```

macOS installed mode uses:

```text
scripts/macos/update-installed-agent-hero.sh
```

Installed updates download the manifest asset, verify SHA256, stage the new bundle, stop AgentHero, swap files, restart, check `/api/health`, and roll back if startup fails.

The default installed update manifest lives in the repo at:

```text
installer/manifest.json
```

Installed builds use the raw GitHub URL for that manifest unless a different URL is set in Settings or `AGENTHERO_UPDATE_MANIFEST_URL`. The manifest should point at versioned release assets. For simple repo-hosted builds, keep the ZIP under `installer/releases/<tag>/`; for cleaner public releases, point the same manifest at GitHub Release assets for that tag.

`version.json` is generated by the bundle scripts. You do not edit it by hand. Installed update checks compare the generated version first, then release tag and commit SHA, so a new release bundle can be detected even when the package version has not changed.

Before creating a release bundle or installer, increment the package build/patch number for routine builds, for example `0.1.0` to `0.1.1`. For significant updates, decide whether the minor or major version should be bumped before building.

Settings > Updates shows the install mode, current version, latest manifest version, matching release asset, and update commands.

Do not rebuild the installer for every app change. Rebuild the installer only when the installer payload, install scripts, bootstrap behavior, or checked-in downloadable setup file needs to change. For normal app updates, publish a new release bundle and update `installer/manifest.json`.

Browsers do not allow a normal installer to silently install a PWA into Chrome or Edge. The Windows installer creates Desktop and Start Menu shortcuts to the local AgentHero URL with the app icon; users can still install the browser PWA from the browser UI if they want the browser-managed app entry.

## Settings

Important settings:

- Project folders and open projects.
- Built-in agent directory.
- Claude, Codex, and OpenAI provider settings.
- Access token requirement for browser/API/WebSocket control.
- Update mode, update manifest URL, and update commands.
- Theme, layout, file explorer dock, terminal dock, and chat display options.

Configuration is stored under the user's AgentHero state directory.

## Security

AgentHero can launch local agents, run shells, read selected project files as context, install plugins, and operate on Git repositories. Use it on a trusted machine.

Recommended defaults:

- Keep `HOST=127.0.0.1`.
- Enable the access token before binding beyond localhost.
- Avoid opening untrusted projects with permissive agent modes.
- Treat plugins and provider credentials as trusted-local-machine concerns.

## Troubleshooting

If the UI cannot connect, make sure the server is running on the expected port and open:

```text
http://127.0.0.1:4317/api/health
```

If Claude or Codex is missing, confirm the CLI is available in the same user account that runs AgentHero:

```bash
claude --version
codex --version
```

For installed Windows/macOS builds, restart the Scheduled Task or LaunchAgent after changing provider installs or PATH-sensitive configuration.
