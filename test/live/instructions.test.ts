import { describe, expect } from "bun:test"
import { deleteSession } from "@anthropic-ai/claude-agent-sdk"
import { Agent, Location, Model } from "@opencode/plugin/effect"
import { define } from "@opencode/plugin/effect/plugin"
import { unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { ClaudeIO } from "../../src/claude/io.js"
import { ClaudeSessions } from "../../src/claude/sessions.js"
import { ClaudeProvider } from "../../src/plugin/provider.js"
import { it } from "../lib/effect.js"
import { Recorder } from "../lib/recorder.js"
import { TestOpenCode } from "../lib/opencode.js"

const live = !process.env.CI && process.env.CLAUDE_LIVE === "1" && Bun.spawnSync(["claude", "auth", "status"]).exitCode === 0

describe.skipIf(!live)("OpenCode instructions against real Claude", () => {
  it.live("follows custom roles and instruction files, and switches roles on the same native session", () => Effect.gen(function* () {
    const directory = yield* TestOpenCode.tempDirectory
    yield* Effect.promise(async () => {
      await writeFile(path.join(directory, "AGENTS.md"), "The project marker is ROOT-OTTER.")
      await writeFile(path.join(directory, "GUIDE.md"), "The configured marker is GUIDE-IBIS.")
    })
    const registry = ClaudeSessions.registry()
    const recorder = Recorder.make("instructions", true)
    yield* Effect.addFinalizer(() => registry.close().pipe(Effect.andThen(Effect.promise(async () => {
      recorder.save()
      for (const id of recorder.sessionIDs) {
        if (await ClaudeIO.real.sessionExists(id)) await deleteSession(id, { dir: directory })
      }
    }))))
    const fixture = define({ id: "live.instructions", effect: Effect.fn(function* (ctx) {
      yield* ctx.session.hook("context", (event) => Effect.sync(() => { event.tools = {} }))
    }) })
    const { opencode } = yield* TestOpenCode.start({
      io: { ...ClaudeIO.real, spawn: recorder.spawn }, registry, directory, plugins: [fixture],
      config: { instructions: [path.join(directory, "GUIDE.md")], agents: {
        reviewer: { system: "Your role marker is REVIEWER-HERON." },
        writer: { system: "Your role marker is WRITER-LYNX." },
      } },
    })
    yield* TestOpenCode.connect(opencode)
    const session = yield* opencode.session.create({ title: "Instructions fixture", agent: Agent.ID.make("reviewer"),
      location: { directory: Location.PublicRef.fields.directory.make(directory) },
      model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }) })
    const ask = Effect.fn(function* (text: string) {
      yield* opencode.session.prompt({ sessionID: session.id, text })
      yield* opencode.session.wait({ sessionID: session.id })
      const history = yield* opencode.session.export({ sessionID: session.id })
      const reply = history.messages.findLast((message) => message.type === "assistant")!
      let answer = ""
      if (reply.type === "assistant") for (const part of reply.content) if (part.type === "text") answer += part.text
      return answer.trim()
    })
    const question = "Using your current instructions, return the role, project, and configured markers in that order. Only the three markers, separated by spaces."
    expect(yield* ask(question)).toBe("REVIEWER-HERON ROOT-OTTER GUIDE-IBIS")
    expect(yield* ask(question)).toBe("REVIEWER-HERON ROOT-OTTER GUIDE-IBIS")
    yield* opencode.session.switchAgent({ sessionID: session.id, agent: Agent.ID.make("writer") })
    expect(yield* ask(question)).toBe("WRITER-LYNX ROOT-OTTER GUIDE-IBIS")
    yield* opencode.session.switchAgent({ sessionID: session.id, agent: Agent.ID.make("build") })
    expect(yield* ask("Return only the project and configured markers, separated by a space.")).toBe("ROOT-OTTER GUIDE-IBIS")
    const runs = recorder.lines.filter((line) => line.from === "spawn" && line.args.includes("--include-partial-messages"))
    expect(runs).toHaveLength(3)
    expect(recorder.sessionIDs.size).toBe(1)
    const init = recorder.lines.filter((line) => line.from === "sdk" && line.message.request?.subtype === "initialize").at(-1)!
    if (init.from === "sdk") {
      expect(init.message.request.systemPrompt).toBeUndefined()
      expect(init.message.request.systemPromptSnapshot).toBe(false)
      expect(init.message.request.appendSystemPrompt).not.toContain("WRITER-LYNX")
    }
    yield* Effect.promise(() => writeFile(path.join(directory, "AGENTS.md"), "The project marker is UPDATED-OTTER."))
    yield* opencode.location.reload()
    const active = "Using only active instructions, return the project and configured markers separated by a space. If no configured marker is active, use NONE."
    expect(yield* ask(active)).toBe("UPDATED-OTTER GUIDE-IBIS")
    yield* Effect.promise(() => unlink(path.join(directory, "GUIDE.md")))
    yield* opencode.location.reload()
    expect(yield* ask(active)).toBe("UPDATED-OTTER NONE")
    const users = recorder.lines.filter((line) => line.from === "sdk" && line.message.type === "user")
    expect(JSON.stringify(users.at(-2))).toContain("UPDATED-OTTER")
    expect(JSON.stringify(users.at(-1))).toContain("no longer apply")
    expect(recorder.sessionIDs.size).toBe(1)
    console.log("Live instruction model calls: 6")
  }), 90_000)
})
