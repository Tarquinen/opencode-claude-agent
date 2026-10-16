export * as ClaudeSessionHooks from "./session.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Scope } from "effect"
import { RequestKind } from "../language-model/request-kind.js"
import { ClaudeProvider } from "./provider.js"

export const Plugin = define<Scope.Scope>({
  id: "claude-code.session",
  effect: Effect.fn("ClaudeSessionHooks.Plugin")(function* (ctx) {
    yield* ctx.session.hook("model.request", (event) => Effect.sync(() => {
      event.headers[RequestKind.HEADER] = event.kind
    }), { providerID: ClaudeProvider.ID })
    // Claude Code already retries API failures. Replaying the whole turn here also retries permanent billing errors.
    yield* ctx.session.hook("retry", (event) => Effect.sync(() => {
      event.decision = { retry: false }
    }), { providerID: ClaudeProvider.ID })
  }),
})
