import { Plugin } from "@opencode/plugin"
import type { Failure } from "../pr-contracts"
import { REQUEST_LEDGER_CAP, type PhaseKind, type RequestLedger, type RequestRecord } from "./contracts"

export const MODEL_ADMISSION_MS = 2_000
// OpenCode's HTTP middleware converts the Web Request back to an Effect request and loses redirect mode.
export const modelTransportFetch = (input: RequestInfo | URL, init?: RequestInit) =>
  fetch(input, { ...init, redirect: "manual", keepalive: false })
const RETRY_DELAYS_MS = [1_000, 2_000] as const
// A logical model call never exceeds three attempts on the wire. The retry hook enforces the cap
// for kinds that pass through it by refusing an attempt ordinal above three; http.request enforces
// it for every other path, including the SDK's internal retry loops that bypass the retry hook.
const MAX_ATTEMPTS = 3
const RETRIABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529])
const RETRIABLE_ERROR_TYPES = new Set(["provider.rate-limit", "provider.transport", "provider.timeout"])
// Expressly non-retriable classes. They reject a retry before any status is considered, because
// the SDK can classify a quota or credential failure with a status that is otherwise retriable:
// a 429 carrying insufficient_quota is provider.quota and never retries.
const NON_RETRIABLE_ERROR_TYPES = new Set([
  "provider.auth", "provider.quota", "provider.free-limit", "provider.go-limit",
  "provider.budget-limit", "provider.model-budget-limit", "provider.chatgpt-limit",
  "provider.no-route", "provider.content-filter", "provider.invalid-output",
  "provider.invalid-request", "provider.unsupported-operation",
])

export type PhaseState = { phase: PhaseKind; deadlineEpochMs: number }

export function stageTimeoutCode(phase: PhaseKind): Failure["code"] {
  return phase === "discovery" ? "discovery-timeout" : phase === "verification" ? "verification-timeout" : "runtime-init"
}

export type SessionRequestError = { type: string; status?: number; retryAfterMs?: number }

export function isRetriableRequestError(error: SessionRequestError): boolean {
  if (NON_RETRIABLE_ERROR_TYPES.has(error.type)) return false
  if (RETRIABLE_ERROR_TYPES.has(error.type)) return true
  return error.status !== undefined && RETRIABLE_STATUSES.has(error.status)
}

// The thrown error's code is also recorded synchronously in the stop map, because a defect raised
// inside an SDK hook may not keep its message on the way to the terminal session error.
export class RequestPolicyStop extends Error {
  constructor(readonly stopCode: Failure["code"], message: string) {
    super(message)
  }
}

type CallSlot = { lastAttempt: number; retrying: boolean; record?: RequestRecord }

export type RequestPolicy = {
  plugin: Plugin.Plugin
  // The terminal failure code a stopped or retry-exhausted session should carry, or null when the
  // policy made no decision for this session.
  stopCode(sessionId: string): Failure["code"] | null
  causedFailure(sessionId: string, error: SessionRequestError & { message?: string }): Failure["code"] | null
}

