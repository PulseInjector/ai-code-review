import { cp, mkdir, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const fixtureRoot = fileURLToPath(new URL("../../fixtures/java-review/", import.meta.url))
const decoder = new TextDecoder()

export type JavaReviewCommits = {
  baseSha: string
  defectSha: string
  fixSha: string
  guardedSha: string
}

function command(args: string[], cwd?: string): string {
  const result = Bun.spawnSync(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "AI Code Review Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "AI Code Review Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: "2001-01-01T00:00:00+0000",
      GIT_COMMITTER_DATE: "2001-01-01T00:00:00+0000",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  })
  if (result.exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${decoder.decode(result.stderr).trim()}`)
  }
  return decoder.decode(result.stdout).trim()
}

function git(directory: string, ...args: string[]): string {
  return command(["git", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", "-C", directory, ...args])
}

export async function createJavaReviewRepository(directory: string): Promise<JavaReviewCommits> {
  await mkdir(directory, { recursive: true })
  git(directory, "init", "--quiet", "--initial-branch=main")

  const base = join(fixtureRoot, "base")
  for (const entry of await readdir(base)) {
    await cp(join(base, entry), join(directory, entry), { recursive: true })
  }

  git(directory, "add", ".")
  git(directory, "commit", "--quiet", "-m", "base: count missing orders as zero")
  const baseSha = git(directory, "rev-parse", "HEAD")

  git(directory, "apply", join(fixtureRoot, "patches/defect.patch"))
  git(directory, "add", ".")
  git(directory, "commit", "--quiet", "-m", "defect: return null for missing orders")
  const defectSha = git(directory, "rev-parse", "HEAD")

  git(directory, "apply", join(fixtureRoot, "patches/fix.patch"))
  git(directory, "add", ".")
  git(directory, "commit", "--quiet", "-m", "fix: restore empty result")
  const fixSha = git(directory, "rev-parse", "HEAD")

  git(directory, "switch", "--quiet", "-c", "guarded", baseSha)
  git(directory, "apply", join(fixtureRoot, "patches/guarded.patch"))
  git(directory, "add", ".")
  git(directory, "commit", "--quiet", "-m", "guarded: handle nullable result")
  const guardedSha = git(directory, "rev-parse", "HEAD")

  return { baseSha, defectSha, fixSha, guardedSha }
}

export function runJavaReviewAssertions(directory: string, sha: string, classesDirectory: string) {
  git(directory, "switch", "--quiet", "--detach", sha)
  const sources = ["OrderService", "OrderSummary", "ReviewAssertions"].map((name) =>
    join(directory, "src/example", `${name}.java`))
  command(["javac", "-d", classesDirectory, ...sources])
  const result = Bun.spawnSync(["java", "-cp", classesDirectory, "example.ReviewAssertions"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout).trim(),
    stderr: decoder.decode(result.stderr).trim(),
  }
}
