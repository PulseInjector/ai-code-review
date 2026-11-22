import { createHash } from "node:crypto"
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Command } from "./cli"
import { BudgetExhaustedError, systemClock, withinStage, type ExecutionBudget } from "./budget"
import { canonicalJson, commentStateSchema, compareExecutions, PRODUCT_BOT_POLICY, renderComment, runUrl, sanitizeCommentText, truncateSummary, type CommentFreshness, type CommentState, type ReportSummary } from "./comment"
import { GitHubError, type CommentObservation, type GitHubPublisher, type ProductComment, type PullRequestCapture } from "./github"
import { admitHandoff, type AdmittedRun, type Admission, type ExpectedPublication } from "./handoff"
import { commentIdSchema, digestSchema, gitShaSchema, type GitSha, type Sha256 } from "./identity"
import { actionsExecutionSchema, identitySchema, recoverableFailureCodes, type ActionsExecution, type Failure } from "./pr-contracts"
import type { ProgressSink } from "./progress"

export type Freshness = Extract<CommentFreshness, { kind: "current" | "stale" }>
export type PublishDecision =
  | { kind: "reject"; failure: Failure }
  | { kind: "retain"; reason: "stale-before-write" | "older-publication" | "already-published"; run: AdmittedRun | null }
  | { kind: "write"; state: CommentState; body: string; expectedHead: GitSha; expectedBase: GitSha }
  | { kind: "write-failure-note"; state: CommentState; body: string; expectedHead: GitSha; expectedBase: GitSha; failure: Failure }
export type PublicationResult =
  | { kind: "published"; commentId: string; freshness: Freshness }
  | { kind: "retained"; reason: "stale-before-write" | "older-publication" | "already-published" }
  | { kind: "rejected"; failure: Failure }
  | { kind: "failed"; failure: Failure; commentId: string | null }
export type PublishDependencies = {
  github: GitHubPublisher
  execution: ActionsExecution
  progress: ProgressSink
  productCommit: GitSha
  programHash: Sha256
  budget: ExecutionBudget
}
export type PublishCommandOutcome = {
  publication: PublicationResult
  runUrl: string
  commentId: string | null
  evidenceDirectory: string
  exitCode: 0 | 1
}

type PublishCommand = Extract<Command, { kind: "publish" }>
const failure = (code: Failure["code"], message: string): Failure => ({ code, stage: "publish", message: message.slice(0, 2_000) || "the publication operation failed" })
const sameIdentity = (left: ExpectedPublication["identity"], right: ExpectedPublication["identity"]) => canonicalJson(left) === canonicalJson(right)
const sha256 = (text: string) => digestSchema.parse(createHash("sha256").update(text).digest("hex"))
const publicationMatches = (left: CommentState, right: CommentState) =>
  compareExecutions(left.lastPublishedRun.execution, right.lastPublishedRun.execution) === 0 && left.lastPublishedRun.resultDigest === right.lastPublishedRun.resultDigest

function summarize(run: AdmittedRun, identity: ExpectedPublication["identity"]): ReportSummary {
  if (run.outcome.kind !== "reviewed") throw new Error("a usable report is required")
  const result = run.outcome.result
  const issues = result.issues.map((issue, index): ReportSummary["issues"][number] => {
    const trigger = truncateSummary(issue.candidate.trigger, 240)
    const consequence = truncateSummary(issue.candidate.consequence, 240)
    const rootCause = truncateSummary(issue.candidate.rootCause, 240)
    const verification = truncateSummary(issue.verification.reason, 240)
    const { excerpt: _, ...location } = issue.candidate.changeLocation
    return { ordinal: index + 1, trigger: trigger.text, consequence: consequence.text, rootCause: rootCause.text, verification: verification.text,
      location: { kind: "inline", ...location }, summarized: trigger.summarized || consequence.summarized || rootCause.summarized || verification.summarized }
  })
  return {
    status: result.status, snapshot: result.snapshot, execution: { ...run.execution, runUrl: runUrl(identity, run.execution) }, resultDigest: run.resultDigest,
    completedAt: run.completedAt, issues, coverage: { included: result.coverage.includedPaths.length, omitted: result.coverage.omittedPaths.length,
      unverified: result.coverage.unverifiedCandidateIds.length, unpublished: result.coverage.unpublishedCandidateIds.length },
    usage: result.usage.kind === "known" ? result.usage : { kind: "unknown" }, durationMs: result.durationMs, summarized: issues.some((issue) => issue.summarized),
  }
}

