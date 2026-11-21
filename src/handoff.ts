import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { open, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { relativePathSchema } from "./contracts"
import { commentIdSchema, digestSchema, gitShaSchema, instantSchema } from "./identity"
import { BudgetExhaustedError, type ExecutionBudget } from "./budget"
import { GitHubError, type GitHubReader, type PullRequestCapture } from "./github"
import {
  actionsExecutionSchema, executionSchema, failureCodeSchema, failureSchema, identitySchema, jobResultSchema,
  prOutcomeSchema, type ActionsExecution, type Execution, type Failure, type JobResult, type PrOutcome,
  type PullRequestIdentity,
} from "./pr-contracts"
import type { FixedRepository } from "./github"
import { hashProductSources, hashPromptTemplates } from "./product-identity"
import type { Sha256, GitSha } from "./identity"

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

export type CapturedSnapshot = { baseSha: GitSha; headSha: GitSha; mergeBaseSha: GitSha | null; observedAt: string }
export type PrHandoffInput = {
  identity: PullRequestIdentity | null
  execution: Execution
  captured: CapturedSnapshot | null
  outcome: PrOutcome
  backup: z.infer<typeof backupReceiptSchema>
  backupBody: string | null
  configSource: FixedRepository["configSource"] | null
  model: { providerId: string; modelId: string } | null
  artifactName: string | null
  replayArtifactName: string | null
  completedAt: string
  replayDirectory: string | null
  productCommit: GitSha
}

export type ExpectedPublication = {
  identity: PullRequestIdentity
  execution: ActionsExecution
  reviewJobResult: JobResult
  productCommit: GitSha
  programHash: Sha256
}
export type AdmittedRun = {
  identity: PullRequestIdentity
  execution: ActionsExecution
  captured: { baseSha: GitSha; headSha: GitSha; mergeBaseSha: GitSha | null } | null
  outcome: PrOutcome
  resultDigest: Sha256
  completedAt: string
}
export type Admission =
  | { kind: "valid"; run: AdmittedRun }
  | { kind: "missing"; failure: Failure }
  | { kind: "rejected"; failure: Failure }

export type HandoffWriteResult = {
  outcome: PrOutcome
  handoffDirectory: string | null
  replayExportDirectory: string | null
  replayIncomplete: boolean
  omittedTraceBytes: number
}

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

const sha256 = (value: Uint8Array | string): Sha256 => createHash("sha256").update(value).digest("hex") as Sha256
const REPLAY_BYTE_LIMIT = 64 * 1024 * 1024
const REPLAY_MANIFEST_RESERVE = 4 * 1024
const REPLAY_FILES = [
  "result.json", "manifest.json", "report.md", "input.json", "candidates.json", "verifications.json",
  "sessions.json", "tool-trace.json", "timing.json", "usage.json", "cleanup.json", "configuration.json",
  "prompts.json", "versions.json", "previous-comment.json",
] as const
const OMITTIONS_FILE = "artifact-omissions.json"

function failure(code: Failure["code"], message: string): Failure {
  const bounded = message.trim().slice(0, 2_000)
  return failureSchema.parse({ code, stage: "handoff", message: bounded || "the handoff could not be written" })
}

function publishFailure(code: Failure["code"], message: string): Failure {
  const bounded = message.trim().slice(0, 2_000)
  return failureSchema.parse({ code, stage: "publish", message: bounded || "the handoff could not be admitted" })
}

function resultFileFor(input: PrHandoffInput, outcome: PrOutcome): ReviewResultFile {
  if (input.identity === null) throw new Error("a handoff needs a captured repository identity")
  return reviewResultFileSchema.parse({
    schemaVersion: 1,
    identity: input.identity,
    execution: input.execution,
    captured: input.captured,
    outcome,
    backup: input.backup,
    completedAt: input.completedAt,
  })
}

function configRecordFor(input: PrHandoffInput, outcome: PrOutcome): z.infer<typeof configRecordSchema> | null {
  if (input.configSource === null || outcome.kind !== "reviewed") return null
  const effectiveDigest = digestSchema.parse(outcome.result.versions.config)
  if (input.configSource.kind === "base-blob") {
    return configRecordSchema.parse({
      kind: "base-blob",
      path: input.configSource.path,
      sourceSha: input.configSource.sha,
      sourceDigest: input.configSource.digest,
      effectiveDigest,
    })
  }
  return configRecordSchema.parse({
    kind: "product-default",
    sourceDigest: input.configSource.digest,
    effectiveDigest,
  })
}

function packageFailureOutcome(outcome: PrOutcome): PrOutcome {
  const snapshot = outcome.kind === "reviewed" ? outcome.result.snapshot : outcome.snapshot
  return prOutcomeSchema.parse({
    kind: "failed",
    failure: failure("artifact-write", "the review result exceeded the 512 KiB handoff limit"),
    snapshot,
  })
}

async function writeSyncedFile(path: string, data: Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function ensureAbsent(path: string): Promise<void> {
  try {
    await lstat(path)
    throw new Error("the handoff destination already exists")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  }
}

type ReplayEntry = { relativePath: string; sourcePath: string; bytes: number }

function within(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..")
}

async function listReplayEntries(replayDirectory: string): Promise<{ entries: ReplayEntry[]; missing: number; excluded: number }> {
  const entries: ReplayEntry[] = []
  let missing = 0
  let excluded = 0
  const root = resolve(replayDirectory)
  for (const name of REPLAY_FILES) {
    const sourcePath = join(root, name)
    let info
    try {
      info = await lstat(sourcePath)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        missing += 1
        continue
      }
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      excluded += 1
      continue
    }
    entries.push({ relativePath: name, sourcePath, bytes: info.size })
  }

  const material = join(root, "material")
  let materialInfo
  try {
    materialInfo = await lstat(material)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      missing += 1
      return { entries, missing, excluded }
    }
    throw error
  }
  if (!materialInfo.isDirectory() || materialInfo.isSymbolicLink()) {
    excluded += 1
    return { entries, missing, excluded }
  }

  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const sourcePath = join(directory, entry.name)
      const relativePath = `${prefix}/${entry.name}`
      const info = await lstat(sourcePath)
      if (info.isSymbolicLink()) {
        excluded += 1
      } else if (info.isDirectory()) {
        await visit(sourcePath, relativePath)
      } else if (info.isFile() && info.nlink === 1 && within(root, sourcePath)) {
        entries.push({ relativePath, sourcePath, bytes: info.size })
      } else {
        excluded += 1
      }
    }
  }
  await visit(material, "material")
  return { entries, missing, excluded }
}

