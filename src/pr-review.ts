import { createHash } from "node:crypto"
import { lstat, mkdir, realpath } from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { backupReceiptSchema, writePrHandoff, type CapturedSnapshot, type PrHandoffInput } from "./handoff"
import { GitHubError, credentialFreeGitEnvironment, type FixedRepository, type GitHubReader, type PullRequestCapture } from "./github"
import { runReview, type ReviewRun } from "./review"
import { loadModelConfiguration } from "./runtime/worker-process"
import type { DiscoveryWorker } from "./discovery"
import { BudgetExhaustedError, withinDeadline, withinStage } from "./budget"
import {
  phaseCheckpointSchema, prReviewResultSchema, recoverableFailureCodes, reduceTerminalReview,
  type Execution, type Failure, type PhaseCheckpoint, type PrOutcome, type PrReviewResult, type PullRequestIdentity,
} from "./pr-contracts"
import { deriveReviewStatus, deriveKeepPublication, type Candidate, type ReviewResult, type Verification } from "./contracts"
import { gitShaSchema, type GitSha, type Sha256 } from "./identity"
import type { ExecutionBudget } from "./budget"
import type { ProgressEvent, ProgressSink } from "./progress"
import { readProductCommit } from "./product-identity"

const BACKUP_BODY_BYTE_LIMIT = 60_000
const FIXED_REPOSITORY_DISPOSAL_MS = 1_000
const sha256 = (value: string | Uint8Array): Sha256 => createHash("sha256").update(value).digest("hex") as Sha256
// Every failure message must satisfy the contract's one-line minimum, so an error carrying no
// usable text still becomes a bounded, nonempty diagnostic instead of a schema violation.
const boundedMessage = (error: unknown): string => {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000).trim()
  return message === "" ? "the failure carried no message" : message
}

// Checkpoint 2 maps a failed local result onto the closed PR failure enum from its stage error
// text. Checkpoint 3's runtime terminal error classifier owns the authoritative mapping through
// typed worker checkpoints, so these ordered patterns stay conservative.
function classifyStageError(stage: string, message: string): Failure {
  const prStage: Failure["stage"] = stage === "input" ? "input"
    : stage === "preparation" ? "preparation"
    : stage === "verification" ? "verification"
    : stage === "report" ? "handoff"
    : "discovery"
  const failure = (code: Failure["code"]): Failure => ({ code, stage: prStage, message: message.slice(0, 2_000) })
  if (/deadline|timed? ?out|exceeded the run/iu.test(message)) {
    return failure(prStage === "discovery" ? "discovery-timeout" : prStage === "verification" ? "verification-timeout" : "prepare-timeout")
  }
  if (/interrupted|signal/iu.test(message)) return failure("run-interrupted")
  if (/401|unauthorized|api key|authentication/iu.test(message)) return failure("model-auth")
  if (/refus/iu.test(message)) return failure("model-refusal")
  if (/REVIEW_MODEL_|base ?url|provider|model id/iu.test(message)) return failure("model-config")
  if (/close|host/iu.test(message)) return failure("cleanup-failed")
  if (/line range|excerpt|citation|snapshot:/iu.test(message)) return failure("citation-invalid")
  if (/candidate/iu.test(message)) return failure("candidate-set-invalid")
  return failure("model-format")
}

function failureFromLocalResult(result: ReviewResult): Failure {
  const error = result.stageErrors[0]
  if (error === undefined) return { code: "model-format", stage: "verification", message: "the local review failed without a recorded stage error" }
  return classifyStageError(error.stage, error.message)
}

function classifyCaptureError(error: unknown): Failure {
  const message = boundedMessage(error)
  if (error instanceof GitHubError) return { code: error.code, stage: "capture", message }
  if (error instanceof BudgetExhaustedError) return { code: "prepare-timeout", stage: "capture", message }
  return { code: "github-unavailable", stage: "capture", message }
}

