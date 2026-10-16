export * as SdkPlaceholder from "./sdk-placeholder.js"

// opencode's npm fallback runs before plugin `sdk` hooks and would try to install our package name from npm
// (OPENCODE-FIX.md). Pointing the model package at this file makes it import this file instead, and our `sdk`
// hook then replaces what it returns. Once the opencode fix ships, this file can go.
export const url = import.meta.url

// The fallback calls the first export whose name starts with "create"
export function createPlaceholder() {
  return {
    languageModel: () => {
      throw new Error("The Claude Code plugin did not supply its model. Check that the plugin is loaded.")
    },
  }
}
