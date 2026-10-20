export * as ClaudeProbe from "./probe.js"

import { query, type AccountInfo, type ModelInfo, type Options, type Query } from "@anthropic-ai/claude-agent-sdk"
import { Data, Effect } from "effect"

export interface Model extends ModelInfo {
  contextWindow?: number
}

export interface Result {
  readonly version: string
  readonly account: AccountInfo
  readonly models: readonly Model[]
}

export class ProbeError extends Data.TaggedError("ClaudeProbeError")<{ readonly cause: unknown }> {}

// Older binaries silently ignore verbatimPrompts and can interpret user text as Claude commands.
const MINIMUM_VERSION = "2.1.248"
// Older binaries do not support summary-only context usage. Their models keep the conservative fallback.
const CONTEXT_DISCOVERY_VERSION = "2.1.257"

export function versionError(version: string | undefined) {
  if (version && Bun.semver.satisfies(version, `>=${MINIMUM_VERSION}`)) return
  const message = version
    ? `Claude Code ${version} is too old; ${MINIMUM_VERSION} or later is required.`
    : "Claude Code did not report its version, so compatibility could not be checked."
  return new Error(`${message} Run \`claude update\`.`)
}

// The input never sends a message, so no model call is made and no tokens are used.
export const run = Effect.fn("ClaudeProbe.run")(function* (options: Options) {
  const stop = Promise.withResolvers<void>()
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => query({ prompt: waitFor(stop.promise), options: { ...options, persistSession: false } })),
    (session) =>
      Effect.gen(function* () {
        const init = yield* Effect.tryPromise({
          try: () => session.initializationResult(),
          catch: (cause) => new ProbeError({ cause }),
        }).pipe(Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => Effect.fail(new ProbeError({ cause: new Error("claude did not start within 30 seconds") })),
        }))
        const error = versionError(init.claude_code_version)
        if (error) return yield* Effect.fail(new ProbeError({ cause: error }))
        const version = init.claude_code_version!
        const models: Model[] = init.models.map((model) => ({ ...model }))
        if (Bun.semver.satisfies(version, `>=${CONTEXT_DISCOVERY_VERSION}`)) yield* discoverContext(session, models)
        return { version, account: init.account, models } satisfies Result
      }),
    (session) =>
      Effect.sync(() => {
        stop.resolve()
        session.close()
      }),
  )
})

// Sets each model's context window in place, so models discovered before a timeout keep theirs.
const discoverContext = Effect.fn("ClaudeProbe.discoverContext")(
  function* (session: Query, models: readonly Model[]) {
    for (const model of models) {
      if (model.value === "default") continue
      yield* Effect.tryPromise(async () => {
        await session.setModel(model.value)
        const usage = await session.getContextUsage({ detail: "summary" })
        // rawMaxTokens is capacity; maxTokens can reflect Claude's own compaction window.
        if (!Number.isSafeInteger(usage.rawMaxTokens) || usage.rawMaxTokens <= 0) {
          throw new Error("Claude Code did not report a valid context window")
        }
        model.contextWindow = usage.rawMaxTokens
      }).pipe(Effect.catch((error) => Effect.logWarning("Claude Code context discovery failed", {
        model: model.value, cause: error.cause,
      })))
    }
  },
  Effect.timeoutOrElse({
    duration: "30 seconds",
    // A stuck control must not become a login failure. Closing this query cancels the pending request.
    orElse: () => Effect.logWarning("Claude Code context discovery timed out; undiscovered models use conservative limits"),
  }),
)

export function isLoggedIn(account: AccountInfo) {
  return account.tokenSource !== "none" || account.apiKeySource !== undefined
}

async function* waitFor(done: Promise<void>): AsyncGenerator<never> {
  await done
}
