export * as ToolResult from "./result.js"

import type { LanguageModelV3FilePart, LanguageModelV3Prompt, LanguageModelV3ToolResultOutput } from "@ai-sdk/provider"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { ConvertToClaudeMessage } from "../language-model/convert-to-claude-message.js"
import { Fingerprint } from "../sync/fingerprint.js"

export function convert(output: LanguageModelV3ToolResultOutput, files: readonly LanguageModelV3FilePart[] = [], failed = false) {
  const parts: Array<{ type: "text"; text: string } | LanguageModelV3FilePart> = []
  switch (output.type) {
    case "text": case "error-text": parts.push({ type: "text", text: output.value }); break
    case "json": case "error-json": parts.push({ type: "text", text: JSON.stringify(output.value) }); break
    case "execution-denied": parts.push({ type: "text", text: output.reason ?? "Tool execution was denied by the user." }); break
    case "content":
      for (const part of output.value) {
        if (part.type === "text") parts.push({ type: "text", text: part.text })
        else if (part.type === "image-data" || part.type === "file-data") parts.push({ type: "file", mediaType: part.mediaType, data: part.data })
        else if (part.type === "image-url") parts.push({ type: "file", mediaType: "image/png", data: new URL(part.url) })
        else throw new Error(`Claude Code does not support ${part.type} tool output`)
      }
  }
  parts.push(...files)
  const content = ConvertToClaudeMessage.content([{ role: "user", content: parts }])
  const isError = failed || output.type === "error-text" || output.type === "error-json" || output.type === "execution-denied"
  const mcp: CallToolResult = { content: [], isError }
  let replace = false
  for (const block of content) {
    if (block.type === "text") mcp.content.push({ type: "text", text: block.text })
    else if (block.type === "image" && block.source.type === "base64") {
      mcp.content.push({ type: "image", mimeType: block.source.media_type, data: block.source.data })
    } else {
      replace = true
      mcp.content.push({ type: "text", text: "Attached document or image follows." })
    }
  }
  // The hook replaces tool_result.content, not the entire MCP envelope.
  return { mcp, replacement: replace ? content : undefined }
}

export type Result = ReturnType<typeof convert>

// OpenCode puts a tool group's media in one following user message. Return it with the group's last result.
export function collect(prompt: LanguageModelV3Prompt, start: number) {
  const results = new Map<string, Result>()
  let end = start
  let aborted = false
  for (const group of Fingerprint.groups(prompt.slice(start))) {
    if (group.role !== "tool") break
    const messages = prompt.slice(start + group.start, start + group.end)
    const tools = []
    const files: LanguageModelV3FilePart[] = []
    for (const message of messages) {
      if (message.role === "tool") {
        for (const part of message.content) if (part.type === "tool-result") tools.push(part)
      }
      if (message.role === "user") for (const part of message.content) if (part.type === "file") files.push(part)
    }
    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i]!
      if (tool.providerOptions?.["claude-code"]?.toolAborted === true) aborted = true
      results.set(tool.toolCallId, convert(tool.output, i === tools.length - 1 ? files : [], tool.providerOptions?.["claude-code"]?.toolError === true))
    }
    end = start + group.end
  }
  return { results, end, aborted }
}
