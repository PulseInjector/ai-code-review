import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { relativePathSchema, splitLines } from "./contracts"
import { parseStateBlock, PRODUCT_BOT_POLICY, scanProductComments, type CommentState } from "./comment"
import { productReviewConfigPath, reviewLimitsSchema, type ReviewLimits } from "./context"
import {
  attemptSchema, canonicalPrInputSchema, commentIdSchema, gitShaSchema, instantSchema, prNumberSchema,
  repositoryIdSchema, repositoryNameSchema, runIdSchema, type GitSha, type Sha256,
} from "./identity"
import {
  actionsExecutionSchema, localExecutionSchema, type ActionsExecution, type Execution,
  type Failure, type PullRequestIdentity, type Trigger,
} from "./pr-contracts"
import { BudgetExhaustedError, systemClock, withinDeadline, withinStage, type Clock, type ExecutionBudget, type Stage } from "./budget"

const API_ORIGIN = "https://api.github.com"
const WEB_ORIGIN = "https://github.com"
const PRODUCT_USER_AGENT = "ai-code-review"
const DEFAULT_CONFIG_PATH = "review.config.json"
const EVENT_JSON_BYTE_LIMIT = 1_048_576
const REQUEST_BYTE_CAP = 2 * 1024 * 1024
const COMMENT_LIST_BYTE_CAP = 20 * 1024 * 1024
const COMMENT_LIST_PAGE_LIMIT = 200
const COMMENT_PAGE_SIZE = 100
const PER_REQUEST_TIMEOUT_MS = 10_000
const RETRY_DELAYS_MS = [1_000, 2_000] as const
const RETRIABLE_STATUSES = new Set([429, 500, 502, 503, 504])
const BOT_LOGIN = PRODUCT_BOT_POLICY.login
const BOT_USER_ID = PRODUCT_BOT_POLICY.id
const BOT_TYPE = PRODUCT_BOT_POLICY.type
const ASKPASS_TOKEN_VARIABLE = "REVIEW_GIT_ASKPASS_TOKEN"
const FIXED_CONFIG_BYTE_LIMIT = 16 * 1024
const FIXED_LINES_FILE_BYTE_LIMIT = 8 * 1024 * 1024
const strictDecoder = new TextDecoder("utf-8", { fatal: true })
const lenientDecoder = new TextDecoder()
const sha256 = (value: Uint8Array | string): Sha256 => createHash("sha256").update(value).digest("hex") as Sha256

// The askpass helper is fixed product code and contains no token. The token reaches it only
// through the child-only environment variable, and its stdout is the only path the token takes
// into Git.
const ASKPASS_SCRIPT = `#!/bin/sh
printf '%s\\n' "$REVIEW_GIT_ASKPASS_TOKEN"
`

export class GitHubError extends Error {
  constructor(message: string, readonly code: Failure["code"], readonly status?: number) {
    super(message)
  }
}

// PR material export runs Git against objects the fixed fetch already brought local, so it needs
// no credentials at all. The explicit environment keeps ambient values, including GITHUB_TOKEN
// and any ambient GIT_* configuration, out of every export child.
export function credentialFreeGitEnvironment(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  }
}

function parseInput<S extends z.ZodType>(schema: S, value: unknown, label: string): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw new GitHubError(`${label} is not valid`, "input-invalid")
  return result.data
}

// A schema mismatch means GitHub changed its response shape; it fails outright, never retries.
function parseResponse<S extends z.ZodType>(schema: S, value: unknown, label: string): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw new GitHubError(`the GitHub ${label} response did not match the expected schema`, "github-unavailable")
  return result.data
}

function parseRepository(repository: string): string {
  return parseInput(repositoryNameSchema, repository, "repository name")
}

export function canonicalRepositoryUrl(repository: string): string {
  return `${WEB_ORIGIN}/${parseRepository(repository)}.git`
}

function apiRepositoryPath(repository: string): string {
  const [owner, name] = parseRepository(repository).split("/")
  return `${API_ORIGIN}/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}`
}

// GitHub JSON numeric IDs become canonical decimal strings before comparison with the branded
// identity schemas, and values outside the safe integer range reject instead of rounding.
const jsonIdSchema = z.number().int().positive().refine((value) => Number.isSafeInteger(value), "GitHub JSON IDs must be safe integers")
const jsonRepositoryIdSchema = jsonIdSchema.transform(String).pipe(repositoryIdSchema)
const jsonRunIdSchema = jsonIdSchema.transform(String).pipe(runIdSchema)
const jsonCommentIdSchema = jsonIdSchema.transform(String).pipe(commentIdSchema)

const repositoryResponseSchema = z.looseObject({
  id: jsonRepositoryIdSchema,
  full_name: repositoryNameSchema,
})
const pullResponseSchema = z.looseObject({
  number: prNumberSchema,
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  base: z.looseObject({ sha: gitShaSchema, repo: z.looseObject({ id: jsonRepositoryIdSchema }) }),
  // An omitted and a null head repository mean the same thing, so both normalize to null.
  head: z.looseObject({ sha: gitShaSchema, repo: z.looseObject({ id: jsonRepositoryIdSchema }).nullable().optional() }),
})
const workflowRunResponseSchema = z.looseObject({
  id: jsonRunIdSchema,
  run_attempt: attemptSchema,
  created_at: instantSchema,
  run_started_at: instantSchema,
  status: z.enum(["queued", "in_progress", "completed"]),
  event: z.enum(["pull_request", "workflow_dispatch"]),
  repository: z.looseObject({ id: jsonRepositoryIdSchema }),
})
const commentAuthorSchema = z.looseObject({ login: z.string(), id: jsonIdSchema.transform(String), type: z.string() })
const commentResponseSchema = z.looseObject({
  id: jsonCommentIdSchema,
  body: z.string(),
  created_at: instantSchema,
  updated_at: instantSchema,
  user: commentAuthorSchema,
})
const commentListSchema = z.array(commentResponseSchema)
const artifactResponseSchema = z.looseObject({
  id: jsonIdSchema.transform(String),
  name: z.string(),
  size_in_bytes: z.int().nonnegative(),
  expired: z.boolean(),
  workflow_run: z.looseObject({ id: jsonRunIdSchema }).nullable().optional(),
})
const artifactListSchema = z.looseObject({ total_count: z.int().nonnegative(), artifacts: z.array(artifactResponseSchema) })

