# Testing

How the plugin is tested. [PLAN.md](PLAN.md) covers the design and the order of work.

## Summary

Four levels. Most tests run against a fake `claude` program, so they are fast, offline and use no plan limits.

| Level | Runs for real | Faked | Covers |
|---|---|---|---|
| 1. Pure logic | Our plain functions | Nothing | Message and stream conversion, fingerprints, the four sync cases, catch-up messages, tool names and descriptions, usage, errors |
| 2. Fake Claude Code | The Claude SDK and our model code | The `claude` program | Text and thinking, waiting tool calls, matching tool IDs, cancelling during a tool call, PDFs from tools, shutdown order, plugin reloads, plan-limit errors |
| 3. Inside opencode | opencode's session loop, tools, permissions, storage and hooks, plus everything in level 2 | The `claude` program, and a scripted "normal" model | Switching models both ways, undo, fork, compaction, titles, cancelling between steps, the retry hook |
| 4. Live | Everything, with real Claude Code and Haiku | Nothing | About ten short scenarios. Also records the traffic that levels 1 and 2 are built from |

Commands:

- `bun test`: levels 1 to 3. Runs in CI.
- `bun run test:live`: level 4. Needs `CLAUDE_LIVE=1` and a logged-in `claude`. Never runs in CI.
- `RECORD=1 bun run test:live`: level 4, saving new recordings.

## Why fake the `claude` program

The parts most likely to break happen inside the Claude SDK as it reacts to `claude`: tool calls waiting for opencode, matching tool calls to IDs through `PreToolUse`, an interrupt stopping a running tool, and PDFs swapped in through `PostToolUse`. Faking the SDK's `query()` function instead would mean copying that behavior into the fake, and the tests would check our copy rather than the SDK.

The SDK has an official option for replacing how it starts `claude`: `spawnClaudeCodeProcess` (`sdk.d.ts:2489`, meant for running Claude Code in VMs and containers). Our fake plugs in there and runs inside the test process, so no real program starts.

## How the SDK talks to `claude`

Recorded with Claude Code 2.1.301 and SDK 0.3.301 (`/tmp/opencode/claude-sdk-lab/q9-wire.ts`). Every message is one line of JSON, in both directions.

1. The SDK starts `claude` with flags for everything we set: model, allowed tools, no built-in tools, no settings, permission mode, no session files.
2. The SDK sends a start-up request (`control_request` `initialize`). It holds the system prompt, our hook IDs and our MCP server with its full tool list.
3. `claude` replies (`control_response`) with its version, account, models and commands.
4. The SDK sends the user message.
5. `claude` sends normal messages: session state, `system` `init`, rate-limit events, assistant text and tool calls, and a final `result`.
6. When `claude` needs our code, it sends a request and waits for the answer:
   - `hook_callback` runs one of our hooks, such as `PreToolUse`.
   - `mcp_message` calls one of our tools (`tools/call`, with `_meta["claudecode/toolUseId"]`). The SDK answers once our handler returns.
7. An interrupt is a request from the SDK to `claude`.

`claude` picks the IDs of its own requests. The SDK picks a random ID for its start-up request, and replies must use the ID the SDK actually sent.

This format is internal to Claude Code and not documented. Recordings (below) are how we notice when it changes.

## Level 1: pure logic

The plain-function modules from PLAN.md's Code structure (`sync/` except `record.ts`, the converters, `tools/names.ts`, `tools/result.ts`, `language-model/usage.ts`, `claude-code-error.ts`). Inputs are opencode prompts and Claude messages. Claude messages are copied from recordings, never invented.

## Level 2: fake Claude Code

The real plugin model code and the real SDK, with `test/lib/fake-claude.ts` in place of `claude`. A test gives the fake a script of steps:

