import { expect, test } from "bun:test"
import { canonicalJson, COMMENT_BYTE_LIMIT, commentStateSchema, compareExecutions, encodeStateBlock, ENCODED_STATE_BYTE_LIMIT, markerLine, parseStateBlock, referenceDigest, renderComment, renderCommentBody, runUrl, sanitizeCommentText, scanProductComments, STATE_BYTE_LIMIT, truncateSummary, VISIBLE_BYTE_LIMIT, type CommentState } from "./comment"
import type { CodeReference } from "./contracts"
import { actionsExecutionSchema, identitySchema } from "./pr-contracts"

const instant = "2026-11-21T10:00:00Z"
const identity = identitySchema.parse({ repositoryId: "123", repository: "owner/repo", pr: 17 })
const execution = actionsExecutionSchema.parse({ kind: "actions", reviewRunId: "gh-1234-1", workflowRunId: "1234", attempt: 1,
  trigger: { kind: "manual" }, triggeredAt: instant, startedAt: instant, runUrl: "https://github.com/owner/repo/actions/runs/1234/attempts/1" })
const snapshot = { baseSha: "a".repeat(40), headSha: "b".repeat(40), mergeBaseSha: "c".repeat(40) }
const digest = "d".repeat(64)
function rawState(status: "complete" | "partial" = "complete") {
  return { schemaVersion: 1, identity, lastReport: { status, snapshot, execution, resultDigest: digest, completedAt: instant, issues: [],
    coverage: { included: 2, omitted: 0, unverified: 0, unpublished: 0 }, usage: { kind: "known", inputTokens: 10, outputTokens: 20 }, durationMs: 25, summarized: false },
  lastPublishedRun: { execution, freshness: { kind: "current" }, status, snapshot, resultDigest: digest }, duplicateCommentIds: [], additionalDuplicateCount: 0 }
}
const state = (status: "complete" | "partial" = "complete") => commentStateSchema.parse(rawState(status))
const reference: CodeReference = { side: "head", path: "src/OrderService.java", startLine: 42, endLine: 45, excerpt: "return null;" }
function issue(ordinal: number, text = "reason", path = reference.path) {
  return { ordinal, trigger: text, consequence: text, rootCause: text, verification: text,
    location: { kind: "inline", side: "head", path, startLine: 42, endLine: 45 }, summarized: false }
}
function withIssues(issues: ReturnType<typeof issue>[]): CommentState {
  const raw = rawState()
  return commentStateSchema.parse({ ...raw, lastReport: { ...raw.lastReport, issues } })
}
const rawBlock = (value: unknown) => `<!-- ai-code-review-state:v1\n${Buffer.from(canonicalJson(value)).toString("base64url")}\n-->`
const rawBody = (value: unknown) => `${markerLine(identity)}\n\n${rawBlock(value)}`

test("canonical JSON recursively sorts keys and preserves array order and string escaping", () => {
  expect(canonicalJson({ z: [{ b: "\n\"", a: "é" }, 3, 1], a: { y: true, x: null } }))
    .toBe('{"a":{"x":null,"y":true},"z":[{"a":"é","b":"\\n\\\""},3,1]}')
  expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
  expect(canonicalJson({ "2": 2, "10": 10, nested: { "20": 20, "3": 3 } })).toBe('{"10":10,"2":2,"nested":{"20":20,"3":3}}')
})

test("renderer state round trips exactly and is deterministic", () => {
  const original = withIssues([issue(1)])
  const first = renderCommentBody(original)
  expect(parseStateBlock(first, identity)).toEqual(original)
  expect(renderCommentBody(parseStateBlock(first))).toBe(first)
  expect(renderCommentBody(original)).toBe(first)
  expect(first.startsWith(`${markerLine(identity)}\n`)).toBe(true)
  expect(first).toContain("src&#47;OrderService&#46;java:42-45 (head)")
  expect(first).not.toContain(reference.excerpt)
  expect(first).toContain(`/blob/${snapshot.headSha}/src/OrderService.java#L42-L45`)
})

