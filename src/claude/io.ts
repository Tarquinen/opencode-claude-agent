export * as ClaudeIO from "./io.js"

import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { Worker } from "node:worker_threads"
import whichPkg from "which"
import { ClaudeFork } from "./fork.js"
import { ClaudeSDK } from "./sdk.js"

// Everything that reaches outside opencode. Tests swap it for a fake `claude`.
export interface Interface {
  readonly spawn?: Options["spawnClaudeCodeProcess"]
  readonly which: () => string | undefined
  // Before our isolation settings
  readonly env: () => Record<string, string | undefined>
  readonly sessionExists: (sessionID: string, configDir?: string) => Promise<boolean>
  readonly fork: (sessionID: string, messageID: string, configDir?: string) => Promise<ClaudeFork.Result | undefined>
  readonly remove: (sessionID: string, configDir?: string) => Promise<void>
}

export const real: Interface = {
  which: () => process.env.OPENCODE_CLAUDE_PATH || whichPkg.sync("claude", { nothrow: true }) || undefined,
  env: () => process.env,
  sessionExists: async (sessionID, configDir) => {
    if (configDir) {
      // Look for the transcript the way the SDK does. Loading the SDK in a worker for this would slow every resume.
      const projects = path.join(configDir, "projects")
      const folders = await readdir(projects).catch(() => [])
      for (const folder of folders) {
        const file = await stat(path.join(projects, folder, `${sessionID}.jsonl`)).catch(() => undefined)
        if (file && file.size > 0) return true
      }
      return false
    }
    const { getSessionInfo } = await ClaudeSDK.load()
    return (await getSessionInfo(sessionID)) !== undefined
  },
  fork: (sessionID, messageID, configDir) =>
    configDir ? inFolder(configDir, "fork", [sessionID, messageID]) : helpers.fork(sessionID, messageID),
  remove: (sessionID, configDir) =>
    configDir ? inFolder(configDir, "remove", [sessionID]) : helpers.remove(sessionID),
}

// The SDK's session helpers read CLAUDE_CONFIG_DIR from process.env and take no folder option.
export const helpers = {
  fork: ClaudeFork.create,
  remove: async (sessionID: string) => {
    const { deleteSession } = await ClaudeSDK.load()
    await deleteSession(sessionID)
  },
}

// A worker has its own process.env, so the helpers see another folder without changing it for other sessions.
function inFolder<Name extends keyof typeof helpers>(
  configDir: string,
  name: Name,
  args: Parameters<(typeof helpers)[Name]>,
) {
  const worker = new Worker(new URL("./folder-worker.js", import.meta.url), {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    workerData: { name, args },
  })
  return new Promise<Awaited<ReturnType<(typeof helpers)[Name]>>>((resolve, reject) => {
    worker.once("message", resolve)
    worker.once("error", reject)
    worker.once("exit", () => reject(new Error(`Claude session helper ${name} exited without a result`)))
  }).finally(() => worker.terminate())
}
