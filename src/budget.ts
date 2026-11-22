import { randomUUID } from "node:crypto"
import { renameSync } from "node:fs"
import { rm, writeFile } from "node:fs/promises"
import type { PhaseDeadlines } from "./runtime/contracts"

export type Stage = "prepare-init" | "discovery" | "verification" | "cleanup" | "publish"

export type Clock = {
  monotonicMs(): number
  wallTime(): string
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

export type ExecutionBudget = {
  startedAt: string
  deadlineEpochMs: number
  remainingMs(): number
  stageDeadline(stage: Stage): number
  stageRemainingMs(stage: Stage): number
  canStartRequest(stage: Stage, minimumMs: number): boolean
  assertRemaining(stage: Stage): void
}

export class BudgetExhaustedError extends Error {
  constructor(message: string, readonly stage: Stage) {
    super(message)
  }
}

export const PREPARE_INIT_STAGE_MS = 60_000
export const DISCOVERY_STAGE_MS = 120_000
export const ANALYSIS_STOP_RESERVE_MS = 10_000
export const WORKER_KILL_RESERVE_MS = 2_000

export function createBudget(clock: Clock, timeoutMs: number): ExecutionBudget {
  const deadlineEpochMs = clock.monotonicMs() + timeoutMs
  // Subprocess timeouts and epoch deadline arithmetic accept whole milliseconds only, and a real
  // monotonic clock produces fractions, so the boundary value is a bounded integer.
  const remainingMs = () => Math.max(0, Math.floor(deadlineEpochMs - clock.monotonicMs()))
  const analysisStopEpochMs = deadlineEpochMs - ANALYSIS_STOP_RESERVE_MS
  // Preparation and initialization share one cap. Discovery ends at the earliest of its own
  // 120-second window from the preparation cap and the analysis stop; the worker records the real
  // discovery start and reports the concrete deadline, so this unmarked value is only the latest
  // planning bound. Verification ends at the analysis stop, and cleanup owns the final reserve.
  const prepareInitEpochMs = deadlineEpochMs - Math.max(ANALYSIS_STOP_RESERVE_MS, timeoutMs - PREPARE_INIT_STAGE_MS)
  const stageDeadline = (stage: Stage): number => {
    switch (stage) {
      case "prepare-init":
        return prepareInitEpochMs
      case "discovery":
        return Math.min(prepareInitEpochMs + DISCOVERY_STAGE_MS, analysisStopEpochMs)
      case "verification":
        return analysisStopEpochMs
      case "cleanup":
      case "publish":
        return deadlineEpochMs
    }
  }
  const stageRemainingMs = (stage: Stage) => Math.max(0, Math.floor(stageDeadline(stage) - clock.monotonicMs()))
  return {
    startedAt: clock.wallTime(),
    deadlineEpochMs,
    remainingMs,
    stageDeadline,
    stageRemainingMs,
    canStartRequest: (stage, minimumMs) => {
      const minimum = Math.max(minimumMs, 1)
      return stageRemainingMs(stage) >= minimum && remainingMs() >= minimum
    },
    assertRemaining: (stage) => {
      if (stageRemainingMs(stage) <= 0) {
        throw new BudgetExhaustedError(`the execution budget was exhausted before the ${stage} stage deadline`, stage)
      }
    },
  }
}

export type DeadlineClock = {
  now(): number
  schedule(ms: number, callback: () => void): () => void
}

export const deadlineClock: DeadlineClock = {
  now: Date.now,
  schedule: (ms, callback) => {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  },
}

export type DeadlineResult<T> = { kind: "completed"; value: T } | { kind: "timed-out" }

export async function withinDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, deadlineEpochMs: number, clock = deadlineClock): Promise<DeadlineResult<T>> {
  const remaining = deadlineEpochMs - clock.now()
  if (remaining <= 0) return { kind: "timed-out" }
  const controller = new AbortController()
  let cancelTimer = () => {}
  const deadline = new Promise<DeadlineResult<T>>((resolve) => {
    cancelTimer = clock.schedule(remaining, () => {
      resolve({ kind: "timed-out" })
      controller.abort(new Error("the operation exceeded its deadline"))
    })
  })
  try {
    const result = await Promise.race([
      deadline,
      operation(controller.signal).then((value): DeadlineResult<T> => ({ kind: "completed", value })),
    ])
    if (clock.now() >= deadlineEpochMs) {
      controller.abort(new Error("the operation exceeded its deadline"))
      return { kind: "timed-out" }
    }
    return result
  } finally {
    cancelTimer()
  }
}

export async function withinStage<T>(budget: ExecutionBudget, stage: Stage, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const result = await withinDeadline(operation, Date.now() + budget.stageRemainingMs(stage))
  if (result.kind === "timed-out") throw new BudgetExhaustedError(`the ${stage} operation exceeded its deadline`, stage)
  budget.assertRemaining(stage)
  return result.value
}

export async function writeFilesBefore(files: ReadonlyArray<readonly [string, string]>, deadline: number, clock = deadlineClock): Promise<boolean> {
  const staged = files.map(([path, data]) => ({ path, data, temporary: `${path}.${randomUUID()}.tmp` }))
  const written = await withinDeadline(async (signal) => {
    try {
      const writes = await Promise.allSettled(staged.map(({ temporary, data }) => writeFile(temporary, data, { flag: "wx", mode: 0o600, signal })))
      signal.throwIfAborted()
      for (const write of writes) if (write.status === "rejected") throw write.reason
      if (clock.now() >= deadline) return false
      for (const { path, temporary } of staged) renameSync(temporary, path)
      return true
    } finally {
      // A timed-out write may still have created its temporary file; never publish it.
      for (const { temporary } of staged) void rm(temporary, { force: true }).catch(() => undefined)
    }
  }, deadline, clock)
  return written.kind === "completed" && written.value
}

// The budget keeps its own monotonic domain, while the worker's deadlines and the process timers
// run on wall-clock epochs. Both clocks tick at the same rate, so one sampled conversion holds
// for the whole run: every stage deadline lands at the same absolute instant in either domain.
export function workerPhaseDeadlines(budget: ExecutionBudget): PhaseDeadlines {
  const wallNow = Date.now()
  const monoNow = budget.deadlineEpochMs - budget.remainingMs()
  const at = (epochMs: number) => wallNow + Math.max(0, Math.floor(epochMs - monoNow))
  return {
    prepareInitEpochMs: at(budget.stageDeadline("prepare-init")),
    discoveryEpochMs: null,
    analysisStopEpochMs: at(budget.stageDeadline("verification")),
    workerKillEpochMs: wallNow + Math.max(1, budget.remainingMs() - WORKER_KILL_RESERVE_MS),
    finalEpochMs: wallNow + budget.remainingMs(),
  }
}

export function discoveryPhaseDeadline(startEpochMs: number, deadlines: PhaseDeadlines): number {
  return Math.min(startEpochMs + DISCOVERY_STAGE_MS, deadlines.analysisStopEpochMs)
}

export const systemClock: Clock = {
  monotonicMs: () => performance.now(),
  wallTime: () => new Date().toISOString(),
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("the budget sleep was aborted"))
      return
    }
    const abort = () => {
      clearTimeout(timer)
      reject(new Error("the budget sleep was aborted"))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, Math.max(0, ms))
    signal.addEventListener("abort", abort, { once: true })
  }),
}
