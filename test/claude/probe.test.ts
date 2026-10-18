import { describe, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { ClaudeProbe } from "../../src/claude/probe.js"
import { ClaudeQueryOptions } from "../../src/claude/query-options.js"
import { it } from "../lib/effect.js"
import { FakeClaude } from "../lib/fake-claude.js"
import { FakeIO } from "../lib/fake-io.js"

describe("login check", () => {
  it.effect("starts claude with everything that duplicates opencode turned off", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([FakeClaude.expectStartup()])
      const io = FakeIO.make({ claude, env: { PATH: "/usr/bin", CLAUDE_CODE_SIMPLE: "1" } })
      const result = yield* ClaudeProbe.run(ClaudeQueryOptions.base({ executable: FakeIO.EXECUTABLE, io }))
      claude.check()

      const run = claude.runs[0]!
      yield* Effect.promise(() => run.closed)
      // Only opencode's tools, no settings, hooks or MCP servers from ~/.claude, and no permission prompts
      expect(run.args).toContain("--tools=")
      expect(run.args).toContain("--allowedTools=mcp__opencode__*")
      expect(run.args).toContain("--setting-sources=")
      expect(run.args).toContain("--strict-mcp-config")
      expect(run.args).toContain("--permission-mode=dontAsk")
      expect(run.args).toContain("--no-session-persistence")
      expect(JSON.parse(run.args[run.args.indexOf("--settings") + 1]!)).toEqual({ disableAllHooks: true })
      expect(run.received[0].request.skills).toEqual([])

      expect(run.env).toMatchObject({
        PATH: "/usr/bin",
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        DISABLE_AUTO_COMPACT: "1",
        CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
        ENABLE_TOOL_SEARCH: "false",
        CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
      })
      // Simple mode skips the subscription login
      expect(run.env.CLAUDE_CODE_SIMPLE).toBeUndefined()

      expect(ClaudeProbe.isSubscription(result.account)).toBe(true)
      expect(result.models.map((model) => model.value)).toContain("sonnet")
    }),
  )

  it.effect("discovers each model's capacity without prompts or token-count requests", () => Effect.gen(function* () {
    const steps = FakeClaude.replay("startup")
    const context = steps.find((step) => step.type === "exchange" && step.input.request?.subtype === "get_context_usage")
    if (context?.type !== "exchange") throw new Error("Missing context recording")
    // Claude's auto-compaction window is not the model's capacity.
    context.replies[0].response.response.maxTokens = 200_000
    const claude = FakeClaude.make(steps)
    const result = yield* ClaudeProbe.run(ClaudeQueryOptions.base({ executable: FakeIO.EXECUTABLE, io: FakeIO.make({ claude }) }))
    expect(result.models.find((model) => model.value === "opus")?.contextWindow).toBe(1_000_000)
    expect(result.models.find((model) => model.value === "claude-opus-4-6")?.contextWindow).toBe(200_000)
    expect(claude.runs).toHaveLength(1)
    const requests = claude.runs[0]!.received
    expect(requests.some((message) => message.type === "user")).toBe(false)
    const contexts = requests.filter((message) => message.request?.subtype === "get_context_usage")
    expect(contexts).toHaveLength(result.models.filter((model) => model.value !== "default").length)
    for (const context of contexts) expect(context.request.detail).toBe("summary")
    claude.check()
  }))

  it.effect("keeps the login and other limits when one model reports an invalid capacity", () => Effect.gen(function* () {
    const steps = FakeClaude.replay("startup")
    const context = steps.find((step) => step.type === "exchange" && step.input.request?.subtype === "get_context_usage")
    if (context?.type !== "exchange") throw new Error("Missing context recording")
    context.replies[0].response.response.rawMaxTokens = 0
    const claude = FakeClaude.make(steps)
    const result = yield* ClaudeProbe.run(ClaudeQueryOptions.base({ executable: FakeIO.EXECUTABLE, io: FakeIO.make({ claude }) }))
    expect(ClaudeProbe.isSubscription(result.account)).toBe(true)
    expect(result.models.find((model) => model.value === "opus")?.contextWindow).toBeUndefined()
    expect(result.models.find((model) => model.value === "sonnet")?.contextWindow).toBe(1_000_000)
    claude.check()
  }))

  it.effect("closes stuck context discovery without turning it into a login failure", () => Effect.gen(function* () {
    const steps = FakeClaude.replay("startup").slice(0, 3)
    const context = { ...steps[2]!, hold: new Promise<void>(() => {}) }
    steps[2] = context
    const claude = FakeClaude.make(steps)
    const check = yield* ClaudeProbe.run(ClaudeQueryOptions.base({ executable: FakeIO.EXECUTABLE, io: FakeIO.make({ claude }) })).pipe(Effect.forkScoped)
    yield* Effect.promise(() => claude.started(context))
    yield* TestClock.adjust("30 seconds")
    const result = yield* Fiber.join(check)
    expect(ClaudeProbe.isSubscription(result.account)).toBe(true)
    expect(result.models.find((model) => model.value === "opus")?.contextWindow).toBeUndefined()
    yield* Effect.promise(() => claude.runs[0]!.closed)
    expect(() => claude.check()).toThrow("1 script steps did not finish")
  }))

  it.effect("accepts the minimum version that supports verbatim prompts", () =>
    Effect.gen(function* () {
      const startup = FakeClaude.expectStartup()
      startup.reply.claude_code_version = "2.1.248"
      const claude = FakeClaude.make([startup])
      const io = FakeIO.make({ claude })
      const result = yield* ClaudeProbe.run(ClaudeQueryOptions.base({ executable: FakeIO.EXECUTABLE, io }))
      expect(result.version).toBe("2.1.248")
      claude.check()
    }),
  )

  for (const version of ["2.1.247", undefined]) {
    it.effect(`asks for an update when claude reports ${version ?? "no version"}`, () =>
      Effect.gen(function* () {
        const startup = FakeClaude.expectStartup()
        startup.reply.claude_code_version = version
        const claude = FakeClaude.make([startup])
        const io = FakeIO.make({ claude })
        const error = yield* ClaudeProbe.run(ClaudeQueryOptions.base({ executable: FakeIO.EXECUTABLE, io })).pipe(
          Effect.flip,
        )
        expect(String(error.cause)).toContain("claude update")
        yield* Effect.promise(() => claude.runs[0]!.closed)
        claude.check()
      }),
    )
  }

  it.effect("times out a stuck startup and closes the process", () =>
    Effect.gen(function* () {
      const startup = FakeClaude.expectStartup({ hold: new Promise<void>(() => {}) })
      const claude = FakeClaude.make([startup])
      const io = FakeIO.make({ claude })
      const check = yield* ClaudeProbe.run(ClaudeQueryOptions.base({ executable: FakeIO.EXECUTABLE, io })).pipe(
        Effect.flip,
        Effect.forkScoped,
      )
      yield* Effect.promise(() => claude.started(startup))
      // A requested step is not a finished step while its reply is held back.
      expect(() => claude.check()).toThrow("1 script steps did not finish")

      yield* TestClock.adjust("30 seconds")
      const error = yield* Fiber.join(check)
      expect(String(error.cause)).toContain("did not start within 30 seconds")
      yield* Effect.promise(() => claude.runs[0]!.closed)
    }),
  )
})