async function copyReplayEntry(entry: ReplayEntry, destination: string, remainingBytes: number): Promise<number | null> {
  const source = await open(entry.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await source.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size !== entry.bytes || info.size > remainingBytes) return null
    const data = await source.readFile()
    if (data.byteLength !== info.size || data.byteLength > remainingBytes) return null
    const target = join(destination, entry.relativePath)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, data, { flag: "wx", mode: 0o600 })
    return data.byteLength
  } finally {
    await source.close()
  }
}

async function exportReplay(input: PrHandoffInput, out: string): Promise<{ directory: string | null; incomplete: boolean; omittedBytes: number }> {
  if (input.replayDirectory === null) return { directory: null, incomplete: true, omittedBytes: 0 }
  const replayDirectory = resolve(input.replayDirectory)
  const replayInfo = await lstat(replayDirectory)
  if (!replayInfo.isDirectory() || replayInfo.isSymbolicLink()) throw new Error("the replay path is not a regular directory")
  const previousComment = JSON.stringify({ receipt: input.backup, body: input.backupBody }, null, 2) + "\n"
  await writeFile(join(replayDirectory, "previous-comment.json"), previousComment, { flag: "wx", mode: 0o600 })

  const output = join(out, "replay-export")
  await mkdir(output, { mode: 0o700 })
  const { entries, missing, excluded } = await listReplayEntries(replayDirectory)
  let copiedBytes = 0
  let omittedBytes = 0
  let omittedFiles = 0
  for (const entry of entries) {
    const remaining = REPLAY_BYTE_LIMIT - copiedBytes - REPLAY_MANIFEST_RESERVE
    const copied = await copyReplayEntry(entry, output, remaining)
    if (copied === null) {
      omittedBytes += entry.bytes
      omittedFiles += 1
    } else {
      copiedBytes += copied
    }
  }
  const incomplete = omittedFiles > 0 || missing > 0 || excluded > 0
  if (incomplete) {
    const record = `${JSON.stringify({ schemaVersion: 1, byteLimit: REPLAY_BYTE_LIMIT, omittedTraceBytes: omittedBytes, omittedFiles, missingEntries: missing, excludedEntries: excluded }, null, 2)}\n`
    const recordBytes = Buffer.from(record, "utf8")
    if (recordBytes.byteLength > REPLAY_MANIFEST_RESERVE || copiedBytes + recordBytes.byteLength > REPLAY_BYTE_LIMIT) {
      throw new Error("the replay omissions record exceeded its reserved space")
    }
    await writeFile(join(replayDirectory, OMITTIONS_FILE), recordBytes, { flag: "wx", mode: 0o600 })
    await writeFile(join(output, OMITTIONS_FILE), recordBytes, { flag: "wx", mode: 0o600 })
  }
  return { directory: output, incomplete, omittedBytes }
}

