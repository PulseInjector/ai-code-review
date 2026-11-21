import { expect, test } from "bun:test"
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BudgetExhaustedError, createBudget, type Clock, type ExecutionBudget } from "./budget"
import { productReviewConfigPath, reviewLimitsSchema } from "./context"
import { gitShaSchema } from "./identity"
import { actionsExecutionSchema, identitySchema, type ActionsExecution, type Failure, type PullRequestIdentity } from "./pr-contracts"
import {
  canonicalRepositoryUrl, createGitHubReader, dispatchEventSchema, GitHubError, pullRequestEventSchema,
  readExecutionContext, type FetchLike, type GitObservation, type GitHubReader, type PullRequestCapture,
} from "./github"

const REPOSITORY = "PulseInjector/java-review"
const TOKEN = "test-token-1234"
const REPO_URL = "https://api.github.com/repos/PulseInjector/java-review"
const PULLS_URL = `${REPO_URL}/pulls/17`
const WORKFLOW_URL = `${REPO_URL}/actions/runs/987654321`
const COMMENTS_URL = `${REPO_URL}/issues/17/comments`
const ARTIFACTS_URL = `${WORKFLOW_URL}/artifacts?per_page=100`
const repositoryResponse = { id: 123456789, full_name: REPOSITORY }
const workflowResponse = {
  id: 987654321, run_attempt: 1, created_at: "2026-11-21T10:00:00Z", run_started_at: "2026-11-21T10:00:05Z",
  status: "in_progress", event: "pull_request", repository: { id: 123456789 },
}
const identity: PullRequestIdentity = identitySchema.parse({ repositoryId: "123456789", repository: REPOSITORY, pr: 17 })
const actionsExecution: ActionsExecution = actionsExecutionSchema.parse({
  kind: "actions", reviewRunId: "gh-987654321-1", workflowRunId: "987654321", attempt: 1,
  trigger: { kind: "pull-request", action: "opened" },
  triggeredAt: "2026-11-21T10:00:00Z", startedAt: "2026-11-21T10:00:01Z",
  runUrl: "https://github.com/PulseInjector/java-review/actions/runs/987654321",
})
const botUser = { login: "github-actions[bot]", id: 41898282, type: "Bot" }
const marker = (repositoryId = 123456789, pr = 17) => `<!-- ai-code-review:v1 repo=${repositoryId} pr=${pr} -->`
const botComment = (id: number, body: string): Record<string, unknown> => ({
  id, body, created_at: "2026-11-21T09:00:00Z", updated_at: "2026-11-21T09:30:00Z", user: botUser,
})
const humanComment = (id: number, body: string): Record<string, unknown> => ({
  id, body, created_at: "2026-11-21T09:00:00Z", updated_at: "2026-11-21T09:30:00Z",
  user: { login: "octocat", id: 1, type: "User" },
})

type ManualClock = Clock & { sleeps: number[]; advance: (ms: number) => void }
function manualClock(): ManualClock {
  const sleeps: number[] = []
  let now = 0
  return {
    monotonicMs: () => now,
    wallTime: () => "2026-11-21T00:00:00.000Z",
    sleep: async (ms: number) => { sleeps.push(ms) },
    sleeps,
    advance: (ms: number) => { now += ms },
  }
}

const budget = (clock: Clock = manualClock()): ExecutionBudget => createBudget(clock, 300_000)

const jsonResponse = (value: unknown, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json", ...headers } })
const statusResponse = (status: number, headers?: Record<string, string>): Response => new Response("", { status, headers })
const commentsPageUrl = (page: number) => `${COMMENTS_URL}?per_page=100&page=${page}`

const listFetch = (pages: Record<string, () => Response>): { fetchImpl: FetchLike; requests: () => number } => {
  let calls = 0
  return {
    fetchImpl: async (input) => {
      calls += 1
      const handler = pages[String(input)]
      if (handler === undefined) throw new Error(`unexpected request: ${String(input)}`)
      return handler()
    },
    requests: () => calls,
  }
}

function pullResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    number: 17, state: "open", draft: false,
    base: { sha: "a".repeat(40), repo: { id: 123456789 } },
    head: { sha: "b".repeat(40), repo: { id: 123456789 } },
    ...overrides,
  }
}

function reader(options: { fetchImpl?: FetchLike; origin?: string; clock?: Clock; observeGit?: (invocation: GitObservation) => void }): GitHubReader {
  return createGitHubReader({ GITHUB_TOKEN: TOKEN }, {
    ...(options.fetchImpl !== undefined ? { fetch: options.fetchImpl } : {}),
    ...(options.origin !== undefined ? { gitRemoteUrl: () => options.origin! } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.observeGit !== undefined ? { observeGit: options.observeGit } : {}),
  })
}

async function expectGitHubError(promise: Promise<unknown>, code: Failure["code"]): Promise<GitHubError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof GitHubError) {
      expect(error.code).toBe(code)
      return error
    }
    throw error
  }
  throw new Error(`expected a GitHubError with code ${code}`)
}

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}

type RepositoryFixture = {
  root: string
  origin: string
  baseSha: string
  headSha: string
  dispose: () => Promise<void>
}

async function repositoryFixture(input: {
  files?: Record<string, string | Buffer>
  headFiles?: Record<string, string | Buffer>
  baseSymlink?: { path: string; target: string }
  executables?: string[]
} = {}): Promise<RepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), "github-adapter-"))
  const repo = join(root, "repo")
  await mkdir(repo)
  git(repo, "init", "--quiet", "--initial-branch=main")
  git(repo, "config", "user.name", "GitHub Adapter Test")
  git(repo, "config", "user.email", "adapter@example.invalid")
  for (const [path, content] of Object.entries(input.files ?? { "src.txt": "one\ntwo\nthree\nfour\n" })) {
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), content)
  }
  for (const path of input.executables ?? []) await chmod(join(repo, path), 0o755)
  if (input.baseSymlink !== undefined) await symlink(input.baseSymlink.target, join(repo, input.baseSymlink.path))
  git(repo, "add", "-A")
  git(repo, "commit", "--quiet", "-m", "base")
  const baseSha = git(repo, "rev-parse", "HEAD")
  const headEntries = Object.entries(input.headFiles ?? {})
  for (const [path, content] of headEntries) {
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), content)
  }
  let headSha = baseSha
  if (headEntries.length > 0) {
    git(repo, "add", "-A")
    git(repo, "commit", "--quiet", "-m", "head")
    headSha = git(repo, "rev-parse", "HEAD")
  }
  const origin = join(root, "origin.git")
  git(root, "clone", "--bare", "--quiet", repo, origin)
  git(origin, "config", "uploadpack.allowAnySHA1InWant", "true")
  return {
    root,
    origin,
    baseSha,
    headSha,
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}

