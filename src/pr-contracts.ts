import { z } from "zod"
import {
  completeResultCoversAllWork, deriveReviewStatus, discoveryOutputSchema, deriveKeepPublication, identifierSchema,
  relativePathSchema, reviewResultObjectSchema, snapshotSchema, terminalResultPublishesNoIssues,
  textSchema, verificationOutputSchema, type DiscoveryOutput, type PublishedIssue,
} from "./contracts"
import { attemptSchema, instantSchema, prNumberSchema, repositoryIdSchema, repositoryNameSchema, runIdSchema } from "./identity"

export const identitySchema = z.strictObject({
  repositoryId: repositoryIdSchema,
  repository: repositoryNameSchema,
  pr: prNumberSchema,
})

export const triggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pull-request"), action: z.enum(["opened", "synchronize", "reopened", "ready_for_review", "edited"]) }),
  z.strictObject({ kind: z.literal("manual") }),
  z.strictObject({ kind: z.literal("local") }),
])

export const actionsExecutionSchema = z.strictObject({
  kind: z.literal("actions"),
  reviewRunId: z.string().regex(/^gh-[1-9][0-9]{0,19}-[1-9][0-9]{0,6}$/),
  workflowRunId: runIdSchema,
  attempt: attemptSchema,
  trigger: triggerSchema,
  triggeredAt: instantSchema,
  startedAt: instantSchema,
  runUrl: z.url(),
})
  .refine((execution) => execution.reviewRunId === `gh-${execution.workflowRunId}-${execution.attempt}`, {
    message: "reviewRunId must equal gh-<workflowRunId>-<attempt>",
  })
  .refine((execution) => execution.trigger.kind !== "local", {
    message: "an Actions execution cannot carry a local trigger",
  })

export const localExecutionSchema = z.strictObject({
  kind: z.literal("local"),
  reviewRunId: z.uuid(),
  trigger: z.strictObject({ kind: z.literal("local") }),
  triggeredAt: instantSchema,
  startedAt: instantSchema,
})

export const executionSchema = z.discriminatedUnion("kind", [actionsExecutionSchema, localExecutionSchema])

export const skipReasonSchema = z.enum(["draft", "closed", "fork", "no-changes"])

export const failureCodeSchema = z.enum([
  "input-invalid", "github-auth", "github-forbidden", "github-not-found", "github-rate-limit", "github-unavailable",
  "snapshot-fetch", "config-invalid", "isolation-rejected", "prepare-timeout", "runtime-init", "model-auth", "model-config",
  "model-refusal", "model-format", "citation-invalid", "candidate-set-invalid", "retry-exhausted", "acceptance-unknown",
  "discovery-timeout", "verification-timeout", "run-interrupted", "read-budget", "request-budget", "cleanup-failed", "artifact-write",
  "artifact-missing", "artifact-invalid", "identity-mismatch", "attempt-mismatch", "artifact-provenance",
  "comment-state-invalid", "comment-list-limit", "comment-write", "comment-write-unknown", "postcheck-unavailable",
  "writer-context-required", "writer-attempt-inactive",
])

export const failureSchema = z.strictObject({
  code: failureCodeSchema,
  stage: z.enum(["input", "capture", "preparation", "initialization", "discovery", "verification", "cleanup", "handoff", "publish"]),
  message: z.string().min(1).max(2_000),
})

export const typedStageErrorSchema = z.strictObject({
  code: failureCodeSchema,
  stage: z.enum(["input", "capture", "preparation", "initialization", "discovery", "verification", "cleanup", "handoff", "publish"]),
  message: z.string().trim().min(1).max(2_000),
})

// The PR boundary narrows coverage to bounded arrays and closes stage errors to the typed codes.
// Stage errors widen beyond the legacy five stages, because a recoverable stop such as a cleanup
// failure happens after verification and must ride the accepted partial. The base object carries
// the shared refinements, and the local schema itself stays unbounded and open.
const prBoundedCoverageSchema = z.strictObject({
  includedPaths: z.array(relativePathSchema).max(2_000),
  omittedPaths: z.array(z.string().min(1)).max(2_000),
  unverifiedCandidateIds: z.array(identifierSchema).max(8),
  unpublishedCandidateIds: z.array(identifierSchema).max(8).default([]),
  notes: z.array(textSchema).max(128),
})
export const prReviewResultSchema = reviewResultObjectSchema
  .extend({
    coverage: prBoundedCoverageSchema,
    stageErrors: z.array(typedStageErrorSchema),
  })
  .refine(completeResultCoversAllWork, {
    message: "complete results cannot have uncovered work or stage errors",
  }).refine(terminalResultPublishesNoIssues, {
    message: "failed and skipped results cannot publish issues",
  })
