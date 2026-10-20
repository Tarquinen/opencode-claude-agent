# opencode-claude-agent

Experimental opencode plugin that runs a user's own Claude subscription inside opencode through Claude Code, using only documented features of the Claude Agent SDK.

Not intended for release. See [PLAN.md](./PLAN.md) for the research, design and order of work, [TESTING.md](./TESTING.md) for how it is tested.

## Local setup

1. Install Claude Code and sign in with `claude auth login` on the machine running OpenCode. An existing login is reused.
2. Run `bun install` in this repository and add its absolute path to the `plugins` array in OpenCode's configuration.
3. In OpenCode, use `/connect` → **Claude Agent**, then `/models` to choose a model and effort level.

The connection records your choice and checks the official CLI's login; it does not install Claude Code or start authentication. There is no separate setup command. Claude retains all credentials. The provider ID is `claude-agent`.
