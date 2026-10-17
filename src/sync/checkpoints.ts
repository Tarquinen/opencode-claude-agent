export * as Checkpoints from "./checkpoints.js"

import type { LanguageModelV3Prompt, LanguageModelV3TextPart, LanguageModelV3ToolCallPart } from "@ai-sdk/provider"
import { Fingerprint } from "./fingerprint.js"
import type { SessionRecord } from "./record.js"

export function build(input: {
  prompt: LanguageModelV3Prompt
  previous?: SessionRecord.Record
  userID?: string
  reply: Array<LanguageModelV3TextPart | LanguageModelV3ToolCallPart>
  messageID?: string
  toolMessages: Map<string, string>
}) {
  const history: SessionRecord.Checkpoint[] = []
  const groups = Fingerprint.groups(input.prompt)
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!
    const previous = input.previous?.history?.[i]
    let claudeMessageID = previous?.hash === group.hash ? previous.claudeMessageID : undefined
    if (group.role === "tool") {
      for (const message of input.prompt.slice(group.start, group.end)) {
        if (message.role !== "tool") continue
        for (const part of message.content) {
          if (part.type === "tool-result" && input.toolMessages.has(part.toolCallId)) claudeMessageID = input.toolMessages.get(part.toolCallId)
        }
      }
    }
    if (i === groups.length - 1 && input.userID) claudeMessageID = input.userID
    history.push({ hash: group.hash, claudeMessageID })
  }
  if (input.reply.length > 0) history.push({
    hash: Fingerprint.groups([{ role: "assistant", content: input.reply }])[0]!.hash,
    claudeMessageID: input.messageID,
  })
  return history
}