export async function writePrHandoff(input: PrHandoffInput & { out: string }): Promise<HandoffWriteResult> {
  let replay = { directory: null as string | null, incomplete: true, omittedBytes: 0 }
  try {
    replay = await exportReplay(input, input.out)
  } catch {
    replay = { directory: null, incomplete: true, omittedBytes: 0 }
  }
  if (input.identity === null) {
    return { outcome: input.outcome, handoffDirectory: null, replayExportDirectory: replay.directory, replayIncomplete: replay.incomplete, omittedTraceBytes: replay.omittedBytes }
  }

  const targetDirectory = join(input.out, "handoff")
  const stagingDirectory = join(input.out, `.handoff-${randomUUID()}.tmp`)
  let outcome = input.outcome
  let resultFile: ReviewResultFile
  let resultBytes: Uint8Array
  try {
    resultFile = resultFileFor(input, outcome)
    resultBytes = Buffer.from(serializeHandoffFile(resultFile), "utf8")
    if (resultBytes.byteLength > HANDOFF_RESULT_BYTE_LIMIT) {
      outcome = packageFailureOutcome(outcome)
      resultFile = resultFileFor(input, outcome)
      resultBytes = Buffer.from(serializeHandoffFile(resultFile), "utf8")
    }
    if (resultBytes.byteLength > HANDOFF_RESULT_BYTE_LIMIT) throw new Error("the bounded artifact-write result exceeded its byte limit")
    const promptHashes = await hashPromptTemplates()
    const programHash = await hashProductSources()
    const manifest = runManifestFileSchema.parse({
      schemaVersion: 1,
      identity: input.identity,
      execution: input.execution,
      captured: input.captured,
      versions: {
        productCommit: input.productCommit,
        programHash,
        bun: "1.4.4",
        sdk: "2.2.7",
        plugin: "2.2.7",
        ...promptHashes,
      },
      config: configRecordFor(input, outcome),
      model: input.model,
      result: { name: HANDOFF_RESULT_FILE_NAME, bytes: resultBytes.byteLength, sha256: sha256(resultBytes) },
      artifactName: input.execution.kind === "actions" ? `ai-code-review-handoff-${input.execution.workflowRunId}-${input.execution.attempt}` : null,
      replayArtifactName: input.execution.kind === "actions" ? `ai-code-review-replay-${input.execution.workflowRunId}-${input.execution.attempt}` : null,
      completedAt: input.completedAt,
    })
    const manifestBytes = Buffer.from(serializeHandoffFile(manifest), "utf8")
    if (manifestBytes.byteLength > HANDOFF_MANIFEST_BYTE_LIMIT) throw new Error("the run manifest exceeded its 32 KiB byte limit")
    const violations = validateHandoffRecords(resultFile, manifest)
    if (violations.length > 0) throw new Error(violations[0]!.message)

    const parentInfo = await lstat(input.out)
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("the output path is not a regular directory")
    await ensureAbsent(targetDirectory)
    await mkdir(stagingDirectory, { mode: 0o700 })
    await writeSyncedFile(join(stagingDirectory, HANDOFF_RESULT_FILE_NAME), resultBytes)
    await writeSyncedFile(join(stagingDirectory, HANDOFF_MANIFEST_FILE_NAME), manifestBytes)
    await syncDirectory(stagingDirectory)
    await ensureAbsent(targetDirectory)
    await rename(stagingDirectory, targetDirectory)
    await syncDirectory(input.out)
    return { outcome, handoffDirectory: targetDirectory, replayExportDirectory: replay.directory, replayIncomplete: replay.incomplete, omittedTraceBytes: replay.omittedBytes }
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
    if (outcome.kind === "reviewed") outcome = packageFailureOutcome(outcome)
    return { outcome, handoffDirectory: null, replayExportDirectory: replay.directory, replayIncomplete: replay.incomplete, omittedTraceBytes: replay.omittedBytes }
  }
}

