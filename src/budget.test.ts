import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BudgetExhaustedError, createBudget, discoveryPhaseDeadline, workerPhaseDeadlines,
  withinDeadline, type Clock,
} from "./budget"
import { runReview } from "./review"
import type { DiscoveryWorker } from "./discovery"
import { emptyReadBudget, type PhaseDeadlines, type RuntimeResult } from "./runtime/contracts"
import type { ProgressEvent } from "./progress"
import type { Failure } from "./pr-contracts"

type ManualClock = Clock & { advance: (ms: number) => void }
function manualClock(): ManualClock {
  let now = 0
  return {
    monotonicMs: () => now,
    wallTime: () => "2026-11-21T00:00:00.000Z",
    sleep: async () => {},
    advance: (ms: number) => { now += ms },
  }
}

describe("phase-cap plan", () => {
  test("a 300-second budget fixes the absolute phase caps", () => {
    const clock = manualClock()
    const budget = createBudget(clock, 300_000)
    expect(budget.stageDeadline("prepare-init")).toBe(60_000)
    expect(budget.stageDeadline("discovery")).toBe(180_000)
    expect(budget.stageDeadline("verification")).toBe(290_000)
    expect(budget.stageDeadline("cleanup")).toBe(300_000)
    expect(budget.stageDeadline("publish")).toBe(300_000)
  })

  test("preparation requests stop at the 60-second cap on its exact boundary", () => {
    const clock = manualClock()
    const budget = createBudget(clock, 300_000)
    clock.advance(59_999)
    expect(budget.canStartRequest("prepare-init", 1)).toBe(true)
    budget.assertRemaining("prepare-init")
    clock.advance(1)
    expect(budget.canStartRequest("prepare-init", 1)).toBe(false)
    expect(() => budget.assertRemaining("prepare-init")).toThrow(BudgetExhaustedError)
    // Later stages keep their own admission inside the same budget.
    expect(budget.canStartRequest("verification", 2_000)).toBe(true)
  })

  test("discovery ends at the earliest of its own window and the analysis stop", () => {
    const deadlines = workerPhaseDeadlines(createBudget(manualClock(), 300_000))
    expect(deadlines.discoveryEpochMs).toBeNull()
    const earlyStart = deadlines.prepareInitEpochMs - 30_000
    expect(discoveryPhaseDeadline(earlyStart, deadlines)).toBe(earlyStart + 120_000)
    const lateStart = deadlines.analysisStopEpochMs - 10_000
    expect(discoveryPhaseDeadline(lateStart, deadlines)).toBe(deadlines.analysisStopEpochMs)
  })

  test("a model request needs two seconds of analysis time at the verification boundary", () => {
    const clock = manualClock()
    const budget = createBudget(clock, 300_000)
    clock.advance(288_000)
    expect(budget.canStartRequest("verification", 2_000)).toBe(true)
    clock.advance(1)
    expect(budget.canStartRequest("verification", 2_000)).toBe(false)
    // A one-millisecond minimum still admits at 289,999 and stops at exactly 290,000.
    clock.advance(289_999 - 288_001)
    expect(budget.canStartRequest("verification", 1)).toBe(true)
    clock.advance(1)
    expect(budget.canStartRequest("verification", 1)).toBe(false)
    expect(() => budget.assertRemaining("verification")).toThrow(BudgetExhaustedError)
  })

  test("the worker kill and final write boundaries reserve the closing window", () => {
    const clock = manualClock()
    const budget = createBudget(clock, 300_000)
    const deadlines = workerPhaseDeadlines(budget)
    const t0 = deadlines.finalEpochMs - 300_000
    expect(deadlines.analysisStopEpochMs - t0).toBe(290_000)
    expect(deadlines.workerKillEpochMs - t0).toBe(298_000)
    expect(deadlines.finalEpochMs - t0).toBe(300_000)
    // The last two seconds belong to the parent: a cleanup request is still admitted at
    // 299,999 and the budget is spent at exactly 300,000.
    clock.advance(299_999)
    expect(budget.canStartRequest("cleanup", 1)).toBe(true)
    clock.advance(1)
    expect(budget.canStartRequest("cleanup", 1)).toBe(false)
    expect(() => budget.assertRemaining("cleanup")).toThrow(BudgetExhaustedError)
  })

  test("the discovery planning bound never exceeds the analysis stop", () => {
    const clock = manualClock()
    const budget = createBudget(clock, 100_000)
    // A short total still orders the stages: the analysis stop keeps ten seconds, and the
    // prepare-init cap shrinks to the earlier of its own limit and that stop.
    expect(budget.stageDeadline("verification")).toBe(90_000)
    expect(budget.stageDeadline("discovery")).toBe(90_000)
    expect(budget.stageDeadline("prepare-init")).toBe(60_000)
  })
})

