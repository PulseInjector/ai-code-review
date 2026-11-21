import { expect, test } from "bun:test"
import { reviewResultSchema, type Candidate, type CodeReference, type KeptVerification } from "./contracts"
import {
  executionSchema, failureCodeSchema, failureSchema, identitySchema, jobResultSchema,
  phaseCheckpointSchema, prOutcomeSchema, prReviewResultSchema, reduceTerminalReview,
  type Execution, type Failure, type PhaseCheckpoint, type PrReviewResult, type ReviewReduction,
} from "./pr-contracts"

const sha = "a".repeat(40)
const instant = "2026-11-21T10:00:00.000Z"
const runId = "12345678901234567890"
const actionsRunId = `gh-${runId}-1000000`
const reference: CodeReference = { side: "head", path: "src/example/OrderService.java", startLine: 9, endLine: 9, excerpt: "return null;" }
const candidate: Candidate = {
  id: "C-1",
  changeLocation: reference,
  trigger: "No orders exist for the customer",
  consequence: "The caller throws instead of returning zero",
  rootCause: "A nullable result is iterated without a guard",
  citations: [reference],
}
const verification: KeptVerification = { candidateId: "C-1", decision: "keep", reason: "The caller has no guard", evidence: [reference] }
const keepIssue = { candidate, verification }

const actionsExecutionFixture = {
  kind: "actions",
  reviewRunId: actionsRunId,
  workflowRunId: runId,
  attempt: 1_000_000,
  trigger: { kind: "pull-request", action: "opened" },
  triggeredAt: instant,
  startedAt: instant,
  runUrl: `https://github.com/PulseInjector/java-review/actions/runs/${runId}`,
}
const localExecutionFixture = {
  kind: "local",
  reviewRunId: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f",
  trigger: { kind: "local" },
  triggeredAt: instant,
  startedAt: instant,
}

const execution: Execution = executionSchema.parse(actionsExecutionFixture)
const noneCheckpoint: PhaseCheckpoint = phaseCheckpointSchema.parse({ kind: "none" })
const discoveredCheckpoint: PhaseCheckpoint = phaseCheckpointSchema.parse({ kind: "discovered", output: { candidates: [candidate] } })
const verifiedCheckpoint: PhaseCheckpoint = phaseCheckpointSchema.parse({
  kind: "verified",
  discovery: { candidates: [candidate] },
  verification: { verifications: [verification] },
})
const emptyVerifiedCheckpoint: PhaseCheckpoint = phaseCheckpointSchema.parse({
  kind: "verified",
  discovery: { candidates: [] },
  verification: { verifications: [] },
})
const unknownDecisionCheckpoint: PhaseCheckpoint = phaseCheckpointSchema.parse({
  kind: "verified",
  discovery: { candidates: [candidate] },
  verification: { verifications: [{ candidateId: "C-1", decision: "unknown", reason: "inconclusive", evidence: [reference] }] },
})
const rejectedCheckpoint: PhaseCheckpoint = phaseCheckpointSchema.parse({
  kind: "verified",
  discovery: { candidates: [candidate] },
  verification: { verifications: [{ candidateId: "C-1", decision: "reject", reason: "not a defect", evidence: [reference] }] },
})

const sixCandidates: Candidate[] = Array.from({ length: 6 }, (_, index) => ({
  ...candidate,
  id: `C-${index + 1}`,
  trigger: `Trigger variant ${index + 1}`,
  rootCause: `Root cause variant ${index + 1}`,
}))
const sixKeepVerifications: KeptVerification[] = sixCandidates.map((kept, index) => ({
  candidateId: kept.id,
  decision: "keep",
  reason: `Keep reason ${index + 1}`,
  evidence: [reference],
}))
const sixKeepsCheckpoint: PhaseCheckpoint = phaseCheckpointSchema.parse({
  kind: "verified",
  discovery: { candidates: sixCandidates },
  verification: { verifications: sixKeepVerifications },
})
const publishedPairs = sixCandidates.map((kept, index) => ({ candidate: kept, verification: sixKeepVerifications[index] }))

