export * as ClaudeCodeLanguageModel from "./claude-code-language-model.js"

import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamResult } from "@ai-sdk/provider"
import type { ClaudeSessions } from "../claude/sessions.js"
import { ConvertClaudeStream } from "./convert-claude-stream.js"
import { ConvertToClaudeMessage } from "./convert-to-claude-message.js"
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
    const convert = ConvertClaudeStream.make()
    const headers = new Headers(options.headers as HeadersInit)
    const primary = headers.get(RequestKind.HEADER) === "primary"
    let cancelled = false
    let task: Promise<void>
    const stream = new ReadableStream({
      start: (controller) => {
        controller.enqueue({ type: "stream-start", warnings: [] })
        task = this.dependencies.run({
          sessionID: primary ? headers.get(RequestKind.SESSION_HEADER) ?? undefined : undefined,
          model: this.modelId,
          system: primary ? ClaudeSystemPrompt.primary : ClaudeSystemPrompt.utility,
          content: (resume) => {
            if (!primary) return ConvertToClaudeMessage.utility(options.prompt)
            if (resume) return ConvertToClaudeMessage.latest(options.prompt)
            return ConvertToClaudeMessage.content(options.prompt)
          },
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
