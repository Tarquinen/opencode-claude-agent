import { define, type Plugin } from "@opencode/plugin/effect/plugin"
import { Effect, Scope } from "effect"
import { ClaudeIO } from "./claude/io.js"
import { ClaudeStatus } from "./claude/status.js"
import { ClaudeSessions } from "./claude/sessions.js"
import { ClaudeCodeOptions } from "./options.js"
import { ClaudeAISDK } from "./plugin/aisdk.js"
import { ClaudeIntegration } from "./plugin/integration.js"
import { ClaudeInstructions } from "./plugin/instructions.js"
import { ClaudeProvider } from "./plugin/provider.js"
import { ClaudeSessionHooks } from "./plugin/session.js"

const features: readonly Plugin<Scope.Scope | ClaudeStatus.Service | ClaudeSessions.Service>[] = [
  ClaudeProvider.Plugin, ClaudeIntegration.Plugin, ClaudeAISDK.Plugin, ClaudeSessionHooks.Plugin,
  ClaudeInstructions.Plugin,
]

// Tests pass a fake ClaudeIO. Config options can't hold functions, so this is the only way in.
// The registry lives outside setup's scope, so a reload can adopt its processes. Restart tests pass
// their own, so they can close it as an exiting opencode process would.
export const make = (io: ClaudeIO.Interface, registry = ClaudeSessions.registry()) =>
  define({
    id: "claude-code",
    effect: Effect.fn("ClaudeCode.Plugin")(function* (ctx) {
      const options = yield* ClaudeCodeOptions.decode(ctx.options).pipe(Effect.orDie)
      // Built once and shared, so every feature sees the same login state
      const status = yield* ClaudeStatus.make({ options, io })
      const sessions = yield* registry.attach({ options, io, storage: ctx.storage, directory: ctx.location.directory })
      for (const feature of features) {
        yield* feature.effect(ctx).pipe(
          Effect.provideService(ClaudeStatus.Service, status),
          Effect.provideService(ClaudeSessions.Service, sessions),
        )
      }
      yield* status.refresh().pipe(Effect.forkScoped)
    }),
  })

export default make(ClaudeIO.real)
