import { z } from "zod"

const shaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
export const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
export const textSchema = z.string().trim().min(1).max(2_000)

export const relativePathSchema = z.string().min(1).max(1_024).refine((path) => {
  if (path.includes("\\") || path.includes("\0") || path.startsWith("/")) return false
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
}, "expected a normalized relative POSIX path")

export const snapshotSchema = z.strictObject({
  baseSha: shaSchema,
  headSha: shaSchema,
  mergeBaseSha: shaSchema,
})

export const codeReferenceSchema = z.strictObject({
  side: z.enum(["merge-base", "head"]),
  path: relativePathSchema,
  startLine: z.int().positive(),
  endLine: z.int().positive(),
  excerpt: z.string().min(1).max(500),
}).refine((reference) => reference.endLine >= reference.startLine, {
  message: "endLine must be at least startLine",
  path: ["endLine"],
})

export const candidateSchema = z.strictObject({
  id: identifierSchema,
  changeLocation: codeReferenceSchema,
  trigger: textSchema,
  consequence: textSchema,
  rootCause: textSchema,
  citations: z.array(codeReferenceSchema).min(1).max(12),
}).refine((candidate) => candidate.changeLocation.side === "head", {
  message: "changeLocation must refer to head",
  path: ["changeLocation", "side"],
})

const verificationFields = {
  candidateId: identifierSchema,
  reason: textSchema,
}

const keptVerificationSchema = z.strictObject({
  ...verificationFields,
  decision: z.literal("keep"),
  evidence: z.array(codeReferenceSchema).min(1).max(12),
})

export const verificationSchema = z.discriminatedUnion("decision", [
  keptVerificationSchema,
  z.strictObject({
    ...verificationFields,
    decision: z.literal("reject"),
    evidence: z.array(codeReferenceSchema).min(1).max(12),
  }),
  z.strictObject({
    ...verificationFields,
    decision: z.literal("unknown"),
    evidence: z.array(codeReferenceSchema).max(12),
  }),
])

export const discoveryOutputSchema = z.strictObject({
  candidates: z.array(candidateSchema).max(8),
}).refine((output) => new Set(output.candidates.map((candidate) => candidate.id)).size === output.candidates.length, {
  message: "candidate IDs must be unique",
  path: ["candidates"],
})

export const verificationOutputSchema = z.strictObject({
  verifications: z.array(verificationSchema).max(8),
}).refine((output) => new Set(output.verifications.map((verification) => verification.candidateId)).size ===
  output.verifications.length, {
  message: "verification candidate IDs must be unique",
  path: ["verifications"],
})

const verifiedIssueSchema = z.strictObject({
  candidate: candidateSchema,
  verification: keptVerificationSchema,
}).refine((issue) => issue.verification.candidateId === issue.candidate.id, {
  message: "a published issue requires a matching keep verification",
})

const coverageSchema = z.strictObject({
  includedPaths: z.array(relativePathSchema),
  omittedPaths: z.array(z.string().min(1)),
  unverifiedCandidateIds: z.array(identifierSchema),
  unpublishedCandidateIds: z.array(identifierSchema).default([]),
  notes: z.array(textSchema),
})

const stageErrorSchema = z.strictObject({
  stage: z.enum(["input", "preparation", "discovery", "verification", "report"]),
  code: identifierSchema,
  message: textSchema,
})

const usageSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("known"),
    inputTokens: z.int().nonnegative(),
    outputTokens: z.int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("unknown"),
    reason: textSchema,
  }),
])

export const MAX_PUBLISHED_ISSUES = 5

// These refinements are shared by the legacy local result and the widened PR result, so both
// boundaries reject the same terminal-state contradictions. The predicates take structural
// supertypes of both inferred outputs.
export const completeResultCoversAllWork = (result: {
  status: string
  coverage: { omittedPaths: readonly unknown[]; unverifiedCandidateIds: readonly unknown[]; unpublishedCandidateIds: readonly unknown[] }
  stageErrors: readonly unknown[]
}): boolean => result.status !== "complete" || (
  result.coverage.omittedPaths.length === 0 &&
  result.coverage.unverifiedCandidateIds.length === 0 &&
  result.coverage.unpublishedCandidateIds.length === 0 &&
  result.stageErrors.length === 0
)

