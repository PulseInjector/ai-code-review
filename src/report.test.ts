import { expect, test } from "bun:test"
import { createRunArtifacts, renderMarkdown } from "./report"
import { candidateSchema, verificationSchema, type Candidate, type Verification } from "./contracts"
import type { ContextManifest } from "./context"
import { localExecutionSchema, phaseCheckpointSchema, prReviewResultSchema, reduceTerminalReview } from "./pr-contracts"
import { emptyRequestLedger, runtimeResultSchema } from "./runtime/contracts"

const sha = "a".repeat(40)
const context: ContextManifest = {
  snapshot: { baseSha: sha, headSha: "b".repeat(40), mergeBaseSha: sha },
  status: "complete",
  limits: { maxChangedFiles: 50, maxPatchBytes: 262144, maxSnapshotBytes: 8388608 },
  files: [],
  changes: [{ status: "M", newPath: "src/A.java", included: true }],
  coverage: { includedPaths: ["src/A.java"], omittedPaths: [] },
}

const common = {
  context,
  runId: "run-1",
  durationMs: 150,
  programVersion: "0.1.0",
  sdkVersion: "2.2.7",
  configHash: "a".repeat(64),
}

test("renders a complete zero-finding review with explicit snapshot and coverage", () => {
  const artifacts = createRunArtifacts(common)
  expect(artifacts.result.status).toBe("complete")
  expect(artifacts.markdown).toContain(`base \`${sha}\``)
  expect(artifacts.markdown).toContain("No verified findings.")
  expect(artifacts.markdown).toContain("Included paths: 1.")
})

test("marks omitted material partial and model errors failed without publishing issues", () => {
  const partial = createRunArtifacts({ ...common, context: { ...context, status: "partial", coverage: { includedPaths: [], omittedPaths: ["src/A.java"] } } })
  expect(partial.result.status).toBe("partial")
  expect(partial.markdown).toContain("src/A.java")

  const failed = createRunArtifacts({ ...common, error: { stage: "discovery", message: "model unavailable" } })
  expect(failed.result.status).toBe("failed")
  expect(failed.result.stageErrors[0]?.stage).toBe("discovery")
  expect(renderMarkdown(failed.result)).toContain("model unavailable")
})

test("local assembly names rejected candidates as unverified and the PR reducer accepts them", () => {
  const candidate: Candidate = candidateSchema.parse({
    id: "C-1",
    changeLocation: { side: "head", path: "src/A.java", startLine: 1, endLine: 1, excerpt: "class A {}" },
    trigger: "A rejected candidate",
    consequence: "No verified defect",
    rootCause: "The behavior is guarded",
    citations: [{ side: "head", path: "src/A.java", startLine: 1, endLine: 1, excerpt: "class A {}" }],
  })
  const verification: Verification = verificationSchema.parse({
    candidateId: candidate.id,
    decision: "reject",
    reason: "The caller handles the result",
    evidence: [{ side: "head", path: "src/A.java", startLine: 1, endLine: 1, excerpt: "class A {}" }],
  })
  const runId = "11111111-1111-4111-8111-111111111111"
  const artifacts = createRunArtifacts({
    ...common,
    runId,
    discovery: {
      candidates: [candidate], verifications: [verification], issues: [], unknownCandidateIds: [], unreportedCandidateIds: [],
      versions: { discoverPrompt: "b".repeat(64), verifyPrompt: "c".repeat(64) },
      runtime: runtimeResultSchema.parse({
        status: "complete", sessions: [], usage: { kind: "known", inputTokens: 0, outputTokens: 0 },
        readBudget: { consumedBytes: 0, truncated: false, exhausted: false, records: [] },
        cleanup: { hostClosed: true, forced: false }, checkpointSequence: 1, submission: { kind: "not-submitted" },
        requests: emptyRequestLedger(), phaseDeadlines: null,
      }),
    },
  })
  expect(artifacts.result.status).toBe("partial")
  expect(artifacts.result.coverage.unverifiedCandidateIds).toEqual([candidate.id])
  const result = prReviewResultSchema.parse(artifacts.result)
  const execution = localExecutionSchema.parse({
    kind: "local", reviewRunId: runId, trigger: { kind: "local" },
    triggeredAt: "2026-11-21T10:00:00.000Z", startedAt: "2026-11-21T10:00:00.000Z",
  })
  const reduced = reduceTerminalReview({
    execution,
    checkpoint: phaseCheckpointSchema.parse({ kind: "verified", discovery: { candidates: [candidate] }, verification: { verifications: [verification] } }),
    result,
    pendingToolPages: 0,
  })
  expect(reduced.kind).toBe("reduced")
  if (reduced.kind !== "reduced") throw new Error("the valid rejected-candidate result was rejected")
  expect(reduced.review).toMatchObject({ kind: "reviewed", status: "partial" })
})
