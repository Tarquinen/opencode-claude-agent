# opencode fix: plugin provider packages are blocked by the npm fallback

Everything needed to send the upstream fix. Code references are against `origin/dev` at `0a03b4bc9c` (October 16, 2026). Paths are relative to the opencode repo.

## The problem in one paragraph

Every opencode model names a package (`aisdk:<name>`) that provides its code. The first time a model is used, opencode runs every plugin's `aisdk` `sdk` hook in order until one supplies an SDK for that package. A built-in fallback, `opencode.provider.dynamic`, installs the package from npm if no earlier hook supplied it. That fallback runs before every plugin loaded from config. So a config plugin that claims a package name that isn't on npm never gets the chance: the fallback tries to install the name, npm returns 404, and the failure aborts the hook chain before the plugin's hook runs.

## Status

- Issue [#42788](https://github.com/anomalyco/opencode/issues/42788), "Plugin aisdk "sdk" hooks never run when the provider package is not on npm": **open**, assigned to jlongster, last activity October 5, 2026. Reproduced again on 2.0.22.
- PR [#42789](https://github.com/anomalyco/opencode/pull/42789), "fix(core): run dynamic provider fallback after plugin hooks" by abhishekbiyala: **closed without merging** on September 15, 2026 by the automatic age and low-reaction cleanup. No maintainer review; the only review was automated.
- No other open PR touches this. The code is unchanged on `origin/dev`.

## How it fails, step by step

1. **Plugin order.** `PluginSupervisor` builds the list as built-in "pre" plugins, then plugins from config, then built-in "post" plugins (`packages/core/src/plugin/supervisor.ts`, the `ordered` array in `resolve`). The "pre" group also includes plugins supplied by an embedding SDK and the instance (`sdk.all()`, `instance.all()` in `activate`).
2. **The fallback is in "pre".** `DynamicProviderPlugin` is the last entry of `ProviderPlugins` (`packages/core/src/plugin/provider.ts:67`), which is spread into `pre` (`packages/core/src/plugin/internal.ts:229`).
3. **Hooks run in that order.** `AISDK` appends each `sdk` hook as it is registered and runs them one after another (`packages/core/src/aisdk.ts:290-299`). The registry keeps setup order across reloads: when a plugin changes, it closes every plugin after the first change and sets them up again in order (`packages/core/src/plugin.ts:89-160`). So hook order always matches plugin order.
4. **The fallback installs anything unclaimed.** `dynamic.ts` returns early if `evt.sdk` is already set, otherwise calls `loadSDKFactory(npm, evt.package)`.
5. **A failed install is a crash.** `sdk-factory.ts` runs `npm.add(...)` with `Effect.orDie`. A 404 becomes a defect that stops the loop, so no later hook runs.
6. **The error the user sees.** `AISDK.language` wraps the failure as `AISDK.InitError` (`initError` at `aisdk.ts:233-235`, used at `aisdk.ts:346`), which surfaces as a model initialization error (`packages/core/src/model-resolver.ts:204-217`).

Built-in providers that supply their own SDK (GitHub Copilot, GitLab, SAP AI Core, Vercel, and bundled packages through `plugin/provider/factory.ts`) work only because they sit earlier in `ProviderPlugins`, so the fallback sees `evt.sdk` already set.

### Second effect: plugins lose control of packages that are on npm

From the October 5 comment on #42788: a plugin pinned as `cursor-opencode-provider@0.8.0` registers its models with `package: "aisdk:cursor-opencode-provider"`. Because the fallback runs first, opencode installs a separate `@latest` copy from npm and runs that, not the pinned plugin's code. A new npm release can silently replace the model code under a pinned plugin. The commenter's workaround is pinning the version in the provider config's package string.

## Why it is ordered this way

No reason is recorded. Commit `7f571d36ea5` (May 30, 2026) made the fallback the last entry of `ProviderPlugins`. Commit `a9b7bd9e2f2`, "feat(core): manage configurable plugin generations" (July 5, 2026), put the whole provider list in "pre" and introduced the pre → config → post order. Nothing in either commit or in later PRs discusses where the fallback should run relative to config plugins.

Later changes to this code kept the order and did not discuss it:

- [#45654](https://github.com/anomalyco/opencode/pull/45654) moved the loading code into `sdk-factory.ts`. Kit Langton noted that "npm installation retains its real typed-error `orDie`", so the crash-on-failure behavior is deliberate.
- [#46901](https://github.com/anomalyco/opencode/pull/46901) centralized plugin host resolution.
- [#53287](https://github.com/anomalyco/opencode/pull/53287) installs unversioned `@ai-sdk/*` packages with the `ai-v6` tag.
- [#48433](https://github.com/anomalyco/opencode/pull/48433) changed how model initialization errors are reported.

## Related reports and workarounds

- [#46756](https://github.com/anomalyco/opencode/issues/46756): plugin providers behind a private certificate authority. Same root cause; closed for not following the issue template.
- [stablekernel/opencode-cursor#129](https://github.com/stablekernel/opencode-cursor/issues/129) (merged, pins the version) and [oakimov/cursor-opencode-provider#41](https://github.com/oakimov/cursor-opencode-provider/issues/41): plugin authors working around it.
- [#54537](https://github.com/anomalyco/opencode/pull/54537) (Kiro provider, open): avoids it by being built in.
- [openchamber/opencode-claude](https://github.com/openchamber/opencode-claude): avoids it by using the bundled `@opencode/ai/providers/openai-compatible` package (`packages/core/src/provider.ts:120`) pointed at a local HTTP proxy.
- Plugins that set `aisdk:file:///...` avoid it too, because `sdk-factory.ts` imports `file://` packages directly instead of installing them. File paths for provider packages date back to V1 ([#4323](https://github.com/anomalyco/opencode/pull/4323), November 2025).

## The fix

**Move `DynamicProviderPlugin` from `ProviderPlugins` to the end of the "post" group.** Leave `sdk-factory.ts` alone.

```diff
--- a/packages/core/src/plugin/provider.ts
+++ b/packages/core/src/plugin/provider.ts
-import { DynamicProviderPlugin } from "./provider/dynamic.js"
 ...
-  DynamicProviderPlugin,
 ]
--- a/packages/core/src/plugin/internal.ts
+++ b/packages/core/src/plugin/internal.ts
+import { DynamicProviderPlugin } from "./provider/dynamic.js"
 ...
 const post = [
   ...
   ConfigPolicyPlugin.Plugin,
+  // Installs AI SDK packages from npm when no other plugin supplied them. It runs last so plugins
+  // loaded from config can supply their own packages first.
+  DynamicProviderPlugin,
 ] as const satisfies readonly InternalPlugin[]
```

### Why keep the crash on a failed install (unlike #42789)

#42789 also changed the fallback to log a failed install at debug level and supply nothing. Once the fallback runs last, that isn't needed: no plugin runs after it, so a failed install really is the end of the line. Keeping `orDie` means the user sees the real npm error inside the `InitError`, instead of the vaguer "No AISDK provider plugin returned an SDK". That keeps the behavior #45654 chose on purpose, and answers the automated review on #42789, which worried that the debug log hid npm errors.

### Where in "post"

No "post" plugin registers `aisdk` hooks (only files under `plugin/provider/` do), so any spot in "post" works. The end is the simplest to explain: the fallback is the last hook to run. If reviewers prefer `ConfigPolicyPlugin` to stay last, putting the fallback just before it behaves the same.

### Who sees a change

| Who | Before | After |
|---|---|---|
| Built-in providers | Supply their SDK before the fallback | Same |
| Config-only custom providers using an npm package | Fallback installs it | Same, just later in the chain |
| Config plugins supplying a package not on npm | Never run; model fails | Work |
| Config plugins supplying a package that is also on npm | Fallback's `@latest` copy wins | The plugin's own code wins |
| SDK- and instance-supplied plugins | Run after the fallback | Run before it |
| A config plugin whose `sdk` hook expects to see the npm-loaded SDK (for example to wrap it) | Sees it | Sees nothing. The `language` hook still runs after every `sdk` hook and receives the final SDK, so wrapping belongs there. None of opencode's own plugins do this. |
| Users who disable the fallback with `"-opencode.provider.dynamic"` | Works | Same plugin ID, still works |

Cost: "post" plugins are set up again whenever a config plugin changes. That already happens to every "post" plugin, and the fallback's setup only registers one hook.

## Tests

In `packages/core/test/plugin/`. Read the repo's `unit-tests` skill before writing them.

1. **The fallback is not a pre-group provider plugin.** In `provider-dynamic.test.ts`: `ProviderPlugins.map((plugin) => plugin.id)` does not contain `"opencode.provider.dynamic"`. Other tests check `ProviderPlugins` contents the same way (`test/modal/models.test.ts:11`, `test/plugin/models-dev.test.ts:911`).
2. **A config plugin can supply a package that isn't on npm.** The real regression test. Through the supervisor (see `supervisor.test.ts` for booting a generation and checking boot order, for example around line 100), load a plugin from config that registers an `sdk` hook for `aisdk:@example/not-on-npm`. Use an `Npm` stub whose `add` fails and records calls (`npmPackage` in `provider-dynamic.test.ts` shows how to stub it). Expect `AISDK.language` to return the plugin's model and `npm.add` never to be called.
3. **A failed install still reports the npm error.** Extend "wraps missing npm entrypoint failures as AISDK init errors" in `provider-dynamic.test.ts` so the `InitError` cause includes the npm failure message.

Existing tests that must keep passing: everything in `provider-dynamic.test.ts`, especially "does not override an SDK already supplied by an earlier plugin" and "wraps dynamic import failures as AISDK init errors" (the `aisdk:file:///missing/provider-factory.js` case).

## Checking it by hand

1. In an opencode worktree with the fix, create the plugin from #42788 (update it to the current API: `ctx.provider.transform` to register a provider whose models use `package: "aisdk:@example/not-on-npm"`, and an `aisdk` `sdk` hook that supplies a small SDK).
2. Add its folder to `plugins` in `opencode.json` and run `bun run dev:live`.
3. Send a prompt to one of its models. Before the fix: initialization error mentioning npm. After: the plugin's hook runs.
4. Also check a normal npm-backed custom provider still installs and runs.

## Sending the PR

- Branch from `origin/dev`: `dynamic-provider-order`.
- Title: `fix(core): run dynamic provider fallback after config plugins`.
- Body: the problem paragraph, the "Who sees a change" table, and why `orDie` stays. Include `Fixes #42788` and say it supersedes #42789, crediting @abhishekbiyala.
- Before pushing: `bun typecheck` and `bun test test/plugin/provider-dynamic.test.ts test/plugin/supervisor.test.ts` from `packages/core`, then `bun run check` from the repo root.

## What our plugin does until the fix ships

We use the `file://` package path, which opencode already supports:

- `provider.transform` sets each model's package to `"aisdk:" + new URL("./sdk-placeholder.js", import.meta.url).href`, an absolute path to a small file inside the plugin, worked out when the plugin starts.
- That file exports a `create...` function returning a placeholder SDK. The fallback imports it without touching npm (`sdk-factory.ts`), then our `sdk` hook, limited to our provider, replaces the placeholder with the real SDK. Our hook always replaces `evt.sdk`, so it must not use the usual `if (evt.sdk) return` check.
- The file must ship in the published package, must export a function whose name starts with `create`, and the path must be absolute. A missing file is an `InitError`.

### Switching once the fix ships

It's a one-line change: set the package to `"aisdk:opencode-claude-code"` and delete the placeholder file. Nothing else depends on the package name:

- Our `sdk` hook is matched by provider ID, not package.
- Saved provider metadata is keyed by the model's canonical ID or provider ID, not the package (`aisdk.ts:369-377`, `439-452`).
- Sessions don't store the package; it only appears in in-memory cache keys.

There's no rush to switch. With the fix in place, the `file://` version still works: the fallback runs after our hook, sees an SDK already set and never imports the placeholder. We can switch once the oldest opencode version we support includes the fix.