export const terminalResultPublishesNoIssues = (result: { status: string; issues: readonly unknown[] }): boolean =>
  (result.status !== "failed" && result.status !== "skipped") || result.issues.length === 0

export const reviewResultObjectSchema = z.strictObject({
  runId: identifierSchema,
  snapshot: snapshotSchema,
  status: z.enum(["complete", "partial", "failed", "skipped"]),
  issues: z.array(verifiedIssueSchema).max(MAX_PUBLISHED_ISSUES),
  coverage: coverageSchema,
  stageErrors: z.array(stageErrorSchema),
  usage: usageSchema,
  versions: z.strictObject({
    program: textSchema,
    sdk: textSchema,
    config: textSchema,
    discoverPrompt: textSchema,
    verifyPrompt: textSchema,
  }),
  durationMs: z.int().nonnegative(),
})

export const reviewResultSchema = reviewResultObjectSchema
  .refine(completeResultCoversAllWork, {
    message: "complete results cannot have uncovered work or stage errors",
  }).refine(terminalResultPublishesNoIssues, {
    message: "failed and skipped results cannot publish issues",
  })

export type Snapshot = z.infer<typeof snapshotSchema>
export type CodeReference = z.infer<typeof codeReferenceSchema>
export type Candidate = z.infer<typeof candidateSchema>
export type DiscoveryOutput = z.infer<typeof discoveryOutputSchema>
export type Verification = z.infer<typeof verificationSchema>
export type KeptVerification = z.infer<typeof keptVerificationSchema>
export type VerificationOutput = z.infer<typeof verificationOutputSchema>
export type ReviewResult = z.infer<typeof reviewResultSchema>

export type PublishedIssue = { candidate: Candidate; verification: KeptVerification }

// The assembler and the PR checkpoint reducer must publish accepted keeps identically: discovery
// order, deduplicated by change location and normalized root cause, capped for publication, with
// keeps past the cap reported as unpublished instead of silently dropped.
export function deriveKeepPublication(candidates: readonly Candidate[], verifications: readonly Verification[]): {
  published: PublishedIssue[]
  unpublishedCandidateIds: string[]
} {
  const byId = new Map(verifications.map((verification) => [verification.candidateId, verification]))
  const seen = new Set<string>()
  const deduped: PublishedIssue[] = []
  for (const candidate of candidates) {
    const verification = byId.get(candidate.id)
    if (verification?.decision !== "keep") continue
    const key = JSON.stringify([
      candidate.changeLocation.path,
      candidate.changeLocation.startLine,
      candidate.changeLocation.endLine,
      candidate.rootCause.trim().replace(/\s+/gu, " ").toLowerCase(),
    ])
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push({ candidate, verification })
  }
  return {
    published: deduped.slice(0, MAX_PUBLISHED_ISSUES),
    unpublishedCandidateIds: deduped.slice(MAX_PUBLISHED_ISSUES).map(({ candidate }) => candidate.id),
  }
}

// An empty file has zero lines, and a trailing newline does not add one.
export const splitLines = (source: string): string[] =>
  source === "" ? [] : source.replace(/\r?\n$/u, "").split(/\r?\n/u)

export const parseSnapshot = (value: unknown): Snapshot => snapshotSchema.parse(value)
export const parseCandidate = (value: unknown): Candidate => candidateSchema.parse(value)
export const parseDiscoveryOutput = (value: unknown): DiscoveryOutput => discoveryOutputSchema.parse(value)
export const parseVerification = (value: unknown): Verification => verificationSchema.parse(value)
export const parseVerificationOutput = (value: unknown): VerificationOutput => verificationOutputSchema.parse(value)
export const parseReviewResult = (value: unknown): ReviewResult => reviewResultSchema.parse(value)
