export * as ClaudeSession from "./session.js"

import { query, type Options, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeProbe } from "./probe.js"

interface Turn {
  readonly emit: (message: SDKMessage) => void
  readonly result: PromiseWithResolvers<SDKResultMessage>
}

export type Interface = ReturnType<typeof start>

// Exactly one reader owns the SDK iterator, including while a turn is being cancelled.
export function start(options: Options) {
  let input!: ReadableStreamDefaultController<SDKUserMessage>
  const prompt = new ReadableStream<SDKUserMessage>({ start(controller) { input = controller } })
  const session = query({ prompt, options })
  let turn: Turn | undefined
  let initialized = false
  let ended = false
  let failure: unknown
  let stopping: Promise<void> | undefined
  let persisted = false
  const ready = session.initializationResult().then((init) => {
    const error = ClaudeProbe.versionError(init.claude_code_version)
    if (error) throw error
    initialized = true
  })

  const pump = (async () => {
    try {
      for await (const message of session) {
        turn?.emit(message)
        if (message.type === "result") {
          persisted = true
          turn?.result.resolve(message)
          turn = undefined
        }
      }
    } catch (error) {
      failure = error
    } finally {
      ended = true
      turn?.result.reject(failure ?? new Error("Claude Code stopped before finishing its reply"))
      turn = undefined
    }
  })()

  async function interrupt() {
    const active = turn
    if (!active) return
    await session.interrupt()
    // The interrupt receipt precedes the result and transcript flush. Do not send another turn yet.
    await active.result.promise
  }

  async function stop() {
    if (stopping) return stopping
    stopping = (async () => {
      try {
        if (initialized && !ended) await session.interrupt()
        input.close()
        // An uninitialized process has no conversation to flush.
        if (!initialized) session.close()
        await pump
      } finally {
        session.close()
      }
    })()
    return stopping
  }

  return {
    id: options.resume ?? options.sessionId!,
    ready,
    get ended() { return ended },
    get persisted() { return persisted },
    send(content: SDKUserMessage["message"]["content"], emit: Turn["emit"], uuid = crypto.randomUUID()) {
      if (ended || stopping) throw failure ?? new Error("Claude Code session has stopped")
      if (turn) throw new Error("Claude Code is still finishing the previous turn")
      const result = Promise.withResolvers<SDKResultMessage>()
      turn = { emit, result }
      input.enqueue({ type: "user", uuid, message: { role: "user", content }, parent_tool_use_id: null })
      return result.promise
    },
    interrupt,
    stop,
  }
}
