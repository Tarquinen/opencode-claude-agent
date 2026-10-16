import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { ClaudeSessions } from "../../src/claude/sessions.js"
import { ClaudeCodeLanguageModel } from "../../src/language-model/claude-code-language-model.js"
import { ClaudeSystemPrompt } from "../../src/language-model/system-prompt.js"
import { it } from "../lib/effect.js"
import { FakeClaude } from "../lib/fake-claude.js"
import { TestSessions } from "../lib/sessions.js"
import { Recorder } from "../lib/recorder.js"

const first = TestSessions.prompt("Remember the marker COPPER-OTTER. Reply only with that marker.")

describe("Claude sessions", () => {
  it.effect("streams consecutive turns once, on one process, with per-turn usage", () => Effect.gen(function* () {
    const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectTurn({ index: 1 }), FakeClaude.expectInterrupt()])
    const test = yield* TestSessions.start(claude)
    const one = yield* TestSessions.reply(test.model, first)
    const two = yield* TestSessions.reply(test.model, TestSessions.followup())
    expect(TestSessions.text(one)).toBe("COPPER-OTTER")
    expect(TestSessions.text(two)).toBe("COPPER-OTTER")
    const finish = two.find((part) => part.type === "finish")!
    const usage = Recorder.result("text", 1).usage
    expect(finish.usage.inputTokens).toEqual({
      total: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
      noCache: usage.input_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens,
    })
    expect(finish.usage.outputTokens.total).toBe(usage.output_tokens)
    expect(claude.runs).toHaveLength(1)
    const users = claude.runs[0]!.received.filter((message) => message.type === "user")
    expect(users).toHaveLength(2)
    expect(users[1].message.content).toEqual([{ type: "text", text: "What was the marker? Reply only with it." }])
    expect(users[0].client_composed).toBe(true)
    yield* test.registry.close()
    yield* Effect.promise(() => claude.runs[0]!.closed)
    claude.check()
  }))

  it.effect("cancellation drains past the interrupt receipt before accepting another turn", () => Effect.gen(function* () {
    const drain = Promise.withResolvers<void>()
    const interrupt = FakeClaude.expectInterrupt({ recording: "text-cancel", beforeResult: drain.promise })
    const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "text-cancel" }), interrupt,
      FakeClaude.expectTurn({ recording: "text-cancel", index: 1 }), FakeClaude.expectInterrupt()])
    const test = yield* TestSessions.start(claude)
    const result = yield* TestSessions.stream(test.model, first)
    const reader = result.stream.getReader()
    // Wait for real partial text
    yield* Effect.promise(async () => {
      for (;;) {
        const part = await reader.read()
        if (part.done) throw new Error("Reply ended before any text")
        if (part.value.type === "text-delta") return
      }
    })
    const cancel = yield* Effect.promise(() => reader.cancel()).pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Effect.promise(() => claude.started(interrupt))
    const next = yield* TestSessions.reply(test.model, TestSessions.followup()).pipe(Effect.forkScoped({ startImmediately: true }))
    expect(claude.runs[0]!.received.filter((message) => message.type === "user")).toHaveLength(1)
    drain.resolve()
    yield* Fiber.join(cancel)
    expect(TestSessions.text(yield* Fiber.join(next))).toBe("COPPER-OTTER")
    expect(claude.runs).toHaveLength(1)
    yield* test.registry.close()
    claude.check()
  }))

  it.effect("chat keeps the Claude Code preset when OpenCode's built-in prompt changes", () => Effect.gen(function* () {
    const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectTurn({ index: 1 }), FakeClaude.expectInterrupt()])
    const test = yield* TestSessions.start(claude)
    yield* TestSessions.reply(test.model, first)
    const prompt = TestSessions.followup()
    prompt[0] = { role: "system", content: "A changed OpenCode built-in agent prompt" }
    yield* TestSessions.reply(test.model, prompt)
    expect(claude.runs).toHaveLength(1)
    const run = claude.runs[0]!
    const init = run.received.find((message) => message.request?.subtype === "initialize").request
    expect(init.systemPrompt).toBeUndefined()
    expect(init.appendSystemPrompt).toBe(ClaudeSystemPrompt.primary.append)
    expect(JSON.stringify(run.received)).not.toContain("A changed OpenCode built-in agent prompt")
    expect(run.args).toContain("--tools=")
    expect(run.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1")
    yield* test.registry.close()
    claude.check()
  }))

  it.effect("idle shutdown drains and the next turn resumes the saved Claude session", () => Effect.gen(function* () {
    const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt(),
      FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "text-resume" }), FakeClaude.expectInterrupt()])
    const test = yield* TestSessions.start(claude)
    yield* TestSessions.reply(test.model, first)
    const id = claude.runs[0]!.args.find((arg) => arg.startsWith("--session-id="))!.split("=")[1]
    yield* TestClock.adjust(ClaudeSessions.IDLE_MS)
    yield* Effect.promise(() => claude.runs[0]!.closed)
    expect(TestSessions.text(yield* TestSessions.reply(test.model, TestSessions.followup()))).toBe("COPPER-OTTER")
    expect(claude.runs[1]!.args).toContain(`--resume=${id}`)
    yield* test.registry.close()
    claude.check()
  }))

  it.effect("a turn arriving during idle shutdown waits for the old process to close", () => Effect.gen(function* () {
    const release = Promise.withResolvers<void>()
    const stop = FakeClaude.expectInterrupt({ hold: release.promise })
    const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn(), stop,
      FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "text-resume" }), FakeClaude.expectInterrupt()])
    const test = yield* TestSessions.start(claude)
    yield* TestSessions.reply(test.model, first)
    const timeout = yield* TestClock.adjust(ClaudeSessions.IDLE_MS).pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Effect.promise(() => claude.started(stop))
    const next = yield* TestSessions.reply(test.model, TestSessions.followup()).pipe(Effect.forkScoped({ startImmediately: true }))
    expect(claude.runs).toHaveLength(1)
    release.resolve()
    yield* Fiber.join(timeout)
    expect(TestSessions.text(yield* Fiber.join(next))).toBe("COPPER-OTTER")
    yield* Effect.promise(() => claude.runs[0]!.closed)
    expect(claude.runs).toHaveLength(2)
    yield* test.registry.close()
    claude.check()
  }))

  it.effect("cancelling during startup closes it and does not save a nonexistent session", () => Effect.gen(function* () {
    const startup = FakeClaude.expectStartup({ hold: new Promise(() => {}) })
    const claude = FakeClaude.make([startup, FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt()])
    const test = yield* TestSessions.start(claude)
    const stream = yield* TestSessions.stream(test.model, first)
    yield* Effect.promise(() => claude.started(startup))
    yield* Effect.promise(() => stream.stream.cancel())
    yield* Effect.promise(() => claude.runs[0]!.closed)
    expect(test.storage.data.size).toBe(0)
    expect(TestSessions.text(yield* TestSessions.reply(test.model, first))).toBe("COPPER-OTTER")
    expect(claude.runs[1]!.args.some((arg) => arg.startsWith("--resume="))).toBe(false)
    yield* test.registry.close()
    expect(() => claude.check()).toThrow("1 script steps did not finish")
  }))

  it.effect("chat checks compatibility before sending a prompt", () => Effect.gen(function* () {
    const startup = FakeClaude.expectStartup()
    startup.reply.claude_code_version = "2.1.247"
    const claude = FakeClaude.make([startup])
    const test = yield* TestSessions.start(claude)
    const error = yield* TestSessions.reply(test.model, first).pipe(Effect.flip)
    expect(String(error.cause)).toContain("claude update")
    expect(claude.runs[0]!.received.some((message) => message.type === "user")).toBe(false)
    yield* Effect.promise(() => claude.runs[0]!.closed)
    claude.check()
  }))

  it.effect("a new registry resumes from durable storage", () => Effect.gen(function* () {
    const saved = TestSessions.storage()
    const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt(),
      FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "text-resume" }), FakeClaude.expectInterrupt()])
    const old = yield* TestSessions.start(claude, saved)
    yield* TestSessions.reply(old.model, first)
    yield* old.registry.close()
    const fresh = yield* TestSessions.start(claude, saved)
    yield* TestSessions.reply(fresh.model, TestSessions.followup())
    const record = saved.data.get("sessions/session-a") as { claudeSessionID: string }
    expect(claude.runs[1]!.args).toContain(`--resume=${record.claudeSessionID}`)
    yield* fresh.registry.close()
    claude.check()
  }))

  it.effect("reload adopts a process during handover; no replacement means shutdown", () => Effect.gen(function* () {
    const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectTurn({ index: 1 }), FakeClaude.expectInterrupt()])
    const registry = ClaudeSessions.registry()
    yield* Effect.addFinalizer(() => registry.close())
    const base = yield* TestSessions.start(FakeClaude.make([]))
    const input = { ...base.input, io: { ...base.input.io, spawn: claude.spawn } }
    const oldScope = yield* Scope.make()
    const old = yield* registry.attach(input).pipe(Effect.provideService(Scope.Scope, oldScope))
    yield* TestSessions.reply(yield* TestSessions.model(old), first)
    yield* Scope.close(oldScope, Exit.void)
    yield* TestClock.adjust(ClaudeSessions.HANDOVER_MS - 1)
    const newScope = yield* Scope.make()
    const fresh = yield* registry.attach(input).pipe(Effect.provideService(Scope.Scope, newScope))
    yield* TestSessions.reply(yield* TestSessions.model(fresh), TestSessions.followup())
    expect(claude.runs).toHaveLength(1)
    yield* Scope.close(newScope, Exit.void)
    yield* TestClock.adjust(ClaudeSessions.HANDOVER_MS)
    yield* Effect.promise(() => claude.runs[0]!.closed)
    claude.check()
  }))

  it.effect("switching model restarts the process and resumes the same Claude session", () => Effect.gen(function* () {
    const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt(),
      FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "text-resume" }), FakeClaude.expectInterrupt()])
    const test = yield* TestSessions.start(claude)
    yield* TestSessions.reply(test.model, first)
    const id = claude.runs[0]!.args.find((arg) => arg.startsWith("--session-id="))!.split("=")[1]
    const sonnet = new ClaudeCodeLanguageModel.Model("sonnet", test.model.dependencies)
    expect(TestSessions.text(yield* TestSessions.reply(sonnet, TestSessions.followup()))).toBe("COPPER-OTTER")
    yield* Effect.promise(() => claude.runs[0]!.closed)
    expect(claude.runs[1]!.args).toContain("--model=sonnet")
    expect(claude.runs[1]!.args).toContain(`--resume=${id}`)
    const users = claude.runs[1]!.received.filter((message) => message.type === "user")
    expect(users[0].message.content).toEqual([{ type: "text", text: "What was the marker? Reply only with it." }])
    yield* test.registry.close()
    claude.check()
  }))

  it.effect("side calls preserve instructions in disposable processes without changing the main session", () => Effect.gen(function* () {
    const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn(),
      FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "utility" }), FakeClaude.expectInterrupt(),
      FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "utility" }), FakeClaude.expectInterrupt(),
      FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "utility" }), FakeClaude.expectInterrupt(),
      FakeClaude.expectTurn({ index: 1 }), FakeClaude.expectInterrupt()])
    const test = yield* TestSessions.start(claude)
    yield* TestSessions.reply(test.model, first)
    yield* TestSessions.reply(test.model, TestSessions.followup(), "session-a", "title")
    yield* TestSessions.reply(test.model, TestSessions.followup(), "session-a", "generate")
    yield* TestSessions.reply(test.model, TestSessions.followup(), "session-a", "compaction")
    yield* TestSessions.reply(test.model, TestSessions.followup())
    expect(claude.runs).toHaveLength(4)
    for (const run of claude.runs.slice(1)) {
      expect(run.args).toContain("--no-session-persistence")
      const init = run.received.find((message) => message.request?.subtype === "initialize").request
      expect(init.systemPrompt).toEqual([ClaudeSystemPrompt.utility])
      expect(init.appendSystemPrompt).toBeUndefined()
      const user = run.received.find((message) => message.type === "user")
      expect(user.message.content[0]).toEqual({ type: "text", text: "<instructions>\nYou are a concise test assistant.\n</instructions>" })
      expect(user.message.content).toContainEqual({ type: "text", text: "What was the marker? Reply only with it." })
    }
    expect(test.storage.data.size).toBe(1)
    yield* test.registry.close()
    claude.check()
  }))

  it.effect("closing the registry interrupts and drains a running side call", () => Effect.gen(function* () {
    const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "text-cancel" }),
      FakeClaude.expectInterrupt({ recording: "text-cancel" }), FakeClaude.expectInterrupt()])
    const test = yield* TestSessions.start(claude)
    const stream = yield* TestSessions.stream(test.model, first, "session-a", "generate")
    const reader = stream.stream.getReader()
    yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel().catch(() => {})))
    yield* Effect.promise(async () => {
      for (;;) {
        const part = await reader.read()
        if (part.done) throw new Error("Reply ended before shutdown could be tested")
        if (part.value.type === "text-delta") break
      }
    })
    yield* test.registry.close()
    yield* Effect.promise(() => claude.runs[0]!.closed)
    expect(test.storage.data.size).toBe(0)
    claude.check()
  }))
})
