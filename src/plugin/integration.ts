export * as ClaudeIntegration from "./integration.js"

import type { Connection } from "@opencode/plugin/effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Scope, Stream, SubscriptionRef } from "effect"
import { ClaudeProbe } from "../claude/probe.js"
import { ClaudeStatus } from "../claude/status.js"
import { ClaudeProvider } from "./provider.js"

export const METHOD_ID = "claude-login"

// The login method only records that the user chose Claude Code. The login itself belongs to `claude`, and the plugin
// never sees a token (PLAN.md, "Ground rules").
export const Plugin = define<Scope.Scope | ClaudeStatus.Service>({
  id: "claude-code.integration",
  effect: Effect.fn("ClaudeIntegration.Plugin")(function* (ctx) {
    const status = yield* ClaudeStatus.Service

    yield* ctx.integration.transform((editor) => {
      editor.update(ClaudeProvider.ID, (integration) => {
        integration.name = "Claude Agent"
      })
      editor.method.update({
        integrationID: ClaudeProvider.ID,
        method: { id: METHOD_ID, type: "external", label: "Use existing Claude Code login (`claude auth login`)" },
      })
    })

    // Show a sign-in problem on the connection when `claude` is missing or logged out
    yield* SubscriptionRef.changes(status.state).pipe(
      Stream.runForEach((state) =>
        Effect.gen(function* () {
          if (state.type === "checking") return
          const connection = yield* ctx.integration.connection.active(ClaudeProvider.ID)
          if (!connection) return
          yield* ctx.integration.connection.status({
            integrationID: ClaudeProvider.ID,
            connection,
            status: problem(state),
          })
        }),
      ),
      Effect.forkScoped,
    )

    // Check again when the user connects. opencode keeps a problem per connection, so a new connection starts with
    // none, and the user may have just run `claude auth login`.
    yield* ctx.event.subscribe().pipe(
      Stream.filter(
        (event) => event.type === "credential.switched" && String(event.data.integrationID) === ClaudeProvider.ID,
      ),
      Stream.runForEach(() => status.refresh()),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})

function problem(state: ClaudeStatus.State): Connection.Status | undefined {
  if (state.type === "missing")
    return {
      status: "needs_auth",
      message: "Claude Code is not installed. Install it, then run `claude auth login`.",
      url: "https://code.claude.com/docs/en/setup",
    }
  if (state.type === "failed") return { status: "needs_auth", message: `Claude Code login check failed: ${state.message}` }
  if (state.type === "ready" && state.warning) return { status: "needs_auth", message: state.warning }
  if (state.type === "ready" && !ClaudeProbe.isSubscription(state.probe.account))
    return { status: "needs_auth", message: "Run `claude auth login` in a terminal and sign in with your Claude plan." }
  return undefined
}
