import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ContextManifest } from "./context"
import { runDiscoveryAndVerification, type DiscoveryWorker } from "./discovery"
import type { RuntimeResult } from "./runtime/contracts"

const sha = "a".repeat(40)
const candidate = {
  id: "C-1",
  changeLocation: { side: "head", path: "src/OrderService.java", startLine: 2, endLine: 2, excerpt: "return null;" },
  trigger: "The customer has no orders",
  consequence: "The caller fails while iterating the result",
  rootCause: "The service returns null for an empty result",
  citations: [{ side: "head", path: "src/OrderService.java", startLine: 2, endLine: 2, excerpt: "return null;" }],
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-discovery-"))
  const materialDirectory = join(root, "material")
  for (const side of ["head", "merge-base"]) await mkdir(join(materialDirectory, side, "src"), { recursive: true })
  await writeFile(join(materialDirectory, "head/src/OrderService.java"), "class OrderService {\n  return null;\n}\n")
  await writeFile(join(materialDirectory, "merge-base/src/OrderService.java"), "class OrderService {\n  return List.of();\n}\n")
  const context = {
    snapshot: { baseSha: sha, headSha: "b".repeat(40), mergeBaseSha: sha },
    status: "complete",
    limits: { maxChangedFiles: 50, maxPatchBytes: 262144, maxSnapshotBytes: 8388608 },
    files: [
      { side: "head", path: "src/OrderService.java", mode: "100644", oid: sha, bytes: 40, included: true },
      { side: "merge-base", path: "src/OrderService.java", mode: "100644", oid: sha, bytes: 50, included: true },
    ],
    changes: [{ status: "M", newPath: "src/OrderService.java", included: true, patch: "material/patches/0001.patch" }],
    coverage: { includedPaths: ["src/OrderService.java"], omittedPaths: [] },
  } as ContextManifest
  return { root, materialDirectory, context }
}

function runtimeResult(discoveryText: string, verificationText: string): RuntimeResult {
  const phase = (name: string, text: string) => ({ name, status: "complete" as const, text, usage: { kind: "known" as const, inputTokens: 10, outputTokens: 10 } })
  return {
    status: "complete",
    sessions: [phase("discover", discoveryText), phase("verify", verificationText)],
    usage: { kind: "known", inputTokens: 20, outputTokens: 20 },
    readBudget: { consumedBytes: 0, truncated: false, exhausted: false, records: [] },
    cleanup: { hostClosed: true, forced: false },
    checkpointSequence: 1, submission: { kind: "not-submitted" }, requests: { records: [], capped: false }, phaseDeadlines: null,
  }
}

function mockWorker(result: RuntimeResult, inspect?: (prompts: Array<{ name: string; text: string }>) => void): DiscoveryWorker {
  return async (options) => {
    inspect?.(options.prompts)
    return result
  }
}

const options = (context: ContextManifest, materialDirectory: string, root: string, runWorker: DiscoveryWorker) => ({
  context, materialDirectory, runDirectory: root, apiKey: "test-key",
  model: { providerID: "openai", baseURL: "https://models.example.test/v1", modelID: "reviewer" }, runWorker,
})

test("runs two phases and never publishes a candidate rejected by caller protection", async () => {
  const state = await fixture()
  try {
    const result = runtimeResult(JSON.stringify({ candidates: [candidate] }), JSON.stringify({
      verifications: [{ candidateId: "C-1", decision: "reject", reason: "The caller checks for null before iteration", evidence: [candidate.citations[0]] }],
    }))
    let calls = 0
    const runWorker = mockWorker(result, (prompts) => {
      calls++
      expect(prompts.map(({ name }) => name)).toEqual(["discover", "verify"])
      expect(prompts[1]?.text).toContain("{{PREVIOUS_PHASE_OUTPUT}}")
    })
    const output = await runDiscoveryAndVerification(options(state.context, state.materialDirectory, state.root, runWorker))
    expect(calls).toBe(1)
    expect(output.verifications[0]?.decision).toBe("reject")
    expect(output.issues).toEqual([])
    expect(output.runtime.sessions).toHaveLength(2)
  } finally { await rm(state.root, { recursive: true, force: true }) }
})

test("rejects malformed model JSON and incomplete verification coverage", async () => {
  const state = await fixture()
  try {
    const malformed = runtimeResult("not json", JSON.stringify({ verifications: [] }))
    await expect(runDiscoveryAndVerification(options(state.context, state.materialDirectory, state.root, mockWorker(malformed))))
      .rejects.toThrow("discovery output is not valid JSON")

    const missing = runtimeResult(JSON.stringify({ candidates: [candidate] }), JSON.stringify({ verifications: [] }))
    await expect(runDiscoveryAndVerification(options(state.context, state.materialDirectory, state.root, mockWorker(missing))))
      .rejects.toThrow("missing C-1")
  } finally { await rm(state.root, { recursive: true, force: true }) }
})

test("rejects citations that do not match an included snapshot line", async () => {
  const state = await fixture()
  try {
    const invalid = { ...candidate, citations: [{ ...candidate.citations[0], excerpt: "return []" }] }
    const output = runtimeResult(JSON.stringify({ candidates: [invalid] }), JSON.stringify({ verifications: [] }))
    await expect(runDiscoveryAndVerification(options(state.context, state.materialDirectory, state.root, mockWorker(output))))
      .rejects.toThrow("citation excerpt does not match")
  } finally { await rm(state.root, { recursive: true, force: true }) }
})

test("the parent aborts a worker adapter that never settles", async () => {
  const state = await fixture()
  try {
    let workerSignal: AbortSignal | undefined
    const hung: DiscoveryWorker = async (_, signal) => {
      workerSignal = signal
      return new Promise(() => {})
    }
    await expect(runDiscoveryAndVerification({
      ...options(state.context, state.materialDirectory, state.root, hung), timeoutMs: 100,
    })).rejects.toMatchObject({ failure: { code: "discovery-timeout" }, checkpoint: { kind: "none" } })
    expect(workerSignal?.aborted).toBe(true)
  } finally { await rm(state.root, { recursive: true, force: true }) }
})