export type PullRequestCapture = {
  identity: PullRequestIdentity
  baseSha: GitSha
  headSha: GitSha
  observedAt: string
  eligibility: { kind: "review" } | { kind: "skip"; reason: "draft" | "closed" | "fork" }
}
export type WorkflowObservation = {
  repositoryId: PullRequestIdentity["repositoryId"]
  runId: ActionsExecution["workflowRunId"]
  currentAttempt: ActionsExecution["attempt"]
  createdAt: string
  attemptStartedAt: string
  status: "queued" | "in_progress" | "completed"
  event: "pull_request" | "workflow_dispatch"
}
export type FixedRepository = {
  directory: string
  config: ReviewLimits
  configSource: { kind: "base-blob"; path: string; sha: GitSha; digest: Sha256 } | { kind: "product-default"; digest: Sha256 }
  dispose(): Promise<void>
}
export type ProductComment = {
  id: z.infer<typeof commentIdSchema>
  authorId: string
  authorLogin: string
  body: string
  createdAt: string
  updatedAt: string
}
export type CommentObservation =
  | { kind: "absent"; duplicateIds: []; humanMarkerIds: string[] }
  | { kind: "valid"; canonical: ProductComment; state: CommentState; duplicateIds: string[]; humanMarkerIds: string[] }
  | { kind: "invalid"; canonical: ProductComment; reason: string; duplicateIds: string[]; humanMarkerIds: string[] }
export type ArtifactReceipt = { id: string; name: string; workflowRunId: string; bytes: number; expired: boolean; digest: Sha256 | null }
export type SourceLineRequest = { sha: GitSha; path: string; startLine: number; endLine: number }
export type FixedSource = { side: "merge-base" | "head"; path: string; text: string }
export type FixedSnapshotEvidence = { mergeBaseSha: GitSha; changedHeadPaths: string[]; sources: FixedSource[] }

export interface GitHubReader {
  capturePullRequest(input: { repository: string; pr: number; budget: ExecutionBudget; stage?: Stage }): Promise<PullRequestCapture>
  readWorkflow(input: { repository: string; runId: string; budget: ExecutionBudget; stage?: Stage }): Promise<WorkflowObservation>
  prepareFixedRepository(input: { captured: PullRequestCapture; configPath: string; budget: ExecutionBudget; stage?: Stage }): Promise<FixedRepository>
  readProductComment(input: { identity: PullRequestIdentity; budget: ExecutionBudget; stage?: Stage }): Promise<CommentObservation>
  readArtifactReceipt(input: { identity: PullRequestIdentity; execution: ActionsExecution; budget: ExecutionBudget; stage?: Stage }): Promise<ArtifactReceipt | null>
  readFixedSnapshot(input: { identity: PullRequestIdentity; baseSha: GitSha; headSha: GitSha; sources?: Pick<FixedSource, "side" | "path">[]; budget: ExecutionBudget; stage?: Stage }): Promise<FixedSnapshotEvidence>
  readFixedLines(input: SourceLineRequest & { repository: string; budget: ExecutionBudget; stage?: Stage }): Promise<string>
}

export interface GitHubPublisher extends GitHubReader {
  writeComment(input: { identity: PullRequestIdentity; existingId: string | null; body: string; budget: ExecutionBudget }): Promise<
    { kind: "confirmed"; comment: ProductComment } | { kind: "unknown"; failure: Failure }
  >
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export type GitObservation = { args: readonly string[]; env: Record<string, string> }
export type GitHubReaderDeps = {
  fetch?: FetchLike
  clock?: Clock
  gitRemoteUrl?: (repository: string) => string
  observeGit?: (invocation: GitObservation) => void
}

function retryAfterMs(headers: Headers): number {
  const value = headers.get("retry-after")
  if (value === null) return 0
  if (/^[0-9]+$/u.test(value)) return Number(value) * 1_000
  const date = Date.parse(value)
  return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now())
}

function rateLimitEvidence(response: Response): boolean {
  return response.headers.get("retry-after") !== null || response.headers.get("x-ratelimit-remaining") === "0"
}

function classifiedError(response: Response): GitHubError {
  const status = response.status
  if (status === 401) return new GitHubError("GitHub rejected the request authentication", "github-auth", status)
  if (status === 403) {
    return rateLimitEvidence(response)
      ? new GitHubError("GitHub rate limited the request", "github-rate-limit", status)
      : new GitHubError("GitHub denied permission for the request", "github-forbidden", status)
  }
  if (status === 404) return new GitHubError("GitHub reported the requested resource as not found", "github-not-found", status)
  if (status === 429) return new GitHubError("GitHub rate limited the request", "github-rate-limit", status)
  return new GitHubError(`GitHub reported status ${status}`, "github-unavailable", status)
}

