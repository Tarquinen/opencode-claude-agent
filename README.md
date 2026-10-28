# Claude Agent plugin

Experimental opencode plugin that runs a user's own Claude subscription inside opencode through Claude Code, using only documented features of the Claude Agent SDK.

Not intended for release. See [PLAN.md](./PLAN.md) for the research, design and order of work, [TESTING.md](./TESTING.md) for how it is tested.

## Install

Requires OpenCode 2.0.25 or newer.

1. Install Claude Code and sign in with `claude auth login` on the machine running OpenCode. An existing login is reused.
2. Install the plugin:

   ```sh
   opencode plugin add github:Tarquinen/opencode-claude-agent
   ```


3. In OpenCode, use `/connect` → **Claude Agent**, then `/models` to choose a model and effort level.

To update, run `opencode plugin update github:Tarquinen/opencode-claude-agent`. To uninstall, run `opencode plugin remove github:Tarquinen/opencode-claude-agent`.
