export * as ClaudeWebSearch from "./websearch.js"

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { WebSearchOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools"
import os from "node:os"
import { ClaudeAgentError } from "../language-model/claude-agent-error.js"
import type { ClaudeIO } from "./io.js"
import { ClaudeQueryOptions } from "./query-options.js"
import { ClaudeSDK } from "./sdk.js"

// Claude Code's WebSearch runs on Anthropic's servers and returns page contents encrypted, so the search has to go
// through a model, which also writes a summary of the results. The cheapest model is enough for that.
export const DEFAULT_MODEL = "haiku"

const SYSTEM = [
  "You are a web search relay.",
  "Call the WebSearch tool exactly once, with the user's message as the query, verbatim.",
  "Do not answer from memory and do not call any other tool.",
].join(" ")

// opencode's WebSearch.Result
export interface Result {
  readonly url: string
  readonly title?: string
  readonly content?: string
  readonly time: { readonly published?: number }
}

// A one-off run with only WebSearch. Like a side call, it keeps no transcript.
export function options(input: {
  readonly executable: string
  readonly io: ClaudeIO.Interface
  readonly connection?: Readonly<Record<string, string>>
  readonly model: string
}): Options {
  return {
    ...ClaudeQueryOptions.base(input),
    // The search reads no files, so it runs outside the project
    cwd: os.tmpdir(),
    model: input.model,
    systemPrompt: SYSTEM,
    thinking: { type: "disabled" },
    tools: ["WebSearch"],
    allowedTools: ["WebSearch"],
    persistSession: false,
    maxTurns: 2,
  }
}

// Runs one search and stops Claude as soon as the results arrive. The model that asked for the search reads them,
// so Claude's own answer would only cost time and plan usage.
export async function search(input: {
  readonly query: string
  readonly options: Options
  readonly signal?: AbortSignal
}): Promise<Result[]> {
  const { query } = await ClaudeSDK.load()
  const abortController = new AbortController()
  const abort = () => abortController.abort()
  if (input.signal?.aborted) abort()
  input.signal?.addEventListener("abort", abort, { once: true })
  const failure = ClaudeAgentError.make()
  const session = query({ prompt: input.query, options: { ...input.options, abortController } })
  try {
    for await (const message of session) {
      const error = failure(message)
      if (error) throw error
      const found = results(message)
      if (found) return found
    }
  } finally {
    input.signal?.removeEventListener("abort", abort)
    session.close()
  }
  throw new Error(input.signal?.aborted ? "Web search cancelled" : "Claude finished without searching the web")
}

// The search results in a message, or undefined when the message holds none. A failed search throws.
export function results(message: SDKMessage): Result[] | undefined {
  if (message.type !== "user" || message.parent_tool_use_id !== null) return
  const output = message.tool_use_result
  if (!isOutput(output)) {
    const content = message.message.content
    const block = Array.isArray(content) ? content.find((item) => item.type === "tool_result") : undefined
    if (block?.type === "tool_result" && block.is_error) {
      throw new Error(`Claude's web search failed: ${text(block.content).slice(0, 300)}`)
    }
    return
  }
  const links: { url: string; title?: string; snippet?: string; rank: number }[] = []
  const seen = new Map<string, number>()
  const notes: string[] = []
  for (const item of output.results) {
    if (typeof item === "string") {
      if (item.trim()) notes.push(item.trim())
      continue
    }
    for (const link of item.content ?? []) {
      if (typeof link?.url !== "string") continue
      const { key, rank } = variant(link.url)
      const index = seen.get(key)
      // A copy keeps the first copy's place but shows the plainest URL, so a Spanish copy listed first doesn't hide
      // the original page, whose title is often in that language too
      if (index === undefined) seen.set(key, links.push({ ...link, rank }) - 1)
      else if (rank < links[index]!.rank) links[index] = { ...link, rank }
    }
  }
  const found: Result[] = links.map((link) => ({
    url: link.url,
    ...(link.title ? { title: link.title } : {}),
    ...(link.snippet ? { content: link.snippet } : {}),
    time: {},
  }))
  const summary = notes.join("\n\n")
  const first = found[0]
  // opencode lists results without a field for the whole search, so the summary rides on the first one, which says so
  if (summary && first) {
    found[0] = {
      ...first,
      title: `Summary of all results below, written by Claude (top source: ${first.title ?? first.url})`,
      content: first.content ? `${summary}\n\n${first.content}` : summary,
    }
  }
  return found
}

// Claude's search often returns one page many times: translated copies (/de/..., ?hl=fr), account variants
// (?authuser=2), tracking parameters and Markdown mirrors (page.md.txt). They share one key.
const VARIANT_PARAMS = /^(hl|lang|locale|authuser|ref|ref_src|fbclid|gclid|utm_.*)$/i
const LOCALE_FOLDER = /^\/([a-z]{2}(?:[-_][a-z]{2,4})?)(?=\/)/i
// On these sites the first folder is a user or organization, whose name may look like a language code
const NAMESPACED_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org", "codeberg.org", "huggingface.co"])
const languages = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" })

function isLanguage(code: string) {
  try {
    return languages.of(code.replace("_", "-")) !== undefined
  } catch {
    return false
  }
}

// The key shared by every copy of a page, and how plain this copy is: lower is better, so the page itself beats an
// English copy, which beats other languages, mirrors and tracked links
function variant(url: string): { key: string; rank: number } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { key: url, rank: 0 }
  }
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase()
  const all = [...parsed.searchParams]
  const params = all.filter(([name]) => !VARIANT_PARAMS.test(name)).sort()
  const found = NAMESPACED_HOSTS.has(host) ? undefined : LOCALE_FOLDER.exec(parsed.pathname)?.[1]
  const locale = found && isLanguage(found) ? found : undefined
  const stripped = (locale ? parsed.pathname.slice(locale.length + 1) : parsed.pathname).replace(/\/+$/, "")
  const pathname = stripped.replace(/\.md(?:\.txt)?$/i, "")
  const rank =
    (locale ? (/^en(?:[-_]|$)/i.test(locale) ? 1 : 2) : 0) +
    (pathname !== stripped ? 2 : 0) +
    (params.length !== all.length ? 1 : 0)
  return { key: `${host}${pathname}?${new URLSearchParams(params)}`, rank }
}

// Whether two URLs are copies of one page
export function samePage(a: string, b: string) {
  return variant(a).key === variant(b).key
}

function isOutput(value: unknown): value is WebSearchOutput {
  return typeof value === "object" && value !== null && Array.isArray((value as WebSearchOutput).results)
}

function text(content: unknown) {
  return typeof content === "string" ? content : JSON.stringify(content)
}