const zeroVisible = (status: "complete" | "partial") => `${markerLine(identity)}

## AI code review

Repository: owner&#47;repo. PR 17.

${status === "partial" ? "Partial review. No verified findings in the completed work." : "Complete review. No verified findings."}

Covered base: ${snapshot.baseSha}. Covered head: ${snapshot.headSha}.

[Run 1234, attempt 1](https://github.com/owner/repo/actions/runs/1234/attempts/1)

Coverage: 2 included, 0 omitted, 0 unverified, 0 unpublished.
Usage: 10 input tokens, 20 output tokens.
Duration: 25 ms.`

test.each(["complete", "partial"] as const)("%s zero findings has its exact visible golden text", (status) => {
  expect(renderCommentBody(state(status)).split("\n\n<!-- ai-code-review-state:v1")[0]).toBe(zeroVisible(status))
})

test("failed publication has its exact visible golden text", () => {
  const failed = commentStateSchema.parse({ ...rawState(), lastReport: null, lastPublishedRun: { status: "failed", execution,
    snapshot: null, resultDigest: null, freshness: { kind: "not-reviewed" }, failure: { code: "artifact-missing", stage: "publish", message: "No artifact exists." } } })
  expect(renderCommentBody(failed).split("\n\n<!-- ai-code-review-state:v1")[0]).toBe(`${markerLine(identity)}

## AI code review

Repository: owner&#47;repo. PR 17.

Review failed. This run has no usable report.
Failure: No artifact exists&#46;

This run did not review the current PR.

[Run 1234, attempt 1](https://github.com/owner/repo/actions/runs/1234/attempts/1)`)
})

test("retained reports show their own status, commit, and run", () => {
  const failed = commentStateSchema.parse({ ...rawState(), lastPublishedRun: { status: "failed", execution: { ...execution, reviewRunId: "gh-1234-2", attempt: 2,
    runUrl: "https://github.com/owner/repo/actions/runs/1234/attempts/2" }, snapshot: null, resultDigest: null,
  freshness: { kind: "not-reviewed" }, failure: { code: "artifact-missing", stage: "publish", message: "No artifact exists." } } })
  const body = renderCommentBody(failed)
  expect(body).toContain("### Last usable report")
  expect(body).toContain(`Retained complete report. Covered base: ${snapshot.baseSha}. Covered head: ${snapshot.headSha}.`)
  expect(body).toContain("[Report run 1234, attempt 1]")
})

