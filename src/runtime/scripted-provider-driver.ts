import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { OpenCode } from "@opencode/sdk"
import { createContextLimitsPlugin } from "./context-limits"
import { createRequestPolicyPlugin, modelTransportFetch, type PhaseState } from "./request-policy"
import { completedTurn, listMessages, readOnlyPermissions, submitPromptExactlyOnce } from "./opencode-v227"
import { emptyReadBudget, emptyRequestLedger, type Submission } from "./contracts"

// Test-support driver only. The gate test spawns this file in an isolated child with the same
// clean environment shape as the production worker, boots the real installed SDK host with the
// production plugin pair, and drives every request kind against the scripted endpoint.

type Scenario =
  | "kinds"
  | "retry-recovered"
  | "retry-exhausted"
  | "ambiguous"
  | "quota-conflict"
  | "title-failure"
  | "generate-retry-cap"
  | "compaction-retry-cap"
  | "compaction-redirect"
  | "stream-retry"

type DriverConfig = {
  scenario: Scenario
  baseURL: string
  configDirectory: string
  materialDirectory: string
}

const configPath = process.argv[2]
const outputPath = process.argv[3]
if (!configPath || !outputPath) throw new Error("driver requires config and output paths")
const config: DriverConfig = JSON.parse(readFileSync(configPath, "utf8"))
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const ledger = emptyRequestLedger()
const phaseState: PhaseState = { phase: "discovery", deadlineEpochMs: Date.now() + 120_000 }
const submissions: Submission[] = []
const policy = createRequestPolicyPlugin({ ledger, phase: () => phaseState, onChange: () => {}, suppressTitle: config.scenario !== "kinds" && config.scenario !== "title-failure" })

type Observation = {
  scenario: Scenario
  sessionID: string
  requests: typeof ledger
  submissions: Submission[]
  turn?: { outcome: string; errorType: string | null }
  outcome?: { kind: string; userMessageId?: string; code?: string; message?: string }
  matchingUserMessages?: number
  userTextSamples?: string[]
  generatedText?: string
  primaryAttempts?: number[]
  elapsedMs?: number
  attemptsByKind?: Record<string, number[]>
}

const host = await OpenCode.create({
  fetch: modelTransportFetch,
  config: {
    directory: config.configDirectory,
    project: false,
    claude: false,
    content: JSON.stringify({
      permissions: readOnlyPermissions(),
      experimental: { background_compaction: false },
      plugins: ["-opencode.config.instruction"], snapshots: false, share: "disabled", lsp: false, formatter: false,
      providers: {
        scripted: {
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { baseURL: config.baseURL, apiKey: "{env:OPENAI_API_KEY}" },
          models: { "scripted-model": {} },
        },
      },
    }),
  },
  models: { fetch: false },
  fs: { filewatcher: false },
  plugins: [
    createContextLimitsPlugin({
      limits: { perToolBytes: 32 * 1024, totalBytes: 512 * 1024, maxLines: 100 },
      budget: emptyReadBudget(),
      materialDirectory: config.materialDirectory,
      onChange: () => {},
      onExhausted: () => {},
    }),
    policy.plugin,
  ],
})

async function waitForTurn(sessionID: string, promptID: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const completed = completedTurn(await listMessages(host, sessionID), promptID)
    if (completed !== undefined) return completed
    await sleep(250)
  }
  throw new Error("the scripted turn did not settle")
}

async function waitForRecord(kind: (typeof ledger.records)[number]["kind"], count = 1, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ledger.records.filter((record) => record.kind === kind).length >= count) return
    await sleep(250)
  }
  throw new Error(`only ${ledger.records.filter((record) => record.kind === kind).length} ${kind} requests reached the session hooks`)
}

async function createSession() {
  const session = await host.sessions.create({
    location: { directory: config.materialDirectory },
    model: { providerID: "scripted", id: "scripted-model" },
    permissions: readOnlyPermissions(),
  })
  return session
}

const attemptsByKind = (): Record<string, number[]> => {
  const grouped: Record<string, number[]> = {}
  for (const record of ledger.records) {
    ;(grouped[record.kind] ??= []).push(record.attempt)
  }
  return grouped
}

const observation: Observation = { scenario: config.scenario, sessionID: "", requests: ledger, submissions }