function captureMatchesRun(run: AdmittedRun, current: PullRequestCapture): boolean {
  if (run.captured !== null && (run.captured.baseSha !== current.baseSha || run.captured.headSha !== current.headSha)) return false
  if (run.outcome.kind === "skipped") {
    if (run.captured === null) return false
    return run.outcome.reason === "no-changes" ? current.eligibility.kind === "review" : current.eligibility.kind === "skip" && current.eligibility.reason === run.outcome.reason
  }
  return run.captured === null || current.eligibility.kind === "review"
}

export function decidePublish(input: { expected: ExpectedPublication; admitted: Admission; current: PullRequestCapture; previous: CommentObservation }): PublishDecision {
  const { expected, admitted, current, previous } = input
  if (!identitySchema.safeParse(expected.identity).success || !actionsExecutionSchema.safeParse(expected.execution).success ||
    !gitShaSchema.safeParse(expected.productCommit).success || !digestSchema.safeParse(expected.programHash).success || !sameIdentity(expected.identity, current.identity)) {
    return { kind: "reject", failure: failure("identity-mismatch", "the publication context and current PR identity differ") }
  }
  const fixedRunRoute = `https://github.com/${expected.identity.repository}/actions/runs/${expected.execution.workflowRunId}`
  if (expected.execution.runUrl !== fixedRunRoute && expected.execution.runUrl !== runUrl(expected.identity, expected.execution)) return { kind: "reject", failure: failure("writer-context-required", "the Actions run URL differs from the fixed publication context") }
  if (admitted.kind === "rejected") return { kind: "reject", failure: admitted.failure }
  if (admitted.kind === "valid" && (!sameIdentity(admitted.run.identity, expected.identity) ||
    admitted.run.execution.workflowRunId !== expected.execution.workflowRunId || admitted.run.execution.attempt !== expected.execution.attempt ||
    canonicalJson({ ...admitted.run.execution, startedAt: null }) !== canonicalJson({ ...expected.execution, startedAt: null }))) return { kind: "reject", failure: failure("identity-mismatch", "the admitted run differs from the expected publication identity") }
  if (previous.kind === "invalid") return { kind: "reject", failure: failure("comment-state-invalid", "the canonical bot comment has invalid state") }
  if (previous.kind === "valid" && (!commentStateSchema.safeParse(previous.state).success || !sameIdentity(previous.state.identity, expected.identity))) return { kind: "reject", failure: failure("comment-state-invalid", "the canonical bot state differs from the expected identity") }
  const run = admitted.kind === "valid" ? admitted.run : null
  const digest = run?.resultDigest ?? null
  if (previous.kind === "valid") {
    const order = compareExecutions(expected.execution, previous.state.lastPublishedRun.execution)
    if (order < 0) return { kind: "retain", reason: "older-publication", run }
    if (order === 0) return digest === previous.state.lastPublishedRun.resultDigest
      ? { kind: "retain", reason: "already-published", run }
      : { kind: "reject", failure: failure("artifact-invalid", "the same workflow run and attempt has a conflicting artifact digest") }
  }
  if (run !== null && !captureMatchesRun(run, current)) return { kind: "retain", reason: "stale-before-write", run }
  const sourceExecution = run?.execution ?? expected.execution
  const execution = { ...sourceExecution, runUrl: runUrl(expected.identity, sourceExecution) }
  let lastReport = previous.kind === "valid" ? previous.state.lastReport : null
  let published: CommentState["lastPublishedRun"]
  if (run === null) {
    published = { execution, freshness: { kind: "not-reviewed" }, status: "failed", snapshot: null, resultDigest: null,
      failure: failure("artifact-missing", `No validated review artifact exists. Review job outcome: ${expected.reviewJobResult}.`) }
  } else {
    switch (run.outcome.kind) {
      case "reviewed":
        lastReport = summarize(run, expected.identity)
        published = { execution, freshness: { kind: "current" }, status: lastReport.status, snapshot: lastReport.snapshot, resultDigest: run.resultDigest }
        break
      case "failed":
        published = { execution, freshness: { kind: "not-reviewed" }, status: "failed", snapshot: run.outcome.snapshot, resultDigest: run.resultDigest, failure: run.outcome.failure }
        break
      case "skipped":
        published = { execution, freshness: { kind: "not-reviewed" }, status: "skipped", snapshot: run.outcome.snapshot, resultDigest: run.resultDigest, skipReason: run.outcome.reason }
        break
    }
  }
  try {
    const state: CommentState = { schemaVersion: 1, identity: expected.identity, lastReport, lastPublishedRun: published,
      duplicateCommentIds: previous.duplicateIds.slice(0, 20).map((id) => commentIdSchema.parse(id)), additionalDuplicateCount: Math.max(0, previous.duplicateIds.length - 20) }
    const references = new Map(run?.outcome.kind === "reviewed" ? run.outcome.result.issues.map((issue, index) => [index + 1, issue.candidate.changeLocation]) : [])
    const rendered = renderComment(state, references)
    return run === null
      ? { kind: "write-failure-note", ...rendered, expectedHead: current.headSha, expectedBase: current.baseSha, failure: published.status === "failed" ? published.failure : failure("artifact-missing", "no validated artifact exists") }
      : { kind: "write", ...rendered, expectedHead: current.headSha, expectedBase: current.baseSha }
  } catch {
    return { kind: "reject", failure: failure("comment-write", "the bounded comment could not be serialized without losing the last usable report") }
  }
}

