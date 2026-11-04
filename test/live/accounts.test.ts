import { describe, expect } from "bun:test"
import { deleteSession } from "@anthropic-ai/claude-agent-sdk"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ClaudeAccounts } from "../../src/claude/accounts.js"
import { ClaudeIO } from "../../src/claude/io.js"
import { ClaudeSessions } from "../../src/claude/sessions.js"
import { ClaudeStatus } from "../../src/claude/status.js"
import { it } from "../lib/effect.js"
import { TestOpenCode } from "../lib/opencode.js"
import { TestSessions } from "../lib/sessions.js"

const live =
  !process.env.CI && process.env.CLAUDE_LIVE === "1" && Bun.spawnSync(["claude", "auth", "status"]).exitCode === 0

describe.skipIf(!live)("account rotation against real Claude", () => {
  it.live(
    "a logged-out account is skipped unseen, and the chat stays on the working one",
    () =>
      Effect.gen(function* () {
        const directory = yield* TestOpenCode.tempDirectory
        const loggedOut = yield* TestOpenCode.tempDirectory
        // The developer's own login, so the test never copies credentials.
        const working = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")
        const storage = TestSessions.storage()
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            for (const id of storage.ids) await deleteSession(id, { dir: directory }).catch(() => {})
          }),
        )
        const registry = ClaudeSessions.registry()
        yield* Effect.addFinalizer(() => registry.close())
        const sessions = yield* registry.attach({
          io: ClaudeIO.real,
          status: yield* ClaudeStatus.make(ClaudeIO.real, () => Effect.succeed({})),
          storage,
          directory,
        })
        const accounts = ClaudeAccounts.make({ sessions, storage })
        const model = yield* TestSessions.rotating(accounts, { configDir: [loggedOut, working] })

        const history = TestSessions.prompt("Remember the marker COPPER-OTTER. Reply only with that marker.")
        const one = yield* TestSessions.reply(model, history)
        expect(one.find((part) => part.type === "error")).toBeUndefined()
        expect(TestSessions.text(one).trim()).toBe("COPPER-OTTER")
        expect(storage.data.get("accounts/session-a")).toBe(working)

        history.push(
          { role: "assistant", content: [{ type: "text", text: "COPPER-OTTER" }] },
          { role: "user", content: [{ type: "text", text: "What was the marker? Reply only with it." }] },
        )
        const two = yield* TestSessions.reply(model, history)
        expect(TestSessions.text(two).trim()).toBe("COPPER-OTTER")
        // The follow-up resumed the working account's transcript rather than starting over.
        const record = storage.data.get(`sessions/session-a:${working}`) as { history: unknown[] }
        expect(record.history.length).toBeGreaterThan(1)
      }),
    120_000,
  )
})
