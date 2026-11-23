import { describe, expect } from "bun:test"
import os from "node:os"
import path from "node:path"
import { Model, WebSearch } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { ClaudeProvider } from "../../src/plugin/provider.js"
import { it } from "../lib/effect.js"
import { FakeClaude } from "../lib/fake-claude.js"
import { FakeIO } from "../lib/fake-io.js"
import { TestOpenCode } from "../lib/opencode.js"

const providerID = WebSearch.ID.make(ClaudeProvider.ID)

const offered = (opencode: TestOpenCode.Client) =>
  Effect.map(opencode.websearch.providers(), (list) => list.data.some((provider) => provider.id === providerID))

describe("opencode web search", () => {
  it.live("offers Claude's search only while connected, and runs it in a claude with no other tool", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([FakeClaude.expectTurn({ recording: "websearch" })], { probes: true })
      const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }) })
      expect(yield* offered(test.opencode)).toBe(false)

      yield* TestOpenCode.connect(test.opencode)
      yield* TestOpenCode.waitUntil(offered(test.opencode), (offered) => offered)
      const found = yield* test.opencode.websearch.query({ query: "Node.js release schedule", providerID })
      expect(found.data.results[0]?.title).toStartWith("Summary of all results below, written by Claude")
      expect(found.data.results[0]?.content).toContain("Node.js")
      expect(found.data.results.length).toBeGreaterThan(1)
      const search = claude.runs.find((run) => run.args.includes("--tools=WebSearch"))
      expect(search?.args).toContain("--no-session-persistence")

      for (const credential of yield* test.opencode.credential.list()) {
        yield* test.opencode.credential.remove({ credentialID: credential.id })
      }
      yield* TestOpenCode.waitUntil(offered(test.opencode), (offered) => !offered)
      claude.check()
    }),
  )

  it.live("searches on the account folder chats used last", () =>
    Effect.gen(function* () {
      const directory = yield* TestOpenCode.tempDirectory
      const database = path.join(directory, "test.db")
      const config = (configDir: string[]) => ({ providers: { "claude-agent": { settings: { configDir } } } })

      const chat = FakeClaude.make(
        [FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt()],
        { probes: true },
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const test = yield* TestOpenCode.start({
            io: FakeIO.make({ claude: chat }),
            directory,
            database,
            config: config(["~/.claude-a", "~/.claude-b"]),
          })
          yield* TestOpenCode.connect(test.opencode)
          yield* TestOpenCode.waitUntil(TestOpenCode.models(test.opencode), (ids) => ids.includes("haiku"))
          yield* test.opencode.generate.text({
            prompt: "hello",
            model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }),
          })
        }),
      )

      // The folders swap places, so the first one is no longer the one the chat ran on
      const claude = FakeClaude.make([FakeClaude.expectTurn({ recording: "websearch" })], { probes: true })
      const test = yield* TestOpenCode.start({
        io: FakeIO.make({ claude }),
        directory,
        database,
        config: config(["~/.claude-b", "~/.claude-a"]),
      })
      yield* TestOpenCode.waitUntil(offered(test.opencode), (offered) => offered)
      yield* test.opencode.websearch.query({ query: "Node.js release schedule", providerID })
      const search = claude.runs.find((run) => run.args.includes("--tools=WebSearch"))
      expect(search?.env.CLAUDE_CONFIG_DIR).toBe(path.join(os.homedir(), ".claude-a"))
    }),
  )
})
