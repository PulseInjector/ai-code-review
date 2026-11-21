import { describe, expect, test } from "bun:test"
import { createRequestPolicyPlugin, isRetriableRequestError, MODEL_ADMISSION_MS, type PhaseState } from "./request-policy"
import { emptyRequestLedger, REQUEST_LEDGER_CAP, requestLedgerSchema, type RequestLedger, type RequestRecord } from "./contracts"

type Hooks = Record<string, (event: never) => void>
const wallTimes: string[] = []

async function policyHarness(options: { phase: PhaseState; now: () => number }) {
  const ledger: RequestLedger = emptyRequestLedger()
  const policy = createRequestPolicyPlugin({ ledger, phase: () => options.phase, onChange: () => {}, wallTime: () => { wallTimes.push(`t${wallTimes.length}`); return `2026-11-21T00:00:0${wallTimes.length}.000Z` }, now: options.now })
  const hooks: Hooks = {}
  await policy.plugin.setup({
    session: {
      hook: async (name: string, callback: (event: never) => void) => {
        hooks[name] = callback
        return { dispose: async () => {} }
      },
    },
  } as never)
  return { policy, ledger, hooks }
}

const discoveryPhase = (deadlineEpochMs: number): PhaseState => ({ phase: "discovery", deadlineEpochMs })
const requestEvent = (kind: RequestRecord["kind"], sessionId = "session") =>
  ({ sessionID: sessionId, kind, request: { url: `https://provider.test/${kind}/${sessionId}` } })
const retryEvent = (error: { type: string; status?: number; retryAfterMs?: number }, sessionId = "session", attempt = 2) =>
  ({ sessionID: sessionId, attempt, error, decision: { retry: false } as { retry: false } | { retry: true; delay: number } })

describe("request admission", () => {
  test("a request is admitted while the two-second analysis minimum fits and stopped after it", async () => {
    const now = { value: 1_000 }
    const deadline = now.value + MODEL_ADMISSION_MS
    const { hooks, ledger, policy } = await policyHarness({ phase: discoveryPhase(deadline), now: () => now.value })
    hooks["http.request"]!(requestEvent("primary") as never)
    expect(ledger.records).toHaveLength(1)
    expect(ledger.records[0]).toMatchObject({ phase: "discovery", sessionId: "session", kind: "primary", attempt: 1, outcome: "started", status: null, finishedAt: null })
    now.value += 1
    expect(() => hooks["http.request"]!(requestEvent("primary") as never)).toThrow("phase deadline")
    expect(ledger.records).toHaveLength(1)
    expect(policy.stopCode("session")).toBe("discovery-timeout")
  })

  test("a stopped request records no ledger entry and never records headers, bodies, or URLs", async () => {
    const now = { value: 1_000 }
    const { hooks, ledger, policy } = await policyHarness({ phase: discoveryPhase(now.value + MODEL_ADMISSION_MS), now: () => now.value })
    hooks["http.request"]!(requestEvent("primary") as never)
    expect(ledger.records).toHaveLength(1)
    const serialized = JSON.stringify(ledger.records)
    expect(serialized).not.toContain("authorization")
    expect(serialized).not.toContain("http://")
    now.value += MODEL_ADMISSION_MS + 1
    expect(() => hooks["http.request"]!(requestEvent("primary") as never)).toThrow()
    expect(ledger.records).toHaveLength(1)
    expect(policy.stopCode("session")).toBe("discovery-timeout")
    expect(() => requestLedgerSchema.parse(ledger)).not.toThrow()
  })
})

