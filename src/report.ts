import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { reviewResultSchema, type Candidate, type ReviewResult } from "./contracts"
import type { ContextManifest } from "./context"
import type { DiscoveryVerificationResult } from "./discovery"
import type { RuntimeResult } from "./runtime/contracts"

export type RunArtifacts = {
  result: ReviewResult
  markdown: string
}

const escapeMarkdown = (text: string) => text.replace(/\r?\n/gu, " ").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/[\\`*_{}\[\]()#!|]/gu, "\\$&")

function reference(reference: Candidate["changeLocation"]): string {
  const target = `material/${reference.side}/${reference.path.split("/").map(encodeURIComponent).join("/")}#L${reference.startLine}`
  return `[${escapeMarkdown(`${reference.path}:${reference.startLine}-${reference.endLine}`)}](${target}) (${reference.side})`
}

function sourceBlock(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/gu) ?? []).map((run) => run.length))
  const fence = "`".repeat(longest + 1)
  return `${fence}\n${text}\n${fence}`
}

export function renderMarkdown(result: ReviewResult): string {
  const lines = [
    "# Code review", "", `Status: **${result.status}**`, "",
    `Snapshot: base \`${result.snapshot.baseSha}\`, head \`${result.snapshot.headSha}\`, merge base \`${result.snapshot.mergeBaseSha}\`.`, "",
    "## Findings", "",
  ]
  if (result.issues.length === 0) lines.push("No verified findings.", "")
  for (const [index, { candidate, verification }] of result.issues.entries()) {
    lines.push(`### ${index + 1}. ${escapeMarkdown(candidate.consequence)}`, "", `- Trigger: ${escapeMarkdown(candidate.trigger)}`,
      `- Root cause: ${escapeMarkdown(candidate.rootCause)}`, `- Change: ${reference(candidate.changeLocation)}`,
      `- Verification: ${escapeMarkdown(verification.reason)}`, "", "Evidence:", "")
    const seen = new Set<string>()
    for (const evidence of [candidate.changeLocation, ...candidate.citations, ...verification.evidence]) {
      const key = JSON.stringify(evidence)
      if (seen.has(key)) continue
      seen.add(key)
      lines.push(reference(evidence), "", sourceBlock(evidence.excerpt), "")
    }
    lines.push("")
  }
  lines.push("## Coverage", "", `Included paths: ${result.coverage.includedPaths.length}.`,
    `Omitted paths: ${result.coverage.omittedPaths.length ? result.coverage.omittedPaths.map(escapeMarkdown).join(", ") : "none"}.`,
    `Unverified candidates: ${result.coverage.unverifiedCandidateIds.length ? result.coverage.unverifiedCandidateIds.join(", ") : "none"}.`,
    `Unpublished verified candidates: ${result.coverage.unpublishedCandidateIds.length ? result.coverage.unpublishedCandidateIds.join(", ") : "none"}.`, "")
  for (const note of result.coverage.notes) lines.push(`- ${escapeMarkdown(note)}`)
  lines.push("", "## Run", "", `Duration: ${result.durationMs} ms.`,
    `Token usage: ${result.usage.kind === "known" ? `${result.usage.inputTokens} input, ${result.usage.outputTokens} output` : `unknown (${result.usage.reason})`}.`,
    `Run ID: \`${result.runId}\`.`, `Program: \`${result.versions.program}\`; SDK: \`${result.versions.sdk}\`.`,
    `Config: \`${result.versions.config}\`; prompts: \`${result.versions.discoverPrompt}\`, \`${result.versions.verifyPrompt}\`.`, "")
  for (const error of result.stageErrors) lines.push(`- ${error.stage} (${error.code}): ${escapeMarkdown(error.message)}`)
  return `${lines.join("\n")}\n`
}

