export * as ConvertToClaudeMessage from "./convert-to-claude-message.js"

import type { LanguageModelV3FilePart, LanguageModelV3Prompt } from "@ai-sdk/provider"
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages"

// Preserve task instructions for titles, compaction and generate, whose system prompt is fixed.
export function utility(prompt: LanguageModelV3Prompt): ContentBlockParam[] {
  const parts: string[] = []
  for (const message of prompt) {
    if (message.role === "system") parts.push(message.content)
  }
  const blocks = content(prompt)
  if (parts.length > 0) blocks.unshift({ type: "text", text: `<instructions>\n${parts.join("\n\n")}\n</instructions>` })
  return blocks
}

// A fresh/throwaway query has no history. Preserve roles as text, and attachments as real content blocks.
export function content(prompt: LanguageModelV3Prompt): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = []
  const history = prompt.some((message) => message.role === "assistant" || message.role === "tool")
  for (const message of prompt) {
    if (message.role === "system") continue
    if (history) blocks.push({ type: "text", text: `<${message.role}>` })
    for (const part of message.content) {
      if (part.type === "text") blocks.push({ type: "text", text: part.text })
      else if (part.type === "file") blocks.push(file(part))
      else if (part.type === "tool-call") blocks.push({ type: "text", text: `<tool-call>\n${JSON.stringify({ id: part.toolCallId, name: part.toolName, input: part.input })}\n</tool-call>` })
      else if (part.type === "tool-result") {
        blocks.push({ type: "text", text: `<tool-result>\n${JSON.stringify({ id: part.toolCallId, name: part.toolName, output: part.output })}\n</tool-result>` })
      }
    }
    if (history) blocks.push({ type: "text", text: `</${message.role}>` })
  }
  return blocks
}

function file(part: LanguageModelV3FilePart): ContentBlockParam {
  const source = part.data instanceof URL
    ? { type: "url" as const, url: part.data.href }
    : { type: "base64" as const, data: typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64") }
  if (part.mediaType === "application/pdf") {
    return { type: "document", source: source.type === "url" ? source : { ...source, media_type: "application/pdf" } }
  }
  if (part.mediaType === "image/png" || part.mediaType === "image/jpeg" || part.mediaType === "image/gif" || part.mediaType === "image/webp") {
    return { type: "image", source: source.type === "url" ? source : { ...source, media_type: part.mediaType } }
  }
  throw new Error(`Claude Code does not support ${part.mediaType} attachments`)
}
