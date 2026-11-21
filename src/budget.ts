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
  canStartRequest(stage: Stage, minimumMs: number): boolean
  assertRemaining(stage: Stage): void
}

export class BudgetExhaustedError extends Error {
  constructor(message: string, readonly stage: Stage) {
    super(message)
  }
}

export function createBudget(clock: Clock, timeoutMs: number): ExecutionBudget {
  const deadlineEpochMs = clock.monotonicMs() + timeoutMs
  // Subprocess timeouts and epoch deadline arithmetic accept whole milliseconds only, and a real
  // monotonic clock produces fractions, so the boundary value is a bounded integer.
  const remainingMs = () => Math.max(0, Math.floor(deadlineEpochMs - clock.monotonicMs()))
  // Checkpoint 3 narrows these per stage. A stage currently ends at the total deadline, so the
  // per-stage table is one value and the callers below keep their stage arguments.
  const stageDeadline = (_stage: Stage): number => deadlineEpochMs
  return {
    startedAt: clock.wallTime(),
    deadlineEpochMs,
    remainingMs,
    stageDeadline,
    canStartRequest: (stage, minimumMs) => remainingMs() >= Math.max(minimumMs, 1),
    assertRemaining: (stage) => {
      if (remainingMs() <= 0) throw new BudgetExhaustedError(`the execution budget was exhausted before the ${stage} stage`, stage)
    },
  }
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