test.each([
  ["wrong schema", (s: ReturnType<typeof rawState>) => ({ ...s, schemaVersion: 2 })],
  ["wrong repository ID", (s: ReturnType<typeof rawState>) => ({ ...s, identity: { ...s.identity, repositoryId: "00123" } })],
  ["wrong PR", (s: ReturnType<typeof rawState>) => ({ ...s, identity: { ...s.identity, pr: 0 } })],
  ["missing report", (s: ReturnType<typeof rawState>) => ({ ...s, lastReport: null })],
  ["wrong URL origin", (s: ReturnType<typeof rawState>) => ({ ...s, lastPublishedRun: { ...s.lastPublishedRun, execution: { ...execution, runUrl: "https://evil.invalid/" } } })],
  ["wrong URL repository", (s: ReturnType<typeof rawState>) => ({ ...s, identity: { ...identity, repository: "other/repo" } })],
  ["wrong URL attempt", (s: ReturnType<typeof rawState>) => ({ ...s, lastPublishedRun: { ...s.lastPublishedRun, execution: { ...execution, runUrl: "https://github.com/owner/repo/actions/runs/1234/attempts/2" } } })],
  ["wrong run ID", (s: ReturnType<typeof rawState>) => ({ ...s, lastPublishedRun: { ...s.lastPublishedRun, execution: { ...execution, reviewRunId: "gh-1234-2" } } })],
  ["local trigger", (s: ReturnType<typeof rawState>) => ({ ...s, lastPublishedRun: { ...s.lastPublishedRun, execution: { ...execution, trigger: { kind: "local" } } } })],
  ["bad SHA", (s: ReturnType<typeof rawState>) => ({ ...s, lastReport: { ...s.lastReport, snapshot: { ...snapshot, headSha: "x".repeat(40) } } })],
  ["non-GitHub SHA", (s: ReturnType<typeof rawState>) => ({ ...s, lastReport: { ...s.lastReport, snapshot: { ...snapshot, headSha: "a".repeat(64) } } })],
  ["missing digest", (s: ReturnType<typeof rawState>) => ({ ...s, lastPublishedRun: { ...s.lastPublishedRun, resultDigest: undefined } })],
  ["missing snapshot", (s: ReturnType<typeof rawState>) => ({ ...s, lastPublishedRun: { ...s.lastPublishedRun, snapshot: null } })],
  ["conflicting report digest", (s: ReturnType<typeof rawState>) => ({ ...s, lastReport: { ...s.lastReport, resultDigest: "e".repeat(64) } })],
  ["conflicting report status", (s: ReturnType<typeof rawState>) => ({ ...s, lastReport: { ...s.lastReport, status: "partial" } })],
  ["noncontinuous ordinals", (s: ReturnType<typeof rawState>) => ({ ...s, lastReport: { ...s.lastReport, issues: [issue(2)] } })],
  ["duplicate ordinals", (s: ReturnType<typeof rawState>) => ({ ...s, lastReport: { ...s.lastReport, issues: [issue(1), issue(1)] } })],
  ["inverted line range", (s: ReturnType<typeof rawState>) => ({ ...s, lastReport: { ...s.lastReport, issues: [{ ...issue(1), location: { ...issue(1).location, endLine: 41 } }] } })],
  ["zero line", (s: ReturnType<typeof rawState>) => ({ ...s, lastReport: { ...s.lastReport, issues: [{ ...issue(1), location: { ...issue(1).location, startLine: 0 } }] } })],
  ["more than five issues", (s: ReturnType<typeof rawState>) => ({ ...s, lastReport: { ...s.lastReport, issues: Array.from({ length: 6 }, (_, i) => issue(i + 1)) } })],
  ["too long prose", (s: ReturnType<typeof rawState>) => ({ ...s, lastReport: { ...s.lastReport, issues: [issue(1, "x".repeat(241))] } })],
  ["too many duplicates", (s: ReturnType<typeof rawState>) => ({ ...s, duplicateCommentIds: Array.from({ length: 21 }, (_, i) => `${i + 1}`) })],
  ["duplicate IDs", (s: ReturnType<typeof rawState>) => ({ ...s, duplicateCommentIds: ["9", "9"] })],
  ["negative extra duplicates", (s: ReturnType<typeof rawState>) => ({ ...s, additionalDuplicateCount: -1 })],
  ["completion before start", (s: ReturnType<typeof rawState>) => ({ ...s, lastReport: { ...s.lastReport, completedAt: "2026-11-21T09:59:59Z" } })],
  ["failed without failure", (s: ReturnType<typeof rawState>) => ({ ...s, lastReport: null, lastPublishedRun: { status: "failed", execution, freshness: { kind: "not-reviewed" }, snapshot: null, resultDigest: null } })],
  ["skipped without reason", (s: ReturnType<typeof rawState>) => ({ ...s, lastReport: null, lastPublishedRun: { status: "skipped", execution, freshness: { kind: "not-reviewed" }, snapshot: null, resultDigest: digest } })],
])("parsed state rejects %s", (_name, mutate) => {
  const value = mutate(rawState())
  expect(() => parseStateBlock(rawBody(value), identity)).toThrow()
})