const completeResult: PrReviewResult = {
  runId: actionsRunId,
  snapshot: { baseSha: sha, headSha: sha, mergeBaseSha: sha },
  status: "complete",
  issues: [],
  coverage: { includedPaths: [reference.path], omittedPaths: [], unverifiedCandidateIds: [], unpublishedCandidateIds: [], notes: [] },
  stageErrors: [],
  usage: { kind: "known", inputTokens: 10, outputTokens: 20 },
  versions: { program: "b".repeat(64), sdk: "2.2.7", config: "c".repeat(64), discoverPrompt: "d".repeat(64), verifyPrompt: "e".repeat(64) },
  durationMs: 25,
}
const interruptedResult: PrReviewResult = {
  ...completeResult,
  status: "partial",
  coverage: { ...completeResult.coverage, unverifiedCandidateIds: ["C-1"] },
}
const allOmittedResult: PrReviewResult = {
  ...completeResult,
  status: "partial",
  coverage: { includedPaths: [], omittedPaths: ["src/Large.java"], unverifiedCandidateIds: [], unpublishedCandidateIds: [], notes: ["src/Large.java: exceeded the snapshot byte limit."] },
}
const keptResult: PrReviewResult = { ...completeResult, issues: [keepIssue] }
const keptPartial: PrReviewResult = { ...keptResult, status: "partial" }
const fivePublishedResult: PrReviewResult = {
  ...completeResult,
  status: "partial",
  issues: publishedPairs.slice(0, 5),
  coverage: { ...completeResult.coverage, unpublishedCandidateIds: ["C-6"] },
}

const duplicateCandidate: Candidate = {
  ...candidate,
  id: "C-2",
  rootCause: "  a NULLABLE   result is ITERATED without a guard  ",
}
const duplicatedCheckpoint: PhaseCheckpoint = phaseCheckpointSchema.parse({
  kind: "verified",
  discovery: { candidates: [candidate, duplicateCandidate] },
  verification: { verifications: [verification, { candidateId: "C-2", decision: "keep", reason: "The duplicate is real", evidence: [reference] }] },
})

const expectReviewed = (reduction: ReviewReduction, status: "complete" | "partial") => {
  if (reduction.kind !== "reduced" || reduction.review.kind !== "reviewed") {
    throw new Error(`expected a reviewed reduction, received ${JSON.stringify(reduction)}`)
  }
  expect(reduction.review.status).toBe(status)
  expect(reduction.review.result.status).toBe(status)
}
const expectReviewedPartial = (reduction: ReviewReduction) => {
  if (reduction.kind !== "reduced" || reduction.review.kind !== "reviewed" || reduction.review.status !== "partial") {
    throw new Error(`expected a reviewed partial reduction, received ${JSON.stringify(reduction)}`)
  }
  return reduction.review
}
const expectFailed = (reduction: ReviewReduction) => {
  if (reduction.kind !== "reduced" || reduction.review.kind !== "failed") {
    throw new Error(`expected a failed reduction, received ${JSON.stringify(reduction)}`)
  }
}
const expectRejected = (reduction: ReviewReduction, code: Failure["code"], pattern: RegExp) => {
  if (reduction.kind !== "rejected") {
    throw new Error(`expected a rejected reduction, received ${JSON.stringify(reduction)}`)
  }
  expect(reduction.failure.code).toBe(code)
  expect(reduction.failure.message).toMatch(pattern)
}

const recoverableCodes: ReadonlySet<Failure["code"]> = new Set([
  "retry-exhausted", "acceptance-unknown", "discovery-timeout", "verification-timeout",
  "run-interrupted", "read-budget", "request-budget", "cleanup-failed",
])

