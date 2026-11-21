import { describe, expect, test } from "bun:test"
import { applyReadBudget, clampReadLimit } from "./context-limits"
import { emptyReadBudget, defaultReadLimits, workerInputSchema } from "./contracts"
import { completedTurn, listMessages, readOnlyPermissions, recoverAcceptedPrompt, resolvePhasePrompt, runRuntime, submitPromptExactlyOnce, type RuntimeHost } from "./opencode-v227"
import { buildWorkerEnvironment, loadModelConfiguration, serializeWorkerInput, type WorkerOptions } from "./worker-process"
import { createBudget, systemClock, workerPhaseDeadlines } from "../budget"
import type { SessionMessageInfo } from "@opencode/client"
import type { Submission } from "./contracts"

const config: WorkerOptions = {
  model: { providerID: "local-model", baseURL: "http://127.0.0.1:8080/v1", modelID: "model-a" },
  apiKey: "secret-sentinel", runDirectory: "/tmp/review-runtime", materialDirectory: "/tmp/review-material", timeoutMs: 300_000,
  readLimits: defaultReadLimits, prompts: [{ name: "discover", text: "Review this snapshot" }, { name: "verify", text: "Check each candidate" }],
}
const user: SessionMessageInfo = { id: "input", type: "user", text: "prompt", time: { created: 1 } }
const idle: SessionMessageInfo = { id: "done", type: "idle", outcome: "succeeded", time: { created: 3 } }
const assistant: SessionMessageInfo = { id: "assistant", type: "assistant", model: { providerID: "local", id: "test" }, agent: "build", time: { created: 2 }, content: [{ type: "text", text: "OK" }] }

