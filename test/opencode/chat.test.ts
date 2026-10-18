import { describe, expect } from "bun:test"
import { Location, Model } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { ClaudeSessions } from "../../src/claude/sessions.js"
import { ClaudeProvider } from "../../src/plugin/provider.js"
import { it } from "../lib/effect.js"
import { FakeClaude } from "../lib/fake-claude.js"
import { FakeIO } from "../lib/fake-io.js"
import { TestOpenCode } from "../lib/opencode.js"
import { Recorder } from "../lib/recorder.js"

describe("embedded text chat", () => {
  const canceled = Recorder.result("text-cancel")
  if (canceled.subtype === "success") throw new Error("Expected an error recording")
  const limit = { ...Recorder.result("branch-error", 2), subtype: "success", api_error_status: 429, result: "Usage limit reached." }
  const rate = { type: "rate_limit_event", uuid: crypto.randomUUID(), session_id: crypto.randomUUID(),
    rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1792800000 } }
  const empty = { ...Recorder.result("text"), subtype: "success", is_error: false, result: "", api_error_status: 529 }
  for (const fixture of [
    { name: "cancellation", replies: [canceled], message: canceled.errors.join("\n") },
    { name: "subscription exhaustion", replies: [rate, limit], message: new Date(rate.rate_limit_info.resetsAt * 1000).toISOString() },
    { name: "empty overloaded success", replies: [empty], message: "Anthropic is overloaded (529)" },
  ]) it.live(`reports ${fixture.name} once instead of retrying the turn`, () => Effect.gen(function* () {
    // Fault-inject documented terminal fields: do not exhaust a real subscription to test its UI path.
    const failed = { ...FakeClaude.expectTurn(), replies: fixture.replies }
    const claude = FakeClaude.make([FakeClaude.expectStartup(), failed, FakeClaude.expectInterrupt()], { probes: true })
    const registry = ClaudeSessions.registry()
    yield* Effect.addFinalizer(() => registry.close())
    const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), registry })
    yield* TestOpenCode.connect(test.opencode)
    const session = yield* test.opencode.session.create({
      title: "Failure test", location: { directory: Location.PublicRef.fields.directory.make(test.directory) },
      model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }),
    })
    yield* test.opencode.session.prompt({ sessionID: session.id, text: "A request that fails" })
    yield* test.opencode.session.wait({ sessionID: session.id })
    const history = yield* test.opencode.session.export({ sessionID: session.id })
    const assistant = history.messages.find((message) => message.type === "assistant")
    expect(assistant?.finish).toBe("error")
    expect(assistant?.error?.message).toContain(fixture.message)
    const calls = claude.runs.filter((run) => run.args.includes("--include-partial-messages"))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.received.filter((message) => message.type === "user")).toHaveLength(1)
    yield* registry.close()
    claude.check()
  }), 5_000)

  it.live("shares a primary process, stores text/usage, and resumes after an OpenCode restart", () => Effect.gen(function* () {
    const directory = yield* TestOpenCode.tempDirectory
    const database = `${directory}/opencode.db`
    const claude = FakeClaude.make([
      FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectTurn({ index: 1 }), FakeClaude.expectInterrupt(),
      FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "text-resume" }), FakeClaude.expectInterrupt(),
    ], { probes: true })
    // Each opencode process has its own registry. Closing it stands in for the old process exiting,
    // instead of waiting out the reload handover.
    const before = ClaudeSessions.registry()
    const sessionID = yield* Effect.gen(function* () {
      const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), directory, database, registry: before })
      yield* TestOpenCode.connect(test.opencode)
      const session = yield* test.opencode.session.create({
        title: "Text test", location: { directory: Location.PublicRef.fields.directory.make(test.directory) },
        model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }),
      })
      yield* test.opencode.session.prompt({ sessionID: session.id, text: "Remember the marker COPPER-OTTER. Reply only with that marker." })
      yield* test.opencode.session.wait({ sessionID: session.id })
      yield* test.opencode.session.prompt({ sessionID: session.id, text: "What was the marker? Reply only with it." })
      yield* test.opencode.session.wait({ sessionID: session.id })
      const history = yield* test.opencode.session.export({ sessionID: session.id })
      const assistants = history.messages.filter((message) => message.type === "assistant")
      expect(assistants).toHaveLength(2)
      for (let i = 0; i < assistants.length; i++) {
        const message = assistants[i]!
        expect(message.content).toContainEqual(expect.objectContaining({ type: "text", text: "COPPER-OTTER" }))
        expect(message.tokens?.output).toBe(Recorder.result("text", i).usage.output_tokens)
      }
      const calls = claude.runs.filter((run) => run.args.includes("--include-partial-messages"))
      expect(calls).toHaveLength(1)
      expect(calls[0]!.received.filter((message) => message.type === "user")).toHaveLength(2)
      return session.id
    }).pipe(Effect.scoped)
    yield* before.close()
    const original = claude.runs.find((run) => run.args.includes("--include-partial-messages"))!
    yield* Effect.promise(() => original.closed)
    const id = original.args.find((arg) => arg.startsWith("--session-id="))!.split("=")[1]

    const after = ClaudeSessions.registry()
    const resumed = yield* Effect.gen(function* () {
      const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), directory, database, registry: after })
      yield* test.opencode.session.prompt({ sessionID, text: "What marker did I give you earlier? Reply only with it." })
      yield* test.opencode.session.wait({ sessionID })
      const history = yield* test.opencode.session.export({ sessionID })
      const assistants = history.messages.filter((message) => message.type === "assistant")
      expect(assistants).toHaveLength(3)
      expect(assistants[0]!.content).toContainEqual(expect.objectContaining({
        type: "text", state: { sessionID: id, messageID: "f4abc1c4-72af-43cc-9dc4-d9707f87aa5a" },
      }))
      expect(assistants.at(-1)!.content).toContainEqual(expect.objectContaining({ type: "text", text: "COPPER-OTTER" }))
      const run = claude.runs.filter((run) => run.args.includes("--include-partial-messages")).at(-1)!
      expect(run.args).toContain(`--resume=${id}`)
      return run
    }).pipe(Effect.scoped)
    yield* after.close()
    yield* Effect.promise(() => resumed.closed)
    claude.check()
  }), 15_000)
})