export function createGitHubReader(env: NodeJS.ProcessEnv, deps: GitHubReaderDeps = {}): GitHubReader {
  const token = typeof env.GITHUB_TOKEN === "string" ? env.GITHUB_TOKEN.trim() : ""
  if (token === "") throw new GitHubError("GITHUB_TOKEN is required for GitHub reads", "github-auth")
  const doFetch: FetchLike = deps.fetch ?? fetch
  const clock = deps.clock ?? systemClock
  const remoteUrl = deps.gitRemoteUrl ?? canonicalRepositoryUrl

  // The body streams against the byte allowance instead of buffering first, and the abort timer
  // covers body consumption so a slow body cannot outlive the per-request budget. Overflow cancels
  // the stream rather than draining the rest of an oversized response.
  async function readCapped(response: Response, byteCap: number, oversizeCode: Failure["code"], signal: AbortSignal): Promise<Uint8Array> {
    const declared = Number(response.headers.get("content-length") ?? "")
    if (Number.isFinite(declared) && declared > byteCap) {
      await response.body?.cancel().catch(() => undefined)
      throw new GitHubError("the GitHub response exceeded the byte cap", oversizeCode)
    }
    const body = response.body
    if (body === null) return new Uint8Array(await response.arrayBuffer())
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    const abort = () => { void reader.cancel().catch(() => undefined) }
    signal.addEventListener("abort", abort, { once: true })
    try {
      for (;;) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        signal.throwIfAborted()
        if (done) break
        received += value.byteLength
        if (received > byteCap) throw new GitHubError("the GitHub response exceeded the byte cap", oversizeCode)
        chunks.push(value)
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error
    } finally {
      signal.removeEventListener("abort", abort)
    }
    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  }

  // Bun's fetch surfaces invalid URLs and TLS certificate rejection as ordinary thrown errors; only
  // their message distinguishes them from transient connection failures, so these markers fail
  // outright without consuming a retry.
  function isPermanentTransportFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /(?:certificate|ssl|tls|x509|invalid url|unable to parse url|failed to parse url)/iu.test(message)
  }

  // One shared read retry policy: transient transport errors, 429, and 500/502/503/504 retry at
  // most twice with 1,000 and 2,000 ms delays, bounded below by Retry-After. Authentication,
  // permission, 404, redirect, schema, malformed-JSON, TLS, and invalid-URL failures never retry.
  // Every request and every backoff consume the calling stage's remaining time, not only the total
  // budget, so capture and preparation stop at their own 60-second cap.
  async function apiJson(input: { url: string; budget: ExecutionBudget; stage: Stage; byteCap?: number; oversizeCode?: Failure["code"] }): Promise<{ value: unknown; bytes: number; headers: Headers }> {
    const deadlineCode = input.stage === "prepare-init" ? "prepare-timeout" : "github-unavailable"
    const byteCap = input.byteCap ?? REQUEST_BYTE_CAP
    const oversizeCode = input.oversizeCode ?? "github-unavailable"
    const request = async (signal: AbortSignal) => {
      const response = await doFetch(input.url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": PRODUCT_USER_AGENT,
        },
        redirect: "manual",
        signal,
      })
      if (response.status !== 200 || signal.aborted) {
        await response.body?.cancel().catch(() => undefined)
        signal.throwIfAborted()
        return { response, bytes: null }
      }
      return { response, bytes: await readCapped(response, byteCap, oversizeCode, signal) }
    }
    try {
      return await withinStage(input.budget, input.stage, async (stageSignal) => {
        for (let attempt = 0; ; attempt++) {
          stageSignal.throwIfAborted()
          input.budget.assertRemaining(input.stage)
          const timeoutMs = Math.min(PER_REQUEST_TIMEOUT_MS, input.budget.stageRemainingMs(input.stage))
          let read: Awaited<ReturnType<typeof request>> | null = null
          try {
            const result = await withinDeadline((requestSignal) => request(AbortSignal.any([stageSignal, requestSignal])), Date.now() + timeoutMs)
            if (result.kind === "completed") read = result.value
          } catch (error) {
            stageSignal.throwIfAborted()
            if (error instanceof GitHubError) throw error
            if (isPermanentTransportFailure(error)) throw new GitHubError("GitHub rejected the request transport permanently", "github-unavailable")
          }
          if (read !== null && read.bytes !== null) {
            const { response, bytes } = read
            try {
              const value: unknown = JSON.parse(lenientDecoder.decode(bytes))
              return { value, bytes: bytes.byteLength, headers: response.headers }
            } catch {
              throw new GitHubError("GitHub returned malformed JSON", "github-unavailable")
            }
          }
          const response = read?.response
          const retryDelay = RETRY_DELAYS_MS[attempt]
          if (response && response.status >= 300 && response.status < 400) {
            throw new GitHubError("the GitHub API returned a redirect, which API JSON requests never follow", "github-unavailable")
          }
          const rateLimited = response !== undefined && (response.status === 429 || (response.status === 403 && rateLimitEvidence(response)))
          if (response && (!rateLimited && !RETRIABLE_STATUSES.has(response.status) || retryDelay === undefined)) throw classifiedError(response)
          if (retryDelay === undefined) throw new GitHubError("GitHub transport failures exhausted the permitted read retries", "github-unavailable")
          const delay = Math.max(retryDelay, response ? retryAfterMs(response.headers) : 0)
          if (!input.budget.canStartRequest(input.stage, delay + 1)) {
            if (rateLimited && response) throw classifiedError(response)
            throw new GitHubError("the retry delay cannot fit in the remaining execution budget", deadlineCode)
          }
          await clock.sleep(delay, stageSignal)
        }
      })
    } catch (error) {
      if (error instanceof BudgetExhaustedError) throw new GitHubError(error.message, deadlineCode)
      throw error
    }
  }

  // The Git environment is fully explicit: no ambient values are inherited, so no ambient GIT_*
  // configuration or credential reaches a child, and the token appears in exactly one variable.
  function gitEnvironment(askPassPath: string): Record<string, string> {
    return {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      GIT_ASKPASS: askPassPath,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      [ASKPASS_TOKEN_VARIABLE]: token,
    }
  }

  function gitBytes(input: { args: string[]; env: Record<string, string>; budget: ExecutionBudget; stage: Stage; label: string; failureCode: Failure["code"] }): Uint8Array {
    const remaining = Math.floor(Math.min(input.budget.stageRemainingMs(input.stage), input.budget.remainingMs()))
    if (remaining <= 0) throw new GitHubError("the execution budget was exhausted before a Git command", "prepare-timeout")
    deps.observeGit?.({ args: input.args, env: input.env })
    const result = Bun.spawnSync(["git", "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", ...input.args], {
      stdout: "pipe",
      stderr: "pipe",
      env: input.env,
      timeout: Math.max(1, remaining),
      killSignal: "SIGKILL",
    })
    if (result.exitedDueToTimeout) throw new GitHubError(`a Git ${input.label} command exceeded the remaining execution budget`, "prepare-timeout")
    if (result.exitCode !== 0) {
      const message = lenientDecoder.decode(result.stderr).trim().slice(0, 500)
      throw new GitHubError(`git ${input.label} failed${message ? `: ${message}` : ""}`, input.failureCode)
    }
    return result.stdout
  }

  function gitText(input: { args: string[]; env: Record<string, string>; budget: ExecutionBudget; stage: Stage; label: string; failureCode: Failure["code"] }): string {
    return lenientDecoder.decode(gitBytes(input)).trim()
  }

  function writeAskPassHelper(parent: string): Promise<string> {
    const askPassPath = join(parent, "askpass.sh")
    return writeFile(askPassPath, ASKPASS_SCRIPT, { mode: 0o700 }).then(() => askPassPath)
  }

  async function fetchFixedObjects(input: { directory: string; env: Record<string, string>; budget: ExecutionBudget; stage: Stage; repository: string; objects: string[] }): Promise<void> {
    gitBytes({
      args: ["-C", input.directory, "fetch", "--no-tags", "--no-recurse-submodules", remoteUrl(input.repository), ...input.objects],
      env: input.env,
      budget: input.budget,
      stage: input.stage,
      label: "fetch of the captured object IDs",
      failureCode: "snapshot-fetch",
    })
    for (const object of input.objects) {
      gitBytes({
        args: ["-C", input.directory, "cat-file", "-e", `${object}^{commit}`],
        env: input.env,
        budget: input.budget,
        stage: input.stage,
        label: "cat-file verification",
        failureCode: "snapshot-fetch",
      })
      const resolved = gitText({
        args: ["-C", input.directory, "rev-parse", "--verify", `${object}^{commit}`],
        env: input.env,
        budget: input.budget,
        stage: input.stage,
        label: "rev-parse verification",
        failureCode: "snapshot-fetch",
      })
      if (resolved !== object) throw new GitHubError("a captured object ID did not resolve to itself as a commit", "snapshot-fetch")
    }
  }

  async function productDefaultConfig(): Promise<{ limits: ReviewLimits; source: FixedRepository["configSource"] }> {
    const bytes = new Uint8Array(await readFile(productReviewConfigPath))
    let limits: ReviewLimits
    try {
      limits = reviewLimitsSchema.parse(JSON.parse(strictDecoder.decode(bytes)))
    } catch {
      throw new GitHubError("the product default configuration is invalid", "config-invalid")
    }
    return { limits, source: { kind: "product-default", digest: sha256(bytes) } }
  }

  // The configuration is read from the fixed base tree, so a PR edit to the configuration cannot
  // change this run's rules. Only the documented default path permits a missing blob; an existing
  // malformed, non-regular, or oversized config always fails.
  async function readFrozenConfig(input: { directory: string; env: Record<string, string>; baseSha: GitSha; configPath: string; budget: ExecutionBudget; stage: Stage }): Promise<{ limits: ReviewLimits; source: FixedRepository["configSource"] }> {
    const requested = parseInput(relativePathSchema, input.configPath, "configuration path")
    const entry = literalTreeEntry({ directory: input.directory, env: input.env, budget: input.budget, stage: input.stage, sha: input.baseSha, path: requested, label: "configuration ls-tree", failureCode: "snapshot-fetch" })
    if (entry === null) {
      if (requested === DEFAULT_CONFIG_PATH) return productDefaultConfig()
      throw new GitHubError(`the configuration path ${requested} is absent from the fixed base`, "config-invalid")
    }
    if (entry.type !== "blob") {
      throw new GitHubError(`the configuration path ${requested} is not a regular file`, "config-invalid")
    }
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      throw new GitHubError(`the configuration blob at ${requested} is not a regular file`, "config-invalid")
    }
    const size = gitText({ args: ["-C", input.directory, "cat-file", "-s", entry.oid], env: input.env, budget: input.budget, stage: input.stage, label: "configuration size", failureCode: "snapshot-fetch" })
    if (!/^[0-9]+$/u.test(size) || Number(size) > FIXED_CONFIG_BYTE_LIMIT) {
      throw new GitHubError(`the configuration blob at ${requested} exceeds the ${FIXED_CONFIG_BYTE_LIMIT}-byte limit`, "config-invalid")
    }
    const bytes = gitBytes({ args: ["-C", input.directory, "cat-file", "blob", entry.oid], env: input.env, budget: input.budget, stage: input.stage, label: "configuration blob", failureCode: "snapshot-fetch" })
    let limits: ReviewLimits
    try {
      limits = reviewLimitsSchema.parse(JSON.parse(strictDecoder.decode(bytes)))
    } catch {
      throw new GitHubError(`the configuration blob at ${requested} is not valid limits JSON`, "config-invalid")
    }
    return { limits, source: { kind: "base-blob", path: requested, sha: input.baseSha, digest: sha256(bytes) } }
  }

  // Only the documented single-rel Link form is recognized. Any other pagination metadata fails
  // closed with comment-list-limit instead of silently stopping an incomplete scan. A continuation
  // must stay on the captured repository and PR: only the same comments endpoint with a positive
  // integer page parameter is followed, so a link cannot move the scan to another comment list.
  function sameOriginNextLink(headers: Headers, commentsPath: string): string | null {
    const link = headers.get("link")
    if (link === null) return null
    const parts = link.split(",").map((part) => part.trim()).filter((part) => part !== "")
    if (parts.length === 0) throw new GitHubError("the comment pagination Link header is not recognized", "comment-list-limit")
    let next: string | null = null
    for (const part of parts) {
      const match = /^<([^<>]+)>;\s*rel="(next|prev|first|last)"$/u.exec(part)
      if (match === null) throw new GitHubError("the comment pagination Link header is not recognized", "comment-list-limit")
      if (match[2] !== "next") continue
      if (next !== null) throw new GitHubError("the comment pagination Link header names two next pages", "comment-list-limit")
      let url: URL
      try {
        url = new URL(match[1]!)
      } catch {
        throw new GitHubError("the comment pagination next link is not a valid URL", "comment-list-limit")
      }
      if (url.origin !== API_ORIGIN) throw new GitHubError("the comment pagination link targets another origin", "comment-list-limit")
      if (url.pathname !== new URL(commentsPath).pathname) {
        throw new GitHubError("the comment pagination link targets another endpoint", "comment-list-limit")
      }
      const pageParameter = url.searchParams.get("page")
      if (pageParameter === null || !/^[1-9][0-9]*$/u.test(pageParameter)) {
        throw new GitHubError("the comment pagination link carries no page parameter", "comment-list-limit")
      }
      next = url.toString()
    }
    return next
  }

  // A literal pathspec cannot reinterpret the requested path, and the returned entry name is
  // compared against the request so a Git pathspec cannot select a different blob. All entry
  // types are parsed here so a directory or gitlink reaches its caller's own classification
  // instead of surfacing as an unreadable Git read.
  function literalTreeEntry(input: { directory: string; env: Record<string, string>; budget: ExecutionBudget; stage: Stage; sha: GitSha; path: string; label: string; failureCode: Failure["code"] }): { mode: string; type: "blob" | "tree" | "commit" | "tag"; oid: string } | null {
    const bytes = gitBytes({
      args: ["-C", input.directory, "ls-tree", "-z", input.sha, "--", `:(literal)${input.path}`],
      env: input.env,
      budget: input.budget,
      stage: input.stage,
      label: input.label,
      failureCode: input.failureCode,
    })
    const fields = lenientDecoder.decode(bytes).split("\0").filter((field) => field !== "")
    if (fields.length === 0) return null
    if (fields.length > 1) throw new GitHubError(`the fixed ${input.label} returned more than one entry for ${input.path}`, input.failureCode)
    const entry = fields[0]!
    const tab = entry.indexOf("\t")
    const match = /^(\d{6}) (blob|tree|commit|tag) ([0-9a-f]{40,64})$/u.exec(entry.slice(0, tab))
    if (tab < 0 || match === null) {
      throw new GitHubError(`the fixed ${input.label} returned an unreadable entry for ${input.path}`, input.failureCode)
    }
    if (entry.slice(tab + 1) !== input.path) {
      throw new GitHubError(`the fixed ${input.label} returned an entry whose name does not equal the requested path`, input.failureCode)
    }
    return { mode: match[1]!, type: match[2]! as "blob" | "tree" | "commit" | "tag", oid: match[3]! }
  }

  return {
    async capturePullRequest({ repository, pr, budget, stage = "prepare-init" }): Promise<PullRequestCapture> {
      const name = parseRepository(repository)
      const number = parseInput(prNumberSchema, pr, "pull request number")
      const base = apiRepositoryPath(name)
      const repositoryRecord = parseResponse(repositoryResponseSchema, (await apiJson({ url: base, budget, stage })).value, "repository")
      if (repositoryRecord.full_name !== repository) {
        throw new GitHubError("the repository response does not name the requested repository", "github-not-found")
      }
      const pull = parseResponse(pullResponseSchema, (await apiJson({ url: `${base}/pulls/${number}`, budget, stage })).value, "pull request")
      if (pull.number !== number) throw new GitHubError("the pull request response does not name the requested pull request", "github-not-found")
      if (pull.base.repo.id !== repositoryRecord.id) {
        throw new GitHubError("the pull request base repository does not match the requested repository", "github-not-found")
      }
      // Eligibility priority is closed, then fork, then draft. A head with a different repository
      // ID is a fork even when its full name looks similar, and a missing head repository on an
      // open PR is a fork, never a fetch.
      const headRepositoryId = pull.head.repo?.id ?? null
      const eligibility: PullRequestCapture["eligibility"] = pull.state === "closed" ? { kind: "skip", reason: "closed" }
        : headRepositoryId === null || headRepositoryId !== pull.base.repo.id ? { kind: "skip", reason: "fork" }
        : pull.draft ? { kind: "skip", reason: "draft" }
        : { kind: "review" }
      return {
        identity: { repositoryId: repositoryRecord.id, repository, pr: number },
        baseSha: pull.base.sha,
        headSha: pull.head.sha,
        observedAt: clock.wallTime(),
        eligibility,
      }
    },

    async readWorkflow({ repository, runId, budget, stage = "prepare-init" }): Promise<WorkflowObservation> {
      const id = parseInput(runIdSchema, runId, "workflow run ID")
      const run = parseResponse(workflowRunResponseSchema, (await apiJson({ url: `${apiRepositoryPath(repository)}/actions/runs/${id}`, budget, stage })).value, "workflow run")
      return {
        repositoryId: run.repository.id,
        runId: run.id,
        currentAttempt: run.run_attempt,
        createdAt: run.created_at,
        attemptStartedAt: run.run_started_at,
        status: run.status,
        event: run.event,
      }
    },

    async prepareFixedRepository({ captured, configPath, budget, stage = "prepare-init" }): Promise<FixedRepository> {
      budget.assertRemaining(stage)
      const parent = await mkdtemp(join(tmpdir(), "ai-code-review-fixed-"))
      let released = false
      const release = async (): Promise<void> => {
        if (released) return
        released = true
        await rm(parent, { recursive: true, force: true })
      }
      try {
        const directory = join(parent, "repo.git")
        const env = gitEnvironment(await writeAskPassHelper(parent))
        gitBytes({ args: ["init", "--bare", "--quiet", directory], env, budget, stage, label: "bare repository init", failureCode: "snapshot-fetch" })
        await fetchFixedObjects({ directory, env, budget, stage, repository: captured.identity.repository, objects: [captured.baseSha, captured.headSha] })
        const mergeBase = gitText({
          args: ["-C", directory, "merge-base", captured.baseSha, captured.headSha],
          env,
          budget,
          stage,
          label: "merge-base computation",
          failureCode: "snapshot-fetch",
        })
        if (mergeBase === "") throw new GitHubError("the captured base and head share no merge base", "snapshot-fetch")
        const config = await readFrozenConfig({ directory, env, baseSha: captured.baseSha, configPath, budget, stage })
        return { directory, config: config.limits, configSource: config.source, dispose: release }
      } catch (error) {
        await release().catch(() => undefined)
        throw error
      }
    },

    async readFixedSnapshot({ identity, baseSha, headSha, sources = [], budget, stage = "publish" }): Promise<FixedSnapshotEvidence> {
      const base = parseInput(gitShaSchema, baseSha, "fixed base commit")
      const head = parseInput(gitShaSchema, headSha, "fixed head commit")
      const parent = await mkdtemp(join(tmpdir(), "ai-code-review-snapshot-"))
      try {
        const directory = join(parent, "repo.git")
        const env = gitEnvironment(await writeAskPassHelper(parent))
        gitBytes({ args: ["init", "--bare", "--quiet", directory], env, budget, stage, label: "bare repository init", failureCode: "snapshot-fetch" })
        await fetchFixedObjects({ directory, env, budget, stage, repository: identity.repository, objects: [base, head] })
        const mergeBase = gitText({
          args: ["-C", directory, "merge-base", base, head], env, budget, stage,
          label: "fixed merge-base computation", failureCode: "snapshot-fetch",
        })
        if (mergeBase === "") throw new GitHubError("the fixed base and head share no merge base", "snapshot-fetch")
        const changed = gitBytes({
          args: ["-C", directory, "diff", "--name-only", "--diff-filter=ACMRT", "-z", mergeBase, head],
          env, budget, stage, label: "fixed changed-path listing", failureCode: "snapshot-fetch",
        })
        const paths = strictDecoder.decode(changed).split("\0").filter((path) => path !== "")
        const sourceFiles: FixedSource[] = []
        const sourceCache = new Map<string, string>()
        let totalBytes = 0
        for (const source of sources) {
          const path = parseInput(relativePathSchema, source.path, "citation source path")
          const sha = source.side === "head" ? head : parseInput(gitShaSchema, mergeBase, "computed merge base")
          const key = `${sha}\0${path}`
          const cached = sourceCache.get(key)
          if (cached !== undefined) {
            sourceFiles.push({ ...source, text: cached })
            continue
          }
          const entry = literalTreeEntry({ directory, env, budget, stage, sha, path, label: "citation source", failureCode: "snapshot-fetch" })
          if (entry === null || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
            throw new GitHubError(`${path} is not a regular fixed source file`, "citation-invalid")
          }
          const sizeText = gitText({ args: ["-C", directory, "cat-file", "-s", entry.oid], env, budget, stage, label: "citation size", failureCode: "snapshot-fetch" })
          const size = Number(sizeText)
          if (!/^[0-9]+$/u.test(sizeText) || size > FIXED_LINES_FILE_BYTE_LIMIT || totalBytes + size > 16 * 1024 * 1024) {
            throw new GitHubError("citation sources exceed the per-file or aggregate read cap", "citation-invalid")
          }
          totalBytes += size
          const blob = gitBytes({ args: ["-C", directory, "cat-file", "blob", entry.oid], env, budget, stage, label: "citation blob", failureCode: "snapshot-fetch" })
          if (blob.byteLength !== size) throw new GitHubError("the citation source size changed", "citation-invalid")
          let text: string
          try { text = strictDecoder.decode(blob) }
          catch { throw new GitHubError(`${path} is not valid UTF-8 text`, "citation-invalid") }
          sourceCache.set(key, text)
          sourceFiles.push({ ...source, path, text })
        }
        return {
          mergeBaseSha: parseInput(gitShaSchema, mergeBase, "computed merge base"),
          changedHeadPaths: paths.map((path) => parseInput(relativePathSchema, path, "changed head path")),
          sources: sourceFiles,
        }
      } finally {
        await rm(parent, { recursive: true, force: true })
      }
    },

    async readProductComment({ identity, budget, stage = "prepare-init" }): Promise<CommentObservation> {
      const commentsPath = `${apiRepositoryPath(identity.repository)}/issues/${identity.pr}/comments`
      let requests = 0
      let decodedBytes = 0
      let page = 1
      let url: string | null = `${commentsPath}?per_page=${COMMENT_PAGE_SIZE}&page=1`
      const seenPages = new Set<string>()
      const seenCommentIds = new Set<string>()
      const candidates: (ProductComment & { authorType: string })[] = []
      while (url !== null) {
        if (requests >= COMMENT_LIST_PAGE_LIMIT) throw new GitHubError("the comment listing exceeded the page limit", "comment-list-limit")
        requests += 1
        if (seenPages.has(url)) throw new GitHubError("GitHub repeated a comment page during pagination", "comment-list-limit")
        seenPages.add(url)
        const response = await apiJson({ url, budget, stage, byteCap: COMMENT_LIST_BYTE_CAP, oversizeCode: "comment-list-limit" })
        const comments = parseResponse(commentListSchema, response.value, "comment list")
        decodedBytes += response.bytes
        if (decodedBytes > COMMENT_LIST_BYTE_CAP) throw new GitHubError("the comment listing exceeded the decoded byte cap", "comment-list-limit")
        for (const comment of comments) {
          // Overlapping or repeated results across pages reject the whole scan, because a listing
          // that repeats itself cannot bound the comment set it claims to have shown.
          if (seenCommentIds.has(comment.id)) {
            throw new GitHubError("GitHub repeated a comment during pagination", "comment-list-limit")
          }
          seenCommentIds.add(comment.id)
          candidates.push({
            id: comment.id, authorId: comment.user.id, authorLogin: comment.user.login, authorType: comment.user.type,
            body: comment.body, createdAt: comment.created_at, updatedAt: comment.updated_at,
          })
        }
        const linked = sameOriginNextLink(response.headers, commentsPath)
        if (linked !== null) {
          page += 1
          url = linked
        } else if (comments.length === COMMENT_PAGE_SIZE) {
          page += 1
          url = `${commentsPath}?per_page=${COMMENT_PAGE_SIZE}&page=${page}`
        } else url = null
      }
      const scanned = scanProductComments(candidates, identity)
      if (scanned.canonical === null) return { kind: "absent", duplicateIds: [], humanMarkerIds: scanned.humanMarkerIds }
      const { authorType: _, ...canonical } = scanned.canonical
      const duplicateIds = scanned.duplicates.map(({ id }) => id)
      try {
        return { kind: "valid", canonical, state: parseStateBlock(canonical.body, identity), duplicateIds, humanMarkerIds: scanned.humanMarkerIds }
      } catch {
        return { kind: "invalid", canonical, reason: "the canonical bot comment has invalid state", duplicateIds, humanMarkerIds: scanned.humanMarkerIds }
      }
    },

    async readArtifactReceipt({ identity, execution, budget, stage = "publish" }): Promise<ArtifactReceipt | null> {
      const expectedName = `ai-code-review-handoff-${execution.workflowRunId}-${execution.attempt}`
      const endpoint = `${apiRepositoryPath(identity.repository)}/actions/runs/${execution.workflowRunId}/artifacts`
      const matches: z.output<typeof artifactResponseSchema>[] = []
      const seenIds = new Set<string>()
      let total = 0
      for (let page = 1; ; page++) {
        if (page > 200) throw new GitHubError("the artifact listing exceeded its page cap", "artifact-provenance")
        const url = `${endpoint}?per_page=100${page === 1 ? "" : `&page=${page}`}`
        const runJson = await apiJson({ url, budget, stage })
        const list = parseResponse(artifactListSchema, runJson.value, "artifact list")
        for (const artifact of list.artifacts) {
          if (seenIds.has(artifact.id)) throw new GitHubError("the artifact listing repeated an artifact", "artifact-provenance")
          seenIds.add(artifact.id)
          if (artifact.name === expectedName) matches.push(artifact)
        }
        total += list.artifacts.length
        if (total >= list.total_count) break
        if (list.artifacts.length === 0) throw new GitHubError("the artifact listing ended before its declared total", "artifact-provenance")
      }
      if (matches.length === 0) return null
      if (matches.length > 1) throw new GitHubError("multiple artifacts match the expected handoff name", "artifact-invalid")
      const artifact = matches[0]!
      if (artifact.workflow_run !== undefined && artifact.workflow_run !== null && artifact.workflow_run.id !== execution.workflowRunId) {
        throw new GitHubError("the artifact receipt names another workflow run", "artifact-invalid")
      }
      return { id: artifact.id, name: artifact.name, workflowRunId: execution.workflowRunId, bytes: artifact.size_in_bytes, expired: artifact.expired, digest: null }
    },

    async readFixedLines({ repository, sha, path, startLine, endLine, budget, stage = "publish" }): Promise<string> {
      const commit = parseInput(gitShaSchema, sha, "fixed commit")
      const relative = parseInput(relativePathSchema, path, "fixed path")
      const first = parseInput(z.int().positive(), startLine, "start line")
      const last = parseInput(z.int().positive(), endLine, "end line")
      if (last < first) throw new GitHubError("the requested line range is inverted", "citation-invalid")
      const parent = await mkdtemp(join(tmpdir(), "ai-code-review-lines-"))
      try {
        const directory = join(parent, "repo.git")
        const env = gitEnvironment(await writeAskPassHelper(parent))
        gitBytes({ args: ["init", "--bare", "--quiet", directory], env, budget, stage, label: "bare repository init", failureCode: "snapshot-fetch" })
        await fetchFixedObjects({ directory, env, budget, stage, repository, objects: [commit] })
        const entry = literalTreeEntry({ directory, env, budget, stage, sha: commit, path: relative, label: "source ls-tree", failureCode: "snapshot-fetch" })
        if (entry === null) throw new GitHubError(`${relative} is absent at the fixed commit`, "citation-invalid")
        if (entry.type !== "blob") throw new GitHubError(`${relative} is not a regular file at the fixed commit`, "citation-invalid")
        if (entry.mode !== "100644" && entry.mode !== "100755") {
          throw new GitHubError(`${relative} is not a regular file at the fixed commit`, "citation-invalid")
        }
        const size = gitText({ args: ["-C", directory, "cat-file", "-s", entry.oid], env, budget, stage, label: "source size", failureCode: "snapshot-fetch" })
        if (!/^[0-9]+$/u.test(size) || Number(size) > FIXED_LINES_FILE_BYTE_LIMIT) {
          throw new GitHubError(`${relative} exceeds the per-file read cap`, "citation-invalid")
        }
        const blob = gitBytes({ args: ["-C", directory, "cat-file", "blob", entry.oid], env, budget, stage, label: "source blob", failureCode: "snapshot-fetch" })
        let text: string
        try {
          text = strictDecoder.decode(blob)
        } catch {
          throw new GitHubError(`${relative} is not valid UTF-8 text`, "citation-invalid")
        }
        const lines = splitLines(text)
        if (last > lines.length) throw new GitHubError(`the citation line range is outside ${relative}`, "citation-invalid")
        return lines.slice(first - 1, last).join("\n")
      } finally {
        await rm(parent, { recursive: true, force: true })
      }
    },
  }
}

