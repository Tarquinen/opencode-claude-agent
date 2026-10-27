# Testing

How the plugin is tested. [PLAN.md](PLAN.md) covers the design and the order of work.

## Summary

Four levels. Most tests run against a fake `claude` program, so they are fast, offline and use no plan limits.

| Level | Runs for real | Faked | Covers |
|---|---|---|---|
| 1. Pure logic | Our plain functions | Nothing | Message and stream conversion, fingerprints, the four sync cases, catch-up messages, tool names and descriptions, usage, errors |
| 2. Fake Claude Code | The Claude SDK and our model code | The `claude` program | Text, waiting tool calls, matching tool IDs, cancelling during a tool call, PDFs from tools, shutdown order, plugin reloads, plan-limit errors |
| 3. Inside opencode | opencode's session loop, tools, permissions, storage and hooks, plus everything in level 2 | The `claude` program, and a scripted "normal" model | Switching models both ways, undo, fork, compaction, titles, cancelling between steps, the retry hook |
| 4. Live | Everything, with real Claude Code and Haiku | Nothing | About ten short scenarios. Also records the traffic that levels 1 and 2 are built from |

Commands:

- `bun test`: levels 1 to 3. Runs in CI.
- `bun run test:live`: level 4. Needs `CLAUDE_LIVE=1` and a logged-in `claude`. Never runs in CI.
- `RECORD=true bun run test:live`: level 4, saving new recordings.

## Why fake the `claude` program

The parts most likely to break happen inside the Claude SDK as it reacts to `claude`: tool calls waiting for opencode, matching tool calls to IDs through `PreToolUse`, an interrupt stopping a running tool, and PDFs swapped in through `PostToolUse`. Faking the SDK's `query()` function instead would mean copying that behavior into the fake, and the tests would check our copy rather than the SDK.

The SDK has an official option for replacing how it starts `claude`: `spawnClaudeCodeProcess` (`sdk.d.ts:2489`, meant for running Claude Code in VMs and containers). Our fake plugs in there and runs inside the test process, so no real program starts.

## How the SDK talks to `claude`

Recorded with Claude Code 2.1.301 and SDK 0.3.301 (`/tmp/opencode/claude-sdk-lab/q9-wire.ts`). Every message is one line of JSON, in both directions.

1. The SDK starts `claude` with flags for everything we set: model, allowed tools, no built-in tools, no settings, permission mode, and either a session ID/resume or no session persistence for side calls.
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

The plain-function modules from PLAN.md's Code structure (`sync/` except `record.ts`, the converters, `tools/names.ts`, `tools/result.ts`, `language-model/usage.ts`, `claude-agent-error.ts`). Inputs are opencode prompts and Claude messages. Claude messages are copied from recordings, never invented.

## Level 2: fake Claude Code

The real plugin model code and the real SDK, with `test/lib/fake-claude.ts` in place of `claude`. A test gives the fake a script of steps:

```ts
const claude = FakeClaude.make([
  FakeClaude.expectStartup(),
  FakeClaude.expectTurn({ recording: "text", index: 0 }),
  FakeClaude.expectTurn({ recording: "text", index: 1 }),
  FakeClaude.expectInterrupt(),
])
```

- `expect...` steps check the kind of SDK input and replay the recorded replies up to the next input. Tests assert the actual prompt content separately. `FakeClaude.replay` also scripts Claude-initiated hook and MCP exchanges.
- The fake answers the start-up request with a recorded start-up reply.
- Embedded chat tests use `FakeClaude.make(script, { probes: true })` to answer login probes independently. These are initialization requests from processes without `--include-partial-messages`; their incidental count/order is not part of the chat script. Dedicated login tests still script probes explicitly.
- It keeps everything the SDK sent (flags, environment, start-up request, user messages, answers), so tests check both directions.
- A test fails if a step is unfinished, including a requested step whose reply is still held back, or if the SDK writes something the script didn't expect. A test that deliberately interrupts a held reply checks that it is unfinished and that the process closes.
- Tests wait on the fake's steps (`claude.started(step)` before a held reply, `claude.reached(step)` after it finishes), never on time. Each run also exposes `closed` to check cleanup. Changes the plugin then makes inside opencode in the background (a new model list, a connection problem) are awaited by checking again every few milliseconds until they show (`TestOpenCode.waitUntil`), as opencode's own tests do.
- Recorded control-response IDs are remapped to the SDK's current request IDs, and session IDs to the process's actual session/resume ID. Transcript message UUIDs remain those in the recording.
- `run.exit(code)` simulates an unexpected process exit, then yields one event-loop turn for the SDK to observe it. Recovery tests check that saved OpenCode tool results reach the replacement process.
- `expectInterrupt({ beforeResult })` can hold the final result after acknowledging an interrupt. Real Claude does this, so cancellation tests check that the next turn waits for the result. `hold` can delay the whole interrupt reply to test a new request arriving during idle shutdown.

Branching and deleting Claude sessions (`forkSession`, `deleteSession`) work on Claude's session files directly (`sdk.d.ts:840-866`), not through `claude`. `ClaudeIO` exposes them separately. The fake records user/assistant messages in memory, copies only the requested prefix, assigns fresh UUIDs on every fork, and tracks deletions. Live checks verify this against the actual SDK; tests never fake `query()`.