try {
  if (config.scenario === "ambiguous") {
    const session = await createSession()
    observation.sessionID = session.id
    const realPrompt = host.sessions.prompt.bind(host.sessions)
    const promptText = "Reply with OK."
    const started = Date.now()
    const outcome = await submitPromptExactlyOnce({
      host: { message: host.message, sessions: { prompt: async (input: { sessionID: string; text: string }) => {
        await realPrompt(input)
        throw new Error("simulated lost response after delivery")
      } } as never },
      sessionID: session.id,
      promptText,
      baselineUserIds: [],
      deadlineEpochMs: phaseState.deadlineEpochMs,
      timeoutCode: "discovery-timeout",
      interrupted: new Promise(() => {}),
      isStopped: () => false,
      report: (submission) => submissions.push(submission),
    })
    observation.outcome = outcome
    observation.elapsedMs = Date.now() - started
    const messages = await listMessages(host, session.id)
    observation.matchingUserMessages = messages.filter((message) => message.type === "user" && message.text === promptText).length
    observation.userTextSamples = messages.filter((message) => message.type === "user").map((message) => message.text.slice(0, 200))
    if (outcome.kind !== "accepted") throw new Error(`recovery did not accept the delivered prompt: ${JSON.stringify(outcome)}`)
    const recovered = await waitForTurn(session.id, outcome.userMessageId)
    observation.turn = { outcome: recovered.idle.outcome, errorType: recovered.idle.error?.type ?? null }
  } else if (config.scenario === "generate-retry-cap") {
    // The generate request kind retries through the SDK's own loop without any retry hook, so the
    // per-call cap must hold at the transport hook: three wire attempts, then a stop.
    const session = await createSession()
    observation.sessionID = session.id
    const started = Date.now()
    let generated: string | undefined
    try {
      const response = await host.sessions.generate({ sessionID: session.id, prompt: "Say done." })
      generated = response.text
    } catch (error) {
      observation.outcome = { kind: "generate-failed", message: error instanceof Error ? error.message : String(error) }
    }
    observation.elapsedMs = Date.now() - started
    observation.generatedText = generated
  } else if (config.scenario === "compaction-retry-cap" || config.scenario === "compaction-redirect") {
    const session = await createSession()
    observation.sessionID = session.id
    const inbox = await host.sessions.prompt({ sessionID: session.id, text: "Reply with OK." })
    await waitForTurn(session.id, inbox.id)
    const started = Date.now()
    try {
      await host.sessions.compact({ sessionID: session.id })
    } catch (error) {
      observation.outcome = { kind: "compaction-failed", message: error instanceof Error ? error.message : String(error) }
    }
    await waitForRecord("compaction", config.scenario === "compaction-retry-cap" ? 3 : 1)
    observation.elapsedMs = Date.now() - started
    // A fourth compaction attempt must never reach the wire, so the count stays at three.
    await sleep(2_000)
  } else {
    const session = await createSession()
    observation.sessionID = session.id
    const started = Date.now()
    const inbox = await host.sessions.prompt({ sessionID: session.id, text: "Reply with OK." })
    const completed = await waitForTurn(session.id, inbox.id)
    observation.turn = { outcome: completed.idle.outcome, errorType: completed.idle.error?.type ?? null }
    observation.elapsedMs = Date.now() - started
    observation.primaryAttempts = ledger.records.filter((record) => record.kind === "primary").map((record) => record.attempt)
    if (config.scenario === "kinds") {
      await waitForRecord("title")
      const generated = await host.sessions.generate({ sessionID: session.id, prompt: "Say done." })
      observation.generatedText = generated.text
      await host.sessions.compact({ sessionID: session.id })
      await waitForRecord("compaction")
      const compactionDeadline = Date.now() + 15_000
      while (Date.now() < compactionDeadline) {
        if ((await listMessages(host, session.id)).some((message) => message.type === "compaction" && message.status === "completed")) break
        await sleep(250)
      }
    }
    if (config.scenario === "title-failure") {
      await waitForRecord("title", 1)
      // The SDK's title generation makes one attempt and never retries, so the count stays at one.
      await sleep(3_000)
    }
  }
  observation.attemptsByKind = attemptsByKind()
  await host.close()
  writeFileSync(`${outputPath}.tmp`, JSON.stringify(observation), { mode: 0o600 })
  renameSync(`${outputPath}.tmp`, outputPath)
  process.exit(0)
} catch (error) {
  observation.outcome = { kind: "driver-failed", message: error instanceof Error ? error.message : String(error) }
  observation.attemptsByKind = attemptsByKind()
  try { await host.close() } catch { /* the host may already be unusable */ }
  writeFileSync(outputPath, JSON.stringify(observation), { mode: 0o600 })
  process.exit(1)
}
