export * as ClaudeCodeOptions from "./options.js"

import { Schema } from "effect"

// Options from the opencode config: { "package": "...", "options": { ... } }
export const Options = Schema.Struct({
  // Found on PATH when unset
  claudePath: Schema.optional(Schema.String),
  // Close idle Claude processes after five minutes by default; their next turn resumes from disk.
  idleTimeoutMs: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
})
export type Options = typeof Options.Type

export const decode = Schema.decodeUnknownEffect(Options)