function capture(fixture: RepositoryFixture): PullRequestCapture {
  return {
    identity,
    baseSha: gitShaSchema.parse(fixture.baseSha),
    headSha: gitShaSchema.parse(fixture.headSha),
    observedAt: "2026-11-21T00:00:00.000Z",
    eligibility: { kind: "review" },
  }
}

test("the budget admits stages while time remains and rejects exhausted stages", () => {
  const clock = manualClock()
  const executionBudget = createBudget(clock, 300_000)
  expect(executionBudget.remainingMs()).toBe(300_000)
  expect(executionBudget.stageDeadline("discovery")).toBe(300_000)
  expect(executionBudget.canStartRequest("discovery", 2_000)).toBe(true)
  executionBudget.assertRemaining("discovery")
  clock.advance(299_999)
  expect(executionBudget.canStartRequest("discovery", 2_000)).toBe(false)
  expect(executionBudget.canStartRequest("discovery", 0)).toBe(true)
  executionBudget.assertRemaining("cleanup")
  clock.advance(1)
  expect(() => executionBudget.assertRemaining("cleanup")).toThrow(BudgetExhaustedError)
})

test("capture eligibility is closed, then fork, then draft, and review uses API SHAs", async () => {
  const captureFetch: FetchLike = async (input) => {
    const url = String(input)
    if (url === REPO_URL) return jsonResponse(repositoryResponse)
    if (url === PULLS_URL) return jsonResponse(pullResponse())
    throw new Error(`unexpected request: ${url}`)
  }
  const github = reader({ fetchImpl: captureFetch })
  const captured = await github.capturePullRequest({ repository: REPOSITORY, pr: 17, budget: budget() })
  expect(captured.eligibility).toEqual({ kind: "review" })
  expect(JSON.parse(JSON.stringify(captured.identity))).toEqual({ repositoryId: "123456789", repository: REPOSITORY, pr: 17 })
  expect(String(captured.baseSha)).toBe("a".repeat(40))
  expect(String(captured.headSha)).toBe("b".repeat(40))

  const eligibility = async (pull: unknown) => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input)
      if (url === REPO_URL) return jsonResponse(repositoryResponse)
      if (url === PULLS_URL) return jsonResponse(pull)
      throw new Error(`unexpected request: ${url}`)
    }
    return (await reader({ fetchImpl }).capturePullRequest({ repository: REPOSITORY, pr: 17, budget: budget() })).eligibility
  }
  expect(await eligibility(pullResponse({ state: "closed", draft: true, head: { sha: "b".repeat(40), repo: null } }))).toEqual({ kind: "skip", reason: "closed" })
  expect(await eligibility(pullResponse({ head: { sha: "b".repeat(40), repo: null } }))).toEqual({ kind: "skip", reason: "fork" })
  expect(await eligibility(pullResponse({ head: { sha: "b".repeat(40), repo: { id: 999999999 } } }))).toEqual({ kind: "skip", reason: "fork" })
  expect(await eligibility(pullResponse({ draft: true }))).toEqual({ kind: "skip", reason: "draft" })
  // An omitted and a null head repository normalize to the same skip decision.
  expect(await eligibility(pullResponse({ state: "closed", head: { sha: "b".repeat(40) } }))).toEqual({ kind: "skip", reason: "closed" })
  expect(await eligibility(pullResponse({ head: { sha: "b".repeat(40) } }))).toEqual({ kind: "skip", reason: "fork" })

  const mismatch = async (pull: unknown, repository: unknown, code: Failure["code"]) =>
    expectGitHubError((async () => {
      const fetchImpl: FetchLike = async (input) => jsonResponse(String(input) === REPO_URL ? repository : pull)
      await reader({ fetchImpl }).capturePullRequest({ repository: REPOSITORY, pr: 17, budget: budget() })
    })(), code)
  await mismatch(pullResponse(), { ...repositoryResponse, full_name: "Other/repository" }, "github-not-found")
  await mismatch(pullResponse({ number: 18 }), repositoryResponse, "github-not-found")
  await mismatch(pullResponse({ base: { sha: "a".repeat(40), repo: { id: 999999999 } } }), repositoryResponse, "github-not-found")
  await expectGitHubError(reader({ fetchImpl: captureFetch }).capturePullRequest({ repository: "not a repository", pr: 17, budget: budget() }), "input-invalid")
  await expectGitHubError(reader({ fetchImpl: captureFetch }).capturePullRequest({ repository: REPOSITORY, pr: 0, budget: budget() }), "input-invalid")
})

