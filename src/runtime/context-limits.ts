import { Plugin } from "@opencode/plugin"
import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { z } from "zod"
import type { ReadBudget, ReadLimits, ReadRecord } from "./contracts"
export type { ReadBudget, ReadLimits } from "./contracts"

const tools = new Set(["read", "grep", "glob"])
const toolNameSchema = z.enum(["read", "grep", "glob"])
const inputSchema = z.looseObject({ path: z.string().optional(), pattern: z.string().optional(), offset: z.int().optional(), limit: z.unknown().optional() })
const pageSchema = z.object({ type: z.literal("text-page"), offset: z.int().positive(), next: z.int().positive().optional() })
const marker = "\n[Review output truncated; remaining content was not returned. Continue reading from the first omitted line or narrow the search.]"
const byteLength = (text: string) => Buffer.byteLength(text, "utf8")

export function clampReadLimit(requested: unknown, maxLines: number): number {
  return Math.max(1, Math.min(maxLines, typeof requested === "number" && Number.isFinite(requested) ? Math.floor(requested) : maxLines))
}

export function applyReadBudget(source: string, limits: ReadLimits, budget: ReadBudget): string {
  if (budget.exhausted) return ""
  const remaining = Math.max(0, limits.totalBytes - budget.consumedBytes)
  const cap = Math.min(limits.perToolBytes, remaining)
  let output = source
  if (byteLength(source) > cap) {
    const lineBudget = Math.max(0, cap - byteLength(marker))
    let partial = ""
    let bytes = 0
    for (const line of source.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
      const length = byteLength(line)
      if (bytes + length > lineBudget) break
      partial += line
      bytes += length
    }
    output = cap >= byteLength(marker) ? partial + marker : ""
    budget.truncated = true
    if (remaining <= limits.perToolBytes) budget.exhausted = true
  }
  budget.consumedBytes += byteLength(output)
  if (budget.consumedBytes >= limits.totalBytes) budget.exhausted = true
  return output
}

export function isWithin(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith("../"))
}

export function createContextLimitsPlugin(options: {
  limits: ReadLimits
  budget: ReadBudget
  materialDirectory: string
  onChange: () => void
  onExhausted: () => void
}) {
  const { limits, budget, materialDirectory, onChange, onExhausted } = options
  return Plugin.define({
    id: "review.context-limits",
    async setup(ctx) {
      const before = await ctx.tool.hook("execute.before", (event) => {
        if (!tools.has(event.tool)) return
        const input = inputSchema.parse(event.input)
        const limit = clampReadLimit(input.limit, limits.maxLines)
        event.input = { ...input, limit }
        if (budget.exhausted) {
          budget.records.push({ sessionID: event.sessionID, callID: event.id, tool: toolNameSchema.parse(event.tool),
            path: input.path ?? ".", pattern: input.pattern, offset: input.offset, limit,
            status: "budget-exhausted", returnedBytes: 0, truncated: true, pending: true })
          onChange()
          onExhausted()
          throw new Error("review read budget exhausted")
        }
        const target = resolve(materialDirectory, input.path ?? ".")
        if (!isWithin(materialDirectory, target)) throw new Error("review tools can only read the prepared material directory")
        let realTarget = target
        try { realTarget = realpathSync(target) } catch { /* native tool reports a missing path */ }
        if (!isWithin(materialDirectory, realTarget)) throw new Error("review tools cannot follow a path outside the material directory")
      })
      let after: Awaited<ReturnType<typeof ctx.tool.hook>>
      try {
        after = await ctx.tool.hook("execute.after", (event) => {
          if (!tools.has(event.tool)) return
          const input = inputSchema.parse(event.input)
          const record: ReadRecord = {
            sessionID: event.sessionID, callID: event.id, tool: toolNameSchema.parse(event.tool),
            path: resolve(materialDirectory, input.path ?? "."), pattern: input.pattern, offset: input.offset,
            limit: clampReadLimit(input.limit, limits.maxLines), status: event.status, returnedBytes: 0, truncated: false, pending: false,
          }
          if (event.status === "error") {
            budget.records.push(record)
            onChange()
            return
          }
          const content = event.result.content
          const source = typeof content === "string" ? content : (content ?? []).map((part) => part.type === "text" ? part.text : "[Non-text tool output omitted]").join("\n")
          const output = applyReadBudget(source, limits, budget)
          const clipped = output !== source
          const nativeTruncated = event.result.metadata?.truncated === true || source.includes("... (line truncated to ")
          record.returnedBytes = byteLength(output)
          record.truncated = nativeTruncated || clipped
          record.pending = record.truncated
          budget.truncated ||= record.truncated
          if (record.tool === "read") {
            const page = pageSchema.safeParse(event.result.output)
            const firstLine = page.success ? page.data.offset : input.offset ?? 1
            const lineNumbers = [...output.matchAll(/^(\d+): /gmu)].map((match) => Number(match[1]))
            const lastLine = lineNumbers.at(-1)
            if (record.truncated) record.nextOffset = lastLine === undefined ? firstLine : lastLine + 1
            for (const previous of budget.records) {
              if (!previous.pending || previous.tool !== "read" || previous.path !== record.path || previous.nextOffset === undefined) continue
              if (firstLine > previous.nextOffset || (lastLine !== undefined && lastLine < previous.nextOffset)) continue
              if (record.truncated) previous.nextOffset = record.nextOffset
              else previous.pending = false
            }
          } else if (!record.truncated) {
            for (const previous of budget.records) {
              if (previous.tool === record.tool && previous.path === record.path && previous.pattern === record.pattern) previous.pending = false
            }
          }
          event.result = { content: [{ type: "text", text: output }], metadata: { ...event.result.metadata, truncated: record.truncated } }
          budget.records.push(record)
          onChange()
          if (budget.exhausted) onExhausted()
        })
      } catch (error) {
        await before.dispose()
        throw error
      }
      return async () => {
        await Promise.all([before.dispose(), after.dispose()])
      }
    },
  })
}
