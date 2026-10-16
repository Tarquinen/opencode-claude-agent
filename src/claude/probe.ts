export * as ClaudeProbe from "./probe.js"

import { query, type AccountInfo, type ModelInfo, type Options } from "@anthropic-ai/claude-agent-sdk"
import { Data, Effect } from "effect"

export interface Result {
  readonly version: string
  readonly account: AccountInfo
  readonly models: readonly ModelInfo[]
}

export class ProbeError extends Data.TaggedError("ClaudeProbeError")<{ readonly cause: unknown }> {}

// Older binaries silently ignore verbatimPrompts and can interpret user text as Claude commands.
const MINIMUM_VERSION = "2.1.248"

export function versionError(version: string | undefined) {
  if (version && Bun.semver.satisfies(version, `>=${MINIMUM_VERSION}`)) return
  const message = version
    ? `Claude Code ${version} is too old; ${MINIMUM_VERSION} or later is required.`
    : "Claude Code did not report its version, so compatibility could not be checked."
  return new Error(`${message} Run \`claude update\`.`)
}

// Starts `claude` with an input that never sends a message, reads what it reports at start-up, then stops it.
// No model call is made, so no tokens are used.
export const run = Effect.fn("ClaudeProbe.run")(function* (options: Options) {
  const stop = Promise.withResolvers<void>()
  const init = yield* Effect.acquireUseRelease(
    Effect.sync(() => query({ prompt: waitFor(stop.promise), options })),
    (session) =>
      Effect.tryPromise({
        try: () => session.initializationResult(),
        catch: (cause) => new ProbeError({ cause }),
      }),
    (session) =>
      Effect.sync(() => {
        stop.resolve()
        session.close()
      }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(new ProbeError({ cause: new Error("claude did not start within 30 seconds") })),
    }),
  )
  const error = versionError(init.claude_code_version)
  if (error) return yield* Effect.fail(new ProbeError({ cause: error }))
  return { version: init.claude_code_version!, account: init.account, models: init.models } satisfies Result
})

// Logged in with a Claude subscription, so calls use plan limits rather than API billing
export function isSubscription(account: AccountInfo) {
  if (account.apiProvider !== undefined && account.apiProvider !== "firstParty") return false
  if (account.apiKeySource !== undefined) return false
  return account.subscriptionType !== undefined
}

async function* waitFor(done: Promise<void>): AsyncGenerator<never> {
  await done
}
