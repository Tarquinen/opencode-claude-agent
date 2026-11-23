export * as ClaudeWebSearchProvider from "./websearch.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Option, Schema, Stream } from "effect"
import { ClaudeAccounts } from "../claude/accounts.js"
import type { ClaudeIO } from "../claude/io.js"
import { ClaudeQueryOptions } from "../claude/query-options.js"
import { ClaudeWebSearch } from "../claude/websearch.js"
import { ClaudeAgentError } from "../language-model/claude-agent-error.js"
import { ClaudeProvider } from "./provider.js"

export const ID = "claude-agent"

// Claude Code's WebSearch as an opencode websearch provider, so every model can search with the Claude plan through
// opencode's own websearch tool. It is offered only while Claude Agent is connected, and never made the default:
// users pick it with `"websearch": { "provider": "claude-agent" }`.
export const register = Effect.fn("ClaudeWebSearchProvider.register")(function* (ctx: Context, io: ClaudeIO.Interface) {
  const state = { connected: (yield* ctx.integration.connection.active(ClaudeProvider.ID)) !== undefined }

  yield* ctx.websearch.transform((editor) => {
    if (!state.connected) return
    editor.add({ id: ID, name: "Claude Agent", execute: (input) => search(ctx, io, input.query) })
  })

  yield* ctx.event.subscribe({ types: ["credential.switched", "credential.updated"] }).pipe(
    // A credential update without an integration ID may be ours, and checking again is cheap
    Stream.filter(
      (event) => !("integrationID" in event.data) || String(event.data.integrationID) === ClaudeProvider.ID,
    ),
    Stream.runForEach(() =>
      Effect.gen(function* () {
        const connected = (yield* ctx.integration.connection.active(ClaudeProvider.ID)) !== undefined
        if (connected === state.connected) return
        state.connected = connected
        yield* ctx.websearch.reload()
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )
})

const search = Effect.fn("ClaudeWebSearchProvider.search")(function* (
  ctx: Context,
  io: ClaudeIO.Interface,
  query: string,
) {
  const executable = io.which()
  if (!executable) return yield* Effect.fail(new Error("Claude Code is not installed, so Claude can't search the web."))
  const provider = yield* ctx.provider.get({ providerID: ClaudeProvider.ID }).pipe(Effect.option)
  const info = Option.isSome(provider) ? provider.value.data : undefined
  const settings = info?.settings ?? {}
  const connection = ClaudeQueryOptions.connectionEnv({ settings, headers: info?.headers, body: info?.body })
  const model = typeof settings.webSearchModel === "string" ? settings.webSearchModel : ClaudeWebSearch.DEFAULT_MODEL

  // Start on the account chats used last, and move on only when a plan limit refuses the search, like chats do.
  // An API key or token logs in the same way whatever the folder, so those never rotate.
  const dirs = ClaudeQueryOptions.configDirs(settings.configDir)
  const rotate = dirs.length > 1 && !connection.ANTHROPIC_API_KEY && !connection.ANTHROPIC_AUTH_TOKEN
  const last = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.String)(yield* ctx.storage.get(ClaudeAccounts.LAST)),
  )
  const start = rotate && last ? Math.max(0, dirs.indexOf(last)) : 0
  const order = rotate ? [...dirs.slice(start), ...dirs.slice(0, start)] : []
  const attempts = order.length > 0 ? order.map((dir) => ({ ...connection, CLAUDE_CONFIG_DIR: dir })) : [connection]

  return yield* Effect.tryPromise({
    try: async (signal) => {
      for (let i = 0; ; i++) {
        const env = ClaudeQueryOptions.withoutDefaultFolder(attempts[i]!, io)
        try {
          const options = ClaudeWebSearch.options({ executable, io, connection: env, model })
          return await ClaudeWebSearch.search({ query, options, signal })
        } catch (error) {
          const limited = error instanceof ClaudeAgentError.Failure && error.limited
          if (!limited || signal.aborted || i === attempts.length - 1) throw error
        }
      }
    },
    catch: (error) => error,
  })
})
