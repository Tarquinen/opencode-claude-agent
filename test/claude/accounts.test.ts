import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ClaudeAccounts } from "../../src/claude/accounts.js"
import { ClaudeQueryOptions } from "../../src/claude/query-options.js"
import { RequestKind } from "../../src/language-model/request-kind.js"
import { it } from "../lib/effect.js"
import { FakeClaude } from "../lib/fake-claude.js"
import { TestSessions } from "../lib/sessions.js"

const first = TestSessions.prompt("Remember the marker COPPER-OTTER. Reply only with that marker.")
const pool = { configDir: ["/accounts/a", "/accounts/b", "/accounts/c"] }
const resetsAt = 1792800000

// A recorded failed turn, rewritten into the messages Claude Code sends when a subscription limit refuses it.
function limitTurn() {
  const turn = FakeClaude.expectTurn({ recording: "billing-error" })
  const replies: any[] = []
  for (const message of turn.replies) {
    if (message.type === "assistant" && message.error) {
      replies.push({
        type: "rate_limit_event",
        uuid: crypto.randomUUID(),
        session_id: message.session_id,
        rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt },
      })
      replies.push({ ...message, error: "rate_limit" })
      continue
    }
    if (message.type === "result") {
      replies.push({ ...message, is_error: true, result: "You've hit your limit", api_error_status: 429 })
      continue
    }
    replies.push(message)
  }
  return { ...turn, replies }
}

// A normal reply whose turn still ends at a limit, after the text was shown.
function limitAfterText() {
  const turn = FakeClaude.expectTurn()
  const replies: any[] = []
  for (const message of turn.replies) {
    if (message.type === "result") {
      replies.push({ type: "assistant", error: "rate_limit", parent_tool_use_id: null, message: { content: [] } })
      replies.push({ ...message, is_error: true, result: "You've hit your limit", api_error_status: 429 })
      continue
    }
    replies.push(message)
  }
  return { ...turn, replies }
}

