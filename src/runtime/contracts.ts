import { isAbsolute } from "node:path"
import { z } from "zod"

const absolutePath = z.string().min(1).refine(isAbsolute, "expected an absolute path")
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
  deadline: z.int().positive(),
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
const phaseCommon = { name: z.string(), sessionID: z.string().optional(), usage: usageSchema, durationMs: z.int().nonnegative().optional() }
export const phaseResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...phaseCommon, status: z.literal("complete"), text: z.string().min(1).max(256 * 1024) }),
  z.strictObject({ ...phaseCommon, status: z.enum(["failed", "interrupted", "timeout", "read-budget-exhausted"]), error: z.string().min(1) }),
])
const runCommon = {
  sessions: z.array(phaseResultSchema), usage: usageSchema, readBudget: readBudgetSchema,
  cleanup: z.strictObject({ hostClosed: z.boolean(), forced: z.boolean() }),
}
export const runtimeResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...runCommon, status: z.literal("complete") }),
  z.strictObject({ ...runCommon, status: z.enum(["failed", "interrupted", "timeout", "read-budget-exhausted"]), error: z.string().min(1) }),
])

export type ReadLimits = z.infer<typeof readLimitsSchema>
export type ReadRecord = z.infer<typeof readRecordSchema>
export type ReadBudget = z.infer<typeof readBudgetSchema>
export type ModelConfiguration = z.infer<typeof modelSchema>
export type WorkerInput = z.infer<typeof workerInputSchema>
export type PhaseValidation = z.infer<typeof phaseValidationSchema>
export type RuntimeResult = z.infer<typeof runtimeResultSchema>
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

export function runtimeFailure(error: string, status: "failed" | "timeout" | "interrupted" = "failed", forced = false): RuntimeResult {
  return { status, error, sessions: [], usage: unknownUsage("worker usage was not settled"), readBudget: emptyReadBudget(), cleanup: { hostClosed: false, forced } }
}
