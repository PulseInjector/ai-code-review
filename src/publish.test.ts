import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBudget, systemClock } from "./budget"
import { canonicalJson, commentStateSchema, markerLine, parseStateBlock, renderCommentBody, runUrl, scanProductComments, type CommentState } from "./comment"
import { dispatchCommand, parseCommand } from "./cli"
import { createGitHubPublisher, GitHubError, type FetchLike, type CommentObservation, type GitHubPublisher, type ProductComment, type PullRequestCapture, type WorkflowObservation } from "./github"
import { writePrHandoff, type AdmittedRun, type Admission, type ExpectedPublication } from "./handoff"
import { commentIdSchema, digestSchema, gitShaSchema, type GitSha } from "./identity"
import { actionsExecutionSchema, identitySchema, prOutcomeSchema, type ActionsExecution, type PrOutcome } from "./pr-contracts"
import { hashProductSources, hashPromptTemplates, readProductIdentity } from "./product-identity"
import { decidePublish, publishReview, type PublishDependencies } from "./publish"

const time = "2026-11-21T10:00:00Z"
const identity = identitySchema.parse({ repositoryId: "123", repository: "owner/repo", pr: 17 })
const base = gitShaSchema.parse("a".repeat(40))
const head = gitShaSchema.parse("b".repeat(40))
const mergeBase = gitShaSchema.parse("c".repeat(40))
const nextHead = gitShaSchema.parse("e".repeat(40))
const productCommit = gitShaSchema.parse("f".repeat(40))
const digest = digestSchema.parse("d".repeat(64))
const snapshot = { baseSha: base, headSha: head, mergeBaseSha: mergeBase }
const absent: CommentObservation = { kind: "absent", duplicateIds: [], humanMarkerIds: [] }
function execution(id = "1234", attempt = 1, triggeredAt = time): ActionsExecution {
  return actionsExecutionSchema.parse({ kind: "actions", workflowRunId: id, attempt, reviewRunId: `gh-${id}-${attempt}`, trigger: { kind: "manual" },
    triggeredAt, startedAt: triggeredAt, runUrl: `https://github.com/owner/repo/actions/runs/${id}` })
}
function reviewed(ex: ActionsExecution = execution(), status: "complete" | "partial" = "complete"): PrOutcome {
  return prOutcomeSchema.parse({ kind: "reviewed", result: { runId: ex.reviewRunId, snapshot, status, issues: [],
    coverage: { includedPaths: ["src/Example.java"], omittedPaths: [], unverifiedCandidateIds: status === "partial" ? ["C-1"] : [], unpublishedCandidateIds: [], notes: [] },
    stageErrors: [], usage: { kind: "known", inputTokens: 1, outputTokens: 2 },
    versions: { program: digest, sdk: "2.2.7", config: digest, discoverPrompt: digest, verifyPrompt: digest }, durationMs: 25 } })
}
function runFor(ex = execution(), outcome = reviewed(ex)): AdmittedRun {
  return { identity, execution: ex, captured: { baseSha: base, headSha: head, mergeBaseSha: mergeBase }, outcome, resultDigest: digest, completedAt: ex.startedAt }
}
function capture(overrides: Partial<PullRequestCapture> = {}): PullRequestCapture {
  return { identity, baseSha: base, headSha: head, observedAt: time, eligibility: { kind: "review" }, ...overrides }
}
function pureInput(run = runFor()): { expected: ExpectedPublication; admitted: Admission; current: PullRequestCapture; previous: CommentObservation } {
  return { expected: { identity, execution: run.execution, reviewJobResult: "success", productCommit, programHash: digest }, admitted: { kind: "valid", run }, current: capture(), previous: absent }
}
function stateFor(run = runFor()): CommentState {
  const decision = decidePublish(pureInput(run))
  if (decision.kind !== "write") throw new Error(`fixture failed: ${canonicalJson(decision)}`)
  return decision.state
}
function comment(state: CommentState, id = "501"): ProductComment {
  return { id: commentIdSchema.parse(id), authorId: "41898282", authorLogin: "github-actions[bot]", body: renderCommentBody(state), createdAt: time, updatedAt: time }
}
function observation(state: CommentState, id = "501", duplicateIds: string[] = []): Extract<CommentObservation, { kind: "valid" }> {
  return { kind: "valid", canonical: comment(state, id), state, duplicateIds, humanMarkerIds: [] }
}

test("review and publication entry times may differ without changing workflow provenance", () => {
  const input = pureInput()
  input.expected.execution = { ...input.expected.execution, startedAt: "2026-11-21T10:01:00Z" }
  expect(decidePublish(input).kind).toBe("write")
})

test("rejected packages and wrong identity take precedence over damaged comment state", () => {
  const input = pureInput()
  input.previous = { kind: "invalid", canonical: comment(stateFor()), reason: "damaged", duplicateIds: [], humanMarkerIds: [] }
  input.admitted = { kind: "rejected", failure: { code: "artifact-invalid", stage: "publish", message: "corrupt" } }
  expect(decidePublish(input)).toMatchObject({ kind: "reject", failure: { code: "artifact-invalid" } })
  input.current.identity = identitySchema.parse({ ...identity, pr: 18 })
  expect(decidePublish(input)).toMatchObject({ kind: "reject", failure: { code: "identity-mismatch" } })
})

test("invalid canonical state blocks writes before stale or older decisions", () => {
  const input = pureInput()
  input.current.headSha = nextHead
  input.previous = { kind: "invalid", canonical: comment(stateFor()), reason: "damaged", duplicateIds: [], humanMarkerIds: [] }
  expect(decidePublish(input)).toMatchObject({ kind: "reject", failure: { code: "comment-state-invalid" } })
})

test("same-run attempt ordering wins over trigger timestamps", () => {
  const earlier = stateFor(runFor(execution("1234", 1)))
  const next = pureInput(runFor(execution("1234", 2)))
  next.previous = observation(earlier)
  expect(decidePublish(next).kind).toBe("write")
  const older = pureInput()
  older.previous = observation(stateFor(runFor(execution("1234", 2))))
  older.current.headSha = nextHead
  expect(decidePublish(older)).toMatchObject({ kind: "retain", reason: "older-publication" })
})

test("cross-run publication order uses trigger time and BigInt ID for ties", () => {
  const newer = stateFor(runFor(execution("9007199254740993")))
  const older = pureInput(runFor(execution("9007199254740992")))
  older.previous = observation(newer)
  expect(decidePublish(older)).toMatchObject({ kind: "retain", reason: "older-publication" })
  const newerTime = pureInput(runFor(execution("1", 1, "2026-11-21T10:00:01Z")))
  newerTime.previous = observation(newer)
  expect(decidePublish(newerTime).kind).toBe("write")
})

