# Claude Code subscription plugin for opencode: plan

Status: experimental. There is no plan to ship this. Anything that does ship would need written approval from Anthropic first, so we build it as if that review will happen.

Testing is described in [TESTING.md](TESTING.md).

## Goal

Let opencode users run their own Claude Pro or Max subscription inside opencode. Claude keeps Claude Code's own base instructions, while opencode owns the conversation, permissions and tool execution. The plugin uses only documented features of the Claude Agent SDK.

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
| `systemPrompt` | Chat uses the `claude_code` preset plus a short OpenCode runtime note. Side calls use a small text-generation prompt. |
| `tools: []` | Turns off all built-in tools. |
| `mcpServers` with our own MCP server instance | Offers our own tools from inside our process. Claude sees them as `mcp__opencode__<tool>`. |
| `hooks` (`PreToolUse`, `PostToolUse`) | Callbacks around each tool call. We use them to match calls to their IDs and to hand PDFs to Claude. |
| `permissionMode`, `allowedTools` | Which tools run without asking. |
| `resume`, `forkSession` | Continue a saved session, or branch it at a given message. |
| `persistSession: false` | Runs a one-shot call without saving a session, for titles. |
| `includePartialMessages` | Streams text and thinking as they are generated. |
| `setModel`, `setMcpServers`, `interrupt` | Live controls on a running session. |
| `applyFlagSettings` | Changes the effort level on a running session. |
| `initializationResult()` | Claude Code version, account type and model list (with supported effort levels), without a model call. Models carry no context size. |
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

1. **Register a "Claude Code" provider and its models** with `ctx.provider.transform` (`packages/plugin/src/effect/provider.ts`). Each model's package points at a placeholder file inside the plugin (see "Provider loading"). Models are registered right away from the last saved model list, or a built-in list on first run. The login check runs in the background and update the list with `ctx.provider.reload()`, so opencode never waits on them at startup.
2. **Show up as connected** in opencode's provider list. `ctx.integration.transform` adds an `external` login method, "Claude Code login (`claude auth login`)", the same way Google Vertex offers gcloud login (`packages/core/src/plugin/provider/google-vertex.ts:116-130`). opencode stores only which method was chosen, never a token (`packages/core/src/integration.ts:766-790`).
3. **Supply our own model** through the `aisdk` `sdk` hook (`packages/plugin/src/effect/aisdk.ts`), the way GitHub Copilot does (`packages/core/src/plugin/provider/github-copilot.ts:264-276`). We return an AI SDK `LanguageModelV3` whose `doStream` drives the Claude SDK instead of making an HTTP call. opencode converts its events into its own (`streamPartEvents` in `packages/core/src/aisdk.ts`).
4. **Know which session a call belongs to, and what kind of call it is.** opencode sends an `x-opencode-session-id` header with every model call, including titles, compaction and generate (`packages/core/src/session/model-request.ts:279-320`), and the bridge passes headers through to `doStream` (`aisdk.ts:492-513`). Our `ctx.session.hook("model.request")`, limited to our provider, adds the call's kind (primary, compaction, title or generate) as another header.
5. **Remember state** with `ctx.storage`: which Claude session belongs to each opencode session, and what Claude has already seen.

