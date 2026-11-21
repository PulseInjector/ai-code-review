import { afterAll, beforeAll, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createBudget, systemClock, type Clock } from "./budget"
import { createGitHubReader, readExecutionContext, type FetchLike, type GitHubReader, type GitObservation } from "./github"
import { createJavaReviewRepository, type JavaReviewCommits } from "./fixtures/java-review"
import { boundCoverageForPublication, runPrReview } from "./pr-review"
import { runReview } from "./review"
import type { Candidate, Verification } from "./contracts"
import { emptyReadBudget, type RuntimeResult } from "./runtime/contracts"
import type { ProgressEvent } from "./progress"

const REPOSITORY = "PulseInjector/java-review"
const REPO_URL = "https://api.github.com/repos/PulseInjector/java-review"
const PULLS_URL = `${REPO_URL}/pulls/17`
const COMMENTS_URL = `${REPO_URL}/issues/17/comments?per_page=100&page=1`
const WORKFLOW_URL = `${REPO_URL}/actions/runs/987654321`
const workflowResponse = {
  id: 987654321, run_attempt: 1, created_at: "2026-11-21T10:00:00Z", run_started_at: "2026-11-21T10:00:05Z",
  status: "in_progress", event: "pull_request", repository: { id: 123456789 },
}
const botUser = { login: "github-actions[bot]", id: 41898282, type: "Bot" }
const marker = "<!-- ai-code-review:v1 repo=123456789 pr=17 -->"
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex")

function manualClock(): Clock {
  return {
    monotonicMs: () => 0,
    wallTime: () => "2026-11-21T00:00:00.000Z",
    sleep: async () => {},
  }
}
const freshBudget = () => createBudget(manualClock(), 300_000)

const failingFetch: FetchLike = async (input) => {
  throw new Error(`the local path must not call GitHub: ${String(input)}`)
}

function pullFixture(baseSha: string, headSha: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    number: 17, state: "open", draft: false,
    base: { sha: baseSha, repo: { id: 123456789 } },
    head: { sha: headSha, repo: { id: 123456789 } },
    ...overrides,
  }
}

type PrApi = {
  pull?: { response?: unknown; notFound?: boolean }
  comments?: { list?: unknown[]; status?: number }
  workflow?: unknown
}

function apiFetch(api: PrApi): { fetchImpl: FetchLike; requests: string[] } {
  const requests: string[] = []
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url === REPO_URL) return jsonResponse({ id: 123456789, full_name: REPOSITORY })
    if (url === PULLS_URL) return api.pull?.notFound === true ? statusResponse(404) : jsonResponse(api.pull?.response ?? pullFixture("a".repeat(40), "b".repeat(40)))
    if (url === COMMENTS_URL) {
      if (api.comments?.status !== undefined) return statusResponse(api.comments.status)
      return jsonResponse(api.comments?.list ?? [])
    }
    if (url === WORKFLOW_URL) return jsonResponse(api.workflow ?? workflowResponse)
    throw new Error(`unexpected request: ${url}`)
  }
  return { fetchImpl, requests }
}

