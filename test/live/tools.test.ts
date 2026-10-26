import { describe, expect } from "bun:test"
import { deleteSession, getSessionMessages } from "@anthropic-ai/claude-agent-sdk"
import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider"
import { Effect } from "effect"
import { ClaudeIO } from "../../src/claude/io.js"
import { ClaudeSessions } from "../../src/claude/sessions.js"
import { ClaudeStatus } from "../../src/claude/status.js"
import { it } from "../lib/effect.js"
import { Recorder } from "../lib/recorder.js"
import { TestOpenCode } from "../lib/opencode.js"
import { TestSessions } from "../lib/sessions.js"
import { TestTools } from "../lib/tools.js"
import { SessionRecord } from "../../src/sync/record.js"

const live =
  !process.env.CI && process.env.CLAUDE_LIVE === "1" && Bun.spawnSync(["claude", "auth", "status"]).exitCode === 0

const setup = Effect.fn(function* (name: string, capture = false) {
  const directory = yield* TestOpenCode.tempDirectory
  const storage = TestSessions.storage()
  const registry = ClaudeSessions.registry()
  const recorder = Recorder.make(name, capture)
  yield* Effect.addFinalizer(() =>
    registry.close().pipe(
      Effect.andThen(
        Effect.promise(async () => {
          recorder.save()
          for (const id of storage.ids) await deleteSession(id, { dir: directory })
        }),
      ),
    ),
  )
  const sessions = yield* registry.attach({
    io: { ...ClaudeIO.real, spawn: recorder.spawn },
    status: yield* ClaudeStatus.make(ClaudeIO.real, () => Effect.succeed({})),
    storage,
    directory,
  })
  return { directory, storage, registry, recorder, model: yield* TestSessions.model(sessions) }
})