function classifyPreparationError(error: unknown): Failure {
  const message = boundedMessage(error)
  if (error instanceof GitHubError) return { code: error.code, stage: "preparation", message }
  if (/deadline|exceeded the run/iu.test(message)) return { code: "prepare-timeout", stage: "preparation", message }
  return { code: "snapshot-fetch", stage: "preparation", message }
}

export type PrReviewCommand = { repository: string; pr: number; config: string; out: string }

export type PrReviewDependencies = {
  github: GitHubReader
  execution: Execution
  progress: ProgressSink
  // The non-secret model identity resolves once at initialization. The credential getter is
  // separate and lazy, so a draft, closed, fork, or all-omitted run never requires a model key.
  modelIdentity: () => { providerId: string; modelId: string }
  model: () => ReturnType<typeof loadModelConfiguration>
  budget: ExecutionBudget
  callerDirectory?: string
  productCommit?: GitSha
  attemptStartedAt?: string
  runWorker?: DiscoveryWorker
}

export type PreviousCommentBackup = { receipt: z.infer<typeof backupReceiptSchema>; body: string | null }

export type ReviewCommandOutcome = {
  outcome: PrOutcome
  runDirectory: string
  handoffDirectory: string | null
  replayExportDirectory: string | null
  replayIncomplete: boolean
  omittedTraceBytes: number
  artifactName: string | null
  exitCode: 0 | 1
}

// The backup keeps at most 60,000 bytes of the canonical owned body. Truncation cuts at a UTF-8
// code-point boundary, so re-encoding the saved body never emits replacement bytes that push it
// past the cap, and the receipt digest always covers the exact saved bytes.
function boundedBackupBody(body: string): string {
  const bytes = Buffer.from(body, "utf8")
  if (bytes.byteLength <= BACKUP_BODY_BYTE_LIMIT) return body
  let end = BACKUP_BODY_BYTE_LIMIT
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  const bounded = bytes.subarray(0, end).toString("utf8")
  if (Buffer.byteLength(bounded, "utf8") > BACKUP_BODY_BYTE_LIMIT) {
    throw new Error("the bounded backup body exceeded its byte cap")
  }
  return bounded
}

// Backup access never changes analysis completeness: a read failure degrades to an unavailable
// receipt that keeps the classified failure code, and the bounded body copy is diagnostic only.
async function readPreviousReportBackup(input: { identity: PullRequestIdentity; github: GitHubReader; budget: ExecutionBudget }): Promise<PreviousCommentBackup> {
  try {
    const observation = await withinStage(input.budget, "prepare-init", () => input.github.readProductComment({ identity: input.identity, budget: input.budget }))
    if (observation.kind === "absent") return { receipt: { kind: "absent" }, body: null }
    const bounded = boundedBackupBody(observation.canonical.body)
    return {
      receipt: backupReceiptSchema.parse({
        kind: "captured",
        commentId: observation.canonical.id,
        bodyDigest: sha256(bounded),
        updatedAt: observation.canonical.updatedAt,
      }),
      body: bounded,
    }
  } catch (error) {
    const code = error instanceof GitHubError ? error.code : error instanceof BudgetExhaustedError ? "prepare-timeout" : "github-unavailable"
    return { receipt: backupReceiptSchema.parse({ kind: "unavailable", code }), body: null }
  }
}

// A stage interruption or cleanup failure leaves the job red even when its partial report is
// usable, while a read or request cap alone is advisory coverage.
const redJobFailureCodes = new Set<Failure["code"]>([
  "retry-exhausted", "acceptance-unknown", "discovery-timeout", "verification-timeout",
  "run-interrupted", "cleanup-failed",
])

function exitCodeFor(outcome: PrOutcome): 0 | 1 {
  if (outcome.kind === "failed") return 1
  if (outcome.kind === "skipped") return 0
  return outcome.result.stageErrors.some((error) => redJobFailureCodes.has(error.code)) ? 1 : 0
}