describe("response recording", () => {
  test("closes the attempt its own request object identifies, so concurrent kinds never cross", async () => {
    const now = { value: 1_000 }
    const { hooks, ledger } = await policyHarness({ phase: discoveryPhase(now.value + 60_000), now: () => now.value })
    const primary = { url: "https://provider.test/primary" }
    const title = { url: "https://provider.test/title" }
    hooks["http.request"]!({ sessionID: "session", kind: "primary", request: primary } as never)
    hooks["http.request"]!({ sessionID: "session", kind: "title", request: title } as never)
    hooks["http.response"]!({ sessionID: "session", request: title, response: { status: 500 } } as never)
    hooks["http.response"]!({ sessionID: "session", request: primary, response: { status: 200 } } as never)
    expect(ledger.records.find((record) => record.kind === "title")).toMatchObject({ status: 500, outcome: "response" })
    expect(ledger.records.find((record) => record.kind === "primary")).toMatchObject({ status: 200, outcome: "response" })
    // A completed response starts the next request of the same kind at attempt one.
    hooks["model.request"]!({ sessionID: "session", kind: "primary" } as never)
    hooks["http.request"]!(requestEvent("primary") as never)
    expect(ledger.records.at(-1)!.attempt).toBe(1)
    hooks["http.response"]!({ sessionID: "session", request: primary, response: { status: 500 } } as never)
    // A retriable response with no retry decision makes the next request a hidden-retry
    // continuation, which is the path the SDK's own retry loops take.
    hooks["http.request"]!(requestEvent("primary") as never)
    expect(ledger.records.at(-1)!.attempt).toBe(2)
  })

  test("a retry decision closes the session's one outstanding record as a transport error", async () => {
    const now = { value: 1_000 }
    const { hooks, ledger } = await policyHarness({ phase: discoveryPhase(now.value + 60_000), now: () => now.value })
    hooks["http.request"]!(requestEvent("primary") as never)
    const event = retryEvent({ type: "provider.transport" })
    hooks["retry"]!(event as never)
    expect(event.decision).toEqual({ retry: true, delay: 1_000 })
    expect(ledger.records[0]).toMatchObject({ outcome: "transport-error", finishedAt: expect.any(String) })
  })
})

describe("retry decisions", () => {
  test("deterministic delays follow the SDK's attempt ordinal and the fourth attempt is refused", async () => {
    const now = { value: 1_000 }
    const { hooks, policy } = await policyHarness({ phase: discoveryPhase(now.value + 60_000), now: () => now.value })
    const first = retryEvent({ type: "provider.internal", status: 500 }, "session", 2)
    hooks["retry"]!(first as never)
    expect(first.decision).toEqual({ retry: true, delay: 1_000 })
    const second = retryEvent({ type: "provider.internal", status: 503 }, "session", 3)
    hooks["retry"]!(second as never)
    expect(second.decision).toEqual({ retry: true, delay: 2_000 })
    const third = retryEvent({ type: "provider.rate-limit", status: 429 }, "session", 4)
    hooks["retry"]!(third as never)
    expect(third.decision).toEqual({ retry: false })
    expect(policy.stopCode("session")).toBe("retry-exhausted")
  })

  test("retryAfterMs is a lower bound on the deterministic delay", async () => {
    const now = { value: 1_000 }
    const { hooks } = await policyHarness({ phase: discoveryPhase(now.value + 60_000), now: () => now.value })
    const event = retryEvent({ type: "provider.rate-limit", status: 429, retryAfterMs: 5_000 })
    hooks["retry"]!(event as never)
    expect(event.decision).toEqual({ retry: true, delay: 5_000 })
  })

  test("a retry whose delay cannot leave the two-second minimum stops the stage instead", async () => {
    const now = { value: 1_000 }
    const { hooks, policy } = await policyHarness({ phase: discoveryPhase(now.value + 2_500), now: () => now.value })
    const event = retryEvent({ type: "provider.transport" })
    hooks["retry"]!(event as never)
    expect(event.decision).toEqual({ retry: false })
    expect(policy.stopCode("session")).toBe("discovery-timeout")
  })

  test("expressly non-retriable classes reject before any status is considered", async () => {
    const now = { value: 1_000 }
    const { hooks, policy } = await policyHarness({ phase: discoveryPhase(now.value + 60_000), now: () => now.value })
    for (const error of [
      { type: "provider.auth", status: 401 },
      { type: "provider.quota", status: 429 },
      { type: "provider.content-filter" },
      { type: "provider.invalid-output" },
      { type: "provider.invalid-request", status: 400 },
      { type: "provider.unsupported-operation" },
      { type: "unknown", status: 404 },
    ]) {
      const event = retryEvent(error)
      hooks["retry"]!(event as never)
      expect(event.decision).toEqual({ retry: false })
    }
    expect(policy.stopCode("session")).toBeNull()
    expect(isRetriableRequestError({ type: "provider.rate-limit" })).toBe(true)
    expect(isRetriableRequestError({ type: "provider.internal", status: 529 })).toBe(true)
    expect(isRetriableRequestError({ type: "provider.quota", status: 429 })).toBe(false)
    expect(isRetriableRequestError({ type: "unknown", status: 500 })).toBe(true)
  })

  test("a transport failure after primary HTTP 200 retries the primary without touching an open title", async () => {
    const now = { value: 1_000 }
    const { hooks, ledger } = await policyHarness({ phase: discoveryPhase(now.value + 60_000), now: () => now.value })
    const primary = requestEvent("primary", "a")
    hooks["model.request"]!(primary as never)
    hooks["http.request"]!(primary as never)
    hooks["http.response"]!({ ...primary, response: { status: 200 } } as never)
    const title = requestEvent("title", "a")
    hooks["model.request"]!(title as never)
    hooks["http.request"]!(title as never)
    hooks["retry"]!(retryEvent({ type: "provider.transport" }, "a", 2) as never)
    expect(ledger.records[0]).toMatchObject({ kind: "primary", status: 200, outcome: "transport-error" })
    expect(ledger.records[1]).toMatchObject({ kind: "title", outcome: "started", finishedAt: null })
    const retry = requestEvent("primary", "a")
    hooks["model.request"]!(retry as never)
    hooks["http.request"]!(retry as never)
    expect(ledger.records.filter(({ kind }) => kind === "primary").map(({ attempt }) => attempt)).toEqual([1, 2])
  })

  test("counters are per session and kind, so one session's retries never spend another's", async () => {
    const now = { value: 1_000 }
    const { hooks } = await policyHarness({ phase: discoveryPhase(now.value + 60_000), now: () => now.value })
    for (const attempt of [2, 3]) {
      const event = retryEvent({ type: "provider.transport" }, "a", attempt)
      hooks["retry"]!(event as never)
      expect(event.decision).toEqual({ retry: true, delay: attempt === 2 ? 1_000 : 2_000 })
    }
    const other = retryEvent({ type: "provider.transport" }, "b")
    hooks["retry"]!(other as never)
    expect(other.decision).toEqual({ retry: true, delay: 1_000 })
  })
})

