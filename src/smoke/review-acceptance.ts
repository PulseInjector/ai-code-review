import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJavaReviewRepository } from "../fixtures/java-review"
import { reviewResultSchema } from "../contracts"
import { runtimeResultSchema } from "../runtime/contracts"
import { z } from "zod"

const root = await mkdtemp(join(tmpdir(), "review-acceptance-"))
const repo = join(root, "repo")
const decoder = new TextDecoder()

function git(args: string[]) {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${decoder.decode(result.stderr).trim()}`)
  return decoder.decode(result.stdout).trim()
}

async function review(name: string, base: string, head: string, options: { allowFailed?: boolean } = {}) {
  const out = join(root, name)
  const started = Date.now()
  const child = Bun.spawnSync(["bun", "run", "review", "--", "--repo", repo, "--base", base, "--head", head, "--out", out], {
    cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe", env: process.env,
    timeout: 305_000, killSignal: "SIGKILL",
  })
  const stdout = decoder.decode(child.stdout).trim()
  const stderr = decoder.decode(child.stderr).trim()
  let raw: unknown
  try { raw = JSON.parse(stdout) } catch { throw new Error(`${name} returned no result JSON: ${stderr || stdout}`) }
  const result = z.object({ runDirectory: z.string(), result: reviewResultSchema }).parse(raw)
  const report = await readFile(join(out, "report.md"), "utf8")
  if (result.result.status === "failed" && !options.allowFailed) {
    throw new Error(`${name} failed: ${result.result.stageErrors[0]?.message ?? stderr}`)
  }
  assert.ok(Date.now() - started < 300_000, "review exceeded its whole-run budget")
  const runtime = runtimeResultSchema.parse(JSON.parse(await readFile(join(out, "runtime/result.json"), "utf8")))
  assert.equal(runtime.status, "complete")
  assert.equal(runtime.cleanup.hostClosed, true)
  assert.equal(runtime.cleanup.forced, false)
  assert.equal(runtime.sessions.length, 2)
  assert.notEqual(runtime.sessions[0]?.sessionID, runtime.sessions[1]?.sessionID)
  const processRecord = z.object({ pid: z.int().positive() }).parse(JSON.parse(await readFile(join(out, "runtime/process.json"), "utf8")))
  assert.throws(() => process.kill(-processRecord.pid, 0), { code: "ESRCH" }, "worker process group must have exited")
  for (const { candidate, verification } of result.result.issues) {
    for (const citation of [candidate.changeLocation, ...candidate.citations, ...verification.evidence]) {
      const lines = (await readFile(join(out, "material", citation.side, citation.path), "utf8")).replace(/\r?\n$/u, "").split(/\r?\n/u)
      assert.equal(lines.slice(citation.startLine - 1, citation.endLine).join("\n").trim(), citation.excerpt.trim())
    }
  }
  for (const file of await readdir(out, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue
    const text = await readFile(join(file.parentPath, file.name), "utf8")
    if (process.env.REVIEW_MODEL_API_KEY) assert.ok(!text.includes(process.env.REVIEW_MODEL_API_KEY), "configured credential must not appear in run artifacts")
  }
  return { code: child.exitCode, out, result: result.result, report, runtime }
}

try {
  const commits = await createJavaReviewRepository(repo)
  const defect = await review("defect", commits.baseSha, commits.defectSha)
  assert.equal(defect.code, 0)
  assert.ok(defect.result.issues.length > 0)
  assert.ok(defect.report.includes("OrderService.java"))

  const guarded = await review("guarded", commits.baseSha, commits.guardedSha)
  assert.equal(guarded.code, 0)
  assert.deepEqual(guarded.result.issues, [])

  git(["switch", "--quiet", "--detach", commits.baseSha])
  const caller = join(repo, "src/example/OrderSummary.java")
  const original = await readFile(caller, "utf8")
  await writeFile(caller, `${original}\n/*${" ".repeat(8 * 1024 * 1024)}*/\n`)
  git(["add", "src/example/OrderSummary.java"])
  git(["-c", "user.name=Review Acceptance", "-c", "user.email=acceptance@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "test oversized supporting caller"])
  const incompleteBase = git(["rev-parse", "HEAD"])
  git(["-c", "user.name=Review Acceptance", "-c", "user.email=acceptance@example.invalid", "-c", "commit.gpgsign=false", "cherry-pick", commits.defectSha])
  const incomplete = await review("incomplete", incompleteBase, git(["rev-parse", "HEAD"]), { allowFailed: true })
  const omittedCaller = "src/example/OrderSummary.java"
  assert.ok(["partial", "failed"].includes(incomplete.result.status))
  assert.ok(incomplete.result.coverage.omittedPaths.includes(omittedCaller))
  assert.ok(incomplete.report.includes(omittedCaller), "report must name the omitted supporting file")
  if (incomplete.result.status === "partial") {
    assert.equal(incomplete.code, 0)
    assert.equal(incomplete.result.stageErrors.length, 0)
    assert.ok(incomplete.report.includes("Status: **partial**"), "report must not present partial coverage as complete")
  } else {
    assert.equal(incomplete.code, 1)
    assert.equal(incomplete.result.issues.length, 0, "failed review must not publish findings")
    assert.ok(incomplete.result.stageErrors.length > 0, "failed review must explain the failure")
    for (const error of incomplete.result.stageErrors) {
      assert.ok(incomplete.report.includes(error.message), "report must include each failure reason")
    }
    assert.ok(incomplete.report.includes("Status: **failed**"), "report must identify the failed review")
    assert.equal(incomplete.runtime.cleanup.hostClosed, true, "failed review worker host must be closed")
    assert.equal(incomplete.runtime.cleanup.forced, false, "failed review worker must not require forced shutdown")
  }

  const summary = {
    defect: { status: defect.result.status, findings: defect.result.issues.length, report: join(defect.out, "report.md") },
    guarded: { status: guarded.result.status, findings: guarded.result.issues.length, report: join(guarded.out, "report.md") },
    incomplete: { status: incomplete.result.status, omittedPaths: incomplete.result.coverage.omittedPaths, report: join(incomplete.out, "report.md") },
  }
  await writeFile(join(root, "acceptance.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  console.log(JSON.stringify(summary, null, 2))
} finally { console.log(`Acceptance artifacts retained at ${root}`) }
