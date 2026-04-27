# Agent Control

Multi-agent dashboard for discovering Claude Code agent definitions, launching standard or Remote Control agents, and routing transcript context between them.

## Requirements

- Node.js 20 or newer
- npm
- Claude Code CLI on `PATH`

## Setup

```bash
npm install
```

## Environment

- `PROJECTS_ROOT`: directory scanned one level deep for projects. Defaults to `~/projects`.
- `PORT`: server port. Defaults to `4317`.
- `FORCE_FALLBACK_MODEL_SWITCH=1`: forces the resume-based model-switch strategy for testing.

A project is any direct child of `PROJECTS_ROOT` that contains `.claude/agents/`. Each markdown file in that folder becomes an agent definition. YAML frontmatter supports:

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
