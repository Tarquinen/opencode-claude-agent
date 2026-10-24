export * as ClaudeSDK from "./sdk.js"

import type * as SDK from "@anthropic-ai/claude-agent-sdk"

// Loaded on first use, so opencode starts without loading the SDK.
let sdk: Promise<typeof SDK> | undefined

export function load() {
  sdk ??= import("@anthropic-ai/claude-agent-sdk")
  return sdk
}
