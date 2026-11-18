import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { assertCleanSystemConfig, assertSeparateDirectories, validateMaterialDirectory } from "./isolation"
import { defaultReadLimits, modelSchema, runtimeFailure, runtimeResultSchema, workerInputSchema, unknownUsage, type RuntimeResult } from "./contracts"
export { assertCleanSystemConfig } from "./isolation"

export const RUNTIME_TIMEOUT_MS = 300_000
const workerOptionsSchema = workerInputSchema.omit({ configDirectory: true, deadline: true }).extend({
  runDirectory: z.string().min(1), apiKey: z.string().trim().min(1),
  timeoutMs: z.int().min(500).max(RUNTIME_TIMEOUT_MS).default(RUNTIME_TIMEOUT_MS),
  cleanupGraceMs: z.int().min(100).max(10_000).default(10_000),
  deadline: z.int().positive().optional(),
  readLimits: workerInputSchema.shape.readLimits.default(defaultReadLimits),
}).refine((input) => input.cleanupGraceMs < input.timeoutMs, "cleanup grace must fit inside the run budget")
export type WorkerOptions = z.input<typeof workerOptionsSchema>

export function loadModelConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const model = modelSchema.parse({ providerID: env.REVIEW_MODEL_PROVIDER_ID, baseURL: env.REVIEW_MODEL_BASE_URL, modelID: env.REVIEW_MODEL_ID })
  const apiKey = z.string().trim().min(1).parse(env.REVIEW_MODEL_API_KEY)
  return { model, apiKey }
}

export function serializeWorkerInput(options: WorkerOptions, deadline = Date.now() + (options.timeoutMs ?? RUNTIME_TIMEOUT_MS)): string {
  const { runDirectory, timeoutMs: _timeoutMs, cleanupGraceMs: _cleanupGraceMs, apiKey: _apiKey, ...rest } = options
  return JSON.stringify(workerInputSchema.parse({ ...rest, configDirectory: join(runDirectory, "config"), deadline }))
}

export function buildWorkerEnvironment(options: Pick<WorkerOptions, "runDirectory" | "apiKey">): Record<string, string> {
  const directory = options.runDirectory
  return {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    HOME: directory, XDG_CONFIG_HOME: join(directory, "config"), XDG_CACHE_HOME: join(directory, "cache"),
    XDG_DATA_HOME: join(directory, "data"), XDG_STATE_HOME: join(directory, "state"), TMPDIR: join(directory, "tmp"), OPENAI_API_KEY: options.apiKey,
  }
}

async function readResult(path: string): Promise<RuntimeResult | undefined> {
  try {
    if ((await stat(path)).size > 4 * 1024 * 1024) return undefined
    return runtimeResultSchema.parse(JSON.parse(await readFile(path, "utf8")))
  } catch { return undefined }
}

export async function runIsolatedWorker(rawOptions: WorkerOptions): Promise<RuntimeResult> {
  const started = Date.now()
  const options = workerOptionsSchema.parse(rawOptions)
  const deadline = Math.min(started + options.timeoutMs, options.deadline ?? Infinity)
  await assertCleanSystemConfig()
  const materialDirectory = await validateMaterialDirectory(options.materialDirectory)
  const directory = await realpath(options.runDirectory)
  const runtimeDirectory = join(directory, "runtime")
  assertSeparateDirectories(materialDirectory, runtimeDirectory)
  await mkdir(runtimeDirectory, { mode: 0o700 })
  const home = join(runtimeDirectory, "home")
  for (const name of ["config", "cache", "data", "state", "tmp"]) await mkdir(join(home, name), { recursive: true, mode: 0o700 })
  const inputPath = join(runtimeDirectory, "input.json")
  const outputPath = join(runtimeDirectory, "result.json")
  const input = serializeWorkerInput({ ...options, materialDirectory, runDirectory: home }, deadline)
  await writeFile(inputPath, input, { mode: 0o600, flag: "wx" })
  let result: RuntimeResult
  let expired = false
  let forced = false
  let interruptTimer: ReturnType<typeof setTimeout> | undefined
  let hardStop: ReturnType<typeof setTimeout> | undefined
  const stopGroup = (pid: number, signal: NodeJS.Signals) => {
    try { process.kill(-pid, signal) } catch { /* process group already exited */ }
  }
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "worker.ts"), inputPath, outputPath], {
      cwd: materialDirectory, env: buildWorkerEnvironment({ runDirectory: home, apiKey: options.apiKey }),
      stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true,
    })
    await writeFile(join(runtimeDirectory, "process.json"), JSON.stringify({ pid: child.pid, started, deadline }), { mode: 0o600 })
    interruptTimer = setTimeout(() => { expired = true; stopGroup(child.pid, "SIGINT") }, Math.max(0, deadline - options.cleanupGraceMs - Date.now()))
    hardStop = setTimeout(() => { expired = true; forced = true; stopGroup(child.pid, "SIGKILL") }, Math.max(0, deadline - Date.now()))
    await child.exited
    const saved = await readResult(outputPath)
    if (expired) {
      const progress = saved ?? await readResult(`${outputPath}.progress.json`)
      result = { ...(progress ?? runtimeFailure("worker exceeded the run deadline", "timeout", forced)), status: "timeout", error: "worker exceeded the run deadline",
        usage: saved?.usage ?? unknownUsage("worker did not settle usage before the deadline"), cleanup: { hostClosed: saved?.cleanup.hostClosed ?? false, forced } }
    } else result = saved ?? runtimeFailure(`worker exited without a valid result (code ${child.exitCode})`)
    // Clean up any descendants even if a worker exited unexpectedly before closing its host.
    stopGroup(child.pid, "SIGKILL")
  } catch (error) {
    result = runtimeFailure(error instanceof Error ? error.message : String(error))
  } finally {
    if (interruptTimer) clearTimeout(interruptTimer)
    if (hardStop) clearTimeout(hardStop)
    await rm(inputPath, { force: true })
    await rm(home, { recursive: true, force: true })
  }
  const serialized = JSON.stringify(result).replaceAll(options.apiKey, "[REDACTED]")
  await writeFile(outputPath, serialized, { mode: 0o600 })
  return runtimeResultSchema.parse(JSON.parse(serialized))
}