The existing `ClaudeIO.sessionExists` uses SDK `getSessionInfo`; the fake defaults to a present transcript and lets a test report one missing. This tests rebuilds without inventing a CLI error protocol.

## Level 3: inside opencode

opencode runs inside the test through `@opencode/sdk` (published on npm). `OpenCode.create({ plugins })` starts the real server and session loop with an in-memory database and accepts our Effect plugin directly (`packages/sdk/src/internal/host.ts:18-68`, example in `packages/sdk/test/embedded.test.ts`). Plugins passed this way load after opencode's built-in plugins, the same as a configured plugin, so the `file://` placeholder is used here too.

```ts
await using oc = await OpenCode.create({
  plugins: [ClaudeAgent.make(fakeIO), TestPlugin],
  config: { directory: configDir, project: false, content: "{}" },
  models: { fetch: false },
  fs: { filewatcher: false },
})
const session = await oc.session.create({ location: { directory: projectDir } })
await oc.session.switchModel({ sessionID: session.id, model: { providerID: "claude-agent", id: "sonnet" } })
await oc.session.prompt({ sessionID: session.id, text: "Use the test tool" })
await oc.session.wait({ sessionID: session.id })
const { messages } = await oc.session.export({ sessionID: session.id })
```

`test/lib/test-plugin.ts` provides:

- **A scripted "normal" model.** A provider whose model is a hand-written `LanguageModelV3` that replies from a list, like the one in `packages/core/test/aisdk.test.ts:43-74`. Used for switching tests. opencode's `TestLLM` can't be used, because it replaces every model, ours included.
- **A test tool** with a fixed result, and a `context` hook that can edit history when a test asks it to.

Tests check what opencode saved, what the fake received, and what our plugin stored.

## Level 4: live

The model/session harness and the level 3 setup with the real `ClaudeIO` and Haiku. `test/live/chat.test.ts` runs the actual model through text, resume, cancellation/recovery, attachments and a utility call whose instructions come from the request's system message, plus one Sonnet turn for thinking, since Haiku doesn't think by default; the embedded offline test separately verifies OpenCode's database-backed restart and request headers. The title regression reads the installed OpenCode title agent's real instructions and submits a conflicting file-edit request through our title side-call path. It checks a short, single-line title rather than an attempted edit or refusal. The utility test also uses a conflicting source request, rather than an innocuous title phrase.

`test/live/sync.test.ts` supplies other-model/tool history, checks all markers after incremental catch-up, deletes its own stopped Claude transcript, then verifies a full-history rebuild after rejecting an unsupported attachment. It also checks that stored boundary UUIDs occur in the real transcript. `test/fixtures/recordings/sync.jsonl` (Claude Code 2.1.302, SDK 0.3.301) replays those responses offline. The embedded switching test separately runs a scripted model and a real OpenCode tool through `session.switchModel`.

The tool recordings include hook and MCP control exchanges. `FakeClaude.replay` replays those exchanges through the real SDK, including a handler that stays pending across OpenCode steps. `tools.jsonl` covers two calls in one reply and a second tool step; `tools-cancel.jsonl` covers cancellation after emitted calls but before the MCP handler starts, followed by a restart; `tools-waiting-cancel.jsonl` waits for actual handler entry, interrupts it, checks transcript refusals, and continues on the same process. The offline shutdown test combines that entered-handler cancellation with the recorded restart and holds the terminal result to verify draining before closure. `tools-continue.jsonl` covers steering alongside tool feedback without ending the active turn. `tools-abort.jsonl` covers OpenCode's typed aborted result: interrupt/drain, canonical results as catch-up, and a normal new user turn on the same process. Its offline test gates the terminal result to prove the next input waits for drain. `tools-media.jsonl` covers image/PDF results, a catalog-change restart, long names and denial. Old text recordings receive a connected-server status only when the SDK actually registers one; explicit failed statuses are preserved.

`test/live/tools.test.ts` refreshes those recordings and verifies real transcript boundaries. PDF replacement is an array of Anthropic content blocks, not an MCP response envelope. Active-turn steering uses priority `next`; aborted-turn recovery must use normal user input after interrupt/drain. Both paths require the exact requested reply, with tool results separate from new user content. `test/live/opencode-tools.test.ts` runs real OpenCode read/edit tools against a temporary file, waits for an actual OpenCode approval, and verifies the file only changes after approval. It then rejects another edit without feedback (ending the OpenCode turn), sends a new user message, and requires the exact reply with no further tool calls or file changes. It also checks the SDK input uses a fresh turn. It captures only its own Claude session IDs for cleanup. `test/opencode/tools.test.ts` exercises both actual host interruption and plain rejection, proving the persisted aborted error reaches the bridge and causes interrupt/drain before new input. A separate rejection-with-feedback test checks ordinary errors still continue as MCP `isError: true`. The multiline namespace test verifies the complete Code Mode catalog reaches Claude.

Refresh only that recording with `CLAUDE_LIVE=1 RECORD=true bun test test/live/sync.test.ts`. Live chat tests retain the complete delivered history, including partial cancelled replies; cleanup tracks every created Claude ID, including replacements.

Rules:

- Runs only when `CLAUDE_LIVE=1` is set, and is skipped if `claude` isn't logged in.
- Never runs in CI.
- Uses marker membership for unconstrained prose. When a prompt explicitly asks for only a marker, compares the entire trimmed reply: quoting the marker in a refusal must fail. Titles use format/content constraints without prescribing exact wording.
- Prints how many model calls it made.
- Deletes the Claude sessions it created.
- Uses its own attachment fixtures (`test/fixtures/red.png` and `marker.pdf`), with Claude sessions in a temporary folder. `red.png` is a plain 64×64 red square. `marker.pdf` is one 300×150 page reading "The secret marker is LEMON-IBIS." (made once with reportlab). Both are checked in; there is nothing to regenerate.

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

### Manual TUI acceptance

On 2026-10-16, ran the installed OpenCode 2.0.32 TUI in tmux 3.7c with this checkout loaded as a plugin, Claude Code 2.1.302, SDK 0.3.301 and Haiku 5.5. Used a temporary project and isolated OpenCode config/database, with read/edit/shell permissions set to ask. All approvals, rejections, interruptions and model selections went through TUI keystrokes.

- **Approval and rejection passed.** Read and edit each waited for approval. `marker.txt` stayed `OLD-OTTER` until the edit was approved, then became `APPROVED-OTTER`. Rejecting a subsequent edit left it unchanged.
- **Tool interruption passed.** Ran `cat cancel.pipe` against a named pipe, confirmed the process was actually blocked, then pressed Escape twice. OpenCode showed `Tool execution interrupted`, and the child process exited. A fresh-session follow-up asking `2 + 2` returned `4`.
- **Model switching passed.** Selected Big Pickle while `cat switch.pipe` was running, then released the pipe with `SWITCH-OTTER`. The TUI applied the new model to the next user turn; Big Pickle recalled the output and introduced `PICKLE-HERON`. After switching back, Claude recalled both markers and the approved file contents.
- **Intermittent follow-up failure.** In the first session, after both a rejected edit and a cancelled shell call, Claude said the next user message came from tool output and ignored its instruction. The Claude transcript shows the input delivered through the SDK's `queued_command` attachment, with a rendered reminder identifying it as a new user message; it was not present in the tool-result content. Repeating cancellation and the same rejection/follow-up in a fresh session passed. Direct SDK controls below reproduced the failure without the bridge.
- **Title prompt bug:** the first session title answered the file-edit request instead of naming the session; the fresh session received a correct title. Direct controls below confirmed that our utility conversion does not clearly separate the source conversation from task instructions.

At the time of this initial TUI check, the live between-step test only checked marker membership, allowing a refusal that quoted the marker to pass. The follow-up tests now require the entire trimmed reply to match. The fixes below change the stopped-turn delivery path rather than relying on another successful sample of the old intermittent behavior.

#### Investigation controls

On 2026-10-16, used the installed Claude Code 2.1.302, SDK 0.3.301 and Haiku 5.5 directly, with the plugin's isolation options. Scripts and results are in `/tmp/opencode/claude-investigate-w3uXWI`. These are diagnostic experiments, not checked-in regression tests.

- **Titles:** used OpenCode's actual title instructions and the original read/edit request. The old utility conversion failed all three trials: it answered the request or emitted malformed edit-like text instead of a title. Clearly delimiting the source conversation and restating the title task produced titles in all three controls. Putting the title instructions in the system prompt also passed all three controls. This identified a prompt-construction defect in our side-call path, not missing tool access.
- **Queued follow-ups:** used SDK `query`, `createSdkMcpServer` and `tool` directly, without `ClaudeSessions`, `PendingTools`, hooks or the bridge server. An edit handler waited while a new user message was queued with `priority: "next"`, then returned a refusal. With the plugin's runtime/tool-routing prompt, two of four trials ignored the follow-up; one explicitly called it tool output. In every trial the refusal contained only the error, and a separate `queued_command` attachment carried the user message. Four bare-preset controls and three controls with prior successful read/edit history passed. This isolates an intermittent prompt/model interaction with Claude Code's mid-turn delivery; it does not establish which prompt wording causes it or a defect in tool-result conversion.
- **Fresh-turn control:** with the same runtime/tool-routing prompt, interrupted and drained the waiting Claude turn before sending the follow-up as a normal user message on the same process. All four trials returned exactly `DENIAL-RECOVERED`. This motivated using a real new turn after an OpenCode cancellation/rejection. The regression tests below also verify preservation of OpenCode's canonical results and checkpoints.
- **Assertion gap:** `.toContain(marker)` accepts the first TUI session's replies even though they explicitly ignored the marker instruction. Use an unambiguous expected response for this targeted instruction-following check; ordinary prose tests can still use marker membership.

The checked-in title regression reproduced the original defect with a 328-character refusal. It now checks for a short single-line title within OpenCode's 100-character storage limit, rather than enforcing the prompt's advisory 50-character target exactly.

#### Fixes

- Standalone titles pass OpenCode's task instructions in the SDK system prompt and keep conversation source in user content. OpenCode still chooses the title agent/model and handles the result; conversation requests keep the Claude Code preset (including generate/compaction branches from phase 5).
- The existing context-hook error metadata also preserves OpenCode's structured `aborted` error. On the next request, a parked Claude turn is interrupted and drained before a normal new user turn begins. Canonical saved results use the existing catch-up path, and transcript checkpoints remain valid. Active-turn steering and ordinary tool errors keep the SDK's native continuation path.
- Offline regressions check drain ordering and both real OpenCode interruption/rejection paths; live regressions check actual replies and wire-level fresh-turn delivery.

