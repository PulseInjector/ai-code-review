import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { recoverableFailureCodes } from "../pr-contracts"
import { assertCleanSystemConfig, assertSeparateDirectories, validateMaterialDirectory } from "./isolation"
import {
  defaultReadLimits, modelSchema, phaseDeadlinesSchema, runtimeFailure, runtimeResultSchema,
  workerInputSchema, workerProgressSchema, unknownUsage, type PhaseDeadlines, type RuntimeResult, type WorkerProgress,
} from "./contracts"
import { deadlineClock, WORKER_KILL_RESERVE_MS, withinDeadline, writeFilesBefore, type DeadlineClock } from "../budget"
export { assertCleanSystemConfig } from "./isolation"

export const RUNTIME_TIMEOUT_MS = 300_000
const PROGRESS_POLL_MS = 250
const workerOptionsSchema = workerInputSchema.omit({ configDirectory: true, phaseDeadlines: true }).extend({
  runDirectory: z.string().min(1), apiKey: z.string().trim().min(1),
  timeoutMs: z.int().min(500).max(RUNTIME_TIMEOUT_MS).default(RUNTIME_TIMEOUT_MS),
  cleanupGraceMs: z.int().min(100).max(10_000).default(10_000),
  phaseDeadlines: phaseDeadlinesSchema.optional(),
  readLimits: workerInputSchema.shape.readLimits.default(defaultReadLimits),
}).refine((input) => input.cleanupGraceMs < input.timeoutMs, "cleanup grace must fit inside the run budget")
export type WorkerOptions = z.input<typeof workerOptionsSchema>

// The non-secret model identity resolves once at initialization so a zero-request run records
// its configured model without ever loading the credential.
export function loadModelIdentity(env: NodeJS.ProcessEnv = process.env) {
  const model = modelSchema.parse({ providerID: env.REVIEW_MODEL_PROVIDER_ID, baseURL: env.REVIEW_MODEL_BASE_URL, modelID: env.REVIEW_MODEL_ID })
  return { providerId: model.providerID, modelId: model.modelID }
}

export function loadModelConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const model = modelSchema.parse({ providerID: env.REVIEW_MODEL_PROVIDER_ID, baseURL: env.REVIEW_MODEL_BASE_URL, modelID: env.REVIEW_MODEL_ID })
  const apiKey = z.string().trim().min(1).parse(env.REVIEW_MODEL_API_KEY)
  return { model, apiKey }
}

export function serializeWorkerInput(options: WorkerOptions, phaseDeadlines: PhaseDeadlines): string {
  const { runDirectory, timeoutMs: _timeoutMs, cleanupGraceMs: _cleanupGraceMs, apiKey: _apiKey, phaseDeadlines: _supplied, ...rest } = options
  return JSON.stringify(workerInputSchema.parse({ ...rest, configDirectory: join(runDirectory, "config"), phaseDeadlines }))
}

// A caller without a shared budget still gets an ordered plan: the analysis stop keeps the cleanup
// grace, and the worker kill keeps a proportional slice of that grace for the parent's final
// writes, never more than the two-second reserve of the full-budget plan.
function defaultPhaseDeadlines(started: number, timeoutMs: number, cleanupGraceMs: number): PhaseDeadlines {
  const finalEpochMs = started + timeoutMs
  const analysisStopEpochMs = Math.max(started + 1, finalEpochMs - cleanupGraceMs)
  const workerKillEpochMs = Math.min(finalEpochMs - 1, finalEpochMs - Math.min(WORKER_KILL_RESERVE_MS, Math.floor(cleanupGraceMs / 2)))
  return {
    prepareInitEpochMs: Math.min(started + 60_000, analysisStopEpochMs),
    discoveryEpochMs: null,
    analysisStopEpochMs: Math.max(started + 1, analysisStopEpochMs),
    workerKillEpochMs: Math.max(analysisStopEpochMs, workerKillEpochMs),
    finalEpochMs,
  }
}

export function buildWorkerEnvironment(options: Pick<WorkerOptions, "runDirectory" | "apiKey">): Record<string, string> {
  const directory = options.runDirectory
  return {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    HOME: directory, XDG_CONFIG_HOME: join(directory, "config"), XDG_CACHE_HOME: join(directory, "cache"),
    XDG_DATA_HOME: join(directory, "data"), XDG_STATE_HOME: join(directory, "state"), TMPDIR: join(directory, "tmp"), OPENAI_API_KEY: options.apiKey,
  }
}

