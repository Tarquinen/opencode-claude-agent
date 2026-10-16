# Claude Code subscription plugin for opencode: plan

Status: experimental. There is no plan to ship this. Anything that does ship would need written approval from Anthropic first, so we build it as if that review will happen.

Testing is described in [TESTING.md](TESTING.md).

## Goal

Let opencode users run their own Claude Pro or Max subscription inside opencode. A Claude Code session should behave as much like a normal opencode model as possible, and the plugin should use only documented features of the Claude Agent SDK.

## Ground rules

- **Documented SDK features only.** Everything goes through public SDK options, hooks, messages and documented environment variables. We never proxy or rewrite Claude Code's API requests.
- **We never touch credentials.** The user installs `claude` and runs `claude auth login` themselves. The plugin never reads, stores or forwards tokens, and never reads `~/.claude` credential files.
- **Use the user's installed `claude` binary** through `pathToClaudeCodeExecutable`, not the copy bundled with the SDK.
- **Warn when billing would switch to the API.** If `ANTHROPIC_API_KEY` or similar variables are set, Claude Code quietly bills the API instead of the subscription.
- **Standalone plugin.** Everything uses opencode's existing plugin API. One small opencode fix to the order providers load in is planned upstream; until it ships, the plugin uses a supported workaround (see "Provider loading").
- **Local only.** The SDK needs child processes, a real filesystem and the `claude` binary. It runs in the local server and the desktop app, not in workerd or Durable Objects.

## Background: the Claude Agent SDK

`@anthropic-ai/claude-agent-sdk` (we checked 0.3.301) doesn't call Anthropic's API itself. It starts the `claude` program as a child process and talks to it over stdin/stdout using JSON messages. The `claude` program then:

- runs the agent loop, calling the model and any tools until the reply is done,
- saves the conversation as JSONL files under `~/.claude/projects`,
- signs in with whatever the user set up through `claude auth login`.

The native binary is about 268 MB per platform and ships as optional dependencies. The license points to Anthropic's terms rather than an open-source license.

Claude Code owns its sessions, and the SDK has no documented way to load a history Claude didn't write. We can only add new user messages, and resume, rewind or branch sessions Claude wrote itself.

Options we use:

| Option | What it does |
|---|---|
| `query()` with a streaming input | One long-lived session. We push user messages as they arrive. |
| `systemPrompt` | Replaces Claude Code's default system prompt with our text. |
| `tools: []` | Turns off all built-in tools. |
| `mcpServers` with our own MCP server instance | Offers our own tools from inside our process. Claude sees them as `mcp__opencode__<tool>`. |
| `hooks` (`PreToolUse`, `PostToolUse`) | Callbacks around each tool call. We use them to match calls to their IDs and to hand PDFs to Claude. |
| `permissionMode`, `allowedTools` | Which tools run without asking. |
| `resume`, `forkSession` | Continue a saved session, or branch it at a given message. |
| `persistSession: false` | Runs a one-shot call without saving a session, for titles. |
| `includePartialMessages` | Streams text and thinking as they are generated. |
| `setModel`, `setMcpServers`, `interrupt` | Live controls on a running session. |
| `applyFlagSettings` | Changes the effort level on a running session. |
| `initializationResult()`, `accountInfo()` | Claude Code version, account type and model list, without a model call. |
| `supportedModels()` | Lists models with context size and supported effort levels. |
| `verbatimPrompts` | Turns off Claude Code's slash commands, `@file` expansion and turn-start notes. |
| `settingSources`, `strictMcpConfig`, `skills` | Control what Claude Code loads from `~/.claude` and the project. |
| `env` | Environment for the child process. It replaces the parent environment rather than merging with it. |

SDK behaviour in this plan comes from the 0.3.301 types and the official docs. Tool matching, cancelling, JSON Schema tools, PDFs, tool name limits, the login check and what Claude Code adds to the context were also confirmed with small experiments against Claude Code 2.1.301.

## Policy

- Anthropic's legal and compliance page (code.claude.com/docs/en/legal-and-compliance) allows an end user to sign in to the **unmodified** Claude Code binary with their own subscription, "including where a platform hosts Claude Code".
- The same page forbids third parties from offering Claude.ai login, from routing requests through Pro or Max credentials on behalf of users, and from collecting, storing or intermediating credentials or session tokens.
- The SDK overview still says third parties need prior approval to offer claude.ai login or plan rate limits. Anthropic's own pages disagree here, so we assume approval is required.
- History with opencode:
  - January 2026: opencode's direct OAuth login was blocked (issues #7410 and #10937).
  - March 2026: PR #18186 ("anthropic legal requests") removed `opencode-anthropic-auth`.
  - April 2026: subscriptions stopped covering third-party tools that used their own Claude login.
  - Anthropic's help page on using the Agent SDK with a Claude plan (support.claude.com/en/articles/15036540) now says Agent SDK use, including inside third-party apps, draws from the user's plan limits. Its October 7, 2026 update adds monthly API credits for some plans, which apply to API keys only.
- Usage: third-party measurements show `claude -p` and the SDK use up plan limits about 1.7× faster than interactive Claude Code. Users get roughly 60% of what they'd get in Claude Code itself.

## Design

Claude thinks and opencode acts. Claude Code's built-in tools are off, and opencode's tools are offered to Claude instead. opencode runs every tool and keeps the authoritative history, so a Claude Code session works like any other opencode model.

### How the plugin plugs into opencode

