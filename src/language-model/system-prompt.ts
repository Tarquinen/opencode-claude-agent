export * as ClaudeSystemPrompt from "./system-prompt.js"

import type { Options } from "@anthropic-ai/claude-agent-sdk"

// Keep Claude Code's own instructions, as OpenChamber and T3 Code do. Phase 4 adds tool
// guidance; phase 6 adds custom agent roles and opencode's project instructions.
export const primary = {
  type: "preset",
  preset: "claude_code",
  append: "<runtime_info>You are running in OpenCode through the Claude Code harness. Mention this only when asked.</runtime_info>",
} satisfies Options["systemPrompt"]

// Side calls don't need the coding prompt. Their task instructions go in the user message.
export const utility = "You are a text generation helper running in OpenCode through the Claude Code harness. Follow the instructions in the user message and return only the requested output."
