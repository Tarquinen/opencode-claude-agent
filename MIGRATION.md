# Moving the plugin into opencode as a built-in

Notes on what has to change to ship this plugin inside opencode, loaded like the other built-in plugins. Checked against `/home/dan/src/opencode/opencode` on `dev` at `0471a39a0f` (October 23, 2026).

**Short version:** most of the code moves over unchanged. The plugin already uses only the public plugin API. The real work is:

1. Register it in core's built-in list, in the right spot.
2. Delete the workarounds that only exist because it's an external plugin: the `file://` placeholder, `server.ts`, and config options.
3. Be lazy: never run `claude` at startup, load the SDK only when it's needed, and leave the plugin out of the hosted runtime.
4. Depend on the SDK as published, as an optional peer so npm users of `@opencode/sdk` don't get it by default. Its bundled `claude` binary (~290 MB on disk) lands in monorepo and CI installs, and that's accepted. We never run it; we always run the user's own `claude`.
5. Trim the tests and port them to core's test setup.

## How built-in plugins work today

- **One registry.** `packages/core/src/plugin/internal.ts` lists every built-in plugin in two groups, `pre` (lines 220-255) and `post` (257-275). Config plugins load between them (`supervisor.ts`).
- **Provider and login plugins live in core.** Each is one file in `packages/core/src/plugin/provider/`, listed in `ProviderPlugins` (`plugin/provider.ts:36-70`), which is spread into `pre`. IDs are `opencode.provider.<name>`, for example `opencode.provider.github.copilot` and `opencode.provider.chatgpt`.
- **Large custom models get their own folder in core.** GitHub Copilot keeps the plugin wiring in `plugin/provider/github-copilot.ts` and the AI SDK model in `packages/core/src/github-copilot/`. Its `sdk` hook lazily imports the model: `yield* Effect.promise(() => import("../../github-copilot/copilot-provider.js"))`.
- **Separate packages are the exception.** `@opencode/plugin-browser` is the only built-in in its own workspace package, imported at `internal.ts:92` and placed in `post`. It's separate because `gui-extensions` imports its RPC types. It also needs extra publishing steps (`script/publish.ts:87`, `packages/sdk/script/verify-package.ts:18`).
- **`packages/plugins/*` is not built in.** Its README says those plugins are installed from Git and must not be added to core's registry. Figma lives there. That folder is the wrong place for this plugin.
- **External login methods.** Google Vertex's gcloud login (`plugin/provider/google-vertex.ts:123-161`) is the model for our `claude auth login` method. Copilot and ChatGPT show how to refresh models and reload when the credential changes: `bus.subscribe(Credential.Event.Switched)` followed by `ctx.provider.reload()`.
- **Built-ins get no options.** The host passes `options: {}` to every plugin (`plugin/host.ts:118`). Built-in providers read user settings from provider config with `configuredSettings(providerID)` (`plugin/provider/configured.ts`).
- **Storage is namespaced by plugin ID** (`plugin/host.ts:623`). Changing the ID starts with empty storage.

## Recommended shape

Make it a core provider plugin, the same way GitHub Copilot is built:

```
packages/core/src/plugin/provider/claude-agent.ts   the define(...) and the register calls from src/index.ts + src/plugin/*
packages/core/src/claude-agent/                     claude/, language-model/, tools/, sync/ from this repo, plus a README
packages/core/test/plugin/provider-claude-agent.test.ts
packages/core/test/claude-agent/                    unit and fake-claude tests, recordings, fake claude
```

Add `ClaudeAgentPlugin` to `ProviderPlugins` **before `DynamicProviderPlugin`**. Do not put it in `post` the way the browser plugin is placed. The npm fallback in `pre` would then run first and fail on our package name, which is the bug in OPENCODE-FIX.md.

The other option is a separate `packages/plugin-claude-agent` package, like the browser plugin. That keeps the 30 files and their dependencies apart from core, but it adds publishing steps. Its opencode-in-a-test suite would also need `@opencode/sdk`, which depends on core, which would depend on the plugin: a dependency cycle. Nothing outside core needs to import it, so the separate package isn't worth it.

## What has to change

### 1. Registration and identity