1. **Register a "Claude Code" provider and its models** with `ctx.provider.transform` (`packages/plugin/src/effect/provider.ts`). Each model's package points at a placeholder file inside the plugin (see "Provider loading"). Models are registered right away from the last saved model list, or a built-in list on first run. The login check and `supportedModels()` run in the background and update the list with `ctx.provider.reload()`, so opencode never waits on them at startup.
2. **Show up as connected** in opencode's provider list. `ctx.integration.transform` adds an `external` login method, "Claude Code login (`claude auth login`)", the same way Google Vertex offers gcloud login (`packages/core/src/plugin/provider/google-vertex.ts:116-130`). opencode stores only which method was chosen, never a token (`packages/core/src/integration.ts:766-790`).
3. **Supply our own model** through the `aisdk` `sdk` hook (`packages/plugin/src/effect/aisdk.ts`), the way GitHub Copilot does (`packages/core/src/plugin/provider/github-copilot.ts:264-276`). We return an AI SDK `LanguageModelV3` whose `doStream` drives the Claude SDK instead of making an HTTP call. opencode converts its events into its own (`streamPartEvents` in `packages/core/src/aisdk.ts`).
4. **Know which session a call belongs to, and what kind of call it is.** opencode sends an `x-opencode-session-id` header with every model call, including titles, compaction and generate (`packages/core/src/session/model-request.ts:279-320`), and the bridge passes headers through to `doStream` (`aisdk.ts:492-513`). Our `ctx.session.hook("model.request")`, limited to our provider, adds the call's kind (main, compaction, title or generate) as another header.
5. **Remember state** with `ctx.storage`: which Claude session belongs to each opencode session, and what Claude has already seen.

Everything else comes from the request our model receives. That request is final: every other plugin's hooks have already run.

### Provider loading

opencode loads a model's code through plugin `sdk` hooks, run in order. A built-in fallback that installs packages from npm runs before any plugin from config, so a made-up package name like `aisdk:opencode-claude-code` fails with an npm error before our hook runs. This is open issue [#42788](https://github.com/anomalyco/opencode/issues/42788). The full write-up and the upstream fix are in [OPENCODE-FIX.md](OPENCODE-FIX.md).

Until the fix ships, the package is an absolute `file://` path to a small placeholder file in the plugin (`language-model/sdk-placeholder.ts`), worked out from `import.meta.url` when the plugin starts. The fallback imports local files directly instead of installing them, calls the file's `create...` export, and our own `sdk` hook then replaces that with the real SDK. Rules for our hook: match on our provider ID, and always replace `evt.sdk`; don't skip when it's already set.

Once the fix ships, switching is a one-line change to the package string, and the `file://` version keeps working in the meantime.

### What one step looks like

Claude's built-in tools are off (`tools: []`). opencode's tools are offered to Claude through our own MCP server, so every tool Claude can call is an opencode tool.

1. opencode calls our model's `doStream` with the request.
2. The plugin compares the request with what Claude has already seen (see "Keeping Claude in sync" below) and sends only the new part, usually the new user message, to the long-lived Claude session for this opencode session.
3. Claude's text and thinking stream back as text and reasoning events.
4. When Claude calls one of our tools, the tool handler doesn't run anything. It records a promise and waits. The plugin emits a normal tool call, mapping `mcp__opencode__read` back to `read`, and ends the step with "tool calls" as the finish reason.
5. opencode runs the tool in its usual way, including permission checks, and records the result.
6. opencode starts the next step. The plugin finds the tool result in the request, resolves the waiting handler, and Claude continues.
7. When Claude finishes without calling a tool, the plugin ends the step with "stop" and the session goes idle.

Because Claude has no tools of its own, each opencode step is roughly one Claude model call. That matches opencode's rule that one step is one model call.

In-process MCP servers have no timeout by default (`sdk.d.ts:622-660`), so a handler can wait through a long permission prompt.

**Matching calls to IDs.** Claude Code fires the `PreToolUse` hook with the tool call's ID (`tool_use_id`) just before it calls our handler (`sdk.d.ts:2785`). The handler takes the ID from the hook that just fired.

**Several tool calls in one reply.** Claude Code calls our handlers one at a time, in the order Claude wrote them. The plugin sees every tool call in the streamed reply and emits them all in the same step. opencode runs them all, and we return each result as Claude Code asks for it. Our tools are never marked read-only, because Claude Code runs read-only tools in parallel and the one-at-a-time matching would break.

**Tool errors.** A failed or denied tool goes back to Claude with `isError: true` and opencode's error text. Returning errors as normal text makes Claude retry calls that can't succeed.

**Failing closed.** If our MCP server can't start or loses its connection, the step fails with an error. The plugin never turns Claude's built-in tools back on to keep going, because they would run outside opencode's permissions.

### Other details

- **Permissions.** opencode runs every tool, so its permission rules and prompts apply unchanged. Claude allows our tools without asking through `permissionMode: "dontAsk"` and `allowedTools: ["mcp__opencode__*"]`. The mode must be set explicitly, because the default is `auto`, where an AI classifier approves or denies each call.
- **System prompt.** The opencode agent's prompt goes in through `systemPrompt`.
- **Process lifetime.** One `claude` process per active opencode session. It is stopped after an idle period and resumed with `resume` when needed. Processes live in one registry for the whole opencode process, not inside a single plugin setup, so a plugin reload doesn't kill running sessions: the old setup keeps them for about 10 seconds so the new one can take them over. A session's process is replaced one at a time, so a restart waits for the previous one to finish. After compaction the old process is never reused.
- **Stopping a process.** Always in this order: `interrupt()`, then read the remaining messages until Claude Code has finished writing its session file, then close. Closing first, or failing waiting tool handlers first, can make Claude start another model call or leave its session file on the wrong branch.
- **Finding `claude`.** The plugin passes the user's installed binary in `pathToClaudeCodeExecutable` and doesn't install the SDK's bundled copy. On Windows it uses `claude.exe`, not the `.cmd` wrapper.
- **Login check.** Before offering the models, check that `claude` is installed and logged in, without using any tokens. Start a session whose input never sends a message, call `initializationResult()` and `accountInfo()`, then close it. It takes about a second and returns the Claude Code version, the subscription type and the model list.
- **Usage.** Each step reports the token counts of its own Claude call. Claude Code can report the same API call more than once while it streams, so the plugin keeps the largest count per API message ID instead of adding them up. Adding them up would make opencode think the context is bigger than it is and compact too early. Cost is covered by the subscription, so the models have an empty cost list and Claude's `total_cost_usd` (a list-price estimate) isn't shown.
- **Empty success.** After a server error, Claude Code can report a successful result with no output. The plugin checks `api_error_status` on the result (`sdk.d.ts:5911`) and reports an error instead.
- **Retries.** Claude Code retries failed API calls itself (10 times by default, set with the documented `CLAUDE_CODE_MAX_RETRIES`). Our `ctx.session.hook("retry")`, limited to our provider, stops opencode from retrying the same errors again.

