import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJavaReviewRepository, type JavaReviewCommits } from "./fixtures/java-review"
import { runReview } from "./review"
import type { Candidate, Verification } from "./contracts"
import type { Sha256 } from "./identity"
import { emptyReadBudget, type RuntimeResult } from "./runtime/contracts"

let root: string
let repo: string
let commits: JavaReviewCommits
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "review-command-"))
  repo = join(root, "repo")
  commits = await createJavaReviewRepository(repo)
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

const configuration = {
  apiKey: "test-key",
  model: { providerID: "test", baseURL: "https://example.invalid/v1", modelID: "reviewer" },
}
const reference = { side: "head", path: "src/example/OrderService.java", startLine: 11, endLine: 11, excerpt: "      return null;" } satisfies Candidate["changeLocation"]
const candidate: Candidate = {
  id: "C-1", changeLocation: reference, trigger: "Missing customer", consequence: "NullPointerException in caller", rootCause: "Caller iterates a nullable result", citations: [reference],
}
const keep: Verification = { candidateId: "C-1", decision: "keep", reason: "Caller has no guard", evidence: [reference] }

function completed(candidates: Candidate[], verifications: Verification[]): RuntimeResult {
  return {
    status: "complete",
    sessions: [
      { name: "discover", status: "complete", text: JSON.stringify({ candidates }), usage: { kind: "known", inputTokens: 5, outputTokens: 2 }, durationMs: 10 },
      { name: "verify", status: "complete", text: JSON.stringify({ verifications }), usage: { kind: "known", inputTokens: 7, outputTokens: 3 }, durationMs: 12 },
    ],
    usage: { kind: "known", inputTokens: 12, outputTokens: 5 }, readBudget: emptyReadBudget(), cleanup: { hostClosed: true, forced: false },
    checkpointSequence: 1, submission: { kind: "accepted", sessionId: "session", userMessageId: "message", promptDigest: "a".repeat(64) as Sha256 },
    requests: { records: [], capped: false }, phaseDeadlines: null,
  }
}

function input(name: string) {
  return { repo, base: commits.baseSha, head: commits.defectSha, out: join(root, name) }
}

test("writes replayable reports and exact verified evidence from a fixed snapshot", async () => {
  const run = await runReview(input("complete with spaces"), { configuration, runWorker: async (options) => {
    const deadlines = options.phaseDeadlines
    if (deadlines === undefined) throw new Error("the review must pass absolute phase deadlines to the worker")
    expect(deadlines.analysisStopEpochMs).toBeGreaterThan(Date.now())
    expect(deadlines.prepareInitEpochMs).toBeLessThanOrEqual(deadlines.analysisStopEpochMs)
    expect(options.timeoutMs).toBeLessThanOrEqual(300_000)
    return completed([candidate], [keep])
  } })
  expect(run.artifacts.result.status).toBe("complete")
  expect(run.artifacts.result.issues).toHaveLength(1)
  expect(run.artifacts.result.snapshot.headSha).toBe(commits.defectSha)
  expect(run.artifacts.result.usage).toEqual({ kind: "known", inputTokens: 12, outputTokens: 5 })
  const markdown = await readFile(join(run.runDirectory, "report.md"), "utf8")
  expect(markdown).toContain("OrderService.java:11-11")
  expect(markdown).toContain("return null;")
  for (const file of ["manifest.json", "input.json", "configuration.json", "prompts.json", "candidates.json", "verifications.json", "tool-trace.json", "sessions.json", "versions.json", "coverage.json", "cleanup.json"]) {
    const text = await readFile(join(run.runDirectory, file), "utf8")
    expect(text).not.toContain(configuration.apiKey)
    expect(() => JSON.parse(text)).not.toThrow()
  }
  const timing = JSON.parse(await readFile(join(run.runDirectory, "timing.json"), "utf8"))
  expect(timing.phases.map((phase: { durationMs: number }) => phase.durationMs)).toEqual([10, 12])
})

test("verification failure retains candidates, usage and stage without publishing", async () => {
  const run = await runReview(input("missing-verification"), { configuration, runWorker: async () => completed([candidate], []) })
  expect(run.artifacts.result.status).toBe("failed")
  expect(run.artifacts.result.issues).toEqual([])
  expect(run.artifacts.result.stageErrors[0]?.stage).toBe("verification")
  expect(run.artifacts.result.coverage.unverifiedCandidateIds).toEqual(["C-1"])
  expect(run.artifacts.result.usage.kind).toBe("known")
  expect(JSON.parse(await readFile(join(run.runDirectory, "candidates.json"), "utf8"))).toHaveLength(1)
})

