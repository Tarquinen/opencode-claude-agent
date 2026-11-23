import { describe, expect } from "bun:test"
import { WebSearch } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { ClaudeProvider } from "../../src/plugin/provider.js"
import { it } from "../lib/effect.js"
import { FakeClaude } from "../lib/fake-claude.js"
import { FakeIO } from "../lib/fake-io.js"
import { TestOpenCode } from "../lib/opencode.js"

describe("opencode web search", () => {
  it.live("offers Claude's search only while connected, and runs it in a claude with no other tool", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([FakeClaude.expectTurn({ recording: "websearch" })], { probes: true })
      const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }) })
      const providerID = WebSearch.ID.make(ClaudeProvider.ID)
      const offered = Effect.map(test.opencode.websearch.providers(), (list) =>
        list.data.some((provider) => provider.id === providerID),
      )
      expect(yield* offered).toBe(false)

      yield* TestOpenCode.connect(test.opencode)
      yield* TestOpenCode.waitUntil(offered, (offered) => offered)
      const found = yield* test.opencode.websearch.query({ query: "Node.js release schedule", providerID })
      expect(found.data.results[0]?.title).toStartWith("Summary of all results below, written by Claude")
      expect(found.data.results[0]?.content).toContain("Node.js")
      expect(found.data.results.length).toBeGreaterThan(1)
      const search = claude.runs.find((run) => run.args.includes("--tools=WebSearch"))
      expect(search?.args).toContain("--no-session-persistence")

      for (const credential of yield* test.opencode.credential.list()) {
        yield* test.opencode.credential.remove({ credentialID: credential.id })
      }
      yield* TestOpenCode.waitUntil(offered, (offered) => !offered)
      claude.check()
    }),
  )
})
