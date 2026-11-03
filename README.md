# Claude Agent plugin

Experimental opencode plugin that runs a user's own Claude subscription inside opencode through Claude Code, using only documented features of the Claude Agent SDK.

Not intended for release. See [PLAN.md](./PLAN.md) for the research, design and order of work, [TESTING.md](./TESTING.md) for how it is tested.

## Install

Requires OpenCode 2.2.3 or newer.

1. Install Claude Code and sign in with `claude auth login` on the machine running OpenCode. An existing login is reused.
2. Install the plugin:

   ```sh
   opencode plugin add github:Tarquinen/opencode-claude-agent
   ```


3. To disable the bundled Claude Agent provider, add `"-opencode.provider.claude-agent"` to `plugins` in `opencode.json`. Keep `"github:Tarquinen/opencode-claude-agent"` and your other plugin entries.
4. In OpenCode, use `/connect` → **Claude Agent**, then `/models` to choose a model and effort level.

To update, run `opencode plugin update github:Tarquinen/opencode-claude-agent`. To uninstall, run `opencode plugin remove github:Tarquinen/opencode-claude-agent`.

## Use a second Claude account

1. Sign in to the second account in a separate folder. Your usual login stays unchanged.

   ```sh
   CLAUDE_CONFIG_DIR="$HOME/.claude-2" claude auth login
   ```

2. Add Sonnet and Opus for the second account to your `opencode.json`:

   ```json
   {
     "providers": {
       "claude-agent": {
         "models": {
           "sonnet-2": {
             "modelID": "sonnet",
             "name": "Sonnet (Claude 2)",
             "settings": { "configDir": "~/.claude-2" }
           },
           "opus-2": {
             "modelID": "opus",
             "name": "Opus (Claude 2)",
             "settings": { "configDir": "~/.claude-2" }
           }
         }
       }
     }
   }
   ```

3. In `/models`, choose **Sonnet (Claude 2)** or **Opus (Claude 2)** for the second account. The original entries still use your usual login.
