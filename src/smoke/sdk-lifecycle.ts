import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const runDirectory = await mkdtemp(join(tmpdir(), "ai-code-review-opencode-"))

try {
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "sdk-host.ts"), runDirectory], {
    cwd: runDirectory,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: runDirectory,
      XDG_CONFIG_HOME: join(runDirectory, "config"),
      XDG_CACHE_HOME: join(runDirectory, "cache"),
      XDG_DATA_HOME: join(runDirectory, "data"),
      XDG_STATE_HOME: join(runDirectory, "state"),
      TMPDIR: join(runDirectory, "tmp"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  if (child.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(child.stderr).trim() || "SDK host failed")
  }

  console.log(JSON.stringify({ smoke: "sdk-lifecycle", status: "passed" }))
} finally {
  await rm(runDirectory, { recursive: true, force: true })
}
