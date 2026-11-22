import { createHash } from "node:crypto"
import { z } from "zod"
import { relativePathSchema, snapshotSchema, type CodeReference } from "./contracts"
import { commentIdSchema, digestSchema, gitShaSchema, instantSchema, type Sha256 } from "./identity"
import { actionsExecutionSchema, failureSchema, identitySchema, skipReasonSchema, type ActionsExecution, type PullRequestIdentity } from "./pr-contracts"

export const PRODUCT_MARKER = "ai-code-review:v1"
export const PRODUCT_BOT_POLICY = Object.freeze({ id: "41898282", login: "github-actions[bot]", type: "Bot" })
const STATE_TOKEN = "ai-code-review-state:v1"
export const STATE_BYTE_LIMIT = 16_384
export const ENCODED_STATE_BYTE_LIMIT = 21_846
export const VISIBLE_BYTE_LIMIT = 32_000
export const COMMENT_BYTE_LIMIT = 60_000

const boundedLocationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("inline"), side: z.enum(["merge-base", "head"]), path: relativePathSchema, startLine: z.int().positive(), endLine: z.int().positive() }),
  z.strictObject({ kind: z.literal("artifact"), referenceDigest: digestSchema }),
])
const issueSummarySchema = z.strictObject({
  ordinal: z.int().min(1).max(5), trigger: z.string().max(240), consequence: z.string().max(240),
  rootCause: z.string().max(240), verification: z.string().max(240), location: boundedLocationSchema, summarized: z.boolean(),
})
const reportSummarySchema = z.strictObject({
  status: z.enum(["complete", "partial"]), snapshot: snapshotSchema, execution: actionsExecutionSchema,
  resultDigest: digestSchema, completedAt: instantSchema, issues: z.array(issueSummarySchema).max(5),
  coverage: z.strictObject({ included: z.int().nonnegative(), omitted: z.int().nonnegative(), unverified: z.int().min(0).max(8), unpublished: z.int().min(0).max(8) }),
  usage: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("known"), inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative() }),
    z.strictObject({ kind: z.literal("unknown") }),
  ]),
  durationMs: z.int().nonnegative(), summarized: z.boolean(),
})
const freshnessSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("current") }),
  z.strictObject({ kind: z.literal("stale"), observedBase: gitShaSchema, observedHead: gitShaSchema, reason: z.enum(["base-changed", "head-changed", "base-and-head-changed", "closed", "draft", "fork"]) }),
  z.strictObject({ kind: z.literal("unconfirmed"), reason: z.literal("postcheck-unavailable") }),
  z.strictObject({ kind: z.literal("not-reviewed") }),
])
const publishedRunFields = { execution: actionsExecutionSchema, freshness: freshnessSchema }
const lastPublishedRunSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...publishedRunFields, status: z.enum(["complete", "partial"]), snapshot: snapshotSchema, resultDigest: digestSchema }),
  z.strictObject({ ...publishedRunFields, status: z.literal("failed"), snapshot: snapshotSchema.nullable(), resultDigest: digestSchema.nullable(), failure: failureSchema }),
  z.strictObject({ ...publishedRunFields, status: z.literal("skipped"), snapshot: snapshotSchema.nullable(), resultDigest: digestSchema, skipReason: skipReasonSchema }),
])
const commentStateObjectSchema = z.strictObject({
  schemaVersion: z.literal(1), identity: identitySchema, lastReport: reportSummarySchema.nullable(), lastPublishedRun: lastPublishedRunSchema,
  duplicateCommentIds: z.array(commentIdSchema).max(20), additionalDuplicateCount: z.int().nonnegative(),
})

export function runUrl(identity: PullRequestIdentity, execution: ActionsExecution): string {
  return `https://github.com/${identity.repository}/actions/runs/${execution.workflowRunId}/attempts/${execution.attempt}`
}

function compareInstants(left: string, right: string): number {
  const seconds = (value: string) => Date.parse(value.replace(/\.\d+(?=Z|[+-])/u, ""))
  const time = seconds(left) - seconds(right)
  if (time !== 0) return Math.sign(time)
  const leftFraction = /\.(\d+)/u.exec(left)?.[1] ?? ""
  const rightFraction = /\.(\d+)/u.exec(right)?.[1] ?? ""
  const length = Math.max(leftFraction.length, rightFraction.length)
  const a = leftFraction.padEnd(length, "0")
  const b = rightFraction.padEnd(length, "0")
  return a < b ? -1 : a > b ? 1 : 0
}

export function compareExecutions(left: ActionsExecution, right: ActionsExecution): number {
  if (left.workflowRunId === right.workflowRunId) return Math.sign(left.attempt - right.attempt)
  const time = compareInstants(left.triggeredAt, right.triggeredAt)
  if (time !== 0) return Math.sign(time)
  return BigInt(left.workflowRunId) < BigInt(right.workflowRunId) ? -1 : 1
}