Conversation content and tools come from the final request our model receives, after every other plugin's hooks. Chat system instructions follow the preset-and-append policy below.

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
- **System prompt.** Chat uses `{ type: "preset", preset: "claude_code", append: ... }`, keeping Claude Code's own instructions and appending a short note that it runs in OpenCode. This follows OpenChamber and T3 Code. We do not forward opencode's assembled built-in agent prompt. Phase 4 adds tool guidance and the Code Mode catalog; phase 6 adds custom agent roles and opencode's instruction files. Titles and other one-shot calls use OpenCode's task instructions as the SDK system prompt, with source conversation kept in the user message.
- **Process lifetime.** One `claude` process per active opencode session. It is stopped after an idle period and resumed with `resume` when needed. Processes live in one registry for the whole opencode process, not inside a single plugin setup, so a plugin reload doesn't kill running sessions: the old setup keeps them for about 10 seconds so the new one can take them over. A session's process is replaced one at a time, so a restart waits for the previous one to finish. After compaction the old process is never reused.
- **Stopping a process.** Always in this order: `interrupt()`, then read the remaining messages until Claude Code has finished writing its session file, then close. Closing first, or failing waiting tool handlers first, can make Claude start another model call or leave its session file on the wrong branch.
- **Finding `claude`.** The plugin passes the user's installed binary in `pathToClaudeCodeExecutable` and doesn't install the SDK's bundled copy. On Windows it uses `claude.exe`, not the `.cmd` wrapper.
- **Login check.** Before offering the models, check that `claude` is installed and logged in, without using any tokens. Start a session whose input never sends a message, call `initializationResult()`, then close it. It takes under a second, writes no session file, and returns the Claude Code version, the account and the model list. A logged-out `claude` still starts and reports an account with no subscription. The check runs when the plugin starts and again each time the user connects the login method, because opencode keeps a problem per connection (a new connection starts with none) and the user may have just run `claude auth login`. Checks run one at a time and look up the executable each time, so connecting after installing or signing in can recover without a plugin reload.
- **Version check.** The reported version must be at least 2.1.248, which added `verbatimPrompts`; older binaries silently ignore it. Binaries that report an older version, or omit their version, get a message to run `claude update`. This is a minimum feature check; the tested versions are listed in Background.
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
- fingerprints of the visible message groups Claude has already seen, with transcript message IDs at known boundaries

The history field is separate from the session ID. A phase-2 record has no verified fingerprints and is rebuilt once. Catch-up can put several OpenCode messages into one Claude user message, so its interior messages have fingerprints but no independent Claude boundary; only the end of the catch-up/current user group gets that user message's UUID.

A fingerprint covers what the model can see: each message's role, its text, attachments, and its tool calls (name, ID and input) and tool results. It leaves out thinking and provider metadata, because opencode sends those differently depending on which model a message goes to (`to-llm-message.ts:153-233`). opencode never sends message IDs or timestamps to the model, but tool call IDs come through unchanged (`aisdk.ts:541-625`).

A run of back-to-back user messages is compared as a group, ignoring their order. opencode can add notes, such as Plan mode reminders, just before the latest user message (`packages/core/src/plugin/plan.ts:55-72`), and they don't always end up in the same spot.

Images from tool results arrive as a separate user message right after the result (`aisdk.ts:522-536`). The plugin counts that message as part of the tool result, not as new user input.

A few rare things change earlier messages: images trimmed once a session passes 25 MB (`model-request.ts:132-215`), thinking in an interrupted reply passed on as text (`to-llm-message.ts:153-183`), and the max-steps note, which is only sent once (`packages/core/src/session/runner/llm.ts:226-244`). These show up as changed history and are handled like any other edit.

The plugin compares against the request it receives, after every plugin's `context` hook has run. That way Claude's copy matches exactly what opencode would send to any other model.

Our replies also carry Claude's session and message IDs as provider metadata on their text and tool-call parts. opencode saves it and sends it back on later calls to the same model, keyed by the model's canonical ID or provider ID (`aisdk.ts:369-377`, `439-452`, `717-720`; `packages/core/src/session/runner/publish-llm-event.ts:153`). It is not sent back for replies that ended in an error, or after a switch to a different model ID. A forked opencode session copies it (`packages/core/src/session/projector.ts:192-225`) but has no record of its own yet, so the plugin uses the newest reply that still has an ID to find the Claude session to branch from.

### The four cases

Before every main model call, the plugin compares the request's messages with the record:

1. **In sync.** Send only the new user message, or the tool results Claude is waiting on.
2. **Other models added turns** (for example Claude → GPT → Claude). Resume the Claude session and send a catch-up of only the new turns. Claude keeps its real memory of its own turns, and its cache stays warm.
3. **Earlier history changed or got shorter** (undo, edit, fork, compaction, or a plugin editing earlier messages). Branch Claude's session at the last matching message with `forkSession(sessionId, { upToMessageId })` (`sdk.d.ts:854`), resume the branch, and save its new session ID in the record. The SDK remaps every message UUID when forking, so refresh saved boundary IDs from the forked transcript rather than carrying over the old UUIDs. Then continue as in case 1 or 2. Branching never changes the old session, so a rewind can't leave Claude on the wrong branch.
4. **Nothing matches.** Start a new Claude session with a catch-up of the whole history.