```ts
const claude = FakeClaude.make([
  FakeClaude.expectStartup(),
  FakeClaude.expectUser({ text: "read the readme" }),
  FakeClaude.send(assistantToolUse({ id: "toolu_1", name: "mcp__opencode__read", input: { path: "README.md" } })),
  FakeClaude.askHook("PreToolUse", { tool_use_id: "toolu_1" }),
  FakeClaude.askTool("mcp__opencode__read", { toolUseId: "toolu_1" }), // waits for our handler
  FakeClaude.send(toolResult("toolu_1")),
  FakeClaude.send(assistantText("done")),
  FakeClaude.send(result()),
])
```

- `expect...` steps check what the SDK wrote. `send` steps write a line as `claude`. `ask...` steps send a request and wait for the SDK's answer.
- The fake answers the start-up request with a recorded start-up reply.
- It keeps everything the SDK sent (flags, environment, start-up request, user messages, answers), so tests check both directions.
- A test fails if a step is unfinished, including a requested step whose reply is still held back, or if the SDK writes something the script didn't expect. A test that deliberately interrupts a held reply checks that it is unfinished and that the process closes.
- Tests wait on the fake's steps (`claude.started(step)` before a held reply, `claude.reached(step)` after it finishes), never on time. Each run also exposes `closed` to check cleanup. Changes the plugin then makes inside opencode in the background (a new model list, a connection problem) are awaited by checking again every few milliseconds until they show (`TestOpenCode.waitUntil`), as opencode's own tests do.
- A recording can be replayed as a script: its SDK lines become `expect` steps and its `claude` lines become `send` and `ask` steps.

Branching and deleting Claude sessions (`forkSession`, `deleteSession`) work on Claude's session files directly (`sdk.d.ts:840-866`), not through `claude`. They are part of `ClaudeIO` (below), and level 2 and 3 tests replace them with a small in-memory version.

## Level 3: inside opencode

opencode runs inside the test through `@opencode/sdk` (published on npm). `OpenCode.create({ plugins })` starts the real server and session loop with an in-memory database and accepts our Effect plugin directly (`packages/sdk/src/internal/host.ts:18-68`, example in `packages/sdk/test/embedded.test.ts`). Plugins passed this way load after opencode's built-in plugins, the same as a configured plugin, so the `file://` placeholder is used here too.

```ts
await using oc = await OpenCode.create({
  plugins: [ClaudeCode.make(fakeIO), TestPlugin],
  config: { directory: configDir, project: false, content: "{}" },
  models: { fetch: false },
  fs: { filewatcher: false },
})
const session = await oc.sessions.create({ location: { directory: projectDir } })
await oc.sessions.switchModel({ sessionID: session.id, model: { providerID: "claude-code", id: "sonnet" } })
await oc.sessions.prompt({ sessionID: session.id, text: "Use the test tool" })
await oc.sessions.wait({ sessionID: session.id })
const messages = await oc.sessions.context({ sessionID: session.id })
```

`test/lib/test-plugin.ts` adds:

- **A scripted "normal" model.** A provider whose model is a hand-written `LanguageModelV3` that replies from a list, like the one in `packages/core/test/aisdk.test.ts:43-74`. Used for switching tests. opencode's `TestLLM` can't be used, because it replaces every model, ours included.
- **A test tool** with a fixed result, and a `context` hook that can edit history when a test asks it to.

Tests check what opencode saved, what the fake received, and what our plugin stored.

**Packaging check.** One test loads the plugin from its folder through an opencode config file, in a fresh home folder, with a fake `claude` executable (`test/bin/claude`, the same fake over real stdin and stdout) passed through the plugin's `claudePath` option. It runs `opencode auth login` and `opencode models`, and from phase 2 an `opencode run` that gets a reply. It checks the root `server.ts`, real option parsing and, through `opencode run`, the `file://` placeholder in the released `opencode`. It uses the `opencode` on `PATH` and is skipped if there isn't one.

## Level 4: live

The level 3 setup with the real `ClaudeIO` and Haiku.

