export * as TestTools from "./tools.js"

import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider"
import { Effect } from "effect"
import type { ClaudeAgentLanguageModel } from "../../src/language-model/claude-agent-language-model.js"
import { RequestKind } from "../../src/language-model/request-kind.js"
import { TestSessions } from "./sessions.js"
import type { ClaudeIO } from "../../src/claude/io.js"
import { ClaudeSession } from "../../src/claude/session.js"
import { ClaudeQueryOptions } from "../../src/claude/query-options.js"
import { ClaudeSystemPrompt } from "../../src/language-model/system-prompt.js"
import { ConvertToClaudeMessage } from "../../src/language-model/convert-to-claude-message.js"
import { PendingTools } from "../../src/tools/pending.js"
import { ToolHooks } from "../../src/tools/hooks.js"
import { ToolServer } from "../../src/tools/server.js"

export const tools: LanguageModelV3FunctionTool[] = [
  {
    type: "function",
    name: "lookup",
    description: "Look up a fixture marker by key.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", enum: ["a", "b"] } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "confirm",
    description: "Confirm the two looked-up markers and get the final marker.",
    inputSchema: {
      type: "object",
      properties: { markers: { type: "array", items: { type: "string" } } },
      required: ["markers"],
      additionalProperties: false,
    },
  },
]

export const prompt = () =>
  TestSessions.prompt(
    "Call lookup twice in a single response, once with key a and once with key b. After both results, call confirm with those two markers. Then reply only with the final marker returned by confirm.",
  )

// Observe the real MCP handler, rather than assuming an emitted tool call has already reached it.
export const park = Effect.fn(function* (io: ClaudeIO.Interface, directory: string) {
  const pending = PendingTools.make()
  const entered = Promise.withResolvers<void>()
  const settled = Promise.withResolvers<void>()
  const session = ClaudeSession.start({
    ...ClaudeQueryOptions.base({ executable: io.which()!, io }),
    cwd: directory,
    model: "haiku",
    sessionId: crypto.randomUUID(),
    includePartialMessages: true,
    systemPrompt: ClaudeSystemPrompt.make(prompt(), true),
    hooks: ToolHooks.make(pending),
    mcpServers: {
      opencode: ToolServer.make(tools, {
        ...pending,
        async call(name) {
          const result = pending.call(name)
          entered.resolve()
          return result.finally(() => settled.resolve())
        },
      }),
    },
  })
  yield* Effect.addFinalizer(() => Effect.promise(() => session.stop().finally(() => pending.clear())))
  yield* Effect.promise(() => session.ready)
  session.begin(ConvertToClaudeMessage.content(prompt()))
  const boundary = yield* Effect.promise(() => session.readStep(() => {}))
  if (boundary !== "tools") throw new Error("Expected a tool step")
  yield* Effect.promise(() => entered.promise)
  return { session, pending, settled: settled.promise }
})

export const step = Effect.fn(function* (
  model: ClaudeAgentLanguageModel.Model,
  prompt: LanguageModelV3Prompt,
  offered = tools,
) {
  const result = yield* Effect.promise(() =>
    model.doStream({
      prompt,
      tools: offered,
      headers: { [RequestKind.SESSION_HEADER]: "session-a", [RequestKind.HEADER]: "primary" },
    }),
  )
  const parts = yield* Effect.tryPromise(() => TestSessions.collect(result.stream))
  const error = parts.find((part) => part.type === "error")
  if (error) throw error.error
  return parts
})

export function append(
  prompt: LanguageModelV3Prompt,
  parts: readonly LanguageModelV3StreamPart[],
  result: (name: string, input: any) => LanguageModelV3ToolResultPart["output"],
  providerOptions?: LanguageModelV3ToolResultPart["providerOptions"],
) {
  const content: Extract<LanguageModelV3Prompt[number], { role: "assistant" }>["content"] = []
  const outputs: LanguageModelV3ToolResultPart[] = []
  for (const part of parts) {
    if (part.type === "text-delta") content.push({ type: "text", text: part.delta })
    if (part.type === "tool-call") {
      const input = JSON.parse(part.input)
      content.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input })
      outputs.push({
        type: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: result(part.toolName, input),
        providerOptions,
      })
    }
  }
  prompt.push({ role: "assistant", content })
  if (outputs.length) prompt.push({ role: "tool", content: outputs })
}

export function output(name: string, input: any): LanguageModelV3ToolResultPart["output"] {
  return { type: "text", value: name === "confirm" ? "COPPER-OTTER" : input.key === "a" ? "LILAC-HERON" : "LEMON-IBIS" }
}
