import assert from "node:assert/strict"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { reviewResultSchema } from "../contracts"
import type { Drive } from "./cli"

const summarySchema = z.object({ runDirectory: z.string(), result: reviewResultSchema })
const manifestSchema = z.object({ status: z.enum(["complete", "partial"]), changes: z.array(z.object({ newPath: z.string().optional(), included: z.boolean(), reason: z.string().optional() })) })
const note = "notes.txt"
const excluded = ".env.example"
const review = [process.execPath, "run", "review", "--"]

export async function verifyReviewCli({ area, drive, scratch, evidence }: {
  area: "cli" | "snapshot"; drive: Drive; scratch: string; evidence: string
}): Promise<void> {
  if (area === "cli") {
    const help = await drive("review-help", [...review, "--help"])
    assert.equal(help.exitCode, 0)
    assert.match(help.stdout, /usage:.*--repo.*--base.*--head.*--out/u)
  }

  const repo = join(scratch, `${area}-repo`)
  const out = join(evidence, area === "cli" ? "unchanged" : "excluded-only")
  await mkdir(repo)
  async function git(step: string, ...args: string[]): Promise<string> {
    const result = await drive(`${area}-git-${step}`, ["git", "-C", repo, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Verification", "-c", "user.email=verify@example.invalid", ...args])
    assert.equal(result.exitCode, 0, `fixture Git step failed: ${step}`)
    return result.stdout.trimEnd()
  }
  await git("init", "init", "--quiet", "--initial-branch=main")
  await writeFile(join(repo, note), "committed text\n")
  await git("add-base", "add", note)
  await git("commit-base", "commit", "--quiet", "-m", "verification base")
  const base = await git("base", "rev-parse", "HEAD")
  if (area === "snapshot") {
    await writeFile(join(repo, excluded), "SYNTHETIC_VALUE=excluded_from_snapshot\n")
    await git("add-head", "add", excluded)
    await git("commit-head", "commit", "--quiet", "-m", "add excluded sample configuration")
  }
  const head = await git("head", "rev-parse", "HEAD")
  await writeFile(join(repo, note), "uncommitted text\n")
  const gitState = async (when: "before" | "after") => ({
    refs: await git(`refs-${when}`, "show-ref", "--head"),
    status: await git(`status-${when}`, "status", "--porcelain"),
  })
  const before = await gitState("before")
  assert.match(before.status, / M notes\.txt/u)

  if (area === "cli") {
    const invalidOut = join(scratch, "invalid")
    const invalid = await drive("review-invalid", [...review, "--repo", repo, "--base", "missing-verification-revision", "--head", head, "--out", invalidOut])
    assert.equal(invalid.exitCode, 1)
    assert.equal(invalid.stdout.trim(), "")
    assert.match(invalid.stderr, /git rev-parse failed/u)
    assert.ok(!(await readdir(scratch)).includes("invalid"), "invalid revision published an output directory")
  }

  let requests = 0
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    requests++
    return new Response("unexpected model request", { status: 400 })
  } })
  try {
    const run = await drive(`review-${area}`, [...review, "--repo", repo, "--base", base, "--head", head, "--out", out], {
      REVIEW_MODEL_PROVIDER_ID: "verify-local", REVIEW_MODEL_BASE_URL: `http://127.0.0.1:${endpoint.port}/v1`,
      REVIEW_MODEL_ID: "no-model-expected", REVIEW_MODEL_API_KEY: "verification-only-not-a-credential",
    })
    assert.equal(run.exitCode, 0, "review CLI failed; inspect its command logs")
    const { runDirectory, result } = summarySchema.parse(JSON.parse(run.stdout))
    assert.equal(runDirectory, out)
    const expected = area === "cli" ? "skipped" : "partial"
    assert.equal(result.status, expected)
    assert.deepEqual(result.snapshot, { baseSha: base, headSha: head, mergeBaseSha: base })
    assert.deepEqual(result.issues, [])
    assert.deepEqual(result.usage, { kind: "known", inputTokens: 0, outputTokens: 0 })
    assert.deepEqual(JSON.parse(await readFile(join(out, "result.json"), "utf8")), result)
    const report = await readFile(join(out, "report.md"), "utf8")
    assert.ok(report.includes(`Status: **${expected}**`))
    if (area === "snapshot") assert.ok(report.includes(excluded))
    assert.deepEqual(JSON.parse(await readFile(join(out, "sessions.json"), "utf8")), [])
    assert.equal(JSON.parse(await readFile(join(out, "cleanup.json"), "utf8")).notStarted, true)
    assert.ok(!(await readdir(out)).includes("runtime"))
    assert.equal(await readFile(join(out, "material", "head", note), "utf8"), "committed text\n")
    assert.equal(await readFile(join(repo, note), "utf8"), "uncommitted text\n")
    assert.deepEqual(await readdir(join(out, "material", "patches")), [])
    const manifest = manifestSchema.parse(JSON.parse(await readFile(join(out, "manifest.json"), "utf8")))
    const omitted = area === "snapshot" ? [excluded] : []
    assert.deepEqual(result.coverage.omittedPaths, omitted)
    assert.deepEqual(manifest.changes, area === "snapshot" ? [{ newPath: excluded, included: false, reason: "excluded-path" }] : [])
    assert.equal(manifest.status, area === "snapshot" ? "partial" : "complete")
    assert.deepEqual(await readdir(join(out, "material", "head")), [note])
    assert.deepEqual(await gitState("after"), before)
    assert.equal(requests, 0)
  } finally {
    await endpoint.stop(true)
    await writeFile(join(evidence, `${area}-model-requests.json`), `${JSON.stringify({ requests })}\n`)
  }
}