export type PrReviewResult = z.infer<typeof prReviewResultSchema>

const usableReviewResultSchema = z.intersection(
  prReviewResultSchema,
  z.object({ status: z.enum(["complete", "partial"]) }),
)
export type UsableReviewResult = z.infer<typeof usableReviewResultSchema>

const reportFields = { result: usableReviewResultSchema }
export const prOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("reviewed"), ...reportFields }),
  z.strictObject({ kind: z.literal("failed"), failure: failureSchema, snapshot: snapshotSchema.nullable() }),
  z.strictObject({ kind: z.literal("skipped"), reason: skipReasonSchema, snapshot: snapshotSchema.nullable() }),
])

export const jobResultSchema = z.enum(["success", "failure", "cancelled", "skipped"])

export type PullRequestIdentity = z.infer<typeof identitySchema>
export type ActionsExecution = z.infer<typeof actionsExecutionSchema>
export type Execution = z.infer<typeof executionSchema>
export type Trigger = z.infer<typeof triggerSchema>
export type Failure = z.infer<typeof failureSchema>
export type PrOutcome = z.infer<typeof prOutcomeSchema>
export type JobResult = z.infer<typeof jobResultSchema>

// The worker IPC gains this checkpoint shape in checkpoint 3. The local schema here composes the
// existing discovery and verification output schemas so the reducer has a validated input type
// before any IPC change.
export const phaseCheckpointSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("discovered"), output: discoveryOutputSchema }),
  z.strictObject({
    kind: z.literal("verified"),
    discovery: discoveryOutputSchema,
    verification: verificationOutputSchema,
  }).refine((checkpoint) => {
    const discovered = new Set(checkpoint.discovery.candidates.map((candidate) => candidate.id))
    return checkpoint.verification.verifications.length === discovered.size &&
      checkpoint.verification.verifications.every((verification) => discovered.has(verification.candidateId))
  }, {
    message: "a verified checkpoint requires a verification of every discovered candidate and no others",
  }),
])
export type PhaseCheckpoint = z.infer<typeof phaseCheckpointSchema>

export const recoverableFailureCodes = new Set<Failure["code"]>([
  "retry-exhausted", "acceptance-unknown", "discovery-timeout", "verification-timeout",
  "run-interrupted", "read-budget", "request-budget", "cleanup-failed",
])

type VerifiedCheckpoint = Extract<PhaseCheckpoint, { kind: "verified" }>

export type TerminalReview =
  | { kind: "reviewed"; status: "complete" | "partial"; result: UsableReviewResult }
  | { kind: "failed"; failure: Failure }

// A rejection is a typed contract violation between the execution identity, the checkpoint, and
// the assembled result. The caller turns it into a failed outcome; the reducer never throws and
// never converts a violation into a review.
export type ReviewReduction =
  | { kind: "reduced"; review: TerminalReview }
  | { kind: "rejected"; failure: Failure }

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

type VerifiedAccounting = {
  publishedPairs: PublishedIssue[]
  unpublishedCandidateIds: string[]
  unverifiedCandidateIds: string[]
}

// The checkpoint owns the candidate accounting. The published pairs, the keeps beyond the
// publication cap, and the candidates without an accepted keep are derived facts, not claims the
// assembled result is allowed to contradict.
function verifiedCheckpointAccounting(checkpoint: VerifiedCheckpoint): VerifiedAccounting {
  const { published, unpublishedCandidateIds } = deriveKeepPublication(
    checkpoint.discovery.candidates,
    checkpoint.verification.verifications,
  )
  const keptIds = new Set(checkpoint.verification.verifications
    .filter((verification) => verification.decision === "keep")
    .map((verification) => verification.candidateId))
  const unverifiedCandidateIds = checkpoint.discovery.candidates
    .filter((candidate) => !keptIds.has(candidate.id))
    .map((candidate) => candidate.id)
  return { publishedPairs: published, unpublishedCandidateIds, unverifiedCandidateIds }
}