- [ ] Add the plugin to `ProviderPlugins` in `packages/core/src/plugin/provider.ts`, before `DynamicProviderPlugin`.
- [ ] Rename the plugin ID from `opencode.claude-agent` to `opencode.provider.claude-agent` to match the other provider plugins. Because storage is keyed by plugin ID, current testers lose saved session records and the cached model list, and Claude sessions start fresh on first use. Nothing has shipped, so that's acceptable.
- [ ] Keep the provider ID `claude-agent` and the name "Claude Agent". Consider adding `Provider.ID.claudeAgent` to core's `provider.ts`, like `Provider.ID.githubCopilot`.
- [ ] Keep `make(io, registry)` exported so tests can pass a fake `ClaudeIO`. The registry entry is `make(ClaudeIO.real)`, and the plugin must satisfy `PluginInternal.InternalPlugin`.
- [ ] Users can still turn it off with `"-opencode.provider.claude-agent"`. Don't add it to `PluginInternal.guarded`.

### 2. Delete the external-plugin workarounds

- [ ] Delete `language-model/sdk-placeholder.ts`. Set the provider package to a plain name, for example `Provider.aisdk("@opencode/claude-agent")`. Our `sdk` hook runs before the npm fallback and sets `evt.sdk`, and the fallback then skips (`plugin/provider/dynamic.ts`). The hook can go back to the normal pattern of checking provider ID and setting `evt.sdk`.
- [ ] Delete `server.ts`, the `./server` export, and `package.json`. The plugin no longer loads from a folder.
- [ ] OPENCODE-FIX.md no longer blocks this plugin. The upstream fix is still worth sending for third-party plugins, but separately.

### 3. Options

`ctx.options` is always `{}` for built-ins. Neither option needs to be in config, so drop options entirely.

- [x] Delete `options.ts`, the `ClaudeAgentOptions.decode` call in `index.ts`, and the `options` field passed to `ClaudeStatus`, `ClaudeSessions` and `query-options.ts`.
- [x] Replace `claudePath` with an environment variable, `OPENCODE_CLAUDE_PATH`, read in `ClaudeIO.real.which()`: use it when set, otherwise look up `claude` on `PATH`. This matches core's other path overrides (`OPENCODE_PTY_BIN`, `OPENCODE_NODE_PTY_PATH`) and provider plugins that read `process.env` directly. Tests keep using a fake `ClaudeIO`, so they never touch the variable.
- [x] Make `idleTimeoutMs` the `IDLE_MS` constant. Tests move past it with `TestClock` instead of passing a shorter value.
- [ ] If users later need a config setting, add it then through `configuredSettings(Provider.ID.claudeAgent)`.

### 4. Lazy loading: startup and the hosted runtime

`internal.ts` imports every built-in when opencode starts, and core also builds for workerd (see the `#imports` conditions in `packages/core/package.json`). Today these files import the SDK as runtime values at the top level:

- `claude/session.ts`: `query`
- `claude/probe.ts`: `query`
- `claude/io.ts`: `deleteSession`, `getSessionInfo`, and `which`
- `claude/fork.ts`: `deleteSession`, `forkSession`, `getSessionMessages`
- `tools/server.ts`: MCP `Server` and request schemas

Changes:

- [ ] Make those imports dynamic, inside the narrowest scope that needs them. AGENTS.md asks for this for heavy modules on startup paths. Type-only imports can stay.
- [ ] Use core's `util/which.ts` instead of importing `which` directly.
- [x] **Never run `claude` at startup.** `index.ts` used to run `status.refresh()` on every start. As a built-in, that would spawn `claude` for every user who has it installed, even those who never use Claude Agent. Instead:
  - **Startup, every user:** no process and no SDK import. Register the `/connect` entry (it doesn't need a provider). Register the provider with the model list saved from the last check, or with no models if there isn't one. opencode hides the provider until it has a connection (`activation: "auto"` in `provider.ts` `snapshot`). Delete the Opus/Sonnet/Haiku `FALLBACK` in `plugin/provider.ts`.
  - **Picking Claude Agent in `/connect`:** run the check once (installed, logged in, models, context windows) and save the model list with `ctx.storage` (opencode's key-value table in its database, under this plugin's namespace; `storage()` in `plugin/host.ts`). The `credential.switched` handler in `plugin/integration.ts` already does this. Opening `/connect` alone runs nothing.
  - **Starting opencode while already connected:** no check. The saved model list is what lets the user pick a Claude Agent model again: the app restores the last-used model itself (`models.recent` in `packages/app/src/composer/selection.ts`) and only keeps it if the server lists that model. The first message starts `claude` anyway, and its startup report (version, login, models) updates the model list at no extra cost. Context windows only come from the `/connect` check and stay saved. One exception: a connection with no saved list (say `claude` wasn't installed when the user connected) runs the check once at startup, since otherwise there's no model to pick and no first message to fill the list.
  - When a check or a message finds `claude` missing or logged out, set the connection problem. The TUI shows it as "Sign in required →" next to Claude Agent in `/connect` (`packages/tui/src/component/dialog-integration.tsx`), the same as for any integration with a connection problem (the Console provider uses it when signed out). The message text itself isn't shown. Selecting the row opens the problem's `url` if it has one (we set the install docs for "not installed"), otherwise it reopens the login method, which re-runs the check. Nothing pops up on its own.
  - There is no server-side signal for picking a model: the app chooses it on its own and calls `switchModel` right before sending the message (`packages/app/src/composer/submit.ts`).
- [ ] **Hosted (workerd) runtime.** `packages/server/src/workerd.ts` boots core inside a Cloudflare Durable Object. It drops plugins from config and disk but keeps every built-in, so this plugin would load there. It also swaps opencode's process spawner for one that always fails (`environment/unavailable.ts`), but the SDK spawns through `node:child_process` itself, which bypasses that. Two changes, each following existing code:
  - **Keep the SDK out of the workerd bundle.** Load it through a `#claude-agent-sdk` import with a `.workerd.ts` stub, the way `#pty` stubs node-pty (`packages/core/package.json` `imports`, `src/pty/pty.workerd.ts`). This is required, not optional: CI's "Verify packed workerd SDK" step packs `@opencode/sdk`, installs it and bundles it for workerd (`packages/sdk/script/verify-package.ts`). Because the Agent SDK is an optional peer, it won't be installed there, so a plain dynamic import would fail to resolve.
  - **Don't offer Claude Agent where it can't run.** `plugin/provider/local.ts` (Ollama and LM Studio) already skips its local default when `environment.spawner === EnvironmentUnavailable.spawner` or the location is a remote workspace (`location.workspaceID`). Do the same check and skip registering the `/connect` entry and the provider.
  - Check with `bun run probe:workerd` in `packages/server` and `bun run verify:package` in `packages/sdk`.
- [ ] Optional: add an import-boundary test like `packages/core/test/mcp-import-boundary.test.ts` that fails if the SDK becomes a static import.

### 5. Dependencies and install size

- [ ] Add `@modelcontextprotocol/sdk` (1.x) to `packages/core/package.json`. `@ai-sdk/provider` 3.0.8 and `which` 6.0.1 are already there. `effect`, `zod` and `@opencode/plugin` come from the catalog and workspace. `@anthropic-ai/claude-agent-sdk` (0.3.301) is covered below.
- [ ] Two MCP SDK versions will live in core: core uses the 2.x split packages, and the Agent SDK needs 1.x. Keep 1.x confined to `tools/server.ts`.
- [ ] **The bundled `claude` binary.** The Agent SDK lists its native `claude` binary as optional dependencies, about 290 MB on disk (130 MB download) per platform. We never run it: we always pass `pathToClaudeCodeExecutable` (from `OPENCODE_CLAUDE_PATH` or `PATH`) and report "missing" instead of falling back. We use the SDK package as published: no patches, no stand-in packages. Where the binary gets downloaded:
  - **CLI users (npm `@opencode/cli`, install script, Homebrew, Docker): no.** They get the compiled binary only (`packages/cli/script/publish.ts`, `packages/cli/Dockerfile`). `bun build --compile` bundles the SDK's JavaScript, not its optional binary packages.
  - **Desktop app: no.** It ships the compiled CLI and doesn't depend on core.
  - **Monorepo `bun install` (contributors and CI): yes, and that's accepted.** About 290 MB on disk (about 130 MB download) for the one matching platform. Bun 1.4.4, which the repo pins, installs only the glibc or musl variant that matches the machine; older Bun installed both, about 500 MB on Linux. It would still be the largest single package in the install (next is `@ibm/plex` at about 200 MB). Bun can only skip all optional dependencies (`--omit=optional`), which would also drop node-pty and other native packages.
  - **CI:** every job that uses `.github/actions/setup-bun` does a full install, including test, check, publish and the `deploy-*` workflows. Linux and macOS jobs restore it from the Actions cache, so the cache grows by about 290 MB. Windows jobs skip the cache and download it every run. Jobs with `--cpu=*` (Windows arm64 publish) get two variants. `build-node.ts` without `--skip-install` runs `--os=* --cpu=*` and gets most of the eight (well over 1 GB). CI always passes `--skip-install`, but a local run doesn't.
  - **npm users of `@opencode/sdk` and `@opencode/core`: yes, unless we change how core depends on the SDK.** `@opencode/sdk` lets developers run opencode inside their own JavaScript app (`OpenCode.create()`), and `@opencode/core` is what it runs on. A plain dependency means every one of those installs downloads the binary, even if they never use Claude Agent.
- [ ] **Decided:** list the Agent SDK in core's `devDependencies` and as an optional `peerDependency`, the way `packages/plugin` treats `@opentui/*`. The monorepo, the tests and the compiled CLI build still get it. npm users of `@opencode/sdk` don't, unless they `npm install @anthropic-ai/claude-agent-sdk` themselves. When the lazy import fails, the provider reports that the SDK isn't installed. This doesn't change contributor or CI installs. Tested with a throwaway package: npm, Bun and pnpm all skip optional peers and still install required ones. To check: that `bun build --compile` bundles it from core's dev dependencies, and that the provider still loads cleanly without it.
- [ ] Import from the SDK's root entry, because `/core` lacks `getSessionInfo`, `getSessionMessages` and `forkSession`. Never mix the root and `/core` entries.

### 6. Match core's code style and lint

- [ ] Run `bun run check` from the repo root. That runs oxlint, the ast-grep Effect rules over `packages/core/src`, and typecheck. Fix what comes up. Known spots:
  - `let catalog` in `plugin/provider.ts` (core prefers `const`)
  - `import whichPkg from "which"` (use `util/which.ts`)
  - `ctx.event.subscribe()` with a `String(...)` comparison in `plugin/integration.ts` (core plugins use `bus.subscribe(Credential.Event.Switched)` with `Stream.filter`)
- [ ] Inside core, import `Provider` and `Model` from core's own modules (`../../provider.js`), as other provider plugins do, rather than from `@opencode/plugin/effect`.
- [ ] Typecheck with `bun typecheck` from `packages/core`, and confirm with `bun run typecheck:tsc`. Core uses `@typescript/native` 7.1.0-beta from the catalog, not 7.0.2.

### 7. Tests

Read `.opencode/skills/unit-tests` and the "Tests" section of `packages/app/AGENTS.md` first. The bar there: each test protects one observable contract, at the strongest boundary that sees it, and no other test already catches the same regression. No mocks, no `globalThis`, no real sleeps or polls.

Today there are about 116 tests (46 fake-claude, 20 pure, 25 opencode-in-a-test, 25 live) and 2.8 MB of recordings. The goal is roughly 60 offline tests plus a small recorded set, in `packages/core/test/claude-agent/` and `packages/core/test/plugin/provider-claude-agent.test.ts`.

- [ ] **Cut what goes away with the built-in:** the placeholder provider in `test/lib/test-plugin.ts`. (Done: `test/opencode/packaging.test.ts`, the placeholder test in `load.test.ts`, and `test/bin/claude`.)
- [ ] **Cut tests of config pass-through or of dependencies:** `claude/probe.test.ts:11` (SDK flags), `live/prompts.test.ts` with `fixtures/opencode-system.txt`, and `claude/sessions.test.ts:284`. Drop exact SDK-argument and call-count assertions from the probe, session and sessions tests.
- [ ] **One owner per contract.** Many behaviors are tested both with the fake `claude` and with opencode running. The fake-claude test owns them; fold the opencode versions in: catch-up (`claude/sync.test.ts`), tool call/result matching (`claude/tools.test.ts:12`), undo and edited replies (`claude/branches.test.ts:113`), idle shutdown (`sessions.test.ts:216`), handover (`tools.test.ts:50`), failed turns (`language-model/error.test.ts`). Move "switch model mid-tool" (`opencode/tools.test.ts:134`) to `claude/tools.test.ts`.
- [ ] **Replace the opencode-in-a-test suite with about 8 hook tests** on core's fixtures (`testEffect(PluginTestLayer)`, `PluginHost.make`, `PluginHooks.Service.trigger`), like `provider-github-copilot.test.ts`. Each proves something the lower tests skip: catalog publish and cache (including that a chat's startup report, which has no context sizes, keeps the saved ones; the current opencode-in-a-test harness can't observe this), connection status, request-kind and fork headers, agent roles, output budget, aborted-tool error metadata, retry suppression, and SDK binding with plugin storage. This removes `test/lib/opencode.ts`, its real 10 ms poll, and the `@opencode/sdk` dependency. Add one assertion that the plugin sits in `ProviderPlugins` before `DynamicProviderPlugin`.
- [ ] **Shorten mixed scenarios** that check several unrelated things: `sessions.test.ts:335` and `:410`, `tools.test.ts:72` and `:265`, `branches.test.ts:162`.
- [ ] **Recordings:** delete the unused ones (`attachments`, `branch-resubmit`, `opencode-tools`, about 340 kB). Keep `branch-generate` for the cache check below. `branch-error` has no producer any more; regenerate or replace it. Move them to `test/fixtures/recordings/` and remove the legacy repair code in `fake-claude.ts`.
- [ ] **Live tests:** follow core's recorded-test convention (`*.recorded.test.ts`, refreshed with `RECORD=true`, refused when `CI` is set; see `session-runner-recorded.test.ts`). They exist to refresh recordings, not as a second regression suite. Keep a small smoke set: startup, chat and resume, tool rejection, fork and compaction, and generate.
- [ ] **Generate reuses the chat's cache.** The live generate test should keep opencode's tools (today's branch tests remove them with a `context` hook, which hides this bug) and check that the generate request reads the chat's cache instead of writing it again. Checked by hand on October 23: before the fix, generate wrote 8,577 tokens and read 658; after it, it wrote 32 and read 14,354. Compaction also reads the chat's cache now.
- [ ] **Fixtures:** keep `red.png` and `marker.pdf`. Drop `create.py` (Python and reportlab) and note where the PDF came from.
- [ ] Use core's `test/lib/effect.ts` instead of ours.
- [ ] Worth one assertion each in existing tests: a malformed cached catalog, and cleanup when a fork's prefix doesn't match.

### 8. Docs and housekeeping

- [ ] Fold PLAN.md and TESTING.md into `packages/core/src/claude-agent/README.md`, like `github-copilot/README.md`. Drop the sections about being a standalone plugin, provider loading, `server.ts` and local setup.
- [ ] Rewrite the setup steps for users: install `claude`, run `claude auth login`, then `/connect` → Claude Agent. There's no plugins array to edit any more.
- [ ] Follow the opencode repo's rules: branch from `origin/dev` with a short name (for example `claude-agent-provider`), commit as `feat(core): add Claude Agent provider`, and no changesets.

## Known risks

- **Windows.** Core's unit tests run on Linux and Windows in CI. This repo has never run on Windows, so finding `claude`, spawning it and transcript paths are untested there. We'll fix what CI finds.

## Checking it by hand before the PR

1. `bun run check` from the repo root, and `bun test test/plugin/provider-claude-agent.test.ts test/claude-agent` from `packages/core`.
2. Try `bun run dev:live`: `/connect` → Claude Agent, then chat, tools, undo, fork, compaction and switching models in both directions.
3. Build the CLI binary for the local platform. Check that it starts without loading the SDK, and that a Claude Agent chat works with the user's installed `claude`.
4. With `claude` uninstalled or logged out, opencode starts normally without spawning anything, and picking Claude Agent in `/connect` shows "Sign in required →".
5. Starting opencode, with or without a Claude Agent connection, runs no `claude` process until the first Claude Agent message.
