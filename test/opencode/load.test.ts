import { describe, expect } from "bun:test"
import type { SDKControlInitializeResponse } from "@anthropic-ai/claude-agent-sdk"
import { Location, Model } from "@opencode/plugin/effect"
import path from "node:path"
import { Effect } from "effect"
import { ClaudeSessions } from "../../src/claude/sessions.js"
import { ClaudeProvider } from "../../src/plugin/provider.js"
import { it } from "../lib/effect.js"
import { FakeClaude } from "../lib/fake-claude.js"
import { FakeIO } from "../lib/fake-io.js"
import { TestOpenCode } from "../lib/opencode.js"
import { Recorder } from "../lib/recorder.js"

describe("loading the plugin", () => {
  it.live("starts without models or a claude run, and connecting fills the list from claude", () =>
    Effect.gen(function* () {
      const onConnect = FakeClaude.expectStartup()
      const claude = FakeClaude.make([onConnect])
      const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }) })

      expect(yield* TestOpenCode.models(test.opencode)).toEqual([])
      expect(claude.runs).toHaveLength(0)

      yield* TestOpenCode.connect(test.opencode)
      yield* Effect.promise(() => claude.reached(onConnect))
      const ids = yield* TestOpenCode.waitUntil(TestOpenCode.models(test.opencode), (ids) => ids.length > 0)
      const startup: SDKControlInitializeResponse = Recorder.startupReply(Recorder.load("startup"))
      const recorded = startup.models.filter((model) => model.value !== "default").map((model) => model.value)
      expect(ids).toEqual(recorded)
      const models = yield* test.opencode.model.list()
      const sonnet = models.data.find((model) => model.providerID === ClaudeProvider.ID && model.id === "sonnet")
      const haiku = models.data.find((model) => model.providerID === ClaudeProvider.ID && model.id === "haiku")
      expect(sonnet?.variants).toContainEqual({ id: Model.VariantID.make("high"), settings: { effort: "high" } })
      expect(haiku?.family).toBe(Model.Family.make("claude-haiku"))
      expect(sonnet?.limit).toEqual({ context: 1_000_000, output: 0 })
      const older = models.data.find(
        (model) => model.providerID === ClaudeProvider.ID && model.id === "claude-opus-4-6",
      )
      expect(older?.limit.context).toBe(200_000)
      for (const model of models.data) {
        if (model.providerID !== ClaudeProvider.ID) continue
        expect(model.cost).toEqual([])
        expect(model.capabilities.input).toEqual(["text", "image", "pdf"])
      }
      claude.check()
    }),
  )

  it.live("lists a model that Claude Code names by its version under its family alias", () =>
    Effect.gen(function* () {
      const steps = FakeClaude.replay("startup")
      const startup = steps[0]
      if (startup?.type !== "startup") throw new Error("Missing startup recording")
      // Through a custom base URL, Claude Code lists Fable by the version it currently resolves to
      const fable = startup.reply.models.find((model) => model.value === "fable")!
      fable.value = "claude-fable-5-2[1m]"
      fable.displayName = "Fable"
      const claude = FakeClaude.make(steps)
      const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }) })
      yield* TestOpenCode.connect(test.opencode)
      yield* Effect.promise(() => claude.reached(steps.at(-1)!))
      const ids = yield* TestOpenCode.waitUntil(TestOpenCode.models(test.opencode), (ids) => ids.length > 0)
      expect(ids).toContain("fable")
      expect(ids).not.toContain("claude-fable-5-2[1m]")
      claude.check()
    }),
  )

  it.live("restarts with the saved models without running claude", () =>
    Effect.gen(function* () {
      const directory = yield* TestOpenCode.tempDirectory
      const database = path.join(directory, "opencode.db")
      const saved = yield* Effect.gen(function* () {
        const onConnect = FakeClaude.expectStartup()
        const claude = FakeClaude.make([onConnect])
        const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), directory, database })
        yield* TestOpenCode.connect(test.opencode)
        yield* Effect.promise(() => claude.reached(onConnect))
        const ids = yield* TestOpenCode.waitUntil(TestOpenCode.models(test.opencode), (ids) => ids.length > 0)
        claude.check()
        return ids
      }).pipe(Effect.scoped)

      const claude = FakeClaude.make([])
      const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), directory, database })
      expect(yield* TestOpenCode.models(test.opencode)).toEqual(saved)
      const models = yield* test.opencode.model.list()
      expect(
        models.data.find((model) => model.providerID === ClaudeProvider.ID && model.id === "opus")?.limit.context,
      ).toBe(1_000_000)
      expect(claude.runs).toHaveLength(0)
    }),
  )

  it.live("checks context sizes for models a chat reports without one", () =>
    Effect.gen(function* () {
      const directory = yield* TestOpenCode.tempDirectory
      const database = path.join(directory, "opencode.db")
      yield* Effect.gen(function* () {
        const steps = FakeClaude.replay("startup")
        const context = steps.find(
          (step) => step.type === "exchange" && step.input.request?.subtype === "get_context_usage",
        )
        if (context?.type !== "exchange") throw new Error("Missing context recording")
        context.replies[0].response.response.rawMaxTokens = 0
        const claude = FakeClaude.make(steps)
        const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), directory, database })
        yield* TestOpenCode.connect(test.opencode)
        yield* Effect.promise(() => claude.reached(steps.at(-1)!))
        yield* TestOpenCode.waitUntil(TestOpenCode.models(test.opencode), (ids) => ids.length > 0)
        claude.check()
      }).pipe(Effect.scoped)

      const claude = FakeClaude.make(
        [FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt()],
        { probes: true },
      )
      const registry = ClaudeSessions.registry()
      yield* Effect.addFinalizer(() => registry.close())
      const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), registry, directory, database })
      const opus = test.opencode.model
        .list({ location: { directory: Location.PublicRef.fields.directory.make(test.directory) } })
        .pipe(
          Effect.map(
            (models) =>
              models.data.find((model) => model.providerID === ClaudeProvider.ID && model.id === "opus")?.limit.context,
          ),
        )
      expect(yield* opus).toBe(200_000)
      const session = yield* test.opencode.session.create({
        title: "Context test",
        location: { directory: Location.PublicRef.fields.directory.make(test.directory) },
        model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }),
      })
      yield* test.opencode.session.prompt({ sessionID: session.id, text: "hello" })
      yield* test.opencode.session.wait({ sessionID: session.id })
      yield* TestOpenCode.waitUntil(opus, (context) => context === 1_000_000)
      yield* registry.close()
      claude.check()
    }),
  )

  it.live("connecting without claude installed shows a problem, and the next start checks again", () =>
    Effect.gen(function* () {
      const directory = yield* TestOpenCode.tempDirectory
      const database = path.join(directory, "opencode.db")
      yield* Effect.gen(function* () {
        const claude = FakeClaude.make([])
        const io = { ...FakeIO.make({ claude }), which: () => undefined }
        const test = yield* TestOpenCode.start({ io, directory, database })
        yield* TestOpenCode.connect(test.opencode)
        const connection = yield* TestOpenCode.waitUntil(
          TestOpenCode.connection(test.opencode),
          (connection) => connection?.status !== undefined,
        )
        expect(connection?.status?.status).toBe("needs_auth")
        expect(yield* TestOpenCode.models(test.opencode)).toEqual([])
      }).pipe(Effect.scoped)

      // The user installed claude and restarted. With no saved models, opencode checks once at startup.
      const atStart = FakeClaude.expectStartup()
      const claude = FakeClaude.make([atStart])
      const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), directory, database })
      yield* Effect.promise(() => claude.reached(atStart))
      yield* TestOpenCode.waitUntil(TestOpenCode.models(test.opencode), (ids) => ids.length > 0)
      expect((yield* TestOpenCode.connection(test.opencode))?.status).toBeUndefined()
      claude.check()
    }),
  )

  it.live("connecting while logged out of claude asks the user to sign in", () =>
    Effect.gen(function* () {
      const onConnect = FakeClaude.expectStartup({ recording: "startup-logged-out" })
      const claude = FakeClaude.make([onConnect])
      const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }) })
      yield* TestOpenCode.connect(test.opencode)
      yield* Effect.promise(() => claude.reached(onConnect))
      const connection = yield* TestOpenCode.waitUntil(
        TestOpenCode.connection(test.opencode),
        (connection) => connection?.status !== undefined,
      )
      expect(connection?.status).toMatchObject({
        status: "needs_auth",
        message: expect.stringContaining("claude auth login"),
      })
      claude.check()
    }),
  )

  it.live("an API-key login is not a sign-in problem, and its models work", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make(
        [FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt()],
        { probes: true },
      )
      const test = yield* TestOpenCode.start({
        io: FakeIO.make({ claude, env: { ANTHROPIC_API_KEY: "fixture-secret" } }),
      })
      yield* TestOpenCode.connect(test.opencode)
      yield* TestOpenCode.waitUntil(TestOpenCode.models(test.opencode), (ids) =>
        ids.some((id) => id.startsWith("claude-")),
      )
      expect((yield* TestOpenCode.connection(test.opencode))?.status).toBeUndefined()
      const result = yield* test.opencode.generate.text({
        prompt: "hello",
        model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }),
      })
      expect(result.text).toBe("COPPER-OTTER")
      claude.check()
    }),
  )
})