Rules:

- Runs only when `CLAUDE_LIVE=1` is set, and is skipped if `claude` isn't logged in.
- Never runs in CI.
- Checks for marker words placed in prompts and tool results, never exact wording.
- Prints how many model calls it made.
- Deletes the Claude sessions it created.
- Creates its own attachments in a temporary folder.

Scenarios:

1. A plain reply that repeats a marker word.
2. One tool call, with the marker coming from the tool result.
3. Two tool calls in one reply.
4. Cancelling during a tool call, then continuing.
5. Restarting opencode between turns, then asking for an earlier marker.
6. Switching to the scripted model and back, then asking for a marker from the scripted model's turn.
7. Undo, then checking that a marker from the removed turn is forgotten.
8. An image attachment.
9. A PDF from a tool result.
10. A title.

## Recordings

`RECORD=1` wraps the real spawn function and saves every line in both directions, one file per scenario in `test/recordings/` (`test/lib/recorder.ts`). The start-up recordings (`startup`, `startup-logged-out`) come from a login check run on its own, so each file holds one complete `claude` run.

- The first line of each file holds the Claude Code version, SDK version, model and date.
- Before saving, personal details are replaced: account email, organization, user name and home folder paths.
- Recordings are committed, so changes show up in review.

On each Claude Code or SDK upgrade:

1. Update the pinned SDK version, or install the new `claude`.
2. Run `RECORD=1 bun run test:live`.
3. Review `git diff test/recordings` for changes in the format.
4. Run `bun test`, and fix the fake or our code.
5. Update the tested versions in PLAN.md's Background note.

## The test seam

Config options can't hold functions, so the plugin is built by a function. `claude/io.ts` holds everything that reaches outside the plugin: starting `claude`, and Claude's session files. The default export passes the real one, and tests pass a fake.

```ts
export const make = (io: ClaudeIO.Interface) =>
  define({
    id: "claude-code",
    effect: Effect.fn("ClaudeCode.Plugin")(function* (ctx) {
      // ...same as PLAN.md's entry point, with io passed to ClaudeSessions.make
    }),
  })

export default make(ClaudeIO.real)
```

## Test rules

opencode's unit test rules apply (`.opencode/skills/unit-tests` in the opencode repo):

- `bun test`, with a timeout on each test.
- No sleeps. Races are tested with gates (`Deferred`) and the fake's steps. Time-based behavior, such as idle shutdown and the reload handover, uses Effect's `TestClock`.
- No `mock.module` and no `globalThis`. Fakes come in through `ClaudeIO` and plugin options.
- Each test gets its own temporary folders.
- A small `it.effect` / `it.live` helper copied from opencode's `packages/core/test/lib/effect.ts`, since opencode doesn't publish its test helpers.
- Few real processes. Only the packaging check and live tests start any.

## Cases to cover

Many of these come from bugs OpenChamber hit (its `test/*-regression.ts` files and `CHANGELOG.md`).

