export * as ClaudeSession from "./session.js"

import { query, type Options, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeProbe } from "./probe.js"

interface Turn {
  readonly result: PromiseWithResolvers<SDKResultMessage>
  readonly messages: SDKMessage[]
  wake?: () => void
  finished: boolean
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
        if (turn) {
          turn.messages.push(message)
          turn.wake?.()
        }
        if (message.type === "assistant") persisted = true
        if (message.type === "result") {
          persisted = true
          if (turn) turn.finished = true
          turn?.result.resolve(message)
        }
      }
    } catch (error) {
      failure = error
    } finally {
      ended = true
      turn?.result.reject(failure ?? new Error("Claude Code stopped before finishing its reply"))
      turn?.wake?.()
    }
  })()

  async function interrupt() {
    const active = turn
    if (!active || active.finished) return
    await session.interrupt()
    // The interrupt receipt precedes the result and transcript flush. Do not send another turn yet.
    await active.result.promise
  }

  async function stop() {
    if (stopping) return stopping
    stopping = (async () => {
      try {
        if (initialized && !ended) {
          await session.interrupt()
          if (turn && !turn.finished) await turn.result.promise
        }
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

  function begin(content: SDKUserMessage["message"]["content"], uuid = crypto.randomUUID()) {
    if (ended || stopping) throw failure ?? new Error("Claude Code session has stopped")
    if (turn && !turn.finished) throw new Error("Claude Code is still finishing the previous turn")
    const result = Promise.withResolvers<SDKResultMessage>()
    // The reader reports process failures too; this promise is also used by interrupt-and-drain.
    void result.promise.catch(() => {})
    turn = { result, messages: [], finished: false }
    input.enqueue({ type: "user", uuid, message: { role: "user", content }, parent_tool_use_id: null })
  }

  async function readStep(emit: (message: SDKMessage) => void): Promise<SDKResultMessage | "tools"> {
    const active = turn
    if (!active) throw new Error("No Claude turn to read")
    let tools = false
    for (;;) {
      const message = active.messages.shift()
      if (!message) {
        if (ended) throw failure ?? new Error("Claude Code stopped before finishing its reply")
        await new Promise<void>((resolve) => { active.wake = resolve })
        continue
      }
      emit(message)
      if (message.type === "assistant" && message.parent_tool_use_id === null) {
        for (const part of message.message.content) if (part.type === "tool_use") tools = true
      }
      if (tools && message.type === "stream_event" && message.parent_tool_use_id === null && message.event.type === "message_stop") return "tools"
      if (message.type === "result") return message
    }
  }

  return {
    id: options.resume ?? options.sessionId!,
    ready,
    get ended() { return ended },
    get persisted() { return persisted },
    get running() { return !!turn && !turn.finished },
    begin,
    readStep,
    addUser(content: SDKUserMessage["message"]["content"], uuid: NonNullable<SDKUserMessage["uuid"]>) {
      input.enqueue({ type: "user", uuid, priority: "next", message: { role: "user", content }, parent_tool_use_id: null })
    },
    interrupt,
    stop,
    setModel: (model: string) => session.setModel(model),
    setEffort: (effort: Options["effort"]) => session.applyFlagSettings({ effortLevel: effort ?? null }),
  }
}