export const commentStateSchema = commentStateObjectSchema.superRefine((state, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message })
  const publication = state.lastPublishedRun
  const reports = state.lastReport === null ? [] : [state.lastReport]
  for (const value of [publication, ...reports]) {
    if (compareInstants(value.execution.startedAt, value.execution.triggeredAt) < 0) invalid("execution cannot start before its trigger")
    if (value.execution.runUrl !== runUrl(state.identity, value.execution)) invalid("run URL must equal the fixed repository, run, and attempt route")
    if (value.snapshot !== null && !Object.values(value.snapshot).every((sha) => gitShaSchema.safeParse(sha).success)) invalid("comment snapshots require GitHub commit SHAs")
  }
  if ((publication.status === "complete" || publication.status === "partial") &&
    (state.lastReport === null || compareExecutions(state.lastReport.execution, publication.execution) !== 0)) invalid("usable publication requires its matching report")
  if (state.lastReport !== null) {
    if (compareInstants(state.lastReport.completedAt, state.lastReport.execution.startedAt) < 0) invalid("report completion cannot precede execution start")
    if (compareExecutions(state.lastReport.execution, publication.execution) > 0) invalid("lastReport cannot be newer than lastPublishedRun")
    for (const [index, issue] of state.lastReport.issues.entries()) {
      if (issue.ordinal !== index + 1) invalid("issue ordinals must be continuous")
      if (issue.location.kind === "inline" && issue.location.endLine < issue.location.startLine) invalid("citation line range is inverted")
    }
    if (compareExecutions(state.lastReport.execution, publication.execution) === 0 &&
      (state.lastReport.resultDigest !== publication.resultDigest || state.lastReport.status !== publication.status ||
        canonicalJson(state.lastReport.snapshot) !== canonicalJson(publication.snapshot) ||
        canonicalJson(state.lastReport.execution) !== canonicalJson(publication.execution))) invalid("same publication report must match status, snapshot, and digest")
  }
  if (new Set(state.duplicateCommentIds).size !== state.duplicateCommentIds.length) invalid("duplicate comment IDs must be unique")
})
export type CommentState = z.infer<typeof commentStateSchema>
export type ReportSummary = z.infer<typeof reportSummarySchema>
export type CommentFreshness = z.infer<typeof freshnessSchema>

export function canonicalJson(value: unknown): string {
  const encode = (item: unknown): string | undefined => {
    if (Array.isArray(item)) return `[${item.map((child) => encode(child) ?? "null").join(",")}]`
    if (item !== null && typeof item === "object") {
      const fields: string[] = []
      for (const [key, child] of Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        const encoded = encode(child)
        if (encoded !== undefined) fields.push(`${JSON.stringify(key)}:${encoded}`)
      }
      return `{${fields.join(",")}}`
    }
    return JSON.stringify(item)
  }
  const encoded = encode(value)
  if (encoded === undefined) throw new Error("comment state is not JSON")
  return encoded
}

export function markerLine(identity: PullRequestIdentity): string {
  return `<!-- ${PRODUCT_MARKER} repo=${identity.repositoryId} pr=${identity.pr} -->`
}

export function encodeStateBlock(state: CommentState): string {
  const bytes = Buffer.from(canonicalJson(commentStateSchema.parse(state)), "utf8")
  if (bytes.byteLength > STATE_BYTE_LIMIT) throw new Error("comment state exceeds 16 KiB")
  const encoded = bytes.toString("base64url")
  if (encoded.length > ENCODED_STATE_BYTE_LIMIT) throw new Error("encoded comment state exceeds its cap")
  return [`<!-- ${STATE_TOKEN}`, encoded, "-->"].join("\n")
}

export function parseStateBlock(body: string, identity?: PullRequestIdentity): CommentState {
  if (Buffer.byteLength(body) > COMMENT_BYTE_LIMIT) throw new Error("comment exceeds its byte cap")
  if (body.split(PRODUCT_MARKER).length !== 2 || body.split(STATE_TOKEN).length !== 2) throw new Error("comment must contain exactly one marker and state block")
  const match = /\n<!-- ai-code-review-state:v1\n([A-Za-z0-9_-]+)\n-->$/u.exec(body)
  if (match === null || !body.endsWith(match[0])) throw new Error("comment state block must be canonical and final")
  const encoded = match[1]!
  if (encoded.length > ENCODED_STATE_BYTE_LIMIT || Math.floor(encoded.length * 3 / 4) > STATE_BYTE_LIMIT) throw new Error("decoded state exceeds its byte cap")
  const bytes = Buffer.from(encoded, "base64url")
  if (bytes.byteLength > STATE_BYTE_LIMIT || bytes.toString("base64url") !== encoded) throw new Error("state is not canonical base64url")
  const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  const state = commentStateSchema.parse(JSON.parse(json))
  if (canonicalJson(state) !== json) throw new Error("state JSON must be canonical")
  if (body.split("\n", 1)[0] !== markerLine(state.identity)) throw new Error("state identity differs from marker")
  if (identity !== undefined && canonicalJson(state.identity) !== canonicalJson(identity)) throw new Error("comment identity differs from requested PR")
  if (Buffer.byteLength(body.slice(0, match.index).replace(/\n$/u, "")) > VISIBLE_BYTE_LIMIT) throw new Error("visible comment exceeds its byte cap")
  return state
}