test("identitySchema is strict and bounds its fields", () => {
  expect(Number(identitySchema.parse({ repositoryId: "123456789", repository: "PulseInjector/java-review", pr: 17 }).pr)).toBe(17)
  expect(() => identitySchema.parse({ repositoryId: "123456789", repository: "PulseInjector/java-review", pr: 17, extra: true })).toThrow()
  expect(() => identitySchema.parse({ repositoryId: "0", repository: "PulseInjector/java-review", pr: 17 })).toThrow()
})

test("an Actions execution binds reviewRunId to its workflow run and attempt", () => {
  expect(executionSchema.parse(actionsExecutionFixture).reviewRunId).toBe(actionsRunId)
  expect(executionSchema.parse({ ...actionsExecutionFixture, trigger: { kind: "manual" } }).kind).toBe("actions")
  expect(() => executionSchema.parse({ ...actionsExecutionFixture, reviewRunId: `gh-${"9".repeat(20)}-1000000` })).toThrow(/reviewRunId/)
  expect(() => executionSchema.parse({ ...actionsExecutionFixture, reviewRunId: `run-${runId}-1000000` })).toThrow()
  expect(() => executionSchema.parse({ ...actionsExecutionFixture, attempt: 1_000_001 })).toThrow()
})

test("trigger kinds stay isolated between local and Actions executions", () => {
  expect(() => executionSchema.parse({ ...actionsExecutionFixture, trigger: { kind: "local" } })).toThrow(/local trigger/)
  expect(() => executionSchema.parse({ ...localExecutionFixture, trigger: { kind: "pull-request", action: "opened" } })).toThrow()
  expect(() => executionSchema.parse({ ...localExecutionFixture, trigger: { kind: "manual" } })).toThrow()
  expect(executionSchema.parse(localExecutionFixture).kind).toBe("local")
  expect(() => executionSchema.parse({ ...localExecutionFixture, reviewRunId: "not-a-uuid" })).toThrow()
})

test("the failure code enum is closed and the failure record is bounded", () => {
  expect(failureCodeSchema.options).toHaveLength(38)
  expect(failureSchema.parse({ code: "input-invalid", stage: "input", message: "x".repeat(2_000) }).message).toHaveLength(2_000)
  expect(() => failureSchema.parse({ code: "input-invalid", stage: "input", message: "x".repeat(2_001) })).toThrow()
  expect(() => failureSchema.parse({ code: "input-invalid", stage: "report", message: "x" })).toThrow()
  expect(() => failureSchema.parse({ code: "model-crashed", stage: "input", message: "x" })).toThrow()
})

test("reviewed outcomes reject unusable result statuses and impossible field combinations", () => {
  expect(prOutcomeSchema.parse({ kind: "reviewed", result: completeResult }).kind).toBe("reviewed")
  expect(() => prOutcomeSchema.parse({
    kind: "reviewed",
    result: { ...completeResult, status: "failed", issues: [] },
  })).toThrow()
  expect(() => prOutcomeSchema.parse({
    kind: "skipped", reason: "draft", snapshot: null, result: completeResult,
  })).toThrow()
  expect(() => prOutcomeSchema.parse({ kind: "failed", snapshot: null })).toThrow()
  expect(() => prOutcomeSchema.parse({ kind: "failed", failure: { code: "model-auth", stage: "discovery", message: "x" }, snapshot: null, result: completeResult })).toThrow()
  expect(() => prOutcomeSchema.parse({
    kind: "reviewed",
    result: { ...completeResult, coverage: { ...completeResult.coverage, omittedPaths: [reference.path] } },
  })).toThrow()
})

test("jobResultSchema accepts exactly the four Actions job results", () => {
  expect(jobResultSchema.options).toEqual(["success", "failure", "cancelled", "skipped"])
  expect(() => jobResultSchema.parse("started")).toThrow()
})

