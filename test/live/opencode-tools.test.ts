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

describe.skipIf(!live)("real Claude through OpenCode tools", () => {
  it.live("stops tool execution at the native agent step limit and summarizes the saved result", () => Effect.gen(function* () {
    const directory = yield* TestOpenCode.tempDirectory
    const recorder = Recorder.make("max-steps", true)
    const registry = ClaudeSessions.registry()
    yield* Effect.addFinalizer(() => registry.close().pipe(Effect.andThen(Effect.promise(async () => {
      recorder.save()
      for (const id of recorder.sessionIDs) if (await ClaudeIO.real.sessionExists(id)) await deleteSession(id, { dir: directory })
    }))))
    let calls = 0
    const fixture = define({ id: "live.steps", effect: Effect.fn(function* (ctx) {
      yield* ctx.tool.transform((editor) => editor.add({ name: "lookup", description: "Look up the marker.",
        input: { type: "object", properties: {} }, options: { codemode: false },
        execute: () => Effect.sync(() => { calls++; return { content: "STEP-OTTER" } }),
      }))
      yield* ctx.session.hook("context", (event) => Effect.sync(() => {
        for (const name of Object.keys(event.tools)) if (name !== "lookup") delete event.tools[name]
      }))
    }) })
    const { opencode } = yield* TestOpenCode.start({ io: { ...ClaudeIO.real, spawn: recorder.spawn }, registry, directory,
      plugins: [fixture], config: { agents: { build: { steps: 2 } } } })
    yield* TestOpenCode.connect(opencode)
    const session = yield* opencode.session.create({ title: "Step limit fixture",
      location: { directory: Location.PublicRef.fields.directory.make(directory) },
      model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }) })
    yield* opencode.session.prompt({ sessionID: session.id,
      text: "Call lookup once. After seeing its result, call lookup again to verify it. Finally report the marker." })
    yield* opencode.session.wait({ sessionID: session.id })
    expect(calls).toBe(1)
    const history = yield* opencode.session.export({ sessionID: session.id })
    const reply = history.messages.findLast((message) => message.type === "assistant")!
    expect(reply.error).toBeUndefined()
    expect(JSON.stringify(reply)).toContain("STEP-OTTER")
    const runs = recorder.lines.filter((line) => line.from === "spawn" && line.args.includes("--include-partial-messages"))
    expect(runs).toHaveLength(2)
    expect(recorder.sessionIDs.size).toBe(1)
    const users = recorder.lines.filter((line) => line.from === "sdk" && line.message.type === "user")
    expect(JSON.stringify(users.at(-1))).toContain("MAXIMUM STEPS REACHED")
    const init = recorder.lines.filter((line) => line.from === "sdk" && line.message.request?.subtype === "initialize").at(-1)!
    if (init.from === "sdk") expect(init.message.request.sdkMcpServers).toBeUndefined()
    console.log("Live max-step model calls: 2")
  }), 60_000)

  it.live("reads, approves an edit, rejects another, and follows the next user message", () => Effect.gen(function* () {
    const directory = yield* TestOpenCode.tempDirectory
    yield* Effect.promise(() => Bun.write(`${directory}/marker.txt`, "OLD-OTTER\n"))
    const recorder = Recorder.make("opencode-tools", true)
    const registry = ClaudeSessions.registry()
    yield* Effect.addFinalizer(() => registry.close().pipe(Effect.andThen(Effect.promise(async () => {
      recorder.save()
      for (const id of recorder.sessionIDs) await deleteSession(id, { dir: directory })
    }))))
    const called: string[] = []
    const plugin = define({ id: "live-tools-fixture", effect: Effect.fn(function* (ctx) {
      yield* ctx.session.hook("title", (event) => Effect.sync(() => { event.result = "Live tools fixture" }))
      yield* ctx.session.hook("context", (event) => Effect.sync(() => {
        for (const name of Object.keys(event.tools)) if (name !== "read" && name !== "edit") delete event.tools[name]
      }))
      yield* ctx.permission.hook("evaluate", (event) => Effect.sync(() => { if (event.action === "edit") event.effect = "ask" }))
      yield* ctx.tool.hook("execute.before", (event) => Effect.sync(() => { called.push(event.tool) }))
    }) })
    const test = yield* TestOpenCode.start({ directory, io: { ...ClaudeIO.real, spawn: recorder.spawn }, registry, plugins: [plugin] })
    yield* TestOpenCode.connect(test.opencode)
    const session = yield* test.opencode.session.create({ title: "Live tools fixture", location: { directory: Location.PublicRef.fields.directory.make(directory) },
      model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }) })
    yield* test.opencode.session.prompt({ sessionID: session.id,
      text: "Read marker.txt. Then use edit to replace OLD-OTTER with EDITED-OTTER in that file. After the edit, reply only with EDITED-OTTER." })
    const requests = yield* TestOpenCode.waitUntil(test.opencode.permission.list({ sessionID: session.id }), (requests) => requests.length > 0)
    expect(yield* Effect.promise(() => Bun.file(`${directory}/marker.txt`).text())).toBe("OLD-OTTER\n")
    yield* test.opencode.permission.reply({ sessionID: session.id, requestID: requests[0]!.id, decision: "once" })
    yield* test.opencode.session.wait({ sessionID: session.id })
    expect(yield* Effect.promise(() => Bun.file(`${directory}/marker.txt`).text())).toBe("EDITED-OTTER\n")
    expect(called).toContain("read")
    expect(called).toContain("edit")
    const history = yield* test.opencode.session.export({ sessionID: session.id })
    const assistants = history.messages.filter((message) => message.type === "assistant")
    let approvedText = ""
    for (const part of assistants.at(-1)!.content) if (part.type === "text") approvedText += part.text
    expect(approvedText.trim()).toBe("EDITED-OTTER")

    yield* test.opencode.session.prompt({ sessionID: session.id,
      text: "Use edit to replace EDITED-OTTER with DENIED-OTTER in marker.txt. Do not use other tools. If the edit is refused, stop and do not retry." })
    const denied = yield* TestOpenCode.waitUntil(test.opencode.permission.list({ sessionID: session.id }), (requests) => requests.length > 0)
    expect(yield* Effect.promise(() => Bun.file(`${directory}/marker.txt`).text())).toBe("EDITED-OTTER\n")
    // No feedback: OpenCode ends this turn, as it does for Reject in the TUI.
    yield* test.opencode.permission.reply({ sessionID: session.id, requestID: denied[0]!.id, decision: "reject" })
    yield* test.opencode.session.wait({ sessionID: session.id })
    expect(yield* Effect.promise(() => Bun.file(`${directory}/marker.txt`).text())).toBe("EDITED-OTTER\n")
    const callsBeforeFollowup = called.length
    yield* test.opencode.session.prompt({ sessionID: session.id,
      text: "The rejected edit must remain rejected. Do not call any tools. Reply only DENIAL-RECOVERED." })
    yield* test.opencode.session.wait({ sessionID: session.id })
    const after = yield* test.opencode.session.export({ sessionID: session.id })
    const replies = after.messages.filter((message) => message.type === "assistant")
    const reply = replies.at(-1)!
    let text = ""
    for (const part of reply.content) if (part.type === "text") text += part.text
    expect(text.trim()).toBe("DENIAL-RECOVERED")
    const inputs = recorder.lines.filter((line) => line.from === "sdk")
    const followup = inputs.findLast((line) => line.message.type === "user")!.message
    expect(followup.priority).toBeUndefined()
    expect(JSON.stringify(followup.message.content)).toContain("The user declined this tool call")
    expect(inputs.some((line) => line.message.request?.subtype === "interrupt")).toBe(true)
    expect(called).toHaveLength(callsBeforeFollowup)
    expect(yield* Effect.promise(() => Bun.file(`${directory}/marker.txt`).text())).toBe("EDITED-OTTER\n")
    console.log(`Live OpenCode read/edit/rejection model steps: ${replies.length}`)
  }), 60_000)
})
