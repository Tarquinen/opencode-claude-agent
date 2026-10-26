export * as ClaudeSystemPrompt from "./system-prompt.js"

import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"

export const AGENT_OPTION = "claudeCodeAgent"

const primary = {
  type: "preset",
  preset: "claude_code",
  // Agent changes must take effect when a process resumes the same native session.
  snapshot: false,
  append:
    "<runtime_info>You are running in OpenCode through the Claude Code harness. Mention this only when asked.</runtime_info>",
} satisfies Options["systemPrompt"]

const MCP_INSTRUCTIONS = /<mcp_instructions>[\s\S]*?<\/mcp_instructions>/g
const SKILLS = /Skills provide specialized instructions[\s\S]*?<\/available_skills>/g

export function make(prompt: LanguageModelV3Prompt, role?: string) {
  const blocks = [primary.append]
  if (role) blocks.push("# Agent role (from OpenCode)\n" + role)
  for (const message of prompt) {
    if (message.role !== "system") continue
    const text = message.content
    for (const match of text.matchAll(MCP_INSTRUCTIONS)) blocks.push(match[0])
    for (const match of text.matchAll(SKILLS)) blocks.push(match[0])
    const catalog = codeModeCatalog(text)
    if (catalog) blocks.push(catalog)
    const instructions = projectInstructions(text)
    if (instructions) blocks.push("# Project instructions (loaded by OpenCode)\n" + instructions)
  }
  return { ...primary, append: blocks.join("\n\n") }
}

function codeModeCatalog(text: string) {
  const start = text.indexOf("# Code Mode\n")
  if (start < 0) return
  const heading = text.indexOf("## Available tools", start)
  if (heading < 0) return
  // Catalog signatures span lines; OpenCode separates the next instruction source with a blank line.
  const end = text.indexOf("\n\n", heading + "## Available tools\n\n".length)
  if (end < 0) return text.slice(start).trim()
  return text.slice(start, end).trim()
}

function projectInstructions(text: string) {
  const start = text.search(/^Instructions from: /m)
  if (start < 0) return
  // Instruction files can contain blank lines; OpenCode places its date/environment block after all of them.
  const end = text.indexOf("\n\nToday's date:", start)
  if (end < 0) return text.slice(start).trim()
  return text.slice(start, end).trim()
}

export function utility(prompt: LanguageModelV3Prompt) {
  const blocks = prompt.filter((message) => message.role === "system").map((message) => message.content)
  return blocks.join("\n\n") || "You are a text generation helper. Return only the requested output."
}