const ACTIONS_ENVIRONMENT_KEYS = [
  "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT",
  "GITHUB_EVENT_NAME", "GITHUB_EVENT_PATH", "GITHUB_SERVER_URL",
] as const

const decimalAttemptSchema = z.string().regex(/^[1-9][0-9]{0,5}$/).transform(Number).pipe(attemptSchema)
const actionsEnvSchema = z.strictObject({
  GITHUB_REPOSITORY: repositoryNameSchema,
  GITHUB_REPOSITORY_ID: repositoryIdSchema,
  GITHUB_RUN_ID: runIdSchema,
  GITHUB_RUN_ATTEMPT: decimalAttemptSchema,
  GITHUB_EVENT_NAME: z.enum(["pull_request", "workflow_dispatch"]),
  GITHUB_EVENT_PATH: z.string().min(1),
  GITHUB_SERVER_URL: z.literal("https://github.com"),
})
// A PR event contributes its action and requested PR number only. Stripping schemas discard
// every other event field, so no event commit SHA can survive parsing into the snapshot.
export const pullRequestEventSchema = z.object({
  action: z.enum(["opened", "synchronize", "reopened", "ready_for_review", "edited"]),
  pull_request: z.object({ number: prNumberSchema }),
})
export const dispatchEventSchema = z.object({ inputs: z.object({ pr: canonicalPrInputSchema }) })

