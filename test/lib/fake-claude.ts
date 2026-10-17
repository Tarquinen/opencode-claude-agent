export * as FakeClaude from "./fake-claude.js"

import { EventEmitter } from "node:events"
import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"
import type { Options, SDKControlInitializeResponse, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk"
import { Recorder } from "./recorder.js"

// One step of a script. Each `claude` the SDK starts takes the next steps in order.
interface Gates {
  readonly hold?: Promise<void>
  readonly started: PromiseWithResolvers<void>
  readonly done: PromiseWithResolvers<void>
}

interface Startup extends Gates {
  readonly type: "startup"
  readonly reply: SDKControlInitializeResponse
  readonly exitCode?: number
}

interface Input extends Gates {
  readonly type: "user" | "interrupt"
  readonly replies: readonly any[]
  readonly beforeResult?: Promise<void>
}

export type Step = Startup | Input

// Answers the SDK's start-up request with the reply from a recording. With `hold`, the reply waits until it resolves.
export function expectStartup(input?: {
  readonly recording?: string
  readonly hold?: Promise<void>
  readonly exitCode?: number
}): Startup {
  return {
    type: "startup",
    reply: Recorder.startupReply(Recorder.load(input?.recording ?? "startup")),
    hold: input?.hold,
    exitCode: input?.exitCode,
    started: Promise.withResolvers<void>(),
    done: Promise.withResolvers<void>(),
  }
}

// Replay one recorded user turn or interrupt, ending at the next SDK input. The cancelled recording
// deliberately splits at the interrupt: its receipt arrives before the remaining assistant events/result.
function recordedInput(recording: string, type: Input["type"], index: number) {
  const replies: any[] = []
  let found = false
  let seen = 0
  for (const line of Recorder.load(recording)) {
    if (line.from === "sdk") {
      if (found) break
      const matches = type === "user" ? line.message.type === "user" : line.message.request?.subtype === "interrupt"
      if (matches && seen++ === index) found = true
    } else if (found && line.from === "claude") replies.push(line.message)
  }
  if (!found) throw new Error(`No ${type} ${index} in ${recording}`)
  return replies
}

export function expectTurn(input?: { readonly recording?: string; readonly index?: number; readonly hold?: Promise<void> }): Input {
  return {
    type: "user", replies: recordedInput(input?.recording ?? "text", "user", input?.index ?? 0),
    hold: input?.hold, started: Promise.withResolvers<void>(), done: Promise.withResolvers<void>(),
  }
}

export function expectInterrupt(input?: { readonly recording?: string; readonly index?: number; readonly hold?: Promise<void>; readonly beforeResult?: Promise<void> }): Input {
  return {
    type: "interrupt", replies: recordedInput(input?.recording ?? "text", "interrupt", input?.index ?? 0),
    hold: input?.hold, beforeResult: input?.beforeResult, started: Promise.withResolvers<void>(), done: Promise.withResolvers<void>(),
  }
}

export function replies(step: Input, requestID?: string) {
  return step.replies.map((message) => message.type === "control_response"
    ? { ...message, response: { ...message.response, request_id: requestID } }
    : message)
}

// A start-up reply from a recording, answering the request with the given ID
export function startupResponse(requestID: string, reply: SDKControlInitializeResponse) {
  return {
    type: "control_response",
    response: { subtype: "success", request_id: requestID, response: reply },
  }
}

// One `claude` the SDK started: its flags, its environment and every message the SDK wrote to it
export interface Run {
  readonly args: readonly string[]
  readonly env: Record<string, string | undefined>
  readonly received: any[]
  readonly closed: Promise<void>
}

export type Fake = ReturnType<typeof make>

export function make(script: readonly Step[], options?: { readonly probes?: boolean }) {
  const runs: Run[] = []
  const errors: string[] = []
  let next = 0
  let completed = 0
  const probeReply = options?.probes ? Recorder.startupReply(Recorder.load("startup")) : undefined

  const spawn: NonNullable<Options["spawnClaudeCodeProcess"]> = (options) => {
    const process = new FakeProcess()
    const closed = Promise.withResolvers<void>()
    process.once("exit", () => closed.resolve())
    const run: Run = { args: options.args, env: options.env, received: [], closed: closed.promise }
    runs.push(run)
    createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line)
      run.received.push(message)
      void answer(message, process, closed.promise, run).catch((error) => errors.push(String(error)))
    })
    // The SDK closes stdin to stop `claude`
    process.stdin.on("end", () => process.exit(0, null))
    return process
  }

  async function answer(message: any, process: FakeProcess, closed: Promise<void>, run: Run) {
    const type = message.type === "user" ? "user" : message.request?.subtype === "initialize" ? "startup" : message.request?.subtype
    // Embedded OpenCode loads plugins for several locations. Its login probes are independent of chat ordering.
    if (probeReply && !run.args.includes("--include-partial-messages") && type === "startup") {
      process.stdout.write(JSON.stringify(startupResponse(message.request_id, probeReply)) + "\n")
      return
    }
    const step = script[next]
    if (!step || type !== step.type) {
      errors.push(`unexpected ${type ?? message.type}, the next step is ${step?.type ?? "the end of the script"}`)
      return
    }
    next++
    step.started.resolve()
    await Promise.race([step.hold, closed])
    if (process.exitCode !== null || process.signalCode !== null) return
    if (step.type === "startup") {
      if (step.exitCode !== undefined) process.exit(step.exitCode, null)
      else process.stdout.write(JSON.stringify(startupResponse(message.request_id, step.reply)) + "\n")
    } else {
      for (const reply of replies(step, message.request_id)) {
        if (reply.type === "result" && step.beforeResult) await Promise.race([step.beforeResult, closed])
        if (process.exitCode !== null || process.signalCode !== null) return
        const sessionID = run.args.find((arg) => arg.startsWith("--session-id=") || arg.startsWith("--resume="))?.split("=")[1]
        process.stdout.write(JSON.stringify(sessionID && "session_id" in reply ? { ...reply, session_id: sessionID } : reply) + "\n")
      }
    }
    completed++
    step.done.resolve()
  }

  return {
    spawn,
    runs,
    // Resolves when the SDK has requested a step, before any hold is released
    started: (step: Step) => step.started.promise,
    // Resolves once the fake has finished the step
    reached: (step: Step) => step.done.promise,
    // Throws if a step never finished, or the SDK wrote something the script didn't expect
    check: () => {
      if (errors.length > 0) throw new Error(errors.join("\n"))
      if (completed < script.length) throw new Error(`${script.length - completed} script steps did not finish`)
    },
  }
}

class FakeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  killed = false
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  kill(signal: NodeJS.Signals) {
    if (this.exited()) return false
    this.killed = true
    this.exit(null, signal)
    return true
  }

  exit(code: number | null, signal: NodeJS.Signals | null) {
    if (this.exited()) return
    this.exitCode = code
    this.signalCode = signal
    this.stdout.end()
    this.emit("exit", code, signal)
  }

  private exited() {
    return this.exitCode !== null || this.signalCode !== null
  }
}
