export * as ClaudeAccounts from "./accounts.js"

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import { ClaudeAgentError } from "../language-model/claude-agent-error.js"
import type { ClaudeSessions } from "./sessions.js"

export interface Storage {
  readonly get: (key: string) => Effect.Effect<unknown>
  readonly set: (key: string, value: string) => Effect.Effect<void>
}

export interface Interface {
  readonly run: (request: ClaudeSessions.Request, configDirs: readonly string[]) => Effect.Effect<void, Error>
}

// When settings list several Claude config folders, a request starts on the account that last worked for its chat.
// If that account refuses before Claude shows any output, the request tries each other account once.
// Failed accounts are not remembered, so a request for a model with its own limit can still use any of them.
// An API key or token in settings logs in the same way whatever the folder, so those requests never rotate.
export function make(input: { readonly sessions: ClaudeSessions.Interface; readonly storage: Storage }) {
  const saved = Effect.fn("ClaudeAccounts.saved")(function* (chat: string | undefined) {
    if (!chat) return undefined
    const value = yield* input.storage.get(`accounts/${chat}`)
    return typeof value === "string" ? value : undefined
  })

  const run = Effect.fn("ClaudeAccounts.run")(function* (
    request: ClaudeSessions.Request,
    configDirs: readonly string[],
  ) {
    const connection = request.connection
    if (configDirs.length < 2 || connection?.ANTHROPIC_API_KEY || connection?.ANTHROPIC_AUTH_TOKEN) {
      return yield* input.sessions.run(request)
    }
    // Side calls use their chat's account. Titles have no chat and start on the first account.
    const chat = request.sessionID ?? request.sourceID
    const stored = yield* saved(chat)
    // A new fork starts on its parent's account, which has the transcript to fork.
    const from = stored ?? (yield* saved(request.sourceID))
    const dirs = order(configDirs, from)
    for (let i = 0; i < dirs.length; i++) {
      const dir = dirs[i]
      const attempt = watch(request.emit)
      yield* input.sessions.run({
        ...request,
        connection: { ...connection, CLAUDE_CONFIG_DIR: dir },
        emit: attempt.emit,
      })
      if (!attempt.refused()) {
        if (chat && dir !== stored) yield* input.storage.set(`accounts/${chat}`, dir)
        attempt.flush()
        return
      }
      // A limit always comes before a call's output, but one step makes a second call when Claude names a tool we did
      // not offer. If that call is refused, a retry would repeat the text already shown, so the next request moves instead.
      // When every account refuses, the last one's error is shown and the chat keeps its saved account.
      if (attempt.shown() || i === dirs.length - 1) {
        attempt.flush()
        return
      }
      yield* Effect.logInfo("Claude account refused the request, retrying on the next one", {
        from: dir,
        to: dirs[i + 1],
      })
    }
  })

  return { run } satisfies Interface
}

// Every account in order, starting from the chat's own so it keeps its transcript and prompt cache.
export function order(dirs: readonly string[], from?: string) {
  let start = from ? dirs.indexOf(from) : 0
  if (start < 0) start = 0
  const result: string[] = []
  for (let i = 0; i < dirs.length; i++) {
    result.push(dirs[(start + i) % dirs.length])
  }
  return result
}

// Holds one attempt's messages until Claude shows output, so a refused request can retry on another account unseen.
export function watch(emit: (message: SDKMessage) => void) {
  const failure = ClaudeAgentError.make()
  let held: SDKMessage[] | undefined = []
  let refused = false

  const flush = () => {
    if (!held) return
    const messages = held
    held = undefined
    for (const message of messages) emit(message)
  }

  return {
    emit(message: SDKMessage) {
      const error = failure(message)
      // A missing login or a usage limit means another account could take the request.
      if (error && (error.code === "authentication_failed" || error.limited)) refused = true
      if (!held) {
        emit(message)
        return
      }
      const visible = message.type === "stream_event" || (message.type === "assistant" && !message.error)
      if (!visible) {
        held.push(message)
        return
      }
      flush()
      emit(message)
    },
    flush,
    shown: () => held === undefined,
    refused: () => refused,
  }
}
