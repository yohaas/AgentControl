# Agent Control

Multi-agent dashboard for adding Claude Code projects, discovering their agent definitions, launching standard or Remote Control agents, and routing transcript context between them.

## Requirements

- Node.js 20 or newer
- npm
- Claude Code CLI on `PATH`

## Setup

```bash
npm install
```

## Environment

- `PORT`: server port. Defaults to `4317`.
- `CLAUDE_CODE_CLI`: optional path to the Claude Code CLI executable. Useful when the CLI shim is not on `PATH`.
- `FORCE_FALLBACK_MODEL_SWITCH=1`: forces the resume-based model-switch strategy for testing.

Projects are added from the dashboard with the **Add Project** button. The server persists those folders in `~/.agent-dashboard/config.json`; they can also be edited from Settings as one path per line.

Each markdown file in a project's `.claude/agents/` folder becomes an agent definition. YAML frontmatter supports:

```yaml
name: Reviewer
description: Reviews code
color: hsl(180 65% 55%)
defaultModel: claude-sonnet-4-6
tools:
  - Read
  - Bash
```

The markdown body is used as the agent system prompt. If `color` is omitted, the server derives a stable HSL color from the agent name.

## Run

```bash
npm run dev
```

- Server: http://localhost:4317
- Web: http://localhost:4318

## Build

```bash
npm run build
npm start
```

In production, the Express server serves the built Vite app from `web/dist`.
