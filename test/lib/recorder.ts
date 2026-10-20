export * as Recorder from "./recorder.js"

import { spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { createInterface } from "node:readline"
import type { Options, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"

export const enabled = process.env.RECORD === "1"

const DIRECTORY = path.join(import.meta.dir, "../recordings")

export type Line =
  | { readonly from: "spawn"; readonly process?: number; readonly args: readonly string[] }
  | { readonly from: "sdk"; readonly process?: number; readonly message: any }
  | { readonly from: "claude"; readonly process?: number; readonly message: any }

// With RECORD=1, starts the real `claude` and captures traffic without thinking, saved by `save()` to
// test/recordings/<name>.jsonl. Without it, `spawn` is undefined and the SDK starts `claude` itself.
export function make(name: string, capture = false) {
  const lines: Line[] = []
  const sessionIDs = new Set<string>()
  let nextProcess = 0

  const spawnClaude: NonNullable<Options["spawnClaudeCodeProcess"]> = (options) => {
    const process = nextProcess++
    lines.push({ from: "spawn", process, args: options.args })
    for (const arg of options.args)
      if (arg.startsWith("--session-id=") || arg.startsWith("--resume=")) sessionIDs.add(arg.split("=")[1]!)
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "inherit"],
    })
    function record(from: "sdk" | "claude", line: string) {
      const message = parse(line)
      if (message !== undefined) lines.push({ from, process, message })
    }
    // Forward the original streams; only the captured copy is filtered.
    const stdin = new PassThrough()
    stdin.pipe(child.stdin)
    createInterface({ input: stdin }).on("line", (line) => record("sdk", line))
    const stdout = new PassThrough()
    child.stdout.pipe(stdout)
    createInterface({ input: child.stdout }).on("line", (line) => record("claude", line))
    return Object.assign(child, { stdin, stdout })
  }

  function save() {
    if (!enabled || lines.length === 0) return
    const startup = startupReply(lines)
    const header = {
      claudeCode: startup?.claude_code_version,
      sdk: sdkVersion(),
      date: new Date().toISOString().slice(0, 10),
    }
    const text = [header, ...lines].map((line) => JSON.stringify(line) + "\n").join("")
    // Personal details stay out of the repository
    const home = text.replaceAll(homedir(), "/home/user")
    const email = startup?.account?.email ? home.replaceAll(startup.account.email, "user@example.com") : home
    const organization = startup?.account?.organization
      ? email.replaceAll(startup.account.organization, "Example Org")
      : email
    writeFileSync(path.join(DIRECTORY, `${name}.jsonl`), organization)
  }

  return { spawn: enabled || capture ? spawnClaude : undefined, save, sessionIDs, lines: lines as readonly Line[] }
}

// Never retain thinking, including signed or redacted blocks and echoed input history.
export function parse(line: string) {
  return JSON.parse(line, (_key, value) => {
    if (!value || typeof value !== "object") return value
    if (Array.isArray(value)) return value.filter((item) => item !== undefined)
    if (
      value.type === "thinking" ||
      value.type === "thinking_delta" ||
      value.type === "redacted_thinking" ||
      value.type === "signature_delta"
    )
      return undefined
    if (
      value.type === "reasoning" ||
      value.type === "reasoning-start" ||
      value.type === "reasoning-delta" ||
      value.type === "reasoning-end"
    )
      return undefined
    if (value.type === "content_block_start" && value.content_block === undefined) return undefined
    if (value.type === "content_block_delta" && value.delta === undefined) return undefined
    if (value.type === "stream_event" && value.event === undefined) return undefined
    return value
  })
}

// What `claude` answered to the SDK's first start-up request
export function startupReply(lines: readonly Line[]) {
  const line = lines.find((line) => line.from === "claude" && line.message.type === "control_response")
  return line?.from === "claude" ? line.message.response.response : undefined
}

export function load(name: string): Line[] {
  const text = readFileSync(path.join(DIRECTORY, `${name}.jsonl`), "utf8")
  // The first line is the header
  return text
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line))
}

// An independent usage oracle for tests: the CLI's result, rather than our stream converter.
export function result(name: string, index = 0): SDKResultMessage {
  const line = load(name).filter((line) => line.from === "claude" && line.message.type === "result")[index]
  if (line?.from === "claude") return line.message
  throw new Error(`No result ${index} in ${name}`)
}

function sdkVersion(): string {
  const file = path.join(import.meta.dir, "../../node_modules/@anthropic-ai/claude-agent-sdk/package.json")
  return JSON.parse(readFileSync(file, "utf8")).version
}
