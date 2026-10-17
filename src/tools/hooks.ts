export * as ToolHooks from "./hooks.js"

import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { PendingTools } from "./pending.js"

export function make(pending: PendingTools.Interface): Options["hooks"] {
  return {
    PreToolUse: [{ hooks: [async (input) => {
      if (input.hook_event_name === "PreToolUse") pending.before(input.tool_use_id, input.tool_name)
      return {}
    }] }],
    PostToolUse: [{ hooks: [async (input) => {
      if (input.hook_event_name !== "PostToolUse") return {}
      const replacement = pending.after(input.tool_use_id)
      return replacement ? { hookSpecificOutput: { hookEventName: "PostToolUse", updatedMCPToolOutput: replacement } } : {}
    }] }],
  }
}