test("equal publication and digest shortcut precedes stale checks and conflicting bytes reject", () => {
  const input = pureInput()
  input.previous = observation(stateFor())
  input.current.headSha = nextHead
  expect(decidePublish(input)).toMatchObject({ kind: "retain", reason: "already-published" })
  if (input.admitted.kind === "valid") input.admitted.run.resultDigest = digestSchema.parse("e".repeat(64))
  expect(decidePublish(input)).toMatchObject({ kind: "reject", failure: { code: "artifact-invalid" } })
})

test.each([
  ["head", { headSha: nextHead }], ["base", { baseSha: nextHead }], ["both", { headSha: nextHead, baseSha: nextHead }],
  ["draft", { eligibility: { kind: "skip", reason: "draft" } }], ["closed", { eligibility: { kind: "skip", reason: "closed" } }],
  ["fork", { eligibility: { kind: "skip", reason: "fork" } }],
] satisfies [string, Partial<PullRequestCapture>][])("an analyzed %s change retains the old comment", (_name, change) => {
  const input = pureInput()
  input.current = capture(change)
  expect(decidePublish(input)).toMatchObject({ kind: "retain", reason: "stale-before-write" })
})

test("a captured failure cannot replace a newer snapshot", () => {
  const input = pureInput(runFor(execution(), { kind: "failed", failure: { code: "runtime-init", stage: "initialization", message: "failed" }, snapshot }))
  input.current.headSha = nextHead
  expect(decidePublish(input)).toMatchObject({ kind: "retain", reason: "stale-before-write" })
})

test.each(["draft", "closed", "fork", "no-changes"] as const)("a matching %s skip updates metadata and retains the last report separately", (reason) => {
  const older = stateFor()
  const input = pureInput(runFor(execution("1235"), { kind: "skipped", reason, snapshot }))
  input.previous = observation(older)
  input.current.eligibility = reason === "no-changes" ? { kind: "review" } : { kind: "skip", reason }
  const decision = decidePublish(input)
  expect(decision.kind).toBe("write")
  if (decision.kind !== "write") return
  expect(decision.state.lastReport).toEqual(older.lastReport)
  expect(decision.state.lastPublishedRun).toMatchObject({ status: "skipped", skipReason: reason, freshness: { kind: "not-reviewed" } })
  expect(decision.body).toContain("Last usable report")
  input.current.eligibility = reason === "draft" ? { kind: "review" } : { kind: "skip", reason: "draft" }
  expect(decidePublish(input)).toMatchObject({ kind: "retain", reason: "stale-before-write" })
})

test("complete and partial replace the last report while failure preserves it", () => {
  const old = stateFor()
  for (const status of ["complete", "partial"] as const) {
    const run = runFor(execution("1235"), reviewed(execution("1235"), status))
    const input = pureInput(run)
    input.previous = observation(old)
    const decision = decidePublish(input)
    expect(decision.kind).toBe("write")
    if (decision.kind === "write") {
      expect(String(decision.state.lastReport?.execution.workflowRunId)).toBe("1235")
      expect(decision.state.lastReport?.status).toBe(status)
      expect(decision.state.lastPublishedRun.status).toBe(status)
    }
  }
  const input = pureInput(runFor(execution("1235"), { kind: "failed", snapshot, failure: { code: "model-auth", stage: "initialization", message: "rejected" } }))
  input.previous = observation(old)
  const failed = decidePublish(input)
  expect(failed.kind).toBe("write")
  if (failed.kind === "write") expect(failed.state.lastReport).toEqual(old.lastReport)
})

test.each(["success", "failure", "cancelled", "skipped"] as const)("a missing artifact names review job %s and invents no analyzed snapshot", (job) => {
  const input = pureInput(runFor(execution("1235")))
  input.admitted = { kind: "missing", failure: { code: "artifact-missing", stage: "publish", message: "missing" } }
  input.expected.reviewJobResult = job
  input.previous = observation(stateFor())
  const decision = decidePublish(input)
  expect(decision.kind).toBe("write-failure-note")
  if (decision.kind !== "write-failure-note") return
  expect(decision.state.lastPublishedRun).toMatchObject({ status: "failed", snapshot: null, resultDigest: null, freshness: { kind: "not-reviewed" } })
  expect(decision.state.lastReport).toEqual(input.previous.state.lastReport)
  expect(decision.body).toContain(`No validated review artifact exists&#46; Review job outcome&#58; ${job}&#46;`)
})

test("duplicate state records twenty IDs and the exact remaining count", () => {
  const input = pureInput(runFor(execution("1235")))
  input.previous = observation(stateFor(), "501", Array.from({ length: 27 }, (_, i) => `${i + 600}`))
  const decision = decidePublish(input)
  expect(decision.kind).toBe("write")
  if (decision.kind === "write") {
    expect(decision.state.duplicateCommentIds).toHaveLength(20)
    expect(decision.state.additionalDuplicateCount).toBe(7)
    expect(decision.body).toContain("and 7 more")
  }
})

