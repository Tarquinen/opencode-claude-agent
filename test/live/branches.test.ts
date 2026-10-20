import { describe, expect } from "bun:test"
import { deleteSession, getSessionMessages } from "@anthropic-ai/claude-agent-sdk"
import { Location, Model } from "@opencode/plugin/effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { ClaudeIO } from "../../src/claude/io.js"
import { ClaudeSessions } from "../../src/claude/sessions.js"
import { ClaudeProvider } from "../../src/plugin/provider.js"
import { it } from "../lib/effect.js"
import { Recorder } from "../lib/recorder.js"
import { TestOpenCode } from "../lib/opencode.js"

const live =
  !process.env.CI && process.env.CLAUDE_LIVE === "1" && Bun.spawnSync(["claude", "auth", "status"]).exitCode === 0
const model = Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") })

const setup = Effect.fn(function* (name: string) {
  const directory = yield* TestOpenCode.tempDirectory
  const registry = ClaudeSessions.registry()
  const recorder = Recorder.make(name, true)
  const forks: Array<{ source: string; boundary: string; sessionID: string }> = []
  const removed: string[] = []
  const io: ClaudeIO.Interface = {
    ...ClaudeIO.real,
    spawn: recorder.spawn,
    async fork(source, boundary) {
      const fork = await ClaudeIO.real.fork(source, boundary)
      if (fork) forks.push({ source, boundary, sessionID: fork.sessionID })
      return fork
    },
    async remove(id) {
      await ClaudeIO.real.remove(id)
      removed.push(id)
    },
  }
  yield* Effect.addFinalizer(() =>
    registry.close().pipe(
      Effect.andThen(
        Effect.promise(async () => {
          recorder.save()
          for (const id of new Set([...recorder.sessionIDs, ...forks.map((fork) => fork.sessionID)])) {
            if (await ClaudeIO.real.sessionExists(id)) await deleteSession(id, { dir: directory })
          }
        }),
      ),
    ),
  )
  const fixture = define({
    id: "live.branches",
    effect: Effect.fn(function* (ctx) {
      yield* ctx.session.hook("context", (event) =>
        Effect.sync(() => {
          event.tools = {}
        }),
      )
    }),
  })
  const test = yield* TestOpenCode.start({
    io,
    registry,
    directory,
    plugins: [fixture],
    config: { compaction: { keep: { tokens: 0 } } },
  })
  yield* TestOpenCode.connect(test.opencode)
  const parent = yield* test.opencode.session.create({
    title: "Branch fixture",
    location: { directory: Location.PublicRef.fields.directory.make(directory) },
    model,
  })
  const ask = Effect.fn(function* (sessionID: typeof parent.id, text: string) {
    yield* test.opencode.session.prompt({ sessionID, text })
    yield* test.opencode.session.wait({ sessionID })
    const data = yield* test.opencode.session.export({ sessionID })
    const reply = data.messages.findLast((message) => message.type === "assistant")!
    if (reply.type !== "assistant") return ""
    return reply.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim()
  })
  return { opencode: test.opencode, parent, ask, forks, removed, directory, recorder }
})

