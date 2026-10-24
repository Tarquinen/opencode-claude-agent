import { describe, expect } from "bun:test"
import { Location, Model } from "@opencode/plugin/effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Deferred, Effect } from "effect"
import { ClaudeSessions } from "../../src/claude/sessions.js"
import { ClaudeProvider } from "../../src/plugin/provider.js"
import { it } from "../lib/effect.js"
import { FakeClaude } from "../lib/fake-claude.js"
import { FakeIO } from "../lib/fake-io.js"
import { TestOpenCode } from "../lib/opencode.js"
import { TestTools } from "../lib/tools.js"

describe("embedded OpenCode tools", () => {
  for (const stop of ["interrupt", "reject"] as const) {
    it.live(
      `OpenCode ${stop} starts the follow-up as a fresh Claude turn`,
      () =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const plugin = define({
            id: "stopped-tools",
            effect: Effect.fn(function* (ctx) {
              yield* ctx.session.hook("title", (event) =>
                Effect.sync(() => {
                  event.result = "Stopped tools"
                }),
              )
              yield* ctx.permission.hook("evaluate", (event) =>
                Effect.sync(() => {
                  if (event.action === "fixture") event.effect = "ask"
                }),
              )
              yield* ctx.tool.transform((editor) => {
                for (const tool of TestTools.tools)
                  editor.add({
                    name: tool.name,
                    description: tool.description!,
                    input: tool.inputSchema,
                    options: { codemode: false },
                    execute: (_, context) =>
                      Effect.gen(function* () {
                        if (stop === "reject")
                          yield* ctx.permission.assert({
                            sessionID: context.sessionID,
                            action: "fixture",
                            resources: ["marker"],
                          })
                        yield* Deferred.succeed(entered, undefined)
                        return yield* Effect.never
                      }),
                  })
              })
            }),
          })
          const claude = FakeClaude.make(FakeClaude.replay("tools-abort"), { probes: true })
          const registry = ClaudeSessions.registry()
          yield* Effect.addFinalizer(() => registry.close())
          const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), registry, plugins: [plugin] })
          yield* TestOpenCode.connect(test.opencode)
          const session = yield* test.opencode.session.create({
            title: "Stopped tools",
            location: { directory: Location.PublicRef.fields.directory.make(test.directory) },
            model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }),
          })
          yield* test.opencode.session.prompt({ sessionID: session.id, text: "Look up keys a and b." })
          if (stop === "interrupt") {
            yield* Deferred.await(entered)
            yield* test.opencode.session.interrupt({ sessionID: session.id })
          }
          if (stop === "reject") {
            const pending = yield* TestOpenCode.waitUntil(
              test.opencode.permission.list({ sessionID: session.id }),
              (requests) => requests.length > 0,
            )
            yield* test.opencode.permission.reply({
              sessionID: session.id,
              requestID: pending[0]!.id,
              decision: "reject",
            })
          }
          yield* test.opencode.session.wait({ sessionID: session.id })
          yield* test.opencode.session.prompt({
            sessionID: session.id,
            text: "Do not call tools. Reply only CONTINUED-OTTER.",
          })
          yield* test.opencode.session.wait({ sessionID: session.id })
          const runs = claude.runs.filter((run) => run.args.includes("--include-partial-messages"))
          expect(runs).toHaveLength(1)
          const messages = runs[0]!.received
          expect(messages.filter((message) => message.request?.subtype === "interrupt")).toHaveLength(1)
          const user = messages.filter((message) => message.type === "user").at(-1)
          expect(user.priority).toBeUndefined()
          expect(user.message.content.at(-1).text).toBe("Do not call tools. Reply only CONTINUED-OTTER.")
          expect(JSON.stringify(user.message.content)).toContain(
            stop === "interrupt" ? "Tool execution interrupted" : "The user declined this tool call",
          )
          const history = yield* test.opencode.session.export({ sessionID: session.id })
          const last = history.messages.filter((message) => message.type === "assistant").at(-1)!
          expect(last.content).toContainEqual(expect.objectContaining({ type: "text", text: "CONTINUED-OTTER" }))
          yield* registry.close()
          claude.check()
        }),
      15_000,
    )
  }

  it.live(
    "OpenCode asks permission and sends a rejection as a tool error",
    () =>
      Effect.gen(function* () {
        const name = "restricted_" + "resource_".repeat(12)
        let executed = false
        const plugin = define({
          id: "permission-test",
          effect: Effect.fn(function* (ctx) {
            yield* ctx.session.hook("title", (event) =>
              Effect.sync(() => {
                event.result = "Permission test"
              }),
            )
            yield* ctx.permission.hook("evaluate", (event) =>
              Effect.sync(() => {
                if (event.action === "fixture") event.effect = "ask"
              }),
            )
            yield* ctx.tool.transform((editor) =>
              editor.add({
                name,
                description: "Read a restricted fixture.",
                input: { type: "object", properties: {} },
                options: { codemode: false },
                execute: (_, context) =>
                  Effect.gen(function* () {
                    yield* ctx.permission.assert({
                      sessionID: context.sessionID,
                      action: "fixture",
                      resources: ["marker"],
                    })
                    executed = true
                    return { content: "unexpected success" }
                  }),
              }),
            )
          }),
        })
        const steps = FakeClaude.replay("tools-media")
        const restart = steps.findIndex((step, index) => index > 0 && step.type === "startup")
        expect(restart).toBeGreaterThan(0)
        const claude = FakeClaude.make(steps.slice(restart), { probes: true })
        const registry = ClaudeSessions.registry()
        yield* Effect.addFinalizer(() => registry.close())
        const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), registry, plugins: [plugin] })
        yield* TestOpenCode.connect(test.opencode)
        const session = yield* test.opencode.session.create({
          title: "Permission test",
          location: { directory: Location.PublicRef.fields.directory.make(test.directory) },
          model: Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("haiku") }),
        })
        yield* test.opencode.session.prompt({
          sessionID: session.id,
          text: "Read the restricted fixture. Stop if denied.",
        })
        const requests = yield* TestOpenCode.waitUntil(
          test.opencode.permission.list({ sessionID: session.id }),
          (requests) => requests.length > 0,
        )
        expect(executed).toBe(false)
        yield* test.opencode.permission.reply({
          sessionID: session.id,
          requestID: requests[0]!.id,
          decision: "reject",
          message: "Permission denied: DENIED-IBIS. Do not retry.",
        })
        yield* test.opencode.session.wait({ sessionID: session.id })
        expect(executed).toBe(false)
        const response = claude.runs
          .flatMap((run) => run.received)
          .find((message) => message.response?.response?.mcp_response?.result)
        expect(response.response.response.mcp_response.result).toMatchObject({ isError: true })
        expect(JSON.stringify(response)).toContain("DENIED-IBIS")
        yield* registry.close()
        claude.check()
      }),
    15_000,
  )
})