test("read retries stop after two delays and never retry authentication, permission, or not-found failures", async () => {
  const sequence = (responses: Response[]): { fetchImpl: FetchLike; calls: () => number } => {
    let calls = 0
    return {
      fetchImpl: async () => {
        const response = responses[Math.min(calls, responses.length - 1)]
        calls += 1
        return response
      },
      calls: () => calls,
    }
  }
  const read = async (responses: Response[]) => {
    const { fetchImpl, calls } = sequence(responses)
    const clock = manualClock()
    const github = reader({ fetchImpl, clock })
    const observation = github.readWorkflow({ repository: REPOSITORY, runId: "987654321", budget: budget(clock) })
    return { observation, calls }
  }

  const retried = await read([statusResponse(429), statusResponse(429), jsonResponse(workflowResponse)])
  expect(Number((await retried.observation).currentAttempt)).toBe(1)
  expect(retried.calls()).toBe(3)

  const rateLimited = await read([statusResponse(429, { "retry-after": "5" }), statusResponse(429), statusResponse(429)])
  await expectGitHubError(rateLimited.observation, "github-rate-limit")
  expect(rateLimited.calls()).toBe(3)

  const unavailable = await read([statusResponse(503), statusResponse(502), statusResponse(500)])
  await expectGitHubError(unavailable.observation, "github-unavailable")
  expect(unavailable.calls()).toBe(3)

  const brokenTransport: FetchLike = async () => { throw new TypeError("connection reset") }
  const brokenClock = manualClock()
  const broken = reader({ fetchImpl: brokenTransport, clock: brokenClock })
  await expectGitHubError(broken.readWorkflow({ repository: REPOSITORY, runId: "987654321", budget: budget(brokenClock) }), "github-unavailable")
  expect(brokenClock.sleeps).toEqual([1_000, 2_000])

  for (const [response, code] of [
    [statusResponse(401), "github-auth"],
    [statusResponse(403), "github-forbidden"],
    [statusResponse(404), "github-not-found"],
    [statusResponse(302, { location: "https://example.invalid" }), "github-unavailable"],
  ] as const) {
    const single = await read([response as unknown as Response])
    await expectGitHubError(single.observation, code)
    expect(single.calls()).toBe(1)
  }
})

test("a secondary rate-limit 403 retries on explicit evidence and ordinary permission failures do not", async () => {
  const evidence: FetchLike = async () => statusResponse(403, { "retry-after": "1" })
  const clock = manualClock()
  await expectGitHubError(reader({ fetchImpl: evidence, clock }).readWorkflow({ repository: REPOSITORY, runId: "987654321", budget: budget(clock) }), "github-rate-limit")
  expect(clock.sleeps).toEqual([1_000, 2_000])

  const remaining = await (async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return calls === 1 ? statusResponse(403, { "x-ratelimit-remaining": "0" }) : jsonResponse(workflowResponse)
    }
    return reader({ fetchImpl }).readWorkflow({ repository: REPOSITORY, runId: "987654321", budget: budget() })
  })()
  expect((await remaining).status).toBe("in_progress")
})

test("retry delays honor Retry-After as a lower bound and stop when they cannot fit the budget", async () => {
  const clock = manualClock()
  const delayed: FetchLike = async () => statusResponse(429, { "retry-after": "5" })
  await expectGitHubError(reader({ fetchImpl: delayed, clock }).readWorkflow({ repository: REPOSITORY, runId: "987654321", budget: budget(clock) }), "github-rate-limit")
  expect(clock.sleeps).toEqual([5_000, 5_000])

  const shortClock = manualClock()
  const shortBudget = budget(shortClock)
  shortClock.advance(299_000)
  await expectGitHubError(
    reader({ fetchImpl: delayed, clock: shortClock }).readWorkflow({ repository: REPOSITORY, runId: "987654321", budget: shortBudget }),
    "github-rate-limit",
  )
  expect(shortClock.sleeps).toEqual([])
})

test("response bodies stream under the byte cap and the abort timer covers body consumption", async () => {
  let cancelled = false
  let chunks = 0
  const chunk = new Uint8Array(512 * 1024).fill(0x78)
  const streaming: FetchLike = async () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
        chunks += 1
      },
      pull(controller) {
        if (chunks < 8) {
          controller.enqueue(chunk)
          chunks += 1
        } else controller.close()
      },
      cancel() {
        cancelled = true
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
  await expectGitHubError(
    reader({ fetchImpl: streaming }).readWorkflow({ repository: REPOSITORY, runId: "987654321", budget: budget() }),
    "github-unavailable",
  )
  expect(cancelled).toBe(true)

  const stalling: FetchLike = async () => new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        // The body never completes, so only the abort timer can end the read.
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
  const stalledClock = manualClock()
  const stalledBudget = budget(stalledClock)
  stalledClock.advance(299_900)
  await expectGitHubError(
    reader({ fetchImpl: stalling }).readWorkflow({ repository: REPOSITORY, runId: "987654321", budget: stalledBudget }),
    "prepare-timeout",
  )
})

test("permanent transport failures fail outright and unaffordable non-rate-limit delays return the stage timeout", async () => {
  for (const message of ["error:0A000086:SSL routines::certificate verify failed", "Invalid URL: malformed input to parser"]) {
    let calls = 0
    const clock = manualClock()
    const permanent: FetchLike = async () => {
      calls += 1
      throw new TypeError(message)
    }
    await expectGitHubError(
      reader({ fetchImpl: permanent, clock }).readWorkflow({ repository: REPOSITORY, runId: "987654321", budget: budget(clock) }),
      "github-unavailable",
    )
    expect(calls).toBe(1)
    expect(clock.sleeps).toEqual([])
  }

  const shortClock = manualClock()
  const shortBudget = budget(shortClock)
  shortClock.advance(299_000)
  const delayed: FetchLike = async () => statusResponse(503, { "retry-after": "5" })
  await expectGitHubError(
    reader({ fetchImpl: delayed, clock: shortClock }).readWorkflow({ repository: REPOSITORY, runId: "987654321", budget: shortBudget }),
    "prepare-timeout",
  )
  expect(shortClock.sleeps).toEqual([])

  const broken: FetchLike = async () => { throw new TypeError("connection reset") }
  const brokenClock = manualClock()
  const brokenBudget = budget(brokenClock)
  brokenClock.advance(299_500)
  await expectGitHubError(
    reader({ fetchImpl: broken, clock: brokenClock }).readWorkflow({ repository: REPOSITORY, runId: "987654321", budget: brokenBudget }),
    "prepare-timeout",
  )
  expect(brokenClock.sleeps).toEqual([])
})