export function createRequestPolicyPlugin(options: {
  ledger: RequestLedger
  phase: () => PhaseState
  onChange: () => void
  wallTime?: () => string
  now?: () => number
  suppressTitle?: boolean
}): RequestPolicy {
  const { ledger, phase, onChange } = options
  const wallTime = options.wallTime ?? (() => new Date().toISOString())
  const now = options.now ?? (() => Date.now())
  let sequence = 0
  const slots = new Map<string, CallSlot>()
  // http.response carries the same Request instance http.request observed, so each response closes
  // its own attempt. Concurrent requests in one session can never land on each other's records.
  const openRecords = new WeakMap<object, RequestRecord>()
  const activeRetryKind = new Map<string, "primary" | "compaction">()
  const stops = new Map<string, { code: Failure["code"]; error?: SessionRequestError; message?: string }>()
  const stopRequest = (event: { sessionID: string; kind: RequestRecord["kind"] }, code: Failure["code"], message: string): never => {
    stops.set(event.sessionID, { code, message })
    onChange()
    throw new RequestPolicyStop(code, message)
  }

  const slotFor = (sessionId: string, kind: RequestRecord["kind"]): CallSlot => {
    const key = `${sessionId}\0${kind}`
    let slot = slots.get(key)
    if (slot === undefined) {
      slot = { lastAttempt: 0, retrying: false }
      slots.set(key, slot)
    }
    return slot
  }
  const modelHook = (event: { sessionID: string; kind: RequestRecord["kind"] }): void => {
    const slot = slotFor(event.sessionID, event.kind)
    // The pinned SDK prepares each primary attempt anew; its retry callback reserves the ordinal
    // before that preparation. Generate's internal retry loop reuses the prepared call.
    if (!slot.retrying) {
      slot.lastAttempt = 0
      delete slot.record
    }
    if (event.kind === "primary" || event.kind === "compaction") activeRetryKind.set(event.sessionID, event.kind)
  }

  const requestHook = (event: { sessionID: string; kind: RequestRecord["kind"]; request: unknown }): void => {
    const state = phase()
    const slot = slotFor(event.sessionID, event.kind)
    const attempt = slot.lastAttempt + 1
    if (attempt > MAX_ATTEMPTS) {
      stopRequest(event, "retry-exhausted", "a logical model call cannot exceed three attempts on the wire")
    }
    if (now() + MODEL_ADMISSION_MS > state.deadlineEpochMs) {
      stopRequest(event, stageTimeoutCode(state.phase), "the active phase deadline stops a new model request")
    }
    if (ledger.records.length >= REQUEST_LEDGER_CAP) {
      ledger.capped = true
      stopRequest(event, "request-budget", "the request ledger reached its entry cap")
    }
    const record: RequestRecord = {
      sequence: ++sequence,
      phase: state.phase,
      sessionId: event.sessionID,
      kind: event.kind,
      attempt,
      startedAt: wallTime(),
      finishedAt: null,
      status: null,
      outcome: "started",
    }
    ledger.records.push(record)
    slot.lastAttempt = attempt
    slot.retrying = false
    slot.record = record
    if (event.kind === "primary" || event.kind === "compaction") {
      activeRetryKind.set(event.sessionID, event.kind)
      stops.delete(event.sessionID)
    }
    if (typeof event.request === "object" && event.request !== null) openRecords.set(event.request, record)
    onChange()
  }

  const responseHook = (event: { sessionID: string; request: unknown; response: Response }): void => {
    if (typeof event.request === "object" && event.request !== null) {
      const record = openRecords.get(event.request)
      if (record !== undefined) {
        openRecords.delete(event.request)
        if (record.outcome === "started") {
          record.finishedAt = wallTime()
          record.status = event.response.status
          record.outcome = "response"
        }
      }
    }
    if (event.response.status >= 300 && event.response.status < 400) {
      // The SDK treats 3xx as success and may retry when the body cannot be parsed.
      void event.response.body?.cancel().catch(() => undefined)
      event.response = new Response('{"error":{"message":"Model redirects are disabled"}}', {
        status: 400, headers: { "content-type": "application/json" },
      })
    }
    onChange()
  }

  const retryHook = (event: {
    sessionID: string
    attempt: number
    error: SessionRequestError
    decision: { retry: false } | { retry: true; delay: number }
  }): void => {
    // Primary and compaction are serial in 2.2.7. Generate and title do not invoke this hook.
    const kind = activeRetryKind.get(event.sessionID)
    const slot = kind === undefined ? undefined : slotFor(event.sessionID, kind)
    const record = slot?.record
    const streamTransportError = record?.status === 200 && (event.error.type === "provider.transport" || event.error.type === "provider.timeout")
    if (record && (record.outcome === "started" || streamTransportError)) {
      record.finishedAt = wallTime()
      record.outcome = "transport-error"
      onChange()
    }
    if (!isRetriableRequestError(event.error)) {
      event.decision = { retry: false }
      if (slot !== undefined) slot.retrying = false
      return
    }
    // The SDK's attempt ordinal names the attempt the retry would start, so the cap needs no
    // counting of its own: a fourth attempt is refused before any delay is scheduled.
    if (event.attempt > MAX_ATTEMPTS || (slot?.lastAttempt ?? 0) >= MAX_ATTEMPTS) {
      stops.set(event.sessionID, { code: "retry-exhausted", error: event.error })
      event.decision = { retry: false }
      return
    }
    const delayIndex = event.attempt - 2
    if (delayIndex < 0 || delayIndex >= RETRY_DELAYS_MS.length) {
      event.decision = { retry: false }
      return
    }
    const state = phase()
    const delay = Math.max(RETRY_DELAYS_MS[delayIndex]!, event.error.retryAfterMs ?? 0)
    if (now() + delay + MODEL_ADMISSION_MS > state.deadlineEpochMs) {
      stops.set(event.sessionID, { code: stageTimeoutCode(state.phase), error: event.error })
      event.decision = { retry: false }
      return
    }
    if (slot !== undefined) slot.retrying = true
    event.decision = { retry: true, delay }
  }

  return {
    plugin: Plugin.define({
      id: "review.request-policy",
      async setup(ctx) {
        const registrations: Awaited<ReturnType<typeof ctx.session.hook>>[] = []
        const dispose = () => Promise.all(registrations.map((registration) => registration.dispose())).then(() => undefined)
        try {
          registrations.push(await ctx.session.hook("http.request", requestHook))
          registrations.push(await ctx.session.hook("http.response", responseHook))
          registrations.push(await ctx.session.hook("model.request", modelHook))
          registrations.push(await ctx.session.hook("retry", retryHook))
          if (options.suppressTitle !== false) {
            registrations.push(await ctx.session.hook("title", (event) => { event.result = "Code review" }))
          }
        } catch (error) {
          await dispose()
          throw error
        }
        return dispose
      },
    }),
    stopCode(sessionId) {
      return stops.get(sessionId)?.code ?? null
    },
    causedFailure(sessionId, error) {
      const stop = stops.get(sessionId)
      if (stop?.error?.type === error.type && stop.error.status === error.status) return stop.code
      if (stop?.message && error.message?.includes(stop.message)) return stop.code
      return null
    },
  }
}
