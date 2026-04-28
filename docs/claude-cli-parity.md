# Claude CLI Parity Roadmap

This dashboard should feel like a multi-agent control surface for Claude Code, not only a transcript viewer. These are the main gaps to close.

## Response Streaming

Current state:
- Standard agents launch Claude with `--print --verbose --output-format stream-json --input-format stream-json`.
- The server parses `content_block_delta` events and sends `agent.transcript_updated` events to the UI.
- Tool calls and tool results are shown, but tile mode previously collapsed them to terse placeholders.

Known issues:
- Some Claude CLI versions may emit final assistant messages without `content_block_delta` events in `--print` mode.
- Stream text chunks can contain meaningful whitespace, so parsers must not trim text deltas.
- Tool-heavy turns can look like there is no response streaming if the visible output is mostly Bash/tool output.

Next steps:
- Capture representative raw `stream-json` lines for text-only, Bash-heavy, edit-heavy, and permission-gated turns.
- Support every observed text delta shape, not only `content_block_delta.delta.text`.
- Add a visible "streaming..." indicator on the active assistant message while chunks are arriving.
- Add a debug export for raw stream lines per agent.

## Permission Prompts

Current state:
- The shared protocol has a `permission` command.
- Tool use events can mark `awaitingPermission`.
- Standard agents register an AgentControl MCP `approval_prompt` tool with Claude's `--permission-prompt-tool` option.
- Permission prompt requests include the Claude `tool_use_id`, mark the transcript tool event as `awaitingPermission`, and set agent status to `awaiting-permission`.
- The UI has prominent approve/deny controls in maximized and tile tool cards.

Observed Claude 2.1.121 stream shape:
- Permission-gated writes first appear as a normal assistant `tool_use` block with `id`, `name`, and `input`.
- Without a permission prompt tool decision, Claude emits a user `tool_result` error for that same `tool_use_id` and reports `permission_denials` in the final `result`.
- With `--permission-prompt-tool`, Claude calls the configured MCP tool with `tool_name`, `input`, and `tool_use_id`; AgentControl maps that call to the visible Approve/Deny prompt.

Next steps:
- Show tool name, command/path, risk context, and approve/deny buttons.
- Preserve permission request history in exports.

Manual verification:
1. Launch AgentControl and start an agent in Ask before edits mode.
2. Ask it to create or edit a file in the current project.
3. Confirm the agent status changes to `awaiting-permission` and the tool card shows a visible Permission required prompt.
4. Click Deny and confirm Claude receives a denial and the file is not changed.
5. Repeat the request, click Approve, and confirm the tool result succeeds and the file is changed.

## Tool Activity Detail

Current state:
- Tool use and result events are stored in transcripts.
- Maximized view has expandable tool cards.

Next steps:
- Render common tools with specialized summaries:
  - Bash: command, exit status, stdout, stderr.
  - Read/Edit/Write: path, diff or content excerpt.
  - Search/Glob: pattern and result count.
- Pair tool results with the corresponding tool use in the UI.
- Default-open errored tool results.
- Add copy buttons for command, output, and path.

## Interrupt / Stop Current Response

Current state:
- `Exit` stops the whole agent process.

Next steps:
- Add a separate stop/interrupt action for the active turn.
- Keep the agent session alive after interrupt when the CLI supports it.
- Distinguish "interrupted" from "exited" in the transcript.

## Slash Commands

Current state:
- The dashboard sends normal user messages.

Next steps:
- Add support for CLI-style slash commands where Claude Code supports them.
- Handle commands such as compact, clear, model changes, memory/status, and resume workflows.
- Decide which commands are dashboard-native versus passed through to Claude.

## Session / Resume UX

Current state:
- Agents with a session id are shown as paused and can be resumed.

Next steps:
- Show session id, launch time, last activity, and model.
- List restorable sessions even when no process is running.
- Let users choose which session to resume for an agent definition.
- Make "paused" distinct from "exited" and "error".

## Queued Messages

Current state:
- Message boxes disable while an agent is busy.

Next steps:
- Allow drafting while busy.
- Optionally queue messages and send them when the current turn completes.
- Show queued message count per tile.
- Allow cancel/edit of queued messages.

## Remote Control State

Current state:
- Remote Control launches and displays the claude.ai/code link and QR code.

Next steps:
- Split state into starting, waiting for browser/mobile, connected, closed, and error.
- Show Remote Control stdout/stderr diagnostics.
- Make Stop/Exit behavior explicit and consistent with normal agents.

## Attachments And Context

Current state:
- Messages are text only.

Next steps:
- Support sending selected files or paths as context.
- Add drag/drop attachments where Claude Code supports them.
- Add "send this file/selection to agent" flows from tool output and transcript selections.

## Terminal Output Fidelity

Current state:
- Tool output is plain text/JSON.

Next steps:
- Preserve useful formatting from command output.
- Render ANSI colors safely where useful.
- Improve long-output folding and search.
- Add "copy raw" and "copy cleaned" actions.

## MCP / Plugin Visibility

Current state:
- The dashboard can list and enable installed plugins.

Next steps:
- Show which plugins/MCP servers are active for each launched session.
- Show available tools per session.
- Expose plugin enablement failures clearly.
- Persist plugin choices per agent definition when appropriate.