describe("the boundary matrix drives orchestration", () => {
  let root: string
  let repo: string
  let baseSha: string
  let headSha: string

  const git = (args: string[]): string => {
    const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
    return new TextDecoder().decode(result.stdout).trim()
  }

  const candidate = {
    id: "C-1",
    changeLocation: { side: "head", path: "src/Service.java", startLine: 3, endLine: 3, excerpt: "    return List.of();" },
    trigger: "The caller has no orders",
    consequence: "The caller iterates a nullable result",
    rootCause: "The service returned null before this change",
    citations: [{ side: "head", path: "src/Service.java", startLine: 3, endLine: 3, excerpt: "    return List.of();" }],
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "review-boundary-"))
    repo = join(root, "repo")
    await mkdir(join(repo, "src"), { recursive: true })
    git(["init", "--quiet", "--initial-branch=main", repo])
    await writeFile(join(repo, "src/Service.java"), "class Service {\n  List<String> orders() {\n    return null;\n  }\n}\n")
    git(["-C", repo, "add", "-A"])
    git(["-C", repo, "-c", "user.name=Boundary Test", "-c", "user.email=boundary@example.invalid", "commit", "--quiet", "-m", "base"])
    baseSha = git(["-C", repo, "rev-parse", "HEAD"])
    await writeFile(join(repo, "src/Service.java"), "class Service {\n  List<String> orders() {\n    return List.of();\n  }\n}\n")
    git(["-C", repo, "add", "-A"])
    git(["-C", repo, "-c", "user.name=Boundary Test", "-c", "user.email=boundary@example.invalid", "commit", "--quiet", "-m", "head"])
    headSha = git(["-C", repo, "rev-parse", "HEAD"])
  })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  const discoveryText = JSON.stringify({ candidates: [candidate] })
  const emptyDiscoveryText = JSON.stringify({ candidates: [] })
  const phase = (name: string, status: "complete", text: string) => ({ name, status, text, usage: { kind: "known" as const, inputTokens: 5, outputTokens: 2 }, durationMs: 10 })

  const runtimeWith = (sessions: RuntimeResult["sessions"], failure: { status: "timeout" | "interrupted" | "failed"; code: Failure["code"] } | { status: "complete" }): RuntimeResult => {
    if (failure.status !== "complete") {
      return {
        status: failure.status,
        error: "worker exceeded the analysis deadline",
        code: failure.code,
        sessions,
        usage: { kind: "unknown", reason: "active session usage was not settled" },
        readBudget: emptyReadBudget(),
        cleanup: { hostClosed: true, forced: false },
        checkpointSequence: 1,
        submission: { kind: "not-submitted" },
        requests: { records: [], capped: false },
        phaseDeadlines: null,
      }
    }
    return {
      status: "complete",
      sessions,
      usage: { kind: "known", inputTokens: 10, outputTokens: 4 },
      readBudget: emptyReadBudget(),
      cleanup: { hostClosed: true, forced: false },
      checkpointSequence: 1,
      submission: { kind: "not-submitted" },
      requests: { records: [], capped: false },
      phaseDeadlines: null,
    }
  }

  const configuration = { apiKey: "boundary-key", model: { providerID: "test", baseURL: "https://example.invalid/v1", modelID: "reviewer" } }

  test("a run past the preparation cap stops during preparation without a model session", async () => {
    const clock = manualClock()
    const budget = createBudget(clock, 300_000)
    clock.advance(60_000)
    let workerCalls = 0
    const runWorker: DiscoveryWorker = async () => {
      workerCalls++
      throw new Error("the model must not start past the preparation cap")
    }
    // Export Git children run against the preparation cap, not the total budget: 240,000 ms of
    // total time remain, and the cap still refuses the first Git command.
    let rejected: unknown
    try {
      await runReview(
        { repo, base: baseSha, head: headSha, out: join(root, "boundary-preparation-cap") },
        { budget, configuration, runWorker },
      )
    } catch (error) {
      rejected = error
    }
    expect(workerCalls).toBe(0)
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).message).toContain("review exceeded the run deadline during preparation")
  })

  test("a verification interrupted at the analysis boundary preserves the discovered checkpoint", async () => {
    const clock = manualClock()
    const budget = createBudget(clock, 300_000)
    const events: ProgressEvent[] = []
    let observedDeadlines: PhaseDeadlines | undefined
    const runWorker: DiscoveryWorker = async (options) => {
      observedDeadlines = options.phaseDeadlines
      // Discovery completed inside its window; verification was interrupted at the analysis stop.
      clock.advance(290_000)
      return runtimeWith([phase("discover", "complete", discoveryText)], { status: "timeout", code: "verification-timeout" })
    }
    const run = await runReview(
      { repo, base: baseSha, head: headSha, out: join(root, "boundary-analysis-stop") },
      { budget, configuration, runWorker, progress: (event) => events.push(event) },
    )
    // The worker received the same absolute phase plan the parent's timers use: the analysis stop
    // keeps the ten-second cleanup reserve and the kill epoch keeps the two-second write reserve
    // off one shared final deadline.
    expect(observedDeadlines?.analysisStopEpochMs).toBe(observedDeadlines!.finalEpochMs - 10_000)
    expect(observedDeadlines?.workerKillEpochMs).toBe(observedDeadlines!.finalEpochMs - 2_000)
    expect(observedDeadlines?.prepareInitEpochMs).toBe(observedDeadlines!.finalEpochMs - 240_000)
    expect(run.artifacts.result.status).toBe("failed")
    expect(run.failure?.checkpoint.kind).toBe("discovered")
    expect(run.failure?.failure.code).toBe("verification-timeout")
    // The surviving checkpoint reaches the replay artifacts.
    expect(JSON.parse(await readFile(join(run.runDirectory, "candidates.json"), "utf8"))).toHaveLength(1)
    expect(JSON.parse(await readFile(join(run.runDirectory, "verifications.json"), "utf8"))).toEqual([])
    expect(run.artifacts.result.coverage.unverifiedCandidateIds).toEqual(["C-1"])
    expect(events.at(-1)?.event).toBe("failure")
    expect(events.at(-1)?.remainingMs).toBe(10_000)
  })

  test("a completed run inside the window reports the clock's remaining time and full evidence", async () => {
    const clock = manualClock()
    const budget = createBudget(clock, 300_000)
    const events: ProgressEvent[] = []
    const runWorker: DiscoveryWorker = async () => {
      clock.advance(40_000)
      return runtimeWith([
        phase("discover", "complete", emptyDiscoveryText),
        phase("verify", "complete", JSON.stringify({ verifications: [] })),
      ], { status: "complete" })
    }
    const run = await runReview(
      { repo, base: baseSha, head: headSha, out: join(root, "boundary-complete") },
      { budget, configuration, runWorker, progress: (event) => events.push(event) },
    )
    expect(run.artifacts.result.status).toBe("complete")
    expect(run.artifacts.result.issues).toEqual([])
    expect(events.at(-1)?.event).toBe("end")
    expect(events.at(-1)?.remainingMs).toBe(260_000)
    expect(await readFile(join(run.runDirectory, "result.json"), "utf8")).toContain('"complete"')
  })

})

test("a hung parent operation is aborted on the exact final boundary", async () => {
  let now = 299_999
  let scheduled: (() => void) | undefined
  let currentSignal: AbortSignal | undefined
  const operation = withinDeadline(async (signal) => {
    currentSignal = signal
    return new Promise(() => {})
  }, 300_000, {
    now: () => now,
    schedule: (wait, callback) => {
      expect(wait).toBe(1)
      scheduled = callback
      return () => { scheduled = undefined }
    },
  })
  expect(currentSignal?.aborted).toBe(false)
  now++
  scheduled?.()
  expect(await operation).toEqual({ kind: "timed-out" })
  expect(currentSignal?.aborted).toBe(true)
})