test("requests carry fixed headers and disabled redirects", async () => {
  const inspecting: FetchLike = async (_input, init) => {
    if (init === undefined) throw new Error("expected request init")
    expect(init.redirect).toBe("manual")
    expect(init.method).toBe("GET")
    const headers = new Headers(init.headers)
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
    expect(headers.get("accept")).toBe("application/vnd.github+json")
    expect(headers.get("x-github-api-version")).toBe("2022-11-28")
    expect(headers.get("user-agent")).toBe("ai-code-review")
    return jsonResponse(workflowResponse)
  }
  await reader({ fetchImpl: inspecting }).readWorkflow({ repository: REPOSITORY, runId: "987654321", budget: budget() })
})

test("malformed JSON, schema mismatch, and oversized bodies fail outright", async () => {
  const malformed: FetchLike = async () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } })
  await expectGitHubError(reader({ fetchImpl: malformed }).readWorkflow({ repository: REPOSITORY, runId: "987654321", budget: budget() }), "github-unavailable")

  const wrongShape: FetchLike = async () => jsonResponse({ id: 987654321 })
  await expectGitHubError(reader({ fetchImpl: wrongShape }).readWorkflow({ repository: REPOSITORY, runId: "987654321", budget: budget() }), "github-unavailable")

  const oversized: FetchLike = async () => new Response("{}", { status: 200, headers: { "content-length": "3145728" } })
  await expectGitHubError(reader({ fetchImpl: oversized }).readWorkflow({ repository: REPOSITORY, runId: "987654321", budget: budget() }), "github-unavailable")
})

test("product comments scan every page before absence and enforce the bot author policy", async () => {
  const pageUrl = commentsPageUrl

  const absent = listFetch({ [pageUrl(1)]: () => jsonResponse([humanComment(1, "looks fine"), humanComment(2, marker())]) })
  expect(await reader({ fetchImpl: absent.fetchImpl }).readProductComment({ identity, budget: budget() })).toEqual({ kind: "absent", duplicateIds: [], humanMarkerIds: ["2"] })
  expect(absent.requests()).toBe(1)

  const reported: string[] = []
  for (const user of [{ login: "octocat", id: 41898282, type: "Bot" }, { login: "github-actions[bot]", id: 1, type: "Bot" }, { login: "github-actions[bot]", id: 41898282, type: "User" }]) {
    const forged = listFetch({ [pageUrl(1)]: () => jsonResponse([{ ...botComment(7, marker()), user }]) })
    const observation = await reader({ fetchImpl: forged.fetchImpl }).readProductComment({ identity, budget: budget() })
    expect(observation.kind).toBe("absent")
    if (observation.kind === "absent") reported.push(...observation.humanMarkerIds)
  }
  expect(reported).toEqual(["7", "7", "7"])

  const wrongPull = listFetch({ [pageUrl(1)]: () => jsonResponse([botComment(7, marker(123456789, 18))]) })
  expect(await reader({ fetchImpl: wrongPull.fetchImpl }).readProductComment({ identity, budget: budget() })).toEqual({ kind: "absent", duplicateIds: [], humanMarkerIds: [] })

  const firstPage = Array.from({ length: 100 }, (_, index) => humanComment(index + 1, "discussion"))
  const found = listFetch({
    [pageUrl(1)]: () => jsonResponse(firstPage),
    [pageUrl(2)]: () => jsonResponse([humanComment(101, "late note"), botComment(500, `${marker()}\nPrevious report.`)]),
  })
  const observation = await reader({ fetchImpl: found.fetchImpl }).readProductComment({ identity, budget: budget() })
  expect(observation.kind).toBe("owned")
  if (observation.kind === "owned") {
    expect(String(observation.canonical.id)).toBe("500")
    expect(observation.canonical.body).toBe(`${marker()}\nPrevious report.`)
    expect(observation.duplicateIds).toEqual([])
  }
  expect(found.requests()).toBe(2)

  const linkedUrl = `${COMMENTS_URL}?per_page=100&cursor=2&page=2`
  const linked = listFetch({
    [pageUrl(1)]: () => jsonResponse(firstPage, { link: `<${linkedUrl}>; rel="next"` }),
    [linkedUrl]: () => jsonResponse([botComment(300, marker())]),
  })
  const linkedObservation = await reader({ fetchImpl: linked.fetchImpl }).readProductComment({ identity, budget: budget() })
  expect(linkedObservation.kind).toBe("owned")
  expect(linked.requests()).toBe(2)

  const duplicates = listFetch({
    [pageUrl(1)]: () => jsonResponse([...firstPage.slice(0, 99), botComment(500, marker())], { link: `<${pageUrl(2)}>; rel="next"` }),
    [pageUrl(2)]: () => jsonResponse([botComment(300, marker()), botComment(400, marker())]),
  })
  const duplicateObservation = await reader({ fetchImpl: duplicates.fetchImpl }).readProductComment({ identity, budget: budget() })
  expect(duplicateObservation.kind).toBe("owned")
  if (duplicateObservation.kind === "owned") {
    expect(String(duplicateObservation.canonical.id)).toBe("300")
    expect(duplicateObservation.duplicateIds).toEqual(["400", "500"])
  }

  const crossOrigin = listFetch({
    [pageUrl(1)]: () => jsonResponse(firstPage, { link: `<https://example.invalid/comments?page=2>; rel="next"` }),
  })
  await expectGitHubError(reader({ fetchImpl: crossOrigin.fetchImpl }).readProductComment({ identity, budget: budget() }), "comment-list-limit")

  const repeated = listFetch({
    [pageUrl(1)]: () => jsonResponse(firstPage),
    [pageUrl(2)]: () => jsonResponse(firstPage),
  })
  await expectGitHubError(reader({ fetchImpl: repeated.fetchImpl }).readProductComment({ identity, budget: budget() }), "comment-list-limit")

  let endlessCalls = 0
  const endless: FetchLike = async (input) => {
    endlessCalls += 1
    const page = Number(new URL(String(input)).searchParams.get("page") ?? "1")
    const pageComments = Array.from({ length: 100 }, (_, index) => humanComment(page * 1_000 + index, "discussion"))
    return jsonResponse(pageComments, { link: `<${COMMENTS_URL}?per_page=100&page=${page + 1}>; rel="next"` })
  }
  await expectGitHubError(reader({ fetchImpl: endless }).readProductComment({ identity, budget: budget() }), "comment-list-limit")
  expect(endlessCalls).toBe(200)

  const large = "x".repeat(70_000)
  const oversized: FetchLike = async (input) => {
    const page = Number(new URL(String(input)).searchParams.get("page") ?? "1")
    if (page > 3) throw new Error("expected the byte cap to stop the scan first")
    return jsonResponse(Array.from({ length: 100 }, (_, index) => humanComment(page * 1000 + index, large)))
  }
  await expectGitHubError(reader({ fetchImpl: oversized }).readProductComment({ identity, budget: budget() }), "comment-list-limit")
})

