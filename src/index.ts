import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Stream } from "effect"
import { ClaudeIO } from "./claude/io.js"
import { ClaudeStatus } from "./claude/status.js"
import { ClaudeSessions } from "./claude/sessions.js"
import { ClaudeAISDK } from "./plugin/aisdk.js"
import { ClaudeIntegration } from "./plugin/integration.js"
import { ClaudeInstructions } from "./plugin/instructions.js"
import { ClaudeProvider } from "./plugin/provider.js"
import { ClaudeSessionHooks } from "./plugin/session.js"
import { ClaudeWebSearchProvider } from "./plugin/websearch.js"

export const ID = "opencode.claude-agent"

// The registry lives outside setup's scope, so a reload can adopt its processes.
export const make = (io: ClaudeIO.Interface, registry = ClaudeSessions.registry()) =>
  define({
    id: ID,
    effect: Effect.fn("ClaudeAgent.Plugin")(function* (ctx) {
      // Claude Agent runs the local `claude` binary, so skip remote workspaces, where it can't run.
      if (ctx.location.workspaceID !== undefined) return

      const status = yield* ClaudeStatus.make(io, () => ClaudeProvider.connection(ctx))
      const sessions = yield* registry.attach({ io, status, storage: ctx.storage, directory: ctx.location.directory })
      yield* ctx.event
        .subscribe({
          types: ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"],
        })
        .pipe(
          Stream.runForEach((event) => sessions.idle(event.data.sessionID)),
          Effect.forkScoped({ startImmediately: true }),
        )
      // A finished subagent is rarely messaged again, so its process stops without waiting for IDLE_MS.
      // Background work, its own or a descendant's, wakes it again, so its process stays until none is left.
      yield* ctx.session.hook("experimental.idle", (event) =>
        Effect.gen(function* () {
          if (event.background.length > 0) return
          const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orDie)
          if (session.parentID) yield* sessions.retire(event.sessionID)
        }),
      )
      yield* ClaudeProvider.register(ctx, status, io)
      yield* ClaudeIntegration.register(ctx, status)
      yield* ClaudeAISDK.register(ctx, sessions)
      yield* ClaudeSessionHooks.register(ctx)
      yield* ClaudeInstructions.register(ctx)
      yield* ClaudeWebSearchProvider.register(ctx, io)
    }),
  })

export default make(ClaudeIO.real)