async function readPackageFiles(directory: string): Promise<{ resultBytes: Uint8Array; manifestBytes: Uint8Array }> {
  const root = resolve(directory)
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("the handoff path is not a regular directory")
  const names = (await readdir(root)).sort()
  if (names.length !== 2 || !names.includes(HANDOFF_MANIFEST_FILE_NAME) || !names.includes(HANDOFF_RESULT_FILE_NAME)) {
    throw new Error("the handoff must contain exactly review-result.json and run-manifest.json")
  }
  const readOne = async (name: string, cap: number): Promise<Uint8Array> => {
    const path = join(root, name)
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > cap) {
      throw new Error(`${name} is not a bounded single-link regular file`)
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.nlink !== 1 || opened.size !== before.size || opened.size > cap) {
        throw new Error(`${name} changed while the handoff was being read`)
      }
      const data = await handle.readFile()
      if (data.byteLength !== opened.size || data.byteLength > cap) throw new Error(`${name} exceeded its byte cap`)
      return data
    } finally {
      await handle.close()
    }
  }
  const [resultBytes, manifestBytes] = await Promise.all([
    readOne(HANDOFF_RESULT_FILE_NAME, HANDOFF_RESULT_BYTE_LIMIT),
    readOne(HANDOFF_MANIFEST_FILE_NAME, HANDOFF_MANIFEST_BYTE_LIMIT),
  ])
  return { resultBytes, manifestBytes }
}

function parseJsonBytes(bytes: Uint8Array, name: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new Error(`${name} is not canonical UTF-8 JSON`)
  }
}

function sameCapturedSnapshot(result: ReviewResultFile, manifest: RunManifestFile): boolean {
  if (!isDeepStrictEqual(result.captured, manifest.captured)) return false
  const outcomeSnapshot = result.outcome.kind === "reviewed" ? result.outcome.result.snapshot : result.outcome.snapshot
  if (outcomeSnapshot === null) return true
  if (result.captured === null) return false
  return outcomeSnapshot.baseSha === result.captured.baseSha &&
    outcomeSnapshot.headSha === result.captured.headSha &&
    outcomeSnapshot.mergeBaseSha === result.captured.mergeBaseSha
}

