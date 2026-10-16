export * as Recorder from "./recorder.js"

import { spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { createInterface } from "node:readline"
import type { Options } from "@anthropic-ai/claude-agent-sdk"

export const enabled = process.env.RECORD === "1"

const DIRECTORY = path.join(import.meta.dir, "../recordings")

export type Line =
  | { readonly from: "spawn"; readonly args: readonly string[] }
  | { readonly from: "sdk" | "claude"; readonly message: any }

// With RECORD=1, starts the real `claude` and keeps every line in both directions, saved by `save()` to
// test/recordings/<name>.jsonl. Without it, `spawn` is undefined and the SDK starts `claude` itself.
export function make(name: string) {
  const lines: Line[] = []

  const spawnClaude: NonNullable<Options["spawnClaudeCodeProcess"]> = (options) => {
    lines.push({ from: "spawn", args: options.args })
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "inherit"],
    })
    // The SDK reads and writes our own streams, which copy each line on its way between the SDK and `claude`
    const stdin = new PassThrough()
    stdin.pipe(child.stdin)
    createInterface({ input: stdin }).on("line", (line) => lines.push({ from: "sdk", message: JSON.parse(line) }))
    const stdout = new PassThrough()
    child.stdout.pipe(stdout)
    createInterface({ input: child.stdout }).on("line", (line) =>
      lines.push({ from: "claude", message: JSON.parse(line) }),
    )
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
    let text = ""
    for (const line of [header, ...lines]) {
      text += JSON.stringify(line) + "\n"
    }
    // Personal details stay out of the repository
    text = text.replaceAll(homedir(), "/home/user")
    if (startup?.account?.email) text = text.replaceAll(startup.account.email, "user@example.com")
    if (startup?.account?.organization) text = text.replaceAll(startup.account.organization, "Example Org")
    writeFileSync(path.join(DIRECTORY, `${name}.jsonl`), text)
  }

  return { spawn: enabled ? spawnClaude : undefined, save }
}

// What `claude` answered to the SDK's first start-up request
export function startupReply(lines: readonly Line[]): any {
  for (const line of lines) {
    if (line.from === "claude" && line.message.type === "control_response") return line.message.response.response
  }
  return undefined
}

export function load(name: string): Line[] {
  const text = readFileSync(path.join(DIRECTORY, `${name}.jsonl`), "utf8")
  const lines: Line[] = []
  // The first line is the header
  for (const line of text.trim().split("\n").slice(1)) {
    lines.push(JSON.parse(line))
  }
  return lines
}

function sdkVersion(): string {
  const file = path.join(import.meta.dir, "../../node_modules/@anthropic-ai/claude-agent-sdk/package.json")
  return JSON.parse(readFileSync(file, "utf8")).version
}