function freshnessAfter(capture: PullRequestCapture, base: GitSha, head: GitSha, eligibility: PullRequestCapture["eligibility"]): Freshness {
  if (canonicalJson(capture.eligibility) !== canonicalJson(eligibility)) {
    const reason = capture.eligibility.kind === "skip" ? capture.eligibility.reason : eligibility.kind === "skip" ? eligibility.reason : "head-changed"
    return { kind: "stale", reason, observedBase: capture.baseSha, observedHead: capture.headSha }
  }
  const baseChanged = capture.baseSha !== base
  const headChanged = capture.headSha !== head
  if (!baseChanged && !headChanged) return { kind: "current" }
  return { kind: "stale", reason: baseChanged && headChanged ? "base-and-head-changed" : baseChanged ? "base-changed" : "head-changed", observedBase: capture.baseSha, observedHead: capture.headSha }
}

function errorFailure(error: unknown, code: Failure["code"] = "comment-write"): Failure {
  return failure(error instanceof GitHubError ? error.code : error instanceof BudgetExhaustedError ? "github-unavailable" : code, error instanceof GitHubError ? error.message : "the publication operation could not complete")
}

type Evidence = {
  precheck: PullRequestCapture | null
  intendedBodyDigest: Sha256 | null
  intendedBody: string | null
  observedCommentId: string | null
  postcheck: PullRequestCapture | null
  relistAttempts: number
  uncertainCreateFound: boolean
  writeAttempts: number
  humanMarkerIds: string[]
  duplicateIds: string[]
  additionalDuplicateCount: number
  additionalHumanMarkerCount: number
  previousComment: { id: string; body: string; bodyDigest: Sha256; truncated: boolean } | null
  uncertainCreateBodyDigest: Sha256 | null
  writeIntents: { kind: WriteIntent["kind"]; existingId: string | null; bodyDigest: Sha256 }[]
}
function recordCommentIds(evidence: Evidence, observed: CommentObservation): void {
  evidence.humanMarkerIds = observed.humanMarkerIds.slice(0, 20)
  evidence.duplicateIds = observed.duplicateIds.slice(0, 20)
  evidence.additionalDuplicateCount = Math.max(0, observed.duplicateIds.length - 20)
  evidence.additionalHumanMarkerCount = Math.max(0, observed.humanMarkerIds.length - 20)
}

type WriteIntent = { kind: "report" | "annotation"; state: CommentState; body: string; expectedBase: GitSha; expectedHead: GitSha }
type IntentResult = { kind: "confirmed"; comment: ProductComment; state: CommentState } | { kind: "terminal"; publication: PublicationResult }

