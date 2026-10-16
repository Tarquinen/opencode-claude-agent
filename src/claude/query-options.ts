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
  // Skips OAuth, so the subscription would not be used
  CLAUDE_CODE_SIMPLE: undefined,
}

// The settings every query starts from: the user's `claude`, opencode's tools only, and nothing from ~/.claude.
export function base(input: { executable: string; io: ClaudeIO.Interface }): Options {
  return {
    pathToClaudeCodeExecutable: input.executable,
    spawnClaudeCodeProcess: input.io.spawn,
    env: { ...input.io.env(), ...ISOLATION_ENV },
    settingSources: [],
    settings: { disableAllHooks: true },
    strictMcpConfig: true,
    skills: [],
    tools: [],
    permissionMode: "dontAsk",
    allowedTools: ["mcp__opencode__*"],
    verbatimPrompts: true,
  }
}