Before reopening a saved session, `ClaudeIO.sessionExists` checks the documented SDK `getSessionInfo` lookup. A missing local transcript also takes case 4. This handles transferred sessions without parsing CLI error strings or retrying arbitrary failures.

Convert the prompt before opening a process. A rejected attachment must not leave a fresh process paired with an older saved record on the next request.

Case 4 is always safe. Cases 1–3 save tokens and keep Claude's memory intact. If anything looks wrong, fall back to case 4.

### Other session changes

| opencode event | What the plugin does | Extra cost |
|---|---|---|
| Undo, or editing a message (revert plus a new prompt) | opencode deletes the later messages (`projector.ts:759-794`). Branch Claude at the last matching message (case 3). | Low |
| Fork | opencode copies messages into a new session (`projector.ts:117-150`). Branch the Claude session with `forkSession`, using the Claude IDs in the copied replies. Any later turns go in a catch-up. | Low |
| Compaction | History becomes one summary message, so case 4 applies and we start a fresh, small Claude session. A tool call still waiting in the old process is cancelled and that process stopped. | Low |
| Agent switch | Built-in agents keep the Claude Code preset. From phase 6, a changed custom agent role changes the appended instructions and restarts with `resume`. | Cache miss when appended instructions change |
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
| Project instructions | opencode's AGENTS.md and configured instruction files (forwarded from phase 6); Claude Code supplies the base prompt | `settingSources: []`, plus env `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` |
| Skills | `skill` tool and the skill list in the prompt | `skills: []` |
| Hooks, MCP servers and plugins from `~/.claude` | opencode's | `settingSources: []`, `strictMcpConfig: true`, settings `disableAllHooks: true` |
| Permissions | opencode asks inside the tool | `permissionMode: "dontAsk"`, `allowedTools: ["mcp__opencode__*"]` |
| Compaction, including idle compaction (summarises a long conversation after about an hour idle, just before the cache expires) | opencode's | env `DISABLE_AUTO_COMPACT=1`, which turns off both |
| Session recap ("while you were away" summary) | none | env `CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0` |
| Web search, todos, plan mode, questions, subagents | opencode's tools and agents (`question`, the `plan` agent, `task`, websearch) | `tools: []` |
| Tool search (hides tool schemas until searched) | none | env `ENABLE_TOOL_SEARCH=false` |
| Advisor tool (asks a larger model for advice) | none | env `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` |

Notes:

- Claude Code's own instruction-file loading stays off. Phase 6 forwards opencode's AGENTS.md and configured instructions once; phase 2 does not yet forward them.
- Claude Code supplies its own base instructions and environment context. Its runtime also adds an SDK introduction and a reminder holding the user's account email. We do not duplicate opencode's environment block in the chat system prompt.
- `--bare` / `CLAUDE_CODE_SIMPLE` must stay off. It skips OAuth, so the subscription wouldn't work.
- Claude Code's start-up reply still lists the user's own skills and commands from `~/.claude`, but with these settings the model doesn't see them (checked live against CC 2.1.301).

### Things that need translating

