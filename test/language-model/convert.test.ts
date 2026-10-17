import { describe, expect, test } from "bun:test"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ConvertClaudeStream } from "../../src/language-model/convert-claude-stream.js"
import { ConvertToClaudeMessage } from "../../src/language-model/convert-to-claude-message.js"
import { CatchUp } from "../../src/sync/catch-up.js"
import { Recorder } from "../lib/recorder.js"

describe("Claude conversions", () => {
  test("a resumed turn keeps the whole newest user group and its attachments", () => {
    const blocks = CatchUp.content([
      { role: "system", content: "Built-in agent instructions" },
      { role: "user", content: [{ type: "text", text: "Earlier question" }] },
      { role: "assistant", content: [{ type: "text", text: "Earlier reply" }] },
      { role: "user", content: [{ type: "text", text: "A plan-mode reminder" }] },
      { role: "user", content: [{ type: "text", text: "Inspect this image" }, { type: "file", mediaType: "image/png", data: "AQID" }] },
    ], 3)
    expect(blocks).toEqual([
      { type: "text", text: "A plan-mode reminder" },
      { type: "text", text: "Inspect this image" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ])
  })

  test("utility calls preserve task instructions and history roles, but omit thinking", () => {
    const blocks = ConvertToClaudeMessage.utility([
      { role: "system", content: "Summarize this conversation." },
      { role: "system", content: "Use one sentence." },
      { role: "user", content: [{ type: "text", text: "First question" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "Private reasoning" }, { type: "text", text: "First answer" }] },
      { role: "user", content: [{ type: "text", text: "Follow-up" }] },
    ])
    expect(blocks).toEqual([
      { type: "text", text: "<instructions>\nSummarize this conversation.\n\nUse one sentence.\n</instructions>" },
      { type: "text", text: "<user>" }, { type: "text", text: "First question" }, { type: "text", text: "</user>" },
      { type: "text", text: "<assistant>" }, { type: "text", text: "First answer" }, { type: "text", text: "</assistant>" },
      { type: "text", text: "<user>" }, { type: "text", text: "Follow-up" }, { type: "text", text: "</user>" },
    ])
  })

  test("unsupported attachments report their media type instead of silently losing content", () => {
    expect(() => ConvertToClaudeMessage.content([{ role: "user", content: [
      { type: "file", mediaType: "image/svg+xml", data: "PHN2Zy8+" },
    ] }])).toThrow("Claude Code does not support image/svg+xml attachments")
  })

  test("preserves byte/base64/URL image and PDF attachments", () => {
    const bytes = new Uint8Array([1, 2, 3])
    const blocks = ConvertToClaudeMessage.content([{ role: "user", content: [
      { type: "text", text: "/compact @README.md are literal text" },
      { type: "file", mediaType: "image/png", data: bytes },
      { type: "file", mediaType: "application/pdf", data: "cGRm" },
      { type: "file", mediaType: "image/jpeg", data: new URL("https://example.com/photo.jpg") },
    ] }])
    expect(blocks).toEqual([
      { type: "text", text: "/compact @README.md are literal text" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "cGRm" } },
      { type: "image", source: { type: "url", url: "https://example.com/photo.jpg" } },
    ])
  })

  test("usage counts a recorded API call once, though Claude Code reports it several times", () => {
    const parts = convertTurn("text")
    const usage = Recorder.result("text").usage
    const finish = parts.at(-1)
    if (finish?.type !== "finish") throw new Error("Expected a finish part")
    const input = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
    expect(finish.usage.inputTokens).toEqual({
      total: input, noCache: usage.input_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens,
    })
    expect(finish.usage.outputTokens.total).toBe(usage.output_tokens)
  })

  test("recorded thinking becomes reasoning, without empty deltas or the signature", () => {
    const parts = convertTurn("thinking")
    const types: string[] = []
    for (const part of parts) {
      if (part.type !== "text-delta") types.push(part.type)
    }
    expect(types).toEqual(["response-metadata", "reasoning-start", "reasoning-end", "text-start", "text-end", "finish"])
    expect(parts.some((part) => part.type === "text-delta" && part.delta.length > 0)).toBe(true)
    expect(JSON.stringify(parts)).not.toContain("signature")
    const finish = parts.at(-1)
    if (finish?.type !== "finish") throw new Error("Expected a finish part")
    expect(finish.usage.outputTokens.reasoning).toBe(Recorder.result("thinking").usage.output_tokens_details?.thinking_tokens)
  })

  test("emits a real error for a recorded failed turn", () => {
    const parts = convertTurn("text-cancel")
    expect(parts.some((part) => part.type === "text-delta")).toBe(true)
    expect(parts.at(-1)?.type).toBe("error")
    expect(parts.some((part) => part.type === "finish")).toBe(false)
  })
})

// The parts the first recorded turn becomes, up to and including its result
function convertTurn(name: string) {
  const convert = ConvertClaudeStream.make()
  const parts: LanguageModelV3StreamPart[] = []
  for (const line of Recorder.load(name)) {
    if (line.from !== "claude" || line.message.type === "control_response") continue
    parts.push(...convert(line.message as SDKMessage))
    if (line.message.type === "result") break
  }
  return parts
}
