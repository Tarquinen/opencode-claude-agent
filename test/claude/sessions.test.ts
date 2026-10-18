import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { ClaudeSessions } from "../../src/claude/sessions.js"
import { ClaudeCodeLanguageModel } from "../../src/language-model/claude-code-language-model.js"
import { ClaudeSystemPrompt } from "../../src/language-model/system-prompt.js"
import { RequestKind } from "../../src/language-model/request-kind.js"
import { it } from "../lib/effect.js"
import { FakeClaude } from "../lib/fake-claude.js"
import { TestSessions } from "../lib/sessions.js"
import { Recorder } from "../lib/recorder.js"

const first = TestSessions.prompt("Remember the marker COPPER-OTTER. Reply only with that marker.")

describe("Claude sessions", () => {
  it.effect("rebuilds saved history when the local Claude transcript is missing", () => Effect.gen(function* () {
    const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt(),
      FakeClaude.expectStartup(), FakeClaude.expectTurn({ index: 1 }), FakeClaude.expectInterrupt()])
    const test = yield* TestSessions.start(claude)
    yield* TestSessions.reply(test.model, first)
    const before = test.storage.data.get("sessions/session-a") as { claudeSessionID: string }
    yield* test.registry.close()
    const registry = ClaudeSessions.registry()
    yield* Effect.addFinalizer(() => registry.close())
    const checked: string[] = []
    const sessions = yield* registry.attach({ ...test.input, io: { ...test.input.io, sessionExists: async (id) => { checked.push(id); return false } } })
    const model = yield* TestSessions.model(sessions)
    expect(TestSessions.text(yield* TestSessions.reply(model, TestSessions.followup()))).toBe("COPPER-OTTER")
    expect(checked).toEqual([before.claudeSessionID])
    expect(claude.runs[1]!.args.some((arg) => arg.startsWith("--resume="))).toBe(false)
    const user = claude.runs[1]!.received.find((message) => message.type === "user")
    expect(JSON.stringify(user.message.content)).toContain("<conversation-checkpoint>")
    expect(JSON.stringify(user.message.content)).toContain("COPPER-OTTER")
    const after = test.storage.data.get("sessions/session-a") as { claudeSessionID: string }
    expect(after.claudeSessionID).not.toBe(before.claudeSessionID)
    yield* registry.close()
    claude.check()
  }))

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

  it.effect("a rejected attachment during rebuild does not lose history on the corrected request", () => Effect.gen(function* () {
    const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt(),
      FakeClaude.expectStartup(), FakeClaude.expectTurn({ index: 1 }), FakeClaude.expectInterrupt()])
    const test = yield* TestSessions.start(claude)
    yield* TestSessions.reply(test.model, first)
    yield* test.registry.close()
    const registry = ClaudeSessions.registry()
    yield* Effect.addFinalizer(() => registry.close())
    const sessions = yield* registry.attach({ ...test.input, io: { ...test.input.io, sessionExists: async () => false } })
    const model = yield* TestSessions.model(sessions)
    const prompt = TestSessions.followup("Inspect this image")
    prompt.push({ role: "user", content: [{ type: "file", mediaType: "image/svg+xml", data: "PHN2Zy8+" }] })
    const error = yield* TestSessions.reply(model, prompt).pipe(Effect.flip)
    expect(String(error.cause)).toContain("Claude Code does not support image/svg+xml attachments")
    yield* TestSessions.reply(model, TestSessions.followup())
    expect(claude.runs).toHaveLength(2)
    expect(claude.runs[1]!.args.some((arg) => arg.startsWith("--resume="))).toBe(false)
    const user = claude.runs[1]!.received.find((message) => message.type === "user")
    expect(JSON.stringify(user.message.content)).toContain("<conversation-checkpoint>")
    expect(JSON.stringify(user.message.content)).toContain("COPPER-OTTER")
    expect(JSON.stringify(user.message.content)).not.toContain("image/svg+xml")
    yield* registry.close()
    claude.check()
  }))

  it.effect("cancellation drains past the interrupt receipt before accepting another turn", () => Effect.gen(function* () {
    const drain = Promise.withResolvers<void>()
    const interrupt = FakeClaude.expectInterrupt({ recording: "text-cancel", beforeResult: drain.promise })
    const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "text-cancel" }), interrupt,
      FakeClaude.expectInterrupt(), FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "text-cancel", index: 1 }), FakeClaude.expectInterrupt()])
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
    // The next authoritative history omits the cancelled animal list, so it must rebuild after draining.
    expect(claude.runs).toHaveLength(2)
    expect(claude.runs[1]!.args.some((arg) => arg.startsWith("--resume="))).toBe(false)
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

  it.effect("changes model and effort live, and resumes when the output limit changes or is cleared", () => Effect.gen(function* () {
    const controls = FakeClaude.replay("controls").filter((step) => step.type === "exchange"
      && ["set_model", "apply_flag_settings"].includes(step.input.request?.subtype))
    const recorded = (index: number) => FakeClaude.expectTurn({ recording: "controls", index })
    const claude = FakeClaude.make([FakeClaude.expectStartup(), recorded(0), controls[0]!, recorded(1),
      controls[1]!, recorded(2), controls[2]!, controls[3]!, recorded(3), FakeClaude.expectInterrupt(),
      FakeClaude.expectStartup(), recorded(4), FakeClaude.expectInterrupt(),
      FakeClaude.expectStartup(), recorded(4), FakeClaude.expectInterrupt()])
    const test = yield* TestSessions.start(claude)
    const prompt = TestSessions.prompt("Remember CONTROL-OTTER. Reply only CONTROL-OTTER.")
    const settings = [
      { model: "haiku", effort: "low", maxOutputTokens: 2048 },
      { model: "haiku", effort: "high", maxOutputTokens: 2048 },
      { model: "haiku", maxOutputTokens: 2048 },
      { model: "sonnet", effort: "low", maxOutputTokens: 2048 },
      { model: "sonnet", effort: "low", maxOutputTokens: 4096 },
      { model: "sonnet", effort: "low" },
    ]
    for (const setting of settings) {
      const model = new ClaudeCodeLanguageModel.Model(setting.model, test.model.dependencies)
      const result = yield* Effect.promise(() => model.doStream({ prompt, maxOutputTokens: setting.maxOutputTokens,
        providerOptions: { "claude-code": setting.effort ? { effort: setting.effort } : {} },
        headers: { [RequestKind.HEADER]: "primary", [RequestKind.SESSION_HEADER]: "session-a" } }))
      expect(TestSessions.text(yield* Effect.promise(() => TestSessions.collect(result.stream)))).toBe("CONTROL-OTTER")
      prompt.push({ role: "assistant", content: [{ type: "text", text: "CONTROL-OTTER" }] },
        { role: "user", content: [{ type: "text", text: "What was the marker? Reply only with it." }] })
    }
    expect(claude.runs).toHaveLength(3)
    const id = claude.runs[0]!.args.find((arg) => arg.startsWith("--session-id="))!.split("=")[1]
    expect(claude.runs[0]!.received.filter((message) => message.type === "user")).toHaveLength(4)
    const requests = claude.runs[0]!.received.map((message) => message.request)
    expect(requests).toContainEqual({ subtype: "set_model", model: "sonnet" })
    expect(requests).toContainEqual({ subtype: "apply_flag_settings", settings: { effortLevel: "high" } })
    expect(requests).toContainEqual({ subtype: "apply_flag_settings", settings: { effortLevel: null } })
    expect(claude.runs[0]!.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("2048")
    expect(claude.runs[1]!.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("4096")
    expect(claude.runs[2]!.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined()
    for (const run of claude.runs.slice(1)) {
      expect(run.args).toContain("--model=sonnet")
      expect(run.args).toContain(`--resume=${id}`)
      expect(run.received.find((message) => message.type === "user").message.content).toEqual([{ type: "text", text: "What was the marker? Reply only with it." }])
    }
    yield* test.registry.close()
    claude.check()
  }))

  it.effect("titles keep their task prompt and conversation branches keep Claude's preset without changing the main session", () => Effect.gen(function* () {
    const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn(),
      FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "utility" }), FakeClaude.expectInterrupt(),
      FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "utility" }), FakeClaude.expectInterrupt(),
      FakeClaude.expectInterrupt(),
      FakeClaude.expectStartup(), FakeClaude.expectTurn({ recording: "utility" }), FakeClaude.expectInterrupt(),
      FakeClaude.expectStartup(), FakeClaude.expectTurn({ index: 1 }), FakeClaude.expectInterrupt()])
    const test = yield* TestSessions.start(claude)
    yield* TestSessions.reply(test.model, first)
    yield* TestSessions.reply(test.model, TestSessions.followup(), "session-a", "title")
    yield* TestSessions.reply(test.model, TestSessions.followup(), "session-a", "generate")
    yield* TestSessions.reply(test.model, TestSessions.followup(), "session-a", "compaction")
    yield* TestSessions.reply(test.model, TestSessions.followup())
    expect(claude.runs).toHaveLength(5)
    for (const run of claude.runs.slice(1, 4)) {
      expect(run.args).toContain("--no-session-persistence")
      const init = run.received.find((message) => message.request?.subtype === "initialize").request
      if (run === claude.runs[1]) {
        expect(init.systemPrompt).toEqual(["You are a concise test assistant."])
        expect(init.appendSystemPrompt).toBeUndefined()
      } else {
        expect(init.systemPrompt).toBeUndefined()
        expect(init.appendSystemPrompt).toBe(ClaudeSystemPrompt.primary.append)
        expect(init.systemPromptSnapshot).toBe(false)
      }
      const user = run.received.find((message) => message.type === "user")
      expect(JSON.stringify(user.message.content)).not.toContain("You are a concise test assistant.")
      expect(user.message.content).toContainEqual({ type: "text", text: "What was the marker? Reply only with it." })
    }
    expect(test.storage.data.size).toBe(1)
    expect(claude.forks).toHaveLength(2)
    expect(claude.removed).toEqual(claude.forks.map((fork) => fork.sessionID))
    expect(claude.runs[1]!.args.some((arg) => arg.startsWith("--resume="))).toBe(false)
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
