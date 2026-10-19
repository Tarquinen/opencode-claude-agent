export * as RequestKind from "./request-kind.js"

import type { SessionRequestKind } from "@opencode/plugin/effect/session"

export const HEADER = "x-opencode-claude-code-kind"
export const SESSION_HEADER = "x-opencode-session-id"
export const FORK_HEADER = "x-opencode-claude-code-fork-source"
export type Kind = SessionRequestKind