- **Tool definitions.** opencode tools use JSON Schema, and the SDK's TypeScript `tool()` helper only accepts zod. We build our own MCP server with the low-level `Server` class from `@modelcontextprotocol/sdk`, list the JSON Schemas directly, and pass the instance in `mcpServers` (`McpSdkServerConfigWithInstance`, `sdk.d.ts:1238`). Phase 4 restarts/resumes when the catalog changes. The pinned SDK's `setMcpServers` treats a server with the same name/config as unchanged, even if its in-process instance has different tools; live catalog updates remain phase-6 work.
- **Tool errors.** OpenCode 2.0.31 lowers its error results to ordinary AI SDK text outputs (`aisdk.ts:665–669`). A provider-scoped context hook preserves the error status in provider metadata before conversion; the MCP bridge uses it for `isError`. It does not infer errors by parsing successful tool text.
- **Large tool output.** Claude Code caps tool results at 25k tokens (`MAX_MCP_OUTPUT_TOKENS`) and saves text over 50k characters to a file, which Claude can't read with its tools off. We raise those limits (`_meta["anthropic/maxResultSizeChars"]` goes up to 500k) and rely on opencode's own truncation.
- **Tool names.** Claude sees `mcp__opencode__read` while opencode's prompts say `read`, so the plugin maps names both ways. Claude Code silently hides any tool whose full name is over 128 characters. We keep full names to 64 characters and shorten longer ones with a short hash.
- **Tool descriptions.** Claude Code cuts tool descriptions at 2048 characters. opencode's subagent tool ends its long description with the list of available agents, so the plugin moves that list to the front, where it survives the cut.
- **System prompt changes.** The plugin compares the effective Claude system prompt, not opencode's assembled prompt, and restarts with `resume` when it changes. The preset and runtime note are fixed in phase 2. Phase 6 adds custom agent roles and instruction files to the append. Mid-session `<system-update>` user messages (`aisdk.ts:540-557`) still pass through as conversation content.
- **Reminders and other mid-session messages.** Plan-mode notes, folder changes and "continue" nudges are ordinary user messages, so they pass through. Messages steering an active turn while tools are running arrive after the tool results. Send them before resolving the waiting results with SDK priority `next`. Live tests confirm that `now` interrupts the waiting turn and emits an extra terminal result instead of joining the next model call. Follow-ups after an OpenCode stop use a fresh turn instead, as described below.
- **Effort levels.** Each effort level is an opencode model variant, built from the login check's model list. It reaches our model in the request's provider options and is changed live with `applyFlagSettings`.
- **Max output tokens.** Set through `CLAUDE_CODE_MAX_OUTPUT_TOKENS` when the process starts. A change restarts the process with `resume`.
- **Max steps.** When an agent hits its step limit, opencode sets `toolChoice: "none"`, which Claude Code can't express. The plugin omits our tools for that call. Phase 4 restarts/resumes for that catalog change; phase 6 will optimize live updates.
- **Context size.** Claude Code's model list has no context size; it is only reported after a call (`modelUsage`). The models keep opencode's default of 200k tokens, which is Claude Code's window for every model on the list (checked live against CC 2.1.301 on a Team plan). A plan that lists 1M-context models (`[1m]`) would compact earlier than needed, which is safe.
- **Title model.** opencode picks a cheaper model for titles by family name (`Model.small` in `packages/core/src/model.ts`), so Haiku models get the `claude-haiku` family.
- **Plan limit reached.** Claude reports `rate_limit` errors and rate-limit events with a reset time (`sdk.d.ts:3751`, `5756-5792`). The plugin shows a clear message with the reset time and suggests switching models. A rate-limit event marked "rejected" isn't always a hard stop, and a later "allowed" event clears it, so the plugin reports a limit only when a call actually fails. Reset times can be hours or days away (weekly limits).
- **Cancelling.** opencode doesn't pass an abort signal to our model. During streaming, its stream cancellation calls `interrupt()` and drains the terminal result. Between steps, Claude can still be waiting on tools after OpenCode stops. OpenCode persists those tool errors with `type: "aborted"`, including plain permission rejections. The context hook preserves that typed signal alongside the error flag through AI SDK lowering. On the next request, the plugin interrupts and drains the old Claude turn, clears waiting handlers, then starts a normal user turn on the same process. OpenCode's saved results go through the existing catch-up path. Ordinary tool errors and permission rejection with feedback continue the active turn. No error-message matching or asynchronous stop-event coordination is needed.

### Side calls: titles, compaction, generate, subagents

Unless an agent overrides the model, these use the session's model, which means our plugin. The kind header tells the plugin which kind of call it is handling.