export function createRunArtifacts(options: {
  context: ContextManifest
  discovery?: DiscoveryVerificationResult
  runId: string
  durationMs: number
  runtime?: RuntimeResult
  candidates?: Candidate[]
  promptVersions?: DiscoveryVerificationResult["versions"]
  error?: { stage: ReviewResult["stageErrors"][number]["stage"]; message: string }
  programVersion: string
  sdkVersion: string
  configHash: string
}): RunArtifacts {
  const { context, discovery, runId, durationMs } = options
  const runtime = discovery?.runtime ?? options.runtime
  const issues = discovery?.issues ?? []
  const notes = [
    ...(context.status === "partial" ? ["Prepared snapshot has omitted paths."] : []),
    ...context.coverage.omittedPaths.map((path) => `${path}: ${context.files.find((file) => file.path === path && !file.included)?.reason ?? "not included"}.`),
    ...(discovery?.unknownCandidateIds.length ? [`Verification was inconclusive for: ${discovery.unknownCandidateIds.join(", ")}.`] : []),
    ...(discovery?.unreportedCandidateIds.length ? [`Verified findings exceeded the publication limit: ${discovery.unreportedCandidateIds.join(", ")}.`] : []),
    ...(runtime?.readBudget.records.filter((record) => record.pending).map((record) => `Uncovered tool request: ${record.tool} ${record.path}${record.nextOffset ? `; next offset ${record.nextOffset}` : ""}.`) ?? []),
    ...(runtime?.readBudget.exhausted ? ["The tool read budget was exhausted."] : []),
  ]
  const stageErrors = options.error ? [{ stage: options.error.stage, code: "review-failed", message: options.error.message.slice(0, 2_000) }] : []
  if (context.changes.length === 0) notes.push("No changes between the merge base and head; model sessions were skipped.")
  else if (!context.changes.some(({ included }) => included)) notes.push("No changed files could be included; model sessions were skipped.")
  const status: ReviewResult["status"] = options.error ? "failed" : context.changes.length === 0 ? "skipped" : notes.length ? "partial" : "complete"
  const result = reviewResultSchema.parse({
    runId,
    snapshot: context.snapshot,
    status,
    issues: status === "failed" ? [] : issues,
    coverage: {
      includedPaths: context.coverage.includedPaths,
      omittedPaths: context.coverage.omittedPaths,
      unverifiedCandidateIds: discovery ? discovery.unknownCandidateIds : (options.candidates ?? []).map(({ id }) => id),
      unpublishedCandidateIds: discovery?.unreportedCandidateIds ?? [],
      notes: notes.map((note) => note.slice(0, 2_000)),
    },
    stageErrors,
    usage: runtime?.usage ?? (!options.error && !discovery ? { kind: "known", inputTokens: 0, outputTokens: 0 } : { kind: "unknown", reason: "model run did not produce settled usage" }),
    versions: {
      program: options.programVersion,
      sdk: options.sdkVersion,
      config: options.configHash,
      discoverPrompt: discovery?.versions.discoverPrompt ?? options.promptVersions?.discoverPrompt ?? "unavailable",
      verifyPrompt: discovery?.versions.verifyPrompt ?? options.promptVersions?.verifyPrompt ?? "unavailable",
    },
    durationMs,
  })
  return { result, markdown: renderMarkdown(result) }
}

export async function writeRunArtifacts(runDirectory: string, artifacts: RunArtifacts, options: {
  discovery?: DiscoveryVerificationResult; runtime?: RuntimeResult; candidates?: Candidate[];
  timing: { startedAt: string; deadline: string; preparationMs: number; analysisMs: number; attemptStartedAt?: string }
}): Promise<void> {
  const runtime = options.discovery?.runtime ?? options.runtime
  const writes: Array<[string, string]> = [
    ["result.json", `${JSON.stringify(artifacts.result, null, 2)}\n`],
    ["report.md", artifacts.markdown],
    ["coverage.json", `${JSON.stringify(artifacts.result.coverage, null, 2)}\n`],
    ["timing.json", `${JSON.stringify({ ...options.timing, durationMs: artifacts.result.durationMs, phases: runtime?.sessions.map(({ name, durationMs }) => ({ name, durationMs: durationMs ?? null })) ?? [] }, null, 2)}\n`],
    ["versions.json", `${JSON.stringify(artifacts.result.versions, null, 2)}\n`],
    ["candidates.json", `${JSON.stringify(options.discovery?.candidates ?? options.candidates ?? [], null, 2)}\n`],
    ["verifications.json", `${JSON.stringify(options.discovery?.verifications ?? [], null, 2)}\n`],
    ["tool-trace.json", `${JSON.stringify(runtime?.readBudget ?? { records: [], unavailable: true }, null, 2)}\n`],
    ["sessions.json", `${JSON.stringify(runtime?.sessions ?? [], null, 2)}\n`],
    ["usage.json", `${JSON.stringify(artifacts.result.usage, null, 2)}\n`],
    ["cleanup.json", `${JSON.stringify(runtime?.cleanup ?? { hostClosed: false, forced: false, notStarted: true }, null, 2)}\n`],
  ]
  await Promise.all(writes.map(async ([name, content]) => writeFile(join(runDirectory, name), content, { flag: "wx", mode: 0o600 })))
}