const sameIds = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && expected.every((id) => actual.includes(id))

const samePairs = (actual: readonly PublishedIssue[], expected: readonly PublishedIssue[]): boolean =>
  actual.length === expected.length &&
  actual.every((issue, index) =>
    sameJson(issue.candidate, expected[index].candidate) && sameJson(issue.verification, expected[index].verification))

function accountingViolation(result: UsableReviewResult, accounting: VerifiedAccounting): string | null {
  if (!samePairs(result.issues, accounting.publishedPairs)) {
    return "the issues must be exactly the checkpoint's published keep pairs in publication order"
  }
  if (!sameIds(result.coverage.unpublishedCandidateIds, accounting.unpublishedCandidateIds)) {
    return "coverage must name exactly the accepted keeps beyond the publication cap as unpublished"
  }
  if (!sameIds(result.coverage.unverifiedCandidateIds, accounting.unverifiedCandidateIds)) {
    return "coverage must name exactly the candidates without an accepted keep as unverified"
  }
  return null
}

// Every issue must be the checkpoint's own accepted keep pair, not merely a pair that cites a
// keep candidate ID, and no keep may be published twice.
function issueViolationAgainstVerification(
  result: UsableReviewResult,
  checkpoint: VerifiedCheckpoint,
): string | null {
  const keepsById = new Map(checkpoint.verification.verifications
    .filter((verification) => verification.decision === "keep")
    .map((verification) => [verification.candidateId, verification]))
  const candidatesById = new Map(checkpoint.discovery.candidates.map((candidate) => [candidate.id, candidate]))
  const publishedIds = new Set<string>()
  for (const issue of result.issues) {
    if (publishedIds.has(issue.candidate.id)) {
      return `issue candidate ${issue.candidate.id} is published more than once`
    }
    publishedIds.add(issue.candidate.id)
    const keep = keepsById.get(issue.candidate.id)
    if (keep === undefined) {
      return `issue candidate ${issue.candidate.id} has no accepted keep verification in the checkpoint`
    }
    if (!sameJson(issue.candidate, candidatesById.get(issue.candidate.id)) ||
      !sameJson(issue.verification, keep)) {
      return `issue ${issue.candidate.id} does not carry the checkpoint candidate and keep verification`
    }
  }
  return null
}

// An interrupted verification leaves no accepted keep, so a partial from a discovered checkpoint
// carries zero current findings and names exactly the discovered candidates unverified.
function discoveredPartialViolation(result: UsableReviewResult, discovery: DiscoveryOutput): string | null {
  if (result.issues.length > 0) return "a partial from a discovered checkpoint carries zero current findings"
  const discovered = discovery.candidates.map((candidate) => candidate.id).sort()
  const unverified = [...result.coverage.unverifiedCandidateIds].sort()
  if (discovered.length !== unverified.length || discovered.some((id, index) => id !== unverified[index])) {
    return "a partial from a discovered checkpoint must name exactly the discovered candidates as unverified"
  }
  return null
}

// The design requires the exact stop reason on every accepted partial, so the reducer records the
// recoverable failure itself when the assembled result does not already carry it.
function withRecordedFailure(result: UsableReviewResult, failure: Failure): UsableReviewResult | null {
  if (result.stageErrors.some((error) => error.code === failure.code && error.stage === failure.stage)) {
    return result
  }
  const stageError = typedStageErrorSchema.safeParse({ code: failure.code, stage: failure.stage, message: failure.message })
  if (!stageError.success) return null
  return { ...result, stageErrors: [...result.stageErrors, stageError.data] }
}

