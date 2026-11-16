import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

for (const name of ["REVIEW_MODEL_PROVIDER_ID", "REVIEW_MODEL_BASE_URL", "REVIEW_MODEL_ID", "REVIEW_MODEL_API_KEY"]) {
  if (!process.env[name]) throw new Error(`missing ${name} in .env.local`)
}

const runDirectory = await mkdtemp(join(tmpdir(), "ai-code-review-model-"))

try {
  await mkdir(join(runDirectory, "tmp"))
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "sdk-model-host.ts"), runDirectory], {
    cwd: runDirectory,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: runDirectory,
      XDG_CONFIG_HOME: join(runDirectory, "config"),
      XDG_CACHE_HOME: join(runDirectory, "cache"),
      XDG_DATA_HOME: join(runDirectory, "data"),
      XDG_STATE_HOME: join(runDirectory, "state"),
      TMPDIR: join(runDirectory, "tmp"),
      REVIEW_MODEL_PROVIDER_ID: process.env.REVIEW_MODEL_PROVIDER_ID!,
      REVIEW_MODEL_BASE_URL: process.env.REVIEW_MODEL_BASE_URL!,
      REVIEW_MODEL_ID: process.env.REVIEW_MODEL_ID!,
      REVIEW_MODEL_API_KEY: process.env.REVIEW_MODEL_API_KEY!,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  if (child.exitCode !== 0) {
    throw new Error(`SDK model smoke failed with exit code ${child.exitCode}`)
  }
  process.stdout.write(child.stdout)
} finally {
  await rm(runDirectory, { recursive: true, force: true })
}
