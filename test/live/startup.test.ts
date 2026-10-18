import { describe, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ClaudeIO } from "../../src/claude/io.js"
import { ClaudeProbe } from "../../src/claude/probe.js"
import { ClaudeQueryOptions } from "../../src/claude/query-options.js"
import { it } from "../lib/effect.js"
import { TestOpenCode } from "../lib/opencode.js"
import { Recorder } from "../lib/recorder.js"

// Needs a real, logged-in `claude`. Run with `bun run test:live`, or `RECORD=1 bun run test:live` to save new
// recordings. `claude auth status` exits with 1 when logged out.
const live = !process.env.CI && process.env.CLAUDE_LIVE === "1" && Bun.spawnSync(["claude", "auth", "status"]).exitCode === 0

// The probe gives `claude` 30 seconds to start and 30 more for context discovery. Waiting longer lets a stuck
// probe report its own error before the test times out.
const PROBE_WAIT = "60 seconds"
const TIMEOUT = 90_000

// An empty config folder is a `claude` that has never logged in
const loggedOutIO = Effect.gen(function* () {
  const config = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "claude-config-"))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
  return { ...ClaudeIO.real, env: () => ({ ...process.env, CLAUDE_CONFIG_DIR: config }) } satisfies ClaudeIO.Interface
})

// One login check with the real `claude`
const probe = (io: ClaudeIO.Interface) => {
  const executable = io.which()
  if (!executable) throw new Error("claude is not on PATH")
  return ClaudeProbe.run(ClaudeQueryOptions.base({ executable, io }))
}

// A login check saved as a recording with RECORD=1
const check = Effect.fn(function* (name: string, io: ClaudeIO.Interface) {
  const recorder = Recorder.make(name)
  const result = yield* probe({ ...io, spawn: recorder.spawn })
  recorder.save()
  return result
})

describe.skipIf(!live)("start-up against the real claude", () => {
  it.live(
    "the login check reports the subscription and each model's context window",
    () =>
      Effect.gen(function* () {
        const result = yield* check("startup", ClaudeIO.real)
        expect(ClaudeProbe.isSubscription(result.account)).toBe(true)
        expect(result.models.map((model) => model.value)).toContain("sonnet")
        for (const model of result.models) {
          if (model.value !== "default") expect(model.contextWindow).toBeGreaterThan(0)
        }
      }),
    TIMEOUT,
  )

  it.live(
    "the login check honors claude's 1M context opt-out",
    () =>
      Effect.gen(function* () {
        const result = yield* probe({ ...ClaudeIO.real, env: () => ({ ...process.env, CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" }) })
        for (const model of result.models) {
          if (model.value !== "default") expect(model.contextWindow).toBe(200_000)
        }
      }),
    TIMEOUT,
  )

  it.live(
    "the login check reports a logged-out claude",
    () =>
      Effect.gen(function* () {
        const result = yield* check("startup-logged-out", yield* loggedOutIO)
        expect(ClaudeProbe.isSubscription(result.account)).toBe(false)
      }),
    TIMEOUT,
  )

  it.live(
    "opencode shows claude's models and no sign-in problem",
    () =>
      Effect.gen(function* () {
        const test = yield* TestOpenCode.start({ io: ClaudeIO.real })
        yield* TestOpenCode.connect(test.opencode)

        // The built-in list only has aliases, so full model IDs mean claude's own list has arrived
        const ids = yield* TestOpenCode.waitUntil(TestOpenCode.models(test.opencode), (ids) =>
          ids.some((id) => id.startsWith("claude-")),
          PROBE_WAIT,
        )
        expect(ids).toContain("sonnet")
        expect(ids).not.toContain("default")
        const connection = yield* TestOpenCode.connection(test.opencode)
        expect(connection?.status).toBeUndefined()
      }),
    TIMEOUT,
  )

  it.live(
    "opencode shows a sign-in problem when claude is logged out",
    () =>
      Effect.gen(function* () {
        const test = yield* TestOpenCode.start({ io: yield* loggedOutIO })
        yield* TestOpenCode.connect(test.opencode)

        const connection = yield* TestOpenCode.waitUntil(
          TestOpenCode.connection(test.opencode),
          (connection) => connection?.status !== undefined,
          PROBE_WAIT,
        )
        expect(connection?.status?.status).toBe("needs_auth")
      }),
    TIMEOUT,
  )
})