async function readRecord<T>(path: string, signal: AbortSignal, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    if ((await stat(path)).size > 4 * 1024 * 1024) return undefined
    return schema.parse(JSON.parse(await readFile(path, { encoding: "utf8", signal })))
  } catch { return undefined }
}

const progressSchema = z.union([workerProgressSchema, runtimeResultSchema]).transform((progress): WorkerProgress => {
  if ("kind" in progress) return progress
  // Legacy progress used an interrupted run result as its running placeholder.
  if (progress.status === "interrupted" && progress.code === "run-interrupted") {
    const { status: _status, code: _code, error: _error, ...record } = progress
    return { kind: "running", record }
  }
  return { kind: "terminal", record: progress }
})

const outcomeStrength = (result: RuntimeResult): number =>
  result.status !== "complete" && !recoverableFailureCodes.has(result.code) ? 2 : 1

function strongerOutcome(current: RuntimeResult | undefined, candidate: RuntimeResult): RuntimeResult {
  if (current === undefined || outcomeStrength(candidate) > outcomeStrength(current)) return candidate
  if (outcomeStrength(candidate) === outcomeStrength(current) && candidate.checkpointSequence >= current.checkpointSequence) return candidate
  return current
}

export async function runIsolatedWorker(rawOptions: WorkerOptions, testing?: { clock: DeadlineClock; workerPath: string }): Promise<RuntimeResult> {
  const clock = testing?.clock ?? deadlineClock
  const started = clock.now()
  const options = workerOptionsSchema.parse(rawOptions)
  const deadlines = options.phaseDeadlines ?? defaultPhaseDeadlines(started, options.timeoutMs, options.cleanupGraceMs)
  const at = (deadline: number, fn: () => void) => clock.schedule(Math.max(0, deadline - clock.now()), fn)
  const resolved = await withinDeadline(() => realpath(options.runDirectory), deadlines.prepareInitEpochMs, clock)
  if (resolved.kind === "timed-out") return runtimeFailure("the worker missed its setup deadline", "timeout", false, "runtime-init")
  const runtimeDirectory = join(resolved.value, "runtime")
  const home = join(runtimeDirectory, "home")
  const inputPath = join(runtimeDirectory, "input.json")
  const outputPath = join(runtimeDirectory, "result.json")
  const progressPath = `${outputPath}.progress.json`
  let result: RuntimeResult
  let forced = false
  let analysisElapsed = false
  let child: Bun.Subprocess | undefined
  let latest: WorkerProgress["record"] | undefined
  let terminal: RuntimeResult | undefined
  const retain = ({ kind, record }: WorkerProgress) => {
    if (latest === undefined || record.checkpointSequence >= latest.checkpointSequence) latest = record
    // Older workers could settle a phase and then block in cleanup with only a running record.
    // Check nested phase outcomes as well as the top-level outcome; a fatal must not become partial.
    for (const session of record.sessions) {
      if (session.status !== "complete") {
        const { status, code, error } = session
        terminal = strongerOutcome(terminal, { ...record, status, code, error })
      }
    }
    if (kind === "terminal") terminal = strongerOutcome(terminal, record)
  }
  const timers: Array<() => void> = []
  const stopGroup = (pid: number, signal: NodeJS.Signals) => {
    try { process.kill(-pid, signal) } catch { /* process group already exited */ }
  }
  try {
    const setup = await withinDeadline(async (signal) => {
      await assertCleanSystemConfig()
      const material = await validateMaterialDirectory(options.materialDirectory)
      assertSeparateDirectories(material, runtimeDirectory)
      signal.throwIfAborted()
      await mkdir(runtimeDirectory, { mode: 0o700 })
      for (const name of ["config", "cache", "data", "state", "tmp"]) {
        signal.throwIfAborted()
        await mkdir(join(home, name), { recursive: true, mode: 0o700 })
      }
      signal.throwIfAborted()
      await writeFile(inputPath, serializeWorkerInput({ ...options, materialDirectory: material, runDirectory: home }, deadlines), { mode: 0o600, flag: "wx", signal })
      return material
    }, deadlines.prepareInitEpochMs, clock)
    if (setup.kind === "timed-out") return runtimeFailure("the worker missed its setup deadline", "timeout", false, "runtime-init")
    const materialDirectory = setup.value
    const worker = Bun.spawn([process.execPath, "--no-env-file", testing?.workerPath ?? join(import.meta.dir, "worker.ts"), inputPath, outputPath], {
      cwd: materialDirectory, env: buildWorkerEnvironment({ runDirectory: home, apiKey: options.apiKey }),
      stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true,
    })
    child = worker
    timers.push(at(deadlines.workerKillEpochMs, () => { forced = true; stopGroup(worker.pid, "SIGKILL") }))
    timers.push(at(deadlines.analysisStopEpochMs, () => { analysisElapsed = true; stopGroup(worker.pid, "SIGINT") }))
    const metadata = writeFilesBefore([[join(runtimeDirectory, "process.json"), JSON.stringify({ pid: worker.pid, started, deadlines })]], deadlines.workerKillEpochMs, clock).catch(() => false)
    let discoveryArmed = false
    await withinDeadline(async (signal) => {
      const poll = new AbortController()
      const stopped = AbortSignal.any([signal, poll.signal])
      let cancelPoll = () => {}
      const onStop = () => cancelPoll()
      stopped.addEventListener("abort", onStop, { once: true })
      const observe = async () => {
        const observed = await readRecord(progressPath, stopped, progressSchema)
        if (stopped.aborted) return
        if (observed !== undefined) retain(observed)
        const discovery = observed?.record.phaseDeadlines?.discoveryEpochMs
        if (!discoveryArmed && observed?.kind === "running" && discovery != null && discovery < deadlines.analysisStopEpochMs && !observed.record.sessions.some(({ name }) => name === "discover")) {
          discoveryArmed = true
          timers.push(at(discovery, () => stopGroup(worker.pid, "SIGUSR2")))
        }
        cancelPoll = clock.schedule(PROGRESS_POLL_MS, () => { void observe() })
      }
      cancelPoll = clock.schedule(PROGRESS_POLL_MS, () => { void observe() })
      try { await worker.exited }
      finally { poll.abort() }
    }, deadlines.finalEpochMs, clock)
    await withinDeadline((signal) => Promise.all([
      readRecord(progressPath, signal, progressSchema).then((progress) => { if (progress && !signal.aborted) retain(progress) }),
      readRecord(outputPath, signal, runtimeResultSchema).then((saved) => { if (saved && !signal.aborted) retain({ kind: "terminal", record: saved }) }),
    ]), deadlines.finalEpochMs, clock)
    const best = latest
    const settled = terminal
    if (settled) result = settled
    else if (forced || analysisElapsed) {
      const discoveryPending = best?.phaseDeadlines?.discoveryEpochMs != null && !best.sessions.some(({ name }) => name === "discover")
      const code = discoveryPending ? "discovery-timeout" : "verification-timeout"
      const error = "worker exceeded the analysis deadline"
      result = { ...runtimeFailure(error, "timeout", forced, code), ...best, status: "timeout", error, code }
    } else result = runtimeFailure(`worker exited without a valid result (code ${worker.exitCode})`)
    if (forced) {
      result = {
        ...result,
        usage: unknownUsage("worker did not settle usage before the deadline"),
        cleanup: { ...result.cleanup, ...best?.cleanup, hostClosed: result.cleanup.hostClosed || best?.cleanup.hostClosed === true, forced: true },
      }
    }
    await withinDeadline(() => metadata, deadlines.finalEpochMs, clock)
  } catch (error) {
    result = runtimeFailure(error instanceof Error ? error.message : String(error))
  } finally {
    for (const cancel of timers) cancel()
    if (child) stopGroup(child.pid, "SIGKILL")
    await withinDeadline(() => Promise.all([rm(inputPath, { force: true }), rm(home, { recursive: true, force: true })]), deadlines.finalEpochMs, clock)
  }
  const serialized = JSON.stringify(result).replaceAll(options.apiKey, "[REDACTED]")
  await writeFilesBefore([[outputPath, serialized]], deadlines.finalEpochMs, clock)
  return runtimeResultSchema.parse(JSON.parse(serialized))
}
