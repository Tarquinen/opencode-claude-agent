export * as FakeIO from "./fake-io.js"

import type { ClaudeIO } from "../../src/claude/io.js"
import type { FakeClaude } from "./fake-claude.js"

export const EXECUTABLE = "/fake/bin/claude"

// ClaudeIO with the fake `claude` in place of the real one
export function make(input: {
  readonly claude: FakeClaude.Fake
  readonly env?: Record<string, string | undefined>
}): ClaudeIO.Interface {
  return {
    spawn: input.claude.spawn,
    which: () => EXECUTABLE,
    env: () => input.env ?? {},
  }
}