## Keeping Claude in sync with opencode

Claude Code keeps its own copy of the conversation, and opencode keeps another. **opencode's copy always wins.** The plugin keeps Claude's copy matching it.

opencode sends a model the whole history on every call. Claude Code can't take a whole history, so the plugin sends only the part Claude hasn't seen. When that part includes turns Claude didn't write itself, they go into a catch-up message.

### Switching from Claude Code to a normal model

Nothing to do. opencode ran every tool and recorded every step in its own format, so the next model sees the history like any other. opencode already drops data only the old model can use (such as signed thinking) and passes reasoning on as readable text (`packages/core/src/session/runner/to-llm-message.ts:153-233`).

### Switching from a normal model to Claude Code

Claude can't be given real past turns. Instead, the turns Claude missed go at the start of the next user message, as a catch-up message. It holds opencode's own messages word for word:

- user messages and their attachments
- the other models' replies
- tool calls with their inputs, and tool results as opencode stored them (opencode already shortened long output when it saved it)
- no thinking

Reading the catch-up costs the same as a normal model switch in opencode: the new model reads the history once without a cache, and it is cached after that.

The catch-up is one user message wrapped in a tag, in the style of opencode's `<conversation-checkpoint>` (`to-llm-message.ts:306-324`). Text, tool calls and tool results are tagged text. Images and PDFs are image and document blocks in the same message.

### The record

For each opencode session, plugin storage keeps:

- the Claude session ID
- a fingerprint of each message Claude has already seen, with Claude's message ID at that point

A fingerprint covers what the model can see: each message's role, its text, and its tool calls (name, ID and input) and tool results. It leaves out thinking and provider metadata, because opencode sends those differently depending on which model a message goes to (`to-llm-message.ts:153-233`). opencode never sends message IDs or timestamps to the model, but tool call IDs come through unchanged (`aisdk.ts:541-625`).

A run of back-to-back user messages is compared as a group, ignoring their order. opencode can add notes, such as Plan mode reminders, just before the latest user message (`packages/core/src/plugin/plan.ts:55-72`), and they don't always end up in the same spot.

Images from tool results arrive as a separate user message right after the result (`aisdk.ts:522-536`). The plugin counts that message as part of the tool result, not as new user input.

A few rare things change earlier messages: images trimmed once a session passes 25 MB (`model-request.ts:132-215`), thinking in an interrupted reply passed on as text (`to-llm-message.ts:153-183`), and the max-steps note, which is only sent once (`packages/core/src/session/runner/llm.ts:226-244`). These show up as changed history and are handled like any other edit.

The plugin compares against the request it receives, after every plugin's `context` hook has run. That way Claude's copy matches exactly what opencode would send to any other model.

Our replies also carry Claude's session and message IDs as provider metadata on their text and tool-call parts. opencode saves it and sends it back on later calls to the same model, keyed by the model's canonical ID or provider ID (`aisdk.ts:369-377`, `439-452`, `717-720`; `packages/core/src/session/runner/publish-llm-event.ts:153`). It is not sent back for replies that ended in an error, or after a switch to a different model ID. A forked opencode session copies it (`packages/core/src/session/projector.ts:192-225`) but has no record of its own yet, so the plugin uses the newest reply that still has an ID to find the Claude session to branch from.

### The four cases

Before every main model call, the plugin compares the request's messages with the record:

1. **In sync.** Send only the new user message, or the tool results Claude is waiting on.
2. **Other models added turns** (for example Claude → GPT → Claude). Resume the Claude session and send a catch-up of only the new turns. Claude keeps its real memory of its own turns, and its cache stays warm.
3. **Earlier history changed or got shorter** (undo, edit, fork, compaction, or a plugin editing earlier messages). Branch Claude's session at the last matching message with `forkSession(sessionId, { upToMessageId })` (`sdk.d.ts:854`), resume the branch, and save its new session ID in the record. Then continue as in case 1 or 2. Branching never changes the old session, so a rewind can't leave Claude on the wrong branch.
4. **Nothing matches.** Start a new Claude session with a catch-up of the whole history.

Case 4 is always safe. Cases 1–3 save tokens and keep Claude's memory intact. If anything looks wrong, fall back to case 4.

### Other session changes

| opencode event | What the plugin does | Extra cost |
|---|---|---|
| Undo, or editing a message (revert plus a new prompt) | opencode deletes the later messages (`projector.ts:759-794`). Branch Claude at the last matching message (case 3). | Low |
| Fork | opencode copies messages into a new session (`projector.ts:117-150`). Branch the Claude session with `forkSession`, using the Claude IDs in the copied replies. Any later turns go in a catch-up. | Low |
| Compaction | History becomes one summary message, so case 4 applies and we start a fresh, small Claude session. A tool call still waiting in the old process is cancelled and that process stopped. | Low |
| Agent switch | The system prompt is fixed when the process starts, so restart with `resume` and the new prompt. | Cache miss on the system prompt |
| Tool list changes | `setMcpServers` on the running session. | None |
| Switch between Claude Code models | `setModel` on the running session. | None |
| Effort change | Read the new level from the request's options and apply it with `applyFlagSettings`. opencode removes its own effort-change marker before calling AI SDK models (`packages/ai/src/effort-updates.ts`), so nothing extra shows up in the messages. | None |
| Working folder change | opencode adds a user note, which passes through. Claude's own folder doesn't matter with its tools off. | None |
| opencode server restart | `resume` from the record. If Claude was waiting on tool results, they go in the first message after resuming. When the process was stopped cleanly, Claude Code has already recorded the waiting call as refused by the user, so that message says the call did run and gives its full results. | Low |
| Session moved to another machine (`packages/core/src/session/transfer.ts`) | Claude's session files stay on the first machine, so resuming fails and case 4 applies. | One catch-up |

## Fitting opencode features

Most opencode features turn into ordinary messages and tools before any model sees them, so Claude gets what any other model would. The work falls into three groups: turning off Claude Code's own copies of features, translating a few things, and handling side calls.