test("comment ownership requires the complete first marker line and reports foreign marker copies", async () => {
  const trailing = async (body: string, expectOwned: boolean, expectIds: string[]): Promise<void> => {
    const fetchImpl: FetchLike = async () => jsonResponse([botComment(7, body)])
    const observation = await reader({ fetchImpl }).readProductComment({ identity, budget: budget() })
    expect(observation.kind).toBe(expectOwned ? "owned" : "absent")
    if (observation.kind === "owned") {
      expect(observation.canonical.body).toBe(body)
      expect(observation.duplicateIds).toEqual([])
    } else if (observation.kind === "absent") {
      expect(observation.humanMarkerIds).toEqual(expectIds)
    }
  }
  // Extra text after the marker on the first line means the comment is not the product comment.
  await trailing(`${marker()} trailing text on the first line`, false, [])
  // An exact first line followed by more lines is owned.
  await trailing(`${marker()}\nPrevious report.`, true, [])
  // A human's exact marker copy is never owned, but its ID stays available for the job summary.
  const human = listFetch({ [`${COMMENTS_URL}?per_page=100&page=1`]: () => jsonResponse([humanComment(9, marker())]) })
  const humanObservation = await reader({ fetchImpl: human.fetchImpl }).readProductComment({ identity, budget: budget() })
  expect(humanObservation.kind).toBe("absent")
  if (humanObservation.kind === "absent") expect(humanObservation.humanMarkerIds).toEqual(["9"])
})

test("comment pagination rejects overlapping, repeated, and unrecognized results", async () => {
  const pageUrl = (page: number) => `${COMMENTS_URL}?per_page=100&page=${page}`
  const firstPage = Array.from({ length: 100 }, (_, index) => humanComment(index + 1, "discussion"))

  // The same IDs in reverse order are still a repeated result, not a second page.
  const reversed = listFetch({
    [pageUrl(1)]: () => jsonResponse(firstPage),
    [pageUrl(2)]: () => jsonResponse([...firstPage].reverse()),
  })
  await expectGitHubError(reader({ fetchImpl: reversed.fetchImpl }).readProductComment({ identity, budget: budget() }), "comment-list-limit")

  // Overlapping pages cannot bound the comment set they claim to have shown.
  const overlapping = listFetch({
    [pageUrl(1)]: () => jsonResponse(firstPage, { link: `<${pageUrl(2)}>; rel="next"` }),
    [pageUrl(2)]: () => jsonResponse([...firstPage.slice(50), ...Array.from({ length: 50 }, (_, index) => humanComment(200 + index, "more"))]),
  })
  await expectGitHubError(reader({ fetchImpl: overlapping.fetchImpl }).readProductComment({ identity, budget: budget() }), "comment-list-limit")

  for (const link of [`<${pageUrl(2)}>; rel="next"; foo="bar"`, `not a link header`, `<${pageUrl(2)}>;rel=next`]) {
    const unrecognized = listFetch({ [pageUrl(1)]: () => jsonResponse(firstPage, { link }) })
    await expectGitHubError(
      reader({ fetchImpl: unrecognized.fetchImpl }).readProductComment({ identity, budget: budget() }),
      "comment-list-limit",
    )
  }

  const loopsBack = listFetch({
    [pageUrl(1)]: () => jsonResponse(firstPage, { link: `<${pageUrl(1)}>; rel="next"` }),
  })
  await expectGitHubError(reader({ fetchImpl: loopsBack.fetchImpl }).readProductComment({ identity, budget: budget() }), "comment-list-limit")

  const otherPull = listFetch({
    [pageUrl(1)]: () => jsonResponse(firstPage, { link: `<${COMMENTS_URL.replace("/issues/17/", "/issues/18/")}?per_page=100&page=2>; rel="next"` }),
  })
  await expectGitHubError(reader({ fetchImpl: otherPull.fetchImpl }).readProductComment({ identity, budget: budget() }), "comment-list-limit")

  const cursorOnly = listFetch({
    [pageUrl(1)]: () => jsonResponse(firstPage, { link: `<${COMMENTS_URL}?per_page=100&cursor=2>; rel="next"` }),
  })
  await expectGitHubError(reader({ fetchImpl: cursorOnly.fetchImpl }).readProductComment({ identity, budget: budget() }), "comment-list-limit")
})

test("a discarded error response body is cancelled before classification", async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => { controller.enqueue(new TextEncoder().encode("not found")) },
    cancel: () => { cancelled = true },
  })
  const fetchImpl: FetchLike = async () => new Response(stream, { status: 404, headers: { "content-type": "application/json" } })
  await expectGitHubError(reader({ fetchImpl }).capturePullRequest({ repository: REPOSITORY, pr: 17, budget: budget() }), "github-not-found")
  expect(cancelled).toBe(true)
})

test("a directory at the configuration path fails as an invalid configuration, not a failed Git read", async () => {
  const fixture = await repositoryFixture({ files: { "review.config.json/inner.txt": "nested\n" } })
  try {
    await expectGitHubError(
      reader({ origin: fixture.origin }).prepareFixedRepository({ captured: capture(fixture), configPath: "review.config.json", budget: budget() }),
      "config-invalid",
    )
  } finally { await fixture.dispose() }
})

test("a directory at a citation path fails as an invalid citation, not a failed Git read", async () => {
  const fixture = await repositoryFixture({ files: { "src/Pkg.java/inner.txt": "nested\n" } })
  try {
    await expectGitHubError(
      reader({ origin: fixture.origin }).readFixedLines({ repository: REPOSITORY, sha: gitShaSchema.parse(fixture.baseSha), path: "src/Pkg.java", startLine: 1, endLine: 1, budget: budget() }),
      "citation-invalid",
    )
  } finally { await fixture.dispose() }
})

