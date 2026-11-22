import { isAbsolute } from "node:path"
import { z } from "zod"
import { digestSchema, instantSchema } from "../identity"
import { failureCodeSchema } from "../pr-contracts"

const absolutePath = z.string().min(1).refine(isAbsolute, "expected an absolute path")
// The parent and the worker share one absolute phase plan on wall-clock epochs, so the worker's
// request admission and the parent's interrupt timers agree on the same instants. Discovery has
// no deadline until it starts; the worker records the start and echoes the concrete value back
// through its progress record.
export const phaseDeadlinesSchema = z.strictObject({
  prepareInitEpochMs: z.int().positive(),
  discoveryEpochMs: z.int().positive().nullable(),
  analysisStopEpochMs: z.int().positive(),
  workerKillEpochMs: z.int().positive(),
  finalEpochMs: z.int().positive(),
}).refine((deadlines) =>
  deadlines.prepareInitEpochMs <= deadlines.analysisStopEpochMs &&
  deadlines.analysisStopEpochMs <= deadlines.workerKillEpochMs &&
  deadlines.workerKillEpochMs < deadlines.finalEpochMs,
"phase deadlines must be ordered preparation, analysis stop, worker kill, and final")
export type PhaseDeadlines = z.infer<typeof phaseDeadlinesSchema>
export type PhaseKind = "initialization" | "discovery" | "verification"
export const submissionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("not-submitted") }),
  z.strictObject({
    kind: z.literal("submitting"),
    sessionId: z.string().min(1).max(256),
    baselineUserIds: z.array(z.string().min(1)),
    promptDigest: digestSchema,
    submittedAt: instantSchema,
  }),
  z.strictObject({
    kind: z.literal("accepted"),
    sessionId: z.string().min(1).max(256),
    userMessageId: z.string().min(1),
    promptDigest: digestSchema,
  }),
  z.strictObject({
    kind: z.literal("acceptance-unknown"),
    sessionId: z.string().min(1).max(256),
    promptDigest: digestSchema,
  }),
])
export type Submission = z.infer<typeof submissionSchema>
export const requestRecordSchema = z.strictObject({
  sequence: z.int().positive(),
  phase: z.enum(["initialization", "discovery", "verification"]),
  sessionId: z.string().min(1).max(256),
  kind: z.enum(["primary", "compaction", "title", "generate"]),
  attempt: z.int().min(1).max(3),
  startedAt: instantSchema,
  finishedAt: instantSchema.nullable(),
  status: z.int().min(100).max(599).nullable(),
  outcome: z.enum(["started", "response", "transport-error", "unknown"]),
})
export const REQUEST_LEDGER_CAP = 256
export const requestLedgerSchema = z.strictObject({
  records: z.array(requestRecordSchema).max(REQUEST_LEDGER_CAP),
  capped: z.boolean(),
})
export type RequestRecord = z.infer<typeof requestRecordSchema>
export type RequestLedger = z.infer<typeof requestLedgerSchema>
export const emptyRequestLedger = (): RequestLedger => ({ records: [], capped: false })
export const readLimitsSchema = z.strictObject({
  perToolBytes: z.int().min(256).max(32 * 1024).default(32 * 1024),
  totalBytes: z.int().min(256).max(512 * 1024).default(512 * 1024),
  maxLines: z.int().min(1).max(100).default(100),
})
export const modelSchema = z.strictObject({
  providerID: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u),
  baseURL: z.url().refine((value) => {
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  }, "expected an HTTP(S) endpoint without credentials, query, or fragment"),
  modelID: z.string().trim().min(1).max(256),
})
export const promptSchema = z.strictObject({ name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u), text: z.string().min(1).max(256 * 1024) })
export const phaseValidationSchema = z.strictObject({
  changedHeadPaths: z.array(z.string().min(1)),
  includedFiles: z.array(z.strictObject({ side: z.enum(["merge-base", "head"]), path: z.string().min(1) })),
})
export const workerInputSchema = z.strictObject({
  model: modelSchema,
  materialDirectory: absolutePath,
  configDirectory: absolutePath,
  phaseDeadlines: phaseDeadlinesSchema,
  readLimits: readLimitsSchema,
  prompts: z.array(promptSchema).min(1).max(2),
  phaseValidation: phaseValidationSchema.optional(),
})
export const usageSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("known"), inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative() }),
  z.strictObject({ kind: z.literal("unknown"), reason: z.string().min(1) }),
])
export const readRecordSchema = z.strictObject({
  sessionID: z.string(), callID: z.string(), tool: z.enum(["read", "grep", "glob"]),
  path: z.string(), pattern: z.string().optional(), offset: z.int().optional(), limit: z.int().positive(),
  status: z.enum(["completed", "error", "budget-exhausted"]), returnedBytes: z.int().nonnegative(),
  truncated: z.boolean(), pending: z.boolean(), nextOffset: z.int().positive().optional(),
})
export const readBudgetSchema = z.strictObject({
  consumedBytes: z.int().nonnegative(), truncated: z.boolean(), exhausted: z.boolean(),
  records: z.array(readRecordSchema),
})
export const outputSubmissionTraceSchema = z.strictObject({
  records: z.array(z.strictObject({
    callID: z.string().max(256), tool: z.string().max(256),
    status: z.enum(["accepted", "rejected", "incomplete"]),
    rawText: z.string().max(8 * 1024), error: z.string().max(2_000).optional(), truncated: z.boolean(),
  })).max(24),
  omitted: z.int().nonnegative(),
})
export type OutputSubmissionTrace = z.infer<typeof outputSubmissionTraceSchema>
const phaseCommon = {
  name: z.string(), sessionID: z.string().optional(), usage: usageSchema, durationMs: z.int().nonnegative().optional(),
  outputSubmissions: outputSubmissionTraceSchema.optional(),
}
export const phaseResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...phaseCommon, status: z.literal("complete"), text: z.string().min(1).max(256 * 1024) }),
  // The typed code is the authoritative terminal classification. The parent never pattern-matches
  // a runtime failure out of its message when this field is present.
  z.strictObject({
    ...phaseCommon,
    status: z.enum(["failed", "interrupted", "timeout", "read-budget-exhausted"]),
    error: z.string().min(1),
    code: failureCodeSchema,
    rawText: z.string().max(256 * 1024).optional(),
  }),
])
const runCommon = {
  sessions: z.array(phaseResultSchema), usage: usageSchema, readBudget: readBudgetSchema,
  // A close failure is recorded beside the primary terminal outcome instead of replacing it, so
  // an outright model failure keeps its own code and a clean run keeps its settled usage.
  cleanup: z.strictObject({ hostClosed: z.boolean(), forced: z.boolean(), closeFailure: z.string().min(1).max(2_000).optional() }),
  // The progress record is one atomic file, so a monotonically increasing sequence inside each
  // written value lets the parent prove which complete record is the latest.
  checkpointSequence: z.int().nonnegative(),
  submission: submissionSchema,
  requests: requestLedgerSchema,
  // The progress record always echoes the concrete phase deadlines, including the discovery
  // deadline once discovery starts. A fallback result built before the worker reported anything
  // carries null rather than inventing deadlines.
  phaseDeadlines: phaseDeadlinesSchema.nullable(),
}
export const runtimeResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...runCommon, status: z.literal("complete") }),
  z.strictObject({
    ...runCommon,
    status: z.enum(["failed", "interrupted", "timeout", "read-budget-exhausted"]),
    error: z.string().min(1),
    code: failureCodeSchema,
  }),
])
export const workerProgressSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("running"), record: z.strictObject(runCommon) }),
  z.strictObject({ kind: z.literal("terminal"), record: runtimeResultSchema }),
])

