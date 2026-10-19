export * as ClaudeSessions from "./sessions.js"

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { LanguageModelV3FunctionTool, LanguageModelV3Prompt, LanguageModelV3TextPart, LanguageModelV3ToolCallPart } from "@ai-sdk/provider"
import { Context, Effect, Fiber, Semaphore } from "effect"
import { ClaudeIO } from "./io.js"
import { ClaudeQueryOptions } from "./query-options.js"
import { ClaudeSession } from "./session.js"
import type { ClaudeCodeOptions } from "../options.js"
import { SessionRecord } from "../sync/record.js"
import { Checkpoints } from "../sync/checkpoints.js"
import { SyncDecision } from "../sync/decide.js"
import { CatchUp } from "../sync/catch-up.js"
import { ConvertToClaudeMessage } from "../language-model/convert-to-claude-message.js"
import { PendingTools } from "../tools/pending.js"
import { ToolNames } from "../tools/names.js"
import { ToolResult } from "../tools/result.js"

export const HANDOVER_MS = 10_000
export const IDLE_MS = 5 * 60_000

interface Request {
  // Only primary calls have one. Side calls run in a throwaway process.
  readonly sessionID?: string
  // Native OpenCode fork lineage, or the session supplying a compaction/generate snapshot.
  readonly sourceID?: string
  readonly compaction?: boolean
  readonly model: string
  readonly effort?: Options["effort"]
  readonly maxOutputTokens?: number
  readonly system: NonNullable<Options["systemPrompt"]>
  readonly prompt: LanguageModelV3Prompt
  readonly tools: readonly LanguageModelV3FunctionTool[]
  readonly emit: (message: SDKMessage) => void
}

// These values belong to one process and are replaced together when it restarts.
interface LiveProcess {
  readonly session: ClaudeSession.Interface
  readonly pending: PendingTools.Interface
  model: string
  effort?: Options["effort"]
  // Settings that need a new process to change. Model and effort change on the running one.
  readonly launch: string
  waiting?: string[]
}

interface Entry {
  readonly lock: Semaphore.Semaphore
  process?: LiveProcess
  record?: SessionRecord.Record
  idle?: Fiber.Fiber<void, never>
  active?: Fiber.Fiber<unknown, unknown>
}

export interface Interface {
  readonly run: (request: Request) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("claude-code/Sessions") {}

const launch = (request: Request) => JSON.stringify([request.maxOutputTokens, request.system, request.tools])

const toError = (error: unknown) => error instanceof Error ? error : new Error(String(error))
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toError })
const attemptSync = <A>(run: () => A) => Effect.try({ try: run, catch: toError })

export type Registry = ReturnType<typeof registry>