test("malformed discovery and out-of-range citations fail in discovery", async () => {
  const malformed = completed([], [])
  const first = malformed.sessions[0]
  if (first?.status !== "complete") throw new Error("invalid test phase")
  first.text = "{invalid JSON"
  const run = await runReview(input("malformed"), { configuration, runWorker: async () => malformed })
  expect(run.artifacts.result.status).toBe("failed")
  expect(run.artifacts.result.stageErrors[0]?.stage).toBe("discovery")
  expect(JSON.parse(await readFile(join(run.runDirectory, "sessions.json"), "utf8"))[0].text).toBe("{invalid JSON")
  const invalid = { ...candidate, changeLocation: { ...reference, startLine: 99, endLine: 99 } }
  const invalidRun = await runReview(input("invalid-citation"), { configuration, runWorker: async () => completed([invalid], [keep]) })
  expect(invalidRun.artifacts.result.status).toBe("failed")
  expect(invalidRun.artifacts.result.stageErrors[0]?.message).toContain("line range")
})

test("interrupted verification preserves known discovery candidates and unknown usage", async () => {
  const runtime = completed([candidate], [])
  runtime.sessions.splice(1)
  const failed: RuntimeResult = { ...runtime, status: "timeout", error: "worker exceeded the run deadline", code: "verification-timeout", usage: { kind: "unknown", reason: "active verification usage was not settled" }, cleanup: { hostClosed: false, forced: true } }
  const run = await runReview(input("timeout"), { configuration, runWorker: async () => failed })
  expect(run.artifacts.result.status).toBe("failed")
  expect(run.artifacts.result.stageErrors[0]?.stage).toBe("verification")
  expect(run.artifacts.result.coverage.unverifiedCandidateIds).toEqual(["C-1"])
  expect(run.artifacts.result.usage.kind).toBe("unknown")
  expect(JSON.parse(await readFile(join(run.runDirectory, "cleanup.json"), "utf8")).forced).toBe(true)
})

test("unknown and pending tool pages mark a review partial", async () => {
  const runtime = completed([candidate], [{ candidateId: "C-1", decision: "unknown", reason: "Caller unavailable", evidence: [] }])
  runtime.readBudget.records.push({ sessionID: "s", callID: "c", tool: "read", path: "head/src/Caller.java", limit: 100,
    status: "completed", returnedBytes: 100, truncated: true, pending: true, nextOffset: 101 })
  const run = await runReview(input("unknown"), { configuration, runWorker: async () => runtime })
  expect(run.artifacts.result.status).toBe("partial")
  expect(run.artifacts.result.issues).toEqual([])
  expect(run.artifacts.result.coverage.unverifiedCandidateIds).toEqual(["C-1"])
  expect(run.artifacts.result.coverage.notes.join(" ")).toContain("next offset 101")
})

test("completed continuation pages do not leave a review partial", async () => {
  const runtime = completed([], [])
  runtime.readBudget.truncated = true
  const run = await runReview(input("resumed-read"), { configuration, runWorker: async () => runtime })
  expect(run.artifacts.result.status).toBe("complete")
})

test("publication cap and exact duplicates preserve all candidate records", async () => {
  const candidates = Array.from({ length: 7 }, (_, index) => ({ ...candidate, id: `C-${index + 1}`, rootCause: `Distinct root cause ${index}` }))
  const verifications = candidates.map(({ id }) => ({ ...keep, candidateId: id }))
  const run = await runReview(input("cap"), { configuration, runWorker: async () => completed(candidates, verifications) })
  expect(run.artifacts.result.status).toBe("partial")
  expect(run.artifacts.result.issues).toHaveLength(5)
  expect(run.artifacts.result.coverage.unpublishedCandidateIds).toEqual(["C-6", "C-7"])
  expect(run.artifacts.result.coverage.unverifiedCandidateIds).toEqual([])
  const duplicate = { ...candidate, id: "C-2" }
  const grouped = await runReview(input("duplicate"), { configuration, runWorker: async () => completed([candidate, duplicate], [keep, { ...keep, candidateId: "C-2" }]) })
  expect(grouped.artifacts.result.issues).toHaveLength(1)
  expect(grouped.discovery?.candidates).toHaveLength(2)
})

test("no changes skip the model and zero included changes report partial coverage", async () => {
  const runWorker = async (): Promise<RuntimeResult> => { throw new Error("model must not start") }
  const skipped = await runReview({ ...input("skipped"), head: commits.baseSha }, { runWorker })
  expect(skipped.artifacts.result.status).toBe("skipped")
  const partial = await runReview(input("no-material"), { runWorker, limits: { maxChangedFiles: 0, maxSnapshotBytes: 8388608, maxPatchBytes: 262144 } })
  expect(partial.artifacts.result.status).toBe("partial")
  expect(partial.artifacts.result.coverage.omittedPaths).toContain("src/example/OrderService.java")
})
