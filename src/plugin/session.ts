export * as ClaudeSessionHooks from "./session.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema, Scope } from "effect"
import { RequestKind } from "../language-model/request-kind.js"
import { ClaudeProvider } from "./provider.js"

// OpenCode records stopped tools (including a plain permission rejection) with this structured error.
const isAborted = Schema.is(Schema.Struct({ error: Schema.Struct({ type: Schema.Literal("aborted") }) }))

export const Plugin = define<Scope.Scope>({
  id: "claude-agent.session",
  effect: Effect.fn("ClaudeSessionHooks.Plugin")(function* (ctx) {
    yield* ctx.session.hook("model.request", (event) => Effect.gen(function* () {
      event.headers[RequestKind.HEADER] = event.kind
      if (event.kind === "primary") {
        const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orDie)
        if (session.fork) event.headers[RequestKind.FORK_HEADER] = session.fork.sessionID
      }
    }), { providerID: ClaudeProvider.ID })
    yield* ctx.session.hook("context", (event) => Effect.sync(() => {
      // Let Claude choose its normal output budget. Later hooks can still set an explicit maxTokens.
      // Compaction has its own hook, so it keeps OpenCode's summary budget.
      delete event.options.maxTokens
      // Preserve tool error status before the AI SDK bridge flattens error results to plain text.
      for (let i = 0; i < event.messages.length; i++) {
        const message = event.messages[i]!
        const content = [...message.content]
        for (let j = 0; j < content.length; j++) {
          const part = content[j]!
          if (part.type !== "tool-result" || part.result.type !== "error") continue
          const flags = {
            ...part.providerMetadata?.[ClaudeProvider.ID],
            toolError: true,
            toolAborted: isAborted(part.result.value),
          }
          const providerMetadata = { ...part.providerMetadata, [ClaudeProvider.ID]: flags }
          content[j] = { ...part, providerMetadata }
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
