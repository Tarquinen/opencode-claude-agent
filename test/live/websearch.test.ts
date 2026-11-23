import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { ClaudeIO } from "../../src/claude/io.js"
import { ClaudeWebSearch } from "../../src/claude/websearch.js"
import { it } from "../lib/effect.js"
import { Recorder } from "../lib/recorder.js"

const live =
  !process.env.CI && process.env.CLAUDE_LIVE === "1" && Bun.spawnSync(["claude", "auth", "status"]).exitCode === 0

describe.skipIf(!live)("web search against the real claude", () => {
  it.live(
    "returns links and Claude's summary",
    () =>
      Effect.gen(function* () {
        const executable = ClaudeIO.real.which()
        if (!executable) throw new Error("claude is not on PATH")
        const recorder = Recorder.make("websearch")
        const found = yield* ClaudeWebSearch.search({
          executable,
          io: { ...ClaudeIO.real, spawn: recorder.spawn },
          query: "Node.js release schedule",
        })
        recorder.save()
        expect(found.length).toBeGreaterThan(0)
        expect(found[0]?.content?.length).toBeGreaterThan(0)
      }),
    90_000,
  )
})
