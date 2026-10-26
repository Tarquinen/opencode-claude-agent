import { describe, expect } from "bun:test"
import { deleteSession, getSessionMessages } from "@anthropic-ai/claude-agent-sdk"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { Effect } from "effect"
import { ClaudeIO } from "../../src/claude/io.js"
import { ClaudeSessions } from "../../src/claude/sessions.js"
import { ClaudeStatus } from "../../src/claude/status.js"
import { SessionRecord } from "../../src/sync/record.js"
import { it } from "../lib/effect.js"
import { Recorder } from "../lib/recorder.js"
import { TestOpenCode } from "../lib/opencode.js"
import { TestSessions } from "../lib/sessions.js"

const live =
  !process.env.CI && process.env.CLAUDE_LIVE === "1" && Bun.spawnSync(["claude", "auth", "status"]).exitCode === 0

describe.skipIf(!live)("history sync against real Claude", () => {
  it.live(
    "remembers other-model/tool history and rebuilds after its transcript is deleted",
    () =>
      Effect.gen(function* () {
        const directory = yield* TestOpenCode.tempDirectory
        const storage = TestSessions.storage()
        const records = SessionRecord.make(storage)
        const recorder = Recorder.make("sync")
        const registry = ClaudeSessions.registry()
        yield* Effect.addFinalizer(() =>
          registry.close().pipe(
            Effect.andThen(
              Effect.promise(async () => {
                recorder.save()
                for (const id of storage.ids) await deleteSession(id, { dir: directory })
                console.log("Live sync model calls: 3")
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
        const model = yield* TestSessions.model(sessions)
        const history: LanguageModelV3Prompt = [
          { role: "user", content: [{ type: "text", text: "Give me a marker." }] },
          { role: "assistant", content: [{ type: "text", text: "My marker is LILAC-HERON." }] },
        ]
        const ask = Effect.fn(function* (text: string) {
          history.push({ role: "user", content: [{ type: "text", text }] })
          const parts = yield* TestSessions.reply(model, history)
          const error = parts.find((part) => part.type === "error")
          if (error) throw error.error
          const reply = TestSessions.text(parts)
          const end = parts.find((part) => part.type === "text-end")
          expect(end?.providerMetadata?.["claude-agent"]).toMatchObject({
            sessionID: expect.any(String),
            messageID: expect.any(String),
          })
          history.push({ role: "assistant", content: [{ type: "text", text: reply }] })
          return reply
        })
        expect(yield* ask("Remember COPPER-OTTER too. Reply only with COPPER-OTTER.")).toContain("COPPER-OTTER")
        const original = (yield* records.get("session-a"))!.claudeSessionID
        history.push(
          { role: "user", content: [{ type: "text", text: "Read the marker file." }] },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "marker-read", toolName: "read", input: { path: "marker.txt" } },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "marker-read",
                toolName: "read",
                output: { type: "text", value: "LEMON-IBIS" },
              },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "I read the file successfully." }] },
        )
        const caughtUp = yield* ask(
          "List all three markers from our conversation, including the file. Output only the markers.",
        )
        for (const marker of ["LILAC-HERON", "COPPER-OTTER", "LEMON-IBIS"]) expect(caughtUp).toContain(marker)
        expect((yield* records.get("session-a"))!.claudeSessionID).toBe(original)
        yield* registry.close()
        const transcript = yield* Effect.promise(() => getSessionMessages(original, { dir: directory }))
        const uuids = new Set(transcript.map((message) => message.uuid))
        for (const checkpoint of (yield* records.get("session-a"))!.history!) {
          if (checkpoint.claudeMessageID) expect(uuids.has(checkpoint.claudeMessageID)).toBe(true)
        }
        expect(yield* Effect.promise(() => ClaudeIO.real.sessionExists(original))).toBe(true)
        yield* Effect.promise(() => deleteSession(original, { dir: directory }))
        storage.ids.delete(original)
        const invalid: LanguageModelV3Prompt = [
          ...history,
          {
            role: "user",
            content: [
              { type: "text", text: "Inspect this image" },
              { type: "file", mediaType: "image/svg+xml", data: "PHN2Zy8+" },
            ],
          },
        ]
        const error = yield* TestSessions.reply(model, invalid).pipe(Effect.flip)
        expect(String(error.cause)).toContain("Claude Code does not support image/svg+xml attachments")
        const rebuilt = yield* ask("Repeat those three markers. Output only the markers.")
        for (const marker of ["LILAC-HERON", "COPPER-OTTER", "LEMON-IBIS"]) expect(rebuilt).toContain(marker)
        expect((yield* records.get("session-a"))!.claudeSessionID).not.toBe(original)
      }),
    90_000,
  )
})