async function reconcileComment(input: { decision: PublishDecision; previous: CommentObservation; expected: ExpectedPublication; admitted: Admission; current: PullRequestCapture; deps: PublishDependencies; evidence: Evidence }): Promise<PublicationResult> {
  const { expected, admitted, deps, evidence } = input
  const { github, budget } = deps
  let createSent = false
  const failed = (problem: Failure): IntentResult => ({ kind: "terminal", publication: { kind: "failed", failure: problem, commentId: evidence.observedCommentId } })
  const read = async () => {
    budget.assertRemaining("publish")
    const observed = await github.readProductComment({ identity: expected.identity, budget, stage: "publish" })
    recordCommentIds(evidence, observed)
    return observed
  }
  const active = async () => {
    budget.assertRemaining("publish")
    const workflow = await github.readWorkflow({ repository: expected.identity.repository, runId: expected.execution.workflowRunId, budget, stage: "publish" })
    if (workflow.repositoryId !== expected.identity.repositoryId || workflow.runId !== expected.execution.workflowRunId || workflow.event !== (expected.execution.trigger.kind === "manual" ? "workflow_dispatch" : "pull_request")) throw new GitHubError("the active workflow identity differs from the publication context", "identity-mismatch")
    if (workflow.currentAttempt !== expected.execution.attempt || workflow.status !== "in_progress") throw new GitHubError("the publication workflow attempt is no longer active", "writer-attempt-inactive")
  }
  const writeIntent = async (initial: WriteIntent, initialObservation: CommentObservation): Promise<IntentResult> => {
    let intent = initial
    let previous = initialObservation
    for (;;) {
      if (previous.kind === "invalid") return { kind: "terminal", publication: { kind: "rejected", failure: failure("comment-state-invalid", "the canonical bot comment has invalid state") } }
      if (previous.kind === "valid") {
        const order = compareExecutions(previous.state.lastPublishedRun.execution, intent.state.lastPublishedRun.execution)
        if (order > 0) return { kind: "terminal", publication: { kind: "retained", reason: "older-publication" } }
        if (order === 0 && previous.state.lastPublishedRun.resultDigest !== intent.state.lastPublishedRun.resultDigest) return { kind: "terminal", publication: { kind: "rejected", failure: failure("artifact-invalid", "the same publication has a conflicting digest") } }
        if (previous.canonical.body === intent.body) return { kind: "confirmed", comment: previous.canonical, state: intent.state }
      }
      if (intent.kind === "annotation" && (previous.kind !== "valid" || !publicationMatches(previous.state, intent.state))) return failed(failure("comment-write", "the publication to annotate no longer exists"))
      if (evidence.writeAttempts >= 3) return failed(failure("comment-write-unknown", "the publication exhausted its three write attempts"))
      await active()
      if (intent.kind === "report") {
        const current = await github.capturePullRequest({ repository: expected.identity.repository, pr: expected.identity.pr, budget, stage: "publish" })
        evidence.precheck = current
        const decision = decidePublish({ expected, admitted, current, previous })
        if (decision.kind === "reject") return { kind: "terminal", publication: { kind: "rejected", failure: decision.failure } }
        if (decision.kind === "retain" && decision.reason !== "already-published") return { kind: "terminal", publication: { kind: "retained", reason: decision.reason } }
        if (admitted.kind === "valid" && !captureMatchesRun(admitted.run, current)) return { kind: "terminal", publication: { kind: "retained", reason: "stale-before-write" } }
        if (current.baseSha !== intent.expectedBase || current.headSha !== intent.expectedHead || !sameIdentity(current.identity, expected.identity)) return { kind: "terminal", publication: { kind: "retained", reason: "stale-before-write" } }
        if (decision.kind === "write" || decision.kind === "write-failure-note") intent = { ...decision, kind: "report" }
      }
      budget.assertRemaining("publish")
      const existingId = previous.kind === "absent" ? null : previous.canonical.id
      if (existingId === null && createSent) return failed(failure("comment-write-unknown", "the invocation will not repeat an uncertain comment create"))
      evidence.intendedBody = intent.body
      evidence.intendedBodyDigest = sha256(intent.body)
      evidence.writeIntents.push({ kind: intent.kind, existingId, bodyDigest: evidence.intendedBodyDigest })
      evidence.writeAttempts += 1
      if (existingId === null) createSent = true
      let result
      try {
        result = await github.writeComment({ identity: expected.identity, existingId, body: intent.body, budget })
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404 && existingId !== null) {
          previous = await read()
          continue
        }
        return failed(errorFailure(error))
      }
      if (result.kind === "confirmed") {
        if (result.comment.authorId !== PRODUCT_BOT_POLICY.id || result.comment.authorLogin !== PRODUCT_BOT_POLICY.login || result.comment.body !== intent.body ||
          !commentIdSchema.safeParse(result.comment.id).success || existingId !== null && result.comment.id !== existingId) return failed(failure("identity-mismatch", "the confirmed comment differs from the intended bot write"))
        evidence.observedCommentId = result.comment.id
        return { kind: "confirmed", comment: result.comment, state: intent.state }
      }
      if (existingId === null) {
        evidence.uncertainCreateBodyDigest = sha256(intent.body)
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) {
            const delay = attempt * 1_000
            if (!budget.canStartRequest("publish", delay + 1)) return failed(failure("comment-write-unknown", "the create reconciliation cannot fit in the remaining budget"))
            await withinStage(budget, "publish", (signal) => systemClock.sleep(delay, signal))
          }
          evidence.relistAttempts += 1
          previous = await read()
          if (previous.kind === "invalid") return { kind: "terminal", publication: { kind: "rejected", failure: failure("comment-state-invalid", "an owned marker appeared with invalid state during create reconciliation") } }
          if (previous.kind === "valid" && (previous.canonical.body === intent.body ||
            previous.state.lastPublishedRun.execution.workflowRunId === expected.execution.workflowRunId && previous.state.lastPublishedRun.execution.attempt === expected.execution.attempt)) {
            evidence.uncertainCreateFound = true
            evidence.observedCommentId = previous.canonical.id
            break
          }
          if (previous.kind === "valid" && compareExecutions(previous.state.lastPublishedRun.execution, expected.execution) > 0) return { kind: "terminal", publication: { kind: "retained", reason: "older-publication" } }
        }
        if (!evidence.uncertainCreateFound) return failed(failure("comment-write-unknown", "the uncertain create was not visible after three complete listings"))
      } else {
        previous = await read()
        if (previous.kind === "absent") return failed(failure("comment-write-unknown", "the known comment was absent after an uncertain update"))
        evidence.observedCommentId = previous.canonical.id
      }
      if (previous.kind === "valid" && previous.canonical.body === intent.body) return { kind: "confirmed", comment: previous.canonical, state: intent.state }
    }
  }
  const postcheck = async (confirmed: Extract<IntentResult, { kind: "confirmed" }>, alreadyPublished: boolean): Promise<PublicationResult> => {
    let freshness: Freshness = { kind: "current" }
    let annotation: CommentFreshness | null = null
    let postcheckFailure: Failure | null = null
    const published = confirmed.state.lastPublishedRun
    try {
      const current = await github.capturePullRequest({ repository: expected.identity.repository, pr: expected.identity.pr, budget, stage: "publish" })
      if (!sameIdentity(current.identity, expected.identity)) throw new Error("postcheck identity mismatch")
      evidence.postcheck = current
      const base = published.snapshot === null ? input.current.baseSha : gitShaSchema.parse(published.snapshot.baseSha)
      const head = published.snapshot === null ? input.current.headSha : gitShaSchema.parse(published.snapshot.headSha)
      const expectedEligibility: PullRequestCapture["eligibility"] = published.status === "skipped" && published.skipReason !== "no-changes"
        ? { kind: "skip", reason: published.skipReason }
        : published.snapshot !== null ? { kind: "review" } : evidence.precheck?.eligibility ?? input.current.eligibility
      freshness = freshnessAfter(current, base, head, expectedEligibility)
      if (freshness.kind === "stale") annotation = freshness
      else if (published.freshness.kind === "stale") freshness = published.freshness
      else if (published.freshness.kind === "unconfirmed") annotation = published.status === "complete" || published.status === "partial" ? { kind: "current" } : { kind: "not-reviewed" }
    } catch {
      postcheckFailure = failure("postcheck-unavailable", "the post-write PR check could not complete")
      annotation = { kind: "unconfirmed", reason: "postcheck-unavailable" }
    }
    if (annotation !== null && canonicalJson(published.freshness) !== canonicalJson(annotation)) {
      const state = commentStateSchema.parse({ ...confirmed.state, lastPublishedRun: { ...published, freshness: annotation } })
      const rendered = renderComment(state)
      const observed = await read()
      const annotated = await writeIntent({ kind: "annotation", ...rendered, expectedBase: input.current.baseSha, expectedHead: input.current.headSha }, observed)
      if (annotated.kind === "terminal") return postcheckFailure === null ? annotated.publication : { kind: "failed", failure: postcheckFailure, commentId: evidence.observedCommentId }
    }
    if (postcheckFailure !== null) return { kind: "failed", failure: postcheckFailure, commentId: evidence.observedCommentId }
    return alreadyPublished ? { kind: "retained", reason: "already-published" } : { kind: "published", commentId: confirmed.comment.id, freshness }
  }
  const decision = input.decision
  if (decision.kind === "reject") return { kind: "rejected", failure: decision.failure }
  if (decision.kind === "retain") {
    if (decision.reason === "already-published" && input.previous.kind === "valid") {
      evidence.observedCommentId = input.previous.canonical.id
      return postcheck({ kind: "confirmed", comment: input.previous.canonical, state: input.previous.state }, true)
    }
    return { kind: "retained", reason: decision.reason }
  }
  const written = await writeIntent({ ...decision, kind: "report" }, input.previous)
  return written.kind === "terminal" ? written.publication : postcheck(written, false)
}

