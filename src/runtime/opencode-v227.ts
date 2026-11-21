import { createHash } from "node:crypto"
import { OpenCode } from "@opencode/sdk"
import type { SessionMessageInfo } from "@opencode/client"
import { discoveryPhaseDeadline, withinDeadline } from "../budget"
import type { Sha256 } from "../identity"
import type { Failure } from "../pr-contracts"
import { createContextLimitsPlugin } from "./context-limits"
import { createRequestPolicyPlugin, modelTransportFetch, stageTimeoutCode, type PhaseState, type RequestPolicy, type SessionRequestError } from "./request-policy"
import {
  emptyReadBudget, emptyRequestLedger, submissionSchema, sumUsage, unknownUsage,
  type PhaseDeadlines, type PhaseResult, type RuntimeResult, type Submission, type WorkerInput, type WorkerProgress,
} from "./contracts"
import { validateDiscoveryText, validateVerificationText } from "../phase-validation"
import type { Candidate } from "../contracts"

export type RuntimeHost = Pick<OpenCode.Interface, "sessions" | "message" | "events" | "model" | "close">
export function resolvePhasePrompt(prompt: string, previousOutput?: string): string {
  const marker = "{{PREVIOUS_PHASE_OUTPUT}}"
  if (!prompt.includes(marker)) return prompt
  if (previousOutput === undefined) throw new Error("phase prompt requires output from a preceding phase")
  return prompt.replace(marker, () => previousOutput)
}

export const readOnlyPermissions = () => [
  { action: "*", resource: "*", effect: "deny" as const },
  { action: "read", resource: "*", effect: "allow" as const },
  { action: "grep", resource: "*", effect: "allow" as const },
  { action: "glob", resource: "*", effect: "allow" as const },
  { action: "external_directory", resource: "*", effect: "deny" as const },
]

export function completedTurn(messages: SessionMessageInfo[], promptID: string) {
  const start = messages.findIndex((message) => message.type === "user" && message.id === promptID)
  if (start < 0) return undefined
  const turn = messages.slice(start + 1)
  const end = turn.findIndex((message) => message.type === "idle")
  if (end < 0) return undefined
  const idle = turn[end]
  if (idle.type !== "idle") return undefined
  const assistants = turn.slice(0, end).filter((message) => message.type === "assistant")
  return { idle, assistants, last: assistants.at(-1) }
}

export async function listMessages(host: Pick<RuntimeHost, "message">, sessionID: string, signal?: AbortSignal): Promise<SessionMessageInfo[]> {
  const messages: SessionMessageInfo[] = []
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    signal?.throwIfAborted()
    const page = await host.message.list({ sessionID, ...(cursor ? { cursor } : { order: "asc" }) })
    messages.push(...page.data)
    cursor = page.cursor.next ?? undefined
    if (cursor && seen.has(cursor)) throw new Error("SDK message pagination repeated a cursor")
    if (cursor) seen.add(cursor)
  } while (cursor)
  return messages
}

type SessionErrorSummary = SessionRequestError & { message?: string }

function sessionFailureCode(error: SessionErrorSummary | undefined, policy: RequestPolicy, sessionID: string): Failure["code"] {
  switch (error?.type) {
    case "provider.auth":
    case "provider.quota":
    case "provider.free-limit":
    case "provider.go-limit":
    case "provider.budget-limit":
    case "provider.model-budget-limit":
    case "provider.chatgpt-limit":
      return "model-auth"
    case "provider.no-route":
      return "model-config"
    case "provider.content-filter":
      return "model-refusal"
    default:
      return (error && policy.causedFailure(sessionID, error)) || "model-format"
  }
}

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex")

export type PromptAcceptance =
  | { kind: "accepted"; userMessageId: string }
  | { kind: "missing" }
  | { kind: "ambiguous"; ids: string[] }

