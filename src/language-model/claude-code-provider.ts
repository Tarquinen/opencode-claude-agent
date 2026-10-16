export * as ClaudeCodeProvider from "./claude-code-provider.js"

import { ClaudeCodeLanguageModel } from "./claude-code-language-model.js"

// The AI SDK provider our `sdk` hook hands to opencode
export function createClaudeCode(dependencies: ClaudeCodeLanguageModel.Dependencies) {
  return {
    languageModel: (modelID: string) => new ClaudeCodeLanguageModel.Model(modelID, dependencies),
  }
}
