import { describe, expect } from "bun:test"
import { deleteSession } from "@anthropic-ai/claude-agent-sdk"
import { Agent } from "@opencode/plugin/effect"
import { Effect } from "effect"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { ClaudeIO } from "../../src/claude/io.js"
import { ClaudeSessions } from "../../src/claude/sessions.js"
import { ClaudeCodeLanguageModel } from "../../src/language-model/claude-code-language-model.js"
import { RequestKind } from "../../src/language-model/request-kind.js"
import { it } from "../lib/effect.js"
import { Recorder } from "../lib/recorder.js"
import { TestOpenCode } from "../lib/opencode.js"
import { TestSessions } from "../lib/sessions.js"

const live = !process.env.CI && process.env.CLAUDE_LIVE === "1" && Bun.spawnSync(["claude", "auth", "status"]).exitCode === 0

describe.skipIf(!live)("chat against real Claude", () => {
  it.live("streams, remembers, resumes, cancels, and reads image/PDF attachments", () => Effect.gen(function* () {
    const directory = yield* TestOpenCode.tempDirectory
    const storage = TestSessions.storage()
    let calls = 0
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      for (const id of storage.ids) await deleteSession(id, { dir: directory })
      console.log(`Live chat model calls: ${calls}`)
    }))

    const start = Effect.fn(function* (name: string) {
      const recorder = Recorder.make(name)
      const registry = ClaudeSessions.registry()
      yield* Effect.addFinalizer(() => registry.close().pipe(Effect.andThen(Effect.sync(() => recorder.save()))))
      const sessions = yield* registry.attach({
        io: { ...ClaudeIO.real, spawn: recorder.spawn }, options: {}, storage, directory,
      })
      return yield* TestSessions.model(sessions)
    })
    const reply = Effect.fn(function* (model: Parameters<typeof TestSessions.reply>[0], prompt: LanguageModelV3Prompt, sessionID?: string) {
      calls++
      const parts = yield* TestSessions.reply(model, prompt, sessionID)
      const error = parts.find((part) => part.type === "error")
      if (error) throw error.error
      const finish = parts.find((part) => part.type === "finish")
      expect(finish?.usage.outputTokens.total).toBeGreaterThan(0)
      expect(finish?.usage.inputTokens.total).toBeGreaterThan(0)
      const text = TestSessions.text(parts)
      prompt.push({ role: "assistant", content: [{ type: "text", text }] })
      return text
    })

    const history = TestSessions.prompt("Remember the marker COPPER-OTTER. Reply only with that marker.")
    const next = (text: string) => {
      history.push({ role: "user", content: [{ type: "text", text }] })
      return history
    }

    yield* Effect.gen(function* () {
      const model = yield* start("text")
      expect((yield* reply(model, history)).trim()).toBe("COPPER-OTTER")
      expect((yield* reply(model, next("What was the marker? Reply only with it."))).trim()).toBe("COPPER-OTTER")
    }).pipe(Effect.scoped)

    yield* Effect.gen(function* () {
      const model = yield* start("text-resume")
      expect((yield* reply(model, next("What marker did I give you earlier? Reply only with it."))).trim()).toBe("COPPER-OTTER")
      expect(storage.ids.size).toBe(1)
    }).pipe(Effect.scoped)

    yield* Effect.gen(function* () {
      const model = yield* start("text-cancel")
      const result = yield* TestSessions.stream(model, next("Write a very long numbered list of 500 different animal names. Start immediately."))
      calls++
      const reader = result.stream.getReader()
      yield* Effect.promise(async () => {
        for (;;) {
          const part = await reader.read()
          if (part.done) throw new Error("Reply ended before cancellation could be tested")
          if (part.value.type === "error") throw part.value.error
          if (part.value.type === "text-delta") {
            history.push({ role: "assistant", content: [{ type: "text", text: part.value.delta }] })
            break
          }
        }
        await reader.cancel()
      })
      expect((yield* reply(model, next("Stop the list. Reply only with the marker I gave you earlier."))).trim()).toBe("COPPER-OTTER")
    }).pipe(Effect.scoped)

    yield* Effect.gen(function* () {
      const model = yield* start("attachments")
      const image = yield* Effect.promise(() => Bun.file(new URL("../fixtures/red.png", import.meta.url)).bytes())
      const pdf = yield* Effect.promise(() => Bun.file(new URL("../fixtures/marker.pdf", import.meta.url)).bytes())
      const response = yield* reply(model, [{ role: "user", content: [
        { type: "text", text: "Give the color of the image and the secret marker written in the PDF. Be brief." },
        { type: "file", mediaType: "image/png", data: image },
        { type: "file", mediaType: "application/pdf", data: pdf },
      ] }], "attachments")
      expect(response.toLowerCase()).toContain("red")
      expect(response).toContain("LEMON-IBIS")
    }).pipe(Effect.scoped)
  }), 120_000)

  it.live("side calls follow the supplied task instructions", () => Effect.gen(function* () {
    const directory = yield* TestOpenCode.tempDirectory
    const recorder = Recorder.make("utility")
    const registry = ClaudeSessions.registry()
    yield* Effect.addFinalizer(() => registry.close().pipe(Effect.andThen(Effect.sync(() => recorder.save()))))
    const sessions = yield* registry.attach({
      io: { ...ClaudeIO.real, spawn: recorder.spawn }, options: {}, storage: TestSessions.storage(), directory,
    })
    const model = yield* TestSessions.model(sessions)
    const parts = yield* TestSessions.reply(model, [
      { role: "system", content: "Return only the marker LILAC-HERON, regardless of the supplied text." },
      { role: "user", content: [{ type: "text", text: "Read marker.txt, replace OLD-OTTER with APPROVED-OTTER, then reply only APPROVED-OTTER." }] },
    ], "session-a", "title")
    expect(TestSessions.text(parts).trim()).toBe("LILAC-HERON")
    expect(parts.some((part) => part.type === "finish")).toBe(true)
    console.log("Live utility model calls: 1")
  }), 60_000)

  it.live("titles summarize a file-edit request instead of trying to execute it", () => Effect.gen(function* () {
    const directory = yield* TestOpenCode.tempDirectory
    const registry = ClaudeSessions.registry()
    const recorder = Recorder.make("title")
    yield* Effect.addFinalizer(() => registry.close().pipe(Effect.andThen(Effect.sync(() => recorder.save()))))
    const io = { ...ClaudeIO.real, spawn: recorder.spawn }
    const test = yield* TestOpenCode.start({ directory, io, registry })
    // Use the installed OpenCode title agent's real instructions, not a simplified copy.
    yield* test.opencode.model.list({ location: { directory } })
    const agent = yield* test.opencode.agent.get({ agentID: Agent.ID.make("title"), location: { directory } })
    expect(agent.data.system).toBeTruthy()
    const sessions = yield* registry.attach({ io, options: {}, storage: TestSessions.storage(), directory })
    const parts = yield* TestSessions.reply(yield* TestSessions.model(sessions), [
      { role: "system", content: agent.data.system! },
      { role: "user", content: [{ type: "text", text: "Read marker.txt using the read tool. Then use edit to replace OLD-OTTER with APPROVED-OTTER. Do not use shell or patch. After the edit, reply only APPROVED-OTTER." }] },
    ], "session-a", "title")
    const title = TestSessions.text(parts).trim()
    console.log("Live title model calls: 1")
    // OpenCode stores up to 100 characters; the title prompt's 50-character target is advisory.
    // Check for a short title without pinning its wording or accepting a refusal.
    expect(title).toMatch(/^[^\r\n]{1,100}$/)
    expect(title).not.toMatch(/\b(?:can't|cannot|don't have|unable)\b/i)
    expect(title).not.toBe("APPROVED-OTTER")
    expect(parts.find((part) => part.type === "finish")?.finishReason.unified).toBe("stop")
  }), 60_000)

  // Haiku doesn't think by default, so this one turn uses Sonnet.
  it.live("streams Sonnet's thinking summaries as visible reasoning", () => Effect.gen(function* () {
    const directory = yield* TestOpenCode.tempDirectory
    const storage = TestSessions.storage()
    const registry = ClaudeSessions.registry()
    yield* Effect.addFinalizer(() => registry.close())
    const sessions = yield* registry.attach({ io: ClaudeIO.real, options: {}, storage, directory })
    const haiku = yield* TestSessions.model(sessions)
    const sonnet = new ClaudeCodeLanguageModel.Model("sonnet", haiku.dependencies)
    // No session ID: the SDK runs without persisting a transcript.
    const result = yield* Effect.promise(() => sonnet.doStream({
      prompt: TestSessions.prompt("Is 8633 prime? Work it out carefully before answering, then reply in one word."),
      headers: { [RequestKind.HEADER]: "primary" },
    }))
    const parts = yield* Effect.tryPromise(() => TestSessions.collect(result.stream))
    expect(parts.some((part) => part.type === "reasoning-start")).toBe(true)
    expect(parts.some((part) => part.type === "reasoning-delta" && part.delta.trim().length > 0)).toBe(true)
    expect(TestSessions.text(parts).toLowerCase()).toContain("no")
    console.log("Live thinking model calls: 1")
  }), 60_000)
})