### Commands

- **opencode commands work as they are.** opencode expands them into plain text, or switches agent or model, or starts a subagent, before calling the model (`packages/core/src/config/plugin/command.ts:189-241`). Claude only sees the result.
- **Claude Code's own commands are off.** Claude Code normally treats a message starting with `/` as one of its commands (`/compact`, `/clear`, custom commands, skills), so "/etc/hosts is broken" could set one off. `verbatimPrompts: true` (`sdk.d.ts:1924`) stops this. It also stops `@file` expansion and the notes Claude Code adds at the start of each turn. It needs Claude Code 2.1.248 or later.
- **`!` shell commands** become a user message holding the command and its output (`to-llm-message.ts:293-303`), which passes through.

### File attachments

- **Text files and folders:** opencode already turns them into text (`to-llm-message.ts:37-73`). Nothing to do.
- **Images and PDFs:** these reach our model as base64 file parts (`aisdk.ts:596-601`). We convert them to Claude's `image` and `document` blocks. The models declare image and PDF input support, otherwise opencode replaces them with an error note (`model-request.ts:122-147`).
- **Images returned by tools** (for example reading a screenshot): MCP tool results carry PNG, JPEG, GIF and WebP images. opencode's bridge moves tool media into a separate user message after the tool result (`aisdk.ts:522-536`), so the plugin puts them back into the result.
- **PDFs returned by tools:** MCP has no way to give Claude a PDF it can read; Claude Code saves it to disk and tells Claude the path. Instead, our handler returns a short placeholder, and our `PostToolUse` hook replaces the result with a `document` block through `updatedMCPToolOutput` (`sdk.d.ts:2715-2729`). Nothing is written to disk.

### Claude Code features to turn off

Claude Code has its own copy of many opencode features. If both run, Claude sees things other models don't and switching stops being seamless. opencode's version wins.

| Feature | Keep opencode's | Turn off Claude Code's with |
|---|---|---|
| Instructions | AGENTS.md and the system prompt | `settingSources: []`, plus env `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` |
| Skills | `skill` tool and the skill list in the prompt | `skills: []` |
| Hooks, MCP servers and plugins from `~/.claude` | opencode's | `settingSources: []`, `strictMcpConfig: true`, settings `disableAllHooks: true` |
| Permissions | opencode asks inside the tool | `permissionMode: "dontAsk"`, `allowedTools: ["mcp__opencode__*"]` |
| Compaction, including idle compaction (summarises a long conversation after about an hour idle, just before the cache expires) | opencode's | env `DISABLE_AUTO_COMPACT=1`, which turns off both |
| Session recap ("while you were away" summary) | none | env `CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0` |
| Web search, todos, plan mode, questions, subagents | opencode's tools and agents (`question`, the `plan` agent, `task`, websearch) | `tools: []` |
| Tool search (hides tool schemas until searched) | none | env `ENABLE_TOOL_SEARCH=false` |
| Advisor tool (asks a larger model for advice) | none | env `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` |

Notes:

- opencode reads AGENTS.md but not CLAUDE.md, so Claude Code sessions use AGENTS.md like every other model.
- Claude Code always adds three things no setting removes: a one-line SDK introduction before our system prompt, an environment block (folder, OS, model and date), and a reminder holding the user's account email. They are small, and the environment block overlaps with opencode's `<env>` block.
- `--bare` / `CLAUDE_CODE_SIMPLE` must stay off. It skips OAuth, so the subscription wouldn't work.

### Things that need translating

- **Tool definitions.** opencode tools use JSON Schema, and the SDK's TypeScript `tool()` helper only accepts zod. We build our own MCP server with the low-level `Server` class from `@modelcontextprotocol/sdk`, list the JSON Schemas directly, and pass the instance in `mcpServers` (`McpSdkServerConfigWithInstance`, `sdk.d.ts:1238`).
- **Large tool output.** Claude Code caps tool results at 25k tokens (`MAX_MCP_OUTPUT_TOKENS`) and saves text over 50k characters to a file, which Claude can't read with its tools off. We raise those limits (`_meta["anthropic/maxResultSizeChars"]` goes up to 500k) and rely on opencode's own truncation.
- **Tool names.** Claude sees `mcp__opencode__read` while opencode's prompts say `read`, so the plugin maps names both ways. Claude Code silently hides any tool whose full name is over 128 characters. We keep full names to 64 characters and shorten longer ones with a short hash.
- **Tool descriptions.** Claude Code cuts tool descriptions at 2048 characters. opencode's subagent tool ends its long description with the list of available agents, so the plugin moves that list to the front, where it survives the cut.
- **System prompt changes.** Claude Code records the system prompt when the process starts and ignores later changes (`sdk.d.ts:2448`). The plugin compares the system prompt on each call and restarts with `resume` if it changed. Most mid-session updates already arrive as `<system-update>` user messages (`aisdk.ts:540-557`), which pass through.
- **Reminders and other mid-session messages.** Plan-mode notes, folder changes and "continue" nudges are ordinary user messages, so they pass through. Messages the user sends while tools are running arrive after the tool results. They go to Claude alongside the results, using the SDK user message `priority` field.
- **Effort levels.** Each effort level is an opencode model variant, built from `supportedModels()`. It reaches our model in the request's provider options and is changed live with `applyFlagSettings`.
- **Max output tokens.** Set through `CLAUDE_CODE_MAX_OUTPUT_TOKENS` when the process starts. A change restarts the process with `resume`.
- **Max steps.** When an agent hits its step limit, opencode sets `toolChoice: "none"`, which Claude Code can't express. The plugin removes our tools for that call with `setMcpServers`.
- **Context size.** Taken from `supportedModels()`, so opencode compacts at the right time.
- **Plan limit reached.** Claude reports `rate_limit` errors and rate-limit events with a reset time (`sdk.d.ts:3751`, `5756-5792`). The plugin shows a clear message with the reset time and suggests switching models. A rate-limit event marked "rejected" isn't always a hard stop, and a later "allowed" event clears it, so the plugin reports a limit only when a call actually fails. Reset times can be hours or days away (weekly limits).
- **Cancelling.** opencode doesn't pass an abort signal to our model. When it stops, it cancels the stream it was reading from us, so the stream's cancel callback calls `interrupt()`. That aborts any waiting tool handler, Claude Code records the call as rejected, and the session keeps working for the next message. When opencode cancels between steps instead, Claude is still waiting on a tool result. The next request holds whatever result opencode saved, and the plugin answers the waiting handler with it, so both copies match.

