export * as TestPlugin from "./test-plugin.js"

import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { Model, Provider } from "@opencode/plugin/effect"
import { define } from "@opencode/plugin/effect/plugin"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import { SdkPlaceholder } from "../../src/language-model/sdk-placeholder.js"

export const model = Model.Ref.make({ providerID: Provider.ID.make("scripted"), id: Model.ID.make("normal") })

export function text(value: string): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: value },
    { type: "text-end", id: "text" },
  ]
}

export function make(input: {
  readonly replies: readonly (readonly LanguageModelV3StreamPart[])[]
  readonly context?: (event: SessionContext) => void
}) {
  const requests: LanguageModelV3CallOptions[] = []
  let next = 0
  let toolCalls = 0
  const language: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "scripted",
    modelId: "normal",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("Expected streaming")
    },
    doStream: async (options) => {
      requests.push(options)
      const reply = input.replies[next++]
      if (!reply) throw new Error("No scripted reply remains")
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            for (const part of reply) controller.enqueue(part)
            controller.enqueue({
              type: "finish",
              finishReason: {
                unified: reply.some((part) => part.type === "tool-call") ? "tool-calls" : "stop",
                raw: undefined,
              },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            })
            controller.close()
          },
        }),
      }
    },
  }
  const plugin = define({
    id: "sync-test",
    effect: Effect.fn(function* (ctx) {
      yield* ctx.provider.transform((editor) =>
        editor.add({
          info: {
            id: model.providerID,
            name: "Scripted",
            activation: "enabled",
            package: `aisdk:${SdkPlaceholder.url}`,
          },
          models: [
            {
              ...Model.Info.default(model.providerID, model.id),
              capabilities: { ...Model.Info.default(model.providerID, model.id).capabilities, tools: true },
            },
          ],
        }),
      )
      yield* ctx.aisdk.hook(
        "sdk",
        (event) =>
          Effect.sync(() => {
            event.sdk = { languageModel: () => language }
          }),
        { providerID: model.providerID },
      )
      yield* ctx.session.hook("context", (event) => Effect.sync(() => input.context?.(event)))
      yield* ctx.session.hook("title", (event) =>
        Effect.sync(() => {
          event.result = "Sync test"
        }),
      )
      yield* ctx.session.hook(
        "retry",
        (event) =>
          Effect.sync(() => {
            event.decision = { retry: false }
          }),
        { providerID: model.providerID },
      )
      yield* ctx.tool.transform((editor) =>
        editor.add({
          name: "marker",
          description: "Read the fixture marker",
          input: { type: "object", properties: {} },
          options: { codemode: false },
          execute: () =>
            Effect.sync(() => {
              toolCalls++
              return { content: "LEMON-IBIS" }
            }),
        }),
      )
    }),
  })
  return {
    plugin,
    requests,
    get toolCalls() {
      return toolCalls
    },
    check() {
      if (next !== input.replies.length) throw new Error(`${input.replies.length - next} scripted replies remain`)
    },
  }
}