export function sanitizeCommentText(value: string): string {
  const text = value.replaceAll("<!--", "<! -").replaceAll(PRODUCT_MARKER, "ai-code-review (marker removed)")
    .replaceAll(STATE_TOKEN, "ai-code-review-state (marker removed)").replace(/\r\n?/gu, "\n").replace(/\n/gu, " ")
  return Array.from(text, (char) => {
    const code = char.codePointAt(0)!
    return code >= 33 && code <= 47 || code >= 58 && code <= 64 || code >= 91 && code <= 96 || code >= 123 && code <= 126 ? `&#${code};` : char
  }).join("")
}

export function truncateSummary(value: string, limit: number): { text: string; summarized: boolean } {
  const normalized = value.replace(/\r\n?/gu, "\n")
  if (normalized.length <= limit) return { text: normalized, summarized: false }
  if (limit === 0) return { text: "", summarized: true }
  let end = Math.max(0, limit - 1)
  if (end > 0 && /[\uD800-\uDBFF]/u.test(normalized[end - 1]!) && /[\uDC00-\uDFFF]/u.test(normalized[end]!)) end -= 1
  return { text: `${normalized.slice(0, end)}…`, summarized: true }
}

export function referenceDigest(reference: CodeReference): Sha256 {
  return digestSchema.parse(createHash("sha256").update(canonicalJson(reference)).digest("hex"))
}

