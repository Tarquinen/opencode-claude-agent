import { describe, expect } from "bun:test"
import { deleteSession } from "@anthropic-ai/claude-agent-sdk"
import { Location, Model } from "@opencode/plugin/effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { ClaudeIO } from "../../src/claude/io.js"
import { ClaudeSessions } from "../../src/claude/sessions.js"
import { ClaudeProvider } from "../../src/plugin/provider.js"
import { it } from "../lib/effect.js"
import { Recorder } from "../lib/recorder.js"
import { TestOpenCode } from "../lib/opencode.js"

const live = !process.env.CI && process.env.CLAUDE_LIVE === "1" && Bun.spawnSync(["claude", "auth", "status"]).exitCode === 0

describe.skipIf(!live)("live runtime controls", () => {
  it.live("applies and clears effort, switches model live, and resumes with a new output limit", () => Effect.gen(function* () {
    const directory = yield* TestOpenCode.tempDirectory
    const registry = ClaudeSessions.registry()
    const recorder = Recorder.make("controls", true)
    yield* Effect.addFinalizer(() => registry.close().pipe(Effect.andThen(Effect.promise(async () => {
      recorder.save()
      for (const id of recorder.sessionIDs) if (await ClaudeIO.real.sessionExists(id)) await deleteSession(id, { dir: directory })
    }))))
    let maxOutputTokens = 2048
    const fixture = define({ id: "live.controls", effect: Effect.fn(function* (ctx) {
      yield* ctx.session.hook("context", (event) => Effect.sync(() => {
        event.tools = {}
        event.options.maxTokens = maxOutputTokens
      }))
    }) })
    const { opencode } = yield* TestOpenCode.start({ io: { ...ClaudeIO.real, spawn: recorder.spawn }, registry, directory, plugins: [fixture] })
    yield* TestOpenCode.connect(opencode)
    const select = (id: string, variant?: string) => Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make(id),
      variant: variant ? Model.VariantID.make(variant) : undefined })
    yield* TestOpenCode.waitUntil(opencode.model.list(), (list) => list.data.some((model) => model.providerID === ClaudeProvider.ID && model.id === "haiku" && model.variants.length > 0))
    const session = yield* opencode.session.create({ title: "Controls fixture", model: select("haiku", "low"),
      location: { directory: Location.PublicRef.fields.directory.make(directory) } })
    const ask = Effect.fn(function* (first = false) {
      yield* opencode.session.prompt({ sessionID: session.id, text: first
        ? "Remember CONTROL-OTTER. Reply only CONTROL-OTTER."
        : "What marker did I ask you to remember? Reply only with it." })
      yield* opencode.session.wait({ sessionID: session.id })
      const history = yield* opencode.session.export({ sessionID: session.id })
      const reply = history.messages.findLast((message) => message.type === "assistant")!
      expect(reply.error).toBeUndefined()
      let text = ""
      if (reply.type === "assistant") for (const part of reply.content) if (part.type === "text") text += part.text
      expect(text.trim()).toBe("CONTROL-OTTER")
    })
    yield* ask(true)
    yield* opencode.session.switchModel({ sessionID: session.id, model: select("haiku", "high") })
    yield* ask()
    yield* opencode.session.switchModel({ sessionID: session.id, model: select("haiku") })
    yield* ask()
    yield* opencode.session.switchModel({ sessionID: session.id, model: select("sonnet", "low") })
    yield* ask()
    expect(recorder.lines.filter((line) => line.from === "spawn" && line.args.includes("--include-partial-messages"))).toHaveLength(1)
    maxOutputTokens = 4096
    yield* ask()
    const runs = recorder.lines.filter((line) => line.from === "spawn" && line.args.includes("--include-partial-messages"))
    expect(runs).toHaveLength(2)
    expect(recorder.sessionIDs.size).toBe(1)
    const requests = recorder.lines.filter((line) => line.from === "sdk").map((line) => line.message.request)
    expect(requests).toContainEqual({ subtype: "set_model", model: "sonnet" })
    expect(requests).toContainEqual({ subtype: "apply_flag_settings", settings: { effortLevel: "high" } })
    expect(requests).toContainEqual({ subtype: "apply_flag_settings", settings: { effortLevel: null } })
    const models: string[] = []
    for (const line of recorder.lines) if (line.from === "claude" && line.message.type === "assistant") models.push(line.message.message.model)
    expect(models.some((model) => model.includes("haiku"))).toBe(true)
    expect(models.some((model) => model.includes("sonnet"))).toBe(true)
    console.log("Live control model calls: 5")
  }), 90_000)
})
