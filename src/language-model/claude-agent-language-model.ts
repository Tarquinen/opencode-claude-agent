export * as ClaudeAgentLanguageModel from "./claude-agent-language-model.js"

import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3FunctionTool, LanguageModelV3StreamResult } from "@ai-sdk/provider"
import type { ClaudeSessions } from "../claude/sessions.js"
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk"
import { ConvertClaudeStream } from "./convert-claude-stream.js"
import { RequestKind } from "./request-kind.js"
import { ClaudeSystemPrompt } from "./system-prompt.js"

export interface Dependencies {
  readonly run: (request: Parameters<ClaudeSessions.Interface["run"]>[0], signal: AbortSignal) => Promise<void>
}

export class Model implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly provider = "claude-agent"
  readonly supportedUrls = {}

  constructor(
    readonly modelId: string,
    readonly dependencies: Dependencies,
  ) {}

  async doGenerate(_options: LanguageModelV3CallOptions): Promise<never> {
    throw new Error("Claude Agent models only support streaming")
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const abort = new AbortController()
    const signal = options.abortSignal ? AbortSignal.any([abort.signal, options.abortSignal]) : abort.signal
    const tools: LanguageModelV3FunctionTool[] = []
    if (options.toolChoice?.type !== "none") {
      for (const tool of options.tools ?? []) {
        if (tool.type === "function") tools.push(tool)
      }
    }
    const convert = ConvertClaudeStream.make(tools)
    const headers = new Headers(options.headers as HeadersInit)
    const kind = headers.get(RequestKind.HEADER)
    const session = headers.get(RequestKind.SESSION_HEADER) ?? undefined
    const settings = options.providerOptions?.["claude-agent"]
    const role = settings?.[ClaudeSystemPrompt.AGENT_OPTION]
    const agent = typeof role === "string" ? role : undefined
    const effort = parseEffort(settings?.effort)
    let sessionID: string | undefined
    let sourceID: string | undefined
    let offered: LanguageModelV3FunctionTool[] = []
    let system: string | ReturnType<typeof ClaudeSystemPrompt.make>
    if (kind === "primary") {
      sessionID = session
      sourceID = headers.get(RequestKind.FORK_HEADER) ?? undefined
      offered = tools
      system = ClaudeSystemPrompt.make(options.prompt, tools.length > 0, agent)
    } else if (kind === "generate" || kind === "compaction") {
      // Conversation branches copy their source session and keep the Claude prompt. OpenCode supplies their task as user input.
      sourceID = session
      system = ClaudeSystemPrompt.make(options.prompt, false, agent)
    } else {
      // Titles are standalone tasks, so OpenCode's system prompt replaces Claude Code's.
      system = ClaudeSystemPrompt.utility(options.prompt)
    }
    let cancelled = false
    let task: Promise<void>
    const stream = new ReadableStream({
      start: (controller) => {
        controller.enqueue({ type: "stream-start", warnings: [] })
        task = this.dependencies.run({
          sessionID,
          sourceID,
          compaction: kind === "compaction",
          model: this.modelId,
          effort,
          maxOutputTokens: options.maxOutputTokens,
          system,
          prompt: options.prompt,
          tools: offered,
          emit: (message) => {
            if (cancelled) return
            for (const part of convert(message)) controller.enqueue(part)
          },
        }, signal).then(
          () => { if (!cancelled) controller.close() },
          (error) => { if (!cancelled) controller.error(error) },
        )
      },
      cancel: () => {
        cancelled = true
        abort.abort()
        return task
      },
    })
    return { stream }
  }
}

const EFFORTS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"]

function parseEffort(value: unknown): EffortLevel | undefined {
  if (value === undefined) return undefined
  for (const effort of EFFORTS) {
    if (value === effort) return effort
  }
  throw new Error("Claude Agent effort must be low, medium, high, xhigh or max")
}