const jsonResponse = (value: unknown, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json", ...headers } })
const statusResponse = (status: number): Response => new Response("", { status })

const configuration = {
  apiKey: "test-key",
  model: { providerID: "test", baseURL: "https://example.invalid/v1", modelID: "reviewer" },
}
const reference = { side: "head", path: "src/example/OrderService.java", startLine: 11, endLine: 11, excerpt: "      return null;" } satisfies Candidate["changeLocation"]
const candidate: Candidate = {
  id: "C-1", changeLocation: reference, trigger: "Missing customer", consequence: "NullPointerException in caller", rootCause: "Caller iterates a nullable result", citations: [reference],
}
const keep: Verification = { candidateId: "C-1", decision: "keep", reason: "Caller has no guard", evidence: [reference] }

function completed(candidates: Candidate[], verifications: Verification[]): RuntimeResult {
  return {
    status: "complete",
    sessions: [
      { name: "discover", status: "complete", text: JSON.stringify({ candidates }), usage: { kind: "known", inputTokens: 5, outputTokens: 2 }, durationMs: 10 },
      { name: "verify", status: "complete", text: JSON.stringify({ verifications }), usage: { kind: "known", inputTokens: 7, outputTokens: 3 }, durationMs: 12 },
    ],
    usage: { kind: "known", inputTokens: 12, outputTokens: 5 }, readBudget: emptyReadBudget(), cleanup: { hostClosed: true, forced: false },
  }
}
const worker = async (): Promise<RuntimeResult> => completed([candidate], [keep])

let root: string
let repo: string
let origin: string
let commits: JavaReviewCommits

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pr-review-"))
  repo = join(root, "repo")
  commits = await createJavaReviewRepository(repo)
  origin = join(root, "origin.git")
  const result = Bun.spawnSync(["git", "clone", "--bare", "--quiet", repo, origin], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  const config = Bun.spawnSync(["git", "-C", origin, "config", "uploadpack.allowAnySHA1InWant", "true"], { stdout: "pipe", stderr: "pipe" })
  if (config.exitCode !== 0) throw new Error(new TextDecoder().decode(config.stderr))
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

const localExecution = () => readExecutionContext({}, freshBudget(), { fetch: failingFetch }).then((resolved) => resolved.execution)
const testModelIdentity = () => ({ providerId: "test", modelId: "reviewer" })
const failingModel = (): never => { throw new Error("the model credential must not load before included changes are proven") }

test("a PR review reproduces the local review over the same fixed objects", async () => {
  const local = await runReview({ repo, base: commits.baseSha, head: commits.defectSha, out: join(root, "local-run") }, { configuration, runWorker: worker })
  const execution = await localExecution()
  const events: ProgressEvent[] = []
  const gitInvocations: GitObservation[] = []
  const api = apiFetch({ pull: { response: pullFixture(commits.baseSha, commits.defectSha) } })
  const github = createGitHubReader({ GITHUB_TOKEN: "pr-review-token" }, {
    fetch: api.fetchImpl,
    gitRemoteUrl: () => origin,
    clock: manualClock(),
    observeGit: (invocation) => gitInvocations.push(invocation),
  })
  const out = join(root, "pr-run")
  const outcome = await runPrReview({ repository: REPOSITORY, pr: 17, config: "review.config.json", out }, {
    github,
    execution,
    progress: (event) => events.push(event),
    model: () => configuration,
    modelIdentity: testModelIdentity,
    budget: freshBudget(),
    runWorker: worker,
  })
  expect(outcome.outcome.kind).toBe("reviewed")
  if (outcome.outcome.kind !== "reviewed") throw new Error("unreachable")
  expect(outcome.outcome.result.issues).toEqual(local.artifacts.result.issues)
  expect(outcome.outcome.result.snapshot).toEqual(local.artifacts.result.snapshot)
  expect(outcome.outcome.result.runId).toBe(execution.reviewRunId)
  expect(outcome.exitCode).toBe(0)
  expect((await readdir(out)).sort()).toEqual(["replay"])
  const replay = join(out, "replay")
  expect(JSON.parse(await readFile(join(replay, "result.json"), "utf8")).runId).toBe(execution.reviewRunId)
  expect(JSON.parse(await readFile(join(replay, "candidates.json"), "utf8")))
    .toEqual(JSON.parse(await readFile(join(root, "local-run", "candidates.json"), "utf8")))
  expect(JSON.parse(await readFile(join(replay, "verifications.json"), "utf8")))
    .toEqual(JSON.parse(await readFile(join(root, "local-run", "verifications.json"), "utf8")))
  expect(outcome.runDirectory).toBe(replay)
  expect(outcome.handoffDirectory).toBeNull()
  expect(JSON.parse(JSON.stringify(outcome.handoff.identity))).toEqual({ repositoryId: "123456789", repository: REPOSITORY, pr: 17 })
  expect(outcome.handoff.backup).toEqual({ kind: "absent" })
  expect(outcome.handoff.configSource?.kind).toBe("product-default")
  expect(outcome.handoff.model).toEqual({ providerId: "test", modelId: "reviewer" })
  expect(outcome.handoff.artifactName).toBeNull()
  expect(String(outcome.handoff.captured?.mergeBaseSha)).toBe(local.artifacts.result.snapshot.mergeBaseSha)
  expect(outcome.handoff.replayDirectory).toBe(replay)

  const sequences = events.map(({ sequence }) => sequence)
  expect(new Set(sequences).size).toBe(sequences.length)
  expect(sequences).toEqual([...sequences].sort((left, right) => left - right))
  expect(events[0]?.phase).toBe("capture")
  expect(events.map(({ phase }) => phase)).toContain("preparation")
  expect(events.map(({ phase }) => phase)).toContain("verification")

  for (const invocation of gitInvocations.filter(({ args }) => args[0] === "init")) {
    await expect(access(invocation.args[3]!)).rejects.toThrow()
    await expect(access(dirname(invocation.args[3]!))).rejects.toThrow()
  }
})

test("the API head wins over a wrong event SHA and the run binds to the Actions identity", async () => {
  const eventRoot = await mkdtemp(join(tmpdir(), "pr-review-event-"))
  try {
    const eventPath = join(eventRoot, "event.json")
    await writeFile(eventPath, JSON.stringify({
      action: "synchronize",
      pull_request: { number: 17, head: { sha: "0".repeat(40) }, base: { sha: "1".repeat(40) } },
    }))
    const env: NodeJS.ProcessEnv = {
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_REPOSITORY_ID: "123456789",
      GITHUB_RUN_ID: "987654321",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_TOKEN: "actions-token",
    }
    const resolved = await readExecutionContext(env, freshBudget(), { fetch: apiFetch({}).fetchImpl }, { pr: 17 })
    const execution = resolved.execution
    expect(execution.kind).toBe("actions")
    const api = apiFetch({ pull: { response: pullFixture(commits.baseSha, commits.defectSha) } })
    const github = createGitHubReader(env, { fetch: api.fetchImpl, gitRemoteUrl: () => origin, clock: manualClock() })
    const outcome = await runPrReview({ repository: REPOSITORY, pr: 17, config: "review.config.json", out: join(root, "pr-actions") }, {
      github,
      execution,
      progress: () => {},
      model: () => configuration,
      modelIdentity: testModelIdentity,
      ...(resolved.attemptStartedAt !== null ? { attemptStartedAt: resolved.attemptStartedAt } : {}),
      budget: freshBudget(),
      runWorker: worker,
    })
    expect(outcome.outcome.kind).toBe("reviewed")
    if (outcome.outcome.kind !== "reviewed") throw new Error("unreachable")
    expect(outcome.outcome.result.snapshot.headSha).toBe(commits.defectSha)
    expect(outcome.outcome.result.snapshot.baseSha).toBe(commits.baseSha)
    expect(outcome.outcome.result.runId).toBe("gh-987654321-1")
    expect(outcome.artifactName).toBe("ai-code-review-handoff-987654321-1")
    expect(outcome.handoff.replayArtifactName).toBe("ai-code-review-replay-987654321-1")
    expect(outcome.handoff.execution.reviewRunId).toBe("gh-987654321-1")
    expect(outcome.exitCode).toBe(0)
    // Detailed timing carries the workflow API's attempt start separately from command entry.
    const timing = JSON.parse(await readFile(join(root, "pr-actions", "replay", "timing.json"), "utf8"))
    expect(timing.attemptStartedAt).toBe("2026-11-21T10:00:05Z")
    expect(typeof timing.startedAt).toBe("string")
    expect(timing.startedAt).not.toBe(timing.attemptStartedAt)
  } finally {
    await rm(eventRoot, { recursive: true, force: true })
  }
})

test("draft, closed, and fork captures skip without a model session or a Git command", async () => {
  const cases = [
    ["draft", pullFixture(commits.baseSha, commits.defectSha, { draft: true })],
    ["closed", pullFixture(commits.baseSha, commits.defectSha, { state: "closed" })],
    ["fork", pullFixture(commits.baseSha, commits.defectSha, { head: { sha: commits.defectSha, repo: null } })],
  ] as const
  for (const [reason, pull] of cases) {
    const execution = await localExecution()
    const api = apiFetch({ pull: { response: pull } })
    const gitInvocations: GitObservation[] = []
    const github = createGitHubReader({ GITHUB_TOKEN: "pr-review-token" }, {
      fetch: api.fetchImpl,
      gitRemoteUrl: () => origin,
      clock: manualClock(),
      observeGit: (invocation) => gitInvocations.push(invocation),
    })
    const out = join(root, `skip-${reason}`)
    const outcome = await runPrReview({ repository: REPOSITORY, pr: 17, config: "review.config.json", out }, {
      github,
      execution,
      progress: () => {},
      // A skipped PR never loads the model credential, so the getter throws if anything calls it.
      model: failingModel,
      modelIdentity: testModelIdentity,
      budget: freshBudget(),
      runWorker: async (): Promise<RuntimeResult> => { throw new Error("the model must not start for a skipped PR") },
    })
    expect(outcome.outcome).toEqual({ kind: "skipped", reason, snapshot: null })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.handoffDirectory).toBeNull()
    expect(outcome.handoff.backup).toEqual({ kind: "absent" })
    expect(gitInvocations).toEqual([])
    expect(await readdir(out)).toEqual([])
  }
})

test("a capture failure produces a classified failed outcome without a snapshot", async () => {
  const execution = await localExecution()
  const api = apiFetch({ pull: { notFound: true } })
  const github = createGitHubReader({ GITHUB_TOKEN: "pr-review-token" }, { fetch: api.fetchImpl, clock: manualClock() })
  const out = join(root, "capture-failed")
  const outcome = await runPrReview({ repository: REPOSITORY, pr: 17, config: "review.config.json", out }, {
    github,
    execution,
    progress: () => {},
    model: () => configuration,
    modelIdentity: testModelIdentity,
    budget: freshBudget(),
  })
  expect(outcome.outcome.kind).toBe("failed")
  if (outcome.outcome.kind !== "failed") throw new Error("unreachable")
  expect(outcome.outcome.failure.code).toBe("github-not-found")
  expect(outcome.outcome.failure.stage).toBe("capture")
  expect(outcome.outcome.snapshot).toBeNull()
  expect(outcome.exitCode).toBe(1)
  expect(outcome.runDirectory).toBe(out)
  expect(outcome.handoff.captured).toBeNull()
  expect(outcome.handoffDirectory).toBeNull()
  expect(await readdir(out)).toEqual([])
})

test("a missing captured object fails preparation as snapshot-fetch and invents no merge base", async () => {
  const execution = await localExecution()
  const missingHead = "e".repeat(40)
  const api = apiFetch({ pull: { response: pullFixture(commits.baseSha, missingHead) } })
  const github = createGitHubReader({ GITHUB_TOKEN: "pr-review-token" }, {
    fetch: api.fetchImpl,
    gitRemoteUrl: () => origin,
    clock: manualClock(),
  })
  const out = join(root, "missing-object")
  const outcome = await runPrReview({ repository: REPOSITORY, pr: 17, config: "review.config.json", out }, {
    github,
    execution,
    progress: () => {},
    model: () => configuration,
    modelIdentity: testModelIdentity,
    budget: freshBudget(),
    runWorker: worker,
  })
  expect(outcome.outcome.kind).toBe("failed")
  if (outcome.outcome.kind !== "failed") throw new Error("unreachable")
  expect(outcome.outcome.failure.code).toBe("snapshot-fetch")
  expect(outcome.outcome.failure.stage).toBe("preparation")
  expect(outcome.outcome.snapshot).toBeNull()
  expect(outcome.exitCode).toBe(1)
  expect(JSON.parse(JSON.stringify(outcome.handoff.captured))).toEqual({
    baseSha: commits.baseSha,
    headSha: missingHead,
    mergeBaseSha: null,
    observedAt: "2026-11-21T00:00:00.000Z",
  })
  expect(await readdir(out)).toEqual([])
})

test("a previous owned comment backs up bounded bytes and a read failure degrades to unavailable", async () => {
  const execution = await localExecution()
  const body = `${marker}\nPrevious report text.`
  const present = apiFetch({
    pull: { response: pullFixture(commits.baseSha, commits.defectSha) },
    comments: { list: [{ id: 500, body, created_at: "2026-11-21T09:00:00Z", updated_at: "2026-11-21T09:30:00Z", user: botUser }] },
  })
  const presentOutcome = await runPrReview({ repository: REPOSITORY, pr: 17, config: "review.config.json", out: join(root, "backup-present") }, {
    github: createGitHubReader({ GITHUB_TOKEN: "pr-review-token" }, { fetch: present.fetchImpl, gitRemoteUrl: () => origin, clock: manualClock() }),
    execution,
    progress: () => {},
    model: () => configuration,
    modelIdentity: testModelIdentity,
    budget: freshBudget(),
    runWorker: worker,
  })
  expect(presentOutcome.outcome.kind).toBe("reviewed")
  expect(JSON.parse(JSON.stringify(presentOutcome.handoff.backup))).toEqual({
    kind: "captured",
    commentId: "500",
    bodyDigest: sha256(body),
    updatedAt: "2026-11-21T09:30:00Z",
  })
  // The saved body survives into the handoff, and its bytes verify against the receipt digest.
  expect(presentOutcome.handoff.backupBody).toBe(body)
  if (presentOutcome.handoff.backup.kind === "captured") {
    expect(sha256(presentOutcome.handoff.backupBody!)).toBe(presentOutcome.handoff.backup.bodyDigest)
  } else throw new Error("unreachable")

  // Truncation cuts at a code-point boundary, so the saved bytes never exceed the 60,000-byte cap.
  // The 49-byte prefix makes the cap land mid-character inside the 3-byte run.
  const longBody = `${marker}\nx${"あ".repeat(20_000)}y`
  expect(Buffer.byteLength(longBody, "utf8")).toBeGreaterThan(60_000)
  const truncated = apiFetch({
    pull: { response: pullFixture(commits.baseSha, commits.defectSha) },
    comments: { list: [{ id: 500, body: longBody, created_at: "2026-11-21T09:00:00Z", updated_at: "2026-11-21T09:30:00Z", user: botUser }] },
  })
  const truncatedOutcome = await runPrReview({ repository: REPOSITORY, pr: 17, config: "review.config.json", out: join(root, "backup-truncated") }, {
    github: createGitHubReader({ GITHUB_TOKEN: "pr-review-token" }, { fetch: truncated.fetchImpl, gitRemoteUrl: () => origin, clock: manualClock() }),
    execution,
    progress: () => {},
    model: () => configuration,
    modelIdentity: testModelIdentity,
    budget: freshBudget(),
    runWorker: worker,
  })
  expect(truncatedOutcome.outcome.kind).toBe("reviewed")
  const truncatedBody = truncatedOutcome.handoff.backupBody!
  expect(Buffer.byteLength(truncatedBody, "utf8")).toBeLessThanOrEqual(60_000)
  // The character straddling the cap is dropped whole, so the cut stays clean.
  expect(truncatedBody).toBe(`${marker}\nx${"あ".repeat(19_983)}`)
  if (truncatedOutcome.handoff.backup.kind === "captured") {
    expect(sha256(truncatedBody)).toBe(truncatedOutcome.handoff.backup.bodyDigest)
  } else throw new Error("unreachable")

  // A classified comment-list failure keeps its own code instead of flattening to unavailable.
  const crossOrigin: FetchLike = async (input) => {
    const url = String(input)
    if (url === REPO_URL) return jsonResponse({ id: 123456789, full_name: REPOSITORY })
    if (url === PULLS_URL) return jsonResponse(pullFixture(commits.baseSha, commits.defectSha))
    if (url === COMMENTS_URL) {
      return jsonResponse(Array.from({ length: 100 }, (_, index) => ({
        id: index + 1, body: "discussion", created_at: "2026-11-21T09:00:00Z", updated_at: "2026-11-21T09:30:00Z", user: botUser,
      })), {
        link: `<https://example.invalid/comments?page=2>; rel="next"`,
      })
    }
    throw new Error(`unexpected request: ${url}`)
  }
  const crossOriginOutcome = await runPrReview({ repository: REPOSITORY, pr: 17, config: "review.config.json", out: join(root, "backup-cross-origin") }, {
    github: createGitHubReader({ GITHUB_TOKEN: "pr-review-token" }, { fetch: crossOrigin, gitRemoteUrl: () => origin, clock: manualClock() }),
    execution,
    progress: () => {},
    model: () => configuration,
    modelIdentity: testModelIdentity,
    budget: freshBudget(),
    runWorker: worker,
  })
  expect(crossOriginOutcome.outcome.kind).toBe("reviewed")
  expect(crossOriginOutcome.handoff.backup).toEqual({ kind: "unavailable", code: "comment-list-limit" })
  expect(crossOriginOutcome.handoff.backupBody).toBeNull()

  const unavailable = apiFetch({
    pull: { response: pullFixture(commits.baseSha, commits.defectSha) },
    comments: { status: 503 },
  })
  const unavailableOutcome = await runPrReview({ repository: REPOSITORY, pr: 17, config: "review.config.json", out: join(root, "backup-unavailable") }, {
    github: createGitHubReader({ GITHUB_TOKEN: "pr-review-token" }, { fetch: unavailable.fetchImpl, gitRemoteUrl: () => origin, clock: manualClock() }),
    execution,
    progress: () => {},
    model: () => configuration,
    modelIdentity: testModelIdentity,
    budget: freshBudget(),
    runWorker: worker,
  })
  expect(unavailableOutcome.outcome.kind).toBe("reviewed")
  expect(unavailableOutcome.handoff.backup).toEqual({ kind: "unavailable", code: "github-unavailable" })
  expect(unavailableOutcome.exitCode).toBe(0)
  expect(unavailable.requests.filter((url) => url === COMMENTS_URL)).toHaveLength(3)
})

test("an Actions run without model configuration fails initialization before capture", async () => {
  const eventRoot = await mkdtemp(join(tmpdir(), "pr-review-event-"))
  try {
    const eventPath = join(eventRoot, "event.json")
    await writeFile(eventPath, JSON.stringify({ action: "opened", pull_request: { number: 17 } }))
    const env: NodeJS.ProcessEnv = {
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_REPOSITORY_ID: "123456789",
      GITHUB_RUN_ID: "987654321",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_TOKEN: "actions-token",
    }
    const execution = (await readExecutionContext(env, freshBudget(), { fetch: apiFetch({}).fetchImpl }, { pr: 17 })).execution
    const api = apiFetch({ pull: { response: pullFixture(commits.baseSha, commits.defectSha) } })
    const github = createGitHubReader(env, { fetch: api.fetchImpl, gitRemoteUrl: () => origin, clock: manualClock() })
    const outcome = await runPrReview({ repository: REPOSITORY, pr: 17, config: "review.config.json", out: join(root, "model-config-failed") }, {
      github,
      execution,
      progress: () => {},
      model: () => { throw new Error("REVIEW_MODEL_BASE_URL is required") },
      modelIdentity: (): never => { throw new Error("REVIEW_MODEL_BASE_URL is required") },
      budget: freshBudget(),
      runWorker: worker,
    })
    expect(outcome.outcome.kind).toBe("failed")
    if (outcome.outcome.kind !== "failed") throw new Error("unreachable")
    expect(outcome.outcome.failure.code).toBe("model-config")
    expect(outcome.outcome.failure.stage).toBe("initialization")
    expect(outcome.exitCode).toBe(1)
    expect(api.requests).toEqual([])
  } finally {
    await rm(eventRoot, { recursive: true, force: true })
  }
})

test("a PR review runs end to end on the production system clock", async () => {
  const execution = await localExecution()
  const api = apiFetch({ pull: { response: pullFixture(commits.baseSha, commits.defectSha) } })
  // No injected clock: the reader and the budget use the real monotonic clock, whose fractional
  // milliseconds must survive every subprocess boundary without ERR_INVALID_ARG_TYPE.
  const github = createGitHubReader({ GITHUB_TOKEN: "pr-review-token" }, { fetch: api.fetchImpl, gitRemoteUrl: () => origin })
  const outcome = await runPrReview({ repository: REPOSITORY, pr: 17, config: "review.config.json", out: join(root, "system-clock") }, {
    github,
    execution,
    progress: () => {},
    model: () => configuration,
    modelIdentity: testModelIdentity,
    budget: createBudget(systemClock, 300_000),
    runWorker: worker,
  })
  expect(outcome.outcome.kind).toBe("reviewed")
  expect(outcome.exitCode).toBe(0)
})

test("PR export runs Git in a credential-free environment while the fetch carries only the askpass token", async () => {
  const shimRoot = await mkdtemp(join(tmpdir(), "pr-review-shim-"))
  const realGit = Bun.which("git") ?? "/usr/bin/git"
  const recordPath = join(shimRoot, "child-env.txt")
  const shimPath = join(shimRoot, "git")
  await writeFile(shimPath, `#!/bin/sh\n{ printf '%s\\n' "$@"; env; printf '\\n'; } >> "${recordPath}"\nexec "${realGit}" "$@"\n`, { mode: 0o700 })
  const hostileObjectDir = join(shimRoot, "hostile-objects")
  await mkdir(hostileObjectDir)
  const previousPath = process.env.PATH
  const previous: Record<string, string | undefined> = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY,
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
  }
  const restore = (): void => {
    process.env.PATH = previousPath
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  // The shim sits first on PATH, so every Git child of this run records the environment it
  // actually received while still delegating to the real Git. The ambient environment is hostile:
  // an inherited GIT_OBJECT_DIRECTORY would break every export command, and an inherited token or
  // config would leak into it.
  process.env.PATH = `${shimRoot}:${previousPath ?? ""}`
  process.env.GITHUB_TOKEN = "ambient-leak-token"
  process.env.GIT_OBJECT_DIRECTORY = hostileObjectDir
  process.env.GIT_CONFIG_COUNT = "1"
  process.env.GIT_CONFIG_KEY_0 = "core.ambient"
  process.env.GIT_CONFIG_VALUE_0 = "leaked"
  const fetchEnv: GitObservation[] = []
  let outcome: Awaited<ReturnType<typeof runPrReview>>
  try {
    const execution = await localExecution()
    const api = apiFetch({ pull: { response: pullFixture(commits.baseSha, commits.defectSha) } })
    const github = createGitHubReader({ GITHUB_TOKEN: "pr-review-token" }, {
      fetch: api.fetchImpl,
      gitRemoteUrl: () => origin,
      clock: manualClock(),
      observeGit: (invocation) => fetchEnv.push(invocation),
    })
    outcome = await runPrReview({ repository: REPOSITORY, pr: 17, config: "review.config.json", out: join(root, "credential-free-export") }, {
      github,
      execution,
      progress: () => {},
      model: () => configuration,
      modelIdentity: testModelIdentity,
      budget: freshBudget(),
      runWorker: worker,
    })
  } finally {
    restore()
  }
  // The run itself proves the export children never saw the hostile ambient values.
  expect(outcome.outcome.kind).toBe("reviewed")

  const blocks = (await readFile(recordPath, "utf8")).split("\n\n").filter((block) => block.trim() !== "")
  const exportEnvironments: Array<Map<string, string>> = []
  const fetchEnvironments: Array<Map<string, string>> = []
  for (const block of blocks) {
    const lines = block.split("\n")
    const env = new Map<string, string>()
    for (const line of lines.slice(1)) {
      const at = line.indexOf("=")
      if (at > 0) env.set(line.slice(0, at), line.slice(at + 1))
    }
    if (env.has("REVIEW_GIT_ASKPASS_TOKEN")) fetchEnvironments.push(env)
    else exportEnvironments.push(env)
  }
  expect(fetchEnvironments.length).toBeGreaterThan(0)
  expect(exportEnvironments.length).toBeGreaterThan(0)
  for (const env of fetchEnvironments) {
    expect(env.get("REVIEW_GIT_ASKPASS_TOKEN")).toBe("pr-review-token")
    expect(env.has("GITHUB_TOKEN")).toBe(false)
    expect(env.has("GIT_OBJECT_DIRECTORY")).toBe(false)
    expect(env.has("GIT_CONFIG_COUNT")).toBe(false)
  }
  for (const env of exportEnvironments) {
    // /bin/sh adds PWD, SHLVL, and sometimes _ to its own environment, so the recorded keys
    // ignore exactly those three shell additions.
    const keys = [...env.keys()].filter((key) => key !== "PWD" && key !== "_" && key !== "SHLVL").sort()
    expect(keys).toEqual(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "PATH"])
    expect(env.has("GITHUB_TOKEN")).toBe(false)
    expect(env.has("GIT_OBJECT_DIRECTORY")).toBe(false)
    expect(env.has("GIT_CONFIG_COUNT")).toBe(false)
  }
  // The askpass exchange happens for the fetch and the remote URL carries no credentials.
  const fetchInvocation = fetchEnv.find(({ args }) => args.includes("fetch"))
  expect(fetchInvocation).toBeDefined()
  expect(fetchInvocation?.args.find((arg) => arg === origin)).toBeDefined()
  for (const arg of fetchInvocation?.args ?? []) expect(arg).not.toContain("@")
  expect(fetchInvocation?.env.REVIEW_GIT_ASKPASS_TOKEN).toBe("pr-review-token")
  await rm(shimRoot, { recursive: true, force: true })
})