#### Recheck after fixes

Typecheck, all 63 offline tests and all 11 affected live chat/tool tests passed. Repeated the original TUI scenario in the same isolated project: the automatic title was `Edit marker.txt: OLD-OTTER to APPROVED-OTTER`; the approved edit succeeded; the rejected edit left the file unchanged; and the next reply was exactly `DENIAL-RECOVERED`. After interrupting a confirmed running `cat cancel.pipe` process, the next reply was exactly `CANCEL-RECOVERED`. The Claude transcript contains both follow-ups as normal user turns with the canonical stopped-tool results, and no queued-command attachments. TUI capture and filtered transcript are saved in `/tmp/opencode/claude-tui-PDuqdg/evidence/fixed-tui.txt` and `fixed-turns.jsonl`. Phase-4 acceptance is complete.

### Phase 5: branching

- Pure tests select only matching historical checkpoints with no outstanding tool calls, including multiple tool calls whose results arrive separately. The current user group stays outside the fork, including when it matches the first or a later turn being retried.
- `test/claude/branches.test.ts` checks undo with unchanged resubmitted input, repeated undo with remapped UUIDs, source lookup after registry reload, missing-transcript fallback, independent concurrent generate calls and cancellation, cleanup after a real recorded API failure, and compaction while a tool handler waits. A terminal-result gate proves compaction cannot fork before the old turn drains. The next primary request contains only the compacted history.
- `test/opencode/branches.test.ts` exercises native `session.fork` and `session.revert` against the real host and verifies source history is unchanged. It also exercises native compaction, verifies the preset/task-input split, accepts OpenCode's required summary format, and starts the next primary request with that summary in a fresh Claude session. The context-edit test verifies that stale replies are excluded from the branch.
- `test/live/branches.test.ts` has separate native fork/undo, concurrent generate, and compaction cases. Each deletes only its own Claude transcripts. `branches.jsonl`, `branch-generate.jsonl` and `branch-compaction.jsonl` record the successful paths. `billing-error.jsonl` is one turn trimmed from an earlier failed compaction that hit a billing error. Nothing produces it; it checks cleanup/recovery after a real API error, and replaces only by hand.
- A direct SDK probe confirmed that forks copy the requested prefix with fresh UUIDs, and a resumed branch with custom `systemPrompt` and `snapshot: false` follows its own task instructions.

#### Side-call rejection: comparison and resolution

