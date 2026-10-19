export * as ClaudeAgentError from "./claude-agent-error.js"

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

    let text: string
    let status: number | undefined
    if (message.subtype === "success") {
      status = message.api_error_status ?? undefined
      const httpError = status !== undefined && status >= 400
      if (!message.is_error && !httpError) return
      text = message.result
    } else {
      text = message.errors.join("\n")
    }

    if (status !== undefined && status >= 500) {
      if (status === 529) text = "Anthropic is overloaded (529)."
      else text = `Anthropic returned HTTP ${status}.`
      text += " Claude Code exhausted its retries. Try again shortly."
    }
    if (code === "rate_limit" || (rejected && status === 429)) {
      if (!text) {
        text = "Claude Code subscription limit reached"
        const window = rejected?.rateLimitType?.replaceAll("_", " ")
        if (window) text += ` (${window})`
        text += "."
      }
      if (rejected?.resetsAt) text += ` Resets at ${new Date(rejected.resetsAt * 1000).toISOString()}.`
    }
    if (code === "billing_error") text += " Check your Claude plan and extra-usage settings."
    if (code === "authentication_failed") text += " Run `claude auth login` in a terminal."

    if (text) return new Error(text)
    if (status) return new Error(`Claude Code could not finish its reply (HTTP ${status})`)
    return new Error("Claude Code could not finish its reply")
  }
}