function visibleBody(state: CommentState): string {
  const published = state.lastPublishedRun
  const lines = [markerLine(state.identity), "", "## AI code review", "", `Repository: ${sanitizeCommentText(state.identity.repository)}. PR ${state.identity.pr}.`, ""]
  if (published.status === "failed") {
    lines.push("Review failed. This run has no usable report.", `Failure: ${sanitizeCommentText(published.failure.message)}`)
  } else if (published.status === "skipped") lines.push(`Review skipped. Reason: ${sanitizeCommentText(published.skipReason)}.`)
  else if (published.status === "partial") lines.push(state.lastReport?.issues.length === 0 ? "Partial review. No verified findings in the completed work." : "Partial review. Verified findings in the completed work follow.")
  else lines.push(state.lastReport?.issues.length === 0 ? "Complete review. No verified findings." : "Complete review. Verified findings follow.")
  const freshness = published.freshness
  if (freshness.kind === "stale") lines.push("", `**Stale review. ${freshness.reason}.**`, `Observed base: ${freshness.observedBase}. Observed head: ${freshness.observedHead}.`)
  if (freshness.kind === "unconfirmed") lines.push("", "**Freshness unconfirmed. The post-write PR check was unavailable.**")
  if (freshness.kind === "not-reviewed") lines.push("", "This run did not review the current PR.")
  if (published.snapshot !== null) lines.push("", `Covered base: ${published.snapshot.baseSha}. Covered head: ${published.snapshot.headSha}.`)
  lines.push("", `[Run ${published.execution.workflowRunId}, attempt ${published.execution.attempt}](${runUrl(state.identity, published.execution)})`)
  if (state.duplicateCommentIds.length > 0 || state.additionalDuplicateCount > 0) lines.push("", `Warning: duplicate bot comments ${state.duplicateCommentIds.join(", ")}${state.additionalDuplicateCount > 0 ? ` and ${state.additionalDuplicateCount} more` : ""}.`)
  const report = state.lastReport
  if (report !== null) {
    if (published.status === "failed" || published.status === "skipped") lines.push("", "### Last usable report", "", `Retained ${report.status} report. Covered base: ${report.snapshot.baseSha}. Covered head: ${report.snapshot.headSha}.`, `[Report run ${report.execution.workflowRunId}, attempt ${report.execution.attempt}](${runUrl(state.identity, report.execution)})`)
    for (const issue of report.issues) {
      lines.push("", `### ${issue.ordinal}. Finding${issue.summarized ? " (summarized)" : ""}`, `Trigger: ${sanitizeCommentText(issue.trigger) || "…"}`, `Consequence: ${sanitizeCommentText(issue.consequence) || "…"}`, `Root cause: ${sanitizeCommentText(issue.rootCause) || "…"}`, `Verification: ${sanitizeCommentText(issue.verification) || "…"}`)
      const location = issue.location
      if (location.kind === "artifact") lines.push(`Citation: [full citation in run artifacts](${runUrl(state.identity, report.execution)}) (SHA-256 ${location.referenceDigest}).`)
      else {
        const sha = location.side === "head" ? report.snapshot.headSha : report.snapshot.mergeBaseSha
        const path = location.path.split("/").map((segment) => encodeURIComponent(segment).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/")
        lines.push(`Citation: [${sanitizeCommentText(location.path)}:${location.startLine}-${location.endLine} (${location.side})](https://github.com/${state.identity.repository}/blob/${sha}/${path}#L${location.startLine}-L${location.endLine}).`)
      }
    }
    lines.push("", `Coverage: ${report.coverage.included} included, ${report.coverage.omitted} omitted, ${report.coverage.unverified} unverified, ${report.coverage.unpublished} unpublished.`, report.usage.kind === "known" ? `Usage: ${report.usage.inputTokens} input tokens, ${report.usage.outputTokens} output tokens.` : "Usage: unknown.", `Duration: ${report.durationMs} ms.`)
    if (report.summarized) lines.push("", `Summarized. [Full report and evidence in run artifacts](${runUrl(state.identity, report.execution)}).`)
  }
  return lines.join("\n")
}

export function renderComment(state: CommentState, references: ReadonlyMap<number, CodeReference> = new Map()): { state: CommentState; body: string } {
  const bounded = commentStateSchema.parse(state)
  // A later stale annotation must fit without changing the already published report summary.
  const fits = () => {
    const stale: CommentState = { ...bounded, lastPublishedRun: { ...bounded.lastPublishedRun, freshness: {
      kind: "stale", observedBase: gitShaSchema.parse("f".repeat(40)), observedHead: gitShaSchema.parse("f".repeat(40)), reason: "base-and-head-changed",
    } } }
    return [bounded, stale].every((candidate) => Buffer.byteLength(canonicalJson(candidate)) <= STATE_BYTE_LIMIT && Buffer.byteLength(visibleBody(candidate)) <= VISIBLE_BYTE_LIMIT)
  }
  const report = bounded.lastReport
  if (report !== null && (bounded.lastPublishedRun.status === "complete" || bounded.lastPublishedRun.status === "partial")) {
    for (const limit of [240, 120, 60, 0]) {
      for (const issue of [...report.issues].reverse()) {
        for (const field of ["verification", "rootCause", "trigger", "consequence"] as const) {
          if (limit !== 240 && fits()) break
          const trimmed = truncateSummary(issue[field], limit)
          issue[field] = trimmed.text
          issue.summarized ||= trimmed.summarized
          report.summarized ||= trimmed.summarized
        }
      }
      if (fits()) break
    }
    if (!fits()) {
      for (const issue of [...report.issues].reverse()) {
        if (issue.location.kind === "inline") {
          const reference = references.get(issue.ordinal)
          if (reference === undefined) throw new Error("a full original reference is required to summarize an oversized citation")
          issue.location = { kind: "artifact", referenceDigest: referenceDigest(reference) }
          issue.summarized = true
          report.summarized = true
        }
        if (fits()) break
      }
    }
  }
  if (!fits()) throw new Error("the minimal comment state exceeds its publication byte caps")
  const visible = visibleBody(bounded)
  const body = `${visible}\n\n${encodeStateBlock(bounded)}`
  if (Buffer.byteLength(body) > COMMENT_BYTE_LIMIT) throw new Error("comment body exceeds 60,000 bytes")
  return { state: bounded, body }
}

export function renderCommentBody(state: CommentState): string {
  return renderComment(state).body
}

type ScannableComment = { id: string; authorId: string; authorLogin: string; authorType: string; body: string }
export function scanProductComments<T extends ScannableComment>(comments: readonly T[], identity: PullRequestIdentity): { canonical: T | null; duplicates: T[]; humanMarkerIds: string[] } {
  const owned: T[] = []
  const humanMarkerIds: string[] = []
  for (const comment of comments) {
    if (comment.body.split("\n", 1)[0] !== markerLine(identity)) continue
    if (comment.authorId === PRODUCT_BOT_POLICY.id && comment.authorLogin === PRODUCT_BOT_POLICY.login && comment.authorType === PRODUCT_BOT_POLICY.type) owned.push(comment)
    else humanMarkerIds.push(comment.id)
  }
  owned.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0)
  return { canonical: owned[0] ?? null, duplicates: owned.slice(1), humanMarkerIds }
}
