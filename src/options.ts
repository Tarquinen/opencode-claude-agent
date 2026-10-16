export * as ClaudeCodeOptions from "./options.js"

import { Schema } from "effect"

// Options from the opencode config: { "package": "...", "options": { ... } }
export const Options = Schema.Struct({
  // Path to the `claude` program. Found on PATH when unset.
  claudePath: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

export const decode = Schema.decodeUnknownEffect(Options)
