export * as ClaudeInstructions from "./instructions.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Scope } from "effect"
import { ClaudeSystemPrompt } from "../language-model/system-prompt.js"
import { ClaudeProvider } from "./provider.js"

export const Plugin = define<Scope.Scope>({
  id: "claude-agent.instructions",
  effect: Effect.fn("ClaudeInstructions.Plugin")(function* (ctx) {
    for (const kind of ["context", "generate", "compaction"] as const) {
      yield* ctx.session.hook(kind, (event) => Effect.gen(function* () {
        const agent = yield* ctx.agent.get({ agentID: event.agent }).pipe(Effect.orDie)
        // Read the role from the resolved agent, not by guessing which prompt text is a built-in.
        event.options[ClaudeSystemPrompt.AGENT_OPTION] = agent.data.system ?? ""
      }), { providerID: ClaudeProvider.ID })
    }
  }),
})
