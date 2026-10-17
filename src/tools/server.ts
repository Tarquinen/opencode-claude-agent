export * as ToolServer from "./server.js"

import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider"
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { ToolNames } from "./names.js"
import type { PendingTools } from "./pending.js"

export function make(tools: readonly LanguageModelV3FunctionTool[], pending: PendingTools.Interface): McpSdkServerConfigWithInstance {
  const server = new Server({ name: "opencode", version: "1.0.0" }, { capabilities: { tools: {} } })
  const definitions: Tool[] = []
  for (const tool of tools) definitions.push({
    name: ToolNames.short(tool.name), description: ToolNames.description(tool), inputSchema: tool.inputSchema as Tool["inputSchema"],
    // Claude serializes non-read-only tools, so each handler takes the ID from the preceding hook.
    annotations: { readOnlyHint: false },
    _meta: { "anthropic/alwaysLoad": true, "anthropic/maxResultSizeChars": 500_000 },
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = ToolNames.PREFIX + request.params.name
    ToolNames.original(name, tools)
    return pending.call(name)
  })
  // The SDK accepts the low-level Server at runtime; its public type names the higher-level McpServer.
  return { type: "sdk", name: "opencode", instance: server as unknown as McpSdkServerConfigWithInstance["instance"] }
}
