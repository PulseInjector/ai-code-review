import { z } from "zod"
import { relativePathSchema } from "./contracts"
import { commentIdSchema, digestSchema, gitShaSchema, instantSchema } from "./identity"
import { executionSchema, failureCodeSchema, identitySchema, prOutcomeSchema, type Failure } from "./pr-contracts"

export const versionRecordSchema = z.strictObject({
  productCommit: gitShaSchema,
  programHash: digestSchema,
  bun: z.literal("1.4.4"),
  sdk: z.literal("2.2.7"),
  plugin: z.literal("2.2.7"),
  discoverPrompt: digestSchema,
  verifyPrompt: digestSchema,
})

export const configRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("base-blob"),
    path: relativePathSchema,
    sourceSha: gitShaSchema,
    sourceDigest: digestSchema,
    effectiveDigest: digestSchema,
  }),
  z.strictObject({
    kind: z.literal("product-default"),
    sourceDigest: digestSchema,
    effectiveDigest: digestSchema,
  }),
])

export const modelRecordSchema = z.strictObject({
  providerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  modelId: z.string().trim().min(1).max(256),
})

export const backupReceiptSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("absent") }),
  z.strictObject({ kind: z.literal("captured"), commentId: commentIdSchema, bodyDigest: digestSchema, updatedAt: instantSchema }),
  z.strictObject({ kind: z.literal("unavailable"), code: failureCodeSchema }),
])

export const capturedSnapshotSchema = z.strictObject({
  baseSha: gitShaSchema,
  headSha: gitShaSchema,
  mergeBaseSha: gitShaSchema.nullable(),
  observedAt: instantSchema,
})

export const reviewResultFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: identitySchema,
  execution: executionSchema,
  captured: capturedSnapshotSchema.nullable(),
  outcome: prOutcomeSchema,
  backup: backupReceiptSchema,
  completedAt: instantSchema,
})

export const resultReceiptSchema = z.strictObject({
  name: z.literal("review-result.json"),
  bytes: z.int().positive().max(524_288),
  sha256: digestSchema,
})

export const runManifestFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: identitySchema,
  execution: executionSchema,
  captured: capturedSnapshotSchema.nullable(),
  versions: versionRecordSchema,
  config: configRecordSchema.nullable(),
  model: modelRecordSchema.nullable(),
  result: resultReceiptSchema,
  artifactName: z.string().regex(/^ai-code-review-handoff-[1-9][0-9]{0,19}-[1-9][0-9]{0,6}$/).nullable(),
  replayArtifactName: z.string().regex(/^ai-code-review-replay-[1-9][0-9]{0,19}-[1-9][0-9]{0,6}$/).nullable(),
  completedAt: instantSchema,
})

export type ReviewResultFile = z.infer<typeof reviewResultFileSchema>
export type RunManifestFile = z.infer<typeof runManifestFileSchema>

// The outcome snapshot and the result version hashes arrive as legacy unbranded strings. Parsing
// them through the branded schemas makes the comparison sites type-checked against the captured
// and manifest values.
const prSnapshotSchema = z.strictObject({
  baseSha: gitShaSchema,
  headSha: gitShaSchema,
  mergeBaseSha: gitShaSchema,
})
const prResultVersionsSchema = z.strictObject({
  program: digestSchema,
  sdk: z.string(),
  config: digestSchema,
  discoverPrompt: digestSchema,
  verifyPrompt: digestSchema,
})

export const HANDOFF_RESULT_FILE_NAME = "review-result.json"
export const HANDOFF_MANIFEST_FILE_NAME = "run-manifest.json"
export const HANDOFF_RESULT_BYTE_LIMIT = 524_288
export const HANDOFF_MANIFEST_BYTE_LIMIT = 32_768

export function serializeHandoffFile(file: ReviewResultFile | RunManifestFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

export type HandoffViolation = { code: Failure["code"]; message: string }

const sameRecord = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function validateHandoffRecords(result: ReviewResultFile, manifest: RunManifestFile): HandoffViolation[] {
  const violations: HandoffViolation[] = []
  const fail = (code: Failure["code"], message: string) => violations.push({ code, message })
  if (!sameRecord(result.identity, manifest.identity)) fail("identity-mismatch", "result and manifest identities differ")
  if (!sameRecord(result.execution, manifest.execution)) fail("attempt-mismatch", "result and manifest executions differ")
  if (!sameRecord(result.captured, manifest.captured)) fail("artifact-invalid", "result and manifest captures differ")
  if (result.completedAt !== manifest.completedAt) fail("artifact-invalid", "result and manifest completion times differ")
  if (manifest.execution.kind === "local") {
    if (manifest.artifactName !== null) fail("artifact-invalid", "a local manifest must have a null artifact name")
    if (manifest.replayArtifactName !== null) fail("artifact-invalid", "a local manifest must have a null replay artifact name")
  } else {
    const runSuffix = `${manifest.execution.workflowRunId}-${manifest.execution.attempt}`
    if (manifest.artifactName !== `ai-code-review-handoff-${runSuffix}`) {
      fail("artifact-invalid", "the artifact name must derive from the workflow run ID and attempt")
    }
    if (manifest.replayArtifactName !== `ai-code-review-replay-${runSuffix}`) {
      fail("artifact-invalid", "the replay artifact name must derive from the workflow run ID and attempt")
    }
  }
  if (manifest.execution.kind === "actions" && manifest.model === null) {
    fail("artifact-invalid", "an Actions manifest requires a non-null model record")
  }
  const outcomeSnapshot = result.outcome.kind === "reviewed" ? result.outcome.result.snapshot : result.outcome.snapshot
  if (outcomeSnapshot !== null && result.captured === null) {
    fail("artifact-invalid", "an outcome snapshot without a capture invents a merge base")
  }
  if (outcomeSnapshot !== null && result.captured !== null) {
    const branded = prSnapshotSchema.safeParse(outcomeSnapshot)
    if (!branded.success ||
      branded.data.baseSha !== result.captured.baseSha ||
      branded.data.headSha !== result.captured.headSha ||
      branded.data.mergeBaseSha !== result.captured.mergeBaseSha) {
      fail("artifact-invalid", "the outcome snapshot does not match the captured snapshot")
    }
  }
  if (result.outcome.kind === "reviewed") {
    if (result.captured === null || result.captured.mergeBaseSha === null) {
      fail("artifact-invalid", "a reviewed outcome requires a capture with a merge base")
    }
    if (manifest.config === null) fail("artifact-invalid", "a reviewed outcome requires a configuration record")
    if (result.outcome.result.runId !== result.execution.reviewRunId) {
      fail("identity-mismatch", "the reviewed result run ID does not equal the execution review run ID")
    }
    const versions = prResultVersionsSchema.safeParse(result.outcome.result.versions)
    if (!versions.success) {
      fail("artifact-provenance", "the reviewed result versions are not PR-side hashes")
    } else {
      if (versions.data.program !== manifest.versions.programHash || versions.data.sdk !== manifest.versions.sdk ||
        versions.data.discoverPrompt !== manifest.versions.discoverPrompt || versions.data.verifyPrompt !== manifest.versions.verifyPrompt) {
        fail("artifact-provenance", "the reviewed result versions do not equal the manifest versions")
      }
      if (manifest.config !== null && versions.data.config !== manifest.config.effectiveDigest) {
        fail("artifact-provenance", "the reviewed result config hash does not equal the effective configuration digest")
      }
    }
  }
  return violations
}