const temporaryPaths: string[] = []
afterEach(async () => { await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
type WriteInput = Parameters<GitHubPublisher["writeComment"]>[0]
type WriteResponse = Awaited<ReturnType<GitHubPublisher["writeComment"]>>
const unknownWrite: WriteResponse = { kind: "unknown", failure: { code: "comment-write-unknown", stage: "publish", message: "response lost" } }
async function fixture(outcomeKind: "complete" | "partial" | "partial-timeout" | "findings" | "failed" | "skipped" | "missing" = "complete", failureMessage = "initialization failed") {
  const directory = await mkdtemp(join(tmpdir(), "ai-code-review-publisher-test-"))
  temporaryPaths.push(directory)
  const ex = execution()
  const programHash = await hashProductSources()
  const prompts = await hashPromptTemplates()
  const raw = reviewed(ex, outcomeKind === "partial" || outcomeKind === "partial-timeout" ? "partial" : "complete")
  if (raw.kind !== "reviewed") throw new Error("fixture needs a usable result")
  if (outcomeKind === "partial-timeout") raw.result.stageErrors.push({ code: "verification-timeout", stage: "verification", message: "verification exceeded its deadline" })
  if (outcomeKind === "findings") raw.result.issues.push({
    candidate: { id: "C-1", changeLocation: { side: "head", path: "src/Example.java", startLine: 1, endLine: 1, excerpt: "return null;" },
      trigger: "t".repeat(2_000), consequence: "c".repeat(2_000), rootCause: "r".repeat(2_000),
      citations: [{ side: "head", path: "src/Example.java", startLine: 1, endLine: 1, excerpt: "return null;" }] },
    verification: { candidateId: "C-1", decision: "keep", reason: "v".repeat(2_000), evidence: [{ side: "head", path: "src/Example.java", startLine: 1, endLine: 1, excerpt: "return null;" }] },
  })
  raw.result.versions = { ...raw.result.versions, program: programHash, ...{ discoverPrompt: prompts.discoverPrompt, verifyPrompt: prompts.verifyPrompt } }
  const outcome: PrOutcome = outcomeKind === "failed"
    ? { kind: "failed", snapshot, failure: { code: "runtime-init", stage: "initialization", message: failureMessage } }
    : outcomeKind === "skipped" ? { kind: "skipped", reason: "draft", snapshot } : raw
  let packageDirectory = join(directory, "missing")
  if (outcomeKind !== "missing") {
    const written = await writePrHandoff({ out: directory, identity, execution: ex, captured: { ...snapshot, observedAt: time }, outcome,
      backup: { kind: "absent" }, backupBody: null, configSource: { kind: "product-default", digest }, model: { providerId: "fake", modelId: "fake" },
      artifactName: null, replayArtifactName: null, completedAt: time, replayDirectory: null, productCommit })
    if (written.handoffDirectory === null) throw new Error(`handoff fixture failed: ${canonicalJson(written)}`)
    packageDirectory = written.handoffDirectory
  }
  const initialWorkflow: WorkflowObservation = { repositoryId: identity.repositoryId, runId: ex.workflowRunId, currentAttempt: ex.attempt, createdAt: time, attemptStartedAt: time, status: "in_progress", event: "workflow_dispatch" }
  const control = {
    comments: [] as ProductComment[], captures: [capture()] as PullRequestCapture[], captureCalls: 0, listCalls: 0, workflowCalls: 0,
    writes: [] as WriteInput[], workflow: initialWorkflow, missing: outcomeKind === "missing", listHidden: 0,
    onList: null as null | (() => void), onCapture: null as null | ((call: number) => void),
    onWrite: null as null | ((input: WriteInput, persist: () => ProductComment) => Promise<WriteResponse>),
  }
  const github: GitHubPublisher = {
    async capturePullRequest() {
      control.captureCalls += 1
      control.onCapture?.(control.captureCalls)
      return control.captures[Math.min(control.captureCalls - 1, control.captures.length - 1)]!
    },
    async readWorkflow() { control.workflowCalls += 1; return control.workflow },
    async prepareFixedRepository() { throw new Error("publish must not prepare a review") },
    async readFixedSnapshot() { return { mergeBaseSha: mergeBase, changedHeadPaths: ["src/Example.java"], sources: [{ side: "head", path: "src/Example.java", text: "return null;\n" }] } },
    async readFixedLines() { throw new Error("zero issues need no citation lines") },
    async readArtifactReceipt() { return control.missing ? null : { id: "1", name: `ai-code-review-handoff-${ex.workflowRunId}-${ex.attempt}`, workflowRunId: ex.workflowRunId, bytes: 1, expired: false, digest: null } },
    async readProductComment() {
      control.listCalls += 1
      control.onList?.()
      if (control.listHidden-- > 0) return absent
      const scanned = scanProductComments(control.comments.map((entry) => ({ ...entry, authorType: "Bot" })), identity)
      if (scanned.canonical === null) return absent
      const canonical = scanned.canonical
      const duplicateIds = scanned.duplicates.map(({ id }) => id)
      try { return { kind: "valid", canonical, state: parseStateBlock(canonical.body, identity), duplicateIds, humanMarkerIds: scanned.humanMarkerIds } }
      catch { return { kind: "invalid", canonical, reason: "damaged", duplicateIds, humanMarkerIds: scanned.humanMarkerIds } }
    },
    async writeComment(input) {
      control.writes.push(input)
      const persist = () => {
        const saved: ProductComment = { id: commentIdSchema.parse(input.existingId ?? "501"), authorId: "41898282", authorLogin: "github-actions[bot]", body: input.body, createdAt: time, updatedAt: time }
        control.comments = [...control.comments.filter((entry) => entry.id !== saved.id), saved]
        return saved
      }
      return control.onWrite === null ? { kind: "confirmed", comment: persist() } : control.onWrite(input, persist)
    },
  }
  const deps: PublishDependencies = { github, execution: { ...ex, startedAt: "2026-11-21T10:01:00Z" }, productCommit, programHash, progress: () => {}, budget: createBudget(systemClock, 120_000) }
  const command = { kind: "publish", repository: identity.repository, pr: identity.pr, packageDirectory, reviewJobResult: "success" } satisfies Parameters<typeof publishReview>[0]
  const publish = async () => {
    const result = await publishReview(command, deps)
    temporaryPaths.push(result.evidenceDirectory)
    return result
  }
  return { control, deps, command, publish }
}

test("publication creates one canonical comment and an identical rerun performs no write", async () => {
  const f = await fixture()
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "published", commentId: "501", freshness: { kind: "current" } })
  expect(result.exitCode).toBe(0)
  expect(f.control.writes.map(({ existingId }) => existingId)).toEqual([null])
  const again = await f.publish()
  expect(again.publication).toEqual({ kind: "retained", reason: "already-published" })
  expect(f.control.writes).toHaveLength(1)
  expect(f.control.comments).toHaveLength(1)
  const evidence = JSON.parse(await readFile(join(result.evidenceDirectory, "publish-result.json"), "utf8"))
  expect(evidence.observedCommentId).toBe("501")
  expect(evidence.intendedBodyDigest).toBe(createHash("sha256").update(f.control.comments[0]!.body).digest("hex"))
  expect(evidence.precheck.headSha).toBe(head)
  expect(evidence.postcheck.headSha).toBe(head)
})

test("a committed POST with a lost response retains the original comment ID", async () => {
  const f = await fixture()
  f.control.onWrite = async (_input, persist) => { persist(); return unknownWrite }
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "published", commentId: "501" })
  expect(f.control.comments).toHaveLength(1)
  expect(f.control.writes).toHaveLength(1)
  const evidence = JSON.parse(await readFile(join(result.evidenceDirectory, "publish-result.json"), "utf8"))
  expect(evidence.uncertainCreateFound).toBe(true)
  expect(evidence.relistAttempts).toBe(1)
  const again = await f.publish()
  expect(again.publication).toEqual({ kind: "retained", reason: "already-published" })
  expect(f.control.writes).toHaveLength(1)
})

