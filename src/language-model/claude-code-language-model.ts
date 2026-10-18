export * as ClaudeCodeLanguageModel from "./claude-code-language-model.js"

import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamResult } from "@ai-sdk/provider"
import type { ClaudeSessions } from "../claude/sessions.js"
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk"
import { ConvertClaudeStream } from "./convert-claude-stream.js"
import { RequestKind } from "./request-kind.js"
import { ClaudeSystemPrompt } from "./system-prompt.js"

export interface Dependencies {
  readonly run: (request: Parameters<ClaudeSessions.Interface["run"]>[0], signal: AbortSignal) => Promise<void>
}

// The AI SDK model opencode calls for each step. Each call becomes one Claude call (PLAN.md, "What one step looks like").
export class Model implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly provider = "claude-code"
  readonly supportedUrls = {}

  constructor(
    readonly modelId: string,
    readonly dependencies: Dependencies,
  ) {}

  async doGenerate(_options: LanguageModelV3CallOptions): Promise<never> {
    throw new Error("Claude Code models only support streaming")
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const abort = new AbortController()
    const signal = options.abortSignal ? AbortSignal.any([abort.signal, options.abortSignal]) : abort.signal
    const tools = options.toolChoice?.type === "none" ? [] : options.tools?.filter((tool) => tool.type === "function") ?? []
    const convert = ConvertClaudeStream.make(tools)
    const headers = new Headers(options.headers as HeadersInit)
    const kind = headers.get(RequestKind.HEADER)
    const primary = kind === "primary"
    const branch = kind === "generate" || kind === "compaction"
    const role = options.providerOptions?.["claude-code"]?.[ClaudeSystemPrompt.AGENT_OPTION]
    const effort = options.providerOptions?.["claude-code"]?.effort
    if (effort !== undefined && (typeof effort !== "string" || !["low", "medium", "high", "xhigh", "max"].includes(effort))) {
      throw new Error("Claude Code effort must be low, medium, high, xhigh or max")
    }
    let cancelled = false
    let task: Promise<void>
    const stream = new ReadableStream({
      start: (controller) => {
        controller.enqueue({ type: "stream-start", warnings: [] })
        task = this.dependencies.run({
          sessionID: primary ? headers.get(RequestKind.SESSION_HEADER) ?? undefined : undefined,
          sourceID: primary ? headers.get(RequestKind.FORK_HEADER) ?? undefined
            : branch ? headers.get(RequestKind.SESSION_HEADER) ?? undefined : undefined,
          compaction: kind === "compaction",
          model: this.modelId,
          effort: effort as EffortLevel | undefined,
          maxOutputTokens: options.maxOutputTokens,
          // Conversation branches keep the Claude prompt. OpenCode supplies their task as user input.
          // Titles are standalone tasks with their own system instructions.
          system: primary || branch ? ClaudeSystemPrompt.make(options.prompt, primary && tools.length > 0, typeof role === "string" ? role : undefined)
            : ClaudeSystemPrompt.utility(options.prompt),
          prompt: options.prompt,
          tools: primary ? tools : [],
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
