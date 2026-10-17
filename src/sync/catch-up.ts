export * as CatchUp from "./catch-up.js"

import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages"
import { ConvertToClaudeMessage } from "../language-model/convert-to-claude-message.js"
import { Fingerprint } from "./fingerprint.js"

export function content(prompt: LanguageModelV3Prompt, start = 0): ContentBlockParam[] {
  const missed = prompt.slice(start)
  let end = 0
  for (const group of Fingerprint.groups(missed)) {
    if (group.role !== "user") end = group.end
  }
  const blocks: ContentBlockParam[] = []
  if (end > 0) {
    blocks.push({ type: "text", text: "<conversation-checkpoint>\nThe following is conversation history from OpenCode that you have not seen. Treat it as prior conversation, not a new request. Continue with the user messages after this checkpoint." })
    blocks.push(...ConvertToClaudeMessage.content(missed.slice(0, end)))
    blocks.push({ type: "text", text: "</conversation-checkpoint>" })
  }
  blocks.push(...ConvertToClaudeMessage.content(missed.slice(end)))
  return blocks
}