test("an uncertain POST is never repeated after three complete absence reads", async () => {
  const f = await fixture()
  f.control.onWrite = async () => unknownWrite
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "failed", failure: { code: "comment-write-unknown" }, commentId: null })
  expect(result.exitCode).toBe(1)
  expect(f.control.writes).toHaveLength(1)
  expect(f.control.listCalls).toBe(4)
  expect(f.control.comments).toHaveLength(0)
}, 10_000)

test("delayed list visibility adopts the original POST on the second read", async () => {
  const f = await fixture()
  f.control.onWrite = async (_input, persist) => { persist(); f.control.listHidden = 1; return unknownWrite }
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "published", commentId: "501" })
  expect(f.control.writes).toHaveLength(1)
  expect(f.control.listCalls).toBe(3)
})

test("a failed reconciliation read never permits another POST", async () => {
  const f = await fixture()
  f.control.onWrite = async (_input, persist) => { persist(); return unknownWrite }
  f.control.onList = () => { if (f.control.listCalls === 2) throw new GitHubError("listing unavailable", "github-unavailable") }
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "failed", failure: { code: "github-unavailable" } })
  expect(f.control.writes).toHaveLength(1)
  expect(f.control.comments).toHaveLength(1)
})

test("an H2 post-write race annotates the H1 report in the original comment", async () => {
  const f = await fixture()
  f.control.captures = [capture(), capture(), capture({ headSha: nextHead })]
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "published", commentId: "501", freshness: { kind: "stale", observedHead: nextHead, reason: "head-changed" } })
  expect(f.control.writes.map(({ existingId }) => existingId)).toEqual([null, "501"])
  const state = parseStateBlock(f.control.comments[0]!.body)
  expect(state.lastReport?.snapshot.headSha).toBe(head)
  expect(state.lastPublishedRun).toMatchObject({ snapshot: { headSha: head }, freshness: { kind: "stale", observedHead: nextHead } })
  expect(f.control.comments[0]!.body).toContain(`Observed head: ${nextHead}`)
  expect(f.control.comments[0]!.body).toContain(`Covered head: ${head}`)
})

test.each([
  ["base", { baseSha: nextHead }, "base-changed"], ["both", { baseSha: nextHead, headSha: nextHead }, "base-and-head-changed"],
  ["draft", { eligibility: { kind: "skip", reason: "draft" } }, "draft"],
  ["closed", { eligibility: { kind: "skip", reason: "closed" } }, "closed"],
  ["fork", { eligibility: { kind: "skip", reason: "fork" } }, "fork"],
] satisfies [string, Partial<PullRequestCapture>, string][])("post-write %s changes get a deterministic stale annotation", async (_name, changes, reason) => {
  const f = await fixture()
  f.control.captures = [capture(), capture(), capture(changes)]
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "published", freshness: { kind: "stale", reason } })
  expect(f.control.writes).toHaveLength(2)
  expect(parseStateBlock(f.control.comments[0]!.body).lastReport?.snapshot.headSha).toBe(head)
})

test("a stale pre-write capture leaves the existing body byte-identical", async () => {
  const f = await fixture()
  const old = comment(stateFor(runFor(execution("1233"))))
  f.control.comments = [old]
  f.control.captures = [capture(), capture({ headSha: nextHead })]
  const result = await f.publish()
  expect(result.publication).toEqual({ kind: "retained", reason: "stale-before-write" })
  expect(result.exitCode).toBe(0)
  expect(f.control.writes).toHaveLength(0)
  expect(f.control.comments[0]!.body).toBe(old.body)
})

test("uncertain annotation recovery checks exact body rather than only run and result digest", async () => {
  const f = await fixture()
  f.control.captures = [capture(), capture(), capture({ headSha: nextHead })]
  f.control.onWrite = async (_input, persist) => {
    if (f.control.writes.length === 2) return unknownWrite
    return { kind: "confirmed", comment: persist() }
  }
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "published", freshness: { kind: "stale" } })
  expect(f.control.writes.map(({ existingId }) => existingId)).toEqual([null, "501", "501"])
  expect(f.control.writes[2]!.body).toBe(f.control.writes[1]!.body)
  expect(parseStateBlock(f.control.comments[0]!.body).lastPublishedRun.freshness).toMatchObject({ kind: "stale" })
})

test("a committed annotation with a lost response needs no repeat PATCH", async () => {
  const f = await fixture()
  f.control.captures = [capture(), capture(), capture({ headSha: nextHead })]
  f.control.onWrite = async (_input, persist) => {
    const saved = persist()
    return f.control.writes.length === 2 ? unknownWrite : { kind: "confirmed", comment: saved }
  }
  expect((await f.publish()).publication).toMatchObject({ kind: "published", freshness: { kind: "stale" } })
  expect(f.control.writes).toHaveLength(2)
})

test("a newer publication stops an old stale annotation", async () => {
  const f = await fixture()
  f.control.captures = [capture(), capture(), capture({ headSha: nextHead })]
  const newer = comment(stateFor(runFor(execution("1235"))))
  f.control.onList = () => { if (f.control.listCalls === 2) f.control.comments = [newer] }
  const result = await f.publish()
  expect(result.publication).toEqual({ kind: "retained", reason: "older-publication" })
  expect(f.control.writes).toHaveLength(1)
  expect(f.control.comments[0]!.body).toBe(newer.body)
})

test("an unavailable postcheck writes an unconfirmed warning and fails the publish job", async () => {
  const f = await fixture()
  f.control.onCapture = (call) => { if (call === 3) throw new GitHubError("unavailable", "github-unavailable") }
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "failed", failure: { code: "postcheck-unavailable" }, commentId: "501" })
  expect(result.exitCode).toBe(1)
  expect(f.control.writes).toHaveLength(2)
  expect(parseStateBlock(f.control.comments[0]!.body).lastPublishedRun.freshness).toEqual({ kind: "unconfirmed", reason: "postcheck-unavailable" })
})

test("an unavailable warning write keeps the confirmed ID and failure evidence", async () => {
  const f = await fixture()
  f.control.onCapture = (call) => { if (call === 3) throw new GitHubError("unavailable", "github-unavailable") }
  f.control.onWrite = async (_input, persist) => {
    if (f.control.writes.length === 2) throw new GitHubError("forbidden", "github-forbidden", 403)
    return { kind: "confirmed", comment: persist() }
  }
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "failed", failure: { code: "postcheck-unavailable" }, commentId: "501" })
  expect(await readFile(join(result.evidenceDirectory, "publish-result.json"), "utf8")).toContain("postcheck-unavailable")
  expect(parseStateBlock(f.control.comments[0]!.body).lastPublishedRun.freshness).toEqual({ kind: "current" })
})