export function registry() {
  const entries = new Map<string, Entry>()
  // Side calls share startup/draining with chat, but are tracked only until their request ends.
  const temporary = new Set<Entry>()
  let owners = 0
  let handover: Fiber.Fiber<void, never> | undefined

  const interrupt = Effect.fn("ClaudeSessions.interrupt")(function* (entry: Entry) {
    const process = entry.process
    if (!process) return
    yield* attempt(() => process.session.interrupt())
    process.pending.clear()
    process.waiting = undefined
  }, Effect.uninterruptible)

  const stop = Effect.fn("ClaudeSessions.stop")(function* (entry: Entry) {
    const process = entry.process
    if (!process) return
    yield* attempt(() => process.session.stop()).pipe(Effect.ensuring(Effect.sync(() => {
      process.pending.clear()
      entry.process = undefined
    })))
  }, Effect.uninterruptible)

  const closeEntries = Effect.fn("ClaudeSessions.closeEntries")(function* () {
    for (const entry of [...entries.values(), ...temporary]) {
      if (entry.active) yield* Fiber.interrupt(entry.active)
      // The active turn's finalizer can install a new idle timer.
      if (entry.idle) yield* Fiber.interrupt(entry.idle)
      yield* entry.lock.withPermit(stop(entry)).pipe(Effect.catch((error) => Effect.logWarning(error)))
    }
    entries.clear()
  })

  const cancelHandover = Effect.fn("ClaudeSessions.cancelHandover")(function* () {
    if (!handover) return
    yield* Fiber.interrupt(handover)
    handover = undefined
  })

  const close = Effect.fn("ClaudeSessions.close")(function* () {
    yield* cancelHandover()
    yield* closeEntries()
  })

  const attach = Effect.fn("ClaudeSessions.attach")(function* (input: {
    readonly io: ClaudeIO.Interface
    readonly options: ClaudeCodeOptions.Options
    readonly storage: SessionRecord.Storage
    readonly directory: string
  }) {
    const records = SessionRecord.make(input.storage)
    owners++
    yield* cancelHandover()
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      owners--
      if (owners !== 0 || (entries.size === 0 && temporary.size === 0)) return
      handover = yield* Effect.sleep(HANDOVER_MS).pipe(Effect.andThen(closeEntries()), Effect.forkDetach)
    }))

    const open = Effect.fn("ClaudeSessions.open")(function* (entry: Entry, request: Request) {
      if (!entry.process) {
        const executable = ClaudeQueryOptions.executable(input)
        if (!executable) return yield* Effect.fail(new Error("Install Claude Code and run `claude auth login` first"))
        const pending = PendingTools.make()
        const session = yield* attemptSync(() => ClaudeSession.start(ClaudeQueryOptions.session({
          executable,
          io: input.io,
          directory: input.directory,
          model: request.model,
          effort: request.effort,
          maxOutputTokens: request.maxOutputTokens,
          system: request.system,
          tools: request.tools,
          pending,
          persist: request.sessionID !== undefined,
          resume: entry.record?.claudeSessionID,
        })))
        entry.process = { session, pending, model: request.model, effort: request.effort, launch: launch(request) }
      }
      const process = entry.process
      yield* attempt(() => process.session.ready).pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError((error) => new Error(String(error))),
        Effect.onError(() => stop(entry).pipe(Effect.ignore)),
      )
      // Apply controls before sending input or releasing parked tool results.
      if (process.model !== request.model) {
        yield* attempt(() => process.session.setModel(request.model))
        process.model = request.model
      }
      if (process.effort !== request.effort) {
        yield* attempt(() => process.session.setEffort(request.effort))
        process.effort = request.effort
      }
      return process
    })

    const turn = Effect.fn("ClaudeSessions.turn")(function* (entry: Entry, request: Request, start: number, results?: ReturnType<typeof ToolResult.collect>) {
      const content = yield* attemptSync(() => request.sessionID || entry.record
        ? CatchUp.content(request.prompt, results?.end ?? start)
        : ConvertToClaudeMessage.content(request.prompt))
      // A rejected rebuild must not leave an empty process paired with the old durable record.
      const live = yield* open(entry, request)
      const process = live.session
      const userID = !results || content.length ? crypto.randomUUID() : undefined
      const reply: Array<LanguageModelV3TextPart | LanguageModelV3ToolCallPart> = []
      const toolMessages = new Map<string, string>()
      const seen = new Set<string>()
      let messageID: string | undefined
      let completed = false
      let parked = false
      const waiting: string[] = []
      const emit = (message: SDKMessage) => {
        if (message.type === "system" && message.subtype === "init" && request.tools.length
          && !message.mcp_servers.some((server) => server.name === "opencode" && server.status === "connected")) {
          throw new Error("The OpenCode tool server did not connect to Claude Code")
        }
        if (message.type === "assistant" && message.parent_tool_use_id === null && !message.error && !seen.has(message.uuid)) {
          seen.add(message.uuid)
          messageID = message.uuid
          for (const part of message.message.content) {
            if (part.type === "text") reply.push({ type: "text", text: part.text })
            if (part.type === "tool_use") {
              const name = ToolNames.original(part.name, request.tools)
              live.pending.expect(part.id, part.name)
              waiting.push(part.id)
              reply.push({ type: "tool-call", toolCallId: part.id, toolName: name, input: part.input })
            }
          }
        }
        if (message.type === "user" && message.uuid && Array.isArray(message.message.content)) {
          for (const part of message.message.content) if (part.type === "tool_result") toolMessages.set(part.tool_use_id, message.uuid)
        }
        request.emit(message)
      }
      yield* Effect.gen(function* () {
        if (results) {
          if (content.length) process.addUser(content, userID!)
          for (const id of live.waiting!) live.pending.resolve(id, results.results.get(id)!)
        } else process.begin(content, userID)
        parked = (yield* attempt(() => process.readStep(emit))) === "tools"
        completed = true
        live.waiting = parked ? waiting : undefined
      }).pipe(
        // A tool boundary releases only the OpenCode step. Actual cancellation still interrupts and drains the turn.
        Effect.ensuring(Effect.gen(function* () {
          if (parked) return
          yield* interrupt(entry).pipe(Effect.orDie)
        })),
        Effect.ensuring(Effect.gen(function* () {
          if (request.sessionID && process.persisted) {
            const history = completed ? Checkpoints.build({ prompt: request.prompt, previous: entry.record, userID, reply, messageID, toolMessages }) : undefined
            entry.record = { claudeSessionID: process.id, history }
            yield* records.set(request.sessionID, entry.record)
          }
        })),
      )
    })

    const release = Effect.fn("ClaudeSessions.release")(function* (entry: Entry, request: Request) {
      entry.active = undefined
      if (!request.sessionID) {
        yield* stop(entry).pipe(Effect.catch((error) => Effect.logWarning(error)))
        if (entry.record) yield* attempt(() => input.io.remove(entry.record!.claudeSessionID)).pipe(Effect.catch((error) => Effect.logWarning(error)))
        temporary.delete(entry)
        return
      }
      entry.idle = yield* Effect.sleep(input.options.idleTimeoutMs ?? IDLE_MS).pipe(
        Effect.andThen(entry.lock.withPermit(stop(entry))),
        Effect.catch((error) => Effect.logWarning(error)),
        Effect.forkDetach,
      )
    })

    const branch = Effect.fn("ClaudeSessions.branch")(function* (entry: Entry, request: Request, source?: SessionRecord.Record) {
      const boundary = SyncDecision.boundary(request.prompt, source)
      if (!source || !boundary) return 0
      // Reject unsupported input before creating a new transcript.
      yield* attemptSync(() => CatchUp.content(request.prompt, boundary.start))
      const fork = yield* attempt(() => input.io.fork(source.claudeSessionID, boundary.messageID))
      if (!fork) return 0
      entry.record = {
        claudeSessionID: fork.sessionID,
        history: boundary.history.map((checkpoint) => ({
          hash: checkpoint.hash,
          claudeMessageID: checkpoint.claudeMessageID ? fork.messages.get(checkpoint.claudeMessageID) : undefined,
        })),
      }
      return boundary.start
    }, Effect.uninterruptible)

    const snapshot = Effect.fn("ClaudeSessions.snapshot")(function* (entry: Entry, request: Request) {
      if (!request.sourceID) return 0
      const source = entries.get(request.sourceID)
      const copy = Effect.gen(function* () {
        // Compaction ends the old primary context. Generate only takes a read-only snapshot.
        if (request.compaction && source) yield* stop(source)
        return yield* branch(entry, request, source?.record ?? (yield* records.get(request.sourceID!)))
      })
      // Hold the source only while copying its settled prefix, never during side-call inference.
      return yield* (source ? source.lock.withPermit(copy) : copy)
    })

    // Decides where in the prompt this request starts, and whether it delivers results to a parked tool step.
    const prepare = Effect.fn("ClaudeSessions.prepare")(function* (entry: Entry, request: Request) {
      // Retire an exited or incompatible process before choosing how to deliver tool results.
      // open() must not replace a process after we have chosen to continue its parked turn.
      const process = entry.process
      if (process && (process.session.ended || process.launch !== launch(request))) yield* stop(entry)
      if (!request.sessionID) return { start: yield* snapshot(entry, request), results: undefined }
      entry.record ??= yield* records.get(request.sessionID)
      const decision = SyncDecision.decide(request.prompt, entry.record)
      let start = decision.start
      if (decision.kind === "fresh" || decision.kind === "changed") {
        yield* stop(entry)
        const previous = entry.record
        entry.record = undefined
        if (decision.kind === "changed") start = yield* branch(entry, request, previous)
        else if (!previous) start = yield* snapshot(entry, request)
      } else if (!entry.process && entry.record
        && !(yield* attempt(() => input.io.sessionExists(entry.record!.claudeSessionID)))) {
        entry.record = undefined
        start = 0
      }
      const live = entry.process
      if (!live?.session.running || !live.waiting) return { start, results: undefined }
      const results = yield* attemptSync(() => ToolResult.collect(request.prompt, start))
      const found = results.results
      if (!live.waiting.every((id) => found.has(id))) {
        yield* stop(entry)
        entry.record = undefined
        return { start: 0, results: undefined }
      }
      if (results.aborted) {
        // OpenCode ended this turn. Start a fresh user turn with the saved results as catch-up;
        // queueing input with addUser only steers a turn that is still running.
        yield* interrupt(entry)
        return { start, results: undefined }
      }
      return { start, results }
    })

    const run = Effect.fn("ClaudeSessions.run")(function* (request: Request) {
      let entry = request.sessionID ? entries.get(request.sessionID) : undefined
      if (!entry) {
        entry = { lock: Semaphore.makeUnsafe(1) }
        if (request.sessionID) entries.set(request.sessionID, entry)
        else temporary.add(entry)
      }
      const current = entry
      yield* current.lock.withPermit(Effect.gen(function* () {
        if (current.idle) {
          yield* Fiber.interrupt(current.idle)
          current.idle = undefined
        }
        current.active = yield* Effect.withFiber(Effect.succeed)
        const { start, results } = yield* prepare(current, request)
        yield* turn(current, request, start, results)
      }).pipe(Effect.ensuring(release(current, request))))
    })
    return { run } satisfies Interface
  })

  return { attach, close }
}
