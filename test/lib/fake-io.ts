export * as FakeIO from "./fake-io.js"

import type { ClaudeIO } from "../../src/claude/io.js"
import type { FakeClaude } from "./fake-claude.js"

export const EXECUTABLE = "/fake/bin/claude"

export function make(input: {
  readonly claude: FakeClaude.Fake
  readonly env?: Record<string, string | undefined>
  readonly sessionExists?: (sessionID: string) => Promise<boolean>
}): ClaudeIO.Interface {
  return {
    spawn: input.claude.spawn,
    which: () => EXECUTABLE,
    env: () => input.env ?? {},
    sessionExists: input.sessionExists ?? (async () => true),
    fork: input.claude.fork,
    remove: input.claude.remove,
  }
}
