export * as ClaudeCodeError from "./claude-code-error.js"

import type { SDKAssistantMessageError, SDKMessage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"

// Keep request-local diagnostics until the terminal result. A usage warning alone
// is not a failed request, and Claude Code owns any retries before this result.
export function make() {
  let code: SDKAssistantMessageError | undefined
  let rejected: SDKRateLimitInfo | undefined
  return (message: SDKMessage): Error | undefined => {
    if (message.type === "rate_limit_event") {
      rejected = message.rate_limit_info.status === "rejected" ? message.rate_limit_info : undefined
    }
    if (message.type === "assistant" && message.parent_tool_use_id === null && message.error) code = message.error
    if (message.type !== "result") return
    const status = message.subtype === "success" ? message.api_error_status : undefined
    if (message.subtype === "success" && !message.is_error && !(status && status >= 400)) return
    let text = message.subtype === "success" ? message.result : message.errors.join("\n")
    if (status && status >= 500) {
      text = status === 529 ? "Anthropic is overloaded (529)." : `Anthropic returned HTTP ${status}.`
      text += " Claude Code exhausted its retries. Try again shortly."
    }
    if (code === "rate_limit" || (rejected && status === 429)) {
      const window = rejected?.rateLimitType?.replaceAll("_", " ")
      text ||= `Claude Code subscription limit reached${window ? ` (${window})` : ""}.`
      if (rejected?.resetsAt) text += ` Resets at ${new Date(rejected.resetsAt * 1000).toISOString()}.`
    }
    if (code === "billing_error") text += " Check your Claude plan and extra-usage settings."
    if (code === "authentication_failed") text += " Run `claude auth login` in a terminal."
    return new Error(text || `Claude Code could not finish its reply${status ? ` (HTTP ${status})` : ""}`)
  }
}