// Same-session acceptance recovery. After a lost or interrupted prompt response, the durable
// message list is the only trustworthy record: a new user message whose exact prompt text hashes
// to the recorded digest proves acceptance, several matching messages break the single-submitter
// invariant, and absence is never concluded from a small number of empty reads.
export async function recoverAcceptedPrompt(options: {
  host: Pick<RuntimeHost, "message">
  sessionID: string
  promptText: string
  baselineUserIds: string[]
  deadlineEpochMs: number
  maxReads?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<PromptAcceptance> {
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const digest = sha256Hex(options.promptText)
  const baseline = new Set(options.baselineUserIds)
  const maxReads = options.maxReads ?? Number.POSITIVE_INFINITY
  for (let reads = 0; reads < maxReads; reads++) {
    if (now() >= options.deadlineEpochMs) break
    let messages: SessionMessageInfo[]
    try {
      const read = await withinDeadline((signal) => listMessages(options.host, options.sessionID, signal), options.deadlineEpochMs)
      if (read.kind === "timed-out") break
      messages = read.value
    } catch {
      await sleep(Math.max(0, Math.min(300, options.deadlineEpochMs - now())))
      continue
    }
    const matches = messages
      .filter((message) => message.type === "user" && !baseline.has(message.id) && sha256Hex(message.text) === digest)
      .map((message) => message.id)
    if (matches.length === 1) return { kind: "accepted", userMessageId: matches[0]! }
    if (matches.length > 1) return { kind: "ambiguous", ids: matches }
    await sleep(Math.max(0, Math.min(300, options.deadlineEpochMs - now())))
  }
  return { kind: "missing" }
}

export type PromptSubmission =
  | { kind: "accepted"; userMessageId: string }
  | { kind: "stopped" }
  | { kind: "failed"; code: Failure["code"]; message: string }

const boundedErrorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500).trim() || "the prompt submission failed without a message"

export async function submitPromptExactlyOnce(options: {
  host: Pick<RuntimeHost, "sessions" | "message">
  sessionID: string
  promptText: string
  baselineUserIds: string[]
  deadlineEpochMs: number
  timeoutCode: Failure["code"]
  interrupted: Promise<unknown>
  isStopped: () => boolean
  report: (submission: Submission) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<PromptSubmission> {
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  if (options.isStopped()) return { kind: "stopped" }
  if (now() >= options.deadlineEpochMs) {
    return { kind: "failed", code: options.timeoutCode, message: "the phase deadline passed before the prompt was submitted" }
  }
  const promptDigest = sha256Hex(options.promptText) as Sha256
  const report = (submission: Submission) => options.report(submissionSchema.parse(submission))
  report({ kind: "submitting", sessionId: options.sessionID, baselineUserIds: options.baselineUserIds, promptDigest, submittedAt: new Date().toISOString() })
  const submitted = await withinDeadline(() => Promise.race([
    options.host.sessions.prompt({ sessionID: options.sessionID, text: options.promptText }),
    options.interrupted.then(() => undefined),
  ]), options.deadlineEpochMs).catch(() => undefined)
  if (submitted?.kind === "completed" && submitted.value !== undefined) {
    report({ kind: "accepted", sessionId: options.sessionID, userMessageId: submitted.value.id, promptDigest })
    return { kind: "accepted", userMessageId: submitted.value.id }
  }
  const recovered = await recoverAcceptedPrompt({ ...options, now, sleep })
  if (recovered.kind === "accepted") {
    report({ kind: "accepted", sessionId: options.sessionID, userMessageId: recovered.userMessageId, promptDigest })
    if (options.isStopped()) return { kind: "stopped" }
    return { kind: "accepted", userMessageId: recovered.userMessageId }
  }
  report({ kind: "acceptance-unknown", sessionId: options.sessionID, promptDigest })
  return {
    kind: "failed", code: "acceptance-unknown",
    message: recovered.kind === "ambiguous"
      ? `the session recorded multiple new user messages matching the submitted prompt: ${recovered.ids.join(", ")}`
      : "the prompt response was lost and the same session never recorded the submitted prompt",
  }
}

async function runSession(options: {
  host: RuntimeHost
  input: WorkerInput
  prompt: WorkerInput["prompts"][number]
  signal: AbortSignal
  stopped: () => "interrupted" | "read-budget-exhausted"
  phase: PhaseState
  policy: RequestPolicy
  reportSubmission: (submission: Submission) => void
  now?: () => number
}): Promise<PhaseResult> {
  const { host, input, prompt, signal, stopped, phase, policy, reportSubmission } = options
  const now = options.now ?? (() => Date.now())
  const session = await host.sessions.create({
    location: { directory: input.materialDirectory }, model: { providerID: input.model.providerID, id: input.model.modelID }, permissions: readOnlyPermissions(),
  })
  const sessionID = session.id
  const eventController = new AbortController()
  const iterator = host.events.subscribe({ types: ["session.status"], signal: eventController.signal })[Symbol.asyncIterator]()
  let settleInterrupt: (() => void) | undefined
  const interruption = new Promise<void>((resolve) => { settleInterrupt = resolve })
  let interruptRequested = false
  const onAbort = () => {
    if (interruptRequested) return
    interruptRequested = true
    settleInterrupt?.()
    void host.sessions.interrupt({ sessionID }).catch(() => undefined)
  }
  signal.addEventListener("abort", onAbort, { once: true })
  let usage = unknownUsage("session usage was not settled")
  const interruptedCode = (): Failure["code"] => stopped() === "read-budget-exhausted" ? "read-budget"
    : signal.reason === "discovery-timeout" || signal.reason === "verification-timeout" ? stageTimeoutCode(phase.phase) : "run-interrupted"
  const interruptedResult = (): PhaseResult => ({
    name: prompt.name, sessionID, status: signal.reason === "discovery-timeout" || signal.reason === "verification-timeout" ? "timeout" : stopped(),
    error: "runtime stopped before the session settled", code: interruptedCode(), usage,
  })
  try {
    if (signal.aborted) onAbort()
    if (interruptRequested) return interruptedResult()
    // Advancing the lazy stream and observing server.connected proves subscription before the prompt.
    while (true) {
      const connected = await Promise.race([iterator.next(), interruption.then(() => undefined)])
      if (!connected) return interruptedResult()
      if (connected.done) throw new Error("SDK event stream closed before connecting")
      if (connected.value.type === "server.connected") break
    }
    let nextEvent = iterator.next().catch(() => undefined)
    let streamOpen = true
    // The baseline read happens before submission, so recovery can tell a new user message from
    // every message that already existed.
    const baselineUserIds = (await listMessages(host, sessionID))
      .filter((message) => message.type === "user")
      .map((message) => message.id)
    const submitted = await submitPromptExactlyOnce({
      host, sessionID, promptText: prompt.text, baselineUserIds,
      deadlineEpochMs: phase.deadlineEpochMs,
      timeoutCode: stageTimeoutCode(phase.phase),
      interrupted: interruption,
      isStopped: () => interruptRequested,
      report: reportSubmission,
      now,
    })
    if (submitted.kind === "stopped") return interruptedResult()
    if (submitted.kind === "failed") {
      return { name: prompt.name, sessionID, status: submitted.code === stageTimeoutCode(phase.phase) ? "timeout" : "failed", error: submitted.message, code: submitted.code, usage }
    }
    const promptID = submitted.userMessageId
    while (true) {
      const messages = await listMessages(host, sessionID)
      const completed = completedTurn(messages, promptID)
      if (completed) {
        const { idle, last } = completed
        if (idle.outcome === "interrupted") return interruptedResult()
        const stats = await host.sessions.get({ sessionID })
        usage = { kind: "known", inputTokens: stats.tokens.input, outputTokens: stats.tokens.output }
        const terminalError = idle.error ?? last?.error
        const text = last?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim()
        if (last?.finish === "content-filter") {
          return { name: prompt.name, sessionID, status: "failed", error: "the model stopped on the provider content filter", code: "model-refusal", usage }
        }
        if (terminalError || idle.outcome !== "succeeded") {
          const code = sessionFailureCode(terminalError, policy, sessionID)
          return { name: prompt.name, sessionID, status: code === stageTimeoutCode(phase.phase) ? "timeout" : "failed", error: terminalError?.message ?? "model session failed", code, usage }
        }
        if (!text || last?.finish === "length" || last?.finish === "error" || Buffer.byteLength(text) > 256 * 1024) {
          return { name: prompt.name, sessionID, status: "failed", error: "model returned no usable complete assistant text", code: "model-format", usage }
        }
        return { name: prompt.name, sessionID, status: "complete", text, usage }
      }
      if (now() >= phase.deadlineEpochMs) {
        return { name: prompt.name, sessionID, status: "timeout", error: "the phase deadline elapsed before the session settled",
          code: stageTimeoutCode(phase.phase), usage }
      }
      // After interruption continue reading the durable terminal message until the parent deadline.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const event = await Promise.race([...(streamOpen ? [nextEvent] : []), new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 1000)
        })])
        if (event?.done) streamOpen = false
        else if (event) nextEvent = iterator.next().catch(() => undefined)
      } finally { if (timer) clearTimeout(timer) }
    }
  } finally {
    signal.removeEventListener("abort", onAbort)
    eventController.abort()
    await iterator.return?.()
  }
}