const COVERAGE_PUBLICATION_CAPS = {
  includedPaths: 2_000,
  omittedPaths: 2_000,
  unverifiedCandidateIds: 8,
  unpublishedCandidateIds: 8,
  notes: 128,
} as const
type CoverageKind = keyof typeof COVERAGE_PUBLICATION_CAPS

// The PR publication schema bounds the coverage arrays. Overflow never fails the run or truncates
// silently: each overflowing kind records its exact dropped-entry count as an omitted coverage
// description, the omitted-path array reserves a slot for every description before slicing, and
// the status becomes partial. A non-overflowing omitted array that descriptions would push over
// its own cap overflows in its own right, so the reservation accounts for that case too. The
// complete inventory stays in the replay context manifest the caller already receives.
export function boundCoverageForPublication(coverage: ReviewResult["coverage"] & { unverifiedCandidateIds: string[] }): {
  coverage: PrReviewResult["coverage"]
  truncated: boolean
} {
  const kinds = Object.keys(COVERAGE_PUBLICATION_CAPS) as CoverageKind[]
  const overflowKinds = kinds.filter((kind) => kind !== "omittedPaths" && coverage[kind].length > COVERAGE_PUBLICATION_CAPS[kind])
  const omittedPushedOver = coverage.omittedPaths.length + overflowKinds.length > COVERAGE_PUBLICATION_CAPS.omittedPaths
  const descriptions = overflowKinds.length + (omittedPushedOver ? 1 : 0)
  if (descriptions === 0) {
    return {
      coverage: {
        includedPaths: coverage.includedPaths,
        omittedPaths: coverage.omittedPaths,
        unverifiedCandidateIds: coverage.unverifiedCandidateIds,
        unpublishedCandidateIds: coverage.unpublishedCandidateIds,
        notes: coverage.notes,
      },
      truncated: false,
    }
  }
  const omittedRoom = COVERAGE_PUBLICATION_CAPS.omittedPaths - descriptions
  const bounded: Record<CoverageKind, string[]> = {
    includedPaths: coverage.includedPaths,
    omittedPaths: coverage.omittedPaths.slice(0, omittedRoom),
    unverifiedCandidateIds: coverage.unverifiedCandidateIds,
    unpublishedCandidateIds: coverage.unpublishedCandidateIds,
    notes: coverage.notes,
  }
  for (const kind of overflowKinds) {
    const cap = COVERAGE_PUBLICATION_CAPS[kind]
    bounded[kind] = coverage[kind].slice(0, cap)
    bounded.omittedPaths.push(`${coverage[kind].length - cap} ${kind} entries beyond the ${cap}-entry publication cap are recorded only in the replay manifest`)
  }
  if (omittedPushedOver) {
    bounded.omittedPaths.push(`${coverage.omittedPaths.length - omittedRoom} omittedPaths entries beyond the 2000-entry publication cap are recorded only in the replay manifest`)
  }
  return { coverage: bounded, truncated: true }
}

function pendingToolPages(run: ReviewRun): number {
  return run.discovery?.runtime.readBudget.records.filter((record) => record.pending).length ?? 0
}

function checkpointFromRun(run: ReviewRun): PhaseCheckpoint {
  if (run.discovery === undefined) return { kind: "none" }
  return phaseCheckpointSchema.parse({
    kind: "verified",
    discovery: { candidates: run.discovery.candidates },
    verification: { verifications: run.discovery.verifications },
  })
}