describe.skipIf(!live)("tools against real Claude", () => {
  it.live(
    "interrupts an entered MCP handler, records refusals and continues on the same process",
    () =>
      Effect.gen(function* () {
        const directory = yield* TestOpenCode.tempDirectory
        const recorder = Recorder.make("tools-waiting-cancel", true)
        // Registered before park(), so its process is stopped before transcript cleanup.
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            recorder.save()
            for (const id of recorder.sessionIDs) await deleteSession(id, { dir: directory })
          }),
        )
        const parked = yield* TestTools.park({ ...ClaudeIO.real, spawn: recorder.spawn }, directory)
        yield* Effect.promise(() => parked.session.interrupt())
        parked.pending.clear()
        yield* Effect.promise(() => parked.settled)
        const transcript = yield* Effect.promise(() => getSessionMessages(parked.session.id, { dir: directory }))
        expect(JSON.stringify(transcript)).toContain('"is_error":true')
        const result = yield* Effect.promise(() =>
          TestSessions.send(parked.session, "Do not call tools. Reply only with WAITING-OTTER."),
        )
        expect(result.subtype).toBe("success")
        if (result.subtype === "success") expect(result.result.trim()).toBe("WAITING-OTTER")
        console.log("Live waiting-handler cancellation model calls: 2")
      }),
    60_000,
  )

  it.live(
    "parks two consecutive tool steps, including multiple calls in one reply",
    () =>
      Effect.gen(function* () {
        const test = yield* setup("tools")
        const prompt = TestTools.prompt()
        const first = yield* TestTools.step(test.model, prompt)
        expect(first.filter((part) => part.type === "tool-call")).toHaveLength(2)
        expect(first.find((part) => part.type === "finish")?.finishReason.unified).toBe("tool-calls")
        expect(test.storage.ids.size).toBe(1)
        TestTools.append(prompt, first, TestTools.output)
        const second = yield* TestTools.step(test.model, prompt)
        const call = second.find((part) => part.type === "tool-call")!
        expect(call.toolName).toBe("confirm")
        expect(call.input).toContain("LILAC-HERON")
        expect(call.input).toContain("LEMON-IBIS")
        TestTools.append(prompt, second, TestTools.output)
        const last = yield* TestTools.step(test.model, prompt)
        expect(TestSessions.text(last)).toContain("COPPER-OTTER")
        expect(last.find((part) => part.type === "finish")?.finishReason.unified).toBe("stop")
        expect(test.storage.ids.size).toBe(1)
        yield* test.registry.close()
        const record = (yield* SessionRecord.make(test.storage).get("session-a"))!
        const transcript = yield* Effect.promise(() =>
          getSessionMessages(record.claudeSessionID, { dir: test.directory }),
        )
        for (const checkpoint of record.history!)
          if (checkpoint.claudeMessageID) {
            expect(transcript.some((message) => message.uuid === checkpoint.claudeMessageID)).toBe(true)
          }
        console.log("Live tools model calls: 3")
      }),
    60_000,
  )

  it.live(
    "delivers tool images/PDFs, refreshes the catalog, and preserves a denial",
    () =>
      Effect.gen(function* () {
        const test = yield* setup("tools-media")
        const tools: LanguageModelV3FunctionTool[] = [
          {
            type: "function",
            name: "attachment",
            description: "Get the fixture image and PDF.",
            inputSchema: { type: "object", properties: {} },
          },
        ]
        const prompt = TestSessions.prompt(
          "Call attachment once. Report the image color and the marker from its PDF. Be brief.",
        )
        const first = yield* TestTools.step(test.model, prompt, tools)
        expect(first.find((part) => part.type === "tool-call")?.toolName).toBe("attachment")
        TestTools.append(prompt, first, () => ({ type: "text", value: "Read the attached image and PDF." }))
        const image = yield* Effect.promise(() => Bun.file(new URL("../fixtures/red.png", import.meta.url)).bytes())
        const pdf = yield* Effect.promise(() => Bun.file(new URL("../fixtures/marker.pdf", import.meta.url)).bytes())
        prompt.push({
          role: "user",
          content: [
            { type: "text", text: "Attached media from tool result:" },
            { type: "file", mediaType: "image/png", data: image },
            { type: "file", mediaType: "application/pdf", data: pdf },
          ],
        })
        const second = yield* TestTools.step(test.model, prompt, tools)
        expect(TestSessions.text(second).toLowerCase()).toContain("red")
        expect(TestSessions.text(second)).toContain("LEMON-IBIS")
        TestTools.append(prompt, second, TestTools.output)
        const name = "restricted_" + "resource_".repeat(12)
        const changed = [
          { ...tools[0]!, name, description: "Read a restricted fixture. Call once; do not retry if denied." },
        ]
        prompt.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "Call the restricted fixture tool once. If denied, reply with the denial's marker; do not retry.",
            },
          ],
        })
        const third = yield* TestTools.step(test.model, prompt, changed)
        expect(third.find((part) => part.type === "tool-call")?.toolName).toBe(name)
        TestTools.append(prompt, third, () => ({
          type: "execution-denied",
          reason: "Permission denied: DENIED-IBIS. Do not retry.",
        }))
        const last = yield* TestTools.step(test.model, prompt, changed)
        expect(TestSessions.text(last)).toContain("DENIED-IBIS")
        expect(test.storage.ids.size).toBe(1)
        console.log("Live media/denial model calls: 4")
      }),
    60_000,
  )

  it.live(
    "interrupts a waiting tool turn before shutdown and resumes a usable session",
    () =>
      Effect.gen(function* () {
        const test = yield* setup("tools-cancel")
        const prompt = TestTools.prompt()
        const first = yield* TestTools.step(test.model, prompt)
        expect(first.some((part) => part.type === "tool-call")).toBe(true)
        yield* test.registry.close()
        TestTools.append(prompt, first, () => ({ type: "execution-denied", reason: "Cancelled by user." }))
        prompt.push({
          role: "user",
          content: [{ type: "text", text: "Do not call any tools. Reply only with CANCELLED-OTTER." }],
        })
        const last = yield* TestTools.step(test.model, prompt)
        expect(TestSessions.text(last).trim()).toBe("CANCELLED-OTTER")
        expect(last.some((part) => part.type === "tool-call")).toBe(false)
        expect(test.storage.ids.size).toBe(1)
        console.log("Live tool cancellation model calls: 2")
      }),
    60_000,
  )

  it.live(
    "active-turn steering uses the SDK queue alongside tool feedback",
    () =>
      Effect.gen(function* () {
        const test = yield* setup("tools-continue")
        const prompt = TestTools.prompt()
        const first = yield* TestTools.step(test.model, prompt)
        expect(first.some((part) => part.type === "tool-call")).toBe(true)
        TestTools.append(prompt, first, () => ({ type: "execution-denied", reason: "Cancelled by user." }))
        prompt.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "The calls were cancelled. Do not call any more tools. Reply only with CONTINUED-OTTER.",
            },
          ],
        })
        const last = yield* TestTools.step(test.model, prompt)
        expect(TestSessions.text(last).trim()).toBe("CONTINUED-OTTER")
        expect(last.some((part) => part.type === "tool-call")).toBe(false)
        expect(test.storage.ids.size).toBe(1)
        console.log("Live steering model calls: 2")
      }),
    60_000,
  )

  it.live(
    "an aborted OpenCode tool ends the Claude turn before the next user message",
    () =>
      Effect.gen(function* () {
        const test = yield* setup("tools-abort", true)
        const prompt = TestTools.prompt()
        const first = yield* TestTools.step(test.model, prompt)
        expect(first.some((part) => part.type === "tool-call")).toBe(true)
        TestTools.append(prompt, first, () => ({ type: "execution-denied", reason: "Cancelled by user." }), {
          "claude-agent": { toolError: true, toolAborted: true },
        })
        prompt.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "The calls were cancelled. Do not call any more tools. Reply only with CONTINUED-OTTER.",
            },
          ],
        })
        const last = yield* TestTools.step(test.model, prompt)
        expect(TestSessions.text(last).trim()).toBe("CONTINUED-OTTER")
        expect(last.some((part) => part.type === "tool-call")).toBe(false)
        const inputs = test.recorder.lines.filter((line) => line.from === "sdk")
        const user = inputs.findLast((line) => line.message.type === "user")!.message
        expect(user.priority).toBeUndefined()
        expect(JSON.stringify(user.message.content)).toContain("Cancelled by user.")
        expect(inputs.filter((line) => line.message.request?.subtype === "interrupt")).toHaveLength(1)
        expect(test.recorder.lines.filter((line) => line.from === "spawn")).toHaveLength(1)
        expect(test.storage.ids.size).toBe(1)
        yield* test.registry.close()
        const record = (yield* SessionRecord.make(test.storage).get("session-a"))!
        const transcript = yield* Effect.promise(() =>
          getSessionMessages(record.claudeSessionID, { dir: test.directory }),
        )
        for (const checkpoint of record.history!)
          if (checkpoint.claudeMessageID) {
            expect(transcript.some((message) => message.uuid === checkpoint.claudeMessageID)).toBe(true)
          }
        console.log("Live aborted-turn model calls: 2")
      }),
    60_000,
  )
})