function identityViolation(result: ReviewResultFile, manifest: RunManifestFile, expected: ExpectedPublication): HandoffViolation | null {
  if (!isDeepStrictEqual(result.identity, manifest.identity) || !isDeepStrictEqual(result.identity, expected.identity)) {
    return { code: "identity-mismatch", message: "the handoff identity does not equal the expected pull request" }
  }
  if (!isDeepStrictEqual(result.execution, manifest.execution) || !isDeepStrictEqual(result.execution, expected.execution)) {
    return { code: "attempt-mismatch", message: "the handoff execution does not equal the expected workflow attempt" }
  }
  const suffix = `${expected.execution.workflowRunId}-${expected.execution.attempt}`
  if (manifest.artifactName !== `ai-code-review-handoff-${suffix}` || manifest.replayArtifactName !== `ai-code-review-replay-${suffix}`) {
    return { code: "artifact-provenance", message: "the manifest artifact names do not match the expected run attempt" }
  }
  if (result.completedAt !== manifest.completedAt) return { code: "artifact-invalid", message: "the handoff completion timestamps differ" }
  return null
}

function versionViolation(result: ReviewResultFile, manifest: RunManifestFile, expected: ExpectedPublication, prompts: { discoverPrompt: Sha256; verifyPrompt: Sha256 }, actualProgramHash: Sha256): HandoffViolation | null {
  const versions = manifest.versions
  if (versions.productCommit !== expected.productCommit || versions.programHash !== expected.programHash || versions.programHash !== actualProgramHash) {
    return { code: "artifact-provenance", message: "the manifest product source does not match this publisher" }
  }
  if (versions.discoverPrompt !== prompts.discoverPrompt || versions.verifyPrompt !== prompts.verifyPrompt) {
    return { code: "artifact-provenance", message: "the manifest prompt hashes do not match this publisher" }
  }
  if (result.outcome.kind === "reviewed") {
    const resultVersions = prResultVersionsSchema.safeParse(result.outcome.result.versions)
    if (!resultVersions.success || resultVersions.data.program !== versions.programHash || resultVersions.data.sdk !== versions.sdk ||
      resultVersions.data.discoverPrompt !== versions.discoverPrompt || resultVersions.data.verifyPrompt !== versions.verifyPrompt ||
      manifest.config === null || resultVersions.data.config !== manifest.config.effectiveDigest) {
      return { code: "artifact-provenance", message: "the reviewed result version hashes do not match the manifest" }
    }
  }
  return null
}

function expectedContextViolation(expected: ExpectedPublication): HandoffViolation | null {
  const identity = identitySchema.safeParse(expected.identity)
  const execution = actionsExecutionSchema.safeParse(expected.execution)
  const job = jobResultSchema.safeParse(expected.reviewJobResult)
  const commit = gitShaSchema.safeParse(expected.productCommit)
  const program = digestSchema.safeParse(expected.programHash)
  if (!identity.success || !execution.success || !job.success || !commit.success || !program.success) {
    return { code: "writer-context-required", message: "a valid Actions publication context is required" }
  }
  const expectedRunUrl = `https://github.com/${identity.data.repository}/actions/runs/${execution.data.workflowRunId}`
  if (execution.data.runUrl !== expectedRunUrl) return { code: "writer-context-required", message: "the Actions run URL does not match the fixed GitHub context" }
  return null
}

function admissionForFailure(code: Failure["code"], message: string): Admission {
  return { kind: "rejected", failure: publishFailure(code, message) }
}

function classifyAdmissionError(error: unknown): Admission {
  if (error instanceof GitHubError) return admissionForFailure(error.code, error.message)
  if (error instanceof BudgetExhaustedError) return admissionForFailure("github-unavailable", error.message)
  return admissionForFailure("artifact-invalid", error instanceof Error ? error.message : "the handoff could not be read")
}