// A terminal runtime failure with finished, validated work becomes a partial review through the
// same reducer as a clean run. The checkpoint comes from parent validation, never from array
// lengths: a fully validated empty verification stays a verified checkpoint, and an interrupted
// verification leaves zero current findings with every discovered candidate named unverified.
function recoverablePartialFromRuntime(result: ReviewResult, data: NonNullable<ReviewRun["failure"]>): {
  checkpoint: PhaseCheckpoint
  result: PrReviewResult
  pendingToolPages: number
} {
  const { candidates, verifications, failure, runtime, checkpoint } = data
  const { published: issues, unpublishedCandidateIds } = deriveKeepPublication(candidates, verifications)
  const keptIds = new Set(verifications.filter((verification) => verification.decision === "keep").map((verification) => verification.candidateId))
  const unverifiedCandidateIds = candidates.filter((candidate) => !keptIds.has(candidate.id)).map((candidate) => candidate.id)
  const { coverage } = boundCoverageForPublication({ ...result.coverage, unverifiedCandidateIds, unpublishedCandidateIds })
  return {
    checkpoint,
    result: prReviewResultSchema.parse({
      ...result,
      status: "partial",
      issues,
      coverage,
      stageErrors: [{ code: failure.code, stage: failure.stage, message: failure.message }],
    }),
    pendingToolPages: runtime?.readBudget.records.filter((record) => record.pending).length ?? 0,
  }
}

// Segment 1 coverage names only inconclusive verifications as unverified, while the PR contract
// names every candidate without an accepted keep and the checkpoint reducer owns that accounting.
// The assembled PR result adopts the PR semantics and the publication bounds before reduction, so
// a guarded review that rejected a candidate is an honest partial rather than a rejected complete.
function prResultFromRun(run: ReviewRun): PrReviewResult {
  const result = run.artifacts.result
  const unverifiedCandidateIds = run.discovery === undefined
    ? result.coverage.unverifiedCandidateIds
    : run.discovery.candidates
      .filter((candidate) => !run.discovery!.verifications.some((verification) => verification.decision === "keep" && verification.candidateId === candidate.id))
      .map((candidate) => candidate.id)
  const { coverage } = boundCoverageForPublication({ ...result.coverage, unverifiedCandidateIds })
  return prReviewResultSchema.parse({
    ...result,
    status: deriveReviewStatus({ ...result, coverage }, pendingToolPages(run)),
    coverage,
  })
}

