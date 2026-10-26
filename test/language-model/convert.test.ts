import { describe, expect, test } from "bun:test"
import { ConvertToClaudeMessage } from "../../src/language-model/convert-to-claude-message.js"
import { ClaudeSystemPrompt } from "../../src/language-model/system-prompt.js"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"

describe("Claude conversions", () => {
  test("utility calls keep system instructions separate from conversation content and omit thinking", () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "Summarize this conversation." },
      { role: "system", content: "Use one sentence." },
      { role: "user", content: [{ type: "text", text: "First question" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Private reasoning" },
          { type: "text", text: "First answer" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Follow-up" }] },
    ]
    expect(ClaudeSystemPrompt.utility(prompt)).toBe("Summarize this conversation.\n\nUse one sentence.")
    expect(ConvertToClaudeMessage.content(prompt)).toEqual([
      { type: "text", text: "<user>" },
      { type: "text", text: "First question" },
      { type: "text", text: "</user>" },
      { type: "text", text: "<assistant>" },
      { type: "text", text: "First answer" },
      { type: "text", text: "</assistant>" },
      { type: "text", text: "<user>" },
      { type: "text", text: "Follow-up" },
      { type: "text", text: "</user>" },
    ])
  })

  test("preserves byte/base64/URL image and PDF attachments", () => {
    const bytes = new Uint8Array([1, 2, 3])
    const blocks = ConvertToClaudeMessage.content([
      {
        role: "user",
        content: [
          { type: "text", text: "/compact @README.md are literal text" },
          { type: "file", mediaType: "image/png", data: bytes },
          { type: "file", mediaType: "application/pdf", data: "cGRm" },
          { type: "file", mediaType: "image/jpeg", data: new URL("https://example.com/photo.jpg") },
        ],
      },
    ])
    expect(blocks).toEqual([
      { type: "text", text: "/compact @README.md are literal text" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "cGRm" } },
      { type: "image", source: { type: "url", url: "https://example.com/photo.jpg" } },
    ])
  })
})