### Side calls: titles, compaction, generate, subagents

Unless an agent overrides the model, these use the session's model, which means our plugin. The kind header tells the plugin which kind of call it is handling.

- **Titles.** opencode picks a cheaper "small" model from the same provider by family name, which includes Haiku (`packages/core/src/model.ts:273-285`, `session/context.ts:95-119`). Titles run as a one-shot `query()` with no tools and `persistSession: false`, separate from the main Claude session. They use the same isolation settings as the main session, including the env vars; otherwise Claude Code's auto memory leaks into them. `prewarm()` can cut startup time.
- **Compaction and generate.** Generate calls come from `session.generate`, which answers a side question from the session's context without changing the session (`packages/core/src/session/generate.ts`). Both kinds arrive with the full history plus their own instructions. The plugin branches the main Claude session with `forkSession`, where the history is already cached, and sends the call's instructions as a user message. The main session's system prompt stays, so the cache still applies. The branch is thrown away afterwards.
- **Generating text without a session** (`ctx.generate.text` with one of our models): a one-shot `query()`, like titles.
- **Subagents.** These inherit the parent's model (`packages/core/src/tool/plugin/subagent.ts:184`), so each one gets its own Claude session and `claude` process. Several subagents in parallel means several processes.

## opencode plugin hooks

Most hooks work unchanged, because opencode still builds every request, runs every tool and stores the history. The ones that don't are hooks on the HTTP request to the model provider: Claude Code sends that request itself, out of opencode's sight. The Promise plugin API mirrors the Effect one, so the same answers apply. TUI plugins only touch the interface and aren't affected.

| Hook | Works? | Notes |
|---|---|---|
| `session.hook("prompt")` | Yes | Runs before the message is queued. |
| `session.hook("context")` | Yes | Our model receives the request after these hooks run. Changing earlier messages has a cost (see "Plugins that edit history" below). |
| `session.hook("compaction")` | Yes | If a plugin supplies the summary, we just see a shorter history. Otherwise the call reaches us and runs on a branch. |
| `session.hook("generate")` | Yes | Shapes generate calls, which run on a branch. |
| `session.hook("title")` | Yes | If a plugin supplies the title, no call reaches us. |
| `session.hook("model.request")` | Partly | Headers reach our plugin but never Anthropic. A changed `baseURL` is ignored. We use this hook ourselves to tag the call's kind. |
| `session.hook("http.request")`, `"http.response"` | No | Never fire. They only wrap opencode's own HTTP client (`model-request.ts:337-365`). |
| `session.hook("experimental.ws.handshake" / "send" / "receive")` | No | Never fire. There is no WebSocket. |
| `session.hook("retry")` | Partly | Claude Code retries API errors itself first (`sdk.d.ts:3640`). opencode's retries, and this hook, only see errors after it gives up. We use it to stop opencode retrying them again. |
| `tool.transform` | Yes | Changes reach Claude through `setMcpServers`. |
| `tool.hook("execute.before")`, `"execute.after"` | Yes | opencode runs every tool. |
| `permission.hook("evaluate")`, `permission.assert` | Yes | |
| `shell.hook("create.before")` | Yes | |
| `aisdk.hook("sdk")`, `"language"` | Yes | We use the `sdk` hook. Another plugin hooking our provider could replace our model. |
| `provider.transform`, `model.transform` | Yes | We use `provider.transform`. Model transforms can hide or edit our models as usual. |
| `agent.transform` | Partly | Prompts, models, permissions and step limits work. Most generation settings, such as temperature, are ignored (see "Incompatible features"). |
| `command`, `mcp`, `skill`, `reference`, `websearch`, `vcs` and `integration` transforms | Yes | These become text, tools or prompt content before the model sees them. MCP tools reach Claude as opencode tools, and opencode handles MCP requests for user input. We use `integration.transform` for the login method. |

Everything else on the plugin context (`event`, `storage`, `rpc`, `worktree`, `credential`, `generate`, `experimental.terminal` and the `session` calls) doesn't touch the model call and works as usual.

### Plugins that edit history

Claude's copy of the conversation can only grow or be rewound. It can't be edited in the middle. When a `context` hook changes an earlier message (for example a context-pruning plugin replacing old tool output), the plugin rewinds Claude to just before the first changed message and sends everything after it as a catch-up.

Normal models lose their prompt cache after an edit too, so the token cost is similar. The extra loss is that Claude's turns after the edit become a catch-up instead of memory. A changed system prompt also means restarting the `claude` process.

Occasional edits are fine. A plugin that changes history or the system prompt on every step (for example by adding a timestamp) turns every step into a restart and a catch-up.

## Incompatible features

These opencode features won't work with Claude Code models:

- **Hosted opencode.** No workerd or Durable Objects, since the SDK needs child processes, a real filesystem and the `claude` binary.
- **HTTP and WebSocket plugin hooks.** Plugins that log, proxy or rewrite model requests see nothing.
- **Custom base URLs and request headers** for the Claude Code provider, such as a company gateway. Claude Code talks to Anthropic directly, and the ground rules rule out redirecting it.
- **Generation settings** from agents, variants or hooks: temperature, top-p, top-k, frequency and presence penalties, seed and stop sequences. Claude Code has no options for them. Max output tokens is the exception (see "Things that need translating").
- **Plugins that edit history or the system prompt on every step** (see "Plugins that edit history").
- **Session warming** (the `warming` setting, `packages/core/src/plugin/warming.ts`). It sends a keep-alive request every few minutes to keep the prompt cache alive. Claude Code's subscription cache already lasts an hour, so warming only uses up plan limits. It should be off for Claude Code sessions.
- **Cost tracking and budgets.** Claude Code models cost $0 in opencode. Plan usage only shows through rate-limit messages.