describe.skipIf(!live)("native branches against real Claude", () => {
  it.live(
    "resends an unchanged question after native undo",
    () =>
      Effect.gen(function* () {
        const test = yield* setup("branch-resubmit")
        expect(yield* test.ask(test.parent.id, "Remember ROOT-OTTER. Reply only ROOT-OTTER.")).toBe("ROOT-OTTER")
        const question = "What marker did I ask you to remember? Reply only with it."
        expect(yield* test.ask(test.parent.id, question)).toBe("ROOT-OTTER")
        const original = yield* test.opencode.session.export({ sessionID: test.parent.id })
        const lastUser = original.messages.filter((message) => message.type === "user").at(-1)!
        yield* test.opencode.session.revert.stage({ sessionID: test.parent.id, messageID: lastUser.id, files: false })
        yield* test.opencode.session.revert.commit({ sessionID: test.parent.id })
        expect(yield* test.ask(test.parent.id, question).pipe(Effect.timeout("30 seconds"))).toBe("ROOT-OTTER")
        const sent = test.recorder.lines.findLast((line) => line.from === "sdk" && line.message.type === "user")!
        if (sent.from === "sdk") expect(sent.message.message.content).toEqual([{ type: "text", text: question }])
        console.log("Live undo/resubmit model calls: 3")
      }),
    60_000,
  )

  it.live(
    "forks and undoes without future leakage or changing the old transcripts",
    () =>
      Effect.gen(function* () {
        const test = yield* setup("branches")
        expect(yield* test.ask(test.parent.id, "Remember ROOT-OTTER. Reply only ROOT-OTTER.")).toBe("ROOT-OTTER")
        expect(yield* test.ask(test.parent.id, "Remember FUTURE-IBIS too. Reply only FUTURE-IBIS.")).toBe("FUTURE-IBIS")
        const original = yield* test.opencode.session.export({ sessionID: test.parent.id })
        const secondUser = original.messages.filter((message) => message.type === "user")[1]!
        const child = yield* test.opencode.session.fork({ sessionID: test.parent.id, before: secondUser.id })
        expect(yield* test.ask(child.id, "Remember CHILD-HERON. Reply only CHILD-HERON.")).toBe("CHILD-HERON")
        expect(test.forks).toHaveLength(1)
        const childBefore = yield* test.opencode.session.export({ sessionID: child.id })
        const childUser = childBefore.messages.filter((message) => message.type === "user").at(-1)!
        const originalChild = yield* Effect.promise(() =>
          getSessionMessages(test.forks[0]!.sessionID, { dir: test.directory }),
        )
        yield* test.opencode.session.revert.stage({ sessionID: child.id, messageID: childUser.id, files: false })
        yield* test.opencode.session.revert.commit({ sessionID: child.id })
        expect(
          yield* test.ask(child.id, "List all marker words you remember from this conversation. Only the markers."),
        ).toBe("ROOT-OTTER")
        expect(test.forks).toHaveLength(2)
        expect(test.forks[1]!.source).toBe(test.forks[0]!.sessionID)
        expect(test.forks[1]!.boundary).not.toBe(test.forks[0]!.boundary)
        expect(
          yield* Effect.promise(() => getSessionMessages(test.forks[0]!.sessionID, { dir: test.directory })),
        ).toEqual(originalChild)
        console.log("Live fork/undo model calls: 4")
      }),
    60_000,
  )

  it.live(
    "concurrent generate calls use disposable branches without changing the primary conversation",
    () =>
      Effect.gen(function* () {
        const test = yield* setup("branch-generate")
        expect(yield* test.ask(test.parent.id, "Remember ROOT-OTTER. Reply only ROOT-OTTER.")).toBe("ROOT-OTTER")
        const original = yield* test.opencode.session.export({ sessionID: test.parent.id })
        const generated = yield* Effect.all(
          [
            test.opencode.session.generate({
              sessionID: test.parent.id,
              prompt: "Do not use tools. Reply only SIDE-A.",
            }),
            test.opencode.session.generate({
              sessionID: test.parent.id,
              prompt: "Do not use tools. Reply only SIDE-B.",
            }),
          ],
          { concurrency: "unbounded" },
        )
        expect(generated.map((reply) => reply.text.trim())).toEqual(["SIDE-A", "SIDE-B"])
        expect(test.forks).toHaveLength(2)
        expect(new Set(test.removed)).toEqual(new Set(test.forks.map((fork) => fork.sessionID)))
        expect((yield* test.opencode.session.export({ sessionID: test.parent.id })).messages).toEqual(original.messages)
        const remembered = yield* test.ask(test.parent.id, "List all marker words you remember. Only the markers.")
        expect(remembered).toContain("ROOT-OTTER")
        expect(remembered).not.toMatch(/CHILD-HERON|SIDE-A|SIDE-B/)
        console.log("Live generate model calls: 4")
      }),
    60_000,
  )

  it.live(
    "native compaction uses a disposable branch and replaces the primary history with its summary",
    () =>
      Effect.gen(function* () {
        const test = yield* setup("branch-compaction")
        expect(yield* test.ask(test.parent.id, "Remember ROOT-OTTER. Reply only ROOT-OTTER.")).toBe("ROOT-OTTER")
        expect(yield* test.ask(test.parent.id, "Remember FUTURE-IBIS too. Reply only FUTURE-IBIS.")).toBe("FUTURE-IBIS")
        yield* test.opencode.session.compact({ sessionID: test.parent.id })
        yield* test.opencode.session.wait({ sessionID: test.parent.id })
        const compacted = yield* test.opencode.session.export({ sessionID: test.parent.id })
        expect(compacted.messages.findLast((message) => message.type === "compaction")).toMatchObject({
          status: "completed",
        })
        expect(test.forks).toHaveLength(1)
        expect(test.removed).toContain(test.forks[0]!.sessionID)
        const after = yield* test.ask(test.parent.id, "List all marker words you remember. Only the markers.")
        expect(after).toContain("ROOT-OTTER")
        expect(after).toContain("FUTURE-IBIS")
        expect(after).not.toMatch(/CHILD-HERON|SIDE-A|SIDE-B/)
        const lastSpawn = test.recorder.lines.findLast((line) => line.from === "spawn")!
        if (lastSpawn.from === "spawn") expect(lastSpawn.args.some((arg) => arg.startsWith("--resume="))).toBe(false)
        console.log("Live compaction model calls: 4")
      }),
    90_000,
  )
})