test("a report cannot be newer than the last publication across runs or attempts", () => {
  for (const newer of [
    { ...execution, attempt: 2, reviewRunId: "gh-1234-2", runUrl: "https://github.com/owner/repo/actions/runs/1234/attempts/2" },
    { ...execution, workflowRunId: "1235", reviewRunId: "gh-1235-1", runUrl: "https://github.com/owner/repo/actions/runs/1235/attempts/1" },
  ]) expect(() => parseStateBlock(rawBody({ ...rawState(), lastReport: { ...rawState().lastReport, execution: newer } }))).toThrow()
})

test("execution ordering compares exact instants and BigInt run IDs", () => {
  const a = actionsExecutionSchema.parse({ ...execution, workflowRunId: "9007199254740992", reviewRunId: "gh-9007199254740992-1" })
  const b = actionsExecutionSchema.parse({ ...a, workflowRunId: "9007199254740993", reviewRunId: "gh-9007199254740993-1" })
  expect(compareExecutions(a, b)).toBe(-1)
  expect(compareExecutions(b, a)).toBe(1)
  expect(compareExecutions({ ...a, triggeredAt: "2026-11-21T11:00:00+01:00" }, b)).toBe(-1)
  expect(compareExecutions({ ...a, triggeredAt: "2026-11-21T10:00:00.000000001Z" }, b)).toBe(1)
  expect(compareExecutions(execution, execution)).toBe(0)
})

test.each([
  ["second marker", (body: string) => body.replace("## AI", "ai-code-review:v1\n## AI")],
  ["second block", (body: string) => `${body}\n${encodeStateBlock(state())}`],
  ["padding", (body: string) => body.replace(/\n-->$/u, "=\n-->")],
  ["state whitespace", (body: string) => body.replace("<!-- ai-code-review-state:v1\n", "<!-- ai-code-review-state:v1\n ")],
  ["nonfinal block", (body: string) => `${body}\nextra`],
  ["leading whitespace", (body: string) => ` ${body}`],
  ["wrong marker identity", (body: string) => body.replace("repo=123", "repo=124")],
  ["trailing newline", (body: string) => `${body}\n`],
])("strict parser rejects %s", (_name, mutate) => expect(() => parseStateBlock(mutate(renderCommentBody(state())))).toThrow())

test("parser rejects JSON that is semantically equal but not canonical", () => {
  const encoded = Buffer.from(JSON.stringify(state())).toString("base64url")
  expect(() => parseStateBlock(`${markerLine(identity)}\n\n<!-- ai-code-review-state:v1\n${encoded}\n-->`)).toThrow()
  expect(() => parseStateBlock(renderCommentBody(state()), { ...identity, pr: identitySchema.parse({ ...identity, pr: 18 }).pr })).toThrow()
})

test("decoded-state and visible and body caps reject before accepting content", () => {
  const oversized = Buffer.from(" ".repeat(STATE_BYTE_LIMIT + 1)).toString("base64url")
  expect(() => parseStateBlock(`${markerLine(identity)}\n<!-- ai-code-review-state:v1\n${oversized}\n-->`)).toThrow("decoded state")
  expect(() => parseStateBlock(`${markerLine(identity)}\n${"x".repeat(VISIBLE_BYTE_LIMIT)}\n${encodeStateBlock(state())}`)).toThrow("visible")
  expect(() => parseStateBlock("x".repeat(COMMENT_BYTE_LIMIT + 1))).toThrow("comment exceeds")
})