## Known limitations

- Claude reads turns from other models as a catch-up message, not as its own memory.
- Plan limits run out faster than in Claude Code itself (about 1.7×).
- Claude Code always adds a short SDK introduction, an environment block and the user's account email to the context.
- After compaction, Claude restarts from the summary, the same as any other model.
- Recovery after a crash mid-turn is limited. Resuming between turns works.
- Every side call (such as a title) starts a `claude` process and uses plan limits.
- Each subagent running in parallel is a separate `claude` process.

## Open questions

- **Catch-up messages.** Does Claude pick up a catch-up message well, treating it as the conversation so far and carrying on naturally? To be tested in phase 3, and the format adjusted if needed.
- **Resuming while a tool call waits.** If the `claude` process closes while Claude waits on tool results (idle shutdown or an opencode restart), can we `resume` and send the results as `tool_result` blocks in the next user message? If not, they go in a tagged text message holding the full results, followed by any user messages that arrived since.
- **The user's own Claude Code skills and commands.** Claude Code's start-up reply still lists the user's commands and skills from `~/.claude` (such as their own skills) even with `settingSources: []`. Check in phase 1 that `skills: []` and `verbatimPrompts` keep them away from the model. If they don't, find the documented setting that does.

## Code structure

The layout follows two opencode patterns:

- **Built-in plugins** (`packages/core/src/plugin/provider/github-copilot.ts`, `plugin/websearch/*.ts`). Each file is one small `define({ id, effect })` that hooks into one opencode area, with plain helper modules beside it.
- **`packages/core/src/github-copilot/`**. The custom AI SDK model has its own folder, separate from the plugin wiring.

opencode loads one default plugin per package (`packages/core/src/plugin/module.ts:125-134`). `index.ts` is that plugin, and it runs a list of feature plugins, the same way `plugin/websearch/index.ts` lists its providers.

```
opencode-claude-code/
├── package.json            exports "./server" → src/index.ts
├── server.ts               Re-exports src/index.ts, for loading from a local folder
├── README.md
├── PLAN.md
├── TESTING.md
├── OPENCODE-FIX.md
├── src/
│   ├── index.ts            The plugin: built from ClaudeIO, reads options, creates shared services, runs each feature
│   ├── options.ts          Plugin options (path to claude, idle timeout), checked once
│   │
│   ├── plugin/             One file per opencode area we hook into, each a small define(...)
│   │   ├── provider.ts     ctx.provider / ctx.model: the "Claude Code" provider and its models
│   │   ├── integration.ts  ctx.integration: the "signed in with claude" login method
│   │   ├── aisdk.ts        ctx.aisdk: hands opencode our model
│   │   └── session.ts      ctx.session: tags side calls, stops opencode's retries
│   │
│   ├── claude/             The only code that starts or talks to Claude Code
│   │   ├── io.ts           Starting claude and Claude's session files (fork, delete). Tests swap it
│   │   ├── options.ts      Shared settings: user's binary, everything we turn off, permissions
│   │   ├── session.ts      One long-lived claude process: send, read, interrupt, branch, restart
│   │   ├── sessions.ts     opencode session ID → live Claude session, idle shutdown, kept across plugin reloads
│   │   ├── one-shot.ts     Single throwaway query: titles, ctx.generate
│   │   └── probe.ts        Login check, version check, model list (saved for the next start)
│   │
│   ├── language-model/     The AI SDK model, laid out like opencode's github-copilot/
│   │   ├── claude-code-provider.ts        createClaudeCode() → { languageModel(id) }
│   │   ├── claude-code-language-model.ts  doStream: pick main/branch/one-shot, sync, stream back
│   │   ├── request-kind.ts                Kind header shared with plugin/session.ts
│   │   ├── convert-to-claude-message.ts   opencode prompt → Claude message (text, images, PDFs)
│   │   ├── convert-claude-stream.ts       Claude messages → opencode stream (text, thinking, tools)
│   │   ├── usage.ts                       Token counts per API message, without double counting
│   │   ├── map-claude-finish-reason.ts
│   │   ├── claude-code-error.ts           Plan limits and reset times, login, billing and empty-success errors
│   │   └── sdk-placeholder.ts             The create...() the npm fallback loads until the opencode fix ships
│   │
│   ├── tools/              opencode tools offered to Claude
│   │   ├── server.ts       Builds the in-process MCP server from opencode's tool schemas and descriptions
│   │   ├── pending.ts      Tool calls Claude is waiting on, resolved on the next step
│   │   ├── hooks.ts        PreToolUse matches calls to IDs, PostToolUse hands over PDFs
│   │   ├── names.ts        read ↔ mcp__opencode__read, shortening long names
│   │   └── result.ts       opencode tool result → Claude tool result (text, images, size limits)
│   │
│   └── sync/               Keeping Claude's copy in line with opencode's
│       ├── record.ts       What we save per session, read and written through ctx.storage
│       ├── fingerprint.ts  Fingerprints of what each message shows
│       ├── decide.ts       Request + record → which of the four cases applies
│       └── catch-up.ts     Turns Claude missed → catch-up message
│
└── test/                   Layout in TESTING.md
    ├── lib/                Fake claude, fake ClaudeIO, opencode-in-a-test helper, test plugin
    ├── bin/claude          The fake claude as an executable, for the packaging check
    ├── recordings/         Real Claude runs, one file per scenario
    ├── language-model/ sync/ tools/ claude/   Same folders as src/
    ├── opencode/           Tests with opencode running inside the test
    └── live/               Opt-in tests against a real, logged-in claude
```

### Rules

