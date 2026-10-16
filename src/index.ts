import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { ClaudeIO } from "./claude/io.js"
import { ClaudeStatus } from "./claude/status.js"
import { ClaudeCodeOptions } from "./options.js"
import { ClaudeAISDK } from "./plugin/aisdk.js"
import { ClaudeIntegration } from "./plugin/integration.js"
import { ClaudeProvider } from "./plugin/provider.js"

const features = [ClaudeProvider.Plugin, ClaudeIntegration.Plugin, ClaudeAISDK.Plugin]

// Tests pass a fake ClaudeIO. Config options can't hold functions, so this is the only way in.
export const make = (io: ClaudeIO.Interface) =>
  define({
    id: "claude-code",
    effect: Effect.fn("ClaudeCode.Plugin")(function* (ctx) {
      const options = yield* ClaudeCodeOptions.decode(ctx.options).pipe(Effect.orDie)
      // Built once and shared, so every feature sees the same login state
      const status = yield* ClaudeStatus.make({ options, io })
      for (const feature of features) {
        yield* feature.effect(ctx).pipe(Effect.provideService(ClaudeStatus.Service, status))
      }
      yield* status.refresh().pipe(Effect.forkScoped)
    }),
  })

export default make(ClaudeIO.real)
