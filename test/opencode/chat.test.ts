import { describe, expect } from "bun:test"
import { Location, Model } from "@opencode/plugin/effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { ClaudeSessions } from "../../src/claude/sessions.js"
import { ClaudeProvider } from "../../src/plugin/provider.js"
import { it } from "../lib/effect.js"
import { FakeClaude } from "../lib/fake-claude.js"
import { FakeIO } from "../lib/fake-io.js"
import { TestOpenCode } from "../lib/opencode.js"
import { Recorder } from "../lib/recorder.js"

describe("embedded text chat", () => {
  const overloaded = {
    ...Recorder.result("text"),
    subtype: "success",
    is_error: false,
    result: "",
    api_error_status: 529,
  }
  it.live(
    "reports an overloaded API once instead of retrying the turn",
    () =>
      Effect.gen(function* () {
        // Fault-inject documented terminal fields: do not exhaust a real subscription to test its UI path.
        const failed = { ...FakeClaude.expectTurn(), replies: [overloaded] }
        const claude = FakeClaude.make([FakeClaude.expectStartup(), failed, FakeClaude.expectInterrupt()], {
          probes: true,
        })
        const registry = ClaudeSessions.registry()
        yield* Effect.addFinalizer(() => registry.close())
        const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), registry })
        yield* TestOpenCode.connect(test.opencode)
        const session = yield* test.opencode.session.create({
          title: "Failure test",
          location: { directory: Location.PublicRef.fields.directory.make(test.directory) },
          model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }),
        })
        yield* test.opencode.session.prompt({ sessionID: session.id, text: "A request that fails" })
        yield* test.opencode.session.wait({ sessionID: session.id })
        const history = yield* test.opencode.session.export({ sessionID: session.id })
        const assistant = history.messages.find((message) => message.type === "assistant")
        expect(assistant?.finish).toBe("error")
        expect(assistant?.error?.message).toContain("Anthropic is overloaded (529)")
        const calls = claude.runs.filter((run) => run.args.includes("--include-partial-messages"))
        expect(calls).toHaveLength(1)
        expect(calls[0]!.received.filter((message) => message.type === "user")).toHaveLength(1)
        yield* registry.close()
        claude.check()
      }),
    5_000,
  )

  it.live(
    "shares a primary process, stores text/usage, and resumes after an OpenCode restart",
    () =>
      Effect.gen(function* () {
        const directory = yield* TestOpenCode.tempDirectory
        const database = `${directory}/opencode.db`
        const claude = FakeClaude.make(
          [
            FakeClaude.expectStartup(),
            FakeClaude.expectTurn(),
            FakeClaude.expectTurn({ index: 1 }),
            FakeClaude.expectInterrupt(),
            FakeClaude.expectStartup(),
            FakeClaude.expectTurn({ recording: "text-resume" }),
            FakeClaude.expectInterrupt(),
          ],
          { probes: true },
        )
        // Each opencode process has its own registry. Closing it stands in for the old process exiting,
        // instead of waiting out the reload handover.
        const before = ClaudeSessions.registry()
        const sessionID = yield* Effect.gen(function* () {
          const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), directory, database, registry: before })
          yield* TestOpenCode.connect(test.opencode)
          const session = yield* test.opencode.session.create({
            title: "Text test",
            location: { directory: Location.PublicRef.fields.directory.make(test.directory) },
            model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }),
          })
          yield* test.opencode.session.prompt({
            sessionID: session.id,
            text: "Remember the marker COPPER-OTTER. Reply only with that marker.",
          })
          yield* test.opencode.session.wait({ sessionID: session.id })
          yield* test.opencode.session.prompt({
            sessionID: session.id,
            text: "What was the marker? Reply only with it.",
          })
          yield* test.opencode.session.wait({ sessionID: session.id })
          const history = yield* test.opencode.session.export({ sessionID: session.id })
          const assistants = history.messages.filter((message) => message.type === "assistant")
          expect(assistants).toHaveLength(2)
          assistants.forEach((message, i) => {
            expect(message.content).toContainEqual(expect.objectContaining({ type: "text", text: "COPPER-OTTER" }))
            expect(message.tokens?.output).toBe(Recorder.result("text", i).usage.output_tokens)
          })
          const calls = claude.runs.filter((run) => run.args.includes("--include-partial-messages"))
          expect(calls).toHaveLength(1)
          expect(calls[0]!.received.filter((message) => message.type === "user")).toHaveLength(2)
          expect(calls[0]!.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined()
          expect(calls[0]!.env.DISABLE_AUTO_COMPACT).toBe("1")
          return session.id
        }).pipe(Effect.scoped)
        yield* before.close()
        const original = claude.runs.find((run) => run.args.includes("--include-partial-messages"))!
        yield* Effect.promise(() => original.closed)
        const id = original.args.find((arg) => arg.startsWith("--session-id="))!.split("=")[1]

        const after = ClaudeSessions.registry()
        const resumed = yield* Effect.gen(function* () {
          const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), directory, database, registry: after })
          yield* test.opencode.session.prompt({
            sessionID,
            text: "What marker did I give you earlier? Reply only with it.",
          })
          yield* test.opencode.session.wait({ sessionID })
          const history = yield* test.opencode.session.export({ sessionID })
          const assistants = history.messages.filter((message) => message.type === "assistant")
          expect(assistants).toHaveLength(3)
          expect(assistants[0]!.content).toContainEqual(
            expect.objectContaining({
              type: "text",
              state: { sessionID: id, messageID: "f4abc1c4-72af-43cc-9dc4-d9707f87aa5a" },
            }),
          )
          expect(assistants.at(-1)!.content).toContainEqual(
            expect.objectContaining({ type: "text", text: "COPPER-OTTER" }),
          )
          const run = claude.runs.filter((run) => run.args.includes("--include-partial-messages")).at(-1)!
          expect(run.args).toContain(`--resume=${id}`)
          return run
        }).pipe(Effect.scoped)
        yield* after.close()
        yield* Effect.promise(() => resumed.closed)
        claude.check()
      }),
    15_000,
  )

  for (const cap of [undefined, 4096])
    it.live(`preserves ${cap === undefined ? "inherited output defaults" : "explicit output overrides"}`, () =>
      Effect.gen(function* () {
        const claude = FakeClaude.make(
          [FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt()],
          { probes: true },
        )
        const registry = ClaudeSessions.registry()
        yield* Effect.addFinalizer(() => registry.close())
        const override = define({
          id: "output-limit",
          effect: Effect.fn(function* (ctx) {
            yield* ctx.session.hook("context", (event) =>
              Effect.sync(() => {
                if (cap !== undefined) event.options.maxTokens = cap
              }),
            )
          }),
        })
        const test = yield* TestOpenCode.start({
          io: FakeIO.make({ claude, env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192" } }),
          registry,
          plugins: [override],
        })
        yield* TestOpenCode.connect(test.opencode)
        const session = yield* test.opencode.session.create({
          title: "Output budget",
          location: { directory: Location.PublicRef.fields.directory.make(test.directory) },
          model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }),
        })
        yield* test.opencode.session.prompt({ sessionID: session.id, text: "Reply with the marker" })
        yield* test.opencode.session.wait({ sessionID: session.id })
        const calls = claude.runs.filter((run) => run.args.includes("--include-partial-messages"))
        expect(calls).toHaveLength(1)
        expect(calls[0]!.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(String(cap ?? 8192))
        yield* registry.close()
        claude.check()
      }),
    )
})