1. **Only `plugin/` sees opencode's plugin context (`ctx`).** Every other module is handed what it needs when it's created, for example `sync/record.ts` gets `ctx.storage`. Most of the code doesn't depend on opencode's plugin API.
2. **Only `claude/` and `tools/server.ts` load the Claude SDK at runtime.** Every other file uses only its types. The SDK changes often, so most breakages stay in one folder.
3. **`sync/` (except `record.ts`), the converters, `tools/names.ts` and `tools/result.ts` are plain functions.** They use no services and start no processes, so they are tested quickly with Claude messages taken from recordings and no mocks.
4. **Each file has one job**, and its name says what it is.
5. **Same style as opencode.** Modules start with the self-export (`export * as ClaudeProvider from "./provider.js"`). Each feature exports `Plugin = define({ id: "claude-code.provider", effect: Effect.fn("ClaudeProvider.Plugin")(...) })`, with small helpers below it. opencode's style guide applies.

### The entry point

```ts
const features = [
  ClaudeProvider.Plugin,
  ClaudeIntegration.Plugin,
  ClaudeAISDK.Plugin,
  ClaudeSessionHooks.Plugin,
]

// Tests pass a fake ClaudeIO. Config options can't hold functions, so this is the only way in.
export const make = (io: ClaudeIO.Interface) =>
  define({
    id: "claude-code",
    effect: Effect.fn("ClaudeCode.Plugin")(function* (ctx) {
      const options = ClaudeOptions.decode(ctx.options)
      // Built once and shared, so every feature sees the same live sessions
      const sessions = yield* ClaudeSessions.make({ options, io, storage: ctx.storage })
      for (const feature of features) {
        yield* feature.effect(ctx).pipe(Effect.provideService(ClaudeSessions.Service, sessions))
      }
    }),
  })

export default make(ClaudeIO.real)
```

### One step through the code

1. `plugin/aisdk.ts` has given opencode our model from `language-model/claude-code-provider.ts`.
2. opencode calls `doStream` in `claude-code-language-model.ts`, which reads the session and kind headers.
3. `sync/decide.ts` compares the request with the record from `sync/record.ts` and picks one of the four cases. `sync/catch-up.ts` builds a catch-up message when one is needed.
4. `claude/sessions.ts` returns the live Claude session, starting or resuming it with the settings from `claude/options.ts`.
5. `convert-to-claude-message.ts` builds the message, or `tools/pending.ts` hands over the tool results Claude is waiting on.
6. `convert-claude-stream.ts` turns Claude's replies into opencode stream events. A tool call parks its handler in `tools/pending.ts` and ends the step.

### Where future changes go

| Change | Where |
|---|---|
| A new opencode hook we need | New file in `plugin/`, added to the list in `index.ts` |
| Another Claude Code feature to turn off | `claude/options.ts` |
| A new attachment type | `convert-to-claude-message.ts` |
| A new kind of history change | `sync/decide.ts`, plus a test |
| A new side-call kind | `request-kind.ts`, plus a branch in the language model |
| An SDK or Claude Code upgrade | Re-record and review the changes (TESTING.md, Recordings), then start in `claude/` |
| A bug found by hand | A row in TESTING.md's Cases to cover, plus a test at the lowest level that shows it |

### Dependencies and loading

- `@anthropic-ai/claude-agent-sdk`, pinned to an exact version.
- `@modelcontextprotocol/sdk`, for the MCP server built from JSON Schemas.
- `@ai-sdk/provider`, for the `LanguageModelV3` types.
- `@opencode/plugin` (published on npm) and `effect`, pinned to the version opencode uses, as peer and dev dependencies. opencode supplies its own copies at runtime (`packages/plugin/src/runtime.ts:17-33`).
- `@opencode/sdk` (published on npm), the same version as `@opencode/plugin`, as a dev dependency for running opencode inside tests.
- We always pass the user's `claude` binary, so the SDK's bundled binary (about 268 MB of optional dependencies) is unused, and installs can skip optional dependencies.

During development, opencode's config points at the plugin folder: `"plugins": ["/home/dan/src/opencode-claude-code"]`, or `{ "package": "...", "options": {...} }` to pass options. For a local folder, opencode ignores `package.json` and looks for a root `server.ts` or `index.ts` (`packages/plugin/src/host.ts:17-43`), so the root `server.ts` re-exports `src/index.ts`.

## Implementation process

The work is split into six phases, each one branch and one pull request. Every phase follows the same loop:

1. Record the phase's new scenarios against real Claude Code (`RECORD=1 bun run test:live`).
2. Write the fake `claude` scripts from those recordings.
3. Write the tests, using the lowest level that can show each case ([TESTING.md](TESTING.md)).
4. Build until the tests pass.
5. Try it by hand in the TUI with `bun run dev:live` from the opencode checkout, with the plugin folder in the opencode config.

A phase is done when its tests and its cases in TESTING.md pass, its "done when" check works by hand, and the live tests still pass.

### 1. Setup and test harness

**Build:** the layout from Code structure, loading the plugin from its folder, the `file://` placeholder package (checked both from source and from a build), provider and model registration from the saved list and then `supportedModels()` (context size, effort variants, empty cost), the `external` login method, the zero-token login check, the isolation settings, and `ClaudeIO`.

**Test harness:** the fake `claude` (start-up only at first), the in-memory session files, the opencode-in-a-test helper, the test plugin with its scripted model, recording, the live-test gate and the packaging check.

**Done when:** Claude Code models show in the TUI and the login method shows as connected. A test running opencode sees the same models. The packaging check loads the plugin from its folder. A live run records a start-up.

### 2. Text chat

**Build:** no tools yet. One long-lived Claude session per opencode session, with the kind header, resume across turns, cancelling, stopping processes in the right order, the registry that survives plugin reloads, usage per API message, `verbatimPrompts`, and image and PDF attachments.

**Done when:** a conversation in the TUI works across several turns and after restarting opencode, cancelling leaves a usable session, and token counts and context size show correctly.

### 3. Sync

**Build:** fingerprints, the record, catch-up messages, the four cases, and the Claude IDs in provider metadata. Still no tools.

**Done when:** in the TUI, a session can switch from Claude Code to another model and back, in both directions, and Claude remembers what happened while it was away. Tests cover all four cases, including a `context` hook that edits history.

### 4. Tools

**Build:** opencode's tools through our MCP server: JSON Schema tools, waiting handlers, matching through `PreToolUse`, tool name mapping and description fitting, tool errors, failing closed, output limits, images and PDFs in results, and finish reasons.