test("a committed PATCH with a lost response keeps the known target ID", async () => {
  const f = await fixture()
  f.control.comments = [comment(stateFor(runFor(execution("1233"))))]
  f.control.onWrite = async (_input, persist) => { persist(); return unknownWrite }
  expect((await f.publish()).publication).toMatchObject({ kind: "published", commentId: "501" })
  expect(f.control.writes.map(({ existingId }) => existingId)).toEqual(["501"])
})

test("an absent read after a committed unknown PATCH never authorizes a new comment", async () => {
  const f = await fixture()
  f.control.comments = [comment(stateFor(runFor(execution("1233"))), "9")]
  f.control.onWrite = async (_input, persist) => {
    persist()
    f.control.listHidden = 1
    return unknownWrite
  }
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "failed", failure: { code: "comment-write-unknown" }, commentId: "9" })
  expect(result.exitCode).toBe(1)
  expect(f.control.writes.map(({ existingId }) => existingId)).toEqual(["9"])
  expect(f.control.comments.map(({ id }) => String(id))).toEqual(["9"])
  expect(parseStateBlock(f.control.comments[0]!.body).lastPublishedRun.execution.workflowRunId).toBe(execution().workflowRunId)
  f.control.onWrite = null
  expect((await f.publish()).publication).toEqual({ kind: "retained", reason: "already-published" })
  expect(f.control.writes).toHaveLength(1)
})

test("an uncommitted unknown PATCH is repeated only after reading the older canonical state", async () => {
  const f = await fixture()
  f.control.comments = [comment(stateFor(runFor(execution("1233"))))]
  let listedAfterWrite = false
  f.control.onList = () => { if (f.control.writes.length > 0) listedAfterWrite = true }
  f.control.onWrite = async (_input, persist) => {
    if (f.control.writes.length === 1) return unknownWrite
    expect(listedAfterWrite).toBe(true)
    return { kind: "confirmed", comment: persist() }
  }
  expect((await f.publish()).publication).toMatchObject({ kind: "published", commentId: "501" })
  expect(f.control.writes.map(({ existingId }) => existingId)).toEqual(["501", "501"])
})

test("a 404 PATCH takes a fresh list and creates once after canonical deletion", async () => {
  const f = await fixture()
  f.control.comments = [comment(stateFor(runFor(execution("1233"))))]
  f.control.onWrite = async (_input, persist) => {
    if (f.control.writes.length === 1) { f.control.comments = []; throw new GitHubError("deleted", "github-not-found", 404) }
    return { kind: "confirmed", comment: persist() }
  }
  expect((await f.publish()).publication).toMatchObject({ kind: "published", commentId: "501" })
  expect(f.control.writes.map(({ existingId }) => existingId)).toEqual(["501", null])
})

test("write retries share one three-write limit", async () => {
  const f = await fixture()
  f.control.comments = [comment(stateFor(runFor(execution("1233"))))]
  f.control.onWrite = async () => unknownWrite
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "failed", failure: { code: "comment-write-unknown" } })
  expect(f.control.writes).toHaveLength(3)
})

test("wrong and inactive attempts reject without mutation", async () => {
  for (const inactive of [false, true]) {
    const f = await fixture()
    f.control.comments = [comment(stateFor(runFor(execution("1233"))))]
    const original = f.control.comments[0]!.body
    f.control.workflow = inactive ? { ...f.control.workflow, status: "completed" } : { ...f.control.workflow, currentAttempt: execution("1234", 2).attempt }
    const result = await f.publish()
    expect(result.publication).toMatchObject({ kind: "rejected", failure: { code: inactive ? "writer-attempt-inactive" : "attempt-mismatch" } })
    expect(result.exitCode).toBe(1)
    expect(f.control.writes).toHaveLength(0)
    expect(f.control.comments[0]!.body).toBe(original)
  }
})

test("an attempt that becomes inactive at the write boundary cannot mutate", async () => {
  const f = await fixture()
  f.control.onList = () => { f.control.workflow = { ...f.control.workflow, status: "completed" } }
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "rejected", failure: { code: "writer-attempt-inactive" } })
  expect(f.control.writes).toHaveLength(0)
})

test("damaged canonical state never creates a replacement", async () => {
  const f = await fixture()
  const damaged = { ...comment(stateFor(runFor(execution("1233")))), body: `${markerLine(identity)}\nbroken state` }
  f.control.comments = [damaged]
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "rejected", failure: { code: "comment-state-invalid" } })
  expect(result.commentId).toBe(damaged.id)
  expect(f.control.writes).toHaveLength(0)
  expect(f.control.comments).toEqual([damaged])
})

test("duplicates keep the lowest canonical ID and a damaged duplicate never blocks it", async () => {
  const f = await fixture()
  const old = stateFor(runFor(execution("1233")))
  const canonical = comment(old, "9")
  f.control.comments = [comment(old, "100"), { ...comment(old, "11"), body: `${markerLine(identity)}\nbroken` }, canonical]
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "published", commentId: "9" })
  expect(f.control.writes.map(({ existingId }) => existingId)).toEqual(["9"])
  const state = parseStateBlock(f.control.comments.find(({ id }) => id === "9")!.body)
  expect(state.duplicateCommentIds.map(String)).toEqual(["11", "100"])
  expect(f.control.comments.find(({ id }) => id === "11")!.body).toBe(`${markerLine(identity)}\nbroken`)
})

test("a missing artifact publishes a bounded failure note with a null analyzed snapshot and exits one", async () => {
  const f = await fixture("missing")
  f.control.comments = [comment(stateFor(runFor(execution("1233"))))]
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "published", commentId: "501" })
  expect(result.exitCode).toBe(1)
  const state = parseStateBlock(f.control.comments[0]!.body)
  expect(state.lastPublishedRun).toMatchObject({ status: "failed", snapshot: null, failure: { code: "artifact-missing" } })
  expect(String(state.lastReport?.execution.workflowRunId)).toBe("1233")
})

test("a failed admitted review publishes its failure and leaves the publish job red", async () => {
  const f = await fixture("failed")
  f.control.comments = [comment(stateFor(runFor(execution("1233"))))]
  const result = await f.publish()
  expect(result.publication.kind).toBe("published")
  expect(result.exitCode).toBe(1)
  expect(String(parseStateBlock(f.control.comments[0]!.body).lastReport?.execution.workflowRunId)).toBe("1233")
})

