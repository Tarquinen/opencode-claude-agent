export * as ClaudeSystemPrompt from "./system-prompt.js"

import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"

export const AGENT_OPTION = "claudeCodeAgent"

export const primary = {
  type: "preset",
  preset: "claude_code",
  // Agent changes must take effect when a process resumes the same native session.
  snapshot: false,
  append: "<runtime_info>You are running in OpenCode through the Claude Code harness. Mention this only when asked.</runtime_info>",
} satisfies Options["systemPrompt"]

const routing = `<opencode_tools>
Use the tools exposed by OpenCode under mcp__opencode__. OpenCode executes them and owns permissions. Claude Code's built-in tools are unavailable.
Prefer dedicated read, glob and grep tools over shell commands. Use the provided edit/patch/write tools for file changes and subagent for delegation.
Use execute for Code Mode tools exactly as the catalog below specifies. Names inside execute are the catalog's paths, not MCP-prefixed names.
Use the skill tool to load a relevant skill before following its workflow. Tool and catalog updates in the conversation supersede earlier definitions.
</opencode_tools>`

export function make(prompt: LanguageModelV3Prompt, hasTools: boolean, role?: string) {
  const blocks = [primary.append]
  if (role) blocks.push("# Agent role (from OpenCode)\n" + role)
  if (hasTools) blocks.push(routing)
  for (const message of prompt) {
    if (message.role !== "system") continue
    const text = message.content
    for (const pattern of [/<mcp_instructions>[\s\S]*?<\/mcp_instructions>/g,
      /Skills provide specialized instructions[\s\S]*?<\/available_skills>/g]) {
      for (const match of text.matchAll(pattern)) blocks.push(match[0])
    }
    // OpenCode joins catalog entries with newlines and instruction sources with blank lines.
    // Descriptions and TypeScript signatures can span several lines within the catalog.
    const start = text.indexOf("# Code Mode\n")
    const catalog = start < 0 ? -1 : text.indexOf("## Available tools", start)
    if (catalog >= 0) {
      const end = text.indexOf("\n\n", catalog + "## Available tools\n\n".length)
      blocks.push(text.slice(start, end < 0 ? undefined : end).trim())
    }
    // OpenCode renders discovered/configured instruction files together, immediately
    // before its date/environment block. Preserve their full text, including blank lines.
    const instructions = text.search(/^Instructions from: /m)
    if (instructions >= 0) {
      const end = text.indexOf("\n\nToday's date:", instructions)
      blocks.push("# Project instructions (loaded by OpenCode)\n" + text.slice(instructions, end < 0 ? undefined : end).trim())
    }
  }
  return { ...primary, append: blocks.join("\n\n") }
}

// OpenCode owns side-call tasks and model selection. Keep its instructions in the system role.
export function utility(prompt: LanguageModelV3Prompt) {
  const blocks: string[] = []
  for (const message of prompt) {
    if (message.role === "system") blocks.push(message.content)
  }
  return blocks.join("\n\n") || "You are a text generation helper. Return only the requested output."
}
