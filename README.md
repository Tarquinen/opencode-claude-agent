# Claude Agent plugin

Experimental opencode plugin that runs a user's own Claude subscription inside opencode through Claude Code, using only documented features of the Claude Agent SDK.

Not intended for release. See [PLAN.md](./PLAN.md) for the research, design and order of work, [TESTING.md](./TESTING.md) for how it is tested.

## Install

Requires OpenCode 2.0.25 or newer.

1. Install Claude Code and sign in with `claude auth login` on the machine running OpenCode. An existing login is reused.
2. Install the plugin from GitHub:

   ```sh
   opencode plugin add github:Tarquinen/opencode-claude-agent
   ```

   This installs the plugin and adds it to the `plugins` array in your global OpenCode configuration. A running OpenCode picks it up without a restart.

3. In OpenCode, use `/connect` → **Claude Agent**, then `/models` to choose a model and effort level.

To get the latest commit, run `opencode plugin update github:Tarquinen/opencode-claude-agent`. To uninstall, run `opencode plugin remove github:Tarquinen/opencode-claude-agent`.

The Claude Agent SDK downloads its own copy of `claude` (about 250 MB) during the install. The plugin never runs it, it uses the `claude` you installed.

## Local development

Run `bun install` in this repository and add its absolute path to the `plugins` array in OpenCode's configuration, for example `~/.config/opencode/opencode.jsonc`, instead of the GitHub package:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/opencode-claude-agent"],
}
```