export async function runPrReview(command: PrReviewCommand, deps: PrReviewDependencies): Promise<ReviewCommandOutcome> {
  const requestedOut = resolve(command.out)
  const out = join(await realpath(dirname(requestedOut)), basename(requestedOut))
  const productDirectory = await realpath(fileURLToPath(new URL("..", import.meta.url)))
  const callerDirectory = await realpath(deps.callerDirectory ?? process.env.GITHUB_WORKSPACE ?? process.cwd())
  deps.budget.assertRemaining("prepare-init")
  const callerRoot = Bun.spawnSync(["git", "-C", callerDirectory, "rev-parse", "--show-toplevel"], {
    env: credentialFreeGitEnvironment(), stdout: "pipe", stderr: "pipe", timeout: Math.max(1, deps.budget.stageRemainingMs("prepare-init")),
  })
  if (callerRoot.exitedDueToTimeout) throw new BudgetExhaustedError("output location validation exceeded the preparation deadline", "prepare-init")
  const callerCheckout = callerRoot.exitCode === 0 ? await realpath(new TextDecoder().decode(callerRoot.stdout).trim()) : callerDirectory
  for (const checkout of [productDirectory, callerCheckout]) {
    if (out === checkout || out.startsWith(`${checkout}${sep}`)) {
      throw new GitHubError("the output directory must be outside the caller and product checkouts", "input-invalid")
    }
  }
  const productCommit = deps.productCommit ?? await readProductCommit()
  await withinStage(deps.budget, "prepare-init", async (signal) => {
    if (await lstat(out).then(() => true, () => false)) {
      throw new GitHubError("the output directory must be a new directory", "input-invalid")
    }
    signal.throwIfAborted()
    await mkdir(out, { mode: 0o700 })
  })
  const replayDirectory = join(out, "replay")
  const actionsExecution = deps.execution.kind === "actions" ? deps.execution : null
  const isActions = actionsExecution !== null
  const artifactName = actionsExecution !== null ? `ai-code-review-handoff-${actionsExecution.workflowRunId}-${actionsExecution.attempt}` : null
  const replayArtifactName = actionsExecution !== null ? `ai-code-review-replay-${actionsExecution.workflowRunId}-${actionsExecution.attempt}` : null
  const runUrl = actionsExecution !== null ? actionsExecution.runUrl : null
  let sequence = 0
  const emit = (phase: ProgressEvent["phase"], event: ProgressEvent["event"]): void => {
    deps.progress({
      runId: deps.execution.reviewRunId,
      sequence: sequence++,
      at: new Date().toISOString(),
      phase,
      event,
      changedFilesIncluded: null,
      changedFilesTotal: null,
      candidatesDiscovered: null,
      candidatesVerified: null,
      remainingMs: Math.max(0, deps.budget.remainingMs()),
      runUrl,
    })
  }
  // One sequencer owns every event of this run, so runReview's own emission is resequenced
  // instead of starting a second counter.
  const reviewProgress: ProgressSink = (event) => deps.progress({ ...event, sequence: sequence++ })

  // The model record captures configured identity, resolved once at initialization from the
  // non-secret model settings. An Actions execution always carries it, so resolution failure
  // fails the run; the credential itself loads only after export proves included changes exist.
  let modelRecord: { providerId: string; modelId: string } | null = null
  let captured: PullRequestCapture | null = null
  let configSource: FixedRepository["configSource"] | null = null
  let backup: PreviousCommentBackup = { receipt: { kind: "absent" }, body: null }
  const failureOutcome = async (failure: Failure, runDirectory: string, replayRan: boolean): Promise<ReviewCommandOutcome> => {
    const outcome: PrOutcome = { kind: "failed", failure, snapshot: null }
    return finalize({
      identity: captured?.identity ?? null,
      execution: deps.execution,
      captured: captured === null ? null : { baseSha: captured.baseSha, headSha: captured.headSha, mergeBaseSha: null, observedAt: captured.observedAt },
      outcome,
      backup: backup.receipt,
      backupBody: backup.body,
      configSource,
      model: modelRecord,
      artifactName,
      replayArtifactName,
      completedAt: new Date().toISOString(),
      replayDirectory: replayRan ? replayDirectory : null,
    }, runDirectory, 1)
  }

  async function finalize(input: Omit<PrHandoffInput, "productCommit">, runDirectory: string, requestedExitCode: 0 | 1): Promise<ReviewCommandOutcome> {
    const written = await writePrHandoff({ ...input, productCommit, out }, { budget: deps.budget })
    let outcome = written.outcome
    if (input.identity !== null && written.handoffDirectory === null && outcome.kind === "skipped") {
      outcome = { kind: "failed", failure: { code: "artifact-write", stage: "handoff", message: "the handoff package could not be committed" }, snapshot: outcome.snapshot }
    }
    const exitCode = outcome.kind === "failed" ? 1 : outcome.kind === "skipped" ? 0 : requestedExitCode === 1 ? 1 : exitCodeFor(outcome)
    return {
      outcome,
      runDirectory,
      handoffDirectory: written.handoffDirectory,
      replayExportDirectory: written.replayExportDirectory,
      replayIncomplete: written.replayIncomplete,
      omittedTraceBytes: written.omittedTraceBytes,
      artifactName,
      exitCode,
    }
  }

  try {
    modelRecord = deps.modelIdentity()
  } catch (error) {
    if (isActions) {
      return failureOutcome({ code: "model-config", stage: "initialization", message: boundedMessage(error) }, out, false)
    }
  }

  emit("capture", "start")
  try {
    captured = await withinStage(deps.budget, "prepare-init", () => deps.github.capturePullRequest({ repository: command.repository, pr: command.pr, budget: deps.budget }))
  } catch (error) {
    if (!(error instanceof GitHubError || error instanceof BudgetExhaustedError)) throw error
    return failureOutcome(classifyCaptureError(error), out, false)
  }
  backup = await readPreviousReportBackup({ identity: captured.identity, github: deps.github, budget: deps.budget })
  emit("capture", "end")

  if (captured.eligibility.kind === "skip") {
    const outcome: PrOutcome = { kind: "skipped", reason: captured.eligibility.reason, snapshot: null }
    return finalize({
      identity: captured.identity,
      execution: deps.execution,
      captured: { baseSha: captured.baseSha, headSha: captured.headSha, mergeBaseSha: null, observedAt: captured.observedAt },
      outcome,
      backup: backup.receipt,
      backupBody: backup.body,
      configSource: null,
      model: modelRecord,
      artifactName,
      replayArtifactName,
      completedAt: new Date().toISOString(),
      replayDirectory: null,
    }, out, 0)
  }

  // Start removal even when preparation has expired. Only the wait is bounded, and a late
  // completion or failure must not hold up model analysis or consume the final write reserve.
  let disposal: Promise<Failure | null> | undefined
  const disposeFixedRepository = (fixed: FixedRepository): Promise<Failure | null> => disposal ??= (async () => {
    const deadline = Date.now() + Math.min(FIXED_REPOSITORY_DISPOSAL_MS, deps.budget.stageRemainingMs("prepare-init"))
    const removal = Promise.resolve().then(() => fixed.dispose()).then(
      () => null,
      (error): Failure => ({ code: "cleanup-failed", stage: "cleanup", message: boundedMessage(error) }),
    )
    const result = await withinDeadline(() => removal, deadline)
    return result.kind === "completed" ? result.value
      : { code: "cleanup-failed", stage: "cleanup", message: "fixed repository cleanup exceeded its deadline" }
  })()

  let fixed: FixedRepository
  let acquired: FixedRepository | undefined
  try {
    const capturedPr = captured
    fixed = await withinStage(deps.budget, "prepare-init", async (signal) => {
      const prepared = await deps.github.prepareFixedRepository({ captured: capturedPr, configPath: command.config, budget: deps.budget })
      acquired = prepared
      if (signal.aborted) void disposeFixedRepository(prepared)
      return prepared
    })
    configSource = fixed.configSource
  } catch (error) {
    if (acquired !== undefined) await disposeFixedRepository(acquired)
    return failureOutcome(classifyPreparationError(error), out, false)
  }

  let run: ReviewRun
  let disposeFailure: Failure | null = null
  let terminalOutcome: PrOutcome | undefined
  try {
    // runReview receives the replay subdirectory, never <out> itself, the budget owns its
    // deadline from the first API call through cleanup, and the export children run Git in the
    // credential-free environment.
    run = await runReview(
      { repo: fixed.directory, base: captured.baseSha, head: captured.headSha, out: replayDirectory },
      {
        budget: deps.budget,
        runId: deps.execution.reviewRunId,
        limits: fixed.config,
        progress: reviewProgress,
        getModelConfiguration: deps.model,
        gitEnvironment: credentialFreeGitEnvironment(),
        afterExport: async () => {
          disposeFailure = await disposeFixedRepository(fixed)
        },
        finalizeReplay: async (preparedRun, signal) => {
          signal.throwIfAborted()
          const outcome = reducePrRun(preparedRun, deps.execution, disposeFailure)
          terminalOutcome = outcome
          if (outcome.kind === "reviewed") return outcome.result
          const result = preparedRun.artifacts.result
          if (outcome.kind === "skipped") return result
          return prReviewResultSchema.parse({ ...result, status: "failed", issues: [], stageErrors: [outcome.failure],
            coverage: boundCoverageForPublication(result.coverage).coverage })
        },
        ...(deps.attemptStartedAt !== undefined ? { attemptStartedAt: deps.attemptStartedAt } : {}),
        ...(deps.runWorker !== undefined ? { runWorker: deps.runWorker } : {}),
      },
    )
  } catch (error) {
    await disposeFixedRepository(fixed)
    if (terminalOutcome === undefined) return failureOutcome(classifyPreparationError(error), out, false)
    return failureOutcome({ code: "artifact-write", stage: "handoff", message: boundedMessage(error) }, out, false)
  }

  const result = run.artifacts.result
  if (terminalOutcome === undefined) throw new Error("review did not assemble a terminal outcome")
  const outcome = terminalOutcome
  const capturedSnapshot: CapturedSnapshot = {
    baseSha: captured.baseSha,
    headSha: captured.headSha,
    mergeBaseSha: gitShaSchema.parse(result.snapshot.mergeBaseSha),
    observedAt: captured.observedAt,
  }
  return finalize({
    identity: captured.identity,
    execution: deps.execution,
    captured: capturedSnapshot,
    outcome,
    backup: backup.receipt,
    backupBody: backup.body,
    configSource,
    model: modelRecord,
    artifactName,
    replayArtifactName,
    completedAt: new Date().toISOString(),
    replayDirectory,
  }, replayDirectory, exitCodeFor(outcome))
}

