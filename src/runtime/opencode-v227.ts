import { OpenCode } from "@opencode/sdk"
import type { SessionMessageInfo } from "@opencode/client"
import { createContextLimitsPlugin } from "./context-limits"
import { emptyReadBudget, sumUsage, unknownUsage, type PhaseResult, type RuntimeResult, type WorkerInput } from "./contracts"

export type RuntimeHost = Pick<OpenCode.Interface, "sessions" | "message" | "events" | "model" | "close">
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

export async function listMessages(host: Pick<RuntimeHost, "message">, sessionID: string): Promise<SessionMessageInfo[]> {
  const messages: SessionMessageInfo[] = []
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    const page = await host.message.list({ sessionID, ...(cursor ? { cursor } : { order: "asc" }) })
    messages.push(...page.data)
    cursor = page.cursor.next ?? undefined
    if (cursor && seen.has(cursor)) throw new Error("SDK message pagination repeated a cursor")
    if (cursor) seen.add(cursor)
  } while (cursor)
  return messages
}

async function runSession(options: {
  host: RuntimeHost
  input: WorkerInput
  prompt: WorkerInput["prompts"][number]
  signal: AbortSignal
  stopped: () => "interrupted" | "read-budget-exhausted"
}): Promise<PhaseResult> {
  const { host, input, prompt, signal, stopped } = options
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
  try {
    if (signal.aborted) onAbort()
    if (interruptRequested) return { name: prompt.name, sessionID, status: stopped(), error: "runtime stopped before submitting prompt", usage }
    // Advancing the lazy stream and observing server.connected proves subscription before the prompt.
    while (true) {
      const connected = await Promise.race([iterator.next(), interruption.then(() => undefined)])
      if (!connected) return { name: prompt.name, sessionID, status: stopped(), error: "runtime stopped while subscribing", usage }
      if (connected.done) throw new Error("SDK event stream closed before connecting")
      if (connected.value.type === "server.connected") break
    }
    let nextEvent = iterator.next().catch(() => undefined)
    let streamOpen = true
    const accepted = await Promise.race([host.sessions.prompt({ sessionID, text: prompt.text }), interruption.then(() => undefined)])
    if (!accepted) return { name: prompt.name, sessionID, status: stopped(), error: "runtime stopped before prompt acceptance was confirmed", usage }
    while (true) {
      const messages = await listMessages(host, sessionID)
      const completed = completedTurn(messages, accepted.id)
      if (completed) {
        const stats = await host.sessions.get({ sessionID })
        usage = { kind: "known", inputTokens: stats.tokens.input, outputTokens: stats.tokens.output }
        if (interruptRequested) return { name: prompt.name, sessionID, status: stopped(), error: "runtime interrupted the session", usage }
        const { idle, assistants, last } = completed
        if (idle.outcome !== "succeeded" || idle.error || assistants.some((message) => message.error)) {
          return { name: prompt.name, sessionID, status: idle.outcome === "interrupted" ? "interrupted" : "failed", error: idle.error?.message ?? "model session failed", usage }
        }
        const text = last?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim()
        if (!text || last?.finish === "length" || last?.finish === "content-filter" || last?.finish === "error" || Buffer.byteLength(text) > 256 * 1024) {
          return { name: prompt.name, sessionID, status: "failed", error: "model returned no usable complete assistant text", usage }
        }
        return { name: prompt.name, sessionID, status: "complete", text, usage }
      }
      // After interruption continue reading the durable terminal message until the parent deadline.
      const timer = setTimeout(() => {}, 1000)
      try {
        const event = await Promise.race([...(streamOpen ? [nextEvent] : []), new Promise<undefined>((resolve) => {
          clearTimeout(timer)
          setTimeout(() => resolve(undefined), 1000)
        })])
        if (event?.done) streamOpen = false
        else if (event) nextEvent = iterator.next().catch(() => undefined)
      } finally { clearTimeout(timer) }
    }
  } finally {
    signal.removeEventListener("abort", onAbort)
    eventController.abort()
    await iterator.return?.()
  }
}

export async function runRuntime(input: WorkerInput, signal: AbortSignal, onProgress: (result: RuntimeResult) => void): Promise<RuntimeResult> {
  if (!process.env.OPENAI_API_KEY?.trim()) throw new Error("model API key must be nonempty")
  const controller = new AbortController()
  let stopped: "interrupted" | "read-budget-exhausted" = "interrupted"
  const forwardAbort = () => controller.abort()
  signal.addEventListener("abort", forwardAbort, { once: true })
  if (signal.aborted) controller.abort()
  const budget = emptyReadBudget()
  const sessions: PhaseResult[] = []
  const cleanup = { hostClosed: false, forced: false }
  const progress = (): RuntimeResult => ({ status: "interrupted", error: "runtime is in progress", sessions, usage: unknownUsage("active session usage is not settled"), readBudget: budget, cleanup })
  let host: OpenCode.Interface | undefined
  let outcome: RuntimeResult | undefined
  try {
    host = await OpenCode.create({
      config: {
        directory: input.configDirectory, project: false, claude: false,
        content: JSON.stringify({
          permissions: readOnlyPermissions(), agents: { build: { steps: 12 } },
          plugins: ["-opencode.config.instruction"], snapshots: false, share: "disabled", lsp: false, formatter: false,
          providers: { [input.model.providerID]: { package: "aisdk:@ai-sdk/openai-compatible", settings: { baseURL: input.model.baseURL, apiKey: "{env:OPENAI_API_KEY}" }, models: { [input.model.modelID]: {} } } },
        }),
      },
      models: { fetch: false }, fs: { filewatcher: false },
      plugins: [createContextLimitsPlugin({ limits: input.readLimits, budget, materialDirectory: input.materialDirectory,
        onChange: () => onProgress(progress()), onExhausted: () => { stopped = "read-budget-exhausted"; controller.abort() } })],
    })
    const models = await host.model.list({ location: { directory: input.materialDirectory }, types: ["chat"] })
    if (!models.data.some((model) => model.enabled && model.providerID === input.model.providerID && model.id === input.model.modelID)) throw new Error("configured model is not enabled in the isolated runtime")
    for (const prompt of input.prompts) {
      if (controller.signal.aborted || Date.now() >= input.deadline) break
      const result = await runSession({ host, input, prompt, signal: controller.signal, stopped: () => stopped })
      sessions.push(result)
      onProgress(progress())
      if (result.status !== "complete") break
    }
    const failed = sessions.find((session) => session.status !== "complete")
    if (failed) outcome = { status: failed.status, error: failed.error, sessions, usage: sumUsage(sessions), readBudget: budget, cleanup }
    else if (sessions.length !== input.prompts.length) outcome = { status: stopped, error: "runtime stopped before all sessions completed", sessions, usage: unknownUsage("remaining sessions were not run"), readBudget: budget, cleanup }
    else outcome = { status: "complete", sessions, usage: sumUsage(sessions), readBudget: budget, cleanup }
  } catch (error) {
    outcome = { status: "failed", error: error instanceof Error ? error.message : String(error), sessions, usage: unknownUsage("runtime failed before usage settled"), readBudget: budget, cleanup }
  } finally {
    signal.removeEventListener("abort", forwardAbort)
    try {
      if (host) { await host.close(); cleanup.hostClosed = true }
    } catch {
      outcome = { status: "failed", error: "SDK host cleanup failed", sessions, usage: unknownUsage("cleanup failed"), readBudget: budget, cleanup }
    }
  }
  return outcome
}