// Skipped never comes through the reducer. Eligibility and no-change reasons exist before any
// checkpoint does, so the capture path owns that outcome directly.
export function reduceTerminalReview(input: {
  execution: Execution
  checkpoint: PhaseCheckpoint
  result?: PrReviewResult
  failure?: Failure
  pendingToolPages: number
}): ReviewReduction {
  const { execution, checkpoint, result, failure, pendingToolPages } = input
  const reject = (code: Failure["code"], message: string): ReviewReduction =>
    ({ kind: "rejected", failure: { code, stage: "cleanup", message } })

  if (!Number.isInteger(pendingToolPages) || pendingToolPages < 0) {
    return reject("input-invalid", "pendingToolPages must be a nonnegative integer count of the runtime's pending tool pages")
  }
  // The run ID arrives before schema validation, so the rejection message must not interpolate it.
  if (result !== undefined && result.runId !== execution.reviewRunId) {
    return reject("identity-mismatch", "review result runId does not equal execution reviewRunId")
  }
  if (result !== undefined && (result.status === "failed" || result.status === "skipped")) {
    return reject("input-invalid", `an assembled result with legacy status ${result.status} never enters the review reducer`)
  }
  if (failure !== undefined && (!recoverableFailureCodes.has(failure.code) || checkpoint.kind === "none")) {
    return { kind: "reduced", review: { kind: "failed", failure } }
  }
  if (result === undefined) {
    return reject("input-invalid", "a reviewed outcome requires an assembled review result")
  }
  if (failure === undefined && result.status === "complete" && deriveReviewStatus(result, pendingToolPages) === "partial") {
    return reject("input-invalid", "assembled result status complete does not match the derived status partial")
  }
  const usable = usableReviewResultSchema.safeParse(result)
  if (!usable.success) {
    return reject("input-invalid", "the assembled result does not satisfy the bounded PR review-result contract")
  }
  const reviewed = (status: "complete" | "partial", data: UsableReviewResult = usable.data): ReviewReduction =>
    ({ kind: "reduced", review: { kind: "reviewed", status, result: data } })

  if (failure !== undefined) {
    // A recoverable failure always forces partial, never complete.
    if (usable.data.status !== "partial") {
      return reject("input-invalid", `a recoverable failure forces partial, but the assembled result status is ${usable.data.status}`)
    }
    switch (checkpoint.kind) {
      case "none":
        return { kind: "reduced", review: { kind: "failed", failure } }
      case "discovered": {
        const violation = discoveredPartialViolation(usable.data, checkpoint.output)
        if (violation !== null) return reject("candidate-set-invalid", violation)
        const recorded = withRecordedFailure(usable.data, failure)
        if (recorded === null) return reject("input-invalid", "a recoverable failure must be recordable as a typed stage error")
        return reviewed("partial", recorded)
      }
      case "verified": {
        const violation = issueViolationAgainstVerification(usable.data, checkpoint)
        if (violation !== null) return reject("candidate-set-invalid", violation)
        const accountingError = accountingViolation(usable.data, verifiedCheckpointAccounting(checkpoint))
        if (accountingError !== null) return reject("candidate-set-invalid", accountingError)
        const recorded = withRecordedFailure(usable.data, failure)
        if (recorded === null) return reject("input-invalid", "a recoverable failure must be recordable as a typed stage error")
        return reviewed("partial", recorded)
      }
    }
  }

  switch (checkpoint.kind) {
    case "verified": {
      const violation = issueViolationAgainstVerification(usable.data, checkpoint)
      if (violation !== null) return reject("candidate-set-invalid", violation)
      const accountingError = accountingViolation(usable.data, verifiedCheckpointAccounting(checkpoint))
      if (accountingError !== null) return reject("candidate-set-invalid", accountingError)
      const derived = deriveReviewStatus(usable.data, pendingToolPages)
      if (usable.data.status !== derived) {
        return reject("input-invalid", `assembled result status ${usable.data.status} does not match the derived status ${derived}`)
      }
      return reviewed(derived)
    }
    case "discovered":
      return reject("input-invalid", "a discovered checkpoint without a failure or a verified checkpoint has no terminal state")
    case "none": {
      // The all-omitted case: material-only exclusion before any model work.
      if (usable.data.status !== "partial") {
        return reject("input-invalid", `a checkpoint of kind none without a failure is legal only for a partial result, not ${usable.data.status}`)
      }
      if (usable.data.issues.length > 0) {
        return reject("candidate-set-invalid", "a partial without a discovery checkpoint cannot carry issues")
      }
      if (usable.data.coverage.omittedPaths.length === 0) {
        return reject("input-invalid", "an all-omitted partial must name its omissions in coverage")
      }
      return reviewed("partial")
    }
  }
}