function reducePrRun(run: ReviewRun, execution: Execution, disposeFailure: Failure | null): PrOutcome {
  const result = run.artifacts.result
  let outcome: PrOutcome
  if (result.status === "skipped") {
    outcome = { kind: "skipped", reason: "no-changes", snapshot: result.snapshot }
  } else if (result.status === "failed") {
    const runtimeFailureData = run.failure
    // The recoverable gate reads the validated checkpoint, not array lengths: a verified
    // checkpoint with zero candidates is still completed work worth a partial, while kind none
    // means no phase ever validated.
    if (runtimeFailureData !== undefined && recoverableFailureCodes.has(runtimeFailureData.failure.code) && runtimeFailureData.checkpoint.kind !== "none") {
      const recovered = recoverablePartialFromRuntime(result, runtimeFailureData)
      const reduction = reduceTerminalReview({
        execution,
        checkpoint: recovered.checkpoint,
        result: recovered.result,
        failure: runtimeFailureData.failure,
        pendingToolPages: recovered.pendingToolPages,
      })
      if (reduction.kind === "rejected") outcome = { kind: "failed", failure: reduction.failure, snapshot: result.snapshot }
      else if (reduction.review.kind === "failed") outcome = { kind: "failed", failure: reduction.review.failure, snapshot: result.snapshot }
      else outcome = { kind: "reviewed", result: reduction.review.result }
    } else {
      // Without validated work the typed failure stands on its own; a failure without a typed
      // classification falls back to the conservative message patterns.
      outcome = { kind: "failed", failure: runtimeFailureData?.failure ?? failureFromLocalResult(result), snapshot: result.snapshot }
    }
  } else {
    // Keep verified findings as a red partial when repository disposal failed before analysis.
    const assembled = prResultFromRun(run)
    const resultForReduction = disposeFailure !== null
      ? prReviewResultSchema.parse({ ...assembled, status: "partial" })
      : assembled
    const reduction = reduceTerminalReview({
      execution,
      checkpoint: checkpointFromRun(run),
      result: resultForReduction,
      ...(disposeFailure !== null ? { failure: disposeFailure } : {}),
      pendingToolPages: pendingToolPages(run),
    })
    if (reduction.kind === "rejected") outcome = { kind: "failed", failure: reduction.failure, snapshot: result.snapshot }
    else if (reduction.review.kind === "failed") outcome = { kind: "failed", failure: reduction.review.failure, snapshot: result.snapshot }
    else outcome = { kind: "reviewed", result: reduction.review.result }
  }
  return outcome
}
