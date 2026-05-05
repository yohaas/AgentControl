# AgentHero Agent Instructions

- Commit completed code changes unless explicitly told not to.
- Update the README and CHANGELOG only when the change is worth calling out.
- Never add pending items to the CHANGELOG.
- Maintain RELEASES.md alongside the changelog: every new release number gets an entry and a summary of what was released. The first entry can be 0.1.5 as a high-level first major release summary; subsequent release entries should include more detail.
- After every update, say whether a browser refresh is enough or whether the server must restart.
- Do not revert user changes unless explicitly asked.
- Keep changes scoped to the requested behavior and existing project patterns.
- Apply chat UI changes to mobile, tile, and maximized chat views unless otherwise specified.
- Do not rebuild or recommit installer artifacts for routine app changes unless the user asks or the installer/update payload itself needs to change.
- For release/update work, explicitly say whether the change needs a full build or can be shipped as a platform-neutral patch. Do not create a patch package automatically; ask before packaging one.
