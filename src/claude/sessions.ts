export * as ClaudeSessions from "./sessions.js"

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { LanguageModelV3Prompt, LanguageModelV3TextPart } from "@ai-sdk/provider"
import { Context, Effect, Fiber, Semaphore } from "effect"
import { ClaudeIO } from "./io.js"
import { ClaudeQueryOptions } from "./query-options.js"
import { ClaudeSession } from "./session.js"
import type { ClaudeCodeOptions } from "../options.js"
import { SessionRecord } from "../sync/record.js"
import { Fingerprint } from "../sync/fingerprint.js"
import { SyncDecision } from "../sync/decide.js"
import { CatchUp } from "../sync/catch-up.js"
import { ConvertToClaudeMessage } from "../language-model/convert-to-claude-message.js"

export const HANDOVER_MS = 10_000
export const IDLE_MS = 5 * 60_000

interface Request {
  // Only primary calls have one. Side calls run in a throwaway process.
  readonly sessionID?: string
  readonly model: string
  readonly system: NonNullable<Options["systemPrompt"]>
  readonly prompt: LanguageModelV3Prompt
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

  const stop = Effect.fn("ClaudeSessions.stop")(function* (entry: Entry) {
    if (!entry.process) return
    const process = entry.process
    yield* attempt(() => process.stop()).pipe(Effect.ensuring(Effect.sync(() => { entry.process = undefined })))
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

    // Reuses the entry's running process, or starts one. A new model or system prompt needs a new process,
    // which resumes the same Claude session.
    const open = Effect.fn("ClaudeSessions.open")(function* (entry: Entry, request: Request) {
      const system = JSON.stringify(request.system)
      if (entry.process?.ended || entry.model !== request.model || entry.system !== system) yield* stop(entry)
      if (!entry.process) {
        const executable = input.options.claudePath ?? input.io.which()
        if (!executable) return yield* Effect.fail(new Error("Install Claude Code and run `claude auth login` first"))
        entry.model = request.model
        entry.system = system
        entry.process = yield* Effect.try(() => ClaudeSession.start({
          ...ClaudeQueryOptions.base({ executable, io: input.io }),
          cwd: input.directory,
          model: request.model,
          systemPrompt: request.system,
          includePartialMessages: true,
          persistSession: request.sessionID !== undefined,
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

    const turn = Effect.fn("ClaudeSessions.turn")(function* (entry: Entry, request: Request, start: number) {
      const content = yield* Effect.try({
        try: () => request.sessionID ? CatchUp.content(request.prompt, start) : ConvertToClaudeMessage.utility(request.prompt),
        catch: (error) => error instanceof Error ? error : new Error(String(error)),
      })
      // A rejected rebuild must not leave an empty process paired with the old durable record.
      const process = yield* open(entry, request)
      const userID = crypto.randomUUID()
      const reply: LanguageModelV3TextPart[] = []
      const seen = new Set<string>()
      let messageID: string | undefined
      let completed = false
      const emit = (message: SDKMessage) => {
        if (message.type === "assistant" && message.parent_tool_use_id === null && !seen.has(message.uuid)) {
          seen.add(message.uuid)
          messageID = message.uuid
          for (const part of message.message.content) {
            if (part.type === "text") reply.push({ type: "text", text: part.text })
          }
        }
        if (message.type === "result") completed = true
        request.emit(message)
      }
      yield* attempt(() => process.send(content, emit, userID)).pipe(
        // Stream cancellation interrupts the producer, but its finalizer keeps reading until the result.
        Effect.ensuring(attempt(() => process.interrupt()).pipe(Effect.orDie)),
        Effect.ensuring(Effect.gen(function* () {
          if (request.sessionID && process.persisted) {
            const history: SessionRecord.Checkpoint[] = []
            if (completed) {
              const groups = Fingerprint.groups(request.prompt)
              for (let i = 0; i < groups.length; i++) {
                const group = groups[i]!
                const previous = entry.record?.history?.[i]
                let claudeMessageID: string | undefined
                if (previous?.hash === group.hash) claudeMessageID = previous.claudeMessageID
                if (i === groups.length - 1) claudeMessageID = userID
                history.push({ hash: group.hash, claudeMessageID })
              }
              if (reply.length > 0) {
                history.push({ hash: Fingerprint.groups([{ role: "assistant", content: reply }])[0]!.hash, claudeMessageID: messageID })
              }
            }
            entry.record = { claudeSessionID: process.id, history: completed ? history : undefined }
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
        let start = 0
        if (request.sessionID) {
          current.record ??= yield* records.get(request.sessionID)
          const decision = SyncDecision.decide(request.prompt, current.record)
          start = decision.start
          if (decision.kind === "fresh" || decision.kind === "changed") {
            yield* stop(current)
            current.record = undefined
          } else if ((!current.process || current.process.ended) && current.record
            && !(yield* attempt(() => input.io.sessionExists(current.record!.claudeSessionID)))) {
            yield* stop(current)
            current.record = undefined
            start = 0
          }
        }
        yield* turn(current, request, start)
      }).pipe(Effect.ensuring(release(current, request))))
    })
    return { run } satisfies Interface
  })

  return { attach, close }
}