describe("Claude accounts", () => {
  test("configDir takes one folder or a list, expanding ~, and the login check uses the first", () => {
    const home = path.join(os.homedir(), ".claude-1")
    expect(ClaudeQueryOptions.configDirs("~/.claude-1")).toEqual([home])
    expect(ClaudeQueryOptions.configDirs(["~/.claude-1", "/tmp/claude-2"])).toEqual([home, "/tmp/claude-2"])
    expect(ClaudeQueryOptions.configDirs(undefined)).toEqual([])
    const env = ClaudeQueryOptions.connectionEnv({ settings: { configDir: ["~/.claude-1", "/tmp/claude-2"] } })
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: home })
  })

  test("order tries every account, starting from the chat's own", () => {
    const dirs = ["a", "b", "c"]
    expect(ClaudeAccounts.order(dirs)).toEqual(["a", "b", "c"])
    expect(ClaudeAccounts.order(dirs, "c")).toEqual(["c", "a", "b"])
    // A saved account that is no longer listed starts from the first.
    expect(ClaudeAccounts.order(dirs, "gone")).toEqual(["a", "b", "c"])
  })

  test("the watch holds diagnostics until output, and reports a limit", () => {
    const seen: SDKMessage[] = []
    const watch = ClaudeAccounts.watch((message) => seen.push(message))
    for (const message of limitTurn().replies) watch.emit(message)
    expect(seen).toEqual([])
    expect(watch.shown()).toBe(false)
    expect(watch.refused()).toBe(true)
    watch.flush()
    expect(seen.length).toBeGreaterThan(0)
  })

  it.effect("a refused chat retries unseen on the next account and stays there", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([
        FakeClaude.expectStartup(),
        limitTurn(),
        FakeClaude.expectInterrupt(),
        FakeClaude.expectStartup(),
        FakeClaude.expectTurn(),
        FakeClaude.expectTurn({ index: 1 }),
        FakeClaude.expectInterrupt(),
      ])
      const test = yield* TestSessions.start(claude, TestSessions.storage(), pool)
      const one = yield* TestSessions.reply(test.model, first)
      expect(TestSessions.text(one)).toBe("COPPER-OTTER")
      expect(one.some((part) => part.type === "error")).toBe(false)
      const two = yield* TestSessions.reply(test.model, TestSessions.followup())
      expect(TestSessions.text(two)).toBe("COPPER-OTTER")
      expect(claude.runs.map((run) => run.env.CLAUDE_CONFIG_DIR)).toEqual(["/accounts/a", "/accounts/b"])
      expect(test.storage.data.get("accounts/session-a")).toBe("/accounts/b")
      yield* test.registry.close()
      claude.check()
    }),
  )

  it.effect("a limit after output is shown as an error, and the next turn moves", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([
        FakeClaude.expectStartup(),
        limitAfterText(),
        limitTurn(),
        FakeClaude.expectInterrupt(),
        FakeClaude.expectStartup(),
        FakeClaude.expectTurn({ index: 1 }),
        FakeClaude.expectInterrupt(),
      ])
      const test = yield* TestSessions.start(claude, TestSessions.storage(), pool)
      const one = yield* TestSessions.reply(test.model, first)
      expect(TestSessions.text(one)).toBe("COPPER-OTTER")
      expect(one.at(-1)?.type).toBe("error")
      expect(test.storage.data.has("accounts/session-a")).toBe(false)
      // The next turn tries the first account again, which refuses unseen, then moves on.
      const two = yield* TestSessions.reply(test.model, TestSessions.followup())
      expect(two.some((part) => part.type === "error")).toBe(false)
      expect(claude.runs.map((run) => run.env.CLAUDE_CONFIG_DIR)).toEqual(["/accounts/a", "/accounts/b"])
      expect(test.storage.data.get("accounts/session-a")).toBe("/accounts/b")
      yield* test.registry.close()
      claude.check()
    }),
  )

  it.effect("after every account refuses, the next request tries them all again from the chat's own", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([
        FakeClaude.expectStartup(),
        FakeClaude.expectTurn(),
        limitTurn(),
        FakeClaude.expectInterrupt(),
        FakeClaude.expectStartup(),
        limitTurn(),
        FakeClaude.expectInterrupt(),
        FakeClaude.expectStartup(),
        FakeClaude.expectTurn({ index: 1 }),
        FakeClaude.expectInterrupt(),
      ])
      const test = yield* TestSessions.start(claude, TestSessions.storage(), {
        configDir: ["/accounts/a", "/accounts/b"],
      })
      yield* TestSessions.reply(test.model, first)
      expect(test.storage.data.get("accounts/session-a")).toBe("/accounts/a")
      // Like a model whose own limit is used up on every account.
      const refused = yield* TestSessions.reply(test.model, TestSessions.followup("Use the capped model"))
      expect(refused.filter((part) => part.type === "error")).toHaveLength(1)
      expect(test.storage.data.get("accounts/session-a")).toBe("/accounts/a")
      // Like switching to a model that still has room: it starts on the chat's own account and works.
      const two = yield* TestSessions.reply(test.model, TestSessions.followup())
      expect(TestSessions.text(two)).toBe("COPPER-OTTER")
      expect(claude.runs.map((run) => run.env.CLAUDE_CONFIG_DIR)).toEqual(["/accounts/a", "/accounts/b", "/accounts/a"])
      yield* test.registry.close()
      claude.check()
    }),
  )

  it.effect("a model with one configDir is pinned to it, even when it is refused", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([FakeClaude.expectStartup(), limitTurn(), FakeClaude.expectInterrupt()])
      const test = yield* TestSessions.start(claude, TestSessions.storage(), pool)
      const work = yield* TestSessions.rotating(test.accounts, { configDir: "/accounts/work" })
      const parts = yield* TestSessions.reply(work, first)
      expect(String(parts.find((part) => part.type === "error")?.error)).toContain("Resets at")
      expect(claude.runs.map((run) => run.env.CLAUDE_CONFIG_DIR)).toEqual(["/accounts/work"])
      expect(test.storage.data.has("accounts/session-a")).toBe(false)
      yield* test.registry.close()
      claude.check()
    }),
  )

  it.effect("an API key in settings skips rotation", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([FakeClaude.expectStartup(), limitTurn(), FakeClaude.expectInterrupt()])
      const test = yield* TestSessions.start(claude, TestSessions.storage(), pool)
      const keyed = yield* TestSessions.rotating(test.accounts, { ...pool, apiKey: "sk-test" })
      const parts = yield* TestSessions.reply(keyed, first, "session-key")
      expect(parts.some((part) => part.type === "error")).toBe(true)
      expect(claude.runs.map((run) => run.env.CLAUDE_CONFIG_DIR)).toEqual(["/accounts/a"])
      expect(test.storage.data.has("accounts/session-key")).toBe(false)
      yield* test.registry.close()
      claude.check()
    }),
  )

  it.effect("a new fork starts on its parent's account and forks the parent's transcript", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([
        FakeClaude.expectStartup(),
        limitTurn(),
        FakeClaude.expectInterrupt(),
        FakeClaude.expectStartup(),
        FakeClaude.expectTurn(),
        FakeClaude.expectInterrupt(),
        FakeClaude.expectStartup(),
        FakeClaude.expectTurn(),
        FakeClaude.expectInterrupt(),
      ])
      const saved = TestSessions.storage()
      const old = yield* TestSessions.start(claude, saved, pool)
      yield* TestSessions.reply(old.model, first)
      expect(saved.data.get("accounts/session-a")).toBe("/accounts/b")
      // After a restart, the parent's saved account still steers the fork.
      yield* old.registry.close()
      const test = yield* TestSessions.start(claude, saved, pool)
      const result = yield* Effect.promise(() =>
        test.model.doStream({
          prompt: TestSessions.followup("A forked question"),
          headers: {
            [RequestKind.HEADER]: "primary",
            [RequestKind.SESSION_HEADER]: "child-a",
            [RequestKind.FORK_HEADER]: "session-a",
          },
        }),
      )
      yield* Effect.promise(() => TestSessions.collect(result.stream))
      expect(claude.forks).toHaveLength(1)
      expect(claude.forks[0]!.configDir).toBe("/accounts/b")
      expect(claude.runs.at(-1)!.env.CLAUDE_CONFIG_DIR).toBe("/accounts/b")
      expect(test.storage.data.get("accounts/child-a")).toBe("/accounts/b")
      yield* test.registry.close()
      claude.check()
    }),
  )

  it.effect("when every account is refused, the chat shows one error and saves no account", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([
        FakeClaude.expectStartup(),
        limitTurn(),
        FakeClaude.expectInterrupt(),
        FakeClaude.expectStartup(),
        limitTurn(),
        FakeClaude.expectInterrupt(),
      ])
      const test = yield* TestSessions.start(claude, TestSessions.storage(), {
        configDir: ["/accounts/a", "/accounts/b"],
      })
      const parts = yield* TestSessions.reply(test.model, first)
      const errors = parts.filter((part) => part.type === "error")
      expect(errors).toHaveLength(1)
      expect(String(errors[0]?.error)).toContain(new Date(resetsAt * 1000).toISOString())
      expect(test.storage.data.has("accounts/session-a")).toBe(false)
      yield* test.registry.close()
      claude.check()
    }),
  )
})
