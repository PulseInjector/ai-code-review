import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { prepareContext, type ContextManifest, type ReviewInput, type ReviewLimits } from "./context"
import { buildDiscoveryPrompts, DiscoveryFailure, runDiscoveryAndVerification, type DiscoveryVerificationResult, type DiscoveryWorker } from "./discovery"
import type { Candidate, ReviewResult, Verification } from "./contracts"
import type { Failure, PhaseCheckpoint, PrReviewResult } from "./pr-contracts"
import { BudgetExhaustedError, createBudget, systemClock, workerPhaseDeadlines, withinDeadline, writeFilesBefore, type ExecutionBudget } from "./budget"
import type { ProgressEvent, ProgressSink } from "./progress"
import { defaultReadLimits, type PhaseDeadlines, type RuntimeResult } from "./runtime/contracts"
import { loadModelConfiguration, RUNTIME_TIMEOUT_MS } from "./runtime/worker-process"
import { createRunArtifacts, writeRunArtifacts, type RunArtifacts } from "./report"
import { hashProductSources } from "./product-identity"

const packagePath = new URL("../package.json", import.meta.url)

export type ReviewRun = {
  artifacts: RunArtifacts
  discovery?: DiscoveryVerificationResult
  // A terminal runtime failure keeps its typed classification and every validated stage output so
  // the caller can rebuild a checkpoint from finished work instead of an empty failed result.
  failure?: {
    failure: Failure
    runtime: RuntimeResult | undefined
    candidates: Candidate[]
    verifications: Verification[]
    checkpoint: PhaseCheckpoint
  }
  runDirectory: string
}

export type ReviewOptions = {
  runWorker?: DiscoveryWorker
  configuration?: ReturnType<typeof loadModelConfiguration>
  getModelConfiguration?: () => ReturnType<typeof loadModelConfiguration>
  limits?: ReviewLimits
  timeoutMs?: number
  budget?: ExecutionBudget
  runId?: string
  progress?: ProgressSink
  gitEnvironment?: Record<string, string>
  attemptStartedAt?: string
  afterExport?: () => Promise<void>
  finalizeReplay?: (run: ReviewRun, signal: AbortSignal) => Promise<PrReviewResult | ReviewResult>
}