// The environment is the only Actions identity source. A local invocation never constructs a
// GitHub adapter or requires a token; an Actions invocation constructs the reader internally and
// resolves its run timestamps and current attempt through the workflow run API. The run API's
// attempt-start time rides alongside the execution identity, separate from the command-entry
// time, so detailed timing can record both.
export type ResolvedExecutionContext = { execution: Execution; attemptStartedAt: string | null }

export async function readExecutionContext(
  env: NodeJS.ProcessEnv,
  budget: ExecutionBudget,
  deps: GitHubReaderDeps = {},
  expected?: { pr: number },
): Promise<ResolvedExecutionContext> {
  const present = ACTIONS_ENVIRONMENT_KEYS.filter((key) => {
    const value = env[key]
    return value !== undefined && value !== ""
  })
  if (present.length === 0) {
    return {
      execution: localExecutionSchema.parse({
        kind: "local",
        reviewRunId: randomUUID(),
        trigger: { kind: "local" },
        triggeredAt: budget.startedAt,
        startedAt: budget.startedAt,
      }),
      attemptStartedAt: null,
    }
  }
  if (present.length !== ACTIONS_ENVIRONMENT_KEYS.length) {
    throw new GitHubError("the Actions environment is incomplete for this release", "input-invalid")
  }
  // Only the listed environment variables enter the seed; the token and any other variable stay
  // out of the strict identity schema.
  const seed = parseInput(actionsEnvSchema, {
    GITHUB_REPOSITORY: env.GITHUB_REPOSITORY,
    GITHUB_REPOSITORY_ID: env.GITHUB_REPOSITORY_ID,
    GITHUB_RUN_ID: env.GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT: env.GITHUB_RUN_ATTEMPT,
    GITHUB_EVENT_NAME: env.GITHUB_EVENT_NAME,
    GITHUB_EVENT_PATH: env.GITHUB_EVENT_PATH,
    GITHUB_SERVER_URL: env.GITHUB_SERVER_URL,
  }, "Actions environment")
  let eventStat
  try {
    eventStat = await stat(seed.GITHUB_EVENT_PATH)
  } catch {
    throw new GitHubError("the Actions event payload is unreadable", "input-invalid")
  }
  if (eventStat.size > EVENT_JSON_BYTE_LIMIT) throw new GitHubError("the Actions event payload exceeds 1 MiB", "input-invalid")
  const eventBytes = new Uint8Array(await readFile(seed.GITHUB_EVENT_PATH))
  if (eventBytes.byteLength > EVENT_JSON_BYTE_LIMIT) throw new GitHubError("the Actions event payload exceeds 1 MiB", "input-invalid")
  let eventValue: unknown
  try {
    eventValue = JSON.parse(lenientDecoder.decode(eventBytes))
  } catch {
    throw new GitHubError("the Actions event payload is not valid JSON", "input-invalid")
  }
  let trigger: Trigger
  let eventPr: number
  if (seed.GITHUB_EVENT_NAME === "pull_request") {
    const event = parseInput(pullRequestEventSchema, eventValue, "pull_request event payload")
    trigger = { kind: "pull-request", action: event.action }
    eventPr = event.pull_request.number
  } else {
    const event = parseInput(dispatchEventSchema, eventValue, "workflow_dispatch event payload")
    trigger = { kind: "manual" }
    eventPr = event.inputs.pr
  }
  if (expected !== undefined && eventPr !== parseInput(prNumberSchema, expected.pr, "requested pull request number")) {
    throw new GitHubError("the event pull request does not equal the requested pull request", "input-invalid")
  }
  const reader = createGitHubReader(env, deps)
  const observation = await reader.readWorkflow({ repository: seed.GITHUB_REPOSITORY, runId: seed.GITHUB_RUN_ID, budget })
  // IDs from the environment are decimal text compared against the parsed API identity, so an
  // environment from another repository, run, or attempt cannot enter this execution.
  if (observation.repositoryId !== seed.GITHUB_REPOSITORY_ID) {
    throw new GitHubError("the workflow run belongs to another repository", "input-invalid")
  }
  if (observation.runId !== seed.GITHUB_RUN_ID) throw new GitHubError("the workflow run response names another run", "input-invalid")
  if (observation.event !== seed.GITHUB_EVENT_NAME) {
    throw new GitHubError("the workflow run event does not match the environment event name", "input-invalid")
  }
  if (observation.currentAttempt !== seed.GITHUB_RUN_ATTEMPT) {
    throw new GitHubError("the environment run attempt is not the workflow's current attempt", "input-invalid")
  }
  return {
    execution: parseInput(actionsExecutionSchema, {
      kind: "actions",
      reviewRunId: `gh-${seed.GITHUB_RUN_ID}-${seed.GITHUB_RUN_ATTEMPT}`,
      workflowRunId: seed.GITHUB_RUN_ID,
      attempt: seed.GITHUB_RUN_ATTEMPT,
      trigger,
      triggeredAt: observation.createdAt,
      startedAt: budget.startedAt,
      runUrl: `${WEB_ORIGIN}/${seed.GITHUB_REPOSITORY}/actions/runs/${seed.GITHUB_RUN_ID}`,
    }, "Actions execution identity"),
    attemptStartedAt: observation.attemptStartedAt,
  }
}