Initial native generate and compaction calls returned `API Error: 400 Third-party apps now draw from your extra usage, not your plan limits.`, while normal chat and fork/undo worked on the same account. Following [the comparison workflow](PLAN.md#investigating-unexpected-behavior):

- [OpenChamber's side-call routing at 9fa38cf](https://github.com/openchamber/opencode-claude/blob/9fa38cfac2b7165c01423f583ccfa56239448209/src/proxy.ts#L1424-L1581) keeps the chat system profile on resumed summary branches and sends the summary task as user instructions. Fresh utility calls use a small helper prompt. Its [issue 33](https://github.com/openchamber/opencode-claude/issues/33) reports the same service error; its proposed specific trigger is third-party evidence, not a rule adopted here. [PR 57](https://github.com/openchamber/opencode-claude/pull/57) and [issue 53](https://github.com/openchamber/opencode-claude/issues/53) also discuss parked-turn reconciliation and interruption entries around compaction; our history comparison and safe-prefix fork already cover those boundaries.
- [T3 Code's adapter at 70d60e0](https://github.com/pingdotgg/t3code/blob/70d60e03a7a35c6fa131825bbfa05ec893e69912/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts) keeps Claude's preset. Its `compactThread` sends `/compact` through the normal turn path, delegating to Claude's own compaction. That is not OpenCode's summary contract, and no equivalent side-question path was found there.
- Native OpenCode `session.generate` sends its side question as user input; native compaction appends its structured-summary task as user input. Both also supply the assembled coding-agent system prompt. Our initial branch routing incorrectly treated that whole system prompt like the standalone title task and replaced Claude's preset.

A focused public-SDK control used the same recorded summary task and parent history (CLI 2.1.302, SDK 0.3.301, Haiku). Full OpenCode custom system on a fork: rejected. The same custom system on a fresh session: rejected. Claude preset with selected host instructions on a fork: successful structured summary. Diagnostic script/results are in `/tmp/opencode/phase5-prompts-845R93`. This isolates prompt construction from fork mechanics for this reproduction; the precise service-side classification rule remains unknown.

The fix uses the supported Claude preset for generate/compaction, with `snapshot: false` and OpenCode's task unchanged in user input. Standalone titles retain their own task system prompt. No error-string filtering, prompt fingerprint scrubbing, credential change or billing retry is involved. Both native live generate and compaction then passed, including concurrent branch deletion, unchanged parent history and recall after compaction.

The real OpenCode 2.0.32 TUI in tmux also passed native fork and undo: forked before `FUTURE-IBIS`, added `CHILD-HERON` in the child, undid that turn, then recalled exactly `ROOT-OTTER`. The three actual Claude transcripts respectively contain ROOT+FUTURE, ROOT+CHILD, and ROOT alone. Filtered transcript evidence and the final screen are in `/tmp/opencode/claude-tui-PDuqdg/evidence/phase5`; the owned live sessions were cleaned up. Typecheck and all 70 offline tests pass.

#### Final acceptance

After the prompt fix, all 71 offline tests, typecheck and five focused live tests passed: native fork/undo, concurrent generate, native compaction, standalone utility instructions and title generation. The new offline native-compaction regression replays the successful summary and checks fresh-session replacement.

Repeated the remaining checks in the real OpenCode 2.0.32 TUI with a temporary project and `compaction.keep.tokens: 0` so the small fixture actually compacts. `/btw` answered `SIDE-HERON ROOT-OTTER FUTURE-IBIS`; subsequent main-chat recall returned only `ROOT-OTTER FUTURE-IBIS`. Native compaction produced its structured summary, and the next primary reply again returned exactly those two original markers. The two retained primary transcripts confirm that SIDE-HERON never entered main history and that the post-compaction Claude session starts with OpenCode's summary. Temporary side branches were removed. Evidence: `side-question.txt`, `compacted.txt`, `compaction-recall.txt` and filtered transcripts under `/tmp/opencode/claude-tui-PDuqdg/evidence/phase5`. Phase-5 acceptance is complete.

#### Review follow-up: undo and fork recovery

Native OpenCode revert removes the selected user message and everything after it (`session/projector.ts:759–794`). Undoing a turn and resubmitting the same question reproduced a real failure: the plugin included that question in its fork, sent empty user content, and Claude returned `API Error: 400 This model does not support assistant message prefill. The conversation must end with a user message.` The new live regression failed before the fix and passed afterward, checking both the exact marker response and the actual SDK user input. Two offline regressions also failed before the fix. The fix only excludes the final user group from fork selection; when no earlier checkpoint exists, the existing rebuild path handles it.

The review's broader fork-recovery suggestion was not supported by a normal failing workflow. SDK 0.3.301 inspection and a public-SDK control verified all four user/assistant boundaries of a real two-turn transcript: unchanged contents, fresh UUIDs, unchanged source, and the existing missing-source/boundary fallback. Control: `/tmp/opencode/phase5-fork-review.ts` (two model calls, owned sessions cleaned up). [OpenChamber at 9fa38cf](https://github.com/openchamber/opencode-claude/blob/9fa38cfac2b7165c01423f583ccfa56239448209/src/proxy.ts#L1313-L1338) catches all fork errors, while [T3 Code at f1e0a4d](https://github.com/pingdotgg/t3code/blob/f1e0a4d4d0600b2803e311989151c7f89ced3251/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1482-L1522) reports invalid fork cursors. Neither establishes a need for extra recovery here. The plan now distinguishes missing history from unexpected SDK/verification failures; no additional fallback or validation was added.

Verification after the review fix: typecheck, all 71 offline tests, the new live undo/resubmit regression (three model calls), the SDK control above, and `git diff --check` passed. Live checks used Claude Code 2.1.302 / SDK 0.3.301 / Haiku.

### Phase 6: instructions, controls and errors

`test/live/instructions.test.ts` loads a real AGENTS.md and configured instruction file, selects a custom reviewer agent, repeats the request, switches to a writer agent, then returns to build. It edits AGENTS.md and removes the configured file, using public `location.reload()` after each change. Exact marker responses verify each active role/source and removal of stale guidance. Six calls retain one native Claude session; unchanged instructions reuse the process. `instructions.jsonl` records the successful run on Claude Code 2.1.302 / SDK 0.3.301 / Haiku. Before implementation, the same live test could not identify any of the three markers.

`test/opencode/instructions.test.ts` replays the recorded turns through embedded OpenCode and verifies the actual SDK initialization: complete multiline file text, the active role, `snapshot: false`, no replacement coding prompt, and resume of the same native session after agent changes. It also checks transient generate receives the same instructions. The pure prompt test covers multiple instruction sources, including a configured URL, while preserving tool catalogs and skills. OpenCode owns file discovery and instruction updates; the plugin forwards loaded text rather than rereading paths.

The SDK's default system-prompt snapshot survives resume and ignores a changed append (`sdk.d.ts:2415–2458`). Conversation prompts now set `snapshot: false`, so restarting for an agent change actually applies the new role. OpenCode keeps its initial instruction baseline and emits later file changes chronologically (`session/instruction-state.ts`); those updates continue through the existing message converter. The embedded test also verifies edits/removals and actual SDK user inputs, without adding file discovery or instruction-diff logic to the plugin.

The first implementation appended all supplemental OpenCode system context after removing its generic coding prompt. It reproduced the phase-5 `400 Third-party apps now draw from your extra usage, not your plan limits` rejection. A two-call public-SDK control reproduced that rejection with the captured append and succeeded with the planned runtime/tool context, resolved role and loaded file instructions. Both used the Claude preset and `snapshot: false`. Evidence: `/tmp/opencode/phase6-instructions-error.jsonl`, `/tmp/opencode/phase6-prompt-controls.ts`, and `/tmp/opencode/phase6-prompt-controls-results.json`. This does not identify the server-side classifier or establish that any particular wording causes rejection.

The implemented selection follows [OpenChamber's role/file additions at 9fa38cf](https://github.com/openchamber/opencode-claude/blob/9fa38cfac2b7165c01423f583ccfa56239448209/src/proxy.ts#L1457-L1493), while using OpenCode's resolved agent API and already-loaded file contents. [Its instruction helper](https://github.com/openchamber/opencode-claude/blob/9fa38cfac2b7165c01423f583ccfa56239448209/src/opencode-context.ts#L120-L150) independently rereads files; ours does not. [T3 at f1e0a4d](https://github.com/pingdotgg/t3code/blob/f1e0a4d4d0600b2803e311989151c7f89ced3251/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1189-L1195) retains the preset with runtime/orchestration additions. Errors remain visible without a billing-error retry or prompt-rewrite fallback.

`test/live/controls.test.ts` records five exact-marker turns in `controls.jsonl`: Haiku low → high → default effort → Sonnet low, then an output-cap change from 2048 to 4096. The first four share a process; the cap change resumes the same native session in a replacement. Captured public SDK controls include `set_model`, `apply_flag_settings` high and null. Offline session tests also clear the output cap and verify the replacement environment. OpenCode's typed option is `maxTokens`; its AI SDK lowering supplies `maxOutputTokens`. The SDK has no equivalent launch option, so we use the documented `CLAUDE_CODE_MAX_OUTPUT_TOKENS` environment setting and restart on changes; inherited `CLAUDE_CODE_EFFORT_LEVEL` is cleared because it outranks live effort settings.

`test/live/opencode-tools.test.ts` records `max-steps.jsonl`: native `steps: 2` allows one lookup, then OpenCode disables tools and requests a final summary. The plugin drains and resumes without the tool catalog, preserving the saved marker and final-step instruction. Embedded replay asserts one tool call, no offered tools in the final process, and both inputs in catch-up. The pinned SDK cannot reliably replace a same-name in-process MCP catalog, so restart/resume remains the supported path; no new max-step mechanism was needed.

`test/language-model/error.test.ts` uses recorded billing failure plus documented SDK fault injection for quota metadata and `api_error_status` 500/529. It verifies terminal-only errors, reset dates, allowed/overage distinctions, clearing stale rejected metadata, and no false error on genuine empty success. `test/opencode/chat.test.ts` proves cancellation, quota exhaustion and empty overloaded success each produce one stored error and one user request, with no outer retry. `test/opencode/load.test.ts` verifies an inherited `ANTHROPIC_API_KEY` yields a billing warning without exposing its value or blocking models. The public connection API has only a `needs_auth` problem status, so that is where the advisory is exposed. **Host UI limitation:** OpenCode 2.0.32's integration picker renders only “Sign in required”, not the status message (`packages/tui/src/component/dialog-integration.tsx:133–139,221–229`). This was confirmed with a fake key in the isolated TUI; a clear billing-specific warning in that UI needs host support. We do not exhaust a real subscription to test its error path.

Manual TUI acceptance on 2026-10-17 used OpenCode 2.0.32, Claude Code 2.1.302, SDK 0.3.301, Haiku/Sonnet 5.5, and an isolated config/database/project under `/tmp/opencode/phase6-tui-FE0Rim`. The session automatically received a title. Reviewer/Haiku returned `REVIEWER-HERON ROOT-OTTER GUIDE-IBIS`; switching through the agent/model/variant pickers to Writer/Sonnet high returned `WRITER-LYNX ROOT-OTTER GUIDE-IBIS`. Editing AGENTS.md and deleting GUIDE.md while the TUI was open triggered its real watcher and returned `WRITER-LYNX UPDATED-OTTER NONE`. Captures: `roles-model-effort.txt`, `instruction-updates.txt`. A separate isolated TUI using the real plugin/SDK with fake CLI traffic displayed `Claude Code subscription limit reached. Resets at 2026-10-24T00:00:00.000Z.` once; capture `quota-reset.txt` and fixture `quota-plugin/server.ts` preserve the scenario.

The TUI export `session.json` and public-SDK `native-history.json` confirm all real turns used one native Claude session; that owned transcript was deleted after saving evidence. `quota-traffic.json` confirms one conversation process and one user request, with the fake script fully consumed on shutdown. Both isolated TUI processes were closed.

Verification: typecheck, all **79 offline tests**, live instructions (six calls), controls (five), max steps (two), concurrent generate and native compaction (eight), and the TUI checks pass. Recordings contain no account/home identifiers. Windows `claude.exe` lookup is implemented; this Linux environment does not establish Windows runtime acceptance.

### System-prompt compatibility

An earlier TUI run received `400 Third-party apps now draw from your extra usage, not your plan limits`. On 2026-10-16, both an exploratory 11-case matrix and this checked-in 12-case matrix passed on Claude Code 2.1.301 / SDK 0.3.301 / Haiku with subscription auth. They covered all planned instruction categories, a roughly 65 KB appendix, both OpenCode base-prompt controls, and (in the second matrix) an actual SDK MCP call. The original rejection was not reproduced; these results do not establish its cause or guarantee every future prompt will work.

Source review:

- [OpenChamber's prompt builder](https://github.com/openchamber/opencode-claude/blob/9fa38cfac2b7165c01423f583ccfa56239448209/src/proxy.ts#L1457-L1493) appends all these instruction categories to the preset. [Its failure mapper](https://github.com/openchamber/opencode-claude/blob/9fa38cfac2b7165c01423f583ccfa56239448209/src/failure.ts) classifies extra-usage errors as billing failures (HTTP 402), rather than retrying them.
- [T3 Code](https://github.com/pingdotgg/t3code/blob/f1e0a4d4d0600b2803e311989151c7f89ced3251/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1189-L1195) uses the preset with runtime and optional orchestration instructions. Its result-error handling explicitly marks API 429/529 retryable; it has no special extra-usage prompt workaround.
- OpenCode's `packages/ai/src/provider-error.ts` retries unknown provider errors. Plain SDK terminal errors reach that path through `packages/core/src/aisdk.ts`. The embedded failure test reproduced a repeated turn before our provider-scoped retry hook was added; it now verifies one request and a visible error. Claude Code handles its own API retries.

## Recordings

`RECORD=true` wraps the real spawn function and saves filtered traffic in both directions, one file per scenario in `test/fixtures/recordings/` (`test/lib/recorder.ts`). Never save thinking or reasoning content, signatures, or redacted thinking in fixtures or diagnostics. The recorder removes these before retaining a captured message. The live reasoning check uses no recorder and disables transcript persistence. The start-up recordings (`startup`, `startup-logged-out`) come from a login check run on its own, so each file holds one complete `claude` run.

The chat recordings are `text` (two turns), `text-resume`, `text-cancel` (interrupt then recovery) and `utility` (side-call instructions). Each is one complete process. Chat recordings use the Claude Code preset and OpenCode runtime note; `utility` preserves the supplied task system prompt. The live test regenerates these through the plugin model itself. Run recording and offline tests sequentially, since recording replaces fixtures. Usage assertions compare converted counts with the recorded terminal result, so re-recording does not require copying token totals into test code.

- The first line of each file holds the Claude Code version, SDK version, model and date.
- Before saving, personal details are replaced: account email, organization, user name and home folder paths.
- Recordings are committed, so changes show up in review.

On each Claude Code or SDK upgrade:

1. Update the pinned SDK version, or install the new `claude`.
2. Run `RECORD=true bun run test:live`.
3. Review `git diff test/fixtures/recordings` for changes in the format.
4. Run `bun test`, and fix the fake or our code.
5. Update the tested versions in PLAN.md's Background note.

## The test seam

Config options can't hold functions, so the plugin is built by a function. `claude/io.ts` holds everything that reaches outside the plugin: starting `claude`, and Claude's session files. The default export passes the real one, and tests pass a fake.

```ts
export const make = (io: ClaudeIO.Interface, registry = ClaudeSessions.registry()) =>
  define({
    id: ID,
    effect: Effect.fn("ClaudeAgent.Plugin")(function* (ctx) {
      // ...same as PLAN.md's entry point, with io passed to registry.attach
    }),
  })

export default make(ClaudeIO.real)
```

## Test rules

opencode's unit test rules apply (`.opencode/skills/unit-tests` in the opencode repo):

- `bun test`, with a timeout on each test.
- No sleeps. Races are tested with gates (`Deferred`) and the fake's steps. Registry timer tests use Effect's `TestClock`. The embedded host owns a separate clock, so its restart test gives each opencode host its own registry and closes it, as an exiting opencode process would, instead of waiting out the ten-second handover.
- No `mock.module` and no `globalThis`. Fakes come in through `ClaudeIO`.
- Each test gets its own temporary folders.
- A small `it.effect` / `it.live` helper copied from opencode's `packages/core/test/lib/effect.ts`, since opencode doesn't publish its test helpers.
- Few real processes. Only live tests start any.

## Cases to cover

Many of these come from bugs OpenChamber hit (its `test/*-regression.ts` files and `CHANGELOG.md`).

| Case | Level | Phase |
|---|---|---|
| The start-up flags and environment turn off everything listed in PLAN.md | 2 | 1 |
| Startup lists no models and runs no `claude`; connecting fills the list from claude, with effort variants, Haiku's family, attachment support and empty cost | 3 | 1 |
| Saved models are restored after an opencode restart without running `claude` | 3 | 1 |
| Costs follow the login: none for a subscription or a custom base URL, Anthropic's prices for an API key, a cloud's prices for a cloud account, and saved prices after a restart | 3 | 1 |
| Connecting without claude installed shows a sign-in problem, and the next start checks again | 3 | 1 |
| A chat's startup reports the login and models it found | 2 | 1 |
| Startup and reconnect checks run in order, so an older account snapshot cannot overwrite the new login | 2 | 1 |
| Installing claude after startup is picked up by the next login check | 2 | 1 |
| A failed startup is reported and the next check can recover; a stuck startup times out and closes its process | 2 | 1 |
| An old or unreported Claude Code version asks the user to update; the minimum supported version is accepted | 2 | 1 |
| Text and usage arrive in order | 2 | 2 |
| Thinking arrives as visible reasoning in a non-persistent live call | 4 | 2 |
| Usage counts each API message once, and context size comes from the last API call, not a sum (a turn makes several calls only once tools exist) | 1 | 2, 4 |
| Shutdown goes interrupt, then drain, then close | 2 | 2 |
| One process per session, and an old process stopping never closes its replacement | 2 | 2 |
| A plugin reload keeps live sessions, and waiting tool calls once tools exist | 2 | 2, 4 |
| Cancelling before initialization closes the process without saving a nonexistent session; chat rejects an incompatible CLI before sending user input | 2 | 2 |
| Text cancellation drains before the next turn; if the saved partial reply differs from Claude's transcript, reconciliation rebuilds | 2, 4 | 2, 3 |
| Idle shutdown and server restart resume the saved Claude ID; OpenCode persists the reply and token counts | 2, 3, 4 | 2 |
| Chat keeps the Claude Code preset and host note; changes to opencode's built-in system prompt do not replace it or restart the session | 2 | 2 |
| Titles preserve native task system instructions; generate/compaction branches retain the Claude preset and native task user input; all side calls run in independent, non-persistent processes | 1, 2, 4 | 2, 5 |
| Closing the registry interrupts, drains and closes an active side call, without saving it as a primary session | 2 | 2 |
| A terminal Claude error is shown once, without opencode replaying the whole turn | 3 | 2 |
| Switching Claude model/effort uses live controls; changing or clearing output limits restarts/resumes the same session | 2, 4 | 6 |
| Text stays verbatim; image and PDF inputs reach Claude as real content blocks | 1, 2, 4 | 2 |
| A resumed turn preserves the whole newest user group; utility requests preserve instructions and history roles; unsupported media reports a clear error | 1 | 2 |
| Switching to another model and back catches up only missed text/tool history, then resumes normally | 2, 3, 4 | 3 |
| Each of the four sync decisions; edited/shortened history, reordered user groups, edited tool results and tool images | 1, 3 | 3, 5 |
| A missing Claude transcript rebuilds from the full authoritative history; records without history also rebuild | 1, 2, 4 | 3 |
| A rejected attachment during rebuild leaves the corrected request able to recover the full history | 2, 4 | 3 |
| Reply metadata survives OpenCode persistence; saved catch-up boundaries use real Claude transcript UUIDs | 2, 3, 4 | 3 |
| Several tool calls in one reply match the right IDs | 2 | 4 |
| Cancelling during a tool call stops the handler, and Claude records the call as refused | 2, 4 | 4 |
| A typed aborted result after cancellation or plain rejection interrupts/drains the parked turn, then delivers saved results and new input in a fresh turn | 2, 3, 4 | 4 |
| Active-turn steering queues new input alongside tool feedback without interrupting the turn | 2, 4 | 4 |
| Tool errors and permission rejections reach Claude as errors (`isError`), not as success text | 2, 3, 4 | 4 |
| If our tool server fails, the call fails and no Claude tools turn on | 2 | 4 |
| Images and PDFs in tool results reach Claude | 2, 4 | 4 |
| Shortened tool descriptions keep the subagent list, and long tool names map back | 1, 2, 4 | 4 |
| Catalog changes restart/resume with updated definitions; setup reloads retain the waiting handlers | 2, 4 | 4 |
| Switching models while OpenCode executes tools lets the other model continue, then catches Claude up on return | 3 | 4 |
| Real read/edit tools wait for OpenCode approval before changing a fixture file | 4 | 4 |
| Undo and native forks select a safe matching checkpoint, refresh UUIDs, and preserve the old transcript | 1, 2, 3, 4 | 5 |
| Fork sources survive registry reload; a missing transcript rebuilds from authoritative history | 2 | 5 |
| Compaction drains a waiting tool call and the next primary request uses the summary alone | 2, 4 | 5 |
| Concurrent generate calls and cancellation remain isolated; disposable forks are deleted on success, failure and cancellation | 2, 4 | 5 |
| Loaded AGENTS.md/configured instructions and resolved agent roles reach primary and generate calls; role changes restart/resume with a fresh system prompt, unchanged instructions reuse the process | 1, 3, 4 | 6 |
| File edits/removals arrive as OpenCode's chronological instruction updates; live reload and TUI acceptance | 3, 4 | 6 |
| Native agent max steps drains parked tools, removes the catalog, and summarizes authoritative results | 3, 4 | 6 |
| A "successful" result after server errors (`api_error_status`) becomes an error without outer retries | 1, 3 | 6 |
| Plan-limit events: "rejected" vs "allowed", weekly reset dates and a single visible terminal error | 1, 3 | 6 |
| An API-key login is not a sign-in problem, and its models work | 3 | 6 |

## Folder layout

```
test/
├── lib/
│   ├── effect.ts          it.effect / it.live helper
│   ├── fake-claude.ts     The fake claude: script steps, replies, everything the SDK sent
│   ├── fake-io.ts         Fake claude, saved-session lookup and in-memory fork/delete
│   ├── recorder.ts        RECORD=true: saves real claude traffic; loads recordings for the fake
│   ├── opencode.ts        Starts opencode in the test with our plugin and optional test plugins
│   ├── sessions.ts        Model/session harness with isolated registry and storage
│   └── tools.ts           Tool fixtures, tool steps and a parked MCP handler
├── fixtures/              Red image and marker PDF
│   └── recordings/        Real runs, one file per scenario
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
