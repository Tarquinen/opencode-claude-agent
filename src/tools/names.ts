export * as ToolNames from "./names.js"

import { createHash } from "node:crypto"
import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider"

export const PREFIX = "mcp__opencode__"

export function short(name: string) {
  const limit = 64 - PREFIX.length
  if (name.length <= limit && /^[a-zA-Z0-9_-]+$/.test(name)) return name
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 10)
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, limit - 11) + "_" + hash
}

export function original(name: string, tools: readonly LanguageModelV3FunctionTool[]) {
  const tool = tools.find((tool) => PREFIX + short(tool.name) === name)
  if (tool) return tool.name
  throw new Error(`Claude Code called an unregistered OpenCode tool: ${name}`)
}

// Claude Code cuts each MCP tool description at this many characters.
const DESCRIPTION_LIMIT = 2048

export function description(tool: LanguageModelV3FunctionTool) {
  const text = tool.description ?? ""
  if (tool.name !== "subagent" || text.length <= DESCRIPTION_LIMIT) return text.slice(0, DESCRIPTION_LIMIT)
  // The subagent list comes last in a long description, so move it first to keep it after the cut.
  const agents = text.indexOf("Available subagents:")
  if (agents === -1) return text.slice(0, DESCRIPTION_LIMIT)
  return (text.slice(agents) + "\n\n" + text.slice(0, agents)).slice(0, DESCRIPTION_LIMIT)
}
