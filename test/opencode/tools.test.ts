import { describe, expect } from "bun:test"
import { Location, Model } from "@opencode/plugin/effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Deferred, Effect } from "effect"
import { ClaudeSessions } from "../../src/claude/sessions.js"
import { ClaudeProvider } from "../../src/plugin/provider.js"
import { it } from "../lib/effect.js"
import { FakeClaude } from "../lib/fake-claude.js"
import { FakeIO } from "../lib/fake-io.js"
import { TestOpenCode } from "../lib/opencode.js"
import { TestTools } from "../lib/tools.js"
import { Recorder } from "../lib/recorder.js"
import { TestPlugin } from "../lib/test-plugin.js"

describe("embedded OpenCode tools", () => {
  it.live("Code Mode preserves multiline namespace descriptions and the following tools", () => Effect.gen(function* () {
    const description = "Customer account tools.\nUse the account ID returned by search for subsequent calls."
    const plugin = define({ id: "catalog-test", effect: Effect.fn(function* (ctx) {
      yield* ctx.session.hook("title", (event) => Effect.sync(() => { event.result = "Catalog test" }))
      yield* ctx.tool.transform((editor) => {
        editor.namespace({ name: "accounts", description })
        editor.add({ name: "search", description: "Find an account.", input: { type: "object", properties: {} },
          options: { namespace: "accounts", codemode: true }, execute: () => Effect.succeed({ content: "fixture" }),
        })
      })
    }) })
    const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt()], { probes: true })
    const registry = ClaudeSessions.registry()
    yield* Effect.addFinalizer(() => registry.close())
    const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), registry, plugins: [plugin] })
    yield* TestOpenCode.connect(test.opencode)
    const session = yield* test.opencode.session.create({ title: "Catalog test", location: { directory: Location.PublicRef.fields.directory.make(test.directory) },
      model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }) })
    yield* test.opencode.session.prompt({ sessionID: session.id, text: "Reply only with COPPER-OTTER." })
    yield* test.opencode.session.wait({ sessionID: session.id })
    const run = claude.runs.find((run) => run.args.includes("--include-partial-messages"))!
    const system = run.received.find((message) => message.request?.subtype === "initialize").request.appendSystemPrompt
    expect(system).toContain(description)
    expect(system).toContain("tools.accounts.search")
    expect(system).toContain("tools.opencode.session_rename")
    yield* registry.close()
    claude.check()
  }), 15_000)

  it.live("switching models while tools run lets Claude catch up when selected again", () => Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const normal = TestPlugin.make({ replies: [TestPlugin.text("NORMAL-IBIS")] })
    const plugin = define({ id: "switching-tools", effect: Effect.fn(function* (ctx) {
      yield* ctx.tool.transform((editor) => {
        for (const tool of TestTools.tools) editor.add({ name: tool.name, description: tool.description!, input: tool.inputSchema, options: { codemode: false },
          execute: (input) => Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return { content: JSON.stringify(input).includes('"a"') ? "LILAC-HERON" : "LEMON-IBIS" }
          }),
        })
      })
    }) })
    const claude = FakeClaude.make(FakeClaude.replay("tools-continue"), { probes: true })
    const registry = ClaudeSessions.registry()
    yield* Effect.addFinalizer(() => registry.close())
    const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), registry, plugins: [normal.plugin, plugin] })
    yield* TestOpenCode.connect(test.opencode)
    const model = Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") })
    const session = yield* test.opencode.session.create({ title: "Switch tools", location: { directory: Location.PublicRef.fields.directory.make(test.directory) }, model })
    yield* test.opencode.session.prompt({ sessionID: session.id, text: "Look up keys a and b." })
    yield* Deferred.await(entered)
    yield* test.opencode.session.switchModel({ sessionID: session.id, model: TestPlugin.model })
    yield* Deferred.succeed(release, undefined)
    yield* test.opencode.session.wait({ sessionID: session.id })
    expect(JSON.stringify(normal.requests[0]!.prompt)).toContain("LILAC-HERON")
    normal.check()
    yield* test.opencode.session.switchModel({ sessionID: session.id, model })
    yield* test.opencode.session.prompt({ sessionID: session.id, text: "Do not call tools. Acknowledge the other model and reply CONTINUED-OTTER." })
    yield* test.opencode.session.wait({ sessionID: session.id })
    const runs = claude.runs.filter((run) => run.args.includes("--include-partial-messages"))
    expect(runs).toHaveLength(1)
    const users = runs[0]!.received.filter((message) => message.type === "user")
    expect(JSON.stringify(users.at(-1).message.content)).toContain("NORMAL-IBIS")
    const results = runs[0]!.received.filter((message) => message.response?.response?.mcp_response?.result)
    expect(results).toHaveLength(2)
    expect(JSON.stringify(results)).toContain("LILAC-HERON")
    expect(JSON.stringify(results)).toContain("LEMON-IBIS")
    yield* registry.close()
    claude.check()
  }), 15_000)

  it.live("OpenCode executes the calls across two steps and persists their results and metadata", () => Effect.gen(function* () {
    const called: string[] = []
    const plugin = define({ id: "tools-test", effect: Effect.fn(function* (ctx) {
      yield* ctx.session.hook("title", (event) => Effect.sync(() => { event.result = "Tools test" }))
      yield* ctx.tool.transform((editor) => {
        for (const tool of TestTools.tools) editor.add({
          name: tool.name, description: tool.description!, input: tool.inputSchema, options: { codemode: false },
          execute: (input) => Effect.sync(() => {
            called.push(tool.name)
            const result = TestTools.output(tool.name, input)
            return { content: result.type === "text" ? result.value : "" }
          }),
        })
      })
    }) })
    const claude = FakeClaude.make(FakeClaude.replay("tools"), { probes: true })
    const registry = ClaudeSessions.registry()
    yield* Effect.addFinalizer(() => registry.close())
    const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), registry, plugins: [plugin] })
    yield* TestOpenCode.connect(test.opencode)
    const session = yield* test.opencode.session.create({
      title: "Tools test", location: { directory: Location.PublicRef.fields.directory.make(test.directory) },
      model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }),
    })
    yield* test.opencode.session.prompt({ sessionID: session.id, text: "Look up the two markers and confirm them." })
    yield* test.opencode.session.wait({ sessionID: session.id })
    const history = yield* test.opencode.session.export({ sessionID: session.id })
    expect(called).toEqual(["lookup", "lookup", "confirm"])
    const assistants = history.messages.filter((message) => message.type === "assistant")
    expect(assistants.at(-1)?.content).toContainEqual(expect.objectContaining({ type: "text", text: "COPPER-OTTER" }))
    const serialized = JSON.stringify(assistants)
    for (const marker of ["LILAC-HERON", "LEMON-IBIS", "COPPER-OTTER"]) expect(serialized).toContain(marker)
    const firstCall = Recorder.load("tools").find((line) => line.from === "claude" && line.message.type === "assistant")!
    if (firstCall.from !== "claude") throw new Error("Missing tool call recording")
    expect(serialized).toContain(firstCall.message.uuid)
    const runs = claude.runs.filter((run) => run.args.includes("--include-partial-messages"))
    expect(runs).toHaveLength(1)
    expect(runs[0]!.received.filter((message) => message.type === "user")).toHaveLength(1)
    yield* registry.close()
    claude.check()
  }), 15_000)

  for (const stop of ["interrupt", "reject"] as const) {
    it.live(`OpenCode ${stop} starts the follow-up as a fresh Claude turn`, () => Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const plugin = define({ id: "stopped-tools", effect: Effect.fn(function* (ctx) {
        yield* ctx.session.hook("title", (event) => Effect.sync(() => { event.result = "Stopped tools" }))
        yield* ctx.permission.hook("evaluate", (event) => Effect.sync(() => { if (event.action === "fixture") event.effect = "ask" }))
        yield* ctx.tool.transform((editor) => {
          for (const tool of TestTools.tools) editor.add({ name: tool.name, description: tool.description!, input: tool.inputSchema, options: { codemode: false },
            execute: (_, context) => Effect.gen(function* () {
              if (stop === "reject") yield* ctx.permission.assert({ sessionID: context.sessionID, action: "fixture", resources: ["marker"] })
              yield* Deferred.succeed(entered, undefined)
              return yield* Effect.never
            }),
          })
        })
      }) })
      const claude = FakeClaude.make(FakeClaude.replay("tools-abort"), { probes: true })
      const registry = ClaudeSessions.registry()
      yield* Effect.addFinalizer(() => registry.close())
      const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), registry, plugins: [plugin] })
      yield* TestOpenCode.connect(test.opencode)
      const session = yield* test.opencode.session.create({ title: "Stopped tools", location: { directory: Location.PublicRef.fields.directory.make(test.directory) },
        model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }) })
      yield* test.opencode.session.prompt({ sessionID: session.id, text: "Look up keys a and b." })
      if (stop === "interrupt") {
        yield* Deferred.await(entered)
        yield* test.opencode.session.interrupt({ sessionID: session.id })
      } else {
        const pending = yield* TestOpenCode.waitUntil(test.opencode.permission.list({ sessionID: session.id }), (requests) => requests.length > 0)
        yield* test.opencode.permission.reply({ sessionID: session.id, requestID: pending[0]!.id, decision: "reject" })
      }
      yield* test.opencode.session.wait({ sessionID: session.id })
      yield* test.opencode.session.prompt({ sessionID: session.id, text: "Do not call tools. Reply only CONTINUED-OTTER." })
      yield* test.opencode.session.wait({ sessionID: session.id })
      const runs = claude.runs.filter((run) => run.args.includes("--include-partial-messages"))
      expect(runs).toHaveLength(1)
      const messages = runs[0]!.received
      expect(messages.filter((message) => message.request?.subtype === "interrupt")).toHaveLength(1)
      const user = messages.filter((message) => message.type === "user").at(-1)
      expect(user.priority).toBeUndefined()
      expect(user.message.content.at(-1).text).toBe("Do not call tools. Reply only CONTINUED-OTTER.")
      expect(JSON.stringify(user.message.content)).toContain(stop === "interrupt" ? "Tool execution interrupted" : "The user declined this tool call")
      const history = yield* test.opencode.session.export({ sessionID: session.id })
      const last = history.messages.filter((message) => message.type === "assistant").at(-1)!
      expect(last.content).toContainEqual(expect.objectContaining({ type: "text", text: "CONTINUED-OTTER" }))
      yield* registry.close()
      claude.check()
    }), 15_000)
  }

  it.live("OpenCode asks permission and sends a rejection as a tool error", () => Effect.gen(function* () {
    const name = "restricted_" + "resource_".repeat(12)
    let executed = false
    const plugin = define({ id: "permission-test", effect: Effect.fn(function* (ctx) {
      yield* ctx.session.hook("title", (event) => Effect.sync(() => { event.result = "Permission test" }))
      yield* ctx.permission.hook("evaluate", (event) => Effect.sync(() => { if (event.action === "fixture") event.effect = "ask" }))
      yield* ctx.tool.transform((editor) => editor.add({ name, description: "Read a restricted fixture.", input: { type: "object", properties: {} }, options: { codemode: false },
        execute: (_, context) => Effect.gen(function* () {
          yield* ctx.permission.assert({ sessionID: context.sessionID, action: "fixture", resources: ["marker"] })
          executed = true
          return { content: "unexpected success" }
        }),
      }))
    }) })
    const steps = FakeClaude.replay("tools-media")
    const restart = steps.findIndex((step, index) => index > 0 && step.type === "startup")
    expect(restart).toBeGreaterThan(0)
    const claude = FakeClaude.make(steps.slice(restart), { probes: true })
    const registry = ClaudeSessions.registry()
    yield* Effect.addFinalizer(() => registry.close())
    const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), registry, plugins: [plugin] })
    yield* TestOpenCode.connect(test.opencode)
    const session = yield* test.opencode.session.create({ title: "Permission test", location: { directory: Location.PublicRef.fields.directory.make(test.directory) },
      model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }) })
    yield* test.opencode.session.prompt({ sessionID: session.id, text: "Read the restricted fixture. Stop if denied." })
    const requests = yield* TestOpenCode.waitUntil(test.opencode.permission.list({ sessionID: session.id }), (requests) => requests.length > 0)
    expect(executed).toBe(false)
    yield* test.opencode.permission.reply({ sessionID: session.id, requestID: requests[0]!.id, decision: "reject", message: "Permission denied: DENIED-IBIS. Do not retry." })
    yield* test.opencode.session.wait({ sessionID: session.id })
    expect(executed).toBe(false)
    const response = claude.runs.flatMap((run) => run.received).find((message) => message.response?.response?.mcp_response?.result)
    expect(response.response.response.mcp_response.result).toMatchObject({ isError: true })
    expect(JSON.stringify(response)).toContain("DENIED-IBIS")
    yield* registry.close()
    claude.check()
  }), 15_000)
})
