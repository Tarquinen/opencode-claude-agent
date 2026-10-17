export * as SyncDecision from "./decide.js"

import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { Fingerprint } from "./fingerprint.js"
import type { SessionRecord } from "./record.js"

export function decide(prompt: LanguageModelV3Prompt, record?: SessionRecord.Record) {
  const groups = Fingerprint.groups(prompt)
  const saved = record?.history
  if (!saved?.length) return { kind: "fresh", start: 0 } as const
  let matched = 0
  while (matched < saved.length && matched < groups.length && saved[matched]!.hash === groups[matched]!.hash) matched++
  if (matched === 0) return { kind: "fresh", start: 0 } as const
  // Phase 5 will fork at the last matching Claude message. Until then, rebuild from authoritative history.
  if (matched < saved.length) return { kind: "changed", start: 0 } as const
  const start = groups[matched]?.start ?? prompt.length
  const missed = groups.slice(matched)
  const kind = missed.some((group) => group.role !== "user") ? "catch-up" : "continue"
  return { kind, start } as const
}
