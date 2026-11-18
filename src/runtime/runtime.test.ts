import { describe, expect, test } from "bun:test"
import { applyReadBudget, clampReadLimit } from "./context-limits"
import { emptyReadBudget, defaultReadLimits, workerInputSchema } from "./contracts"
import { completedTurn, listMessages, readOnlyPermissions, resolvePhasePrompt, type RuntimeHost } from "./opencode-v227"
import { buildWorkerEnvironment, loadModelConfiguration, serializeWorkerInput, type WorkerOptions } from "./worker-process"
import type { SessionMessageInfo } from "@opencode/client"

const config: WorkerOptions = {
  model: { providerID: "local-model", baseURL: "http://127.0.0.1:8080/v1", modelID: "model-a" },
  apiKey: "secret-sentinel", runDirectory: "/tmp/review-runtime", materialDirectory: "/tmp/review-material", timeoutMs: 300_000,
  readLimits: defaultReadLimits, prompts: [{ name: "discover", text: "Review this snapshot" }, { name: "verify", text: "Check each candidate" }],
}
const user: SessionMessageInfo = { id: "input", type: "user", text: "prompt", time: { created: 1 } }
const idle: SessionMessageInfo = { id: "done", type: "idle", outcome: "succeeded", time: { created: 3 } }
const assistant: SessionMessageInfo = { id: "assistant", type: "assistant", model: { providerID: "local", id: "test" }, agent: "build", time: { created: 2 }, content: [{ type: "text", text: "OK" }] }

describe("controlled model runtime", () => {
  test("clamps tool limits and keeps zero and nonnumeric inputs bounded", () => {
    const cases: Array<[unknown, number]> = [[undefined, 100], [0, 1], [18.9, 18], [500, 100], [NaN, 100], [-5, 1]]
    for (const [input, expected] of cases) expect(clampReadLimit(input, 100)).toBe(expected)
  })
  test("limits UTF-8 output by whole lines and includes a truncation marker", () => {
    const budget = emptyReadBudget()
    const limits = { perToolBytes: 256, totalBytes: 512, maxLines: 100 }
    const output = applyReadBudget(`header\n${"界".repeat(100)}\nsecond line\n`, limits, budget)
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(256)
    expect(output).toContain("Review output truncated")
    expect(output).not.toContain("界")
    expect(budget.truncated).toBe(true)
    expect(budget.consumedBytes).toBe(Buffer.byteLength(output))
  })
  test("reserves the remaining aggregate budget for markers and never exceeds the cap", () => {
    const budget = emptyReadBudget()
    const limits = { perToolBytes: 256, totalBytes: 512, maxLines: 100 }
    const outputs = [applyReadBudget("a".repeat(240), limits, budget), applyReadBudget("b".repeat(240), limits, budget), applyReadBudget("界".repeat(100), limits, budget)]
    expect(outputs.reduce((total, text) => total + Buffer.byteLength(text), 0)).toBeLessThanOrEqual(512)
    expect(budget.exhausted).toBe(true)
    expect(applyReadBudget("more", limits, budget)).toBe("")
  })
  test("a normal read does not imply missing coverage", () => {
    const budget = emptyReadBudget()
    expect(applyReadBudget("all code\n", defaultReadLimits, budget)).toBe("all code\n")
    expect(budget.truncated).toBe(false)
  })
  test("keeps credentials and unrelated environment outside the worker input", () => {
    const input = serializeWorkerInput(config)
    expect(input).not.toContain(config.apiKey)
    expect(workerInputSchema.parse(JSON.parse(input)).prompts).toHaveLength(2)
    const env = buildWorkerEnvironment(config)
    expect(env.OPENAI_API_KEY).toBe(config.apiKey)
    expect(Object.keys(env).sort()).toEqual(["HOME", "OPENAI_API_KEY", "PATH", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"])
  })
  test("accepts the existing four-field provider configuration and rejects credentials in endpoint URLs", () => {
    expect(loadModelConfiguration({ REVIEW_MODEL_PROVIDER_ID: "axonhub", REVIEW_MODEL_BASE_URL: "https://example.com/v1", REVIEW_MODEL_ID: "vendor/model", REVIEW_MODEL_API_KEY: "key" }).model.providerID).toBe("axonhub")
    expect(() => loadModelConfiguration({})).toThrow()
    expect(() => loadModelConfiguration({ REVIEW_MODEL_PROVIDER_ID: "local", REVIEW_MODEL_BASE_URL: "https://user:password@example.com", REVIEW_MODEL_ID: "model", REVIEW_MODEL_API_KEY: "key" })).toThrow()
  })
  test("explicitly denies external-directory access and all tools except read, grep, and glob", () => {
    const permissions = readOnlyPermissions()
    expect(permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
    expect(permissions.filter((rule) => rule.effect === "allow").map((rule) => rule.action)).toEqual(["read", "grep", "glob"])
    expect(permissions.at(-1)).toEqual({ action: "external_directory", resource: "*", effect: "deny" })
  })
  test("ignores idle before this prompt and requires a terminal message after its exact ID", () => {
    expect(completedTurn([idle, user, assistant], "input")).toBeUndefined()
    expect(completedTurn([user, assistant, idle], "other-input")).toBeUndefined()
    expect(completedTurn([idle, user, assistant, idle], "input")?.last).toEqual(assistant)
  })
  test("pages all messages and does not combine cursor with order", async () => {
    const calls: unknown[] = []
    const host: Pick<RuntimeHost, "message"> = { message: { list: async (input) => {
      calls.push(input)
      return input.cursor ? { data: [assistant, idle], cursor: {} } : { data: [user], cursor: { next: "page-2" } }
    } } }
    const messages = await listMessages(host, "session")
    expect(messages).toEqual([user, assistant, idle])
    expect(calls).toEqual([{ sessionID: "session", order: "asc" }, { sessionID: "session", cursor: "page-2" }])
    expect(completedTurn(messages, "input")?.idle.outcome).toBe("succeeded")
  })

  test("injects only the preceding phase output into a dependent prompt", () => {
    const prompt = "Verify this result: {{PREVIOUS_PHASE_OUTPUT}}"
    expect(resolvePhasePrompt(prompt, '{"candidates":[]}')).toBe('Verify this result: {"candidates":[]}')
    const literal = '{"rootCause":"$& $` $\u0027 {{PREVIOUS_PHASE_OUTPUT}}"}'
    expect(resolvePhasePrompt(`${prompt}\nPath: {{PREVIOUS_PHASE_OUTPUT}}`, literal)).toBe(`Verify this result: ${literal}\nPath: {{PREVIOUS_PHASE_OUTPUT}}`)
    expect(() => resolvePhasePrompt(prompt)).toThrow("preceding phase")
    expect(resolvePhasePrompt("Independent prompt")).toBe("Independent prompt")
  })
})
