export * as ClaudeIO from "./io.js"

import { getSessionInfo, type Options } from "@anthropic-ai/claude-agent-sdk"

// Everything that reaches outside opencode when talking to Claude Code. Tests swap it for a fake `claude`.
export interface Interface {
  // Starts the `claude` program. Undefined uses the SDK's own spawn.
  readonly spawn?: Options["spawnClaudeCodeProcess"]
  // Finds `claude` when the plugin options don't give a path
  readonly which: () => string | undefined
  // The environment `claude` starts with, before our isolation settings
  readonly env: () => Record<string, string | undefined>
  readonly sessionExists: (sessionID: string) => Promise<boolean>
}

export const real: Interface = {
  which: () => Bun.which("claude") ?? undefined,
  env: () => process.env,
  sessionExists: async (sessionID) => (await getSessionInfo(sessionID)) !== undefined,
}
