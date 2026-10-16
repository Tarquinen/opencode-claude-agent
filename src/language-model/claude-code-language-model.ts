export * as ClaudeCodeLanguageModel from "./claude-code-language-model.js"

import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import type { ClaudeStatus } from "../claude/status.js"

export interface Dependencies {
  readonly status: ClaudeStatus.Interface
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

  async doStream(_options: LanguageModelV3CallOptions): Promise<never> {
    throw new Error("Claude Code chat is not implemented yet")
  }
}