test("a partial report without infrastructure errors remains advisory", async () => {
  const f = await fixture("partial")
  const result = await f.publish()
  expect(result.publication.kind).toBe("published")
  expect(result.exitCode).toBe(0)
  expect(f.control.comments[0]!.body).toContain("Partial review. No verified findings in the completed work.")
})

test("a matching skip note publishes without claiming its retained report is current", async () => {
  const f = await fixture("skipped")
  f.control.captures = [capture({ eligibility: { kind: "skip", reason: "draft" } })]
  f.control.comments = [comment(stateFor(runFor(execution("1233"))))]
  const result = await f.publish()
  expect(result.exitCode).toBe(0)
  expect(result.publication.kind).toBe("published")
  expect(f.control.comments[0]!.body).toContain("This run did not review the current PR.")
  expect(f.control.comments[0]!.body).toContain("Last usable report")
})

test("corrupt downloaded bytes reject without changing the existing comment", async () => {
  const f = await fixture()
  const previous = comment(stateFor(runFor(execution("1233"))))
  f.control.comments = [previous]
  await writeFile(join(f.command.packageDirectory, "review-result.json"), "{}\n")
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "rejected", failure: { code: "artifact-invalid" } })
  expect(f.control.writes).toHaveLength(0)
  expect(f.control.comments[0]!.body).toBe(previous.body)
})

test("the public dispatcher parses publish, shares its budget, and emits exactly one JSON result", async () => {
  const f = await fixture()
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await dispatchCommand(["publish", "--repository", identity.repository, "--pr", "17", "--package", f.command.packageDirectory, "--review-job-result", "success"], {
    env: {}, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
    publishDependencies: async (command, budget) => { expect(command).toEqual(f.command); expect(budget.remainingMs()).toBeLessThanOrEqual(120_000); return { ...f.deps, budget } },
  })
  expect(code).toBe(0)
  expect(stdout).toHaveLength(1)
  expect(stdout[0]!.split("\n")).toHaveLength(1)
  const summary = JSON.parse(stdout[0]!)
  temporaryPaths.push(summary.evidenceDirectory)
  expect(summary).toMatchObject({ publication: { kind: "published", commentId: "501" }, exitCode: 0 })
  expect(stderr).toEqual([])
})

test("publish rejects mixed public flags and cannot accept workflow or test state flags", () => {
  for (const extra of ["--out", "--config", "--repo", "--run-id", "--attempt", "--endpoint", "--state", "--fault"]) expect(() => parseCommand([
    "publish", "--repository", identity.repository, "--pr", "17", "--package", "/tmp/handoff", "--review-job-result", "success", extra, "x",
  ])).toThrow()
})

test("product identity comes only from fixed Action context and installed source", async () => {
  const directory = join(import.meta.dir, "..")
  const result = await readProductIdentity({ REVIEW_PRODUCT_COMMIT: productCommit, REVIEW_PRODUCT_DIRECTORY: directory, GITHUB_ACTION_PATH: directory })
  expect(result.productCommit).toBe(productCommit)
  expect(result.programHash).toBe(await hashProductSources())
  await expect(readProductIdentity({ REVIEW_PRODUCT_COMMIT: "main", REVIEW_PRODUCT_DIRECTORY: directory, GITHUB_ACTION_PATH: directory })).rejects.toThrow("fixed Action commit")
  await expect(readProductIdentity({ REVIEW_PRODUCT_COMMIT: productCommit, REVIEW_PRODUCT_DIRECTORY: tmpdir(), GITHUB_ACTION_PATH: directory })).rejects.toThrow("installed product")
  await expect(readProductIdentity({ REVIEW_PRODUCT_COMMIT: productCommit })).rejects.toThrow("fixed Action commit")
})

test("an already published H1 still receives a stale annotation after an H2 push", async () => {
  const f = await fixture()
  await f.publish()
  f.control.captures = [capture({ headSha: nextHead })]
  const result = await f.publish()
  expect(result.publication).toEqual({ kind: "retained", reason: "already-published" })
  expect(f.control.writes.map(({ existingId }) => existingId)).toEqual([null, "501"])
  expect(parseStateBlock(f.control.comments[0]!.body).lastPublishedRun.freshness).toMatchObject({ kind: "stale", observedHead: nextHead })
})

test("a recovered postcheck can replace an unconfirmed warning for the same publication", async () => {
  const f = await fixture()
  f.control.onCapture = (call) => { if (call === 3) throw new GitHubError("unavailable", "github-unavailable") }
  expect((await f.publish()).exitCode).toBe(1)
  expect(parseStateBlock(f.control.comments[0]!.body).lastPublishedRun.freshness.kind).toBe("unconfirmed")
  f.control.onCapture = null
  const result = await f.publish()
  expect(result.publication).toEqual({ kind: "retained", reason: "already-published" })
  expect(result.exitCode).toBe(0)
  expect(parseStateBlock(f.control.comments[0]!.body).lastPublishedRun.freshness.kind).toBe("current")
})

test("publication evidence records separate report and annotation write intents after an uncertain POST", async () => {
  const f = await fixture()
  f.control.captures = [capture(), capture(), capture({ headSha: nextHead })]
  f.control.onWrite = async (_input, persist) => {
    const saved = persist()
    return f.control.writes.length === 1 ? unknownWrite : { kind: "confirmed", comment: saved }
  }
  const result = await f.publish()
  const evidence = JSON.parse(await readFile(join(result.evidenceDirectory, "publish-result.json"), "utf8"))
  expect(evidence.writeIntents.map((intent: { kind: string }) => intent.kind)).toEqual(["report", "annotation"])
  expect(evidence.uncertainCreateBodyDigest).toBe(createHash("sha256").update(f.control.writes[0]!.body).digest("hex"))
  expect(evidence.intendedBodyDigest).toBe(createHash("sha256").update(f.control.writes[1]!.body).digest("hex"))
})

test("unknown initial and annotation PATCH writes share the three-write allowance", async () => {
  const f = await fixture()
  f.control.comments = [comment(stateFor(runFor(execution("1233"))))]
  f.control.captures = [capture(), capture(), capture(), capture({ headSha: nextHead })]
  f.control.onWrite = async (_input, persist) => {
    if (f.control.writes.length === 1 || f.control.writes.length === 3) return unknownWrite
    return { kind: "confirmed", comment: persist() }
  }
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "failed", failure: { code: "comment-write-unknown" } })
  expect(f.control.writes).toHaveLength(3)
  expect(f.control.writes[2]!.body).toContain("Stale review")
})

