export * as ConvertClaudeStream from "./convert-claude-stream.js"

import type { LanguageModelV3FunctionTool, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeUsage } from "./usage.js"
import { ToolNames } from "../tools/names.js"
import { ClaudeCodeError } from "./claude-code-error.js"

export function make(tools: readonly LanguageModelV3FunctionTool[] = []) {
  const usage = ClaudeUsage.make()
  const failure = ClaudeCodeError.make()
  const streamed = new Set<string>()
  const blocks = new Map<number, "text" | "reasoning">()
  let messageID = ""
  let calledTools = false
  let metadata: { "claude-code": { sessionID: string; messageID: string } } | undefined

  return (message: SDKMessage): LanguageModelV3StreamPart[] => {
    const parts: LanguageModelV3StreamPart[] = []
    const error = failure(message)
    if (error) return [{ type: "error", error }]
    if (message.type === "stream_event" && message.parent_tool_use_id === null) {
      const event = message.event
      switch (event.type) {
        case "message_start":
          messageID = event.message.id
          metadata = undefined
          streamed.add(messageID)
          usage.update(messageID, event.message.usage)
          parts.push({ type: "response-metadata", id: messageID, modelId: event.message.model })
          break
        case "content_block_start": {
          const block = event.content_block
          const kind = block.type === "text" ? "text" : block.type === "thinking" ? "reasoning" : undefined
          if (!kind) break
          blocks.set(event.index, kind)
          const id = `${messageID}:${event.index}`
          parts.push({ type: `${kind}-start`, id })
          const text = block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : ""
          if (text) parts.push({ type: `${kind}-delta`, id, delta: text })
          break
        }
        case "content_block_delta": {
          const id = `${messageID}:${event.index}`
          if (event.delta.type === "text_delta") parts.push({ type: "text-delta", id, delta: event.delta.text })
          if (event.delta.type === "thinking_delta" && event.delta.thinking) parts.push({ type: "reasoning-delta", id, delta: event.delta.thinking })
          break
        }
        case "content_block_stop": {
          const kind = blocks.get(event.index)
          if (kind) parts.push({ type: `${kind}-end`, id: `${messageID}:${event.index}`, providerMetadata: metadata })
          blocks.delete(event.index)
          break
        }
        case "message_delta":
          usage.update(messageID, event.usage)
          break
        case "message_stop":
          // The same boundary where ClaudeSession.readStep returns "tools". Both must agree, or a step ends without a finish.
          if (calledTools) parts.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: usage.snapshot() })
          break
      }
    }
    if (message.type === "assistant" && message.parent_tool_use_id === null) {
      // Synthetic API errors are diagnostics, not assistant answers.
      if (message.error) return parts
      // The complete block carries the transcript UUID, unlike the API message ID on stream events.
      metadata = { "claude-code": { sessionID: message.session_id, messageID: message.uuid } }
      usage.update(message.message.id, message.message.usage)
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue
        calledTools = true
        parts.push({ type: "tool-call", toolCallId: block.id, toolName: ToolNames.original(block.name, tools), input: JSON.stringify(block.input), providerMetadata: metadata })
      }
      // Complete assistant blocks repeat the streamed content. Only use them when no stream was sent.
      if (!streamed.has(message.message.id)) {
        for (let i = 0; i < message.message.content.length; i++) {
          const block = message.message.content[i]!
          const id = `${message.uuid}:${i}`
          if (block.type === "text") parts.push({ type: "text-start", id }, { type: "text-delta", id, delta: block.text }, { type: "text-end", id, providerMetadata: metadata })
          if (block.type === "thinking") parts.push({ type: "reasoning-start", id }, { type: "reasoning-delta", id, delta: block.thinking }, { type: "reasoning-end", id })
        }
      }
    }
    if (message.type === "result") {
      if (message.num_turns === 1) usage.result(message.usage)
      parts.push({
        type: "finish",
        finishReason: { unified: message.stop_reason === "max_tokens" ? "length" : "stop", raw: message.stop_reason ?? undefined },
        usage: usage.snapshot(),
      })
    }
    return parts
  }
}
