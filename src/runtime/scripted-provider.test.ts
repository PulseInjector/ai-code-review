import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildWorkerEnvironment, runIsolatedWorker } from "./worker-process"
import type { RequestLedger, Submission } from "./contracts"

type Scenario =
  | "kinds"
  | "retry-recovered"
  | "retry-exhausted"
  | "ambiguous"
  | "quota-conflict"
  | "title-failure"
  | "generate-blocked"
  | "compaction-retry-cap"
  | "compaction-terminal"
  | "stream-retry"

type DriverObservation = {
  scenario: Scenario
  sessionID: string
  requests: RequestLedger
  submissions: Submission[]
  turn?: { outcome: string; errorType: string | null }
  outcome?: { kind: string; userMessageId?: string; code?: string; message?: string }
  matchingUserMessages?: number
  userTextSamples?: string[]
  generatedText?: string
  policyStop?: string | null
  primaryAttempts?: number[]
  elapsedMs?: number
  attemptsByKind?: Record<string, number[]>
}

// A scripted OpenAI-compatible endpoint. It classifies each request from its body: the SDK's
// title generation always carries its fixed title instruction, a manual compaction carries the
// summary instruction, a generate call carries its one-off prompt, and everything else is the
// primary model request whose scripted responses the scenario controls.
type RequestKind = "primary" | "compaction" | "title" | "generate"
type ScriptServer = {
  port: number
  counts(): Record<RequestKind, number>
  times: Record<RequestKind, number[]>
  paths: string[]
  stop(): Promise<void>
}