- **Titles.** OpenCode owns the hidden title agent, prompt, model choice and result handling. An explicit title-agent model wins; otherwise OpenCode picks a "small" model from the same provider by family name, including Haiku, with the main model as fallback (`packages/core/src/model.ts:273-285`, `session/context.ts:95-119`). If it selects this provider, we run a one-shot `query()` with no tools and `persistSession: false`, passing its task instructions as `systemPrompt`. The source conversation stays in user content. Titles use the same isolation settings as the main session, including the env vars; otherwise Claude Code's auto memory leaks into them. `prewarm()` can cut startup time.
- **Compaction and generate.** Generate calls come from `session.generate`, which answers a side question from the session's context without changing the session (`packages/core/src/session/generate.ts`). Both kinds arrive with the full history plus their own system instructions. Currently they use isolated, non-persistent queries like titles. Phase 5 adds throwaway branches through `forkSession` for history reuse; that work must preserve the system role of the task instructions and leave the main session untouched.
- **Generating text without a session** (`ctx.generate.text` with one of our models): a one-shot `query()`, like titles.
- **Subagents.** These inherit the parent's model (`packages/core/src/tool/plugin/subagent.ts:184`), so each one gets its own Claude session and `claude` process. Several subagents in parallel means several processes.

## opencode plugin hooks

Most hooks work unchanged, because opencode still builds every request, runs every tool and stores the history. The ones that don't are hooks on the HTTP request to the model provider: Claude Code sends that request itself, out of opencode's sight. The Promise plugin API mirrors the Effect one, so the same answers apply. TUI plugins only touch the interface and aren't affected.

| Hook | Works? | Notes |
|---|---|---|
| `session.hook("prompt")` | Yes | Runs before the message is queued. |
| `session.hook("context")` | Partly | History changes reach Claude. The assembled chat system prompt is not forwarded wholesale (see "System prompt"). Changing earlier messages has a cost (see "Plugins that edit history" below). |
| `session.hook("compaction")` | Yes | If a plugin supplies the summary, we just see a shorter history. Otherwise the call reaches us and runs on a branch. |
| `session.hook("generate")` | Yes | Shapes generate calls, which run on a branch. |
| `session.hook("title")` | Yes | If a plugin supplies the title, no call reaches us. |
| `session.hook("model.request")` | Partly | Headers reach our plugin but never Anthropic. A changed `baseURL` is ignored. We use this hook ourselves to tag the call's kind. |
| `session.hook("http.request")`, `"http.response"` | No | Never fire. They only wrap opencode's own HTTP client (`model-request.ts:337-365`). |
| `session.hook("experimental.ws.handshake" / "send" / "receive")` | No | Never fire. There is no WebSocket. |
| `session.hook("retry")` | Partly | Claude Code retries API errors itself first (`sdk.d.ts:3640`). opencode's retries, and this hook, only see errors after it gives up. We use it to stop opencode retrying them again. |
| `tool.transform` | Yes | Catalog changes restart/resume in phase 4; live updates are deferred to phase 6. |
| `tool.hook("execute.before")`, `"execute.after"` | Yes | opencode runs every tool. |
| `permission.hook("evaluate")`, `permission.assert` | Yes | |
| `shell.hook("create.before")` | Yes | |
| `aisdk.hook("sdk")`, `"language"` | Yes | We use the `sdk` hook. Another plugin hooking our provider could replace our model. |
| `provider.transform`, `model.transform` | Yes | We use `provider.transform`. Model transforms can hide or edit our models as usual. |
| `agent.transform` | Partly | Models, permissions and step limits work. Built-in agent prompts are replaced by the Claude Code preset; custom roles are appended from phase 6. Most generation settings, such as temperature, are ignored (see "Incompatible features"). |
| `command`, `mcp`, `skill`, `reference`, `websearch`, `vcs` and `integration` transforms | Yes | These become text, tools or prompt content before the model sees them. MCP tools reach Claude as opencode tools, and opencode handles MCP requests for user input. We use `integration.transform` for the login method. |

Everything else on the plugin context (`event`, `storage`, `rpc`, `worktree`, `credential`, `generate`, `experimental.terminal` and the `session` calls) doesn't touch the model call and works as usual.

### Plugins that edit history

Claude's copy of the conversation can only grow or be rewound. It can't be edited in the middle. When a `context` hook changes an earlier message (for example a context-pruning plugin replacing old tool output), the plugin rewinds Claude to just before the first changed message and sends everything after it as a catch-up.

Normal models lose their prompt cache after an edit too, so the token cost is similar. The extra loss is that Claude's turns after the edit become a catch-up instead of memory. A change to the effective Claude system prompt also means restarting the `claude` process.

