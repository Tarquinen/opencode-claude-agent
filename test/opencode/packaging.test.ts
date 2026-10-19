import { describe, expect } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { it } from "../lib/effect.js"

// Loads the plugin the way a user does: from its folder, through a config file, in the `opencode` on PATH.
// `test/bin/claude` stands in for `claude`. Skipped when there is no `opencode`.
const opencode = Bun.which("opencode")
const REPO = path.join(import.meta.dir, "../..")

describe.skipIf(!opencode)("packaging", () => {
  it.live(
    "opencode loads the plugin from its folder and reads its options",
    () =>
      Effect.gen(function* () {
        const home = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), "claude-agent-packaging-"))),
          (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
        )
        const config = path.join(home, ".config", "opencode")
        const project = path.join(home, "project")
        const log = path.join(home, "claude.log")
        yield* Effect.promise(async () => {
          await mkdir(config, { recursive: true })
          await mkdir(project)
          const plugin = { package: REPO, options: { claudePath: path.join(REPO, "test/bin/claude") } }
          await writeFile(path.join(config, "opencode.json"), JSON.stringify({ plugins: [plugin] }))
        })
        // A fresh home, so the user's own opencode config and data are never touched
        const env = {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_DATA_HOME: path.join(home, ".local", "share"),
          XDG_CACHE_HOME: path.join(home, ".cache"),
          XDG_STATE_HOME: path.join(home, ".local", "state"),
          OPENCODE_CONFIG_DIR: config,
          OPENCODE_CONFIG: undefined,
          OPENCODE_CONFIG_CONTENT: undefined,
          FAKE_CLAUDE_LOG: log,
        }
        const run = (args: string[]) =>
          Effect.promise(async () => {
            const child = Bun.spawn([opencode!, ...args, "--standalone"], { cwd: project, env, stderr: "pipe" })
            const output = await new Response(child.stdout).text()
            const exitCode = await child.exited
            if (exitCode !== 0) throw new Error(`opencode ${args.join(" ")} failed:\n${await new Response(child.stderr).text()}`)
            return output
          })

        yield* run(["auth", "login", "claude-agent", "--method", "claude-login"])
        const models = yield* run(["models"])
        expect(models).toContain("claude-agent/sonnet")
        const reply = yield* run(["run", "--model", "claude-agent/haiku", "Reply with the marker."])
        expect(reply).toContain("COPPER-OTTER")
        // The plugin started our fake from the `claudePath` option, not the `claude` on PATH
        const starts = yield* Effect.promise(() => readFile(log, "utf8"))
        expect(starts).toContain("--tools=")
      }),
    60_000,
  )
})