function sseChunk(content: string, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-scripted", object: "chat.completion.chunk", created: 0, model: "scripted-model",
    choices: [{ index: 0, delta: finishReason === null ? { content } : {}, finish_reason: finishReason }],
  })}\n\n`
}

const streamResponse = (text: string): Response => new Response(
  new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      controller.enqueue(encoder.encode(sseChunk(text, null)))
      controller.enqueue(encoder.encode(sseChunk("", "stop")))
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  }),
  { status: 200, headers: { "content-type": "text/event-stream" } },
)

const errorResponse = (status: number, body: Record<string, unknown>, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

// OpenAI's account-cap phrasing on HTTP 429: the status alone looks like a throttle, but the
// insufficient_quota code makes the SDK classify the failure as provider.quota.
const insufficientQuotaResponse = (): Response =>
  errorResponse(429, { error: { message: "You exceeded your current quota limits, please check your plan and billing details.", code: "insufficient_quota" } }, { "x-should-retry": "true" })

function classifyKind(body: string): RequestKind {
  if (body.includes("Reply with only the title.")) return "title"
  if (body.includes("You MUST summarize the conversation")) return "compaction"
  if (body.includes("Say done.")) return "generate"
  return "primary"
}

async function startScriptServer(script: (kind: RequestKind, kindIndex: number) => Response): Promise<ScriptServer> {
  const counts: Record<RequestKind, number> = { primary: 0, compaction: 0, title: 0, generate: 0 }
  const times: ScriptServer["times"] = { primary: [], compaction: [], title: [], generate: [] }
  const paths: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      paths.push(new URL(request.url).pathname)
      const body = JSON.stringify(JSON.parse(await request.text()))
      const kind = classifyKind(body)
      counts[kind] += 1
      times[kind].push(performance.now())
      return script(kind, counts[kind])
    },
  })
  const port = server.port
  if (port === undefined) throw new Error("the scripted server did not bind a port")
  return { port, counts: () => ({ ...counts }), times, paths, stop: () => server.stop(true) }
}

async function driveScenario(scenario: Scenario, script: (kind: RequestKind, kindIndex: number) => Response, timeoutMs = 90_000): Promise<DriverObservation & { serverCounts: Record<RequestKind, number>; times: ScriptServer["times"]; paths: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "scripted-provider-"))
  const server = await startScriptServer(script)
  try {
    const home = join(root, "home")
    for (const name of ["config", "cache", "data", "state", "tmp"]) await mkdir(join(home, name), { recursive: true, mode: 0o700 })
    const material = join(root, "material")
    await mkdir(material)
    const configPath = join(root, "driver-config.json")
    const outputPath = join(root, "driver-output.json")
    await writeFile(configPath, JSON.stringify({
      scenario,
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      configDirectory: join(home, "config"),
      materialDirectory: material,
    }), { mode: 0o600 })
    const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "scripted-provider-driver.ts"), configPath, outputPath], {
      cwd: material,
      env: buildWorkerEnvironment({ runDirectory: home, apiKey: "scripted-provider-key" }),
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    })
    const exited = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the scripted driver exceeded the gate timeout")), timeoutMs)),
    ])
    const stderr = await new Response(child.stderr).text()
    let observation: DriverObservation | undefined
    try {
      observation = JSON.parse(await readFile(outputPath, "utf8")) as DriverObservation
    } catch {
      observation = undefined
    }
    if (exited !== 0) {
      const detail = observation?.outcome?.message ?? stderr.trim() ?? ""
      const samples = observation?.userTextSamples !== undefined ? `; user texts: ${JSON.stringify(observation.userTextSamples)}` : ""
      throw new Error(`scripted driver failed: ${detail || "no diagnostic output"}${samples}`)
    }
    if (observation === undefined) throw new Error("scripted driver wrote no observation")
    return { ...observation, serverCounts: server.counts(), times: server.times, paths: server.paths }
  } finally {
    await server.stop()
    await rm(root, { recursive: true, force: true })
  }
}

// Blocking checkpoint gate: the real SDK must account for each supported request kind, enforce
// retry decisions on the wire, and reject the standalone generate path before transmission.
test("primary, foreground compaction, and optional title each succeed with one recorded POST", async () => {
  const observation = await driveScenario("kinds", (kind) => streamResponse(kind === "compaction" ? "## Objective\n- Review the change." : "OK"))
  const kinds = observation.requests.records.map((record) => record.kind)
  expect(kinds).toContain("primary")
  expect(kinds).toContain("title")
  expect(kinds).toContain("compaction")
  expect(observation.requests.records.every((record) => record.sessionId === observation.sessionID)).toBe(true)
  expect(observation.requests.records.filter((record) => record.outcome === "response")).toHaveLength(observation.requests.records.length)
  expect(observation.requests.capped).toBe(false)
  expect(observation.turn?.outcome).toBe("succeeded")
  expect(observation.serverCounts).toEqual({ primary: 1, compaction: 1, title: 1, generate: 0 })
  expect(observation.attemptsByKind).toEqual({ primary: [1], compaction: [1], title: [1] })
}, 120_000)

test("primary retries observe Retry-After and the third attempt succeeds", async () => {
  const observation = await driveScenario("retry-recovered", (kind, index) => {
    if (kind === "primary" && index === 1) return errorResponse(429, { error: "rate limit" }, { "retry-after": "2" })
    if (kind === "primary" && index === 2) return errorResponse(500, { error: "server unavailable" })
    return streamResponse("OK")
  })
  const attempts = observation.requests.records.filter((record) => record.kind === "primary").map((record) => record.attempt)
  expect(attempts).toEqual([1, 2, 3])
  expect(observation.requests.records.at(-1)?.status).toBe(200)
  expect(observation.turn?.outcome).toBe("succeeded")
  expect(observation.serverCounts.title).toBe(0)
  expect(observation.serverCounts.primary).toBe(3)
  const [first, second, third] = observation.times.primary
  expect(second! - first!).toBeGreaterThanOrEqual(2_000)
  expect(third! - second!).toBeGreaterThanOrEqual(2_000)
}, 120_000)

test("a Retry-After longer than the phase budget does not schedule another POST", async () => {
  const observation = await driveScenario("retry-exhausted", () => errorResponse(429, { error: "rate limit" }, { "retry-after": "180" }))
  expect(observation.serverCounts.primary).toBe(1)
  expect(observation.attemptsByKind?.primary).toEqual([1])
  expect(observation.turn).toEqual({ outcome: "failed", errorType: "provider.rate-limit" })
  expect(observation.policyStop).toBe("discovery-timeout")
}, 120_000)

test("a primary stream transport error keeps its retry record after HTTP 200", async () => {
  const observation = await driveScenario("stream-retry", (kind, index) => {
    if (kind !== "primary" || index !== 1) return streamResponse("OK")
    return new Response(new ReadableStream({ start(controller) {
      setTimeout(() => controller.error(new Error("scripted stream disconnect")), 10)
    } }), { status: 200, headers: { "content-type": "text/event-stream" } })
  })
  expect(observation.attemptsByKind?.primary).toEqual([1, 2])
  expect(observation.requests.records.filter(({ kind }) => kind === "primary").map(({ outcome }) => outcome)).toEqual(["transport-error", "response"])
  expect(observation.serverCounts.primary).toBe(2)
  expect(observation.serverCounts.title).toBe(0)
}, 120_000)

test("a third retry never reaches the provider and the session fails with the transport error", async () => {
  const observation = await driveScenario("retry-exhausted", (kind) => kind === "primary" ? errorResponse(500, { error: "server unavailable" }) : streamResponse("OK"))
  const primary = observation.requests.records.filter((record) => record.kind === "primary")
  expect(primary).toHaveLength(3)
  expect(primary.map((record) => record.attempt)).toEqual([1, 2, 3])
  // The provider itself never saw a fourth request.
  expect(observation.serverCounts.primary).toBe(3)
  expect(observation.turn?.outcome).toBe("failed")
  expect(observation.turn?.errorType).toBe("provider.internal")
}, 120_000)

test("an ambiguous prompt response recovers through the same session and uses only one user message", async () => {
  const observation = await driveScenario("ambiguous", () => streamResponse("OK"))
  expect(observation.outcome).toMatchObject({ kind: "accepted" })
  expect(observation.matchingUserMessages).toBe(1)
  expect(observation.submissions.map(({ kind }) => kind)).toEqual(["submitting", "accepted"])
  expect(observation.requests.records.filter((record) => record.kind === "primary")).toHaveLength(1)
  expect(observation.turn?.outcome).toBe("succeeded")
}, 120_000)

const authWithRetryHint = () => errorResponse(401, { error: { message: "invalid key" } }, { "x-should-retry": "true" })

test("standalone SDK generate is rejected before it can retry a credential error", async () => {
  const observation = await driveScenario("generate-blocked", authWithRetryHint)
  expect(observation.serverCounts.generate).toBe(0)
  expect(observation.paths).toEqual([])
  expect(observation.attemptsByKind?.generate).toBeUndefined()
  expect(observation.outcome?.kind).toBe("generate-failed")
  expect(observation.policyStop).toBe("model-config")
  expect(observation.generatedText).toBeUndefined()
}, 120_000)

const redirectScenarios: Array<[RequestKind, Scenario]> = [
  ["primary", "retry-exhausted"], ["compaction", "compaction-terminal"], ["title", "title-failure"],
]
for (const [target, scenario] of redirectScenarios) {
  test(`the embedded transport never follows a ${target} POST redirect`, async () => {
    const observation = await driveScenario(scenario, (kind, index) => kind === target && index <= 5
      ? new Response(null, { status: 307, headers: { location: `/redirect/${index}` } })
      : streamResponse("OK"))
    expect(observation.paths.every((path) => !path.startsWith("/redirect/"))).toBe(true)
    expect(observation.serverCounts[target]).toBe(1)
    expect(observation.attemptsByKind?.[target]).toEqual([1])
    expect(observation.requests.records.find(({ kind }) => kind === target)?.status).toBe(307)
  }, 120_000)
}

test("compaction requests retry through the hook and stop at three wire attempts", async () => {
  const observation = await driveScenario("compaction-retry-cap", (kind) => kind === "compaction" ? errorResponse(500, { error: "server unavailable" }) : streamResponse("OK"))
  expect(observation.attemptsByKind?.compaction).toEqual([1, 2, 3])
  expect(observation.serverCounts.compaction).toBe(3)
  // The deterministic delays are 1,000 and 2,000 ms, so the exhausted compaction cannot be faster.
  expect(observation.elapsedMs ?? 0).toBeGreaterThanOrEqual(3_000)
}, 120_000)

for (const [failure, response] of [
  ["payload rejection", () => errorResponse(413, { error: "payload too large" })],
  ["invalid summary", () => streamResponse("No template headings")],
] as const) {
  test(`a compaction ${failure} cannot trigger an unapproved resend`, async () => {
    const observation = await driveScenario("compaction-terminal", (kind) => kind === "compaction" ? response() : streamResponse("OK"))
    expect(observation.serverCounts.compaction).toBe(1)
    expect(observation.attemptsByKind?.compaction).toEqual([1])
    expect(observation.policyStop).toBe("model-format")
  }, 120_000)
}

test("a failed title request is recorded once and the SDK never retries it", async () => {
  const observation = await driveScenario("title-failure", (kind) => kind === "title" ? errorResponse(500, { error: "server unavailable" }, { "x-should-retry": "true" }) : streamResponse("OK"))
  expect(observation.attemptsByKind?.title).toEqual([1])
  expect(observation.serverCounts.title).toBe(1)
  expect(observation.requests.records.find((record) => record.kind === "title")?.status).toBe(500)
  expect(observation.turn?.outcome).toBe("succeeded")
}, 120_000)

test("a 429 insufficient_quota is classified provider.quota and never retries despite the status", async () => {
  const observation = await driveScenario("quota-conflict", (kind) => kind === "primary" ? insufficientQuotaResponse() : streamResponse("OK"))
  expect(observation.attemptsByKind?.primary).toEqual([1])
  expect(observation.serverCounts.primary).toBe(1)
  expect(observation.requests.records.find((record) => record.kind === "primary")?.status).toBe(429)
  expect(observation.turn?.outcome).toBe("failed")
  expect(observation.turn?.errorType).toBe("provider.quota")
}, 120_000)

test("primary ignores a provider retry hint on HTTP 401", async () => {
  const observation = await driveScenario("retry-exhausted", authWithRetryHint)
  expect(observation.serverCounts.primary).toBe(1)
  expect(observation.attemptsByKind?.primary).toEqual([1])
  expect(observation.turn).toEqual({ outcome: "failed", errorType: "provider.auth" })
}, 120_000)

test("a discovery signal delivered during verification does not interrupt it", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-stale-discovery-"))
  const material = join(root, "material")
  await mkdir(material)
  const verificationStarted = Promise.withResolvers<void>()
  const verificationResponse = Promise.withResolvers<Response>()
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.text()
    if (body.includes("Verification phase")) {
      verificationStarted.resolve()
      return verificationResponse.promise
    }
    return streamResponse('{"candidates":[]}')
  } })
  const pending = runIsolatedWorker({
    runDirectory: root, materialDirectory: material,
    model: { providerID: "scripted", baseURL: `http://127.0.0.1:${server.port}/v1`, modelID: "scripted-model" },
    apiKey: "scripted-provider-key", timeoutMs: 12_000, cleanupGraceMs: 1_000,
    prompts: [{ name: "discover", text: "Discovery phase" }, { name: "verify", text: "Verification phase" }],
  })
  try {
    const active = await Promise.race([verificationStarted.promise.then(() => true), pending.then(() => false)])
    expect(active).toBe(true)
    const { pid } = JSON.parse(await readFile(join(root, "runtime/process.json"), "utf8"))
    process.kill(pid, "SIGUSR2")
    await Bun.sleep(50)
    verificationResponse.resolve(streamResponse('{"verifications":[]}'))
    const result = await pending
    expect(result.status).toBe("complete")
    expect(result.sessions.map(({ name, status }) => [name, status])).toEqual([["discover", "complete"], ["verify", "complete"]])
  } finally {
    verificationResponse.resolve(streamResponse('{"verifications":[]}'))
    await server.stop(true)
    await pending.catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
