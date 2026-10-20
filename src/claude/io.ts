export * as ClaudeIO from "./io.js"

import { deleteSession, getSessionInfo, type Options } from "@anthropic-ai/claude-agent-sdk"
import whichPkg from "which"
import { ClaudeFork } from "./fork.js"

// Everything that reaches outside opencode. Tests swap it for a fake `claude`.
export interface Interface {
  // Undefined uses the SDK's own spawn
  readonly spawn?: Options["spawnClaudeCodeProcess"]
  readonly which: () => string | undefined
  // Before our isolation settings
  readonly env: () => Record<string, string | undefined>
  readonly sessionExists: (sessionID: string) => Promise<boolean>
  readonly fork: (sessionID: string, messageID: string) => Promise<ClaudeFork.Result | undefined>
  readonly remove: (sessionID: string) => Promise<void>
}

export const real: Interface = {
  which: () => whichPkg.sync("claude", { nothrow: true }) ?? undefined,
  env: () => process.env,
  sessionExists: async (sessionID) => (await getSessionInfo(sessionID)) !== undefined,
  fork: ClaudeFork.create,
  remove: deleteSession,
}