test("failed canonical state is saved as bounded diagnostic bytes without a replacement write", async () => {
  const f = await fixture()
  const body = `${markerLine(identity)}\n${"😀".repeat(20_000)}`
  f.control.comments = [{ ...comment(stateFor()), body }]
  const result = await f.publish()
  const evidence = JSON.parse(await readFile(join(result.evidenceDirectory, "publish-result.json"), "utf8"))
  expect(result.publication).toMatchObject({ kind: "rejected", failure: { code: "comment-state-invalid" } })
  expect(Buffer.byteLength(evidence.previousComment.body)).toBeLessThanOrEqual(60_000)
  expect(evidence.previousComment.truncated).toBe(true)
  expect(evidence.previousComment.body).not.toContain("�")
  expect(f.control.writes).toHaveLength(0)
})

test("evidence and public failure summaries redact known secrets and preserve valid JSON", async () => {
  const f = await fixture()
  const savedToken = process.env.GITHUB_TOKEN
  const sentinel = 'credential-with-"quotes"-and-\\slashes'
  process.env.GITHUB_TOKEN = sentinel
  try {
    f.control.onList = () => { throw new GitHubError(`read ${sentinel}\n::warning::failed`, "github-unavailable") }
    const result = await f.publish()
    const evidence = await readFile(join(result.evidenceDirectory, "publish-result.json"), "utf8")
    expect(JSON.stringify(result)).not.toContain(JSON.stringify(sentinel).slice(1, -1))
    expect(evidence).not.toContain(JSON.stringify(sentinel).slice(1, -1))
    expect(evidence).toContain("[redacted]")
    expect(evidence).not.toContain("::warning::")
    expect(() => JSON.parse(evidence)).not.toThrow()
    expect(Buffer.byteLength(evidence)).toBeLessThanOrEqual(1_048_576)
  } finally {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = savedToken
  }
})

test("the Actions summary reports canonical, duplicate, and human marker IDs", async () => {
  const f = await fixture()
  const directory = await mkdtemp(join(tmpdir(), "ai-code-review-publish-summary-"))
  temporaryPaths.push(directory)
  const summaryPath = join(directory, "summary.md")
  const originalPath = process.env.GITHUB_STEP_SUMMARY
  process.env.GITHUB_STEP_SUMMARY = summaryPath
  const originalRead = f.deps.github.readProductComment
  f.deps.github.readProductComment = async (input) => {
    const observed = await originalRead(input)
    return { ...observed, humanMarkerIds: ["404"] }
  }
  f.control.comments = [comment(stateFor(runFor(execution("1233"))), "9"), comment(stateFor(runFor(execution("1233"))), "10")]
  try {
    await f.publish()
    const summary = await readFile(summaryPath, "utf8")
    expect(summary).toContain("Comment ID: 9.")
    expect(summary).toContain("Duplicate bot comments: 10.")
    expect(summary).toContain("Human marker copies: 404.")
  } finally {
    if (originalPath === undefined) delete process.env.GITHUB_STEP_SUMMARY
    else process.env.GITHUB_STEP_SUMMARY = originalPath
  }
})


test("paginated HTTP reconciliation recovers the bot comment committed before a lost POST response", async () => {
  const f = await fixture()
  const rawComments: { id: number; body: string }[] = []
  const calls: { url: string; method: string }[] = []
  const api = "https://api.github.com/repos/owner/repo"
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    calls.push({ url, method })
    if (method === "POST" && url === `${api}/issues/17/comments`) {
      const body = JSON.parse(String(init?.body)).body
      rawComments.push({ id: 501, body })
      throw new Error("ECONNRESET after comment commit")
    }
    if (method === "GET" && url === `${api}/issues/17/comments?per_page=100&page=1`) return Response.json(Array.from({ length: 100 }, (_, i) => ({
      id: i + 1, body: "discussion", created_at: time, updated_at: time, user: { id: 1, login: "human", type: "User" },
    })))
    if (method === "GET" && url === `${api}/issues/17/comments?per_page=100&page=2`) return Response.json(rawComments.map((entry) => ({
      ...entry, created_at: time, updated_at: time, user: { id: 41898282, login: "github-actions[bot]", type: "Bot" }, issue_url: `${api}/issues/17`,
    })))
    throw new Error(`unexpected fake transport call ${method} ${url}`)
  }
  const adapter = createGitHubPublisher({ GITHUB_TOKEN: "test-only-token" }, { fetch: fetchImpl })
  f.deps.github = { ...f.deps.github, readProductComment: adapter.readProductComment, writeComment: adapter.writeComment }
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "published", commentId: "501" })
  expect(rawComments).toHaveLength(1)
  expect(calls.filter(({ method }) => method === "POST")).toHaveLength(1)
  expect(calls.filter(({ method }) => method === "PATCH")).toHaveLength(0)
  expect(calls.filter(({ method }) => method === "GET").map(({ url }) => url)).toEqual([
    `${api}/issues/17/comments?per_page=100&page=1`, `${api}/issues/17/comments?per_page=100&page=2`,
    `${api}/issues/17/comments?per_page=100&page=1`, `${api}/issues/17/comments?per_page=100&page=2`,
  ])
  expect(parseStateBlock(rawComments[0]!.body).lastReport?.snapshot.headSha).toBe(head)
  expect((await f.publish()).publication).toEqual({ kind: "retained", reason: "already-published" })
  expect(rawComments).toHaveLength(1)
  expect(calls.filter(({ method }) => method === "POST")).toHaveLength(1)
})

test("an older H1 run cannot replace a newer usable H2 publication", async () => {
  const f = await fixture()
  const newer = stateFor(runFor(execution("1235")))
  newer.lastReport!.snapshot.headSha = nextHead
  newer.lastPublishedRun.snapshot!.headSha = nextHead
  const original = comment(newer)
  f.control.comments = [original]
  f.control.captures = [capture({ headSha: nextHead })]
  const result = await f.publish()
  expect(result.publication).toEqual({ kind: "retained", reason: "older-publication" })
  expect(f.control.writes).toHaveLength(0)
  expect(f.control.comments[0]!.body).toBe(original.body)
})


test("an admitted finding renders one bounded summary with validated source links and no excerpt block", async () => {
  const f = await fixture("findings")
  const result = await f.publish()
  expect(result.exitCode).toBe(0)
  const body = f.control.comments[0]!.body
  const saved = parseStateBlock(body).lastReport!
  expect(saved.issues).toHaveLength(1)
  expect(saved.issues[0]!.trigger).toBe(`${"t".repeat(239)}…`)
  expect(saved.issues[0]!.verification).toBe(`${"v".repeat(239)}…`)
  expect(saved.issues[0]!.summarized).toBe(true)
  expect(saved.summarized).toBe(true)
  expect(body).toContain(`/blob/${head}/src/Example.java#L1-L1`)
  expect(body).not.toContain("return null;")
})