async function verifyCitations(run: AdmittedRun, evidence: { mergeBaseSha: GitSha; changedHeadPaths: string[] }, github: GitHubReader, budget: ExecutionBudget): Promise<void> {
  if (run.outcome.kind !== "reviewed") return
  type Ref = { side: "merge-base" | "head"; path: string; startLine: number; endLine: number; excerpt: string }
  const groups = new Map<string, { sha: GitSha; path: string; startLine: number; endLine: number; refs: Ref[] }>()
  for (const issue of run.outcome.result.issues) {
    const refs = [issue.candidate.changeLocation, ...issue.candidate.citations, ...issue.verification.evidence]
    for (const ref of refs) {
      if (ref === issue.candidate.changeLocation && !evidence.changedHeadPaths.includes(ref.path)) {
        throw new GitHubError(`the finding location is not a changed head path: ${ref.path}`, "citation-invalid")
      }
      const sha = ref.side === "head" ? run.captured!.headSha : evidence.mergeBaseSha
      const key = `${sha}\0${ref.path}`
      const group = groups.get(key) ?? { sha, path: ref.path, startLine: ref.startLine, endLine: ref.endLine, refs: [] }
      group.startLine = Math.min(group.startLine, ref.startLine)
      group.endLine = Math.max(group.endLine, ref.endLine)
      group.refs.push(ref)
      groups.set(key, group)
    }
  }
  for (const group of groups.values()) {
    budget.assertRemaining("publish")
    const source = await github.readFixedLines({
      repository: run.identity.repository,
      sha: group.sha,
      path: group.path,
      startLine: group.startLine,
      endLine: group.endLine,
      budget,
      stage: "publish",
    })
    const lines = source === "" ? [] : source.split(/\r?\n/u)
    for (const ref of group.refs) {
      const excerpt = lines.slice(ref.startLine - group.startLine, ref.endLine - group.startLine + 1).join("\n")
      if (excerpt.trim() !== ref.excerpt.trim()) {
        throw new GitHubError(`the citation excerpt does not match ${group.path}:${ref.startLine}-${ref.endLine}`, "citation-invalid")
      }
    }
  }
}

