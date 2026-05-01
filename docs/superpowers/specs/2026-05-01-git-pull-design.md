# Git Pull Feature Design

**Date:** 2026-05-01

## Problem

Users have no way to pull upstream changes from within AgentHero. The existing `GitStatusMenu` shows how many commits are ahead (to push) but has no visibility into commits behind (available to pull), and no pull action.

## Target User

Any AgentHero user working in a shared repository where upstream commits land while they are working — they need to know when to pull and be able to do it without leaving the app.

## Scope

Add pull support to the existing `GitStatusMenu`: a left-side badge showing the behind count, a pull button in the dropdown, and background polling so the badge stays current without user interaction.

## Non-Goals

- Polling inactive/background projects (only the active project is polled)
- Conflict resolution UI (pull errors surface as a message, same as push credential errors)
- Support for `git pull --rebase` or other pull strategies (plain `git pull` only)

---

## Architecture

### Badge & Icon

The existing GitBranch icon gains a **left-side blue badge** showing the `behind` count. It is only rendered when `behind > 0`. Caps at "99+" to match the existing right-side red ahead badge. Both badges can appear simultaneously.

### Dropdown Changes

When `behind > 0`, the dropdown shows at the top (above the existing push controls):

- A **"X commits behind `origin/branch`"** summary line
- A **Pull button** with a loading spinner while in progress

On pull success, the frontend immediately re-fetches git status to refresh both badges. On credential error, the same terminal-fallback modal used by push is reused. Other errors surface inline as a message string.

### Background Polling

On project **load or switch**, the frontend:
1. Immediately runs `POST /api/projects/:id/git/fetch` then `GET /api/projects/:id/git/status`
2. Starts a `setInterval` at the configured interval

Each interval tick runs the same fetch → status sequence. The interval is cleared when the project is closed or switched. Only the active project is polled.

**Setting:** "Git fetch interval" numeric input (minutes) in the existing settings panel. Default: `15`. Setting to `0` disables background polling.

### Server Endpoints

**`POST /api/projects/:id/git/fetch`**
- Runs `git fetch`
- Timeout: 120s (same as push)
- WSL support: same pattern as existing git commands
- Returns `{ ok: true }` or `{ error: string }`

**`POST /api/projects/:id/git/pull`**
- Runs `git pull`
- Timeout: 120s
- WSL support: same pattern
- Credential error detection: same regex as push (`/terminal prompts (have been )?disabled|could not read Username|Authentication failed/i`)
- Returns `{ ok: true }` or `{ error: string, needsCredentials?: boolean }`

### Types

No changes to `GitStatus` — the `behind` field already exists and is populated by the existing `git status --porcelain=v1 --branch` parse.

---

## Data Flow

```
[setInterval / project switch]
        ↓
POST /api/projects/:id/git/fetch   (git fetch)
        ↓
GET  /api/projects/:id/git/status  (git status --porcelain=v1 --branch)
        ↓
gitStatus.behind → left badge count
        ↓
User opens dropdown → pull button visible if behind > 0
        ↓
POST /api/projects/:id/git/pull    (git pull)
        ↓
GET  /api/projects/:id/git/status  (refresh badges)
```

---

## Settings

| Setting | Type | Default | Notes |
|---|---|---|---|
| `gitFetchIntervalMinutes` | number | 15 | 0 = disabled |

Stored in the existing app settings alongside other project-level preferences.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| `git fetch` fails (network, auth) | Silently ignored — badge shows last known behind count |
| `git pull` needs credentials | Terminal-fallback modal (reuse push credential modal) |
| `git pull` merge conflict | Error message shown inline in dropdown |
| `git pull` other error | Error message shown inline in dropdown |

---

## Acceptance Criteria

- [ ] Left-side blue badge appears on GitBranch icon when `behind > 0`
- [ ] Badge shows correct count, caps at "99+"
- [ ] Badge is absent when `behind === 0`
- [ ] Existing right-side red badge (ahead/push) is unaffected
- [ ] Dropdown shows "X commits behind origin/branch" when `behind > 0`
- [ ] Pull button is visible in dropdown when `behind > 0`
- [ ] Pull button shows spinner while pull is in progress
- [ ] After successful pull, git status refreshes and badges update
- [ ] Credential error during pull opens terminal-fallback modal
- [ ] Other pull errors display inline in the dropdown
- [ ] On project load or switch, fetch + status runs immediately
- [ ] Background polling runs at the configured interval (default 15 min)
- [ ] Setting interval to 0 disables background polling
- [ ] Timer resets when project is switched
- [ ] Only active project is polled
- [ ] "Git fetch interval" setting is present in settings panel
- [ ] `POST /api/projects/:id/git/fetch` endpoint works for normal and WSL projects
- [ ] `POST /api/projects/:id/git/pull` endpoint works for normal and WSL projects