**Done when:** Claude Code reads and edits files in the TUI with opencode's permission prompts, cancelling during a tool call leaves a usable session, and switching models in the middle of tool work still works.

### 5. Undo, fork, compaction and generate

**Build:** branching through `forkSession`, with compaction and generate calls run on throwaway branches.

**Done when:** after undo, fork or compaction in the TUI, Claude remembers exactly what the opencode session shows, checked live with marker words.

### 6. Side calls and polish

**Build:** one-shot titles, system prompt and agent changes, effort and max output token changes, max steps, plan-limit errors and the retry hook, the empty-success check, the API-key billing warning, and `claude.exe` on Windows.

**Done when:** sessions get titles, agent and effort changes take effect, and running out of plan limits shows a clear error with the reset time instead of retrying.

### Alongside the phases

Send the opencode fix in [OPENCODE-FIX.md](OPENCODE-FIX.md). Switch the package name once the oldest opencode version we support includes it.

## References

opencode (paths relative to the opencode repo):

- `packages/plugin/src/effect/`: plugin API (`plugin.ts` for the full context, `session.ts` for session hooks, `provider.ts`, `aisdk.ts`, `tool.ts`, `permission.ts`, `README.md`)
- `packages/core/src/plugin/hooks.ts`: hooks run in registration order
- `packages/core/src/plugin/provider/dynamic.ts`, `sdk-factory.ts`: the npm fallback for provider packages, and `file://` packages (details in [OPENCODE-FIX.md](OPENCODE-FIX.md))
- `packages/core/src/aisdk.ts`: AI SDK bridge (`streamLanguage`, `streamPartEvents`, `callOptions`)
- `packages/core/src/aisdk.ts:369-377`, `439-452`: provider options key
- `packages/core/src/aisdk.ts:522-557`: tool media moved to a user message; mid-history system messages become `<system-update>`
- `packages/core/src/aisdk.ts:596-601`, `704-720`: file parts, provider options and replayed provider metadata
- `packages/core/src/session/runner/to-llm-message.ts:153-233`: how history is replayed after a model switch
- `packages/core/src/session/runner/to-llm-message.ts:306-324`: the `<conversation-checkpoint>` message after compaction
- `packages/core/src/session/runner/publish-llm-event.ts:153`: which provider metadata is saved
- `packages/core/src/session/model-request.ts:122-215`: attachments the model can't take, and image trimming
- `packages/core/src/session/model-request.ts:279-320`: session ID headers and the `model.request` hook
- `packages/core/src/session/model-request.ts:337-399`: HTTP, WebSocket and retry hooks
- `packages/core/src/session/model-request.ts:423-431`: where the `context`, `compaction`, `generate` and `title` hooks fire
- `packages/core/src/session/projector.ts:117-225`, `759-794`: forks and reverts
- `packages/ai/src/effort-updates.ts`: effort-change markers removed before AI SDK models
- `packages/core/src/plugin/plan.ts:55-72`: Plan mode reminders
- `packages/core/src/session/generate.ts`: generate calls
- `packages/core/src/config/plugin/command.ts:189-241`: command expansion
- `packages/core/src/model.ts:273-285`, `session/context.ts:95-119`: small-model choice for titles
- `packages/core/src/session/compaction.ts:205-251`: when compaction triggers
- `packages/core/src/tool/plugin/subagent.ts:184`: subagent model choice
- `packages/core/src/plugin/warming.ts`: session warming
- `packages/core/src/integration.ts:766-790`, `plugin/provider/google-vertex.ts:116-130`: `external` login methods
- `packages/schema/src/model.ts:67-143`: model metadata schema
- `packages/core/src/plugin/provider/chatgpt.ts`, `github-copilot.ts`: existing subscription providers
- `packages/core/src/github-copilot/`: a custom AI SDK model kept apart from its plugin, the model for our `language-model/` folder
- `packages/core/src/plugin/websearch/index.ts`: a list of small feature plugins
- `packages/core/src/plugin/module.ts:125-134`: one default plugin per package
- `packages/plugin/src/host.ts:17-43`: how plugin entry points are found

Claude Agent SDK 0.3.301 (`sdk.d.ts`):

- MCP tool timeout: lines 622–660
- `McpSdkServerConfigWithInstance`: line 1238
- `verbatimPrompts`: line 1924
- `permissionMode`: lines 2012–2025
- `forkSession`: line 854
- `resume`: lines 2110–2185
- `settingSources`: line 2297
- system prompt snapshot: line 2448
- `PostToolUse` `updatedMCPToolOutput`: lines 2715–2729
- `PreToolUse` input: line 2785
- `setModel`: line 2942
- `applyFlagSettings`: line 2997
- `supportedModels`: line 3059
- `setMcpServers`: line 3258
- API retry messages: line 3640
- assistant message errors: line 3751
- rate-limit events: lines 5756–5792
- result `api_error_status`: line 5911
- `SDKUserMessage` (`priority`): lines 6389–6440

External:

- T3 Code, a working SDK integration to borrow process handling, the login probe and attachment code from: https://github.com/pingdotgg/t3code (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `apps/server/src/provider/ClaudeProvider.ts`)
- OpenChamber's opencode V2 plugin on the official SDK, with opencode's tools offered through MCP. Source of several lessons in this plan (process shutdown order, surviving plugin reloads, usage counting, rate-limit events, tool descriptions): https://github.com/openchamber/opencode-claude (`src/bridge-pool.ts`, `src/query.ts`, `src/usage.ts`, `src/rate-limit.ts`, `CHANGELOG.md`)
- Earlier community Claude Code providers for opencode V1, loaded as npm or `file://` provider packages: https://github.com/khalilgharbaoui/opencode-claude-code-plugin, https://github.com/youhaowei/opencode-claude-code-provider
- Usage measurement source: the `claude-subscription-directsdk` README in https://github.com/NousResearch/hermes-official-plugins
- Claude Code environment variables: https://code.claude.com/docs/en/env-vars
- Anthropic policy: https://code.claude.com/docs/en/legal-and-compliance
- Agent SDK use with a Claude plan: https://support.claude.com/en/articles/15036540
