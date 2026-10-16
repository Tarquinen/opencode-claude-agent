export * as ClaudeAISDK from "./aisdk.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Scope } from "effect"
import { ClaudeStatus } from "../claude/status.js"
import { ClaudeCodeProvider } from "../language-model/claude-code-provider.js"
import { ClaudeProvider } from "./provider.js"

export const Plugin = define<Scope.Scope | ClaudeStatus.Service>({
  id: "claude-code.aisdk",
  effect: Effect.fn("ClaudeAISDK.Plugin")(function* (ctx) {
    const status = yield* ClaudeStatus.Service
    yield* ctx.aisdk.hook(
      "sdk",
      (evt) =>
        Effect.sync(() => {
          // Always replace: until the opencode fix ships, the npm fallback has already set the placeholder here
          evt.sdk = ClaudeCodeProvider.createClaudeCode({ status })
        }),
      { providerID: ClaudeProvider.ID },
    )
  }),
})
