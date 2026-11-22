import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBudget, systemClock } from "./budget"
import { GitHubError, type GitHubReader } from "./github"
import { digestSchema, gitShaSchema, runIdSchema } from "./identity"
import { actionsExecutionSchema, identitySchema, prOutcomeSchema, type PullRequestIdentity } from "./pr-contracts"
import { hashProductSources, hashPromptTemplates } from "./product-identity"
import {
  admitHandoff, backupReceiptSchema, HANDOFF_MANIFEST_BYTE_LIMIT, HANDOFF_RESULT_BYTE_LIMIT, modelRecordSchema,
  resultReceiptSchema, reviewResultFileSchema, runManifestFileSchema, serializeHandoffFile, validateHandoffRecords,
  writePrHandoff, type ExpectedPublication, type PrHandoffInput,
} from "./handoff"

const sha = "a".repeat(40)
const hex64 = (char: string) => char.repeat(64)
const instant = "2026-11-21T10:00:00.000Z"
const maxInstant = "2026-11-21T23:59:59.999999999+14:00"
const identity = { repositoryId: "123456789", repository: "PulseInjector/java-review", pr: 17 }
const runId = "9".repeat(20)
const actionsRunId = `gh-${runId}-1000000`
const rawActionsExecution = {
  kind: "actions",
  reviewRunId: actionsRunId,
  workflowRunId: runId,
  attempt: 1_000_000,
  trigger: { kind: "pull-request", action: "opened" },
  triggeredAt: instant,
  startedAt: instant,
  runUrl: `https://github.com/PulseInjector/java-review/actions/runs/${runId}`,
}
const rawLocalExecution = {
  kind: "local",
  reviewRunId: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f",
  trigger: { kind: "local" },
  triggeredAt: instant,
  startedAt: instant,
}
const versions = { program: hex64("b"), sdk: "2.2.7", config: hex64("f"), discoverPrompt: hex64("c"), verifyPrompt: hex64("d") }
const reviewedResult = (overrides: Record<string, unknown> = {}) => ({
  runId: actionsRunId,
  snapshot: { baseSha: sha, headSha: sha, mergeBaseSha: sha },
  status: "complete",
  issues: [],
  coverage: { includedPaths: ["src/OrderService.java"], omittedPaths: [], unverifiedCandidateIds: [], unpublishedCandidateIds: [], notes: [] },
  stageErrors: [],
  usage: { kind: "known", inputTokens: 10, outputTokens: 20 },
  versions,
  durationMs: 25,
  ...overrides,
})
const rawResultFile = (outcome: Record<string, unknown> = { kind: "reviewed", result: reviewedResult() }) => ({
  schemaVersion: 1,
  identity,
  execution: rawActionsExecution,
  captured: { baseSha: sha, headSha: sha, mergeBaseSha: sha, observedAt: instant },
  outcome,
  backup: { kind: "captured", commentId: "9".repeat(20), bodyDigest: hex64("1"), updatedAt: instant },
  completedAt: instant,
})
const rawManifest = {
  schemaVersion: 1,
  identity,
  execution: rawActionsExecution,
  captured: { baseSha: sha, headSha: sha, mergeBaseSha: sha, observedAt: instant },
  versions: {
    productCommit: sha, programHash: hex64("b"), bun: "1.4.4", sdk: "2.2.7", plugin: "2.2.7",
    discoverPrompt: hex64("c"), verifyPrompt: hex64("d"),
  },
  config: { kind: "base-blob", path: "review.config.json", sourceSha: sha, sourceDigest: hex64("e"), effectiveDigest: hex64("f") },
  model: { providerId: "openai", modelId: "gpt-test" },
  result: { name: "review-result.json", bytes: 2_048, sha256: hex64("0") },
  artifactName: `ai-code-review-handoff-${runId}-1000000`,
  replayArtifactName: `ai-code-review-replay-${runId}-1000000`,
  completedAt: instant,
}
const parsedResult = (outcome?: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
  reviewResultFileSchema.parse({ ...rawResultFile(outcome), ...overrides })
const parsedManifest = (overrides: Record<string, unknown> = {}) =>
  runManifestFileSchema.parse({ ...rawManifest, ...overrides })
const codes = (violations: ReturnType<typeof validateHandoffRecords>) => violations.map(({ code }) => code)

test("the canonical serialization round trips byte for byte", () => {
  const resultBytes = serializeHandoffFile(parsedResult())
  expect(resultBytes.endsWith("\n")).toBe(true)
  expect(resultBytes.includes("\r")).toBe(false)
  expect(resultBytes.includes('\n  "identity"')).toBe(true)
  expect(serializeHandoffFile(reviewResultFileSchema.parse(JSON.parse(resultBytes)))).toBe(resultBytes)
  const manifestBytes = serializeHandoffFile(parsedManifest())
  expect(serializeHandoffFile(runManifestFileSchema.parse(JSON.parse(manifestBytes)))).toBe(manifestBytes)
})

test("a canonical multibyte result file serializes to pinned exact bytes", () => {
  const file = reviewResultFileSchema.parse({
    schemaVersion: 1,
    identity,
    execution: rawActionsExecution,
    captured: null,
    outcome: {
      kind: "failed",
      failure: { code: "model-refusal", stage: "verification", message: "検証セッションが中断されました" },
      snapshot: null,
    },
    backup: { kind: "absent" },
    completedAt: instant,
  })
  const bytes = serializeHandoffFile(file)
  expect(bytes).toBe(`{
  "schemaVersion": 1,
  "identity": {
    "repositoryId": "123456789",
    "repository": "PulseInjector/java-review",
    "pr": 17
  },
  "execution": {
    "kind": "actions",
    "reviewRunId": "gh-99999999999999999999-1000000",
    "workflowRunId": "99999999999999999999",
    "attempt": 1000000,
    "trigger": {
      "kind": "pull-request",
      "action": "opened"
    },
    "triggeredAt": "2026-11-21T10:00:00.000Z",
    "startedAt": "2026-11-21T10:00:00.000Z",
    "runUrl": "https://github.com/PulseInjector/java-review/actions/runs/99999999999999999999"
  },
  "captured": null,
  "outcome": {
    "kind": "failed",
    "failure": {
      "code": "model-refusal",
      "stage": "verification",
      "message": "検証セッションが中断されました"
    },
    "snapshot": null
  },
  "backup": {
    "kind": "absent"
  },
  "completedAt": "2026-11-21T10:00:00.000Z"
}
`)
  expect(Buffer.byteLength(bytes, "utf8")).toBe(892)
})

const maxIdentity = { repositoryId: "9".repeat(20), repository: `${"o".repeat(39)}/${"n".repeat(100)}`, pr: 2_147_483_647 }
const maxExecution = { ...rawActionsExecution, triggeredAt: maxInstant, startedAt: maxInstant }
const maxCaptured = { baseSha: sha, headSha: sha, mergeBaseSha: sha, observedAt: maxInstant }

test("a maximum reviewed result file stays inside the 512 KiB result cap with a real receipt", () => {
  const maxReference = { side: "head", path: "p".repeat(1_024), startLine: 1, endLine: 1, excerpt: "x".repeat(500) }
  const issues = Array.from({ length: 5 }, (_, index) => {
    const id = `C-${index}-${"i".repeat(60)}`
    const candidate = {
      id,
      changeLocation: maxReference,
      trigger: "t".repeat(2_000),
      consequence: "c".repeat(2_000),
      rootCause: "r".repeat(2_000),
      citations: Array.from({ length: 12 }, () => maxReference),
    }
    return { candidate, verification: { candidateId: id, decision: "keep", reason: "v".repeat(2_000), evidence: Array.from({ length: 12 }, () => maxReference) } }
  })
  const file = reviewResultFileSchema.parse({
    ...rawResultFile({ kind: "reviewed", result: reviewedResult({ issues }) }),
    identity: maxIdentity,
    execution: maxExecution,
    captured: maxCaptured,
    backup: { kind: "captured", commentId: "9".repeat(20), bodyDigest: hex64("1"), updatedAt: maxInstant },
    completedAt: maxInstant,
  })
  const text = serializeHandoffFile(file)
  const bytes = Buffer.byteLength(text, "utf8")
  expect(bytes).toBeGreaterThan(200_000)
  expect(bytes).toBeLessThanOrEqual(HANDOFF_RESULT_BYTE_LIMIT)
  const manifest = runManifestFileSchema.parse({
    ...rawManifest,
    identity: maxIdentity,
    execution: maxExecution,
    captured: maxCaptured,
    result: { name: "review-result.json", bytes, sha256: createHash("sha256").update(text).digest("hex") },
    completedAt: maxInstant,
  })
  expect(validateHandoffRecords(file, manifest)).toEqual([])
})

test("a maximum multibyte reviewed result stays inside the 512 KiB result cap", () => {
  const maxReference = { side: "head", path: "p".repeat(1_024), startLine: 1, endLine: 1, excerpt: "あ".repeat(500) }
  const issues = Array.from({ length: 5 }, (_, index) => {
    const id = `C-${index}-${"i".repeat(60)}`
    const candidate = {
      id,
      changeLocation: maxReference,
      trigger: "と".repeat(2_000),
      consequence: "こ".repeat(2_000),
      rootCause: "る".repeat(2_000),
      citations: Array.from({ length: 12 }, () => maxReference),
    }
    return { candidate, verification: { candidateId: id, decision: "keep", reason: "け".repeat(2_000), evidence: Array.from({ length: 12 }, () => maxReference) } }
  })
  const file = reviewResultFileSchema.parse({
    ...rawResultFile({ kind: "reviewed", result: reviewedResult({ issues }) }),
    identity: maxIdentity,
    execution: maxExecution,
    captured: maxCaptured,
    completedAt: maxInstant,
  })
  const bytes = Buffer.byteLength(serializeHandoffFile(file), "utf8")
  expect(bytes).toBeGreaterThan(400_000)
  expect(bytes).toBeLessThanOrEqual(HANDOFF_RESULT_BYTE_LIMIT)
})

test("a schema-valid result can serialize beyond the 512 KiB result cap", () => {
  // The bounded artifact-write fallback implemented at checkpoint 4 owns this case: it writes an
  // artifact-write failure envelope without issues and leaves the oversized original in replay.
  // This test pins only that the wire schema admits the oversized result.
  const notes = Array.from({ length: 128 }, () => "注".repeat(2_000))
  const file = reviewResultFileSchema.parse(rawResultFile({
    kind: "reviewed",
    result: reviewedResult({ status: "partial", coverage: { includedPaths: [], omittedPaths: [], unverifiedCandidateIds: [], unpublishedCandidateIds: [], notes } }),
  }))
  const bytes = Buffer.byteLength(serializeHandoffFile(file), "utf8")
  expect(bytes).toBeGreaterThan(HANDOFF_RESULT_BYTE_LIMIT)
})

test("a maximum failure envelope with the longest failure message stays inside the result cap", () => {
  const file = reviewResultFileSchema.parse(rawResultFile({
    kind: "failed",
    failure: { code: "github-unavailable", stage: "capture", message: "x".repeat(2_000) },
    snapshot: { baseSha: sha, headSha: sha, mergeBaseSha: sha },
  }))
  expect(Buffer.byteLength(serializeHandoffFile(file), "utf8")).toBeLessThanOrEqual(HANDOFF_RESULT_BYTE_LIMIT)
})

test("a maximum manifest stays inside the 32 KiB manifest cap", () => {
  const manifest = runManifestFileSchema.parse({
    ...rawManifest,
    identity: { repositoryId: "9".repeat(20), repository: `${"o".repeat(39)}/${"n".repeat(100)}`, pr: 2_147_483_647 },
    execution: { ...rawActionsExecution, triggeredAt: maxInstant, startedAt: maxInstant },
    captured: { baseSha: sha, headSha: sha, mergeBaseSha: sha, observedAt: maxInstant },
    config: { ...rawManifest.config, path: "c".repeat(1_024) },
    model: { providerId: "m".repeat(64), modelId: "g".repeat(256) },
    result: { name: "review-result.json", bytes: HANDOFF_RESULT_BYTE_LIMIT, sha256: hex64("0") },
    completedAt: maxInstant,
  })
  const bytes = Buffer.byteLength(serializeHandoffFile(manifest), "utf8")
  expect(bytes).toBeGreaterThan(2_000)
  expect(bytes).toBeLessThanOrEqual(HANDOFF_MANIFEST_BYTE_LIMIT)
})

test("the wire schemas reject unknown versions, extra fields, and oversized receipts", () => {
  expect(() => reviewResultFileSchema.parse({ ...rawResultFile(), schemaVersion: 2 })).toThrow()
  expect(() => reviewResultFileSchema.parse({ ...rawResultFile(), extra: true })).toThrow()
  expect(() => runManifestFileSchema.parse({ ...rawManifest, schemaVersion: 0 })).toThrow()
  expect(() => runManifestFileSchema.parse({ ...rawManifest, result: { ...rawManifest.result, bytes: HANDOFF_RESULT_BYTE_LIMIT + 1 } })).toThrow()
  expect(resultReceiptSchema.parse({ name: "review-result.json", bytes: HANDOFF_RESULT_BYTE_LIMIT, sha256: hex64("0") }).bytes).toBe(HANDOFF_RESULT_BYTE_LIMIT)
})

test("artifact names follow the exact run and attempt pattern", () => {
  expect(() => runManifestFileSchema.parse({ ...rawManifest, artifactName: `ai-code-review-handoff-0${runId}-1000000` })).toThrow()
  expect(() => runManifestFileSchema.parse({ ...rawManifest, artifactName: `ai-code-review-replay-${runId}-1000000` })).toThrow()
  expect(() => runManifestFileSchema.parse({ ...rawManifest, replayArtifactName: `ai-code-review-handoff-${runId}-1000000` })).toThrow()
})

test("the model record captures configured identity, not usage", () => {
  expect(modelRecordSchema.parse({ providerId: "openai", modelId: " gpt-x " }).modelId).toBe("gpt-x")
  expect(() => modelRecordSchema.parse({ providerId: "openai", modelId: "gpt-x", inputTokens: 10 })).toThrow()
  expect(() => modelRecordSchema.parse({ providerId: "-openai", modelId: "gpt-x" })).toThrow()
})

test("backup receipts carry comment identity or an admission failure code", () => {
  expect(backupReceiptSchema.parse({ kind: "absent" }).kind).toBe("absent")
  expect(() => backupReceiptSchema.parse({ kind: "captured", commentId: "0", bodyDigest: hex64("1"), updatedAt: instant })).toThrow()
  expect(() => backupReceiptSchema.parse({ kind: "unavailable", code: "model-crashed" })).toThrow()
})

test("a consistent reviewed pair admits with no violations", () => {
  expect(validateHandoffRecords(parsedResult(), parsedManifest())).toEqual([])
})

test("record mismatches between result and manifest are rejected with admission codes", () => {
  const result = parsedResult()
  expect(codes(validateHandoffRecords(result, parsedManifest({ identity: { ...identity, pr: 18 } })))).toContain("identity-mismatch")
  expect(codes(validateHandoffRecords(result, parsedManifest({ execution: { ...rawActionsExecution, attempt: 2, reviewRunId: `gh-${runId}-2` } })))).toContain("attempt-mismatch")
  expect(codes(validateHandoffRecords(result, parsedManifest({ captured: { ...rawManifest.captured, observedAt: "2026-11-21T10:00:01.000Z" } })))).toContain("artifact-invalid")
  expect(codes(validateHandoffRecords(result, parsedManifest({ completedAt: "2026-11-21T10:00:01.000Z" })))).toContain("artifact-invalid")
})

test("a reviewed outcome requires a configuration record, a merge base, and, for Actions, a model record", () => {
  const result = parsedResult()
  expect(codes(validateHandoffRecords(result, parsedManifest({ config: null })))).toContain("artifact-invalid")
  expect(codes(validateHandoffRecords(result, parsedManifest({ model: null })))).toContain("artifact-invalid")
  expect(codes(validateHandoffRecords(result, parsedManifest({ captured: { ...rawManifest.captured, mergeBaseSha: null } })))).toContain("artifact-invalid")
})

test("an Actions manifest requires a model record whatever the outcome", () => {
  const failed = parsedResult({
    kind: "failed",
    failure: { code: "model-auth", stage: "verification", message: "the model rejected the key" },
    snapshot: null,
  })
  expect(codes(validateHandoffRecords(failed, parsedManifest({ model: null })))).toContain("artifact-invalid")
})

test("reviewed versions must equal the manifest provenance", () => {
  const result = parsedResult()
  expect(codes(validateHandoffRecords(result, parsedManifest({ versions: { ...rawManifest.versions, programHash: hex64("a") } })))).toContain("artifact-provenance")
  expect(codes(validateHandoffRecords(result, parsedManifest({ versions: { ...rawManifest.versions, discoverPrompt: hex64("a") } })))).toContain("artifact-provenance")
  expect(codes(validateHandoffRecords(result, parsedManifest({ config: { ...rawManifest.config, effectiveDigest: hex64("a") } })))).toContain("artifact-provenance")
  const mismatchedSdk = parsedResult({ kind: "reviewed", result: reviewedResult({ versions: { ...versions, sdk: "2.3.0" } }) })
  expect(codes(validateHandoffRecords(mismatchedSdk, parsedManifest()))).toContain("artifact-provenance")
})

test("reviewed result run identity must equal the execution review run ID", () => {
  const result = parsedResult({ kind: "reviewed", result: reviewedResult({ runId: `gh-${"8".repeat(20)}-1000000` }) })
  expect(codes(validateHandoffRecords(result, parsedManifest()))).toContain("identity-mismatch")
})

test("artifact names derive from the exact workflow run ID and attempt", () => {
  const result = parsedResult()
  expect(codes(validateHandoffRecords(result, parsedManifest({ artifactName: `ai-code-review-handoff-${"8".repeat(20)}-1000000` })))).toContain("artifact-invalid")
  expect(codes(validateHandoffRecords(result, parsedManifest({ replayArtifactName: `ai-code-review-replay-${"8".repeat(20)}-1000000` })))).toContain("artifact-invalid")
})

test("local manifests keep null artifact names", () => {
  const localResult = parsedResult({ kind: "reviewed", result: reviewedResult({ runId: rawLocalExecution.reviewRunId }) }, { execution: rawLocalExecution })
  const localManifest = parsedManifest({ execution: rawLocalExecution, artifactName: null, replayArtifactName: null })
  expect(validateHandoffRecords(localResult, localManifest)).toEqual([])
  expect(codes(validateHandoffRecords(localResult, parsedManifest({ execution: rawLocalExecution })))).toContain("artifact-invalid")
})

test("a local manifest may carry a null model record", () => {
  const localResult = parsedResult({ kind: "reviewed", result: reviewedResult({ runId: rawLocalExecution.reviewRunId }) }, { execution: rawLocalExecution })
  const localManifest = parsedManifest({ execution: rawLocalExecution, artifactName: null, replayArtifactName: null, model: null })
  expect(validateHandoffRecords(localResult, localManifest)).toEqual([])
})

test("a skipped run may capture base and head without a merge base", () => {
  const withoutMergeBase = { ...rawManifest.captured, mergeBaseSha: null }
  const skipped = parsedResult({ kind: "skipped", reason: "draft", snapshot: null }, { captured: withoutMergeBase })
  expect(validateHandoffRecords(skipped, parsedManifest({ captured: withoutMergeBase }))).toEqual([])
})

test("an early failure may have no capture", () => {
  const early = parsedResult({
    kind: "failed",
    failure: { code: "github-not-found", stage: "capture", message: "the pull request is gone" },
    snapshot: null,
  }, { captured: null })
  expect(validateHandoffRecords(early, parsedManifest({ captured: null }))).toEqual([])
})

test("a failed outcome never invents a merge base its capture does not hold", () => {
  const failure = { code: "github-unavailable", stage: "capture", message: "the API stopped responding" }
  const snapshot = { baseSha: sha, headSha: sha, mergeBaseSha: sha }
  const uncaptured = parsedResult({ kind: "failed", failure, snapshot }, { captured: null })
  expect(codes(validateHandoffRecords(uncaptured, parsedManifest({ captured: null })))).toContain("artifact-invalid")
  const divergentCapture = parsedResult({ kind: "failed", failure, snapshot })
  expect(codes(validateHandoffRecords(divergentCapture, parsedManifest({ captured: { ...rawManifest.captured, mergeBaseSha: "b".repeat(40) } })))).toContain("artifact-invalid")
})

const sourceReference = { side: "head", path: "src/A.java", startLine: 1, endLine: 1, excerpt: "class A {}" }

async function validHandoffInput(overrides: Partial<PrHandoffInput> = {}): Promise<PrHandoffInput> {
  const programHash = await hashProductSources()
  const promptHashes = await hashPromptTemplates()
  const execution = actionsExecutionSchema.parse(rawActionsExecution)
  const parsedIdentity = identitySchema.parse(identity)
  const candidate = {
    id: "C-1",
    changeLocation: sourceReference,
    trigger: "A call receives an incompatible result",
    consequence: "The caller can fail",
    rootCause: "The return value changed",
    citations: [sourceReference],
  }
  const issue = {
    candidate,
    verification: { candidateId: "C-1", decision: "keep", reason: "The source confirms the behavior", evidence: [sourceReference] },
  }
  const outcome = prOutcomeSchema.parse({
    kind: "reviewed",
    result: {
      ...reviewedResult({ issues: [issue] }),
      versions: { program: programHash, sdk: "2.2.7", config: hex64("f"), ...promptHashes },
    },
  })
  const fixedSha = gitShaSchema.parse(sha)
  const sourceDigest = digestSchema.parse(hex64("e"))
  const defaults: PrHandoffInput = {
    identity: parsedIdentity,
    execution,
    captured: { baseSha: fixedSha, headSha: fixedSha, mergeBaseSha: fixedSha, observedAt: instant },
    outcome,
    backup: backupReceiptSchema.parse({ kind: "absent" }),
    backupBody: null,
    configSource: { kind: "base-blob", path: "review.config.json", sha: fixedSha, digest: sourceDigest },
    model: { providerId: "openai", modelId: "gpt-test" },
    artifactName: `ai-code-review-handoff-${runId}-1000000`,
    replayArtifactName: `ai-code-review-replay-${runId}-1000000`,
    completedAt: instant,
    replayDirectory: null,
    productCommit: fixedSha,
  }
  return { ...defaults, ...overrides }
}

function expectedPublication(input: PrHandoffInput, overrides: Partial<ExpectedPublication> = {}): ExpectedPublication {
  if (input.identity === null || input.execution.kind !== "actions") throw new Error("test fixture requires an Actions handoff")
  return {
    identity: input.identity,
    execution: input.execution,
    reviewJobResult: "success",
    productCommit: input.productCommit,
    programHash: input.outcome.kind === "reviewed" ? digestSchema.parse(input.outcome.result.versions.program) : digestSchema.parse(hex64("b")),
    ...overrides,
  }
}

function admissionReader(input: PrHandoffInput, overrides: Partial<GitHubReader> = {}): GitHubReader {
  const fixedIdentity = input.identity
  const fixedExecution = input.execution
  const fixedCapture = input.captured
  if (fixedIdentity === null || fixedExecution.kind !== "actions" || fixedCapture === null || fixedCapture.mergeBaseSha === null) {
    throw new Error("test fixture requires a captured Actions handoff")
  }
  const fixedMergeBase = fixedCapture.mergeBaseSha
  return {
    async capturePullRequest() { throw new Error("capture is not part of handoff admission") },
    async readWorkflow() {
      return {
        repositoryId: fixedIdentity.repositoryId,
        runId: fixedExecution.workflowRunId,
        currentAttempt: fixedExecution.attempt,
        createdAt: fixedExecution.triggeredAt,
        attemptStartedAt: fixedExecution.startedAt,
        status: "in_progress",
        event: "pull_request",
      }
    },
    async prepareFixedRepository() { throw new Error("fixed repository preparation is not part of handoff admission") },
    async readProductComment() { throw new Error("comments are not part of handoff admission") },
    async readArtifactReceipt() {
      return {
        id: "123",
        name: `ai-code-review-handoff-${fixedExecution.workflowRunId}-${fixedExecution.attempt}`,
        workflowRunId: fixedExecution.workflowRunId,
        bytes: 1,
        expired: false,
        digest: null,
      }
    },
    async readFixedSnapshot() {
      return { mergeBaseSha: fixedMergeBase, changedHeadPaths: [sourceReference.path], sources: [{ side: "head" as const, path: sourceReference.path, text: sourceReference.excerpt }] }
    },
    async readFixedLines() { return sourceReference.excerpt },
    ...overrides,
  }
}

async function committedPackage(input: PrHandoffInput): Promise<{ root: string; directory: string }> {
  const root = await mkdtemp(join(tmpdir(), "handoff-admission-"))
  const outcome = await writePrHandoff({ ...input, out: root })
  if (outcome.handoffDirectory === null) throw new Error("the test handoff package was not committed")
  return { root, directory: outcome.handoffDirectory }
}

test("writePrHandoff commits exactly two files and admitHandoff returns only domain values", async () => {
  const input = await validHandoffInput()
  const packageRoot = await committedPackage(input)
  try {
    expect((await readdir(packageRoot.directory)).sort()).toEqual(["review-result.json", "run-manifest.json"])
    for (const name of await readdir(packageRoot.directory)) {
      const stat = await lstat(join(packageRoot.directory, name))
      expect(stat.isFile()).toBe(true)
      expect(stat.isSymbolicLink()).toBe(false)
      expect(stat.nlink).toBe(1)
    }
    const admission = await admitHandoff(packageRoot.directory, expectedPublication(input), admissionReader(input), createBudget(systemClock, 10_000))
    expect(admission.kind).toBe("valid")
    if (admission.kind !== "valid") throw new Error("the valid package was rejected")
    expect(admission.run).toMatchObject({
      identity,
      execution: rawActionsExecution,
      captured: { baseSha: sha, headSha: sha, mergeBaseSha: sha },
      outcome: { kind: "reviewed" },
    })
    expect("schemaVersion" in admission.run).toBe(false)
  } finally {
    await rm(packageRoot.root, { recursive: true, force: true })
  }
})

test("a corrupted result digest rejects before fixed source reads", async () => {
  const input = await validHandoffInput()
  const packageRoot = await committedPackage(input)
  let fixedReads = 0
  const original = admissionReader(input)
  const github: GitHubReader = { ...original, async readFixedSnapshot(args) { fixedReads += 1; return original.readFixedSnapshot(args) } }
  try {
    await writeFile(join(packageRoot.directory, "review-result.json"), "{}\n")
    const admission = await admitHandoff(packageRoot.directory, expectedPublication(input), github, createBudget(systemClock, 10_000))
    expect(admission.kind).toBe("rejected")
    expect(fixedReads).toBe(0)
  } finally {
    await rm(packageRoot.root, { recursive: true, force: true })
  }
})

test("a package with the wrong identity is rejected after its digest is recomputed", async () => {
  const wrongIdentity: PullRequestIdentity = identitySchema.parse({ ...identity, pr: 18 })
  const input = await validHandoffInput({ identity: wrongIdentity })
  const packageRoot = await committedPackage(input)
  try {
    const expected = expectedPublication(input, { identity: identitySchema.parse(identity) })
    const admission = await admitHandoff(packageRoot.directory, expected, admissionReader(input), createBudget(systemClock, 10_000))
    expect(admission.kind).toBe("rejected")
  } finally {
    await rm(packageRoot.root, { recursive: true, force: true })
  }
})

test("extra entries and symlinks reject the handoff directory", async () => {
  const input = await validHandoffInput()
  const extraPackage = await committedPackage(input)
  try {
    await writeFile(join(extraPackage.directory, "extra.json"), "{}\n")
    expect((await admitHandoff(extraPackage.directory, expectedPublication(input), admissionReader(input), createBudget(systemClock, 10_000))).kind).toBe("rejected")
  } finally {
    await rm(extraPackage.root, { recursive: true, force: true })
  }

  const linkedPackage = await committedPackage(input)
  try {
    const target = join(linkedPackage.root, "result-copy.json")
    await writeFile(target, await readFile(join(linkedPackage.directory, "review-result.json")))
    await rm(join(linkedPackage.directory, "review-result.json"))
    await symlink(target, join(linkedPackage.directory, "review-result.json"))
    expect((await admitHandoff(linkedPackage.directory, expectedPublication(input), admissionReader(input), createBudget(systemClock, 10_000))).kind).toBe("rejected")
  } finally {
    await rm(linkedPackage.root, { recursive: true, force: true })
  }
})

test("oversized files and multiple exact-name artifact receipts reject", async () => {
  const input = await validHandoffInput()
  const oversized = await committedPackage(input)
  try {
    await writeFile(join(oversized.directory, "review-result.json"), Buffer.alloc(HANDOFF_RESULT_BYTE_LIMIT + 1, 0x20))
    expect((await admitHandoff(oversized.directory, expectedPublication(input), admissionReader(input), createBudget(systemClock, 10_000))).kind).toBe("rejected")
  } finally {
    await rm(oversized.root, { recursive: true, force: true })
  }

  const repeated = await committedPackage(input)
  try {
    const github = admissionReader(input)
    const multiple: GitHubReader = {
      ...github,
      async readArtifactReceipt() { throw new GitHubError("multiple exact-name artifacts exist", "artifact-invalid") },
    }
    expect((await admitHandoff(repeated.directory, expectedPublication(input), multiple, createBudget(systemClock, 10_000))).kind).toBe("rejected")
  } finally {
    await rm(repeated.root, { recursive: true, force: true })
  }
})

test("an artifact receipt associated with another run rejects", async () => {
  const input = await validHandoffInput()
  const packageRoot = await committedPackage(input)
  try {
    const github = admissionReader(input)
    const otherRun: GitHubReader = {
      ...github,
      async readArtifactReceipt() {
        return { id: "124", name: `ai-code-review-handoff-${runId}-1000000`, workflowRunId: runIdSchema.parse("8"), bytes: 1, expired: false, digest: null }
      },
    }
    expect((await admitHandoff(packageRoot.directory, expectedPublication(input), otherRun, createBudget(systemClock, 10_000))).kind).toBe("rejected")
  } finally {
    await rm(packageRoot.root, { recursive: true, force: true })
  }
})

test("an oversized result writes a bounded failure package and preserves the original in replay", async () => {
  const base = await validHandoffInput()
  if (base.outcome.kind !== "reviewed") throw new Error("test fixture requires a reviewed result")
  const root = await mkdtemp(join(tmpdir(), "handoff-oversized-result-"))
  const replay = join(root, "replay")
  await mkdir(replay)
  const oversizedOutcome = prOutcomeSchema.parse({
    kind: "reviewed",
    result: {
      ...base.outcome.result,
      status: "partial",
      coverage: { ...base.outcome.result.coverage, notes: Array.from({ length: 128 }, () => "注".repeat(2_000)) },
    },
  })
  if (oversizedOutcome.kind !== "reviewed") throw new Error("the oversized fixture must remain a review")
  const original = `${JSON.stringify(oversizedOutcome.result, null, 2)}\n`
  await writeFile(join(replay, "result.json"), original)
  const input = await validHandoffInput({
    replayDirectory: replay,
    outcome: oversizedOutcome,
  })
  try {
    const written = await writePrHandoff({ ...input, out: root })
    expect(written.outcome).toMatchObject({ kind: "failed", failure: { code: "artifact-write", stage: "handoff" } })
    expect(written.handoffDirectory).toBe(join(root, "handoff"))
    expect(await readFile(join(replay, "result.json"), "utf8")).toBe(original)
    expect(await readFile(join(root, "replay-export", "result.json"), "utf8")).toBe(original)
    const committed = reviewResultFileSchema.parse(JSON.parse(await readFile(join(root, "handoff", "review-result.json"), "utf8")))
    expect(committed.outcome.kind).toBe("failed")
    if (committed.outcome.kind !== "failed") throw new Error("the size fallback must not retain review issues")
    expect("result" in committed.outcome).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the replay export applies its allowlist and records exact bytes omitted by the 64 MiB cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "handoff-replay-cap-"))
  const replay = join(root, "replay")
  await mkdir(join(replay, "runtime"), { recursive: true })
  await writeFile(join(replay, "result.json"), "{\"status\":\"complete\"}\n")
  await writeFile(join(replay, "requests.json"), "must not be exported\n")
  await writeFile(join(replay, "runtime", "worker.json"), "must not be exported\n")
  const trace = await open(join(replay, "sessions.json"), "w")
  const cap = 64 * 1024 * 1024
  const expectedOmittedBytes = cap + 123
  await trace.truncate(expectedOmittedBytes)
  await trace.close()
  try {
    const input = await validHandoffInput({ replayDirectory: replay })
    const written = await writePrHandoff({ ...input, out: root })
    expect(written.replayIncomplete).toBe(true)
    expect(written.omittedTraceBytes).toBe(expectedOmittedBytes)
    if (written.replayExportDirectory === null) throw new Error("the replay export directory is missing")
    const omissions = JSON.parse(await readFile(join(written.replayExportDirectory, "artifact-omissions.json"), "utf8"))
    expect(omissions.omittedTraceBytes).toBe(expectedOmittedBytes)
    expect(await readFile(join(written.replayExportDirectory, "result.json"), "utf8")).toBe("{\"status\":\"complete\"}\n")
    await expect(readFile(join(written.replayExportDirectory, "sessions.json"))).rejects.toThrow()
    await expect(readFile(join(written.replayExportDirectory, "requests.json"))).rejects.toThrow()
    await expect(readFile(join(written.replayExportDirectory, "runtime", "worker.json"))).rejects.toThrow()
    const sourceOmissions = JSON.parse(await readFile(join(replay, "artifact-omissions.json"), "utf8"))
    expect(sourceOmissions.omittedTraceBytes).toBe(expectedOmittedBytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("admission accepts the same run provenance when the publisher starts later", async () => {
  const input = await validHandoffInput()
  const packageRoot = await committedPackage(input)
  try {
    const expected = expectedPublication(input)
    expected.execution = actionsExecutionSchema.parse({ ...expected.execution, startedAt: "2026-11-21T10:05:00.000Z" })
    const admission = await admitHandoff(packageRoot.directory, expected, admissionReader(input), createBudget(systemClock, 10_000))
    expect(admission.kind).toBe("valid")
    if (admission.kind === "valid") expect(admission.run.execution.startedAt).toBe(instant)
    const manifest = runManifestFileSchema.parse(JSON.parse(await readFile(join(packageRoot.directory, "run-manifest.json"), "utf8")))
    manifest.execution.startedAt = expected.execution.startedAt
    await writeFile(join(packageRoot.directory, "run-manifest.json"), serializeHandoffFile(manifest))
    const mismatched = await admitHandoff(packageRoot.directory, expected, admissionReader(input), createBudget(systemClock, 10_000))
    expect(mismatched.kind).toBe("rejected")
    if (mismatched.kind === "rejected") expect(mismatched.failure.code).toBe("attempt-mismatch")
  } finally {
    await rm(packageRoot.root, { recursive: true, force: true })
  }
})

test("handoff finalization cannot commit after its shared deadline expires during storage", async () => {
  const input = await validHandoffInput()
  const root = await mkdtemp(join(tmpdir(), "handoff-deadline-"))
  let now = 0
  const budget = createBudget({ monotonicMs: () => now, wallTime: () => instant, sleep: async () => {} }, 300_000)
  try {
    const written = await writePrHandoff({ ...input, out: root }, {
      budget,
      writeFile: async (path, data) => { await writeFile(path, data); now = 300_000 },
    })
    expect(written.handoffDirectory).toBeNull()
    expect(await lstat(join(root, "handoff")).then(() => true, () => false)).toBe(false)
    expect(written.outcome.kind).toBe("failed")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a captured backup is saved and exported before local analysis exists", async () => {
  const body = "previous canonical report\n"
  const input = await validHandoffInput({
    outcome: { kind: "skipped", reason: "draft", snapshot: null },
    captured: { baseSha: gitShaSchema.parse(sha), headSha: gitShaSchema.parse(sha), mergeBaseSha: null, observedAt: instant },
    backup: backupReceiptSchema.parse({ kind: "captured", commentId: "123", bodyDigest: createHash("sha256").update(body).digest("hex"), updatedAt: instant }),
    backupBody: body,
  })
  const root = await mkdtemp(join(tmpdir(), "handoff-backup-"))
  try {
    const written = await writePrHandoff({ ...input, out: root })
    expect(written.handoffDirectory).not.toBeNull()
    expect(JSON.parse(await readFile(join(root, "replay", "previous-comment.json"), "utf8"))).toEqual({ receipt: input.backup, body })
    expect(await readFile(join(root, "replay-export", "previous-comment.json"), "utf8")).toBe(await readFile(join(root, "replay", "previous-comment.json"), "utf8"))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("an identical handoff repeat is a successful no-op and conflicting bytes preserve the original", async () => {
  const input = await validHandoffInput()
  const packageRoot = await committedPackage(input)
  try {
    const original = await readFile(join(packageRoot.directory, "review-result.json"), "utf8")
    const repeat = await writePrHandoff({ ...input, out: packageRoot.root })
    expect(repeat.handoffDirectory).toBe(packageRoot.directory)
    expect(repeat.outcome).toEqual(input.outcome)
    const conflicting = await writePrHandoff({ ...input, completedAt: "2026-11-21T10:06:00.000Z", out: packageRoot.root })
    expect(conflicting.handoffDirectory).toBeNull()
    expect(await readFile(join(packageRoot.directory, "review-result.json"), "utf8")).toBe(original)
  } finally { await rm(packageRoot.root, { recursive: true, force: true }) }
})

test("a storage failure attempts a bounded artifact-write envelope with the actual cause", async () => {
  const input = await validHandoffInput()
  const root = await mkdtemp(join(tmpdir(), "handoff-storage-"))
  let writes = 0
  try {
    const written = await writePrHandoff({ ...input, out: root }, { writeFile: async (path, data) => {
      writes += 1
      if (writes === 1) throw new Error("storage temporarily unavailable")
      await writeFile(path, data, { flag: "wx" })
    } })
    expect(written.handoffDirectory).toBe(join(root, "handoff"))
    expect(writes).toBe(3)
    const result = reviewResultFileSchema.parse(JSON.parse(await readFile(join(root, "handoff", "review-result.json"), "utf8")))
    expect(result.outcome.kind).toBe("failed")
    if (result.outcome.kind !== "failed") throw new Error("expected artifact failure")
    expect(result.outcome.failure).toMatchObject({ code: "artifact-write", message: "storage temporarily unavailable" })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("an interrupted replay copy cannot be reported as a complete export on repeat", async () => {
  const input = await validHandoffInput()
  const root = await mkdtemp(join(tmpdir(), "handoff-export-interrupted-"))
  try {
    await mkdir(join(root, "replay-export"))
    const written = await writePrHandoff({ ...input, out: root })
    expect(written.handoffDirectory).not.toBeNull()
    expect(written.replayIncomplete).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a stalled handoff write returns at the deadline and never commits when storage resumes", async () => {
  const input = await validHandoffInput()
  const root = await mkdtemp(join(tmpdir(), "handoff-stalled-"))
  let resume = () => {}
  const gate = new Promise<void>((resolve) => { resume = resolve })
  let finish = () => {}
  const finished = new Promise<void>((resolve) => { finish = resolve })
  try {
    const written = await writePrHandoff({ ...input, out: root }, {
      budget: createBudget(systemClock, 500),
      writeFile: async (path, data) => { await gate; await writeFile(path, data, { flag: "wx" }); finish() },
    })
    expect(written.handoffDirectory).toBeNull()
    resume()
    await finished
    await Promise.resolve()
    expect(await lstat(join(root, "handoff")).then(() => true, () => false)).toBe(false)
  } finally { resume(); await rm(root, { recursive: true, force: true }) }
})