test("a verified checkpoint requires verification of every discovered candidate and no others", () => {
  expect(() => phaseCheckpointSchema.parse({
    kind: "verified",
    discovery: { candidates: [candidate] },
    verification: { verifications: [] },
  })).toThrow()
  expect(() => phaseCheckpointSchema.parse({
    kind: "verified",
    discovery: { candidates: [] },
    verification: { verifications: [verification] },
  })).toThrow()
  expect(() => phaseCheckpointSchema.parse({ kind: "discovered", output: { candidates: Array.from({ length: 9 }, (_, i) => ({ ...candidate, id: `C-${i}` })) } })).toThrow()
})

test("the PR result boundary bounds coverage while the legacy local schema stays unbounded", () => {
  expect(() => prReviewResultSchema.parse({ ...completeResult, extra: true })).toThrow()
  const paths = (count: number) => Array.from({ length: count }, (_, index) => `src/File${index}.java`)
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `C-${index}`)
  const oversizedIncluded: PrReviewResult = {
    ...completeResult,
    coverage: { includedPaths: paths(2_001), omittedPaths: [], unverifiedCandidateIds: [], unpublishedCandidateIds: [], notes: [] },
  }
  expect(reviewResultSchema.parse(oversizedIncluded).coverage.includedPaths).toHaveLength(2_001)
  expect(() => prReviewResultSchema.parse(oversizedIncluded)).toThrow()

  const oversizedOmitted: PrReviewResult = {
    ...completeResult,
    status: "partial",
    coverage: { includedPaths: [reference.path], omittedPaths: paths(2_001).map((path) => `${path}: too large`), unverifiedCandidateIds: [], unpublishedCandidateIds: [], notes: [] },
  }
  expect(reviewResultSchema.parse(oversizedOmitted).status).toBe("partial")
  expect(() => prReviewResultSchema.parse(oversizedOmitted)).toThrow()

  const oversizedUnverified: PrReviewResult = {
    ...interruptedResult,
    coverage: { ...interruptedResult.coverage, unverifiedCandidateIds: ids(9) },
  }
  expect(reviewResultSchema.parse(oversizedUnverified).coverage.unverifiedCandidateIds).toHaveLength(9)
  expect(() => prReviewResultSchema.parse(oversizedUnverified)).toThrow()
  expect(() => prReviewResultSchema.parse({ ...interruptedResult, coverage: { ...interruptedResult.coverage, unpublishedCandidateIds: ids(9) } })).toThrow()

  const oversizedNotes: PrReviewResult = {
    ...interruptedResult,
    coverage: { ...interruptedResult.coverage, notes: Array.from({ length: 129 }, () => "an extra note") },
  }
  expect(reviewResultSchema.parse(oversizedNotes).coverage.notes).toHaveLength(129)
  expect(() => prReviewResultSchema.parse(oversizedNotes)).toThrow()
  expect(prReviewResultSchema.parse({
    ...interruptedResult,
    coverage: { ...interruptedResult.coverage, notes: Array.from({ length: 128 }, () => "a note") },
  }).coverage.notes).toHaveLength(128)

  expectRejected(reduceTerminalReview({ execution, checkpoint: verifiedCheckpoint, result: oversizedIncluded, pendingToolPages: 0 }), "input-invalid", /bounded PR review-result/)
})