Occasional edits are fine. A plugin that changes earlier history on every step (for example by adding a timestamp) turns every step into a restart and a catch-up. Changes only to opencode's assembled built-in system prompt do not cause a restart.

## Incompatible features

These opencode features won't work with Claude Code models:

- **Hosted opencode.** No workerd or Durable Objects, since the SDK needs child processes, a real filesystem and the `claude` binary.
- **HTTP and WebSocket plugin hooks.** Plugins that log, proxy or rewrite model requests see nothing.
- **Custom base URLs and request headers** for the Claude Code provider, such as a company gateway. Claude Code talks to Anthropic directly, and the ground rules rule out redirecting it.
- **Generation settings** from agents, variants or hooks: temperature, top-p, top-k, frequency and presence penalties, seed and stop sequences. Claude Code has no options for them. Max output tokens is the exception (see "Things that need translating").
- **Plugins that edit earlier history on every step** (see "Plugins that edit history").
- **Full system-prompt parity.** Built-in agent prompts and arbitrary system-only context-hook additions are not forwarded wholesale. Custom roles and instruction files are added selectively from phase 6.
- **Session warming** (the `warming` setting, `packages/core/src/plugin/warming.ts`). It sends a keep-alive request every few minutes to keep the prompt cache alive. Claude Code's subscription cache already lasts an hour, so warming only uses up plan limits. It should be off for Claude Code sessions.
- **Cost tracking and budgets.** Claude Code models cost $0 in opencode. Plan usage only shows through rate-limit messages.

## Known limitations

- Claude reads turns from other models as a catch-up message, not as its own memory.
- Plan limits run out faster than in Claude Code itself (about 1.7×).
- Chat follows Claude Code's base instructions, with its environment context, SDK introduction and account reminder, rather than opencode's built-in agent instructions.
- After compaction, Claude restarts from the summary, the same as any other model.
- Recovery after a crash mid-turn is limited. Resuming between turns works.
- Every side call (such as a title) starts a `claude` process and uses plan limits.
- Each subagent running in parallel is a separate `claude` process.

## Open questions

- **Catch-up messages.** The phase-3 live test verifies marker recall from another model and a tool result, including a full rebuild after deleting the local transcript. Tool-heavy histories will get broader coverage with the phase-4 bridge.
- **Resuming while a tool call waits.** Phase 4 verifies interrupt-and-drain shutdown and a usable resumed session. Results saved by OpenCode after shutdown are delivered as tagged catch-up text; the interrupted native calls already have refusal results in Claude's transcript.

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
│   │   ├── io.ts           Starting claude and checking saved sessions; fork/delete in phase 5. Tests swap it
│   │   ├── query-options.ts  Shared settings: user's binary, everything we turn off, permissions
│   │   ├── status.ts       The login check's latest result, shared by every feature
│   │   ├── session.ts      One Claude process: input queue, single reader, interrupt, drain, close
│   │   ├── sessions.ts     Session registry: serialization, resume/restart, idle shutdown, reload handover, side-call cleanup
│   │   └── probe.ts        Login check, version check, model list (saved for the next start)
│   │
│   ├── language-model/     The AI SDK model, laid out like opencode's github-copilot/
│   │   ├── claude-code-provider.ts        createClaudeCode() → { languageModel(id) }
│   │   ├── claude-code-language-model.ts  doStream: select chat or side-call prompt, run the request, stream back
│   │   ├── request-kind.ts                Request kind and session headers
│   │   ├── system-prompt.ts               Claude Code preset for chat; small fixed prompt for side calls
│   │   ├── convert-to-claude-message.ts   opencode prompt → Claude message (text, tool history, images, PDFs)
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
// The registry lives outside setup's scope, so a reload can adopt its processes. Restart tests pass their own.
export const make = (io: ClaudeIO.Interface, registry = ClaudeSessions.registry()) =>
  define({
    id: "claude-code",
    effect: Effect.fn("ClaudeCode.Plugin")(function* (ctx) {
      const options = yield* ClaudeCodeOptions.decode(ctx.options).pipe(Effect.orDie)
      const status = yield* ClaudeStatus.make({ options, io })
      const sessions = yield* registry.attach({ options, io, storage: ctx.storage, directory: ctx.location.directory })
      for (const feature of features) {
        yield* feature.effect(ctx).pipe(
          Effect.provideService(ClaudeStatus.Service, status),
          Effect.provideService(ClaudeSessions.Service, sessions),
        )
      }
      yield* status.refresh().pipe(Effect.forkScoped)
    }),
  })

