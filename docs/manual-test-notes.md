# Manual Test Notes

## Worktree Open & Switch

1. Open a project that is a Git repository in AgentControl.
2. Create or confirm a worktree under the selected project folder, for example `.claude/worktrees/example-branch`.
3. Open the Git Worktrees dialog.
4. Confirm the descendant worktree shows `Inside project` and an enabled `Open & Switch` button when it is not already an AgentControl project.
5. Click `Open & Switch`.
6. Confirm the worktree path is added to saved project paths, the project selector changes to the new worktree project, and agents/terminals are scoped to that worktree.
7. Reopen Git Worktrees and confirm already-open worktrees show `Open` with `Switch`, while the current worktree keeps `Switch` disabled.
8. Confirm worktrees outside the selected project folder do not get `Open & Switch`.
