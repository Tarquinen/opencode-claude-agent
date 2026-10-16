export * as RequestKind from "./request-kind.js"

export const HEADER = "x-opencode-claude-code-kind"
export const SESSION_HEADER = "x-opencode-session-id"
export type Kind = "primary" | "title" | "compaction" | "generate"