export default make(ClaudeIO.real)
```

### One step through the code

1. `plugin/aisdk.ts` has given opencode our model from `language-model/claude-code-provider.ts`.
2. opencode calls `doStream` in `claude-code-language-model.ts`, which reads the session and kind headers.
3. `sync/decide.ts` compares the request with the record from `sync/record.ts` and picks one of the four cases. `sync/catch-up.ts` builds a catch-up message when one is needed.
4. `claude/sessions.ts` returns the live Claude session, starting or resuming it with the settings from `claude/query-options.ts`.
5. `convert-to-claude-message.ts` builds the message, or `tools/pending.ts` hands over the tool results Claude is waiting on.
6. `convert-claude-stream.ts` turns Claude's replies into opencode stream events. A tool call parks its handler in `tools/pending.ts` and ends the step.

### Where future changes go

| Change | Where |
|---|---|
| A new opencode hook we need | New file in `plugin/`, added to the list in `index.ts` |
| Another Claude Code feature to turn off | `claude/query-options.ts` |
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

**Build:** the layout from Code structure, loading the plugin from its folder, the `file://` placeholder package, provider and model registration from the saved list and then the login check's model list (effort variants, Haiku's family, empty cost), the `external` login method, the zero-token login and version checks, the isolation settings, and `ClaudeIO`.

**Test harness:** the fake `claude` (start-up only at first), the opencode-in-a-test helper, recording, the live-test gate and the packaging check. The test plugin comes in phase 3 and the in-memory session files in phase 5, where they are first used.

**Done when:** Claude Code models show in the TUI and the login method shows as connected. A test running opencode sees the same models. The packaging check loads the plugin from its folder. A live run records a start-up.

### 2. Text chat

**Build:** no tools yet. One long-lived Claude session per opencode session, with the kind header, resume across turns, cancelling, stopping processes in the right order, the registry that survives plugin reloads, usage per API message, `verbatimPrompts`, and image and PDF attachments. The packaging check adds an `opencode run` that gets a reply from `test/bin/claude`, which also checks the `file://` placeholder in the released `opencode`. Until our model can answer, opencode retries its error, so phase 1 can't check this.

Chat uses the Claude Code preset plus an OpenCode runtime note. Titles and other side calls use isolated, non-persistent queries and preserve OpenCode's task instructions in the SDK system prompt. The registry owns all processes, including running side calls. Disable opencode's outer retries here: Claude Code already retries API failures, and replaying a completed, failed turn repeats permanent errors too.