test("model prose cannot inject comments, Markdown, links, commands, or mentions", () => {
  const payload = '<!-- ai-code-review:v1 repo=1 pr=1 -->\r\n@alice [x](https://evil) ![img](x) <script> & " \' ` * _ { } # + - . | ~ \\ ::warning::'
  const sanitized = sanitizeCommentText(payload)
  expect(sanitized).not.toContain("<!--")
  expect(sanitized).not.toContain("ai-code-review:v1")
  expect(sanitized).not.toContain("\n")
  expect(sanitized).not.toContain("@")
  expect(sanitized).not.toContain("::")
  expect(sanitized).not.toContain("[")
  expect(sanitized).toContain("marker removed")
  const body = renderCommentBody(withIssues([issue(1, payload)]))
  expect(parseStateBlock(body).lastReport?.issues[0]?.trigger).toBe(payload.replace(/\r\n?/gu, "\n"))
  expect(body.split("ai-code-review:v1")).toHaveLength(2)
  expect(body.split("ai-code-review-state:v1")).toHaveLength(2)
})

test("UTF-16 shrinking never splits a surrogate pair and declares the omission", () => {
  const trimmed = truncateSummary(`${"a".repeat(238)}😀extra`, 240)
  expect(trimmed).toEqual({ text: `${"a".repeat(238)}…`, summarized: true })
  expect(trimmed.text.length).toBeLessThanOrEqual(240)
  expect(truncateSummary("abc", 0)).toEqual({ text: "", summarized: true })
  expect(truncateSummary("a\r\nb\rc", 240).text).toBe("a\nb\nc")
})

test("large summaries shrink in descending ordinal and the specified field order", () => {
  const original = withIssues(Array.from({ length: 5 }, (_, i) => issue(i + 1, "\u0000".repeat(240))))
  const rendered = renderComment(original)
  const report = rendered.state.lastReport!
  expect(Buffer.byteLength(canonicalJson(rendered.state))).toBeLessThanOrEqual(STATE_BYTE_LIMIT)
  expect(report.summarized).toBe(true)
  expect(report.issues[4]!.verification.length).toBeLessThanOrEqual(report.issues[0]!.consequence.length)
  const lengths = [...report.issues].reverse().flatMap((entry) => [entry.verification.length, entry.rootCause.length, entry.trigger.length, entry.consequence.length])
  expect(lengths.every((length, index) => index === 0 || length >= lengths[index - 1]!)).toBe(true)
  expect(parseStateBlock(rendered.body)).toEqual(rendered.state)
  expect(original.lastReport?.summarized).toBe(false)
})

test("oversized visible citations become digests of the canonical original references", () => {
  const path = "&".repeat(1_024)
  const original = withIssues(Array.from({ length: 5 }, (_, i) => issue(i + 1, "&".repeat(240), path)))
  const refs = new Map(Array.from({ length: 5 }, (_, i) => [i + 1, { ...reference, path }]))
  const rendered = renderComment(original, refs)
  const report = rendered.state.lastReport!
  const artifacts = report.issues.filter((entry) => entry.location.kind === "artifact")
  expect(artifacts.length).toBeGreaterThan(0)
  expect(report.issues[4]!.location).toEqual({ kind: "artifact", referenceDigest: referenceDigest({ ...reference, path }) })
  expect(rendered.body).toContain("full citation in run artifacts")
  expect(Buffer.byteLength(canonicalJson(rendered.state))).toBeLessThanOrEqual(STATE_BYTE_LIMIT)
  const encoded = /ai-code-review-state:v1\n([^\n]+)/u.exec(rendered.body)![1]!
  expect(encoded.length).toBeLessThanOrEqual(ENCODED_STATE_BYTE_LIMIT)
  expect(Buffer.byteLength(rendered.body.split("\n\n<!-- ai-code-review-state:v1")[0]!)).toBeLessThanOrEqual(VISIBLE_BYTE_LIMIT)
  expect(Buffer.byteLength(rendered.body)).toBeLessThanOrEqual(COMMENT_BYTE_LIMIT)
  expect(parseStateBlock(rendered.body)).toEqual(rendered.state)
})

