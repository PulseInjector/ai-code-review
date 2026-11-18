import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJavaReviewRepository, runJavaReviewAssertions, type JavaReviewCommits } from "./java-review"

let directory: string
let commits: JavaReviewCommits

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ai-code-review-cases-"))
  commits = await createJavaReviewRepository(join(directory, "repo"))
})

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("case commits remain fixed and labels stay outside the source repository", async () => {
  const expected = await readFile(new URL("../../fixtures/java-review/commits.json", import.meta.url), "utf8")
  expect(commits).toEqual(JSON.parse(expected))
  const tracked = Bun.spawnSync(["git", "-C", join(directory, "repo"), "ls-tree", "-r", "--name-only", commits.defectSha], {
    stdout: "pipe",
  })
  expect(tracked.exitCode).toBe(0)
  expect(new TextDecoder().decode(tracked.stdout)).not.toContain("labels")
  expect(new TextDecoder().decode(tracked.stdout)).not.toContain("evals")
})

test("defect and fix are consecutive; guarded branches from base", () => {
  for (const [sha, parent] of [
    [commits.defectSha, commits.baseSha],
    [commits.fixSha, commits.defectSha],
    [commits.guardedSha, commits.baseSha],
  ]) {
    const result = Bun.spawnSync(["git", "-C", join(directory, "repo"), "rev-list", "--parents", "-n", "1", sha], {
      stdout: "pipe",
    })
    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout).trim()).toBe(`${sha} ${parent}`)
  }
})

for (const [name, outcome] of [["base", "passes"], ["defect", "fails"], ["fix", "passes"], ["guarded", "passes"]] as const) {
  test(`${name} Java assertions ${outcome}`, () => {
    const sha = commits[`${name}Sha`]
    const result = runJavaReviewAssertions(join(directory, "repo"), sha, join(directory, `classes-${name}`))
    if (outcome === "passes") {
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("java-review-ok")
    } else {
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("NullPointerException")
    }
  })
}