**Scope:** model or effective Claude system-prompt changes restart with resume. History reconciliation belongs to phase 3; tool guidance to phase 4; compaction/generate branches to phase 5; custom roles, project instructions and live model controls to phase 6. Prompt compatibility experiments are documented in [TESTING.md](TESTING.md#system-prompt-compatibility).

**Done when:** a conversation in the TUI works across several turns and after restarting opencode, cancelling leaves a usable session, and token counts and context size show correctly.

### 3. Sync

**Build:** fingerprints, the record, catch-up messages, the four cases, and the Claude IDs in provider metadata. Still no tools. Until branching is added in phase 5, case 3 (changed or shortened history) uses case 4's safe fallback: a fresh Claude session with a catch-up of the current history.

Extend `sync/record.ts`, which already owns the stored Claude ID. Keep the durable Claude ID separate from the fingerprint of fully synchronized history: phase 4 must be able to remember a session while a tool handler is still waiting, before its turn's final `result`.

**Done when:** in the TUI, a session can switch from Claude Code to another model and back, in both directions, and Claude remembers what happened while it was away. Tests cover all four decisions, including a `context` hook that edits history and verifies the fresh-session fallback for case 3.

### 4. Tools

**Build:** opencode's tools through our MCP server: JSON Schema tools, waiting handlers, matching through `PreToolUse`, tool name mapping and description fitting, tool errors, failing closed, output limits, images and PDFs in results, and finish reasons. Append tool-routing guidance, Code Mode's catalog, MCP notes and skill guidance to the Claude Code preset when those tools are offered.

**First:** separate an opencode step from a Claude turn. Phase 2's `send()` waits for `result`; a tool call must instead end the current `doStream` step while Claude's turn and reader remain alive. Release the step's ownership without interrupting the parked turn, then hand its tool results back on the next step. Keep interrupt-and-drain for actual cancellation. Test two consecutive tool steps before adding the rest of the bridge.

**Done when:** Claude Code reads and edits files in the TUI with opencode's permission prompts, cancelling during a tool call leaves a usable session, and switching models in the middle of tool work still works.

**Implementation status:** complete. Offline, embedded OpenCode and live tests cover consecutive tool steps, permissions, cancellation, media, catalog changes, model switching, exited-process recovery and multiline Code Mode catalogs. Manual TUI checks on 2026-10-16 verified approval/rejection, stopping a running shell command, and switching to another provider and back. Follow-up fixes preserve OpenCode's stopped-turn boundary through SDK interrupt/drain and normal new user input; title calls preserve native task system instructions. The TUI recheck produced a proper title and exact follow-up replies after both rejection and cancellation, with normal user turns confirmed in the Claude transcript. Typecheck, 63 offline tests and 11 affected live tests passed. See [the TUI results and investigation](TESTING.md#manual-tui-acceptance).

### 5. Undo, fork, compaction and generate

**Build:** branching through `forkSession`, with compaction and generate calls run on throwaway branches.

**Done when:** after undo, fork or compaction in the TUI, Claude remembers exactly what the opencode session shows, checked live with marker words.

### 6. Side calls and polish

**Build:** polish the basic one-shot titles from phase 2, append custom agent roles and opencode instruction files (AGENTS.md and configured instructions) to the Claude Code preset, restart when those effective instructions change, live model/effort and max output token changes, max steps, plan-limit and billing error messages (the retry hook is in phase 2), the empty-success check, the API-key billing warning, and `claude.exe` on Windows. Built-in agents keep the Claude Code base prompt.

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

- Prompt implementations checked on 2026-10-16: [OpenChamber `src/proxy.ts`](https://github.com/openchamber/opencode-claude/blob/9fa38cfac2b7165c01423f583ccfa56239448209/src/proxy.ts#L1457-L1493) (preset plus runtime, tool routing, catalogs, MCP notes, skills, custom role and project instructions), [its runtime note](https://github.com/openchamber/opencode-claude/blob/9fa38cfac2b7165c01423f583ccfa56239448209/src/prompt.ts#L1054-L1061), and [T3 Code's adapter](https://github.com/pingdotgg/t3code/blob/f1e0a4d4d0600b2803e311989151c7f89ced3251/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1189-L1195) (preset plus runtime and optional orchestration instructions).

- T3 Code, a working SDK integration to borrow process handling, the login probe and attachment code from: https://github.com/pingdotgg/t3code (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `apps/server/src/provider/ClaudeProvider.ts`)
- OpenChamber's opencode V2 plugin on the official SDK, with opencode's tools offered through MCP. Source of several lessons in this plan (process shutdown order, surviving plugin reloads, usage counting, rate-limit events, tool descriptions): https://github.com/openchamber/opencode-claude (`src/bridge-pool.ts`, `src/query.ts`, `src/usage.ts`, `src/rate-limit.ts`, `CHANGELOG.md`)
- Earlier community Claude Code providers for opencode V1, loaded as npm or `file://` provider packages: https://github.com/khalilgharbaoui/opencode-claude-code-plugin, https://github.com/youhaowei/opencode-claude-code-provider
- Usage measurement source: the `claude-subscription-directsdk` README in https://github.com/NousResearch/hermes-official-plugins
- Claude Code environment variables: https://code.claude.com/docs/en/env-vars
- Anthropic policy: https://code.claude.com/docs/en/legal-and-compliance
- Agent SDK use with a Claude plan: https://support.claude.com/en/articles/15036540