test("a cleanup failure after validated verification keeps the verified work as a red-job partial", async () => {
  const execution = await localExecution()
  const api = apiFetch({ pull: { response: pullFixture(commits.baseSha, commits.defectSha) } })
  const base = createGitHubReader({ GITHUB_TOKEN: "pr-review-token" }, { fetch: api.fetchImpl, gitRemoteUrl: () => origin, clock: manualClock() })
  const brokenDispose: GitHubReader = {
    ...base,
    prepareFixedRepository: async (input) => {
      const fixed = await base.prepareFixedRepository(input)
      return {
        ...fixed,
        dispose: async () => {
          await rm(dirname(fixed.directory), { recursive: true, force: true })
          throw new Error("forced cleanup failure after validated verification")
        },
      }
    },
  }
  const outcome = await runPrReview({ repository: REPOSITORY, pr: 17, config: "review.config.json", out: join(root, "dispose-failed") }, {
    github: brokenDispose,
    execution,
    progress: () => {},
    model: () => configuration,
    modelIdentity: testModelIdentity,
    budget: freshBudget(),
    runWorker: worker,
  })
  expect(outcome.outcome.kind).toBe("reviewed")
  if (outcome.outcome.kind !== "reviewed") throw new Error("unreachable")
  expect(outcome.outcome.result.status).toBe("partial")
  expect(outcome.outcome.result.issues).toHaveLength(1)
  expect(outcome.outcome.result.stageErrors.map((error) => error.code)).toContain("cleanup-failed")
  expect(outcome.exitCode).toBe(1)

  // A disposal error carrying no text still folds into the partial instead of failing the
  // contract's message minimum and discarding the verified work.
  const blankDispose: GitHubReader = {
    ...base,
    prepareFixedRepository: async (input) => {
      const fixed = await base.prepareFixedRepository(input)
      return { ...fixed, dispose: async () => { throw new Error("") } }
    },
  }
  const blankOutcome = await runPrReview({ repository: REPOSITORY, pr: 17, config: "review.config.json", out: join(root, "dispose-blank") }, {
    github: blankDispose,
    execution,
    progress: () => {},
    model: () => configuration,
    modelIdentity: testModelIdentity,
    budget: freshBudget(),
    runWorker: worker,
  })
  expect(blankOutcome.outcome.kind).toBe("reviewed")
  if (blankOutcome.outcome.kind !== "reviewed") throw new Error("unreachable")
  expect(blankOutcome.outcome.result.status).toBe("partial")
  expect(blankOutcome.outcome.result.issues).toHaveLength(1)
  expect(blankOutcome.outcome.result.stageErrors.map((error) => error.code)).toContain("cleanup-failed")
})

