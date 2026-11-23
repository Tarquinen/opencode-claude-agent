import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeIO } from "../../src/claude/io.js"
import { ClaudeWebSearch } from "../../src/claude/websearch.js"

// The message Claude Code sends after WebSearch, shaped like a real one: results hold link lists and Claude's notes
const searched = (results: unknown[]) =>
  ({
    type: "user",
    parent_tool_use_id: null,
    session_id: "s",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "Web search results" }] },
    tool_use_result: { query: "q", results, durationSeconds: 1 },
  }) as unknown as SDKMessage

const links = (...urls: string[]) => ({
  tool_use_id: "srvtoolu",
  content: urls.map((url) => ({ title: `title of ${url}`, url })),
})

describe("web search results", () => {
  test("lists each link and puts Claude's summary on the first one", () => {
    const found = ClaudeWebSearch.results(
      searched([links("https://a.example/one", "https://b.example/two"), "  Node.js 26.13.1 is the latest.  ", ""]),
    )
    expect(found).toEqual([
      {
        url: "https://a.example/one",
        title: "Summary of all results below, written by Claude (top source: title of https://a.example/one)",
        content: "Node.js 26.13.1 is the latest.",
        time: {},
      },
      { url: "https://b.example/two", title: "title of https://b.example/two", time: {} },
    ])
  })

  test("joins several notes and keeps links from several searches", () => {
    const found = ClaudeWebSearch.results(
      searched(["first note", links("https://a.example/"), "second note", links("https://b.example/")]),
    )
    expect(found?.map((result) => result.url)).toEqual(["https://a.example/", "https://b.example/"])
    expect(found?.[0]?.content).toBe("first note\n\nsecond note")
  })

  test("returns no results and no summary when the search found nothing", () => {
    expect(ClaudeWebSearch.results(searched(["Nothing found."]))).toEqual([])
  })

  test("lists one copy of a page, in the first copy's place, under its plainest URL", () => {
    const found = ClaudeWebSearch.results(
      searched([
        links(
          "https://nodejs.org/es/blog/release/v26.0.0",
          "https://other.example/x",
          "https://nodejs.org/ko/blog/release/v26.0.0",
          "https://nodejs.org/en/blog/release/v26.0.0",
          "https://nodejs.org/blog/release/v26.0.0",
          "https://nodejs.org/pt-br/blog/release/v26.0.0",
          "https://developer.chrome.com/docs/x?authuser=2",
          "https://developer.chrome.com/docs/x.md.txt",
          "https://developer.chrome.com/docs/x?hl=en",
        ),
      ]),
    )
    expect(found?.map((result) => result.url)).toEqual([
      "https://nodejs.org/blog/release/v26.0.0",
      "https://other.example/x",
      "https://developer.chrome.com/docs/x?authuser=2",
    ])
  })

  test("throws when the search failed", () => {
    const failed = {
      type: "user",
      parent_tool_use_id: null,
      session_id: "s",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t", is_error: true, content: "Web search is unavailable" }],
      },
    } as unknown as SDKMessage
    expect(() => ClaudeWebSearch.results(failed)).toThrow("Claude's web search failed: Web search is unavailable")
  })

  test("ignores messages that hold no search", () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "assistant", parent_tool_use_id: null, session_id: "s", message: { role: "assistant", content: [] } },
      { type: "user", parent_tool_use_id: null, session_id: "s", message: { role: "user", content: "hello" } },
      { ...searched([links("https://a.example/")]), parent_tool_use_id: "subagent" },
    ] as unknown as SDKMessage[]
    for (const message of messages) expect(ClaudeWebSearch.results(message)).toBeUndefined()
  })
})

describe("same page", () => {
  test.each([
    ["https://nodejs.org/en/about/releases/", "https://nodejs.org/about/releases"],
    ["https://nodejs.org/zh-tw/about/releases/", "https://nodejs.org/about/releases"],
    ["https://example.com/pt_BR/x", "https://example.com/x"],
    ["https://www.anthropic.com/news?hl=en-IN", "https://anthropic.com/news"],
    ["https://example.com/a?utm_source=x&b=1&c=2", "https://example.com/a?c=2&b=1"],
    ["https://example.com/docs/page.md", "https://example.com/docs/page"],
  ])("%s is %s", (a, b) => expect(ClaudeWebSearch.samePage(a, b)).toBe(true))

  test.each([
    ["https://www.anthropic.com/news?p=11", "https://anthropic.com/news"],
    // "go" is not a language code, and on GitHub the first folder is an owner
    ["https://example.com/go/x", "https://example.com/x"],
    ["https://github.com/de/x", "https://github.com/x"],
    ["https://github.com/oven-sh/bun", "https://github.com/oven-sh/bun/releases"],
  ])("%s is not %s", (a, b) => expect(ClaudeWebSearch.samePage(a, b)).toBe(false))
})

describe("web search options", () => {
  test("allow only WebSearch, keep no transcript and use the chosen model", () => {
    const options = ClaudeWebSearch.options({ executable: "claude", io: ClaudeIO.real, model: "sonnet" })
    expect(options.tools).toEqual(["WebSearch"])
    expect(options.allowedTools).toEqual(["WebSearch"])
    expect(options.persistSession).toBe(false)
    expect(options.model).toBe("sonnet")
  })
})
