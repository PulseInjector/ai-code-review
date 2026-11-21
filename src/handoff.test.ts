import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  backupReceiptSchema, HANDOFF_MANIFEST_BYTE_LIMIT, HANDOFF_RESULT_BYTE_LIMIT, modelRecordSchema,
  resultReceiptSchema, reviewResultFileSchema, runManifestFileSchema, serializeHandoffFile,
  validateHandoffRecords,
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
    result: reviewedResult({ coverage: { includedPaths: [], omittedPaths: [], unverifiedCandidateIds: [], unpublishedCandidateIds: [], notes } }),
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
