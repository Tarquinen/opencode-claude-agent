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
import { ToolServer } from "../tools/server.js"
import { ToolHooks } from "../tools/hooks.js"
import { ToolNames } from "../tools/names.js"
import { ToolResult } from "../tools/result.js"

export const HANDOVER_MS = 10_000
export const IDLE_MS = 5 * 60_000

interface Request {
  // Only primary calls have one. Side calls run in a throwaway process.
  readonly sessionID?: string
  readonly model: string
  readonly system: NonNullable<Options["systemPrompt"]>
  readonly prompt: LanguageModelV3Prompt
  readonly tools?: readonly LanguageModelV3FunctionTool[]
  readonly emit: (message: SDKMessage) => void
}

interface Entry {
  readonly lock: Semaphore.Semaphore
  process?: ClaudeSession.Interface
  record?: SessionRecord.Record
  model?: string
  system?: string
  idle?: Fiber.Fiber<void, never>
  active?: Fiber.Fiber<unknown, unknown>
  pending?: PendingTools.Interface
  waiting?: string[]
  tools?: string
}

export interface Interface {
  readonly run: (request: Request) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("claude-code/Sessions") {}

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({
  try: run,
  catch: (error) => error instanceof Error ? error : new Error(String(error)),
})

// Created once by the plugin factory, outside setup's Scope. Reloading setup can adopt the same processes.
// Tests create their own registry, rather than sharing module/global state.
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
    yield* attempt(() => process.interrupt())
    // Resolving handlers before interrupt-and-drain could start another model request.
    entry.pending?.clear()
    entry.waiting = undefined
  }, Effect.uninterruptible)

  const stop = Effect.fn("ClaudeSessions.stop")(function* (entry: Entry) {
    if (!entry.process) return
    const process = entry.process
    yield* attempt(() => process.stop()).pipe(Effect.ensuring(Effect.sync(() => {
      entry.pending?.clear()
      entry.process = undefined
      entry.pending = undefined
      entry.waiting = undefined
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

  const close = Effect.fn("ClaudeSessions.close")(function* () {
    if (handover) {
      yield* Fiber.interrupt(handover)
      handover = undefined
    }
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
    if (handover) {
      yield* Fiber.interrupt(handover)
      handover = undefined
    }
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      owners--
      if (owners !== 0 || (entries.size === 0 && temporary.size === 0)) return
      handover = yield* Effect.sleep(HANDOVER_MS).pipe(Effect.andThen(closeEntries()), Effect.forkDetach)
    }))

    // run() decides whether the old process can be reused before collecting pending tool results.
    const open = Effect.fn("ClaudeSessions.open")(function* (entry: Entry, request: Request) {
      const system = JSON.stringify(request.system)
      const tools = request.tools ?? []
      const key = JSON.stringify(tools)
      if (!entry.process) {
        const executable = input.options.claudePath ?? input.io.which()
        if (!executable) return yield* Effect.fail(new Error("Install Claude Code and run `claude auth login` first"))
        entry.model = request.model
        entry.system = system
        const pending = PendingTools.make()
        entry.pending = pending
        entry.tools = key
        entry.process = yield* Effect.try(() => ClaudeSession.start({
          ...ClaudeQueryOptions.base({ executable, io: input.io }),
          cwd: input.directory,
          model: request.model,
          systemPrompt: request.system,
          includePartialMessages: true,
          persistSession: request.sessionID !== undefined,
          hooks: ToolHooks.make(pending),
          mcpServers: tools.length ? { opencode: ToolServer.make(tools, pending) } : {},
          ...(entry.record ? { resume: entry.record.claudeSessionID } : { sessionId: crypto.randomUUID() }),
        }))
      }
      const process = entry.process
      yield* attempt(() => process.ready).pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError((error) => new Error(String(error))),
        Effect.onError(() => stop(entry).pipe(Effect.ignore)),
      )
      return process
    })

    const turn = Effect.fn("ClaudeSessions.turn")(function* (entry: Entry, request: Request, start: number, results?: ReturnType<typeof ToolResult.collect>) {
      const content = yield* Effect.try({
        try: () => request.sessionID ? CatchUp.content(request.prompt, results?.end ?? start) : ConvertToClaudeMessage.content(request.prompt),
        catch: (error) => error instanceof Error ? error : new Error(String(error)),
      })
      // A rejected rebuild must not leave an empty process paired with the old durable record.
      const process = yield* open(entry, request)
      const userID = !results || content.length ? crypto.randomUUID() : undefined
      const reply: Array<LanguageModelV3TextPart | LanguageModelV3ToolCallPart> = []
      const toolMessages = new Map<string, string>()
      const seen = new Set<string>()
      let messageID: string | undefined
      let completed = false
      let parked = false
      const waiting: string[] = []
      const emit = (message: SDKMessage) => {
        if (message.type === "system" && message.subtype === "init" && request.tools?.length
          && !message.mcp_servers.some((server) => server.name === "opencode" && server.status === "connected")) {
          throw new Error("The OpenCode tool server did not connect to Claude Code")
        }
        if (message.type === "assistant" && message.parent_tool_use_id === null && !seen.has(message.uuid)) {
          seen.add(message.uuid)
          messageID = message.uuid
          for (const part of message.message.content) {
            if (part.type === "text") reply.push({ type: "text", text: part.text })
            if (part.type === "tool_use") {
              const name = ToolNames.original(part.name, request.tools ?? [])
              entry.pending!.expect(part.id, part.name)
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
          for (const id of entry.waiting!) entry.pending!.resolve(id, results.results.get(id)!)
        } else process.begin(content, userID)
        parked = (yield* attempt(() => process.readStep(emit))) === "tools"
        completed = true
        entry.waiting = parked ? waiting : undefined
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

    // Side calls stop their process right away. Primary sessions keep it until the idle timeout.
    const release = Effect.fn("ClaudeSessions.release")(function* (entry: Entry, request: Request) {
      entry.active = undefined
      if (!request.sessionID) {
        yield* stop(entry).pipe(Effect.catch((error) => Effect.logWarning(error)))
        temporary.delete(entry)
        return
      }
      entry.idle = yield* Effect.sleep(input.options.idleTimeoutMs ?? IDLE_MS).pipe(
        Effect.andThen(entry.lock.withPermit(stop(entry))),
        Effect.catch((error) => Effect.logWarning(error)),
        Effect.forkDetach,
      )
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
        // Retire an exited or incompatible process before choosing how to deliver tool results.
        // open() must not replace a process after we have chosen to continue its parked turn.
        if (current.process?.ended || current.model !== request.model
          || current.system !== JSON.stringify(request.system) || current.tools !== JSON.stringify(request.tools ?? [])) yield* stop(current)
        let start = 0
        let results: ReturnType<typeof ToolResult.collect> | undefined
        if (request.sessionID) {
          current.record ??= yield* records.get(request.sessionID)
          const decision = SyncDecision.decide(request.prompt, current.record)
          start = decision.start
          if (decision.kind === "fresh" || decision.kind === "changed") {
            yield* stop(current)
            current.record = undefined
          } else if (!current.process && current.record
            && !(yield* attempt(() => input.io.sessionExists(current.record!.claudeSessionID)))) {
            yield* stop(current)
            current.record = undefined
            start = 0
          }
          if (current.process?.running && current.waiting) {
            results = yield* Effect.try(() => ToolResult.collect(request.prompt, start))
            const found = results.results
            if (!current.waiting.every((id) => found.has(id))) {
              yield* stop(current)
              current.record = undefined
              results = undefined
              start = 0
            } else if (results.aborted) {
              // OpenCode ended this turn. Start the next one normally, with its saved results as catch-up.
              // Active-turn steering still uses the SDK queue; it is not a substitute for a fresh user turn.
              yield* interrupt(current)
              results = undefined
            }
          }
        }
        yield* turn(current, request, start, results)
      }).pipe(Effect.ensuring(release(current, request))))
    })
    return { run } satisfies Interface
  })

  return { attach, close }
}