test("a usable partial caused by timeout publishes its report and exits one", async () => {
  const f = await fixture("partial-timeout")
  const result = await f.publish()
  expect(result.publication.kind).toBe("published")
  expect(result.exitCode).toBe(1)
  expect(parseStateBlock(f.control.comments[0]!.body).lastReport?.status).toBe("partial")
})

test("adoption by run identity PATCHes the intended body without another POST", async () => {
  const f = await fixture()
  f.control.onWrite = async (_input, persist) => {
    const saved = persist()
    if (f.control.writes.length === 1) {
      f.control.comments[0] = { ...saved, body: saved.body.replace("## AI code review", "## AI code review\nExtra visible detail") }
      return unknownWrite
    }
    return { kind: "confirmed", comment: saved }
  }
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "published", commentId: "501" })
  expect(f.control.writes.map(({ existingId }) => existingId)).toEqual([null, "501"])
  expect(f.control.comments[0]!.body).toBe(f.control.writes[0]!.body)
})

test("a newer publication stops recovery of an uncertain older PATCH", async () => {
  const f = await fixture()
  f.control.comments = [comment(stateFor(runFor(execution("1233"))))]
  const newer = comment(stateFor(runFor(execution("1235"))))
  f.control.onWrite = async () => unknownWrite
  f.control.onList = () => { if (f.control.listCalls === 2) f.control.comments = [newer] }
  const result = await f.publish()
  expect(result.publication).toEqual({ kind: "retained", reason: "older-publication" })
  expect(f.control.writes).toHaveLength(1)
  expect(f.control.comments[0]!.body).toBe(newer.body)
})

test("a write barrier permits an H2 push after the final precheck and produces a stale H1 annotation", async () => {
  const f = await fixture()
  let release = () => {}
  let reached = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const atWrite = new Promise<void>((resolve) => { reached = resolve })
  f.control.onWrite = async (_input, persist) => {
    if (f.control.writes.length === 1) { reached(); await gate }
    return { kind: "confirmed", comment: persist() }
  }
  const pending = f.publish()
  await atWrite
  f.control.captures = [capture({ headSha: nextHead })]
  release()
  const result = await pending
  expect(result.publication).toMatchObject({ kind: "published", freshness: { kind: "stale", observedHead: nextHead } })
  expect(f.control.writes).toHaveLength(2)
  const finalState = parseStateBlock(f.control.comments[0]!.body)
  expect(finalState.lastReport?.snapshot.headSha).toBe(head)
  expect(finalState.lastPublishedRun.freshness).toMatchObject({ kind: "stale", observedHead: nextHead })
})

test("a committed third write with a lost response is confirmed by its subsequent read", async () => {
  const f = await fixture()
  f.control.comments = [comment(stateFor(runFor(execution("1233"))))]
  f.control.captures = [capture(), capture(), capture(), capture({ headSha: nextHead })]
  f.control.onWrite = async (_input, persist) => {
    if (f.control.writes.length === 1) return unknownWrite
    const saved = persist()
    return f.control.writes.length === 3 ? unknownWrite : { kind: "confirmed", comment: saved }
  }
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "published", freshness: { kind: "stale", observedHead: nextHead } })
  expect(f.control.writes).toHaveLength(3)
})

test("an uncaptured skip cannot claim that current SHAs match its capture", () => {
  const run = runFor(execution(), { kind: "skipped", reason: "draft", snapshot: null })
  run.captured = null
  const input = pureInput(run)
  input.current.eligibility = { kind: "skip", reason: "draft" }
  expect(decidePublish(input)).toMatchObject({ kind: "retain", reason: "stale-before-write" })
})


test("unexpected minimal-state overflow fails before a write and preserves the prior report", async () => {
  const f = await fixture("failed", "\u0000".repeat(2_000))
  const prior = stateFor(runFor(execution("1233")))
  prior.lastReport!.completedAt = `2026-11-21T10:00:00.${"0".repeat(6_000)}Z`
  const original = comment(prior)
  f.control.comments = [original]
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "rejected", failure: { code: "comment-write" } })
  expect(result.exitCode).toBe(1)
  expect(f.control.writes).toHaveLength(0)
  expect(f.control.comments[0]!.body).toBe(original.body)
  expect(parseStateBlock(original.body).lastReport).toEqual(prior.lastReport)
})

test.each(["failed", "skipped"] as const)("a %s publication cannot shrink a retained Unicode report to fit new metadata", async (kind) => {
  const f = await fixture(kind, "x".repeat(1_931))
  const prior = stateFor(runFor(execution("1233")))
  prior.lastReport!.issues = Array.from({ length: 5 }, (_, index) => ({
    ordinal: index + 1, trigger: "界".repeat(240), consequence: "界".repeat(240), rootCause: "界".repeat(240), verification: "界".repeat(240),
    location: { kind: "inline", side: "head", path: "src/Example.java", startLine: 1, endLine: 1 }, summarized: false,
  }))
  const original = comment(prior, "9")
  const retained = parseStateBlock(original.body).lastReport
  expect(retained!.issues.some((issue) => issue.verification.length === 240)).toBe(true)
  f.control.comments = [original]
  if (kind === "skipped") {
    f.control.captures = [capture({ eligibility: { kind: "skip", reason: "draft" } })]
    f.control.comments.push(...Array.from({ length: 20 }, (_, index) => ({ ...original, id: commentIdSchema.parse(`999999999999999999${String(index).padStart(2, "0")}`) })))
  }
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "rejected", failure: { code: "comment-write" } })
  expect(result.exitCode).toBe(1)
  expect(f.control.writes).toHaveLength(0)
  expect(f.control.comments[0]!.body).toBe(original.body)
  expect(parseStateBlock(f.control.comments[0]!.body).lastReport).toEqual(retained)
})

test("the shared publish budget blocks every write once the clock reaches its deadline", async () => {
  const f = await fixture()
  let elapsed = 0
  f.deps.budget = createBudget({ monotonicMs: () => elapsed, wallTime: () => time, sleep: async () => {} }, 120_000)
  f.control.onList = () => { elapsed = 120_000 }
  const result = await f.publish()
  expect(result.publication).toMatchObject({ kind: "failed", failure: { code: "github-unavailable" } })
  expect(result.exitCode).toBe(1)
  expect(f.control.writes).toHaveLength(0)
})