describe("controlled model runtime", () => {
  test("clamps tool limits and keeps zero and nonnumeric inputs bounded", () => {
    const cases: Array<[unknown, number]> = [[undefined, 100], [0, 1], [18.9, 18], [500, 100], [NaN, 100], [-5, 1]]
    for (const [input, expected] of cases) expect(clampReadLimit(input, 100)).toBe(expected)
  })
  test("limits UTF-8 output by whole lines and includes a truncation marker", () => {
    const budget = emptyReadBudget()
    const limits = { perToolBytes: 256, totalBytes: 512, maxLines: 100 }
    const output = applyReadBudget(`header\n${"界".repeat(100)}\nsecond line\n`, limits, budget)
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(256)
    expect(output).toContain("Review output truncated")
    expect(output).not.toContain("界")
    expect(budget.truncated).toBe(true)
    expect(budget.consumedBytes).toBe(Buffer.byteLength(output))
  })
  test("reserves the remaining aggregate budget for markers and never exceeds the cap", () => {
    const budget = emptyReadBudget()
    const limits = { perToolBytes: 256, totalBytes: 512, maxLines: 100 }
    const outputs = [applyReadBudget("a".repeat(240), limits, budget), applyReadBudget("b".repeat(240), limits, budget), applyReadBudget("界".repeat(100), limits, budget)]
    expect(outputs.reduce((total, text) => total + Buffer.byteLength(text), 0)).toBeLessThanOrEqual(512)
    expect(budget.exhausted).toBe(true)
    expect(applyReadBudget("more", limits, budget)).toBe("")
  })
  test("a normal read does not imply missing coverage", () => {
    const budget = emptyReadBudget()
    expect(applyReadBudget("all code\n", defaultReadLimits, budget)).toBe("all code\n")
    expect(budget.truncated).toBe(false)
  })
  test("keeps credentials and unrelated environment outside the worker input", () => {
    const deadlines = workerPhaseDeadlines(createBudget(systemClock, 300_000))
    const input = serializeWorkerInput(config, deadlines)
    expect(input).not.toContain(config.apiKey)
    const parsed = workerInputSchema.parse(JSON.parse(input))
    expect(parsed.prompts).toHaveLength(2)
    expect(parsed.phaseDeadlines.discoveryEpochMs).toBeNull()
    expect(parsed.phaseDeadlines.analysisStopEpochMs).toBeGreaterThan(Date.now() + 280_000)
    const env = buildWorkerEnvironment(config)
    expect(env.OPENAI_API_KEY).toBe(config.apiKey)
    expect(Object.keys(env).sort()).toEqual(["HOME", "OPENAI_API_KEY", "PATH", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"])
  })
  test("accepts the existing four-field provider configuration and rejects credentials in endpoint URLs", () => {
    expect(loadModelConfiguration({ REVIEW_MODEL_PROVIDER_ID: "axonhub", REVIEW_MODEL_BASE_URL: "https://example.com/v1", REVIEW_MODEL_ID: "vendor/model", REVIEW_MODEL_API_KEY: "key" }).model.providerID).toBe("axonhub")
    expect(() => loadModelConfiguration({})).toThrow()
    expect(() => loadModelConfiguration({ REVIEW_MODEL_PROVIDER_ID: "local", REVIEW_MODEL_BASE_URL: "https://user:password@example.com", REVIEW_MODEL_ID: "model", REVIEW_MODEL_API_KEY: "key" })).toThrow()
  })
  test("explicitly denies external-directory access and all tools except read, grep, and glob", () => {
    const permissions = readOnlyPermissions()
    expect(permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
    expect(permissions.filter((rule) => rule.effect === "allow").map((rule) => rule.action)).toEqual(["read", "grep", "glob"])
    expect(permissions.at(-1)).toEqual({ action: "external_directory", resource: "*", effect: "deny" })
  })
  test("ignores idle before this prompt and requires a terminal message after its exact ID", () => {
    expect(completedTurn([idle, user, assistant], "input")).toBeUndefined()
    expect(completedTurn([user, assistant, idle], "other-input")).toBeUndefined()
    expect(completedTurn([idle, user, assistant, idle], "input")?.last).toEqual(assistant)
  })
  test("pages all messages and does not combine cursor with order", async () => {
    const calls: unknown[] = []
    const host: Pick<RuntimeHost, "message"> = { message: { list: async (input) => {
      calls.push(input)
      return input.cursor ? { data: [assistant, idle], cursor: {} } : { data: [user], cursor: { next: "page-2" } }
    } } }
    const messages = await listMessages(host, "session")
    expect(messages).toEqual([user, assistant, idle])
    expect(calls).toEqual([{ sessionID: "session", order: "asc" }, { sessionID: "session", cursor: "page-2" }])
    expect(completedTurn(messages, "input")?.idle.outcome).toBe("succeeded")
  })

  test("injects only the preceding phase output into a dependent prompt", () => {
    const prompt = "Verify this result: {{PREVIOUS_PHASE_OUTPUT}}"
    expect(resolvePhasePrompt(prompt, '{"candidates":[]}')).toBe('Verify this result: {"candidates":[]}')
    const literal = '{"rootCause":"$& $` $\u0027 {{PREVIOUS_PHASE_OUTPUT}}"}'
    expect(resolvePhasePrompt(`${prompt}\nPath: {{PREVIOUS_PHASE_OUTPUT}}`, literal)).toBe(`Verify this result: ${literal}\nPath: {{PREVIOUS_PHASE_OUTPUT}}`)
    expect(() => resolvePhasePrompt(prompt)).toThrow("preceding phase")
    expect(resolvePhasePrompt("Independent prompt")).toBe("Independent prompt")
  })

  const userMessage = (id: string, text: string): SessionMessageInfo => ({ id, type: "user", text, time: { created: 1 } })
  const messageHost = (reads: SessionMessageInfo[][]): Pick<RuntimeHost, "message"> => {
    let index = 0
    return { message: { list: async () => ({ data: reads[Math.min(index++, reads.length - 1)]!, cursor: {} }) } }
  }
  const promptHost = (prompt: (input: { sessionID: string; text: string }) => Promise<{ id: string }>, message: Pick<RuntimeHost, "message">): Pick<RuntimeHost, "sessions" | "message"> => {
    return { message: message.message, sessions: { prompt } as never }
  }

  test("recovery proves acceptance from a unique new user message and ignores the baseline", async () => {
    const host = messageHost([
      [userMessage("old-user", "Reply OK.")],
      [userMessage("old-user", "Reply OK."), userMessage("new-user", "Reply OK.")],
    ])
    const accepted = await recoverAcceptedPrompt({ host, sessionID: "session", promptText: "Reply OK.", baselineUserIds: ["old-user"], deadlineEpochMs: Date.now() + 10_000, sleep: async () => {} })
    expect(accepted).toEqual({ kind: "accepted", userMessageId: "new-user" })
  })

  test("recovery fails on multiple matching new user messages and never concludes from one empty read", async () => {
    const ambiguous = await recoverAcceptedPrompt({
      host: messageHost([[userMessage("a", "Reply OK."), userMessage("b", "Reply OK.")]]),
      sessionID: "session", promptText: "Reply OK.", baselineUserIds: [], deadlineEpochMs: Date.now() + 10_000, sleep: async () => {},
    })
    expect(ambiguous).toEqual({ kind: "ambiguous", ids: ["a", "b"] })
    let reads = 0
    const emptyHost: Pick<RuntimeHost, "message"> = { message: { list: async () => { reads++; return { data: [], cursor: {} } } } }
    const missing = await recoverAcceptedPrompt({ host: emptyHost, sessionID: "session", promptText: "Reply OK.", baselineUserIds: [], deadlineEpochMs: Date.now() + 10_000, maxReads: 3, sleep: async () => {} })
    expect(missing).toEqual({ kind: "missing" })
    expect(reads).toBe(3)
  })

  test("a lost prompt response resolves through the same session with exactly one submission", async () => {
    const submissions: Submission[] = []
    let promptCalls = 0
    const host = promptHost(
      async () => { promptCalls++; throw new Error("the response was lost after delivery") },
      messageHost([[userMessage("delivered", "Reply OK.")]]),
    )
    const outcome = await submitPromptExactlyOnce({
      host, sessionID: "session", promptText: "Reply OK.", baselineUserIds: [],
      deadlineEpochMs: Date.now() + 10_000, timeoutCode: "discovery-timeout",
      interrupted: new Promise(() => {}), isStopped: () => false,
      report: (submission) => submissions.push(submission), sleep: async () => {},
    })
    expect(outcome).toEqual({ kind: "accepted", userMessageId: "delivered" })
    expect(promptCalls).toBe(1)
    expect(submissions.map(({ kind }) => kind)).toEqual(["submitting", "accepted"])
    expect(submissions[1]).toMatchObject({ userMessageId: "delivered", promptDigest: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })

  test("an interrupted submission without a durable message stays acceptance-unknown and never resends", async () => {
    const submissions: Submission[] = []
    let promptCalls = 0
    let stopped = false
    const host = promptHost(
      async () => { promptCalls++; stopped = true; return new Promise(() => {}) },
      messageHost([[]]),
    )
    const outcome = await submitPromptExactlyOnce({
      host, sessionID: "session", promptText: "Reply OK.", baselineUserIds: [],
      deadlineEpochMs: Date.now() + 30, timeoutCode: "discovery-timeout",
      interrupted: Promise.resolve(), isStopped: () => stopped,
      report: (submission) => submissions.push(submission), sleep: async () => {},
    })
    expect(outcome).toMatchObject({ kind: "failed", code: "acceptance-unknown" })
    expect(promptCalls).toBe(1)
    expect(submissions.at(-1)).toMatchObject({ kind: "acceptance-unknown" })
  })

  test("a nested 408 after enqueue and four empty reads never resubmits", async () => {
    const submissions: Submission[] = []
    let promptCalls = 0
    const host = promptHost(
      async () => {
        promptCalls++
        if (promptCalls === 1) {
          throw new Error("response lost after enqueue", { cause: { status: 408 } })
        }
        return { id: "second-delivery" }
      },
      messageHost([[], [], [], [], [userMessage("first-delivery", "Reply OK.")]]),
    )
    const outcome = await submitPromptExactlyOnce({
      host, sessionID: "session", promptText: "Reply OK.", baselineUserIds: [],
      deadlineEpochMs: Date.now() + 10_000, timeoutCode: "discovery-timeout",
      interrupted: new Promise(() => {}), isStopped: () => false,
      report: (submission) => submissions.push(submission), sleep: async () => {},
    })
    expect(outcome).toEqual({ kind: "accepted", userMessageId: "first-delivery" })
    expect(promptCalls).toBe(1)
    expect(submissions.map(({ kind }) => kind)).toEqual(["submitting", "accepted"])
  })

  test("an answered rejection without a visible message ends at the deadline", async () => {
    const submissions: Submission[] = []
    let promptCalls = 0
    const host = promptHost(
      async () => {
        promptCalls++
        const rejection = new Error("the server rejected the enqueue")
        ;(rejection as { status?: number }).status = 422
        throw rejection
      },
      messageHost([[]]),
    )
    const outcome = await submitPromptExactlyOnce({
      host, sessionID: "session", promptText: "Reply OK.", baselineUserIds: [],
      deadlineEpochMs: Date.now() + 30, timeoutCode: "discovery-timeout",
      interrupted: new Promise(() => {}), isStopped: () => false,
      report: (submission) => submissions.push(submission), sleep: async () => {},
    })
    expect(promptCalls).toBe(1)
    expect(outcome).toMatchObject({ kind: "failed", code: "acceptance-unknown" })
    expect(submissions.at(-1)).toMatchObject({ kind: "acceptance-unknown" })
  })

  test("a post-enqueue 5xx rejection with empty reads never resubmits", async () => {
    const submissions: Submission[] = []
    let promptCalls = 0
    const host = promptHost(
      async () => {
        promptCalls++
        const rejection = new Error("the server failed after an unknown point in enqueue")
        ;(rejection as { status?: number }).status = 500
        throw rejection
      },
      messageHost([[]]),
    )
    const outcome = await submitPromptExactlyOnce({
      host, sessionID: "session", promptText: "Reply OK.", baselineUserIds: [],
      deadlineEpochMs: Date.now() + 200, timeoutCode: "discovery-timeout",
      interrupted: new Promise(() => {}), isStopped: () => false,
      report: (submission) => submissions.push(submission), sleep: async () => {},
    })
    expect(promptCalls).toBe(1)
    expect(outcome).toMatchObject({ kind: "failed", code: "acceptance-unknown" })
    expect(submissions.at(-1)).toMatchObject({ kind: "acceptance-unknown" })
  })

  test("a read failure inside an answered-rejection sweep keeps delivery unknown and never resubmits", async () => {
    const submissions: Submission[] = []
    let promptCalls = 0
    const failingReads: Pick<RuntimeHost, "message"> = { message: { list: async () => { throw new Error("the read failed transiently") } } }
    const host = promptHost(
      async () => {
        promptCalls++
        const rejection = new Error("the server rejected the enqueue")
        ;(rejection as { status?: number }).status = 422
        throw rejection
      },
      failingReads,
    )
    const outcome = await submitPromptExactlyOnce({
      host, sessionID: "session", promptText: "Reply OK.", baselineUserIds: [],
      deadlineEpochMs: Date.now() + 30, timeoutCode: "discovery-timeout",
      interrupted: new Promise(() => {}), isStopped: () => false,
      report: (submission) => submissions.push(submission), sleep: async () => {},
    })
    expect(promptCalls).toBe(1)
    expect(outcome).toMatchObject({ kind: "failed", code: "acceptance-unknown" })
    expect(submissions.at(-1)).toMatchObject({ kind: "acceptance-unknown" })
  })

  test("a transient read failure stays inside recovery and accepts once the message appears", async () => {
    const submissions: Submission[] = []
    let reads = 0
    const flaky: Pick<RuntimeHost, "message"> = { message: { list: async () => {
      if (reads++ === 0) throw new Error("the read failed transiently")
      return { data: [userMessage("delivered", "Reply OK.")], cursor: {} }
    } } }
    const host = promptHost(
      async () => { throw new Error("the response was lost after delivery") },
      flaky,
    )
    const outcome = await submitPromptExactlyOnce({
      host, sessionID: "session", promptText: "Reply OK.", baselineUserIds: [],
      deadlineEpochMs: Date.now() + 10_000, timeoutCode: "discovery-timeout",
      interrupted: new Promise(() => {}), isStopped: () => false,
      report: (submission) => submissions.push(submission), sleep: async () => {},
    })
    expect(outcome).toEqual({ kind: "accepted", userMessageId: "delivered" })
    expect(submissions.map(({ kind }) => kind)).toEqual(["submitting", "accepted"])
  })
})

test("an initialization that reaches the preparation deadline is cut off with runtime-init", async () => {
  // A real in-process SDK boot raced against an already-passed preparation cap: the timer wins
  // before the host can finish starting, and the abandoned host closes when it settles later.
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const root = await mkdtemp(join(tmpdir(), "review-init-deadline-"))
  const configDirectory = join(root, "config")
  const materialDirectory = join(root, "material")
  await mkdir(configDirectory, { recursive: true })
  await mkdir(materialDirectory, { recursive: true })
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = "init-deadline-key"
  try {
    const input = workerInputSchema.parse({
      model: { providerID: "scripted", baseURL: "http://127.0.0.1:9/v1", modelID: "scripted-model" },
      materialDirectory,
      configDirectory,
      phaseDeadlines: {
        prepareInitEpochMs: Date.now() - 1,
        discoveryEpochMs: null,
        analysisStopEpochMs: Date.now() + 10_000,
        workerKillEpochMs: Date.now() + 12_000,
        finalEpochMs: Date.now() + 15_000,
      },
      readLimits: defaultReadLimits,
      prompts: [{ name: "discover", text: "Reply with OK." }],
    })
    const result = await runRuntime(input, new AbortController().signal, () => {})
    expect(result.status).toBe("failed")
    if (result.status === "complete") throw new Error("invalid result")
    expect(result.code).toBe("runtime-init")
    expect(result.cleanup.hostClosed).toBe(false)
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
