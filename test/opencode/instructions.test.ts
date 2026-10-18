import { describe, expect } from "bun:test"
import { Agent, Location, Model } from "@opencode/plugin/effect"
import { define } from "@opencode/plugin/effect/plugin"
import { unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { ClaudeSessions } from "../../src/claude/sessions.js"
import { ClaudeProvider } from "../../src/plugin/provider.js"
import { it } from "../lib/effect.js"
import { FakeClaude } from "../lib/fake-claude.js"
import { FakeIO } from "../lib/fake-io.js"
import { TestOpenCode } from "../lib/opencode.js"

describe("OpenCode instruction forwarding", () => {
  it.live("keeps instruction files on primary and generate calls, restarting only when the effective role changes", () => Effect.gen(function* () {
    const claude = FakeClaude.make([
      FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "instructions", index: 0 }),
      FakeClaude.expectTurn({ recording: "instructions", index: 1 }),
      FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "utility" }), FakeClaude.expectInterrupt(),
      FakeClaude.expectInterrupt(), FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "instructions", index: 2 }),
      FakeClaude.expectInterrupt(), FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "instructions", index: 3 }),
      FakeClaude.expectTurn({ recording: "instructions", index: 4 }), FakeClaude.expectTurn({ recording: "instructions", index: 5 }), FakeClaude.expectInterrupt(),
    ], { probes: true })
    const registry = ClaudeSessions.registry()
    yield* Effect.addFinalizer(() => registry.close())
    const directory = yield* TestOpenCode.tempDirectory
    const project = "The project marker is ROOT-OTTER.\n\n## Style\nKeep the response short."
    const configured = "The configured marker is GUIDE-IBIS."
    yield* Effect.promise(async () => {
      await writeFile(path.join(directory, "AGENTS.md"), project)
      await writeFile(path.join(directory, "GUIDE.md"), configured)
    })
    const fixture = define({ id: "instructions-fixture", effect: Effect.fn(function* (ctx) {
      yield* ctx.session.hook("context", (event) => Effect.sync(() => { event.tools = {} }))
    }) })
    const { opencode } = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), registry, directory, plugins: [fixture],
      config: { instructions: [path.join(directory, "GUIDE.md")], agents: {
        reviewer: { system: "Your role marker is REVIEWER-HERON." },
        writer: { system: "Your role marker is WRITER-LYNX." },
      } } })
    yield* TestOpenCode.connect(opencode)
    const session = yield* opencode.session.create({ title: "Instructions fixture", agent: Agent.ID.make("reviewer"),
      location: { directory: Location.PublicRef.fields.directory.make(directory) },
      model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }) })
    const ask = Effect.fn(function* () {
      yield* opencode.session.prompt({ sessionID: session.id,
        text: "Using your current instructions, return the role, project, and configured markers in that order. Only the three markers, separated by spaces." })
      yield* opencode.session.wait({ sessionID: session.id })
    })
    yield* ask()
    yield* ask()
    expect(claude.runs.filter((run) => run.args.includes("--include-partial-messages"))).toHaveLength(1)
    yield* opencode.session.generate({ sessionID: session.id, prompt: "Reply only LILAC-HERON." })
    yield* opencode.session.switchAgent({ sessionID: session.id, agent: Agent.ID.make("writer") })
    yield* ask()
    yield* opencode.session.switchAgent({ sessionID: session.id, agent: Agent.ID.make("build") })
    yield* ask()
    yield* Effect.promise(() => writeFile(path.join(directory, "AGENTS.md"), "The project marker is UPDATED-OTTER."))
    yield* opencode.location.reload()
    yield* ask()
    yield* Effect.promise(() => unlink(path.join(directory, "GUIDE.md")))
    yield* opencode.location.reload()
    yield* ask()
    const runs = claude.runs.filter((run) => run.args.includes("--include-partial-messages"))
    expect(runs).toHaveLength(4)
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]!
      const init = run.received.find((message) => message.request?.subtype === "initialize").request
      expect(init.systemPrompt).toBeUndefined()
      expect(init.systemPromptSnapshot).toBe(false)
      expect(init.appendSystemPrompt).toContain(project)
      expect(init.appendSystemPrompt).toContain(configured)
      expect(init.appendSystemPrompt).not.toContain("You are an AI agent running in OpenCode")
      if (i < 2) expect(init.appendSystemPrompt).toContain("REVIEWER-HERON")
      else if (i === 2) {
        expect(init.appendSystemPrompt).toContain("WRITER-LYNX")
        expect(init.appendSystemPrompt).not.toContain("REVIEWER-HERON")
      } else expect(init.appendSystemPrompt).not.toMatch(/REVIEWER-HERON|WRITER-LYNX/)
    }
    const id = runs[0]!.args.find((arg) => arg.startsWith("--session-id="))!.slice("--session-id=".length)
    expect(runs[1]!.args).toContain("--no-session-persistence")
    expect(runs[2]!.args).toContain(`--resume=${id}`)
    expect(runs[3]!.args).toContain(`--resume=${id}`)
    const users = runs[3]!.received.filter((message) => message.type === "user")
    expect(JSON.stringify(users.at(-2))).toContain("UPDATED-OTTER")
    expect(JSON.stringify(users.at(-1))).toContain("no longer apply")
    yield* registry.close()
    claude.check()
  }), 15_000)
})
