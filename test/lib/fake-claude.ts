export * as FakeClaude from "./fake-claude.js"

import { EventEmitter } from "node:events"
import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"
import type { Options, SDKControlInitializeResponse, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk"
import { Recorder } from "./recorder.js"

// One step of a script. Each `claude` the SDK starts takes the next steps in order.
export interface Step {
  readonly type: "startup"
  readonly reply: SDKControlInitializeResponse
  readonly hold?: Promise<void>
  readonly exitCode?: number
  readonly started: PromiseWithResolvers<void>
  readonly done: PromiseWithResolvers<void>
}

// Answers the SDK's start-up request with the reply from a recording. With `hold`, the reply waits until it resolves.
export function expectStartup(input?: {
  readonly recording?: string
  readonly hold?: Promise<void>
  readonly exitCode?: number
}): Step {
  return {
    type: "startup",
    reply: Recorder.startupReply(Recorder.load(input?.recording ?? "startup")),
    hold: input?.hold,
    exitCode: input?.exitCode,
    started: Promise.withResolvers<void>(),
    done: Promise.withResolvers<void>(),
  }
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

export function make(script: readonly Step[]) {
  const runs: Run[] = []
  const errors: string[] = []
  let next = 0
  let completed = 0

  const spawn: NonNullable<Options["spawnClaudeCodeProcess"]> = (options) => {
    const process = new FakeProcess()
    const closed = Promise.withResolvers<void>()
    process.once("exit", () => closed.resolve())
    const run: Run = { args: options.args, env: options.env, received: [], closed: closed.promise }
    runs.push(run)
    createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line)
      run.received.push(message)
      void answer(message, process, closed.promise).catch((error) => errors.push(String(error)))
    })
    // The SDK closes stdin to stop `claude`
    process.stdin.on("end", () => process.exit(0, null))
    return process
  }

  async function answer(message: any, process: FakeProcess, closed: Promise<void>) {
    if (message.type === "control_request" && message.request.subtype === "initialize") {
      const step = script[next]
      if (step?.type !== "startup") {
        errors.push(`unexpected start-up, the next step is ${step?.type ?? "the end of the script"}`)
        return
      }
      next++
      step.started.resolve()
      await Promise.race([step.hold, closed])
      if (process.exitCode !== null || process.signalCode !== null) return
      if (step.exitCode !== undefined) process.exit(step.exitCode, null)
      else process.stdout.write(JSON.stringify(startupResponse(message.request_id, step.reply)) + "\n")
      completed++
      step.done.resolve()
      return
    }
    errors.push(`unexpected message from the SDK: ${JSON.stringify(message)}`)
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
