export * as ClaudeSessionHooks from "./session.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema, Scope } from "effect"
import { RequestKind } from "../language-model/request-kind.js"
import { ClaudeProvider } from "./provider.js"

// OpenCode records stopped tools (including a plain permission rejection) with this structured error.
const isAborted = Schema.is(Schema.Struct({ error: Schema.Struct({ type: Schema.Literal("aborted") }) }))

export const Plugin = define<Scope.Scope>({
  id: "claude-code.session",
  effect: Effect.fn("ClaudeSessionHooks.Plugin")(function* (ctx) {
    yield* ctx.session.hook("model.request", (event) => Effect.gen(function* () {
      event.headers[RequestKind.HEADER] = event.kind
      if (event.kind === "primary") {
        const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orDie)
        if (session.fork) event.headers[RequestKind.FORK_HEADER] = session.fork.sessionID
      }
    }), { providerID: ClaudeProvider.ID })
    // Let Claude choose its normal output budget. Later hooks can still set an explicit maxTokens.
    // Compaction keeps OpenCode's summary budget; titles and generate already omit the automatic limit.
    yield* ctx.session.hook("context", (event) => Effect.sync(() => {
      delete event.options.maxTokens
    }), { providerID: ClaudeProvider.ID })
    // OpenCode's AI SDK bridge lowers error results to plain text. Preserve their status before that conversion.
    yield* ctx.session.hook("context", (event) => Effect.sync(() => {
      for (let i = 0; i < event.messages.length; i++) {
        const message = event.messages[i]!
        const content = [...message.content]
        for (let j = 0; j < content.length; j++) {
          const part = content[j]!
          if (part.type !== "tool-result" || part.result.type !== "error") continue
          content[j] = { ...part, providerMetadata: { ...part.providerMetadata, [ClaudeProvider.ID]: {
            ...part.providerMetadata?.[ClaudeProvider.ID], toolError: true, toolAborted: isAborted(part.result.value),
          } } }
        }
        event.messages[i] = { ...message, content }
      }
    }), { providerID: ClaudeProvider.ID })
    // Claude Code already retries API failures. Replaying the whole turn here also retries permanent billing errors.
    yield* ctx.session.hook("retry", (event) => Effect.sync(() => {
      event.decision = { retry: false }
    }), { providerID: ClaudeProvider.ID })
  }),
})