test("artifact receipts report absence as null and reject ambiguous matches", async () => {
  const absent: FetchLike = async (input) => {
    expect(String(input)).toBe(ARTIFACTS_URL)
    return jsonResponse({ total_count: 0, artifacts: [] })
  }
  expect(await reader({ fetchImpl: absent }).readArtifactReceipt({ identity, execution: actionsExecution, budget: budget() })).toBeNull()

  const present: FetchLike = async () => jsonResponse({
    total_count: 1,
    artifacts: [{ id: 4242, name: "ai-code-review-handoff-987654321-1", size_in_bytes: 2048, expired: false, workflow_run: { id: 987654321 } }],
  })
  const receipt = await reader({ fetchImpl: present }).readArtifactReceipt({ identity, execution: actionsExecution, budget: budget() })
  expect(receipt).toEqual({ id: "4242", name: "ai-code-review-handoff-987654321-1", workflowRunId: "987654321", bytes: 2048, expired: false, digest: null })

  const ambiguous: FetchLike = async () => jsonResponse({
    total_count: 2,
    artifacts: [
      { id: 1, name: "ai-code-review-handoff-987654321-1", size_in_bytes: 1, expired: false },
      { id: 2, name: "ai-code-review-handoff-987654321-1", size_in_bytes: 2, expired: false },
    ],
  })
  await expectGitHubError(reader({ fetchImpl: ambiguous }).readArtifactReceipt({ identity, execution: actionsExecution, budget: budget() }), "artifact-invalid")

  const foreign: FetchLike = async () => jsonResponse({
    total_count: 1,
    artifacts: [{ id: 3, name: "ai-code-review-handoff-987654321-1", size_in_bytes: 3, expired: false, workflow_run: { id: 111111111 } }],
  })
  await expectGitHubError(reader({ fetchImpl: foreign }).readArtifactReceipt({ identity, execution: actionsExecution, budget: budget() }), "artifact-invalid")
})

test("prepareFixedRepository reads the frozen base configuration so a head edit cannot change limits", async () => {
  const baseConfig = Buffer.from('{"maxChangedFiles":1,"maxPatchBytes":100,"maxSnapshotBytes":1000}\n')
  const headConfig = '{"maxChangedFiles":50,"maxPatchBytes":262144,"maxSnapshotBytes":8388608}\n'
  const fixture = await repositoryFixture({ files: { "review.config.json": baseConfig }, headFiles: { "review.config.json": headConfig, "src.txt": "one\ntwo\nthree\nfive\n" } })
  try {
    const github = reader({ origin: fixture.origin })
    const fixed = await github.prepareFixedRepository({ captured: capture(fixture), configPath: "review.config.json", budget: budget() })
    try {
      expect(fixed.config).toEqual({ maxChangedFiles: 1, maxPatchBytes: 100, maxSnapshotBytes: 1000 })
      expect(JSON.parse(JSON.stringify(fixed.configSource))).toEqual({
        kind: "base-blob",
        path: "review.config.json",
        sha: fixture.baseSha,
        digest: createHash("sha256").update(baseConfig).digest("hex"),
      })
      expect(git(fixed.directory, "merge-base", fixture.baseSha, fixture.headSha)).toBe(fixture.baseSha)
    } finally {
      await fixed.dispose()
    }
    await expect(access(join(fixture.root, "does-not-exist"))).rejects.toThrow()
  } finally {
    await fixture.dispose()
  }
})

test("a missing default configuration falls back to the product default and other paths must exist", async () => {
  const productBytes = new Uint8Array(await readFile(productReviewConfigPath))
  const fixture = await repositoryFixture()
  try {
    const github = reader({ origin: fixture.origin })
    const defaulted = await github.prepareFixedRepository({ captured: capture(fixture), configPath: "review.config.json", budget: budget() })
    try {
      expect(defaulted.config).toEqual(reviewLimitsSchema.parse(JSON.parse(new TextDecoder().decode(productBytes))))
      expect(JSON.parse(JSON.stringify(defaulted.configSource))).toEqual({ kind: "product-default", digest: createHash("sha256").update(productBytes).digest("hex") })
    } finally {
      await defaulted.dispose()
    }
    await expectGitHubError(
      github.prepareFixedRepository({ captured: capture(fixture), configPath: "configs/review.json", budget: budget() }),
      "config-invalid",
    )
  } finally {
    await fixture.dispose()
  }
})

test("malformed, non-regular, and oversized configuration blobs fail as config-invalid", async () => {
  const malformed = await repositoryFixture({ files: { "custom.json": "not json at all\n" } })
  try {
    await expectGitHubError(
      reader({ origin: malformed.origin }).prepareFixedRepository({ captured: capture(malformed), configPath: "custom.json", budget: budget() }),
      "config-invalid",
    )
  } finally { await malformed.dispose() }

  const extraField = await repositoryFixture({ files: { "custom.json": '{"maxChangedFiles":1,"maxPatchBytes":100,"maxSnapshotBytes":1000,"extra":true}\n' } })
  try {
    await expectGitHubError(
      reader({ origin: extraField.origin }).prepareFixedRepository({ captured: capture(extraField), configPath: "custom.json", budget: budget() }),
      "config-invalid",
    )
  } finally { await extraField.dispose() }

  const linked = await repositoryFixture({ files: { "real.json": '{"maxChangedFiles":1,"maxPatchBytes":100,"maxSnapshotBytes":1000}\n' }, baseSymlink: { path: "custom.json", target: "real.json" } })
  try {
    await expectGitHubError(
      reader({ origin: linked.origin }).prepareFixedRepository({ captured: capture(linked), configPath: "custom.json", budget: budget() }),
      "config-invalid",
    )
  } finally { await linked.dispose() }

  const padded = `{"maxChangedFiles":1,${" ".repeat(17_000)}"maxPatchBytes":100,"maxSnapshotBytes":1000}\n`
  const oversized = await repositoryFixture({ files: { "custom.json": padded } })
  try {
    await expectGitHubError(
      reader({ origin: oversized.origin }).prepareFixedRepository({ captured: capture(oversized), configPath: "custom.json", budget: budget() }),
      "config-invalid",
    )
  } finally { await oversized.dispose() }
})