class RuntimeClassifiedError extends Error {
  constructor(readonly code: Failure["code"], message: string) {
    super(message)
  }
}

function validationFailureCode(message: string): Failure["code"] {
  if (/line range|excerpt|citation|snapshot:/iu.test(message)) return "citation-invalid"
  if (/candidate/iu.test(message)) return "candidate-set-invalid"
  return "model-format"
}

export async function runRuntime(
  input: WorkerInput,
  signal: AbortSignal,
  onProgress: (progress: WorkerProgress) => void,
  discoveryDeadline?: AbortSignal,
  createHost = OpenCode.create,
): Promise<RuntimeResult> {
  const controller = new AbortController()
  let stopped: "interrupted" | "read-budget-exhausted" = "interrupted"
  const budget = emptyReadBudget()
  const ledger = emptyRequestLedger()
  const echoedDeadlines: PhaseDeadlines = { ...input.phaseDeadlines }
  let phaseState: PhaseState = { phase: "initialization", deadlineEpochMs: input.phaseDeadlines.prepareInitEpochMs }
  const forwardAbort = () => controller.abort(
    signal.reason === "supervisor-analysis-stop" ? stageTimeoutCode(phaseState.phase) : signal.reason,
  )
  signal.addEventListener("abort", forwardAbort, { once: true })
  if (signal.aborted) forwardAbort()
  let submission: Submission = { kind: "not-submitted" }
  let checkpointSequence = 0
  const sessions: PhaseResult[] = []
  const cleanup: RuntimeResult["cleanup"] = { hostClosed: false, forced: false }
  let host: OpenCode.Interface | undefined
  let outcome: RuntimeResult | undefined
  const emitProgress = () => {
    const checkpoint = { sessions: [...sessions], readBudget: budget, cleanup: { ...cleanup }, checkpointSequence: ++checkpointSequence, submission, requests: ledger, phaseDeadlines: { ...echoedDeadlines } }
    if (outcome) onProgress({ kind: "terminal", record: { ...outcome, ...checkpoint } })
    else onProgress({ kind: "running", record: { ...checkpoint, usage: unknownUsage("active session usage is not settled") } })
  }
  let phaseActive = false
  const interruptDiscovery = () => {
    if (phaseActive && phaseState.phase === "discovery") controller.abort("discovery-timeout")
  }
  discoveryDeadline?.addEventListener("abort", interruptDiscovery, { once: true })
  // The abandoned create settles after the run gave up on it; closing it then is best effort and
  // prevents an unresolved host from outliving the worker's own exit.
  let abandonedCreate = false
  // Preparation and initialization share one cap, so SDK startup and model resolution are raced
  // against the preparation deadline instead of being checked only after they finish. A hung
  // initialization fails at the cap rather than consuming the analysis window.
  let clearInitTimer: () => void = () => {}
  const initDeadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new RuntimeClassifiedError("runtime-init", "runtime initialization exceeded the preparation deadline")),
      Math.max(0, input.phaseDeadlines.prepareInitEpochMs - Date.now()),
    )
    clearInitTimer = () => clearTimeout(timer)
  })
  try {
    if (!process.env.OPENAI_API_KEY?.trim()) throw new RuntimeClassifiedError("model-auth", "model API key must be nonempty")
    const policy = createRequestPolicyPlugin({
      ledger,
      phase: () => phaseState,
      onChange: emitProgress,
    })
    const creating = createHost({
      fetch: modelTransportFetch,
      config: {
        directory: input.configDirectory, project: false, claude: false,
        content: JSON.stringify({
          permissions: readOnlyPermissions(), agents: { build: { steps: 12 } },
          experimental: { background_compaction: false },
          plugins: ["-opencode.config.instruction"], snapshots: false, share: "disabled", lsp: false, formatter: false,
          providers: { [input.model.providerID]: { package: "aisdk:@ai-sdk/openai-compatible", settings: { baseURL: input.model.baseURL, apiKey: "{env:OPENAI_API_KEY}" }, models: { [input.model.modelID]: {} } } },
        }),
      },
      models: { fetch: false }, fs: { filewatcher: false },
      plugins: [createContextLimitsPlugin({ limits: input.readLimits, budget, materialDirectory: input.materialDirectory,
        onChange: emitProgress, onExhausted: () => { stopped = "read-budget-exhausted"; controller.abort() } }),
        policy.plugin],
    })
    void creating.then((created) => {
      if (abandonedCreate) created.close().catch(() => undefined)
    }, () => undefined)
    host = await Promise.race([creating, initDeadline])
    const models = await Promise.race([
      host.model.list({ location: { directory: input.materialDirectory }, types: ["chat"] }),
      initDeadline,
    ])
    if (!models.data.some((model) => model.enabled && model.providerID === input.model.providerID && model.id === input.model.modelID)) {
      throw new RuntimeClassifiedError("model-config", "configured model is not enabled in the isolated runtime")
    }
    // Preparation, initialization, and every capture-side step before this point share the
    // prepare-init cap; an initialization that finishes after the cap has already spent the
    // discovery window's guarantee.
    if (Date.now() > input.phaseDeadlines.prepareInitEpochMs) {
      throw new RuntimeClassifiedError("runtime-init", "runtime initialization exceeded the preparation deadline")
    }
    // The first phase is a durable phase transition, so the initialization timer ends here.
    clearInitTimer()
    let previousOutput: string | undefined
    let discovered: Candidate[] | undefined
    const validation = input.phaseValidation ?? { changedHeadPaths: [], includedFiles: [] }
    for (const prompt of input.prompts) {
      if (controller.signal.aborted || Date.now() >= input.phaseDeadlines.analysisStopEpochMs) break
      if (prompt.name === "verify" && !discovered) throw new Error("verification requires a validated discovery result")
      const text = resolvePhasePrompt(prompt.text, previousOutput)
      // Discovery owns a fresh 120-second window from its actual start, bounded by the analysis
      // stop. The concrete deadline is echoed in every progress record so the parent's interrupt
      // timer and this process's request admission agree.
      if (prompt.name === "discover") {
        echoedDeadlines.discoveryEpochMs = discoveryPhaseDeadline(Date.now(), input.phaseDeadlines)
        phaseState = { phase: "discovery", deadlineEpochMs: echoedDeadlines.discoveryEpochMs }
      } else {
        phaseState = { phase: "verification", deadlineEpochMs: input.phaseDeadlines.analysisStopEpochMs }
      }
      submission = { kind: "not-submitted" }
      emitProgress()
      phaseActive = true
      const phaseStarted = Date.now()
      const settled = await runSession({ host, input, prompt: { ...prompt, text }, signal: controller.signal, stopped: () => stopped, phase: phaseState, policy, reportSubmission: (value) => { submission = value; emitProgress() } })
      let result = settled
      if (settled.status === "complete") {
        const { text, ...phase } = settled
        try {
          const validated = await withinDeadline(async () => {
            if (prompt.name === "discover") return validateDiscoveryText(text, validation, input.materialDirectory)
            if (prompt.name === "verify") await validateVerificationText(text, discovered ?? [], validation, input.materialDirectory)
          }, phaseState.deadlineEpochMs)
          const code = stageTimeoutCode(phaseState.phase)
          if (validated.kind === "timed-out" || controller.signal.reason === code || Date.now() >= phaseState.deadlineEpochMs) {
            result = { ...phase, status: "timeout", error: "the phase deadline elapsed before its output was validated", code }
          } else if (validated.value !== undefined) discovered = validated.value
        } catch (error) {
          const message = boundedErrorText(error)
          result = { ...phase, status: "failed", error: message, code: validationFailureCode(message) }
        }
      }
      phaseActive = false
      sessions.push({ ...result, durationMs: Date.now() - phaseStarted })
      if (result.status !== "complete") break
      previousOutput = result.text
      emitProgress()
    }
    const failed = sessions.find((session) => session.status !== "complete")
    if (failed) outcome = { status: failed.status, error: failed.error, code: failed.code, sessions, usage: sumUsage(sessions), readBudget: budget, cleanup, checkpointSequence: ++checkpointSequence, submission, requests: ledger, phaseDeadlines: echoedDeadlines }
    else if (sessions.length !== input.prompts.length) {
      // The loop stopped before a phase could start. A time-based stop is the stage timeout of
      // the phase that never ran; an abort carries the stop reason the tool budget recorded.
      const timedOut = !controller.signal.aborted
      outcome = {
        status: timedOut ? "timeout" : stopped,
        error: timedOut ? "the analysis stop was reached before every phase could run" : "runtime stopped before all sessions completed",
        code: timedOut ? "verification-timeout" : budget.exhausted ? "read-budget" : "run-interrupted",
        sessions, usage: unknownUsage("remaining sessions were not run"), readBudget: budget, cleanup,
        checkpointSequence: ++checkpointSequence, submission, requests: ledger, phaseDeadlines: echoedDeadlines,
      }
    }
    else outcome = { status: "complete", sessions, usage: sumUsage(sessions), readBudget: budget, cleanup, checkpointSequence: ++checkpointSequence, submission, requests: ledger, phaseDeadlines: echoedDeadlines }
  } catch (error) {
    // A failed run no longer waits on its pending SDK create: when it settles later, the abandoned
    // host closes instead of keeping the worker's event loop alive.
    abandonedCreate = true
    const message = boundedErrorText(error)
    const code = error instanceof RuntimeClassifiedError ? error.code
      : phaseActive || sessions.length === 0 ? "runtime-init" : validationFailureCode(message)
    outcome = { status: "failed", error: message, code, sessions, usage: !phaseActive && sessions.length ? sumUsage(sessions) : unknownUsage("runtime failed before usage settled"), readBudget: budget, cleanup, checkpointSequence: ++checkpointSequence, submission, requests: ledger, phaseDeadlines: echoedDeadlines }
  } finally {
    signal.removeEventListener("abort", forwardAbort)
    discoveryDeadline?.removeEventListener("abort", interruptDiscovery)
    clearInitTimer()
    // Save the business outcome before waiting on SDK cleanup, which can hang until the kill.
    try { emitProgress() }
    finally {
      try {
        if (host) { await host.close(); cleanup.hostClosed = true }
      } catch (error) {
        cleanup.closeFailure = boundedErrorText(error)
      }
      emitProgress()
    }
  }
  return { ...outcome, checkpointSequence: ++checkpointSequence }
}
