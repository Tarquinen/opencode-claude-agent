import { describe, expect, test } from "bun:test"
import { ClaudeIO } from "../../src/claude/io.js"
import { ClaudeWebSearch } from "../../src/claude/websearch.js"

// Needs a real, logged-in `claude`, and uses one search of plan usage. Run with `bun run test:live`.
const live =
  !process.env.CI && process.env.CLAUDE_LIVE === "1" && Bun.spawnSync(["claude", "auth", "status"]).exitCode === 0

describe.skipIf(!live)("web search against the real claude", () => {
  test("returns links and Claude's summary, without repeating a page", async () => {
    const executable = ClaudeIO.real.which()
    if (!executable) throw new Error("claude is not on PATH")
    const options = ClaudeWebSearch.options({ executable, io: ClaudeIO.real, model: ClaudeWebSearch.DEFAULT_MODEL })
    const found = await ClaudeWebSearch.search({ query: "Node.js release schedule", options })
    expect(found.length).toBeGreaterThan(0)
    for (const result of found) expect(new URL(result.url).protocol).toBe("https:")
    expect(found[0]?.content?.length).toBeGreaterThan(0)
    const urls = found.map((result) => result.url)
    for (const [i, url] of urls.entries()) {
      expect(urls.slice(i + 1).some((other) => ClaudeWebSearch.samePage(url, other))).toBe(false)
    }
  }, 90_000)

  test("stops when cancelled", async () => {
    const executable = ClaudeIO.real.which()
    if (!executable) throw new Error("claude is not on PATH")
    const options = ClaudeWebSearch.options({ executable, io: ClaudeIO.real, model: ClaudeWebSearch.DEFAULT_MODEL })
    const signal = AbortSignal.abort()
    await expect(ClaudeWebSearch.search({ query: "Node.js release schedule", options, signal })).rejects.toThrow()
  })
})