function sanitizePublicationText(value: string): string {
  let text = value
  for (const secret of [process.env.GITHUB_TOKEN, process.env.REVIEW_MODEL_API_KEY]) {
    if (secret !== undefined && secret !== "") text = text.replaceAll(secret, "[redacted]")
  }
  return text.replaceAll("::", ": :")
}

function sanitizeEvidence<T>(value: T): string {
  const scrub = (item: unknown): unknown => {
    if (typeof item === "string") {
      return sanitizePublicationText(item)
    }
    if (Array.isArray(item)) return item.map(scrub)
    if (item !== null && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, scrub(child)]))
    return item
  }
  return `${JSON.stringify(scrub(value), null, 2)}\n`
}

async function writePublicationSummary(result: PublishCommandOutcome, evidence: Evidence): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY
  if (path === undefined || path === "") return
  const lines = ["## AI code review publication", "", `Publication: ${result.publication.kind}.`, `Comment ID: ${result.commentId ?? "none"}.`, `Run: ${sanitizeCommentText(result.runUrl)}.`]
  if (result.publication.kind === "failed" || result.publication.kind === "rejected") lines.push(`Failure: ${sanitizeCommentText(result.publication.failure.message)}`)
  if (result.publication.kind === "retained") lines.push(`Retained: ${result.publication.reason}.`)
  for (const [label, ids, additional] of [["Duplicate bot comments", evidence.duplicateIds, evidence.additionalDuplicateCount], ["Human marker copies", evidence.humanMarkerIds, evidence.additionalHumanMarkerCount]] as const) {
    if (ids.length > 0) lines.push(`${label}: ${ids.map(sanitizeCommentText).join(", ")}${additional > 0 ? ` and ${additional} more` : ""}.`)
  }
  await appendFile(path, `${lines.join("\n")}\n`)
}

