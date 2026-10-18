import { describe, expect } from "bun:test"
import { Model } from "@opencode/plugin/effect"
import path from "node:path"
import { Effect } from "effect"
import { ClaudeProvider } from "../../src/plugin/provider.js"
import { it } from "../lib/effect.js"
import { FakeClaude } from "../lib/fake-claude.js"
import { FakeIO } from "../lib/fake-io.js"
import { TestOpenCode } from "../lib/opencode.js"
import { Recorder } from "../lib/recorder.js"

describe("loading the plugin", () => {
  it.live("models show from the built-in list until the login check finishes, then from claude", () =>
    Effect.gen(function* () {
      // Both checks wait: the one at start-up, and the one connecting starts
      const hold = Promise.withResolvers<void>()
      const atStart = FakeClaude.expectStartup({ hold: hold.promise })
      const onConnect = FakeClaude.expectStartup({ hold: hold.promise })
      const claude = FakeClaude.make([atStart, onConnect])
      const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }) })

      expect(yield* TestOpenCode.models(test.opencode)).toEqual([])
      yield* TestOpenCode.connect(test.opencode)
      expect(yield* TestOpenCode.models(test.opencode)).toEqual(["opus", "sonnet", "haiku"])

      hold.resolve()
      yield* Effect.promise(() => claude.reached(onConnect))
      const ids = yield* TestOpenCode.waitUntil(TestOpenCode.models(test.opencode), (ids) => ids.length > 3)
      const recorded: string[] = []
      for (const model of Recorder.startupReply(Recorder.load("startup")).models) {
        if (model.value !== "default") recorded.push(model.value)
      }
      expect(ids).toEqual(recorded)
      const models = yield* test.opencode.model.list()
      const sonnet = models.data.find((model) => model.providerID === ClaudeProvider.ID && model.id === "sonnet")
      const haiku = models.data.find((model) => model.providerID === ClaudeProvider.ID && model.id === "haiku")
      expect(sonnet?.variants).toContainEqual({ id: Model.VariantID.make("high"), settings: { effort: "high" } })
      expect(haiku?.family).toBe(Model.Family.make("claude-haiku"))
      expect(sonnet?.limit).toEqual({ context: 1_000_000, output: 0 })
      const older = models.data.find((model) => model.providerID === ClaudeProvider.ID && model.id === "claude-opus-4-6")
      expect(older?.limit.context).toBe(200_000)
      for (const model of models.data) {
        if (model.providerID !== ClaudeProvider.ID) continue
        expect(model.cost).toEqual([])
        expect(model.capabilities.input).toEqual(["text", "image", "pdf"])
      }
      claude.check()
    }),
  )

  it.live("restores the saved models before the next startup check finishes", () =>
    Effect.gen(function* () {
      const directory = yield* TestOpenCode.tempDirectory
      const database = path.join(directory, "opencode.db")
      const saved = yield* Effect.gen(function* () {
        const atStart = FakeClaude.expectStartup()
        const onConnect = FakeClaude.expectStartup()
        const claude = FakeClaude.make([atStart, onConnect])
        const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), directory, database })
        yield* TestOpenCode.connect(test.opencode)
        yield* Effect.promise(() => claude.reached(onConnect))
        const ids = yield* TestOpenCode.waitUntil(TestOpenCode.models(test.opencode), (ids) => ids.length > 3)
        claude.check()
        return ids
      }).pipe(Effect.scoped)

      const hold = Promise.withResolvers<void>()
      const startup = FakeClaude.expectStartup({ hold: hold.promise })
      const claude = FakeClaude.make([startup])
      const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), directory, database })
      yield* Effect.promise(() => claude.started(startup))
      expect(yield* TestOpenCode.models(test.opencode)).toEqual(saved)
      const models = yield* test.opencode.model.list()
      expect(models.data.find((model) => model.providerID === ClaudeProvider.ID && model.id === "opus")?.limit.context).toBe(1_000_000)

      hold.resolve()
      yield* Effect.promise(() => claude.reached(startup))
      claude.check()
    }),
  )

  it.live("connecting after the login check shows its result, and checks again", () =>
    Effect.gen(function* () {
      const atStart = FakeClaude.expectStartup({ recording: "startup-logged-out" })
      const onConnect = FakeClaude.expectStartup({ recording: "startup-logged-out" })
      const claude = FakeClaude.make([atStart, onConnect])
      const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }) })
      yield* Effect.promise(() => claude.reached(atStart))

      yield* TestOpenCode.connect(test.opencode)
      yield* Effect.promise(() => claude.reached(onConnect))
      const connection = yield* TestOpenCode.waitUntil(
        TestOpenCode.connection(test.opencode),
        (connection) => connection?.status !== undefined,
      )
      expect(connection?.status?.status).toBe("needs_auth")
      expect(connection?.status?.message).toContain("claude auth login")
      claude.check()
    }),
  )

  it.live("opencode calls our model through the placeholder package", () =>
    Effect.gen(function* () {
      const onConnect = FakeClaude.expectStartup()
      // Generate loads its location's plugin instance as well as the server-level provider catalog.
      const claude = FakeClaude.make([FakeClaude.expectStartup(), onConnect, FakeClaude.expectStartup(), FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt()])
      const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }) })
      yield* TestOpenCode.connect(test.opencode)
      yield* Effect.promise(() => claude.reached(onConnect))
      const result = yield* test.opencode.generate
        .text({ prompt: "hello", model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("sonnet") }) })
      expect(result.text).toBe("COPPER-OTTER")
      claude.check()
    }),
  )

  it.live("shows an inherited API-key billing warning without exposing the key or blocking models", () => Effect.gen(function* () {
    const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt()], { probes: true })
    const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude, env: { ANTHROPIC_API_KEY: "fixture-secret" } }) })
    yield* TestOpenCode.connect(test.opencode)
    const connection = yield* TestOpenCode.waitUntil(TestOpenCode.connection(test.opencode), (value) => !!value?.status)
    expect(connection?.status?.message).toContain("API billing instead of your subscription")
    expect(connection?.status?.message).not.toContain("fixture-secret")
    expect(yield* TestOpenCode.models(test.opencode)).toContain("haiku")
    const result = yield* test.opencode.generate.text({ prompt: "hello",
      model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }) })
    expect(result.text).toBe("COPPER-OTTER")
    claude.check()
  }))
})