test("a missing captured object fails as snapshot-fetch without substituting a newer SHA", async () => {
  const fixture = await repositoryFixture()
  try {
    const missing = { ...capture(fixture), headSha: gitShaSchema.parse("e".repeat(40)) }
    await expectGitHubError(
      reader({ origin: fixture.origin }).prepareFixedRepository({ captured: missing, configPath: "review.config.json", budget: budget() }),
      "snapshot-fetch",
    )
  } finally {
    await fixture.dispose()
  }
})

test("the askpass helper carries no token and the remote URL carries no credentials", async () => {
  const fixture = await repositoryFixture({ files: { "review.config.json": '{"maxChangedFiles":1,"maxPatchBytes":100,"maxSnapshotBytes":1000}\n' } })
  try {
    expect(canonicalRepositoryUrl(REPOSITORY)).toBe(`https://github.com/${REPOSITORY}.git`)
    const invocations: GitObservation[] = []
    const github = reader({
      origin: fixture.origin,
      observeGit: (invocation) => invocations.push(invocation),
    })
    const fixed = await github.prepareFixedRepository({ captured: capture(fixture), configPath: "review.config.json", budget: budget() })
    const parent = dirname(fixed.directory)
    try {
      expect(invocations.length).toBeGreaterThan(0)
      for (const invocation of invocations) {
        expect(Object.keys(invocation.env).sort()).toEqual([
          "GIT_ASKPASS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT",
          "PATH", "REVIEW_GIT_ASKPASS_TOKEN",
        ])
        expect(invocation.env.GITHUB_TOKEN).toBeUndefined()
        expect(invocation.env.REVIEW_GIT_ASKPASS_TOKEN).toBe(TOKEN)
        expect(invocation.env.GIT_TERMINAL_PROMPT).toBe("0")
        expect(invocation.env.GIT_CONFIG_NOSYSTEM).toBe("1")
        expect(invocation.env.GIT_CONFIG_GLOBAL).toBe("/dev/null")
        for (const arg of invocation.args) expect(arg).not.toContain(TOKEN)
        const fetchCall = invocation.args.find((arg) => arg === fixture.origin)
        if (fetchCall !== undefined) expect(fetchCall).not.toContain("@")
        const helper = readFileSync(invocation.env.GIT_ASKPASS!, "utf8")
        expect(helper).toContain('printf \'%s\\n\' "$REVIEW_GIT_ASKPASS_TOKEN"')
        expect(helper).not.toContain(TOKEN)
      }
      const fetchInvocation = invocations.find((invocation) => invocation.args.includes("fetch"))
      expect(fetchInvocation?.args).toContain(fixture.origin)
      expect(fetchInvocation?.args).toContain("--no-tags")
    } finally {
      await fixed.dispose()
    }
    await expect(access(parent)).rejects.toThrow()
  } finally {
    await fixture.dispose()
  }
})

test("a glob-shaped configuration path cannot select a different blob and both regular modes are accepted", async () => {
  // Without literal pathspecs, "review[1].json" would glob-match the review1.json blob.
  const fixture = await repositoryFixture({ files: { "review1.json": '{"maxChangedFiles":7,"maxPatchBytes":100,"maxSnapshotBytes":1000}\n' } })
  try {
    await expectGitHubError(
      reader({ origin: fixture.origin }).prepareFixedRepository({ captured: capture(fixture), configPath: "review[1].json", budget: budget() }),
      "config-invalid",
    )
  } finally { await fixture.dispose() }

  const executable = await repositoryFixture({
    files: { "custom.json": '{"maxChangedFiles":2,"maxPatchBytes":100,"maxSnapshotBytes":1000}\n' },
    executables: ["custom.json"],
  })
  try {
    const fixed = await reader({ origin: executable.origin }).prepareFixedRepository({ captured: capture(executable), configPath: "custom.json", budget: budget() })
    try {
      expect(fixed.config).toEqual({ maxChangedFiles: 2, maxPatchBytes: 100, maxSnapshotBytes: 1000 })
      expect(fixed.configSource.kind).toBe("base-blob")
    } finally {
      await fixed.dispose()
    }
  } finally { await executable.dispose() }
})

test("an empty fixed blob has zero lines", async () => {
  const fixture = await repositoryFixture({ files: { "src/Empty.java": "" } })
  try {
    const github = reader({ origin: fixture.origin })
    await expectGitHubError(github.readFixedLines({
      repository: REPOSITORY, sha: gitShaSchema.parse(fixture.baseSha), path: "src/Empty.java", startLine: 1, endLine: 1, budget: budget(),
    }), "citation-invalid")
  } finally {
    await fixture.dispose()
  }
})

test("readFixedLines serves fixed-commit lines under the existing line rules", async () => {
  const fixture = await repositoryFixture({ files: { "src/example/Service.java": "line one\nline two\nline three\nline four\n" } })
  try {
    const github = reader({ origin: fixture.origin })
    const text = await github.readFixedLines({
      repository: REPOSITORY,
      sha: gitShaSchema.parse(fixture.baseSha),
      path: "src/example/Service.java",
      startLine: 2,
      endLine: 3,
      budget: budget(),
    })
    expect(text).toBe("line two\nline three")
    await expectGitHubError(github.readFixedLines({
      repository: REPOSITORY, sha: gitShaSchema.parse(fixture.baseSha), path: "src/example/Service.java", startLine: 1, endLine: 99, budget: budget(),
    }), "citation-invalid")
    await expectGitHubError(github.readFixedLines({
      repository: REPOSITORY, sha: gitShaSchema.parse(fixture.baseSha), path: "src/example/Absent.java", startLine: 1, endLine: 1, budget: budget(),
    }), "citation-invalid")
  } finally {
    await fixture.dispose()
  }
})