test("the PR result boundary closes stage-error codes and widens stages beyond the legacy five", () => {
  const openCode = { ...interruptedResult, stageErrors: [{ stage: "verification", code: "review-failed", message: "an open legacy code" }] }
  expect(reviewResultSchema.parse(openCode).stageErrors[0]?.code).toBe("review-failed")
  expect(() => prReviewResultSchema.parse(openCode)).toThrow()

  const typed = { ...interruptedResult, stageErrors: [{ stage: "verification", code: "read-budget", message: "the read budget stopped the run" }] }
  expect(prReviewResultSchema.parse(typed).stageErrors[0]?.code).toBe("read-budget")

  // A stage legal in only the legacy enum is still rejected at the PR boundary.
  const legacyStage = { ...interruptedResult, stageErrors: [{ stage: "report", code: "read-budget", message: "x" }] }
  expect(reviewResultSchema.parse(legacyStage).stageErrors[0]?.stage).toBe("report")
  expect(() => prReviewResultSchema.parse(legacyStage)).toThrow()

  // A recoverable stop after verification rides the accepted partial as a typed stage error.
  const cleanupStage = { ...interruptedResult, stageErrors: [{ stage: "cleanup", code: "cleanup-failed", message: "cleanup did not finish" }] }
  expect(() => reviewResultSchema.parse(cleanupStage)).toThrow()
  expect(prReviewResultSchema.parse(cleanupStage).stageErrors[0]?.code).toBe("cleanup-failed")
  const handoffStage = { ...interruptedResult, stageErrors: [{ stage: "handoff", code: "artifact-write", message: "x" }] }
  expect(prReviewResultSchema.parse(handoffStage).stageErrors[0]?.stage).toBe("handoff")
})

test("a verified checkpoint derives the status from exact checkpoint accounting", () => {
  expectReviewed(reduceTerminalReview({ execution, checkpoint: emptyVerifiedCheckpoint, result: completeResult, pendingToolPages: 0 }), "complete")
  expectReviewed(reduceTerminalReview({ execution, checkpoint: unknownDecisionCheckpoint, result: interruptedResult, pendingToolPages: 0 }), "partial")
})

test("a verified checkpoint rejects a result whose status contradicts its facts", () => {
  expectRejected(reduceTerminalReview({
    execution, checkpoint: verifiedCheckpoint, result: keptPartial, pendingToolPages: 0,
  }), "input-invalid", /does not match the derived status complete/)
})

test("a verified checkpoint publishes exactly its keep pairs as a complete review", () => {
  expectReviewed(reduceTerminalReview({ execution, checkpoint: verifiedCheckpoint, result: keptResult, pendingToolPages: 0 }), "complete")
})

test("a verified checkpoint rejects issues outside the accepted keeps", () => {
  expectRejected(reduceTerminalReview({
    execution, checkpoint: rejectedCheckpoint, result: keptPartial, pendingToolPages: 0,
  }), "candidate-set-invalid", /no accepted keep/)
})

test("a verified checkpoint rejects a result that reports an unknown decision as verified", () => {
  expectRejected(reduceTerminalReview({
    execution, checkpoint: unknownDecisionCheckpoint, result: keptResult, pendingToolPages: 0,
  }), "candidate-set-invalid", /no accepted keep/)
})

test("a verified checkpoint rejects a mutated issue pair that cites a real keep", () => {
  const mutatedResult: PrReviewResult = {
    ...keptResult,
    issues: [{ ...keepIssue, candidate: { ...keepIssue.candidate, trigger: "A fabricated trigger" } }],
  }
  expectRejected(reduceTerminalReview({ execution, checkpoint: verifiedCheckpoint, result: mutatedResult, pendingToolPages: 0 }), "candidate-set-invalid", /does not carry the checkpoint/)
})

test("a result that publishes one keep twice is rejected", () => {
  expectRejected(reduceTerminalReview({
    execution, checkpoint: verifiedCheckpoint, result: { ...keptResult, issues: [keepIssue, keepIssue] }, pendingToolPages: 0,
  }), "candidate-set-invalid", /published more than once/)
})

test("a verified checkpoint publishes its first five keep pairs and reports the sixth as unpublished", () => {
  expectReviewed(reduceTerminalReview({ execution, checkpoint: sixKeepsCheckpoint, result: fivePublishedResult, pendingToolPages: 0 }), "partial")
})

