import { describe, expect, test } from "bun:test"
import { createSdkMcpServer, tool, type Options } from "@anthropic-ai/claude-agent-sdk"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { Effect } from "effect"
import { z } from "zod"
import { ClaudeIO } from "../../src/claude/io.js"
import { ClaudeProbe } from "../../src/claude/probe.js"
import { ClaudeQueryOptions } from "../../src/claude/query-options.js"
import { ClaudeSession } from "../../src/claude/session.js"
import { ClaudeSystemPrompt } from "../../src/language-model/system-prompt.js"

// Separate opt-in: compatibility experiments, not part of the usual live regression suite.
const live = !process.env.CI && process.env.CLAUDE_PROMPT_MATRIX === "1"
  && Bun.spawnSync(["claude", "auth", "status"]).exitCode === 0

const runtime = ClaudeSystemPrompt.primary.append
const routing = "Built-in Claude Code tools are disabled. Use only the mcp__opencode__* tools provided for this turn; they execute via OpenCode. Batch independent tool calls into a single turn instead of calling them one at a time."
const catalog = `# Code Mode
Use the \`execute\` tool to call the tools listed below. They cannot be called directly. They only work inside code you pass to \`execute\`.
The catalog is complete. Do not guess tool names.
## Available tools
- project (3 tools)
  - tools.project.read({ path: string }): Promise<string> // Read a project file.
  - tools.project.list({ directory: string }): Promise<string[]> // List project files.
  - tools.project.search({ query: string }): Promise<string[]> // Search project files.
The \`execute\` tool above is mcp__opencode__execute.`
const mcp = `<mcp_instructions>
  <server name="project">
    Use tools from this server through \`execute\` under \`tools["project"]\`.
    Paths are relative to the project directory. Use read to inspect a file before editing it.
  </server>
</mcp_instructions>`
const skills = `Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.
<available_skills>
  <skill><id>review</id><name>Review</name><description>Review code for correctness and maintainability when the user requests a code review.</description></skill>
</available_skills>
The skill tool above is mcp__opencode__skill.`
const role = "# Agent role (from the agent configuration in OpenCode)\nYou are a careful code reviewer. Focus on realistic correctness bugs and explain them concisely."
const agents = `# Project instructions (loaded by OpenCode)
Instructions from: AGENTS.md
Prefer plain language and simple procedural code. Keep changes focused. Run bun test and bun run typecheck after editing code.`

describe.skipIf(!live)("system prompt compatibility", () => {
  test("planned additions with subscription auth, including a real SDK MCP call", async () => {
    const base = ClaudeQueryOptions.base({ executable: ClaudeIO.real.which()!, io: ClaudeIO.real })
    const probe = await Effect.runPromise(ClaudeProbe.run(base))
    expect(ClaudeProbe.isSubscription(probe.account)).toBe(true)
    const directory = await mkdtemp("/tmp/opencode/prompt-matrix-")
    const opencode = readFileSync(new URL("../fixtures/opencode-system.txt", import.meta.url), "utf8")
    const full = [runtime, routing, catalog, mcp, skills, role, agents].join("\n\n")
    const cases: { name: string; system: NonNullable<Options["systemPrompt"]>; tools?: boolean; control?: boolean }[] = []
    function preset(name: string, append: string, tools = false) {
      cases.push({ name, system: { type: "preset", preset: "claude_code", append }, tools })
    }
    preset("baseline", runtime)
    preset("routing", [runtime, routing].join("\n\n"))
    preset("catalog", [runtime, routing, catalog].join("\n\n"))
    preset("phase4", [runtime, routing, catalog, mcp, skills].join("\n\n"))
    preset("phase6", [runtime, role, agents].join("\n\n"))
    preset("combined", full)
    preset("large-project-instructions", full + "\n\n# Project architecture reference\n\n" + readFileSync(new URL("../../PLAN.md", import.meta.url), "utf8"))
    cases.push({ name: "opencode-replacement", system: opencode, control: true })
    cases.push({ name: "opencode-append", system: { type: "preset", preset: "claude_code", append: runtime + "\n\n" + opencode }, control: true })
    cases.push({ name: "short-custom", system: "You are a concise test assistant.", control: true })
    preset("combined-with-tools", full, true)
    preset("combined-repeat", full)

    const failures: string[] = []
    try {
      for (const item of cases) {
        let toolCalls = 0
        const reply = async () => {
          toolCalls++
          return { content: [{ type: "text" as const, text: "COPPER-OTTER" }] }
        }
        // Fixture tools return text only. This checks SDK tool registration and prompt compatibility,
        // not the phase 4 OpenCode bridge, which is not implemented yet.
        const server = item.tools ? createSdkMcpServer({ name: "opencode", tools: [
          tool("read", "Read a fixture file.", { path: z.string() }, reply),
          tool("execute", "Execute a Code Mode query against the fixture project.", { code: z.string() }, reply),
          tool("skill", "Load a fixture skill.", { id: z.string() }, reply),
        ] }) : undefined
        const session = ClaudeSession.start({
          ...base, cwd: directory, model: "haiku", systemPrompt: item.system,
          includePartialMessages: true, persistSession: false, sessionId: crypto.randomUUID(),
          ...(server ? { mcpServers: { opencode: server } } : {}),
        })
        const timer = setTimeout(() => { void session.stop() }, 30_000)
        try {
          await session.ready
          const prompt = item.tools
            ? "Use the read tool to read marker.txt, then reply only with the marker it returns."
            : "Reply only with the marker COPPER-OTTER. Do not use tools."
          const result = await session.send(prompt, () => {})
          const passed = result.subtype === "success" && !result.is_error && result.result.includes("COPPER-OTTER")
            && (!item.tools || toolCalls > 0)
          console.log(JSON.stringify({ name: item.name, version: probe.version, characters: JSON.stringify(item.system).length,
            passed, toolCalls, result: result.subtype === "success" ? result.result : result.errors }))
          if (!passed && !item.control) failures.push(item.name)
        } catch (error) {
          console.log(JSON.stringify({ name: item.name, error: String(error) }))
          if (!item.control) failures.push(item.name)
        } finally {
          clearTimeout(timer)
          await session.stop()
        }
      }
      console.log(`Prompt matrix: ${cases.length} SDK turns; the tool case makes multiple model calls.`)
      expect(failures).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 420_000)
})
