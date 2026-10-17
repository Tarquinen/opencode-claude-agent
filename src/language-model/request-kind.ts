export * as RequestKind from "./request-kind.js"

export const HEADER = "x-opencode-claude-code-kind"
export const SESSION_HEADER = "x-opencode-session-id"
export const FORK_HEADER = "x-opencode-claude-code-fork-source"
export type Kind = "primary" | "title" | "compaction" | "generate"