export async function runReview(input: ReviewInput, options: ReviewOptions = {}): Promise<ReviewRun> {
  // A supplied budget owns the deadline, so a timeoutMs alongside it would create two clocks.
  if (options.budget !== undefined && options.timeoutMs !== undefined) {
    throw new Error("timeoutMs cannot be supplied when a budget owns the deadline")
  }
  if (options.configuration !== undefined && options.getModelConfiguration !== undefined) {
    throw new Error("configuration and getModelConfiguration are mutually exclusive")
  }
  // A local call still generates its own budget; a PR call receives the budget the caller started
  // before the first GitHub request.
  const budget = options.budget ?? createBudget(systemClock, z.int().min(500).max(RUNTIME_TIMEOUT_MS).parse(options.timeoutMs ?? RUNTIME_TIMEOUT_MS))
  const started = Date.now()
  const runDirectory = resolve(input.out)
  const runId = options.runId ?? randomUUID()
  const deadline = started + budget.remainingMs()
  const phaseDeadlines: PhaseDeadlines = workerPhaseDeadlines(budget)
  const remainingMs = () => Math.max(0, budget.remainingMs())
  let sequence = 0
  const emit = (event: Omit<ProgressEvent, "runId" | "sequence" | "at" | "remainingMs">): void => {
    if (options.progress === undefined) return
    options.progress({ runId, sequence: sequence++, at: new Date().toISOString(), remainingMs: remainingMs(), ...event })
  }
  const includedChanges = (context: ContextManifest) => context.changes.filter(({ included }) => included).length
  // Program evidence is staged before any model work, so the final write reserve never has to
  // carry hashing or package reads alongside the artifact writes.
  const prepared = await withinDeadline((signal) => Promise.all([readFile(packagePath, { encoding: "utf8", signal }), hashProductSources(signal)]), phaseDeadlines.prepareInitEpochMs)
  if (prepared.kind === "timed-out") throw new BudgetExhaustedError("review exceeded the run deadline during preparation", "prepare-init")
  const [pkg, programVersion] = prepared.value
  const pkgJson = z.object({ dependencies: z.object({ "@opencode/sdk": z.string() }) }).parse(JSON.parse(pkg))
  emit({ phase: "preparation", event: "start", changedFilesIncluded: null, changedFilesTotal: null, candidatesDiscovered: null, candidatesVerified: null, runUrl: null })
  // Export Git children run against the preparation cap, not the total deadline: capture-side
  // work shares the prepare-init stage with SDK initialization.
  const exported = await withinDeadline((signal) => prepareContext(
    { ...input, out: runDirectory },
    options.limits,
    phaseDeadlines.prepareInitEpochMs,
    { gitEnvironment: options.gitEnvironment, signal },
  ), phaseDeadlines.prepareInitEpochMs)
  if (exported.kind === "timed-out") throw new BudgetExhaustedError("review exceeded the run deadline during preparation", "prepare-init")
  const context = exported.value
  if (options.afterExport !== undefined) await options.afterExport()
  emit({ phase: "preparation", event: "end", changedFilesIncluded: includedChanges(context), changedFilesTotal: context.changes.length, candidatesDiscovered: null, candidatesVerified: null, runUrl: null })
  const preparationMs = Date.now() - started
  let configuration = options.configuration
  let discovery: DiscoveryVerificationResult | undefined
  let runtime: RuntimeResult | undefined
  let candidates: Candidate[] = []
  let failureData: ReviewRun["failure"] | undefined
  let promptVersions: DiscoveryVerificationResult["versions"] | undefined
  let error: { stage: "preparation" | "discovery" | "verification"; message: string } | undefined
  const analysisStarted = Date.now()
  emit({ phase: "discovery", event: "start", changedFilesIncluded: includedChanges(context), changedFilesTotal: context.changes.length, candidatesDiscovered: null, candidatesVerified: null, runUrl: null })
  // Preparation, initialization, and every capture-side step before this point share the
  // prepare-init cap; a preparation that already spent it never starts a model session.
  if (!budget.canStartRequest("prepare-init", 1)) {
    error = { stage: "preparation", message: "the prepare-init stage exceeded its deadline before model work could start" }
  } else {
    try {
      const prepared = await withinDeadline((signal) => buildDiscoveryPrompts(context, resolve(runDirectory, "material"), signal), phaseDeadlines.prepareInitEpochMs)
      if (prepared.kind === "timed-out") throw new BudgetExhaustedError("prompt preparation exceeded its deadline", "prepare-init")
      const prompts = prepared.value
      promptVersions = prompts.versions
      if (!await writeFilesBefore([[join(runDirectory, "prompts.json"), `${JSON.stringify({ discover: prompts.discover, verify: prompts.verify }, null, 2)}\n`]], phaseDeadlines.prepareInitEpochMs)) {
        throw new BudgetExhaustedError("prompt preparation exceeded its deadline", "prepare-init")
      }
      // The PR path supplies the lazy getter so a no-change or all-omitted review preserves the
      // zero-request behavior without requiring model credentials.
      if (context.changes.some(({ included }) => included)) {
        configuration ??= options.getModelConfiguration !== undefined ? options.getModelConfiguration() : loadModelConfiguration()
      }
      if (context.changes.some(({ included }) => included)) discovery = await runDiscoveryAndVerification({
        context,
        materialDirectory: resolve(runDirectory, "material"),
        runDirectory,
        timeoutMs: Math.min(RUNTIME_TIMEOUT_MS, Math.max(500, budget.remainingMs())),
        phaseDeadlines,
        runWorker: options.runWorker,
        preparedPrompts: prompts,
        ...configuration,
      })
    } catch (cause) {
      if (cause instanceof DiscoveryFailure) {
        runtime = cause.runtime
        candidates = cause.candidates
        failureData = { failure: cause.failure, runtime: cause.runtime, candidates: cause.candidates, verifications: cause.verifications, checkpoint: cause.checkpoint }
      }
      error = { stage: cause instanceof DiscoveryFailure ? cause.stage : cause instanceof BudgetExhaustedError ? "preparation" : "discovery", message: cause instanceof Error ? cause.message : String(cause) }
    }
  }
  const analysisMs = Date.now() - analysisStarted
  emit({
    phase: "verification",
    event: error === undefined ? "end" : "failure",
    changedFilesIncluded: includedChanges(context),
    changedFilesTotal: context.changes.length,
    candidatesDiscovered: discovery !== undefined ? discovery.candidates.length : (error === undefined ? null : candidates.length),
    candidatesVerified: discovery !== undefined ? discovery.verifications.length : (failureData?.verifications.length ?? null),
    runUrl: null,
  })
  const runConfig = {
    limits: context.limits, model: configuration?.model ?? null,
    budgetMs: deadline - started, readLimits: defaultReadLimits, maxStepsPerSession: 12, maxCandidates: 8, maxPublishedIssues: 5,
  }
  const artifacts = createRunArtifacts({
      context,
      ...(discovery ? { discovery } : {}),
      runtime, candidates, promptVersions,
      runId,
      durationMs: Date.now() - started,
      ...(error ? { error } : {}),
      programVersion,
      sdkVersion: pkgJson.dependencies["@opencode/sdk"],
      configHash: createHash("sha256").update(JSON.stringify(runConfig)).digest("hex"),
    })
  const run: ReviewRun = { artifacts, discovery, failure: failureData, runDirectory }
  const finalizeReplay = options.finalizeReplay
  let result: ReviewResult | PrReviewResult = artifacts.result
  if (finalizeReplay) {
    const finalized = await withinDeadline((signal) => finalizeReplay(run, signal), phaseDeadlines.finalEpochMs)
    if (finalized.kind === "timed-out") throw new BudgetExhaustedError("replay assembly exceeded the final deadline", "cleanup")
    result = finalized.value
  }
  const written = await writeRunArtifacts(runDirectory, result, {
      discovery, runtime, candidates,
      // A terminal failure retains its validated verification evidence, so the replay surface and
      // the PR envelope preserve the same completed work.
      ...(failureData?.verifications.length ? { verifications: failureData.verifications } : {}),
      timing: {
        startedAt: new Date(started).toISOString(),
        deadline: new Date(deadline).toISOString(),
        preparationMs,
        analysisMs,
        ...(options.attemptStartedAt !== undefined ? { attemptStartedAt: options.attemptStartedAt } : {}),
      },
      finalDeadline: phaseDeadlines.finalEpochMs,
      files: [
        ["configuration.json", `${JSON.stringify(runConfig, null, 2)}\n`],
        ["input.json", `${JSON.stringify({ repo: resolve(input.repo), snapshot: context.snapshot, runId }, null, 2)}\n`],
      ],
    })
  if (!written) throw new BudgetExhaustedError("the final artifact writes exceeded the run deadline", "cleanup")
  return run
}
