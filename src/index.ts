import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { ClaudeIO } from "./claude/io.js"
import { ClaudeStatus } from "./claude/status.js"
import { ClaudeSessions } from "./claude/sessions.js"
import { ClaudeAISDK } from "./plugin/aisdk.js"
import { ClaudeIntegration } from "./plugin/integration.js"
import { ClaudeInstructions } from "./plugin/instructions.js"
import { ClaudeProvider } from "./plugin/provider.js"
import { ClaudeSessionHooks } from "./plugin/session.js"

export const ID = "opencode.claude-agent"

// Tests pass a fake ClaudeIO here. The registry lives outside setup's scope, so a reload can adopt its processes.
// Restart tests pass their own and close it, as an exiting opencode would.
export const make = (io: ClaudeIO.Interface, registry = ClaudeSessions.registry()) =>
  define({
    id: ID,
    effect: Effect.fn("ClaudeAgent.Plugin")(function* (ctx) {
      // Claude Agent runs the local `claude` binary, so skip remote workspaces, where it can't run.
      if (ctx.location.workspaceID !== undefined) return

      const status = yield* ClaudeStatus.make(io, () => ClaudeProvider.connection(ctx))
      const sessions = yield* registry.attach({ io, status, storage: ctx.storage, directory: ctx.location.directory })
      yield* ClaudeProvider.register(ctx, status, io)
      yield* ClaudeIntegration.register(ctx, status)
      yield* ClaudeAISDK.register(ctx, sessions)
      yield* ClaudeSessionHooks.register(ctx)
      yield* ClaudeInstructions.register(ctx)
    }),
  })

export default make(ClaudeIO.real)