test("a partial that omits an unpublished keep is rejected", () => {
  expectRejected(reduceTerminalReview({
    execution, checkpoint: sixKeepsCheckpoint,
    result: { ...fivePublishedResult, coverage: { ...fivePublishedResult.coverage, unpublishedCandidateIds: [] } },
    pendingToolPages: 0,
  }), "candidate-set-invalid", /beyond the publication cap/)
})

test("a result that swaps a published pair for a keep beyond the cap is rejected", () => {
  const wrongSelection: PrReviewResult = {
    ...fivePublishedResult,
    issues: [publishedPairs[0], publishedPairs[1], publishedPairs[2], publishedPairs[3], publishedPairs[5]],
  }
  expectRejected(reduceTerminalReview({
    execution, checkpoint: sixKeepsCheckpoint, result: wrongSelection, pendingToolPages: 0,
  }), "candidate-set-invalid", /exactly the checkpoint's published keep pairs/)
})

test("coverage must name every candidate without an accepted keep as unverified", () => {
  const rejectedPartial: PrReviewResult = {
    ...completeResult,
    status: "partial",
    coverage: { ...completeResult.coverage, unverifiedCandidateIds: ["C-1"] },
  }
  expectReviewed(reduceTerminalReview({ execution, checkpoint: rejectedCheckpoint, result: rejectedPartial, pendingToolPages: 0 }), "partial")
  expectRejected(reduceTerminalReview({
    execution, checkpoint: rejectedCheckpoint,
    result: { ...rejectedPartial, coverage: { ...rejectedPartial.coverage, unverifiedCandidateIds: [] } },
    pendingToolPages: 0,
  }), "candidate-set-invalid", /candidates without an accepted keep/)
})

test("an accepted keep that duplicates an earlier keep's location and root cause is not republished", () => {
  expectReviewed(reduceTerminalReview({ execution, checkpoint: duplicatedCheckpoint, result: keptResult, pendingToolPages: 0 }), "complete")
})

test("pending tool pages force partial and cannot be relabeled away in coverage notes", () => {
  const relabeled: PrReviewResult = {
    ...keptResult,
    coverage: { ...keptResult.coverage, notes: ["The remaining tool pages were relabeled as a note for the next run."] },
  }
  expectReviewed(reduceTerminalReview({ execution, checkpoint: verifiedCheckpoint, result: { ...relabeled, status: "partial" }, pendingToolPages: 2 }), "partial")
  expectRejected(reduceTerminalReview({
    execution, checkpoint: verifiedCheckpoint, result: relabeled, pendingToolPages: 2,
  }), "input-invalid", /does not match the derived status partial/)
  expectRejected(reduceTerminalReview({
    execution, checkpoint: verifiedCheckpoint, result: keptResult, pendingToolPages: -1,
  }), "input-invalid", /pendingToolPages/)
})

test("the all-omitted case is legal only as a zero-issue partial naming its omissions", () => {
  expectReviewed(reduceTerminalReview({ execution, checkpoint: noneCheckpoint, result: allOmittedResult, pendingToolPages: 0 }), "partial")
  expectRejected(reduceTerminalReview({
    execution, checkpoint: noneCheckpoint, result: { ...allOmittedResult, issues: [keepIssue] }, pendingToolPages: 0,
  }), "candidate-set-invalid", /cannot carry issues/)
  expectRejected(reduceTerminalReview({
    execution, checkpoint: noneCheckpoint,
    result: { ...allOmittedResult, coverage: { ...allOmittedResult.coverage, omittedPaths: [], notes: [] } },
    pendingToolPages: 0,
  }), "input-invalid", /name its omissions/)
  expectRejected(reduceTerminalReview({
    execution, checkpoint: noneCheckpoint, result: completeResult, pendingToolPages: 0,
  }), "input-invalid", /legal only for a partial/)
})

test("an interrupted verification after a valid discovery checkpoint yields a usable partial", () => {
  const failure: Failure = { code: "run-interrupted", stage: "verification", message: "verification session interrupted" }
  expectReviewed(reduceTerminalReview({ execution, checkpoint: discoveredCheckpoint, result: interruptedResult, failure, pendingToolPages: 0 }), "partial")
})

test("a discovered checkpoint with an interrupted verification rejects a result that carries issues", () => {
  const failure: Failure = { code: "verification-timeout", stage: "verification", message: "verification timed out" }
  expectRejected(reduceTerminalReview({
    execution, checkpoint: discoveredCheckpoint, result: { ...interruptedResult, issues: [keepIssue] }, failure, pendingToolPages: 0,
  }), "candidate-set-invalid", /zero current findings/)
})

test("a partial from a discovered checkpoint names exactly the discovered candidates unverified", () => {
  const failure: Failure = { code: "run-interrupted", stage: "verification", message: "stopped" }
  expectRejected(reduceTerminalReview({
    execution, checkpoint: discoveredCheckpoint,
    result: { ...interruptedResult, coverage: { ...interruptedResult.coverage, unverifiedCandidateIds: [] } }, failure, pendingToolPages: 0,
  }), "candidate-set-invalid", /exactly the discovered/)
  expectRejected(reduceTerminalReview({
    execution, checkpoint: discoveredCheckpoint,
    result: { ...interruptedResult, coverage: { ...interruptedResult.coverage, unverifiedCandidateIds: ["C-2"] } }, failure, pendingToolPages: 0,
  }), "candidate-set-invalid", /exactly the discovered/)
})

test("a recoverable failure after a verified checkpoint forces partial and retains the keep issues", () => {
  const failure: Failure = { code: "cleanup-failed", stage: "cleanup", message: "cleanup did not finish" }
  expectReviewed(reduceTerminalReview({ execution, checkpoint: verifiedCheckpoint, result: keptPartial, failure, pendingToolPages: 0 }), "partial")
  expectRejected(reduceTerminalReview({ execution, checkpoint: verifiedCheckpoint, result: keptResult, failure, pendingToolPages: 0 }), "input-invalid", /forces partial/)
})

test("a recoverable failure is recorded as a typed stage error on the accepted partial", () => {
  const failure: Failure = { code: "request-budget", stage: "discovery", message: "the request ledger reached its cap" }
  const reviewed = expectReviewedPartial(reduceTerminalReview({ execution, checkpoint: verifiedCheckpoint, result: keptPartial, failure, pendingToolPages: 0 }))
  expect(reviewed.result.stageErrors).toContainEqual({ code: "request-budget", stage: "discovery", message: "the request ledger reached its cap" })
})

test("a cleanup failure after verified work is recorded on the accepted partial", () => {
  const failure: Failure = { code: "cleanup-failed", stage: "cleanup", message: "cleanup did not finish" }
  const reviewed = expectReviewedPartial(reduceTerminalReview({ execution, checkpoint: verifiedCheckpoint, result: keptPartial, failure, pendingToolPages: 0 }))
  expect(reviewed.result.stageErrors).toContainEqual({ code: "cleanup-failed", stage: "cleanup", message: "cleanup did not finish" })
})

test("an already recorded stop reason is not recorded twice", () => {
  const failure: Failure = { code: "cleanup-failed", stage: "cleanup", message: "cleanup did not finish" }
  const recorded: PrReviewResult = {
    ...keptPartial,
    stageErrors: [{ stage: "cleanup", code: "cleanup-failed", message: "cleanup did not finish" }],
  }
  const reviewed = expectReviewedPartial(reduceTerminalReview({ execution, checkpoint: verifiedCheckpoint, result: recorded, failure, pendingToolPages: 0 }))
  expect(reviewed.result.stageErrors).toHaveLength(1)
})

test("a recoverable failure whose message cannot form a typed stage error is rejected", () => {
  const failure: Failure = { code: "run-interrupted", stage: "verification", message: " " }
  expectRejected(reduceTerminalReview({
    execution, checkpoint: verifiedCheckpoint, result: keptPartial, failure, pendingToolPages: 0,
  }), "input-invalid", /recordable as a typed stage error/)
})

test("every recoverable failure code yields partial from a checkpoint and failed without one", () => {
  for (const code of recoverableCodes) {
    const failure: Failure = { code, stage: "verification", message: "stopped" }
    expectReviewed(reduceTerminalReview({ execution, checkpoint: discoveredCheckpoint, result: interruptedResult, failure, pendingToolPages: 0 }), "partial")
    expectReviewed(reduceTerminalReview({ execution, checkpoint: verifiedCheckpoint, result: keptPartial, failure, pendingToolPages: 0 }), "partial")
    expectFailed(reduceTerminalReview({ execution, checkpoint: noneCheckpoint, failure, pendingToolPages: 0 }))
  }
})

test("every other failure code fails the run even after a verified checkpoint with a complete result", () => {
  const failingCodes = failureCodeSchema.options.filter((code) => !recoverableCodes.has(code))
  expect(failingCodes).toHaveLength(30)
  for (const code of failingCodes) {
    const failure: Failure = { code, stage: "discovery", message: "stopped" }
    expectFailed(reduceTerminalReview({ execution, checkpoint: verifiedCheckpoint, result: keptResult, failure, pendingToolPages: 0 }))
    expectFailed(reduceTerminalReview({ execution, checkpoint: noneCheckpoint, result: keptResult, failure, pendingToolPages: 0 }))
  }
})

test("a review bound to another run identity is rejected", () => {
  expectRejected(reduceTerminalReview({
    execution,
    checkpoint: verifiedCheckpoint,
    result: { ...keptResult, runId: "gh-99999999999999999999-1000000" },
    pendingToolPages: 0,
  }), "identity-mismatch", /does not equal execution reviewRunId/)
})

test("a run identity rejection satisfies the failure schema even for a forged run ID", () => {
  const forged: PrReviewResult = { ...keptResult, runId: "x".repeat(4_000) }
  const reduction = reduceTerminalReview({ execution, checkpoint: verifiedCheckpoint, result: forged, pendingToolPages: 0 })
  expectRejected(reduction, "identity-mismatch", /does not equal execution reviewRunId/)
  if (reduction.kind !== "rejected") throw new Error(`expected a rejected reduction, received ${JSON.stringify(reduction)}`)
  expect(reduction.failure.message.length).toBeLessThanOrEqual(2_000)
  expect(failureSchema.safeParse(reduction.failure).success).toBe(true)
})

test("an assembled result with a legacy failed or skipped status never enters the reviewed branches", () => {
  expectRejected(reduceTerminalReview({
    execution, checkpoint: verifiedCheckpoint, result: { ...keptResult, status: "skipped", issues: [] }, pendingToolPages: 0,
  }), "input-invalid", /legacy status skipped/)
  expectRejected(reduceTerminalReview({
    execution, checkpoint: verifiedCheckpoint, result: { ...keptResult, status: "failed", issues: [] }, pendingToolPages: 0,
  }), "input-invalid", /legacy status failed/)
})

test("a discovered checkpoint without a failure has no terminal state", () => {
  expectRejected(reduceTerminalReview({ execution, checkpoint: discoveredCheckpoint, result: completeResult, pendingToolPages: 0 }), "input-invalid", /no terminal state/)
})

test("reviewed outcomes require an assembled result", () => {
  expectRejected(reduceTerminalReview({ execution, checkpoint: verifiedCheckpoint, pendingToolPages: 0 }), "input-invalid", /assembled review result/)
  expectRejected(reduceTerminalReview({
    execution, checkpoint: discoveredCheckpoint, pendingToolPages: 0,
    failure: { code: "run-interrupted", stage: "verification", message: "stopped" },
  }), "input-invalid", /assembled review result/)
})