export async function admitHandoff(directory: string, expected: ExpectedPublication, github: GitHubReader, budget: ExecutionBudget): Promise<Admission> {
  const contextViolation = expectedContextViolation(expected)
  if (contextViolation !== null) return admissionForFailure(contextViolation.code, contextViolation.message)

  let observation
  try {
    observation = await github.readWorkflow({
      repository: expected.identity.repository,
      runId: expected.execution.workflowRunId,
      budget,
      stage: "publish",
    })
  } catch (error) {
    return classifyAdmissionError(error)
  }
  const expectedEvent = expected.execution.trigger.kind === "pull-request" ? "pull_request" : "workflow_dispatch"
  if (observation.repositoryId !== expected.identity.repositoryId || observation.runId !== expected.execution.workflowRunId || observation.event !== expectedEvent) {
    return admissionForFailure("identity-mismatch", "the current Actions run does not match the expected repository and trigger")
  }
  if (observation.currentAttempt !== expected.execution.attempt) {
    return admissionForFailure("attempt-mismatch", "the expected workflow attempt is no longer current")
  }
  if (observation.status !== "in_progress") {
    return admissionForFailure("writer-attempt-inactive", "the expected workflow attempt is not active")
  }

  let receipt
  try {
    receipt = await github.readArtifactReceipt({ identity: expected.identity, execution: expected.execution, budget, stage: "publish" })
  } catch (error) {
    return classifyAdmissionError(error)
  }
  if (receipt === null) return { kind: "missing", failure: publishFailure("artifact-missing", "no handoff artifact exists for the current workflow attempt") }
  const expectedName = `ai-code-review-handoff-${expected.execution.workflowRunId}-${expected.execution.attempt}`
  if (receipt.name !== expectedName || receipt.workflowRunId !== expected.execution.workflowRunId || receipt.expired || receipt.bytes <= 0) {
    return admissionForFailure("artifact-provenance", "the artifact receipt does not identify one unexpired artifact for this workflow attempt")
  }

  let files: { resultBytes: Uint8Array; manifestBytes: Uint8Array }
  try {
    files = await readPackageFiles(directory)
  } catch (error) {
    return classifyAdmissionError(error)
  }

  let rawManifest: unknown
  let rawResult: unknown
  let resultDigest: Sha256
  try {
    const digest = sha256(files.resultBytes)
    rawManifest = parseJsonBytes(files.manifestBytes, HANDOFF_MANIFEST_FILE_NAME)
    rawResult = parseJsonBytes(files.resultBytes, HANDOFF_RESULT_FILE_NAME)
    if (typeof rawManifest !== "object" || rawManifest === null || !("result" in rawManifest) ||
      typeof rawManifest.result !== "object" || rawManifest.result === null || !("sha256" in rawManifest.result) ||
      !("bytes" in rawManifest.result) || typeof rawManifest.result.sha256 !== "string" || rawManifest.result.bytes !== files.resultBytes.byteLength ||
      digestSchema.safeParse(rawManifest.result.sha256).success === false || rawManifest.result.sha256 !== digest) {
      return admissionForFailure("artifact-invalid", "the result digest or byte receipt does not match the downloaded result")
    }
    resultDigest = digest
  } catch (error) {
    return classifyAdmissionError(error)
  }

  const parsedResult = reviewResultFileSchema.safeParse(rawResult)
  const parsedManifest = runManifestFileSchema.safeParse(rawManifest)
  if (!parsedResult.success || !parsedManifest.success) {
    return admissionForFailure("artifact-invalid", "the handoff files do not match the strict wire schemas")
  }
  const result = parsedResult.data
  const manifest = parsedManifest.data
  if (serializeHandoffFile(result) !== new TextDecoder("utf-8", { fatal: true }).decode(files.resultBytes) ||
    serializeHandoffFile(manifest) !== new TextDecoder("utf-8", { fatal: true }).decode(files.manifestBytes)) {
    return admissionForFailure("artifact-invalid", "the handoff files are not in canonical byte format")
  }

  const recordIdentityViolation = identityViolation(result, manifest, expected)
  if (recordIdentityViolation !== null) return admissionForFailure(recordIdentityViolation.code, recordIdentityViolation.message)

  if (!sameCapturedSnapshot(result, manifest)) return admissionForFailure("artifact-invalid", "the result and manifest do not describe the same fixed snapshot")
  let fixedEvidence: { mergeBaseSha: GitSha; changedHeadPaths: string[] } | null = null
  if (manifest.captured !== null && manifest.captured.mergeBaseSha !== null) {
    try {
      fixedEvidence = await github.readFixedSnapshot({
        identity: expected.identity,
        baseSha: manifest.captured.baseSha,
        headSha: manifest.captured.headSha,
        budget,
        stage: "publish",
      })
    } catch (error) {
      return classifyAdmissionError(error)
    }
    if (fixedEvidence.mergeBaseSha !== manifest.captured.mergeBaseSha) {
      return admissionForFailure("artifact-provenance", "the manifest merge base does not match the fixed Git objects")
    }
  }

  let prompts: { discoverPrompt: Sha256; verifyPrompt: Sha256 }
  let actualProgramHash: Sha256
  try {
    ;[prompts, actualProgramHash] = await Promise.all([hashPromptTemplates(), hashProductSources()])
  } catch {
    return admissionForFailure("artifact-provenance", "the publisher could not hash its fixed source and prompt files")
  }
  const provenanceViolation = versionViolation(result, manifest, expected, prompts, actualProgramHash)
  if (provenanceViolation !== null) return admissionForFailure(provenanceViolation.code, provenanceViolation.message)

  if (result.outcome.kind === "reviewed" && fixedEvidence === null) {
    return admissionForFailure("artifact-provenance", "a reviewed result needs a verifiable fixed snapshot")
  }
  const captured = manifest.captured === null ? null : {
    baseSha: manifest.captured.baseSha,
    headSha: manifest.captured.headSha,
    mergeBaseSha: manifest.captured.mergeBaseSha,
  }
  const actionsExecution = actionsExecutionSchema.safeParse(result.execution)
  if (!actionsExecution.success) return admissionForFailure("attempt-mismatch", "the handoff execution is not an Actions run")
  const run: AdmittedRun = {
    identity: result.identity,
    execution: actionsExecution.data,
    captured,
    outcome: result.outcome,
    resultDigest,
    completedAt: result.completedAt,
  }
  try {
    if (fixedEvidence !== null) await verifyCitations(run, fixedEvidence, github, budget)
  } catch (error) {
    return classifyAdmissionError(error)
  }
  return { kind: "valid", run }
}