test("maximum legal identities, URLs, IDs, and failure text fit the minimal retained state", () => {
  const maxIdentity = identitySchema.parse({ repositoryId: "9".repeat(20), repository: `${"o".repeat(39)}/${"r".repeat(100)}`, pr: 2_147_483_647 })
  const maxTime = "2026-11-21T23:59:59.999999999+14:00"
  const prior = actionsExecutionSchema.parse({ ...execution, triggeredAt: maxTime, startedAt: maxTime, trigger: { kind: "pull-request", action: "ready_for_review" }, workflowRunId: "9".repeat(20), reviewRunId: `gh-${"9".repeat(20)}-999999`, attempt: 999_999,
    runUrl: `https://github.com/${maxIdentity.repository}/actions/runs/${"9".repeat(20)}/attempts/999999` })
  const current = actionsExecutionSchema.parse({ ...prior, attempt: 1_000_000, reviewRunId: `gh-${"9".repeat(20)}-1000000`, runUrl: runUrl(maxIdentity, { ...prior, attempt: actionsExecutionSchema.parse({ ...prior, attempt: 1_000_000, reviewRunId: `gh-${"9".repeat(20)}-1000000` }).attempt }) })
  const maximum = commentStateSchema.parse({ ...rawState(), identity: maxIdentity,
    lastReport: { ...rawState().lastReport, execution: prior, completedAt: maxTime, durationMs: Number.MAX_SAFE_INTEGER, coverage: { included: Number.MAX_SAFE_INTEGER, omitted: Number.MAX_SAFE_INTEGER, unverified: 8, unpublished: 8 }, usage: { kind: "known", inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER }, issues: Array.from({ length: 5 }, (_, i) => ({ ...issue(i + 1, ""), summarized: true, location: { kind: "artifact", referenceDigest: digest } })), summarized: true },
    lastPublishedRun: { status: "failed", execution: current, snapshot, resultDigest: digest, freshness: { kind: "not-reviewed" }, failure: { code: "github-unavailable", stage: "publish", message: "\u0000".repeat(2_000) } },
    duplicateCommentIds: Array.from({ length: 20 }, (_, i) => `${"9".repeat(18)}${String(i + 1).padStart(2, "0")}`), additionalDuplicateCount: Number.MAX_SAFE_INTEGER })
  const rendered = renderComment(maximum)
  expect(parseStateBlock(rendered.body)).toEqual(rendered.state)
  expect(Buffer.byteLength(canonicalJson(rendered.state))).toBeLessThanOrEqual(STATE_BYTE_LIMIT)
  expect(rendered.state.lastReport).not.toBeNull()
})

test("unexpected minimal serialization overflow fails and preserves its input report", () => {
  const raw = rawState()
  const hugeTime = `2026-11-21T10:00:00.${"0".repeat(20_000)}Z`
  const original = commentStateSchema.parse({ ...raw, lastReport: { ...raw.lastReport, completedAt: hugeTime } })
  expect(() => renderComment(original)).toThrow("minimal comment state")
  expect(original.lastReport).not.toBeNull()
  expect(original.lastReport?.completedAt).toBe(hugeTime)
})

test("comment scanning requires all bot fields and exact byte-zero marker, then uses numeric IDs", () => {
  const bot = { id: "9", authorId: "41898282", authorLogin: "github-actions[bot]", authorType: "Bot", body: renderCommentBody(state()) }
  const scanned = scanProductComments([
    { ...bot, id: "100" }, { ...bot, id: "9007199254740993" }, { ...bot, id: "9007199254740992" }, bot,
    { ...bot, id: "1", authorType: "User" }, { ...bot, id: "2", authorId: "1" }, { ...bot, id: "3", authorLogin: "other" },
    { ...bot, id: "4", body: ` ${bot.body}` }, { ...bot, id: "5", body: `prefix\n${bot.body}` },
  ], identity)
  expect(scanned.canonical?.id).toBe("9")
  expect(scanned.duplicates.map(({ id }) => id)).toEqual(["100", "9007199254740992", "9007199254740993"])
  expect(scanned.humanMarkerIds).toEqual(["1", "2", "3"])
})