describe("per-call attempt cap", () => {
  test("a fourth wire attempt of a hidden retry loop is stopped with retry-exhausted", async () => {
    const now = { value: 1_000 }
    const { hooks, ledger, policy } = await policyHarness({ phase: discoveryPhase(now.value + 60_000), now: () => now.value })
    for (let attempt = 1; attempt <= 3; attempt++) {
      hooks["http.request"]!({ sessionID: "session", kind: "generate", request: { url: `https://provider.test/${attempt}` } } as never)
    }
    expect(ledger.records.map((record) => record.attempt)).toEqual([1, 2, 3])
    expect(() => hooks["http.request"]!({ sessionID: "session", kind: "generate", request: { url: "https://provider.test/4" } } as never))
      .toThrow("three attempts")
    expect(ledger.records).toHaveLength(3)
    expect(policy.stopCode("session")).toBe("retry-exhausted")
    expect(policy.causedFailure("session", { type: "provider.auth" })).toBeNull()
    expect(policy.causedFailure("session", { type: "provider.internal", message: "a logical model call cannot exceed three attempts on the wire" })).toBe("retry-exhausted")
  })

  test("a completed response resets the per-call count across steps of one session", async () => {
    const now = { value: 1_000 }
    const { hooks, ledger } = await policyHarness({ phase: discoveryPhase(now.value + 60_000), now: () => now.value })
    for (const step of [1, 2]) {
      const request = { url: `https://provider.test/step-${step}` }
      hooks["model.request"]!({ sessionID: "session", kind: "primary" } as never)
      hooks["http.request"]!({ sessionID: "session", kind: "primary", request } as never)
      hooks["http.response"]!({ sessionID: "session", request, response: { status: 200 } } as never)
    }
    expect(ledger.records.map((record) => record.attempt)).toEqual([1, 1])
  })
})

describe("request ledger cap", () => {
  test("reaching the cap stops new requests with the request-budget code and keeps every record", async () => {
    const now = { value: 1_000 }
    const { hooks, ledger } = await policyHarness({ phase: discoveryPhase(now.value + 10_000_000), now: () => now.value })
    for (let index = 0; index < REQUEST_LEDGER_CAP; index++) {
      const request = { url: `https://provider.test/${index}` }
      hooks["model.request"]!({ sessionID: `session-${Math.floor(index / 128)}`, kind: "primary" } as never)
      hooks["http.request"]!({ sessionID: `session-${Math.floor(index / 128)}`, kind: "primary", request } as never)
      hooks["http.response"]!({ sessionID: `session-${Math.floor(index / 128)}`, request, response: { status: 200 } } as never)
    }
    expect(ledger.records).toHaveLength(REQUEST_LEDGER_CAP)
    expect(ledger.capped).toBe(false)
    expect(() => hooks["http.request"]!({ sessionID: "session-2", kind: "primary", request: { url: "https://provider.test/cap" } } as never)).toThrow("request ledger")
    expect(ledger.capped).toBe(true)
    expect(ledger.records).toHaveLength(REQUEST_LEDGER_CAP)
  })
})