export function createGitHubPublisher(env: NodeJS.ProcessEnv, deps: GitHubReaderDeps = {}): GitHubPublisher {
  const reader = createGitHubReader(env, deps)
  const doFetch = deps.fetch ?? fetch
  const token = env.GITHUB_TOKEN!.trim()
  return {
    ...reader,
    async writeComment({ identity, existingId, body, budget }) {
      budget.assertRemaining("publish")
      if (Buffer.byteLength(body) > 60_000) throw new GitHubError("the intended comment exceeds its byte cap", "comment-write")
      if (existingId !== null) commentIdSchema.parse(existingId)
      const repositoryPath = apiRepositoryPath(identity.repository)
      const url = existingId === null ? `${repositoryPath}/issues/${identity.pr}/comments` : `${repositoryPath}/issues/comments/${existingId}`
      try {
        const result = await withinDeadline(async (signal) => {
          const response = await doFetch(url, {
            method: existingId === null ? "POST" : "PATCH", redirect: "manual", signal,
            headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": PRODUCT_USER_AGENT },
            body: JSON.stringify({ body }),
          })
          if (response.status !== 200 && response.status !== 201) {
            await response.body?.cancel().catch(() => undefined)
            if (response.status === 422) throw new GitHubError("GitHub rejected the comment validation", "comment-write", response.status)
            if ([401, 403, 404].includes(response.status) && !(response.status === 403 && rateLimitEvidence(response))) throw classifiedError(response)
            return null
          }
          const chunks: Uint8Array[] = []
          let size = 0
          const stream = response.body?.getReader()
          if (stream === undefined) return null
          const abort = () => { void stream.cancel().catch(() => undefined) }
          signal.addEventListener("abort", abort, { once: true })
          try {
            for (;;) {
              signal.throwIfAborted()
              const { done, value } = await stream.read()
              if (done) break
              size += value.byteLength
              if (size > REQUEST_BYTE_CAP) throw new Error("comment response exceeds its byte cap")
              chunks.push(value)
            }
          } finally { signal.removeEventListener("abort", abort); void stream.cancel().catch(() => undefined) }
          const bytes = Buffer.concat(chunks)
          let raw: unknown
          try { raw = JSON.parse(strictDecoder.decode(bytes)) } catch { return null }
          const parsed = commentResponseSchema.extend({ issue_url: z.url() }).safeParse(raw)
          if (!parsed.success) return null
          const comment = parsed.data
          if (comment.user.login !== BOT_LOGIN || comment.user.id !== BOT_USER_ID || comment.user.type !== BOT_TYPE ||
            comment.issue_url !== `${repositoryPath}/issues/${identity.pr}` || comment.body !== body || existingId !== null && comment.id !== existingId) {
            throw new GitHubError("the comment response identity or body differs from the intended write", "identity-mismatch")
          }
          return { id: comment.id, authorId: comment.user.id, authorLogin: comment.user.login, body: comment.body, createdAt: comment.created_at, updatedAt: comment.updated_at }
        }, Date.now() + Math.min(PER_REQUEST_TIMEOUT_MS, budget.stageRemainingMs("publish")))
        if (result.kind === "completed" && result.value !== null) return { kind: "confirmed", comment: result.value }
      } catch (error) {
        if (error instanceof GitHubError) throw error
      }
      return { kind: "unknown", failure: { code: "comment-write-unknown", stage: "publish", message: "the comment write could not be confirmed" } }
    },
  }
}
