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

To use one account for every model in a project, such as a work account, set `configDir` for the provider in that project's `opencode.json` instead:

```json
{ "providers": { "claude-agent": { "settings": { "configDir": "~/.claude-work" } } } }
```

## Rotate between accounts

If you have several interchangeable accounts, OpenCode can move chats between them as they hit usage limits.

1. Sign in to each extra account in its own folder. Your existing login in `~/.claude` can stay as it is:

   ```sh
   CLAUDE_CONFIG_DIR="$HOME/.claude-1" claude auth login
   ```

2. List the folders as `configDir` in your `opencode.json`:

   ```json
   {
     "providers": {
       "claude-agent": {
         "settings": { "configDir": ["~/.claude", "~/.claude-1"] }
       }
     }
   }
   ```

## Search the web with your Claude plan

The plugin can serve opencode's `websearch` tool with Claude Code's WebSearch, so searches count toward your Claude plan instead of needing a search API key. It works for every model, not just Claude. Turn it on in your `opencode.json`:

```json
{ "websearch": { "provider": "claude-agent" } }
```

The provider is offered only while Claude Agent is connected, and searches use the same login, account folders and connection settings as chats.

WebSearch returns page contents encrypted, so a Claude model has to run each search. It writes a short summary of the results, which comes back with the links. That model is Haiku by default, the cheapest. To choose another, set `webSearchModel`:

```json
{ "providers": { "claude-agent": { "settings": { "webSearchModel": "sonnet" } } } }
```