test("an all-omitted change reviews without ever loading the model credential", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pr-review-omitted-"))
  const spawn = (args: string[]): string => {
    const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
    return new TextDecoder().decode(result.stdout).trim()
  }
  try {
    const repo = join(fixtureRoot, "repo")
    await mkdir(repo)
    spawn(["init", "--quiet", "--initial-branch=main", repo])
    await writeFile(join(repo, "src.txt"), "one\n")
    spawn(["-C", repo, "add", "-A"])
    spawn(["-C", repo, "-c", "user.name=PR Review Test", "-c", "user.email=pr@example.invalid", "commit", "--quiet", "-m", "base"])
    const baseSha = spawn(["-C", repo, "rev-parse", "HEAD"])
    await mkdir(join(repo, "secrets"))
    await writeFile(join(repo, "secrets/token.txt"), "credential-like\n")
    spawn(["-C", repo, "add", "-A"])
    spawn(["-C", repo, "-c", "user.name=PR Review Test", "-c", "user.email=pr@example.invalid", "commit", "--quiet", "-m", "head"])
    const headSha = spawn(["-C", repo, "rev-parse", "HEAD"])
    const bareOrigin = join(fixtureRoot, "origin.git")
    spawn(["clone", "--bare", "--quiet", repo, bareOrigin])
    spawn(["-C", bareOrigin, "config", "uploadpack.allowAnySHA1InWant", "true"])

    const execution = await localExecution()
    const api = apiFetch({ pull: { response: pullFixture(baseSha, headSha) } })
    const github = createGitHubReader({ GITHUB_TOKEN: "pr-review-token" }, { fetch: api.fetchImpl, gitRemoteUrl: () => bareOrigin, clock: manualClock() })
    const outcome = await runPrReview({ repository: REPOSITORY, pr: 17, config: "review.config.json", out: join(root, "all-omitted") }, {
      github,
      execution,
      progress: () => {},
      model: failingModel,
      modelIdentity: testModelIdentity,
      budget: freshBudget(),
      runWorker: async (): Promise<RuntimeResult> => { throw new Error("the model must not start for an all-omitted change") },
    })
    expect(outcome.outcome.kind).toBe("reviewed")
    if (outcome.outcome.kind !== "reviewed") throw new Error("unreachable")
    expect(outcome.outcome.result.status).toBe("partial")
    expect(outcome.outcome.result.issues).toHaveLength(0)
    expect(outcome.outcome.result.coverage.omittedPaths).toContain("secrets/token.txt")
    expect(outcome.exitCode).toBe(0)
    expect(outcome.handoff.model).toEqual({ providerId: "test", modelId: "reviewer" })
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test("coverage translation bounds every array, records exact overflow counts, and forces partial", () => {
  const untouched = boundCoverageForPublication({ includedPaths: ["a.java"], omittedPaths: [], unverifiedCandidateIds: [], unpublishedCandidateIds: [], notes: ["kept"] })
  expect(untouched.truncated).toBe(false)
  expect(untouched.coverage.notes).toEqual(["kept"])

  const overflowing = boundCoverageForPublication({
    includedPaths: Array.from({ length: 2_050 }, (_, index) => `src/included-${index}.java`),
    omittedPaths: Array.from({ length: 2_050 }, (_, index) => `src/omitted-${index}.java`),
    unverifiedCandidateIds: Array.from({ length: 9 }, (_, index) => `C-${index}`),
    unpublishedCandidateIds: [],
    notes: [],
  })
  expect(overflowing.truncated).toBe(true)
  expect(overflowing.coverage.includedPaths).toHaveLength(2_000)
  expect(overflowing.coverage.unverifiedCandidateIds).toHaveLength(8)
  // The omitted array reserves a description slot per overflowing kind, then carries the exact
  // dropped-entry counts, which also makes the derived status partial.
  expect(overflowing.coverage.omittedPaths.slice(0, 1_997)).toEqual(Array.from({ length: 1_997 }, (_, index) => `src/omitted-${index}.java`))
  const descriptions = overflowing.coverage.omittedPaths.slice(1_997)
  expect(descriptions).toHaveLength(3)
  expect(descriptions.some((note) => note.startsWith("50 includedPaths entries beyond the 2000-entry publication cap"))).toBe(true)
  expect(descriptions.some((note) => note.startsWith("53 omittedPaths entries beyond the 2000-entry publication cap"))).toBe(true)
  expect(descriptions.some((note) => note.startsWith("1 unverifiedCandidateIds entries beyond the 8-entry publication cap"))).toBe(true)

  const notesOverflow = boundCoverageForPublication({
    includedPaths: [],
    omittedPaths: [],
    unverifiedCandidateIds: [],
    unpublishedCandidateIds: [],
    notes: Array.from({ length: 129 }, (_, index) => `note ${index}`),
  })
  expect(notesOverflow.truncated).toBe(true)
  expect(notesOverflow.coverage.notes).toHaveLength(128)
  expect(notesOverflow.coverage.omittedPaths).toHaveLength(1)
  expect(notesOverflow.coverage.omittedPaths[0]!.startsWith("1 notes entries beyond the 128-entry publication cap")).toBe(true)

  // A non-overflowing omitted array that descriptions would push over its cap overflows in its
  // own right, so the mixed boundary stays inside every publication cap.
  const mixed = boundCoverageForPublication({
    includedPaths: Array.from({ length: 2_001 }, (_, index) => `src/included-${index}.java`),
    omittedPaths: Array.from({ length: 2_000 }, (_, index) => `src/omitted-${index}.java`),
    unverifiedCandidateIds: [],
    unpublishedCandidateIds: [],
    notes: [],
  })
  expect(mixed.truncated).toBe(true)
  expect(mixed.coverage.includedPaths).toHaveLength(2_000)
  expect(mixed.coverage.omittedPaths).toHaveLength(2_000)
  expect(mixed.coverage.omittedPaths.filter((entry) => entry.startsWith("src/omitted-"))).toHaveLength(1_998)
  expect(mixed.coverage.omittedPaths.some((entry) => entry.startsWith("1 includedPaths entries beyond the 2000-entry publication cap"))).toBe(true)
  expect(mixed.coverage.omittedPaths.some((entry) => entry.startsWith("2 omittedPaths entries beyond the 2000-entry publication cap"))).toBe(true)
})

test("a partial caused only by pending tool reads stays advisory", async () => {
  const execution = await localExecution()
  const api = apiFetch({ pull: { response: pullFixture(commits.baseSha, commits.defectSha) } })
  const github = createGitHubReader({ GITHUB_TOKEN: "pr-review-token" }, { fetch: api.fetchImpl, gitRemoteUrl: () => origin, clock: manualClock() })
  const pendingRead: RuntimeResult = {
    ...completed([candidate], [keep]),
    readBudget: {
      consumedBytes: 100,
      truncated: false,
      exhausted: false,
      records: [{
        sessionID: "session", callID: "call", tool: "read", path: "src/example/OrderService.java",
        limit: 1_024, status: "completed", returnedBytes: 100, truncated: false, pending: true,
      }],
    },
  }
  const outcome = await runPrReview({ repository: REPOSITORY, pr: 17, config: "review.config.json", out: join(root, "pending-reads") }, {
    github,
    execution,
    progress: () => {},
    model: () => configuration,
    modelIdentity: testModelIdentity,
    budget: freshBudget(),
    runWorker: async () => pendingRead,
  })
  expect(outcome.outcome.kind).toBe("reviewed")
  if (outcome.outcome.kind !== "reviewed") throw new Error("unreachable")
  expect(outcome.outcome.result.status).toBe("partial")
  expect(outcome.outcome.result.stageErrors).toEqual([])
  expect(outcome.exitCode).toBe(0)
})