const actionsEnv = (eventPath: string, overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  GITHUB_REPOSITORY: "PulseInjector/java-review",
  GITHUB_REPOSITORY_ID: "123456789",
  GITHUB_RUN_ID: "987654321",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_EVENT_PATH: eventPath,
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_TOKEN: TOKEN,
  ...overrides,
})

const workflowFetch = (overrides: Record<string, unknown> = {}): FetchLike => async (input) => {
  expect(String(input)).toBe(WORKFLOW_URL)
  return jsonResponse({ ...workflowResponse, ...overrides })
}

const failingFetch: FetchLike = async (input) => {
  throw new Error(`the local path must not construct a GitHub adapter: ${String(input)}`)
}

async function writeEvent(value: unknown): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "github-event-")), "event.json")
  await writeFile(path, JSON.stringify(value))
  return path
}

test("readExecutionContext resolves a local identity without a token or adapter", async () => {
  const local = await readExecutionContext({}, budget(), { fetch: failingFetch })
  expect(local.attemptStartedAt).toBeNull()
  expect(local.execution.kind).toBe("local")
  if (local.execution.kind === "local") {
    expect(local.execution.reviewRunId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(local.execution.trigger).toEqual({ kind: "local" })
    expect(local.execution.triggeredAt).toBe("2026-11-21T00:00:00.000Z")
  }
  await expectGitHubError(readExecutionContext({ GITHUB_RUN_ID: "987654321" }, budget(), { fetch: failingFetch }), "input-invalid")
})

test("readExecutionContext discards event commit fields and binds the Actions identity to the API run", async () => {
  const eventPath = await writeEvent({
    action: "opened",
    pull_request: {
      number: 17,
      head: { sha: "0".repeat(40) },
      base: { sha: "1".repeat(40) },
      merge_commit_sha: "2".repeat(40),
    },
  })
  const resolved = await readExecutionContext(actionsEnv(eventPath), budget(), { fetch: workflowFetch() }, { pr: 17 })
  const execution = resolved.execution
  expect(execution.kind).toBe("actions")
  if (execution.kind === "actions") {
    expect(execution.reviewRunId).toBe("gh-987654321-1")
    expect(String(execution.workflowRunId)).toBe("987654321")
    expect(Number(execution.attempt)).toBe(1)
    expect(execution.trigger).toEqual({ kind: "pull-request", action: "opened" })
    expect(execution.triggeredAt).toBe("2026-11-21T10:00:00Z")
    expect(execution.startedAt).toBe("2026-11-21T00:00:00.000Z")
    expect(execution.runUrl).toBe("https://github.com/PulseInjector/java-review/actions/runs/987654321")
  }
  // The workflow API's attempt start is carried onward separately from the command-entry time.
  expect(resolved.attemptStartedAt).toBe("2026-11-21T10:00:05Z")
  await expectGitHubError(
    readExecutionContext(actionsEnv(eventPath), budget(), { fetch: workflowFetch() }, { pr: 18 }),
    "input-invalid",
  )
  await expectGitHubError(
    readExecutionContext(actionsEnv(eventPath, { GITHUB_SERVER_URL: "https://github.example.com" }), budget(), { fetch: workflowFetch() }),
    "input-invalid",
  )
  await expectGitHubError(
    readExecutionContext(actionsEnv(eventPath, { GITHUB_RUN_ID: "987654321", GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_NAME: "pull_request" }), budget(), { fetch: workflowFetch({ event: "workflow_dispatch" }) }),
    "input-invalid",
  )
  await expectGitHubError(
    readExecutionContext(actionsEnv(eventPath), budget(), { fetch: workflowFetch({ run_attempt: 2 }) }),
    "input-invalid",
  )
  await expectGitHubError(
    readExecutionContext(actionsEnv(eventPath), budget(), { fetch: workflowFetch({ repository: { id: 999999999 } }) }),
    "input-invalid",
  )
})

test("manual dispatch events contribute a canonical decimal PR input", async () => {
  const eventPath = await writeEvent({ inputs: { pr: "17" } })
  const manualEnv = actionsEnv(eventPath, { GITHUB_EVENT_NAME: "workflow_dispatch" })
  const execution = (await readExecutionContext(manualEnv, budget(), { fetch: workflowFetch({ event: "workflow_dispatch" }) }, { pr: 17 })).execution
  expect(execution.kind === "actions" && execution.trigger).toEqual({ kind: "manual" })
  await expectGitHubError(
    readExecutionContext(manualEnv, budget(), { fetch: workflowFetch({ event: "workflow_dispatch" }) }, { pr: 18 }),
    "input-invalid",
  )
  const nonCanonical = await writeEvent({ inputs: { pr: "017" } })
  await expectGitHubError(
    readExecutionContext(actionsEnv(nonCanonical, { GITHUB_EVENT_NAME: "workflow_dispatch" }), budget(), { fetch: workflowFetch({ event: "workflow_dispatch" }) }),
    "input-invalid",
  )
})

test("event schemas strip every field beyond the action and PR number", () => {
  const parsed = pullRequestEventSchema.parse({
    action: "synchronize",
    pull_request: { number: 17, head: { sha: "0".repeat(40) }, base: { sha: "1".repeat(40) }, merge_commit_sha: "2".repeat(40) },
    repository: { id: 123456789, full_name: REPOSITORY },
  })
  expect(JSON.parse(JSON.stringify(parsed))).toEqual({ action: "synchronize", pull_request: { number: 17 } })
  const dispatched = dispatchEventSchema.parse({ inputs: { pr: "17" }, repository: { id: 123456789 } })
  expect(JSON.parse(JSON.stringify(dispatched))).toEqual({ inputs: { pr: 17 } })
})

test("an oversized event payload fails before parsing", async () => {
  const root = await mkdtemp(join(tmpdir(), "github-event-"))
  try {
    const eventPath = join(root, "event.json")
    await writeFile(eventPath, Buffer.alloc(1_048_577, 0x20))
    await expectGitHubError(readExecutionContext(actionsEnv(eventPath), budget(), { fetch: workflowFetch() }), "input-invalid")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
