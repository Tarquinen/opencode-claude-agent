import { describe, expect } from "bun:test"
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
    "a logged-out account fails with the command to log in to its folder, without moving on",
    () =>
      Effect.gen(function* () {
        const directory = yield* TestOpenCode.tempDirectory
        const loggedOut = yield* TestOpenCode.tempDirectory
        // The developer's own login, so the test never copies credentials.
        const working = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")
        const storage = TestSessions.storage()
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

        const prompt = TestSessions.prompt("Reply only with OK.")
        const error = yield* TestSessions.reply(model, prompt).pipe(Effect.flip)
        expect(String(error.cause)).toContain(`CLAUDE_CONFIG_DIR="${loggedOut}" claude auth login`)
        expect(storage.data.has("accounts/session-a")).toBe(false)
      }),
    120_000,
  )
})