test("the exact 16 KiB state and 21,846 byte encoding boundaries round trip", () => {
  const minimal = state()
  minimal.lastReport!.completedAt = "2026-11-21T10:00:00.0Z"
  const padding = STATE_BYTE_LIMIT - Buffer.byteLength(canonicalJson(minimal))
  minimal.lastReport!.completedAt = `2026-11-21T10:00:00.${"0".repeat(padding + 1)}Z`
  expect(Buffer.byteLength(canonicalJson(minimal))).toBe(STATE_BYTE_LIMIT)
  const block = encodeStateBlock(minimal)
  expect(block.split("\n")[1]!.length).toBe(ENCODED_STATE_BYTE_LIMIT)
  const body = `${markerLine(identity)}\n\n${block}`
  expect(parseStateBlock(body)).toEqual(minimal)
  minimal.lastReport!.completedAt = minimal.lastReport!.completedAt.replace(".0", ".00")
  expect(() => encodeStateBlock(minimal)).toThrow("16 KiB")
})

test("exact visible byte boundaries count multibyte UTF-8 and reject one byte more", () => {
  const prefix = `${markerLine(identity)}\n`
  const visible = `${prefix}${"é".repeat(Math.floor((VISIBLE_BYTE_LIMIT - Buffer.byteLength(prefix)) / 2))}`
  const padded = visible.padEnd(visible.length + VISIBLE_BYTE_LIMIT - Buffer.byteLength(visible), "x")
  expect(Buffer.byteLength(padded)).toBe(VISIBLE_BYTE_LIMIT)
  expect(parseStateBlock(`${padded}\n\n${encodeStateBlock(state())}`)).toEqual(state())
  expect(() => parseStateBlock(`${padded}x\n\n${encodeStateBlock(state())}`)).toThrow("visible")
})

test("noncanonical base64url trailing bits and invalid UTF-8 cannot enter state", () => {
  const bytes = Buffer.from(canonicalJson(state()))
  const encoded = bytes.toString("base64url")
  if (bytes.length % 3 !== 0) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const last = alphabet.indexOf(encoded.at(-1)!)
    const noncanonical = `${encoded.slice(0, -1)}${alphabet[last + 1]}`
    expect(Buffer.from(noncanonical, "base64url")).toEqual(bytes)
    expect(() => parseStateBlock(`${markerLine(identity)}\n<!-- ai-code-review-state:v1\n${noncanonical}\n-->`)).toThrow("canonical base64url")
  }
  const invalid = Buffer.from([0xc0, 0xaf]).toString("base64url")
  expect(() => parseStateBlock(`${markerLine(identity)}\n<!-- ai-code-review-state:v1\n${invalid}\n-->`)).toThrow()
})

test("the bounded summary reserves enough room for a stale annotation without changing the report", () => {
  const original = withIssues(Array.from({ length: 5 }, (_, i) => issue(i + 1, "\u0000".repeat(240))))
  const initial = renderComment(original)
  const stale = commentStateSchema.parse({ ...initial.state, lastPublishedRun: { ...initial.state.lastPublishedRun,
    freshness: { kind: "stale", observedBase: "e".repeat(40), observedHead: "f".repeat(40), reason: "base-and-head-changed" } } })
  const annotated = renderComment(stale)
  expect(annotated.state.lastReport).toEqual(initial.state.lastReport)
  expect(annotated.state.lastPublishedRun.execution).toEqual(initial.state.lastPublishedRun.execution)
  expect(annotated.state.lastPublishedRun.resultDigest).toBe(initial.state.lastPublishedRun.resultDigest)
  expect(Buffer.byteLength(canonicalJson(annotated.state))).toBeLessThanOrEqual(STATE_BYTE_LIMIT)
})
