export * as TestOpenCode from "./opencode.js"

import { Integration } from "@opencode/plugin/effect"
import type { Plugin } from "@opencode/plugin/effect/plugin"
import { OpenCode } from "@opencode/sdk/effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Schedule, type Duration } from "effect"
import type { ClaudeIO } from "../../src/claude/io.js"
import type { ClaudeSessions } from "../../src/claude/sessions.js"
import { make } from "../../src/index.js"
import { ClaudeIntegration } from "../../src/plugin/integration.js"
import { ClaudeProvider } from "../../src/plugin/provider.js"

export type Client = OpenCode.Interface

// A restart test keeps this folder in its outer scope while it opens and closes two hosts inside it.
export const tempDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(path.join(tmpdir(), "claude-code-plugin-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
)

// Runs opencode inside the test with our plugin, built from the given ClaudeIO. Everything lives in a temp folder
// and, by default, an in-memory database. Restart tests can pass a shared folder and database path.
export const start = Effect.fn("TestOpenCode.start")(function* (input: {
  readonly io: ClaudeIO.Interface
  readonly directory?: string
  readonly database?: string
  readonly registry?: ClaudeSessions.Registry
  readonly plugins?: readonly Plugin[]
  readonly config?: Record<string, unknown>
}) {
  const directory = input.directory ?? (yield* tempDirectory)
  const opencode = yield* OpenCode.create({
    database: input.database ? { path: input.database } : undefined,
    config: { directory, project: false, content: JSON.stringify(input.config ?? {}) },
    models: { fetch: false },
    fs: { filewatcher: false },
    plugins: [make(input.io, input.registry), ...input.plugins ?? []],
  })
  // Listing models waits for plugins to finish loading
  yield* opencode.model.list()
  return { opencode, directory }
})

// Picks our login method, as a user does in the provider list
export const connect = Effect.fn("TestOpenCode.connect")(function* (opencode: Client) {
  yield* opencode.integration.connect.external({
    integrationID: Integration.ID.make(ClaudeProvider.ID),
    methodID: Integration.MethodID.make(ClaudeIntegration.METHOD_ID),
  })
})

// IDs of the Claude Code models opencode offers
export const models = Effect.fn("TestOpenCode.models")(function* (opencode: Client) {
  const list = yield* opencode.model.list()
  const ids: string[] = []
  for (const model of list.data) {
    if (model.providerID === ClaudeProvider.ID) ids.push(String(model.id))
  }
  return ids
})

// Our active connection, including any problem the plugin reported on it
export const connection = Effect.fn("TestOpenCode.connection")(function* (opencode: Client) {
  const list = yield* opencode.integration.list()
  for (const integration of list.data) {
    if (String(integration.id) === ClaudeProvider.ID) return integration.connections[0]
  }
  return undefined
})

// The plugin updates opencode in the background, so tests check again until opencode shows the change
export function waitUntil<A, E>(read: Effect.Effect<A, E>, done: (value: A) => boolean, timeout: Duration.Input = "5 seconds") {
  return read.pipe(
    Effect.repeat({ until: done, schedule: Schedule.spaced("10 millis") }),
    Effect.timeout(timeout),
  )
}