| Case | Level | Phase |
|---|---|---|
| The start-up flags and environment turn off everything listed in PLAN.md | 2 | 1 |
| Models show from the built-in list until the login check finishes, then from claude's list, with effort variants, Haiku's family, attachment support and empty cost | 3 | 1 |
| Saved models are restored after an opencode restart, before the next login check finishes | 3 | 1 |
| Connecting after the login check shows its result (logged out → sign-in problem), and checks again | 3 | 1 |
| Startup and reconnect checks run in order, so an older account snapshot cannot overwrite the new login | 2 | 1 |
| Installing claude after startup is picked up by the next login check | 2 | 1 |
| A failed startup is reported and the next check can recover; a stuck startup times out and closes its process | 2 | 1 |
| An old or unreported Claude Code version asks the user to update; the minimum supported version is accepted | 2 | 1 |
| Text, thinking and usage arrive in order | 2 | 2 |
| Usage counts each API message once, and context size comes from the last API call, not a sum | 1 | 2 |
| Shutdown goes interrupt, then drain, then close | 2 | 2 |
| One process per session, and an old process stopping never closes its replacement | 2 | 2 |
| A plugin reload keeps live sessions, and waiting tool calls once tools exist | 2 | 2, 4 |
| Switching to another model and back sends only the missed turns, then resumes normally | 3 | 3 |
| Each of the four sync decisions, with case 3 using a fresh-session fallback until phase 5; edited replies, reordered user messages and a missing Claude session, plus edited tool results and tool images once tools exist | 1, 3 | 3, 4 |
| Several tool calls in one reply match the right IDs | 2 | 4 |
| Cancelling during a tool call stops the handler, and Claude records the call as refused | 2 | 4 |
| Cancelling between steps answers the waiting handler with opencode's saved result | 3 | 4 |
| Tool errors reach Claude as errors (`isError`), not as success text | 2 | 4 |
| If our tool server fails, the call fails and no Claude tools turn on | 2 | 4 |
| Images and PDFs in tool results reach Claude | 2 | 4 |
| Shortened tool descriptions keep the subagent list, and long tool names map back | 1 | 4 |
| Undo and fork branch from the right message | 3, 4 | 5 |
| Compaction stops a waiting tool call and doesn't reuse the old process | 3 | 5 |
| Generate calls running at the same time don't cancel each other | 3 | 5 |
| A changed system prompt restarts the process, and an unchanged one never does | 2 | 6 |
| A "successful" result after server errors (`api_error_status`) becomes an error | 1, 2 | 6 |
| Plan-limit events: "rejected" vs "allowed", and weekly reset dates | 1 | 6 |
| An `ANTHROPIC_API_KEY` in the environment shows the billing warning | 3 | 6 |

## Folder layout

```
test/
├── lib/
│   ├── effect.ts          it.effect / it.live helper
│   ├── fake-claude.ts     The fake claude: script steps, replies, everything the SDK sent
│   ├── fake-io.ts         ClaudeIO with the fake claude, plus in-memory session files from phase 5
│   ├── recorder.ts        RECORD=1: saves real claude traffic; loads recordings for the fake
│   ├── opencode.ts        Starts opencode in the test with our plugin (and the test plugin from phase 3)
│   └── test-plugin.ts     Phase 3: scripted "normal" model, test tool, history-editing hook
├── bin/
│   └── claude             The fake as a real executable, for the packaging check
├── recordings/            Real runs, one file per scenario
├── language-model/        Levels 1 and 2, same folders as src/
├── sync/
├── tools/
├── claude/
├── opencode/              Level 3
└── live/                  Level 4
```

## References

- opencode testing examples (paths relative to the opencode repo):
  - `packages/core/test/github-copilot/copilot-chat-model.test.ts`: a custom model tested by calling `doStream` directly
  - `packages/core/test/aisdk.test.ts:43-74`: a scripted `LanguageModelV3`
  - `packages/sdk/test/embedded.test.ts:561-644`: a full session with a tool call inside `OpenCode.create`
  - `packages/core/test/session-model-request-hooks.test.ts`, `session-title.test.ts`, `session-native-compaction.test.ts`: session hook tests
- Claude Agent SDK 0.3.301 `sdk.d.ts`: `spawnClaudeCodeProcess` line 2489, `SpawnedProcess` line 9626, `SpawnOptions` line 9678, `forkSession` lines 840–866
- T3 Code's fake `claude` behind the real SDK: `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts:1944-2054`; recorded replays: `ClaudeAdapterV2.testkit.ts:491-625`; recorder: `apps/server/scripts/record-claude-agent-sdk-replay-fixture.ts` (https://github.com/pingdotgg/t3code)
- OpenChamber's regression tests: `test/*-regression.ts` and `test/haiku-live.ts` (https://github.com/openchamber/opencode-claude)
