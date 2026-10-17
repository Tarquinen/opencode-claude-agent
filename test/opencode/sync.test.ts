import { describe, expect } from "bun:test"
import { Location, Model } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { ClaudeSessions } from "../../src/claude/sessions.js"
import { ClaudeProvider } from "../../src/plugin/provider.js"
import { it } from "../lib/effect.js"
import { FakeClaude } from "../lib/fake-claude.js"
import { FakeIO } from "../lib/fake-io.js"
import { TestOpenCode } from "../lib/opencode.js"
import { TestPlugin } from "../lib/test-plugin.js"

const model = Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") })

describe("embedded history sync", () => {
  it.live("switches both ways, catches up tool history, then sends only the newest user message", () => Effect.gen(function* () {
    const normal = TestPlugin.make({ replies: [
      [{ type: "tool-call", toolCallId: "marker-call", toolName: "marker", input: "{}" }],
      TestPlugin.text("The tool returned LEMON-IBIS. My marker is LILAC-HERON."),
      TestPlugin.text("I can see Claude's later reply."),
    ] })
    const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectTurn({ index: 1 }), FakeClaude.expectTurn({ index: 1 }), FakeClaude.expectInterrupt()], { probes: true })
    const registry = ClaudeSessions.registry()
    yield* Effect.addFinalizer(() => registry.close())
    const { opencode, directory } = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), registry, plugins: [normal.plugin] })
    yield* TestOpenCode.connect(opencode)
    const session = yield* opencode.session.create({ title: "Switch test", location: { directory: Location.PublicRef.fields.directory.make(directory) }, model })
    const prompt = Effect.fn(function* (text: string) {
      yield* opencode.session.prompt({ sessionID: session.id, text })
      yield* opencode.session.wait({ sessionID: session.id })
    })
    yield* prompt("Remember COPPER-OTTER. Reply only with it.")
    yield* opencode.session.switchModel({ sessionID: session.id, model: TestPlugin.model })
    yield* prompt("Read the marker tool.")
    expect(normal.toolCalls).toBe(1)
    expect(JSON.stringify(normal.requests[0]!.prompt)).toContain("COPPER-OTTER")
    yield* opencode.session.switchModel({ sessionID: session.id, model })
    yield* prompt("What happened while you were away?")
    yield* prompt("Continue normally.")
    const runs = claude.runs.filter((run) => run.args.includes("--include-partial-messages"))
    expect(runs).toHaveLength(1)
    const users = runs[0]!.received.filter((message) => message.type === "user")
    const catchup = JSON.stringify(users[1].message.content)
    expect(catchup).toContain("<conversation-checkpoint>")
    expect(catchup).toContain("LEMON-IBIS")
    expect(catchup).toContain("LILAC-HERON")
    expect(catchup).toContain("marker-call")
    expect(catchup).not.toContain("COPPER-OTTER")
    expect(users[2].message.content).toEqual([{ type: "text", text: "Continue normally." }])
    const history = yield* opencode.session.export({ sessionID: session.id })
    const assistant = history.messages.find((message) => message.type === "assistant")
    const text = assistant?.content.find((part) => part.type === "text")
    const sessionID = runs[0]!.args.find((arg) => arg.startsWith("--session-id="))!.split("=")[1]
    expect(text).toMatchObject({ state: { sessionID, messageID: "f4abc1c4-72af-43cc-9dc4-d9707f87aa5a" } })
    yield* opencode.session.switchModel({ sessionID: session.id, model: TestPlugin.model })
    yield* prompt("Confirm that you see Claude's reply.")
    expect(JSON.stringify(normal.requests.at(-1)!.prompt)).toContain("Continue normally.")
    normal.check()
    yield* registry.close()
    claude.check()
  }), 15_000)

  it.live("uses a fresh session when a context hook edits an earlier reply", () => Effect.gen(function* () {
    let edit = false
    const normal = TestPlugin.make({ replies: [], context(event) {
      if (!edit) return
      event.messages = event.messages.map((message) => message.role !== "assistant" ? message : {
        ...message, content: message.content.map((part) => part.type !== "text" ? part : { ...part, text: "REVISED-MARKER" }),
      })
    } })
    const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt(), FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt()], { probes: true })
    const registry = ClaudeSessions.registry()
    yield* Effect.addFinalizer(() => registry.close())
    const { opencode, directory } = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), registry, plugins: [normal.plugin] })
    yield* TestOpenCode.connect(opencode)
    const session = yield* opencode.session.create({ title: "Edit test", location: { directory: Location.PublicRef.fields.directory.make(directory) }, model })
    yield* opencode.session.prompt({ sessionID: session.id, text: "First turn" })
    yield* opencode.session.wait({ sessionID: session.id })
    edit = true
    yield* opencode.session.prompt({ sessionID: session.id, text: "Use the revised history" })
    yield* opencode.session.wait({ sessionID: session.id })
    const runs = claude.runs.filter((run) => run.args.includes("--include-partial-messages"))
    expect(runs).toHaveLength(2)
    expect(runs[1]!.args.some((arg) => arg.startsWith("--resume="))).toBe(false)
    const user = runs[1]!.received.find((message) => message.type === "user")
    expect(JSON.stringify(user.message.content)).toContain("REVISED-MARKER")
    expect(JSON.stringify(user.message.content)).not.toContain("COPPER-OTTER")
    yield* registry.close()
    claude.check()
  }), 15_000)
})
