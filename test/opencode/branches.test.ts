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

describe("native OpenCode branching", () => {
  it.live(
    "native compaction keeps the Claude preset and resumes from only OpenCode's summary",
    () =>
      Effect.gen(function* () {
        const claude = FakeClaude.make(
          [
            FakeClaude.expectStartup(),
            FakeClaude.expectTurn({ recording: "branch-compaction", index: 0 }),
            FakeClaude.expectTurn({ recording: "branch-compaction", index: 1 }),
            FakeClaude.expectInterrupt(),
            FakeClaude.expectStartup(),
            FakeClaude.expectTurn({ recording: "branch-compaction", index: 2 }),
            FakeClaude.expectInterrupt(),
            FakeClaude.expectStartup(),
            FakeClaude.expectTurn({ recording: "branch-compaction", index: 3 }),
            FakeClaude.expectInterrupt(),
          ],
          { probes: true },
        )
        const registry = ClaudeSessions.registry()
        yield* Effect.addFinalizer(() => registry.close())
        const fixture = define({
          id: "compaction-fixture",
          effect: Effect.fn(function* (ctx) {
            yield* ctx.session.hook("context", (event) =>
              Effect.sync(() => {
                event.tools = {}
              }),
            )
          }),
        })
        const test = yield* TestOpenCode.start({
          io: FakeIO.make({ claude }),
          registry,
          plugins: [fixture],
          config: { compaction: { keep: { tokens: 0 } } },
        })
        yield* TestOpenCode.connect(test.opencode)
        const session = yield* test.opencode.session.create({
          title: "Compaction fixture",
          location: { directory: Location.PublicRef.fields.directory.make(test.directory) },
          model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }),
        })
        for (const marker of ["ROOT-OTTER", "FUTURE-IBIS"]) {
          yield* test.opencode.session.prompt({
            sessionID: session.id,
            text: `Remember ${marker}. Reply only ${marker}.`,
          })
          yield* test.opencode.session.wait({ sessionID: session.id })
        }
        yield* test.opencode.session.compact({ sessionID: session.id })
        yield* test.opencode.session.wait({ sessionID: session.id })
        const history = yield* test.opencode.session.export({ sessionID: session.id })
        expect(history.messages.findLast((message) => message.type === "compaction")).toMatchObject({
          status: "completed",
        })
        expect(claude.forks).toHaveLength(1)
        expect(claude.removed).toEqual([claude.forks[0]!.sessionID])
        const runs = claude.runs.filter((run) => run.args.includes("--include-partial-messages"))
        const init = runs[1]!.received.find((message) => message.request?.subtype === "initialize").request
        expect(init.systemPrompt).toBeUndefined()
        expect(init.appendSystemPrompt).toContain("You are running in OpenCode through the Claude Code harness")
        expect(init.systemPromptSnapshot).toBe(false)
        const task = runs[1]!.received.find((message) => message.type === "user")
        expect(JSON.stringify(task.message.content)).toContain("You MUST summarize the conversation above")
        yield* test.opencode.session.prompt({
          sessionID: session.id,
          text: "List all marker words you remember. Only the markers.",
        })
        yield* test.opencode.session.wait({ sessionID: session.id })
        const resumed = claude.runs.filter((run) => run.args.includes("--include-partial-messages")).at(-1)!
        expect(resumed.args.some((arg) => arg.startsWith("--resume="))).toBe(false)
        const user = resumed.received.find((message) => message.type === "user")
        expect(JSON.stringify(user.message.content)).toContain("<summary>")
        expect(JSON.stringify(user.message.content)).toContain("ROOT-OTTER")
        expect(JSON.stringify(user.message.content)).toContain("FUTURE-IBIS")
        yield* registry.close()
        claude.check()
      }),
    15_000,
  )

  it.live(
    "uses native fork lineage and undo boundaries while preserving the source session",
    () =>
      Effect.gen(function* () {
        const claude = FakeClaude.make(
          [
            FakeClaude.expectStartup(),
            FakeClaude.expectTurn({ recording: "branches", index: 0 }),
            FakeClaude.expectTurn({ recording: "branches", index: 1 }),
            FakeClaude.expectStartup(),
            FakeClaude.expectTurn({ recording: "branches", index: 2 }),
            FakeClaude.expectInterrupt(),
            FakeClaude.expectStartup(),
            FakeClaude.expectTurn({ recording: "branches", index: 3 }),
            FakeClaude.expectInterrupt(),
            FakeClaude.expectInterrupt(),
          ],
          { probes: true },
        )
        const registry = ClaudeSessions.registry()
        yield* Effect.addFinalizer(() => registry.close())
        const fixture = define({
          id: "branch-fixture",
          effect: Effect.fn(function* (ctx) {
            yield* ctx.session.hook("context", (event) =>
              Effect.sync(() => {
                event.tools = {}
              }),
            )
          }),
        })
        const test = yield* TestOpenCode.start({
          io: FakeIO.make({ claude }),
          registry,
          plugins: [fixture],
        })
        yield* TestOpenCode.connect(test.opencode)
        const parent = yield* test.opencode.session.create({
          title: "Branch fixture",
          location: { directory: Location.PublicRef.fields.directory.make(test.directory) },
          model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }),
        })
        const ask = Effect.fn(function* (sessionID: typeof parent.id, text: string) {
          yield* test.opencode.session.prompt({ sessionID, text })
          yield* test.opencode.session.wait({ sessionID })
        })
        yield* ask(parent.id, "Remember ROOT-OTTER. Reply only ROOT-OTTER.")
        yield* ask(parent.id, "Remember FUTURE-IBIS too. Reply only FUTURE-IBIS.")
        const original = yield* test.opencode.session.export({ sessionID: parent.id })
        const second = original.messages.filter((message) => message.type === "user")[1]!
        const child = yield* test.opencode.session.fork({ sessionID: parent.id, before: second.id })
        yield* ask(child.id, "Remember CHILD-HERON. Reply only CHILD-HERON.")
        expect(claude.forks).toHaveLength(1)
        const fork = claude.forks[0]!
        const copied = claude.transcripts.get(fork.sessionID)!
        expect(JSON.stringify(copied)).not.toContain("FUTURE-IBIS")
        const childBefore = yield* test.opencode.session.export({ sessionID: child.id })
        const lastUser = childBefore.messages.filter((message) => message.type === "user").at(-1)!
        yield* test.opencode.session.revert.stage({ sessionID: child.id, messageID: lastUser.id, files: false })
        yield* test.opencode.session.revert.commit({ sessionID: child.id })
        yield* ask(child.id, "List all marker words you remember from this conversation. Only the markers.")
        expect(claude.forks).toHaveLength(2)
        expect(claude.forks[1]!.source).toBe(fork.sessionID)
        expect(claude.forks[1]!.boundary).not.toBe(fork.boundary)
        expect(JSON.stringify(claude.transcripts.get(claude.forks[1]!.sessionID))).not.toMatch(
          /FUTURE-IBIS|CHILD-HERON/,
        )
        expect((yield* test.opencode.session.export({ sessionID: parent.id })).messages).toEqual(original.messages)
        expect(claude.removed).toHaveLength(0)
        yield* registry.close()
        claude.check()
      }),
    15_000,
  )
})
