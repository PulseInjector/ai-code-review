import { expect, test } from "bun:test"
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseReviewInput } from "./cli"
import { prepareContext, type ReviewLimits } from "./context"

function git(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}

async function repository(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "review-context-"))
  const repo = join(root, "repo")
  await mkdir(repo)
  git(repo, "init", "--quiet", "--initial-branch=main")
  git(repo, "config", "user.name", "Context Test")
  git(repo, "config", "user.email", "context@example.invalid")
  return { root, repo }
}

function commit(repo: string, message: string): string {
  git(repo, "add", "-A")
  git(repo, "commit", "--quiet", "-m", message)
  return git(repo, "rev-parse", "HEAD")
}

test("prepares fixed Git snapshots with rename, deletion, and excluded inputs", async () => {
  const { root, repo } = await repository()
  try {
    await mkdir(join(repo, "src"))
    await mkdir(join(repo, ".opencode"))
    await writeFile(join(repo, "src/old.txt"), "rename me\n")
    await writeFile(join(repo, "src/deleted.txt"), "removed\n")
    await writeFile(join(repo, "src/Service.java"), "class Service { int n = 0; }\n")
    await writeFile(join(repo, "AGENTS.md"), "untrusted instructions\n")
    await writeFile(join(repo, ".env"), "secret=value\n")
    await writeFile(join(repo, ".opencode/plugin.js"), "side effect\n")
    await writeFile(join(repo, "REVIEW.md"), "Review service behavior.\n")
    const base = commit(repo, "base")
    git(repo, "mv", "src/old.txt", "src/renamed.txt")
    git(repo, "rm", "src/deleted.txt")
    await writeFile(join(repo, "src/Service.java"), "class Service { int n = 1; }\n")
    await writeFile(join(repo, "src/image.bin"), Buffer.from([0, 1, 2, 3]))
    await writeFile(join(root, "outside.txt"), "outside\n")
    await symlink(join(root, "outside.txt"), join(repo, "src/linked.txt"))
    const head = commit(repo, "change")
    const out = join(root, "run")
    const manifest = await prepareContext({ repo, base, head, out })

    expect(manifest.snapshot).toEqual({ baseSha: base, headSha: head, mergeBaseSha: base })
    expect(manifest.status).toBe("partial")
    expect(manifest.changes.some((change) => change.status.startsWith("R") && change.oldPath === "src/old.txt" && change.newPath === "src/renamed.txt" && change.included)).toBe(true)
    expect(manifest.changes.some((change) => change.status === "D" && change.oldPath === "src/deleted.txt" && change.included)).toBe(true)
    expect(manifest.changes.find((change) => change.newPath === "src/image.bin")?.reason).toBe("non-text")
    expect(manifest.changes.find((change) => change.newPath === "src/linked.txt")?.reason).toBe("non-regular")
    expect(await readFile(join(out, "material/merge-base/src/Service.java"), "utf-8")).toContain("n = 0")
    expect(await readFile(join(out, "material/head/src/Service.java"), "utf-8")).toContain("n = 1")
    expect(await readFile(join(out, "material/merge-base/src/deleted.txt"), "utf-8")).toBe("removed\n")
    expect(await readFile(join(out, "material/head/src/renamed.txt"), "utf-8")).toBe("rename me\n")
    expect(manifest.instructions).toEqual({ sourceSha: base, path: "REVIEW.md", text: "Review service behavior.\n" })
    expect((await readdir(join(out, "material/head"))).sort()).toEqual(["src"])
    expect((await readdir(join(out, "material/patches"))).length).toBe(3)
    expect(manifest.files.find((file) => file.path === "AGENTS.md")?.reason).toBe("excluded-path")
    expect(manifest.files.find((file) => file.path === ".env")?.reason).toBe("excluded-path")
    expect(manifest.coverage.omittedPaths).toEqual(["src/image.bin", "src/linked.txt"])

    await writeFile(join(repo, "src/Service.java"), "class Service { int n = 2; }\n")
    commit(repo, "later")
    const fixed = await prepareContext({ repo, base, head, out: join(root, "fixed") })
    expect(fixed.snapshot.headSha).toBe(head)
    expect(await readFile(join(root, "fixed/material/head/src/Service.java"), "utf-8")).toContain("n = 1")

    const command = Bun.spawnSync(["bun", "run", "review", "--", "--repo", repo, "--base", base, "--head", head, "--out", join(root, "cli")], {
      cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, REVIEW_MODEL_API_KEY: "" },
    })
    expect(command.exitCode).toBe(1)
    expect(JSON.parse(new TextDecoder().decode(command.stdout)).result.status).toBe("failed")
    expect(JSON.parse(await readFile(join(root, "cli/manifest.json"), "utf-8")).snapshot.headSha).toBe(head)
    expect(await readFile(join(root, "cli/report.md"), "utf-8")).toContain("failed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("records changed-file, patch, and snapshot limits as partial coverage", async () => {
  const { root, repo } = await repository()
  try {
    await writeFile(join(repo, "a.txt"), "old a\n")
    await writeFile(join(repo, "b.txt"), "old b\n")
    const base = commit(repo, "base")
    await writeFile(join(repo, "a.txt"), "new a\n")
    await writeFile(join(repo, "b.txt"), "new b\n")
    const head = commit(repo, "head")
    const input = { repo, base, head }
    const limits: ReviewLimits = { maxChangedFiles: 1, maxPatchBytes: 262144, maxSnapshotBytes: 8388608 }
    const count = await prepareContext({ ...input, out: join(root, "count") }, limits)
    expect(count.status).toBe("partial")
    expect(count.changes.filter((change) => change.included)).toHaveLength(1)
    expect(count.changes.find((change) => !change.included)?.reason).toBe("changed-file-limit")
    expect(count.coverage.omittedPaths).toHaveLength(1)

    const patch = await prepareContext({ ...input, out: join(root, "patch") }, { ...limits, maxChangedFiles: 2, maxPatchBytes: 1 })
    expect(patch.status).toBe("partial")
    expect(patch.changes.every((change) => change.reason === "patch-limit")).toBe(true)
    expect(await readdir(join(root, "patch/material/patches"))).toEqual([])

    const snapshot = await prepareContext({ ...input, out: join(root, "snapshot") }, { ...limits, maxChangedFiles: 2, maxSnapshotBytes: 1 })
    expect(snapshot.status).toBe("partial")
    expect(snapshot.changes.every((change) => change.reason === "snapshot-limit")).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("oversized supporting files remain visible in partial coverage", async () => {
  const { root, repo } = await repository()
  try {
    await writeFile(join(repo, "changed.txt"), "old\n")
    await writeFile(join(repo, "caller.txt"), "x".repeat(101))
    const base = commit(repo, "base")
    await writeFile(join(repo, "changed.txt"), "new\n")
    const head = commit(repo, "head")
    const manifest = await prepareContext({ repo, base, head, out: join(root, "run") }, {
      maxChangedFiles: 50, maxPatchBytes: 262144, maxSnapshotBytes: 100,
    })
    expect(manifest.changes[0]?.included).toBe(true)
    expect(manifest.status).toBe("partial")
    expect(manifest.coverage.omittedPaths).toEqual(["caller.txt"])
    expect(manifest.files.filter(({ path }) => path === "caller.txt").every(({ reason }) => reason === "snapshot-limit")).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("preparation refuses Git work after the shared deadline", async () => {
  const { root, repo } = await repository()
  try {
    await expect(prepareContext({ repo, base: "HEAD", head: "HEAD", out: join(root, "late") }, undefined, Date.now() - 1))
      .rejects.toThrow("deadline")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("uses the merge base for changes and the selected base for review instructions", async () => {
  const { root, repo } = await repository()
  try {
    await writeFile(join(repo, "REVIEW.md"), "Original guidance.\n")
    await writeFile(join(repo, "feature.txt"), "original\n")
    const ancestor = commit(repo, "ancestor")
    await writeFile(join(repo, "REVIEW.md"), "Base guidance.\n")
    const base = commit(repo, "base guidance")
    git(repo, "switch", "--quiet", "-c", "feature", ancestor)
    await writeFile(join(repo, "feature.txt"), "changed\n")
    const head = commit(repo, "feature")
    const out = join(root, "run")
    const manifest = await prepareContext({ repo, base, head, out })

    expect(manifest.snapshot.mergeBaseSha).toBe(ancestor)
    expect(manifest.snapshot.baseSha).toBe(base)
    expect(manifest.instructions?.text).toBe("Base guidance.\n")
    expect(manifest.changes.map((change) => change.newPath)).toEqual(["feature.txt"])
    expect(await readFile(join(out, "material/merge-base/feature.txt"), "utf-8")).toBe("original\n")
    expect(await readFile(join(out, "material/head/feature.txt"), "utf-8")).toBe("changed\n")
    expect(manifest.status).toBe("complete")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects malformed CLI options and existing output directories", async () => {
  expect(parseReviewInput(["--", "--repo", "r", "--base", "b", "--head", "h", "--out", "o"])).toEqual({ repo: "r", base: "b", head: "h", out: "o" })
  expect(() => parseReviewInput(["--repo", "r", "--repo", "r", "--base", "b", "--head", "h", "--out", "o"])).toThrow()
  expect(() => parseReviewInput(["--repo", "r", "--head", "h", "--out", "o"])).toThrow()
  const { root, repo } = await repository()
  try {
    await writeFile(join(repo, "file.txt"), "content\n")
    const sha = commit(repo, "base")
    await expect(prepareContext({ repo, base: sha, head: sha, out: root })).rejects.toThrow("new directory")
    await symlink(repo, join(root, "repo-link"))
    await expect(prepareContext({ repo, base: sha, head: sha, out: join(root, "repo-link", "run") })).rejects.toThrow("outside the repository")
    await expect(prepareContext({ repo, base: sha, head: sha, out: join(repo, "new-parent", "run") })).rejects.toThrow()
    await expect(access(join(repo, "new-parent"))).rejects.toThrow()
    await expect(prepareContext({ repo, base: "not-a-ref", head: sha, out: join(root, "bad") })).rejects.toThrow("git rev-parse failed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
