export * as ClaudeAISDK from "./aisdk.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Scope } from "effect"
import { ClaudeSessions } from "../claude/sessions.js"
import { ClaudeCodeLanguageModel } from "../language-model/claude-code-language-model.js"
import { ClaudeProvider } from "./provider.js"

export const Plugin = define<Scope.Scope | ClaudeSessions.Service>({
  id: "claude-code.aisdk",
  effect: Effect.fn("ClaudeAISDK.Plugin")(function* (ctx) {
    const sessions = yield* ClaudeSessions.Service
    const context = yield* Effect.context<never>()
    const run = Effect.runPromiseWith(context)
    const dependencies: ClaudeCodeLanguageModel.Dependencies = {
      run: (request, signal) => run(sessions.run(request), { signal }),
    }
    yield* ctx.aisdk.hook(
      "sdk",
      (evt) =>
        Effect.sync(() => {
          // Always replace: until the opencode fix ships, the npm fallback has already set the placeholder here
          evt.sdk = {
            languageModel: (modelID: string) => new ClaudeCodeLanguageModel.Model(modelID, dependencies),
          }
        }),
      { providerID: ClaudeProvider.ID },
    )
  }),
})
