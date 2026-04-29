# Project Inspector Plan

Build this as a Project Inspector tile, not a lightweight IDE. The goal is to inspect files, review diffs, open paths externally, and send context to chats without taking on editing, language-server, debugger, or extension complexity.

## Fix External Open First

- Fix open folder and open file before adding the tile.
- The current Windows opener can fail when PowerShell sees `$args[0]` as null.
- Avoid `$args[0]` for Windows open commands. Pass the path through a safe parameter mechanism, such as an environment variable consumed by PowerShell, or another argument-safe approach.
- Keep server-side path validation. Only open paths inside open projects or the built-in agent directory.
- Provide separate UI actions for open folder, open file, and open in default app.

## Cross-Platform Path Model

Carry three path concepts through file actions:

- `displayPath`: path shown in the UI.
- `runtimePath`: path valid inside the project runtime.
- `hostOpenPath`: path the host OS can open.

### Local Windows Projects

- Browser root is a Windows path.
- File reads and Git use the normal Node filesystem path.
- Open file and folder through the Windows host opener with safe parameter passing.

### WSL Projects

- Browser root and Git operations use the WSL/Linux project path where needed.
- Convert WSL paths to UNC paths for host opening, such as `\\wsl$\<distro>\home\...`.
- Do not pass raw `/home/...` paths to Windows open commands.
- Git commands should continue using `wsl.exe git ...`.

### macOS And Linux Hosts

- macOS opens paths with `open`.
- Linux opens paths with `xdg-open`.
- Use argument-safe process APIs such as `execFile`; avoid string-built shell commands.

## Project Inspector Tile

- Add a tile type alongside agent and terminal tiles: File Browser or Project Inspector.
- Header controls: project label, refresh, open folder, collapse, close.
- Left pane: simple lazy-loaded file tree with folder expand/collapse and search/filter.
- Main pane modes: Preview, Diff, Details.

## File Browser

- Start at the selected project root.
- Expand folders lazily.
- Show lightweight file and folder icons.
- File actions:
  - open in preview
  - open in default editor
  - open containing folder
  - add file to chat
  - copy relative path

## Quick Preview

- Read-only only.
- Syntax-highlight common text files.
- Handle large files with truncation and a clear full-file action.
- Handle binary files with metadata and external-open actions.
- Show path, size, and modified time.
- Support selecting text and adding that selection to a chat.

## Diff And Review Pane

- Use Git status as the entry point.
- Show changed files with status badges: modified, added, deleted, renamed, untracked.
- Click a changed file to show its unified diff.
- For untracked files, show a full-file preview or new-file view.
- Diff actions:
  - add full file diff to chat
  - add selected hunk to chat
  - open file
  - open containing folder

## Add To Chat

- Reuse the existing attachment/context flow where possible.
- Support adding:
  - full file
  - selected text
  - selected diff hunk
  - full diff for a file
- Let the user choose the target chat when multiple agents are open.
- Prefer compact context cards or attachments over dumping large text inline.

## Backend Endpoints

Potential endpoint shape:

- `GET /api/projects/:id/tree?path=...`
- `GET /api/projects/:id/file?path=...`
- `GET /api/projects/:id/diff?path=...`
- Extend `POST /api/filesystem/open` for cross-runtime host opening.

All endpoints must normalize and validate paths against the project root before reading or opening.

## Phasing

1. Fix external open for files and folders across Windows, WSL, macOS, and Linux.
2. Add the Project Inspector tile shell and file tree.
3. Add read-only file preview.
4. Add Git changed-files and diff view.
5. Add send-to-chat actions for files, selections, and diff hunks.
6. Add polish: search, hunk selection, large-file handling, binary-file handling.

## Acceptance Tests

- Windows local project: open project folder, open agent file, preview file.
- Windows plus WSL project: open WSL folder through `\\wsl$`, open WSL agent file, preview through the runtime path.
- macOS/Linux host: open folder and file with platform opener.
- Bad path outside project: blocked with a clear error.
- Large file: preview truncates safely.
- Binary file: metadata shown, no broken text preview.
- Diff hunk: can be added to a selected chat.
