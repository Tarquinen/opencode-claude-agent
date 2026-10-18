export * as ClaudeQueryOptions from "./query-options.js"

import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { ClaudeIO } from "./io.js"

// Claude Code features that duplicate opencode's. opencode's version wins (PLAN.md, "Claude Code features to turn off").
const ISOLATION_ENV = {
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  DISABLE_AUTO_COMPACT: "1",
  CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
  ENABLE_TOOL_SEARCH: "false",
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
  MAX_MCP_OUTPUT_TOKENS: "200000",
  // Skips OAuth, so the subscription would not be used
  CLAUDE_CODE_SIMPLE: undefined,
  // OpenCode's selected effort must win over a shell-level Claude override.
  CLAUDE_CODE_EFFORT_LEVEL: undefined,
}

export function base(input: { executable: string; io: ClaudeIO.Interface }): Options {
  return {
    pathToClaudeCodeExecutable: input.executable,
    spawnClaudeCodeProcess: input.io.spawn,
    env: { ...input.io.env(), ...ISOLATION_ENV },
    settingSources: [],
    settings: { disableAllHooks: true },
    // Without summaries, OpenCode has no reasoning text to display
    thinking: { type: "adaptive", display: "summarized" },
    strictMcpConfig: true,
    skills: [],
    tools: [],
    permissionMode: "dontAsk",
    allowedTools: ["mcp__opencode__*"],
    verbatimPrompts: true,
  }
}