export async function publishReview(command: PublishCommand, deps: PublishDependencies): Promise<PublishCommandOutcome> {
  const { budget, execution, github } = deps
  const runnerTemp = process.env.RUNNER_TEMP
  const evidenceDirectory = runnerTemp === undefined || runnerTemp === ""
    ? await mkdtemp(join(tmpdir(), "ai-code-review-publish-"))
    : join(runnerTemp, `ai-code-review-${execution.workflowRunId}-${execution.attempt}`, "publish-evidence")
  await mkdir(evidenceDirectory, { recursive: true })
  const evidence: Evidence = { precheck: null, intendedBodyDigest: null, intendedBody: null, observedCommentId: null, postcheck: null, relistAttempts: 0, uncertainCreateFound: false, writeAttempts: 0, humanMarkerIds: [], duplicateIds: [], additionalDuplicateCount: 0, additionalHumanMarkerCount: 0, previousComment: null, uncertainCreateBodyDigest: null, writeIntents: [] }
  let publication: PublicationResult
  let admission: Admission | null = null
  let sequence = 0
  const progress = (event: "start" | "end" | "failure") => deps.progress({ runId: execution.reviewRunId, sequence: ++sequence, at: new Date().toISOString(), phase: "publish", event,
    changedFilesIncluded: null, changedFilesTotal: null, candidatesDiscovered: null, candidatesVerified: null, remainingMs: budget.remainingMs(), runUrl: execution.runUrl })
  try {
    progress("start")
    if (!actionsExecutionSchema.safeParse(execution).success) throw new GitHubError("an Actions execution is required to publish", "writer-context-required")
    const current = await github.capturePullRequest({ repository: command.repository, pr: command.pr, budget, stage: "publish" })
    evidence.precheck = current
    if (current.identity.repository !== command.repository || current.identity.pr !== command.pr) throw new GitHubError("the captured PR differs from the publish command", "identity-mismatch")
    const expected: ExpectedPublication = { identity: current.identity, execution, reviewJobResult: command.reviewJobResult, productCommit: deps.productCommit, programHash: deps.programHash }
    admission = await admitHandoff(command.packageDirectory, expected, github, budget)
    if (admission.kind === "rejected") publication = { kind: "rejected", failure: admission.failure }
    else {
      const previous = await github.readProductComment({ identity: current.identity, budget, stage: "publish" })
      recordCommentIds(evidence, previous)
      if (previous.kind !== "absent") {
        evidence.observedCommentId = previous.canonical.id
        const original = Buffer.from(previous.canonical.body, "utf8")
        let end = Math.min(original.byteLength, 60_000)
        while (end < original.byteLength && end > 0 && (original[end]! & 0xc0) === 0x80) end -= 1
        const body = original.subarray(0, end).toString("utf8")
        evidence.previousComment = { id: previous.canonical.id, body, bodyDigest: sha256(body), truncated: original.byteLength > end }
      }
      const decision = decidePublish({ expected, admitted: admission, current, previous })
      publication = await reconcileComment({ decision, previous, expected, admitted: admission, current, deps, evidence })
    }
  } catch (error) {
    const problem = errorFailure(error)
    publication = ["writer-context-required", "writer-attempt-inactive", "identity-mismatch"].includes(problem.code)
      ? { kind: "rejected", failure: problem }
      : { kind: "failed", failure: problem, commentId: evidence.observedCommentId }
  }
  if (publication.kind === "failed" || publication.kind === "rejected") publication = { ...publication, failure: { ...publication.failure, message: sanitizePublicationText(publication.failure.message).slice(0, 2_000) } }
  let exitCode: 0 | 1 = publication.kind === "rejected" || publication.kind === "failed" || admission?.kind === "missing" ? 1 : 0
  if (admission?.kind === "valid" && (admission.run.outcome.kind === "failed" || admission.run.outcome.kind === "reviewed" && admission.run.outcome.result.stageErrors.some((error) => recoverableFailureCodes.has(error.code) && error.code !== "read-budget" && error.code !== "request-budget"))) exitCode = 1
  if (publication.kind === "retained") exitCode = 0
  const result: PublishCommandOutcome = { publication, runUrl: execution.runUrl, commentId: publication.kind === "published" ? publication.commentId : evidence.observedCommentId, evidenceDirectory, exitCode }
  const json = sanitizeEvidence({ ...evidence, publication, runUrl: execution.runUrl })
  if (Buffer.byteLength(json) > 1_048_576) throw new Error("publish evidence exceeds its byte cap")
  await writeFile(join(evidenceDirectory, "publish-result.json"), json, { mode: 0o600 })
  await writePublicationSummary(result, evidence)
  progress(exitCode === 0 ? "end" : "failure")
  return result
}
