# Releases

Release summaries are listed newest-first. [CHANGELOG.md](CHANGELOG.md) has the detailed releases.

## 0.1.9 - 2026-05-05

AgentHero 0.1.9 shipped a new Windows full installer and release bundle with the recent Codex workflow improvements:

- Codex launches now separate mode selection from permission presets, including native slash shortcuts for plan, permissions, review, and diff.
- Chat views gained context usage tracking, compact/handoff controls, and raw transcript search navigation.
- Mobile and tile chat surfaces show clearer attention alerts and less clipped status indicators.
- Windows Codex sandbox runner diagnostics are filtered out of normal chat output, with clearer guidance when Full access is needed.
- Provider model settings can be reordered by dragging rows.

## 0.1.8 - 2026-05-04

AgentHero 0.1.8 improved installed update handling by replacing automatic installed update execution with manual release download links. The app now surfaces update choices more clearly and ships as a full macOS release asset when platform-specific packaging is needed.

## 0.1.7 - 2026-05-04

AgentHero 0.1.7 focused on macOS installed updater reliability. Release asset URLs are resolved against the remote manifest so installed macOS builds can download the correct update package even when manifests contain relative asset paths.

## 0.1.6 - 2026-05-04

AgentHero 0.1.6 shipped as a platform-neutral patch for day-to-day app behavior:

- File Explorer popout state is preserved more consistently.
- Reveal and send actions were refined for project file workflows.
- Native folder picker fallback behavior was hardened, especially for Windows launches where the native picker can be hidden by scheduled-task startup behavior.
- macOS-specific UI behavior was tightened by hiding unsupported WSL runtime choices.

## 0.1.5 - 2026-05-04

AgentHero 0.1.5 was the first major release, consolidating the local dashboard, agent launch workflows, project-aware file tools, mobile access, and Windows/macOS installer and update foundations into a complete installable app.
