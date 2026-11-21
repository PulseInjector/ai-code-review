import { createHash, randomUUID } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { prepareContext, type ContextManifest, type ReviewInput, type ReviewLimits } from "./context"
import { buildDiscoveryPrompts, DiscoveryFailure, runDiscoveryAndVerification, type DiscoveryVerificationResult, type DiscoveryWorker } from "./discovery"
import type { Candidate } from "./contracts"
import type { ExecutionBudget } from "./budget"
import type { ProgressEvent, ProgressSink } from "./progress"
import type { RuntimeResult } from "./runtime/contracts"
import { defaultReadLimits } from "./runtime/contracts"
import { loadModelConfiguration, RUNTIME_TIMEOUT_MS } from "./runtime/worker-process"
import { createRunArtifacts, writeRunArtifacts, type RunArtifacts } from "./report"

const packagePath = new URL("../package.json", import.meta.url)

async function programHash(): Promise<string> {
  const hash = createHash("sha256")
  for (const path of (await readdir(import.meta.dir, { recursive: true })).filter((path) => path.endsWith(".ts")).sort()) {
    hash.update(path).update("\0").update(await readFile(join(import.meta.dir, path))).update("\0")
  }
  return hash.digest("hex")
}

export type ReviewRun = { artifacts: RunArtifacts; discovery?: DiscoveryVerificationResult; runDirectory: string }

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
}

export async function runReview(input: ReviewInput, options: ReviewOptions = {}): Promise<ReviewRun> {
  // A supplied budget owns the deadline, so a timeoutMs alongside it would create two clocks.
  if (options.budget !== undefined && options.timeoutMs !== undefined) {
    throw new Error("timeoutMs cannot be supplied when a budget owns the deadline")
  }
  if (options.configuration !== undefined && options.getModelConfiguration !== undefined) {
    throw new Error("configuration and getModelConfiguration are mutually exclusive")
  }
  const started = Date.now()
  const runDirectory = resolve(input.out)
  const runId = options.runId ?? randomUUID()
  const deadline = options.budget !== undefined
    ? Date.now() + Math.max(0, options.budget.remainingMs())
    : started + z.int().min(500).max(RUNTIME_TIMEOUT_MS).parse(options.timeoutMs ?? RUNTIME_TIMEOUT_MS)
  const remainingMs = () => Math.max(0, options.budget !== undefined ? options.budget.remainingMs() : deadline - Date.now())
  let sequence = 0
  const emit = (event: Omit<ProgressEvent, "runId" | "sequence" | "at" | "remainingMs">): void => {
    if (options.progress === undefined) return
    options.progress({ runId, sequence: sequence++, at: new Date().toISOString(), remainingMs: remainingMs(), ...event })
  }
  const includedChanges = (context: ContextManifest) => context.changes.filter(({ included }) => included).length
  emit({ phase: "preparation", event: "start", changedFilesIncluded: null, changedFilesTotal: null, candidatesDiscovered: null, candidatesVerified: null, runUrl: null })
  const context = await prepareContext(
    { ...input, out: runDirectory },
    options.limits,
    deadline,
    options.gitEnvironment !== undefined ? { gitEnvironment: options.gitEnvironment } : undefined,
  )
  emit({ phase: "preparation", event: "end", changedFilesIncluded: includedChanges(context), changedFilesTotal: context.changes.length, candidatesDiscovered: null, candidatesVerified: null, runUrl: null })
  const preparationMs = Date.now() - started
  let configuration = options.configuration
  let discovery: DiscoveryVerificationResult | undefined
  let runtime: RuntimeResult | undefined
  let candidates: Candidate[] = []
  let promptVersions: DiscoveryVerificationResult["versions"] | undefined
  let error: { stage: "discovery" | "verification"; message: string } | undefined
  const analysisStarted = Date.now()
  emit({ phase: "discovery", event: "start", changedFilesIncluded: includedChanges(context), changedFilesTotal: context.changes.length, candidatesDiscovered: null, candidatesVerified: null, runUrl: null })
  try {
    const prompts = await buildDiscoveryPrompts(context, resolve(runDirectory, "material"))
    promptVersions = prompts.versions
    await writeFile(join(runDirectory, "prompts.json"), `${JSON.stringify({ discover: prompts.discover, verify: prompts.verify }, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    // The PR path supplies the lazy getter so a no-change or all-omitted review preserves the
    // zero-request behavior without requiring model credentials.
    if (context.changes.some(({ included }) => included)) {
      configuration ??= options.getModelConfiguration !== undefined ? options.getModelConfiguration() : loadModelConfiguration()
    }
    if (context.changes.some(({ included }) => included)) discovery = await runDiscoveryAndVerification({
      context,
      materialDirectory: resolve(runDirectory, "material"),
      runDirectory,
      timeoutMs: Math.min(RUNTIME_TIMEOUT_MS, deadline - 1_000 - Date.now()),
      deadline: deadline - 1_000,
      runWorker: options.runWorker,
      preparedPrompts: prompts,
      ...configuration,
    })
  } catch (cause) {
    if (cause instanceof DiscoveryFailure) {
      runtime = cause.runtime
      candidates = cause.candidates
      promptVersions = cause.versions
    }
    error = { stage: cause instanceof DiscoveryFailure ? cause.stage : "discovery", message: cause instanceof Error ? cause.message : String(cause) }
  }
  const analysisMs = Date.now() - analysisStarted
  emit({
    phase: "verification",
    event: error === undefined ? "end" : "failure",
    changedFilesIncluded: includedChanges(context),
    changedFilesTotal: context.changes.length,
    candidatesDiscovered: discovery !== undefined ? discovery.candidates.length : (error === undefined ? null : candidates.length),
    candidatesVerified: discovery !== undefined ? discovery.verifications.length : null,
    runUrl: null,
  })
  const [pkg, programVersion] = await Promise.all([readFile(packagePath, "utf8"), programHash()])
  const pkgJson = z.object({ dependencies: z.object({ "@opencode/sdk": z.string() }) }).parse(JSON.parse(pkg))
  const runConfig = {
    limits: context.limits, model: configuration?.model ?? null,
    budgetMs: deadline - started, readLimits: defaultReadLimits, maxStepsPerSession: 12, maxCandidates: 8, maxPublishedIssues: 5,
  }
  await writeFile(join(runDirectory, "configuration.json"), `${JSON.stringify(runConfig, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  await writeFile(join(runDirectory, "input.json"), `${JSON.stringify({ repo: resolve(input.repo), snapshot: context.snapshot, runId }, null, 2)}\n`, { flag: "wx", mode: 0o600 })
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
  await writeRunArtifacts(runDirectory, artifacts, { discovery, runtime, candidates, timing: {
    startedAt: new Date(started).toISOString(),
    deadline: new Date(deadline).toISOString(),
    preparationMs,
    analysisMs,
    ...(options.attemptStartedAt !== undefined ? { attemptStartedAt: options.attemptStartedAt } : {}),
  } })
  return { artifacts, ...(discovery ? { discovery } : {}), runDirectory }
}
