import { expect, test } from "bun:test"
import { parseCandidate, parseDiscoveryOutput, parseReviewResult, parseSnapshot, parseVerification, parseVerificationOutput } from "./contracts"

const sha = "a".repeat(40)
const reference = { side: "head", path: "src/example/OrderService.java", startLine: 9, endLine: 9, excerpt: "return null;" }
const candidate = {
  id: "C-1",
  changeLocation: reference,
  trigger: "No orders exist for the customer",
  consequence: "The caller throws instead of returning zero",
  rootCause: "A nullable result is iterated without a guard",
  citations: [reference],
}
const verification = { candidateId: "C-1", decision: "keep", reason: "The caller has no guard", evidence: [reference] }

test("parses the minimal review contracts", () => {
  const snapshot = parseSnapshot({ baseSha: sha, headSha: sha, mergeBaseSha: sha })
  expect(parseCandidate(candidate).id).toBe("C-1")
  expect(parseVerification(verification).decision).toBe("keep")
  expect(parseReviewResult({
    runId: "run-1",
    snapshot,
    status: "complete",
    issues: [{ candidate, verification }],
    coverage: { includedPaths: [reference.path], omittedPaths: [], unverifiedCandidateIds: [], notes: [] },
    stageErrors: [],
    usage: { kind: "known", inputTokens: 10, outputTokens: 20 },
    versions: { program: "0.1", sdk: "2.2.7", config: "v1", discoverPrompt: "v1", verifyPrompt: "v1" },
    durationMs: 25,
  }).issues).toHaveLength(1)
})

test("rejects unresolved SHAs, unsafe paths, invalid ranges, and missing claims", () => {
  expect(() => parseSnapshot({ baseSha: "main", headSha: sha, mergeBaseSha: sha })).toThrow()
  expect(() => parseCandidate({ ...candidate, citations: [{ ...reference, path: "../secret" }] })).toThrow()
  expect(() => parseCandidate({ ...candidate, changeLocation: { ...reference, startLine: 10, endLine: 9 } })).toThrow()
  expect(() => parseCandidate({ ...candidate, trigger: " " })).toThrow()
  expect(() => parseCandidate({ ...candidate, changeLocation: { ...reference, side: "merge-base" } })).toThrow()
})

test("requires evidence for a conclusive verification", () => {
  expect(() => parseVerification({ ...verification, evidence: [] })).toThrow()
  expect(parseVerification({ candidateId: "C-1", decision: "unknown", reason: "Caller is unavailable", evidence: [] }).decision).toBe("unknown")
})

test("discovery output has unique candidate IDs and a fixed limit", () => {
  expect(parseDiscoveryOutput({ candidates: [candidate] }).candidates).toHaveLength(1)
  expect(() => parseDiscoveryOutput({ candidates: [candidate, candidate] })).toThrow()
  expect(() => parseDiscoveryOutput({ candidates: Array.from({ length: 9 }, (_, i) => ({ ...candidate, id: `C-${i}` })) })).toThrow()
})

test("verification output has unique candidate IDs and a fixed limit", () => {
  expect(parseVerificationOutput({ verifications: [verification] }).verifications).toHaveLength(1)
  expect(() => parseVerificationOutput({ verifications: [verification, verification] })).toThrow()
  expect(() => parseVerificationOutput({
    verifications: Array.from({ length: 9 }, (_, i) => ({ ...verification, candidateId: `C-${i}` })),
  })).toThrow()
})

test("rejects published issues without a matching keep decision", () => {
  const result = {
    runId: "run-1",
    snapshot: { baseSha: sha, headSha: sha, mergeBaseSha: sha },
    status: "complete",
    issues: [{ candidate, verification: { ...verification, candidateId: "C-2" } }],
    coverage: { includedPaths: [], omittedPaths: [], unverifiedCandidateIds: [], notes: [] },
    stageErrors: [],
    usage: { kind: "unknown", reason: "session interrupted" },
    versions: { program: "0.1", sdk: "2.2.7", config: "v1", discoverPrompt: "v1", verifyPrompt: "v1" },
    durationMs: 0,
  }
  expect(() => parseReviewResult(result)).toThrow()
  expect(() => parseReviewResult({
    ...result,
    issues: [{ candidate, verification }],
    coverage: { ...result.coverage, omittedPaths: [reference.path] },
  })).toThrow()
  expect(() => parseReviewResult({ ...result, status: "failed", issues: [{ candidate, verification }] })).toThrow()
})
