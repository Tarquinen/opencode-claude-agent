export * as ClaudeStatus from "./status.js"

import { Context, Effect, Semaphore, SubscriptionRef } from "effect"
import type { ClaudeAgentOptions } from "../options.js"
import { ClaudeIO } from "./io.js"
import { ClaudeProbe } from "./probe.js"
import { ClaudeQueryOptions } from "./query-options.js"

export type State =
  | { readonly type: "checking" }
  | { readonly type: "missing" }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "ready"; readonly probe: ClaudeProbe.Result }

export interface Interface {
  readonly state: SubscriptionRef.SubscriptionRef<State>
  readonly refresh: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("claude-agent/ClaudeStatus") {}

export const make = Effect.fn("ClaudeStatus.make")(function* (input: {
  readonly options: ClaudeAgentOptions.Options
  readonly io: ClaudeIO.Interface
}) {
  const state = yield* SubscriptionRef.make<State>({ type: "checking" })
  const lock = yield* Semaphore.make(1)

  // Serialized so a reconnect checks again after startup, rather than racing it with an older account snapshot.
  const refresh = Effect.fn("ClaudeStatus.refresh")(
    function* () {
      const executable = ClaudeQueryOptions.executable(input)
      if (!executable) return yield* SubscriptionRef.set(state, { type: "missing" })
      const next = yield* ClaudeProbe.run(ClaudeQueryOptions.base({ executable, io: input.io })).pipe(
        Effect.map((probe): State => ({ type: "ready", probe })),
        Effect.catch((error) =>
          Effect.logWarning("Claude Code login check failed", { cause: error.cause }).pipe(
            Effect.as<State>({ type: "failed", message: String(error.cause) }),
          ),
        ),
      )
      yield* SubscriptionRef.set(state, next)
    },
    lock.withPermit,
  )

  return Service.of({ state, refresh })
})