export type ReadLimits = z.infer<typeof readLimitsSchema>
export type ReadRecord = z.infer<typeof readRecordSchema>
export type ReadBudget = z.infer<typeof readBudgetSchema>
export type ModelConfiguration = z.infer<typeof modelSchema>
export type WorkerInput = z.infer<typeof workerInputSchema>
export type PhaseValidation = z.infer<typeof phaseValidationSchema>
export type RuntimeResult = z.infer<typeof runtimeResultSchema>
export type WorkerProgress = z.infer<typeof workerProgressSchema>
export type PhaseResult = z.infer<typeof phaseResultSchema>
export type Usage = z.infer<typeof usageSchema>
export const defaultReadLimits: ReadLimits = readLimitsSchema.parse({})
export const emptyReadBudget = (): ReadBudget => ({ consumedBytes: 0, truncated: false, exhausted: false, records: [] })
export const unknownUsage = (reason: string): Usage => ({ kind: "unknown", reason })

export function sumUsage(sessions: PhaseResult[]): Usage {
  let inputTokens = 0
  let outputTokens = 0
  for (const session of sessions) {
    if (session.usage.kind === "unknown") return session.usage
    inputTokens += session.usage.inputTokens
    outputTokens += session.usage.outputTokens
  }
  return { kind: "known", inputTokens, outputTokens }
}

export function runtimeFailure(
  error: string,
  status: "failed" | "timeout" | "interrupted" = "failed",
  forced = false,
  code: z.infer<typeof failureCodeSchema> = "runtime-init",
): RuntimeResult {
  return {
    status, error, code, sessions: [], usage: unknownUsage("worker usage was not settled"),
    readBudget: emptyReadBudget(), cleanup: { hostClosed: false, forced },
    checkpointSequence: 0, submission: { kind: "not-submitted" }, requests: emptyRequestLedger(), phaseDeadlines: null,
  }
}
