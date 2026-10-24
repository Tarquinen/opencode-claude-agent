import { describe, expect } from "bun:test"
import { Model } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { ClaudeProvider } from "../../src/plugin/provider.js"
import { it } from "../lib/effect.js"
import { FakeClaude } from "../lib/fake-claude.js"
import { FakeIO } from "../lib/fake-io.js"
import { TestOpenCode } from "../lib/opencode.js"

describe("opencode provider config", () => {
  it.live("passes the configured connection to Claude Code, for the login check and for chats", () =>
    Effect.gen(function* () {
      // The login check is answered by `probes`, so the script is only the chat
      const claude = FakeClaude.make(
        [FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt()],
        { probes: true },
      )
      const test = yield* TestOpenCode.start({
        io: FakeIO.make({ claude, env: { ANTHROPIC_BASE_URL: "https://from-shell.example" } }),
        config: {
          providers: {
            "claude-agent": {
              settings: {
                baseURL: "https://gateway.example",
                authToken: "config-token",
                headerTimeout: 60000,
                chunkTimeout: 600000,
              },
              headers: { "X-Team": "core" },
              body: { metadata: { user_id: "dan" } },
              models: {
                haiku: { settings: { baseURL: "https://haiku-gateway.example" }, headers: { "X-Model": "haiku" } },
              },
            },
          },
        },
      })
      yield* TestOpenCode.connect(test.opencode)
      yield* TestOpenCode.waitUntil(TestOpenCode.models(test.opencode), (ids) => ids.includes("sonnet"))

      const check = claude.runs[0]!.env
      expect(check.ANTHROPIC_BASE_URL).toBe("https://gateway.example")
      expect(check.ANTHROPIC_AUTH_TOKEN).toBe("config-token")
      expect(check.API_TIMEOUT_MS).toBe("60000")
      expect(check.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe("600000")
      expect(check.ANTHROPIC_CUSTOM_HEADERS).toBe("X-Team: core")
      expect(check.CLAUDE_CODE_EXTRA_BODY).toBe(JSON.stringify({ metadata: { user_id: "dan" } }))

      const result = yield* test.opencode.generate.text({
        prompt: "hello",
        model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }),
      })
      expect(result.text).toBe("COPPER-OTTER")

      // Model settings override the provider's, and only configured headers are sent, not opencode's own
      const chat = claude.runs.find((run) => run.args.includes("--include-partial-messages"))!.env
      expect(chat.ANTHROPIC_BASE_URL).toBe("https://haiku-gateway.example")
      expect(chat.ANTHROPIC_AUTH_TOKEN).toBe("config-token")
      expect(chat.ANTHROPIC_CUSTOM_HEADERS).toBe("X-Team: core\nX-Model: haiku")
      expect(chat.CLAUDE_CODE_EXTRA_BODY).toBe(JSON.stringify({ metadata: { user_id: "dan" } }))
      claude.check()
    }),
  )

  it.live("leaves the user's environment alone when nothing is configured", () =>
    Effect.gen(function* () {
      const onConnect = FakeClaude.expectStartup()
      const claude = FakeClaude.make([onConnect])
      const test = yield* TestOpenCode.start({
        io: FakeIO.make({ claude, env: { ANTHROPIC_BASE_URL: "https://from-shell.example" } }),
      })
      yield* TestOpenCode.connect(test.opencode)
      yield* Effect.promise(() => claude.reached(onConnect))
      const env = claude.runs[0]!.env
      expect(env.ANTHROPIC_BASE_URL).toBe("https://from-shell.example")
      expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
      expect(env.CLAUDE_CODE_EXTRA_BODY).toBeUndefined()
      claude.check()
    }),
  )
})
