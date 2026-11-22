import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { runIsolatedWorker } from "./worker-process"
import { deadlineClock } from "../budget"
import { runtimeFailure, workerProgressSchema, type RuntimeResult } from "./contracts"
import type { CodeReference } from "../contracts"
import { resultToolResponse } from "./test-provider"

function modelResponse(text: string) {
  const chunk = (delta: { content?: string }, finishReason: string | null) => `data: ${JSON.stringify({
    id: "test-turn", object: "chat.completion.chunk", created: 0, model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
  return new Response(chunk({ content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })
}

const workerPath = join(import.meta.dir, "worker.ts")

for (const scenario of ["malformed", "excerpt", "path", "conflict", "duplicate", "wrong-phase", "prose-only", "truncated", "required-choice"] as const) {
  test(`structured review submission handles ${scenario} without weakening evidence validation`, async () => {
    const root = await mkdtemp(join(tmpdir(), "review-submission-case-"))
    const material = join(root, "material")
    const reference = { side: "head", path: "change.txt", startLine: 1, endLine: 1, excerpt: "change" } satisfies CodeReference
    const valid = { candidates: [{ id: "C-1", changeLocation: reference, trigger: "trigger", consequence: "consequence", rootCause: "cause", citations: [reference] }] }
    const json = JSON.stringify(valid)
    const requests: string[] = []
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      requests.push(await request.text())
      const index = requests.length
      const choice = z.object({ tool_choice: z.string().optional() }).parse(JSON.parse(requests.at(-1)!)).tool_choice
      if (scenario === "required-choice" && choice !== "required") return modelResponse("Done")
      if (scenario === "prose-only") return modelResponse(json)
      if (scenario === "wrong-phase" && index === 1) return resultToolResponse("review_submit_verification", '{"verifications":[]}')
      if (scenario === "malformed" && index === 1) return resultToolResponse("review_submit_discovery", json + "]}")
      if ((scenario === "excerpt" || scenario === "path") && index === 1) {
        const bad = { ...reference, ...(scenario === "excerpt" ? { excerpt: "invented" } : { path: "head/change.txt" }) }
        return resultToolResponse("review_submit_discovery", JSON.stringify({ candidates: [{ ...valid.candidates[0], citations: [bad] }] }))
      }
      if (scenario === "truncated" && index === 2) {
        const response = modelResponse("Incomplete acknowledgement")
        return new Response((await response.text()).replace('"finish_reason":"stop"', '"finish_reason":"length"'), { headers: response.headers })
      }
      if (index === 1 || (index === 2 && ["malformed", "excerpt", "path", "duplicate", "conflict"].includes(scenario))) {
        return resultToolResponse("review_submit_discovery", scenario === "conflict" && index === 2 ? '{"candidates":[]}' : json)
      }
      return modelResponse("Done. ]}")
    } })
    try {
      await mkdir(join(material, "head"), { recursive: true })
      await writeFile(join(material, "head/change.txt"), "change\n")
      const result = await runIsolatedWorker({
        runDirectory: root, materialDirectory: material, apiKey: "submission-test-key",
        model: { providerID: "test", modelID: "test-model", baseURL: `http://127.0.0.1:${server.port}/v1` },
        phaseValidation: { changedHeadPaths: [reference.path], includedFiles: [{ side: reference.side, path: reference.path }] },
        prompts: [{ name: "discover", text: "Discover the change through the result tool." }],
      })
      const phase = result.sessions[0]
      if (["conflict", "wrong-phase", "prose-only", "truncated"].includes(scenario)) {
        expect(result.status).toBe("failed")
        expect(phase?.status).toBe("failed")
        expect(phase).not.toHaveProperty("text")
      } else {
        expect(result.status).toBe("complete")
        if (phase?.status !== "complete") throw new Error("expected complete discovery")
        expect(JSON.parse(phase.text)).toEqual(valid)
        expect(phase.outputSubmissions?.records.map((record) => record.status)).toEqual(scenario === "duplicate" ? ["accepted", "accepted"] : scenario === "required-choice" ? ["accepted"] : ["rejected", "accepted"])
        expect(requests[1]).toContain(scenario === "malformed" ? "could not be parsed as JSON" : scenario === "excerpt" ? "excerpt does not match" : scenario === "path" ? "not present in the prepared" : "accepted")
        expect(z.object({ tool_choice: z.string() }).parse(JSON.parse(requests.at(-1)!)).tool_choice).toBe("none")
      }
      expect(result.requests.records).toHaveLength(requests.length)
      expect(result.requests.records.every((record) => record.status === 200 && record.outcome === "response")).toBe(true)
      expect(z.object({ tool_choice: z.string() }).parse(JSON.parse(requests[0]!)).tool_choice).toBe("required")
      expect(result.cleanup).toEqual({ hostClosed: true, forced: false })
    } finally {
      await server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)
}

test("review phases consume schema tool arguments instead of malformed assistant prose", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-structured-output-"))
  const material = join(root, "material")
  const calls = { discover: 0, verify: 0 }
  const toolNames: string[] = []
  const requestSchema = z.looseObject({ tools: z.array(z.looseObject({
    function: z.looseObject({ name: z.string(), parameters: z.looseObject({ properties: z.record(z.string(), z.unknown()).optional() }) }),
  })).optional() })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const raw = await request.text()
    const phase = raw.includes("Verify structured result") ? "verify" : "discover"
    const property = phase === "discover" ? "candidates" : "verifications"
    const body = requestSchema.parse(JSON.parse(raw))
    const tool = body.tools?.find((tool) => property in (tool.function.parameters.properties ?? {}))
    calls[phase]++
    if (!tool || calls[phase] > 1) return modelResponse(`{"${property}":[]}]} `)
    toolNames.push(tool.function.name)
    const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({
      id: "structured-result", object: "chat.completion.chunk", created: 0, model: "test-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
    return new Response(chunk({ tool_calls: [{ index: 0, id: `submit-${phase}`, type: "function", function: {
      name: tool.function.name, arguments: JSON.stringify({ [property]: [] }),
    } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  try {
    await mkdir(material)
    const result = await runIsolatedWorker({
      runDirectory: root, materialDirectory: material, apiKey: "structured-test-key",
      model: { providerID: "test", modelID: "test-model", baseURL: `http://127.0.0.1:${server.port}/v1` },
      phaseValidation: { changedHeadPaths: [], includedFiles: [] },
      prompts: [{ name: "discover", text: "Discover structured result" }, { name: "verify", text: "Verify structured result" }],
    })
    expect(result).toMatchObject({ status: "complete", cleanup: { hostClosed: true, forced: false }, sessions: [
      { name: "discover", status: "complete", text: '{"candidates":[]}' },
      { name: "verify", status: "complete", text: '{"verifications":[]}' },
    ] })
    expect(toolNames).toHaveLength(2)
    expect(result.requests.records.every((request) => request.kind === "primary")).toBe(true)
  } finally {
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

test("a stalled model worker exits within the parent deadline and retains unknown usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-timeout-"))
  const material = join(root, "material")
  await mkdir(material)
  let requests = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    requests++
    return new Promise<Response>(() => {})
  } })
  try {
    const started = Date.now()
    const result = await runIsolatedWorker({
      runDirectory: root, materialDirectory: material,
      model: { providerID: "test", baseURL: `http://127.0.0.1:${server.port}/v1`, modelID: "stalled" },
      apiKey: "timeout-sentinel-key", timeoutMs: 8_000, cleanupGraceMs: 500,
      // The explicit plan leaves the two-second model admission minimum room inside the analysis
      // window, so the stalled request really reaches the provider before the deadline fires.
      phaseDeadlines: {
        prepareInitEpochMs: started + 4_000,
        discoveryEpochMs: null,
        analysisStopEpochMs: started + 6_000,
        workerKillEpochMs: started + 7_000,
        finalEpochMs: started + 8_000,
      },
      prompts: [{ name: "smoke", text: "Reply OK." }],
    })
    expect(requests).toBeGreaterThan(0)
    expect(result.status).toBe("timeout")
    if (result.status === "complete") throw new Error("expected a timeout result")
    expect(result.code).toBe("verification-timeout")
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(result.usage.kind).toBe("unknown")
    // Neither the settled result nor the worker's progress records ever carry the model key.
    const saved = await readFile(join(root, "runtime/result.json"), "utf8")
    expect(saved).not.toContain("timeout-sentinel-key")
    expect(JSON.parse(saved).usage.kind).toBe("unknown")
    const progress = await readFile(join(root, "runtime/result.json.progress.json"), "utf8")
    expect(progress).not.toContain("timeout-sentinel-key")
    const { pid } = z.object({ pid: z.int().positive() }).parse(JSON.parse(await readFile(join(root, "runtime/process.json"), "utf8")))
    expect(() => process.kill(-pid, 0)).toThrow()
  } finally {
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

for (const conflictingFinal of [false, true]) {
  test(`forced cleanup preserves a legacy verification failure ${conflictingFinal ? "over a newer timeout result" : "without a final result"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "review-hung-terminal-"))
    const material = join(root, "material")
    const script = join(root, "worker.ts")
    const started = Date.now()
    const phaseDeadlines = { prepareInitEpochMs: started + 900, discoveryEpochMs: null, analysisStopEpochMs: started + 1_000, workerKillEpochMs: started + 1_300, finalEpochMs: started + 3_000 }
    const usage = { kind: "known", inputTokens: 11, outputTokens: 7 } as const
    const progress = {
      ...runtimeFailure("runtime is in progress", "interrupted", false, "run-interrupted"),
      checkpointSequence: 4, usage, phaseDeadlines,
      sessions: [
        { name: "discover", status: "complete", text: '{"candidates":[]}', usage },
        { name: "verify", status: "failed", code: "model-auth", error: "invalid model key", usage },
      ],
    } satisfies RuntimeResult
    const final = { ...runtimeFailure("late timeout", "timeout", false, "verification-timeout"), checkpointSequence: 5, phaseDeadlines }
    try {
      await mkdir(material)
      await writeFile(script, `
import { writeFileSync } from "node:fs"
process.on("SIGINT", () => {})
writeFileSync(process.argv[3] + ".progress.json", ${JSON.stringify(JSON.stringify(progress))})
${conflictingFinal ? `writeFileSync(process.argv[3], ${JSON.stringify(JSON.stringify(final))})` : ""}
setInterval(() => {}, 1_000)
`)
      const result = await runIsolatedWorker({
        runDirectory: root, materialDirectory: material, apiKey: "test-key", phaseDeadlines,
        model: { providerID: "test", modelID: "hung", baseURL: "http://127.0.0.1:9/v1" },
        prompts: [{ name: "discover", text: "Discover" }, { name: "verify", text: "Verify" }],
      }, { workerPath: script, clock: deadlineClock })
      expect(result).toMatchObject({
        status: "failed", code: "model-auth", error: "invalid model key", sessions: progress.sessions,
        cleanup: { forced: true, hostClosed: false }, usage: { kind: "unknown" },
      })
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 5_000)
}

test("an SDK discovery response completed after its deadline never starts verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-late-discovery-"))
  const material = join(root, "material")
  const jump = join(root, "advance-clock")
  const requests: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.text()
    const verifying = body.includes("Verification phase")
    requests.push(verifying ? "verify" : "discover")
    if (!verifying) await writeFile(jump, "")
    return resultToolResponse(verifying ? "review_submit_verification" : "review_submit_discovery", verifying ? '{"verifications":[]}' : '{"candidates":[]}')
  } })
  try {
    await mkdir(material)
    const script = join(root, "clock-worker.ts")
    await writeFile(script, `
import { existsSync } from "node:fs"
const realNow = Date.now
Date.now = () => realNow() + (existsSync(${JSON.stringify(jump)}) ? 121_000 : 0)
await import(${JSON.stringify(workerPath)})
`)
    const result = await runIsolatedWorker({
      runDirectory: root, materialDirectory: material, apiKey: "late-model-key",
      model: { providerID: "test", modelID: "test-model", baseURL: `http://127.0.0.1:${server.port}/v1` },
      prompts: [{ name: "discover", text: "Discovery phase" }, { name: "verify", text: "Verification phase" }],
      phaseValidation: { changedHeadPaths: [], includedFiles: [] },
    }, { workerPath: script, clock: deadlineClock })
    expect(requests).toEqual(["discover"])
    expect(result).toMatchObject({ status: "timeout", code: "discovery-timeout", sessions: [{ name: "discover", status: "timeout" }] })
    expect(result.sessions.some((session) => "text" in session)).toBe(false)
  } finally {
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

for (const [phase, late] of [["discover", true], ["verify", true], ["verify", false]] as const) {
  test(late ? `late ${phase} citation validation does not publish the phase text` : "on-time verification survives a stale discovery signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-late-validation-"))
    const material = join(root, "material")
    const head = join(material, "head")
    const evidencePath = join(head, "evidence.txt")
    const ready = join(root, "validation-started")
    const release = join(root, "release-validation")
    const jump = join(root, "advance-clock")
    const script = join(root, "clock-worker.ts")
    const started = Date.now()
    const phaseDeadlines = { prepareInitEpochMs: started + 5_000, discoveryEpochMs: null, analysisStopEpochMs: started + 10_000, workerKillEpochMs: started + 11_000, finalEpochMs: started + 12_000 }
    const location = { side: "head", path: "change.txt", startLine: 1, endLine: 1, excerpt: "change" } as const
    const evidence = { ...location, path: "evidence.txt", excerpt: "evidence" }
    const discovery = JSON.stringify({ candidates: [{ id: "C-1", changeLocation: location, trigger: "trigger", consequence: "consequence", rootCause: "cause", citations: [phase === "discover" ? evidence : location] }] })
    const verification = JSON.stringify({ verifications: [{ candidateId: "C-1", decision: "keep", reason: "reason", evidence: [evidence] }] })
    const requests: string[] = []
    const writers: Bun.Subprocess[] = []
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const verifying = (await request.text()).includes("Verification phase")
      const active = verifying ? "verify" : "discover"
      requests.push(active)
      if (active === phase && writers.length === 0) {
        // The isolated snapshot was already checked. The writer can open the FIFO only once
        // real citation validation opens its reader.
        expect(Bun.spawnSync(["mkfifo", evidencePath]).exitCode).toBe(0)
        writers.push(Bun.spawn([process.execPath, "-e", `
import { closeSync, existsSync, openSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
const fd = openSync(${JSON.stringify(evidencePath)}, "w")
writeFileSync(${JSON.stringify(ready)}, "")
while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10)
writeSync(fd, "evidence\\n")
unlinkSync(${JSON.stringify(evidencePath)})
writeFileSync(${JSON.stringify(evidencePath)}, "evidence\\n")
closeSync(fd)
`], { stdout: "ignore", stderr: "ignore" }))
      }
      return requests.filter((name) => name === active).length === 1
        ? resultToolResponse(verifying ? "review_submit_verification" : "review_submit_discovery", verifying ? verification : discovery)
        : modelResponse("Done")
    } })
    let pending: Promise<RuntimeResult> | undefined
    try {
      await mkdir(head, { recursive: true })
      await writeFile(join(head, location.path), "change\n")
      await writeFile(script, `
import { existsSync } from "node:fs"
const realNow = Date.now
Date.now = () => realNow() + (existsSync(${JSON.stringify(jump)}) ? 12_000 : 0)
await import(${JSON.stringify(workerPath)})
`)
      pending = runIsolatedWorker({
        runDirectory: root, materialDirectory: material, apiKey: "late-validation-key", phaseDeadlines,
        model: { providerID: "test", modelID: "test-model", baseURL: `http://127.0.0.1:${server.port}/v1` },
        prompts: [{ name: "discover", text: "Discovery phase" }, { name: "verify", text: "Verification phase" }],
        phaseValidation: { changedHeadPaths: [location.path], includedFiles: [location, evidence].map(({ side, path }) => ({ side, path })) },
      }, { workerPath: script, clock: deadlineClock })
      for (let attempt = 0; attempt < 350 && !await Bun.file(ready).exists(); attempt++) await Bun.sleep(20)
      expect(await Bun.file(ready).exists()).toBe(true)
      const progress = workerProgressSchema.parse(JSON.parse(await readFile(join(root, "runtime/result.json.progress.json"), "utf8")))
      expect(progress.kind).toBe("running")
      expect(progress.record.sessions.map(({ name }) => name)).toEqual(phase === "discover" ? [] : ["discover"])
      if (late) await writeFile(jump, "")
      else {
        const { pid } = z.object({ pid: z.int().positive() }).parse(JSON.parse(await readFile(join(root, "runtime/process.json"), "utf8")))
        process.kill(pid, "SIGUSR2")
      }
      await writeFile(release, "")
      const result = await pending
      if (late) {
        expect(result).toMatchObject({ status: "timeout", code: phase === "discover" ? "discovery-timeout" : "verification-timeout" })
        const unsettled = result.sessions.at(-1)
        expect(unsettled).toMatchObject({ name: phase, status: "timeout" })
        expect(unsettled).not.toHaveProperty("text")
      } else {
        expect(result).toMatchObject({ status: "complete", cleanup: { hostClosed: true, forced: false } })
        const verified = result.sessions.at(-1)
        expect(verified).toMatchObject({ name: "verify", status: "complete" })
        if (verified?.status !== "complete") throw new Error("expected completed verification")
        expect(JSON.parse(verified.text)).toEqual(JSON.parse(verification))
      }
      expect(requests).toEqual(phase === "discover" ? ["discover"] : late ? ["discover", "discover", "verify"] : ["discover", "discover", "verify", "verify"])
    } finally {
      for (const writer of writers) writer.kill("SIGKILL")
      await Promise.all(writers.map(({ exited }) => exited))
      await pending?.catch(() => undefined)
      await server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)
}

test("a rejected model citation keeps its bounded raw phase output for replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-invalid-citation-output-"))
  const material = join(root, "material")
  const changed = { side: "head", path: "change.txt", startLine: 1, endLine: 1, excerpt: "change" } satisfies CodeReference
  const baseline = { ...changed, side: "merge-base", excerpt: "before" } satisfies CodeReference
  const discovery = JSON.stringify({ candidates: [{
    id: "C-1", changeLocation: changed, trigger: "trigger", consequence: "consequence", rootCause: "cause", citations: [changed],
  }] })
  const rejected = JSON.stringify({ verifications: [{
    candidateId: "C-1", decision: "keep", reason: "The caller iterates the result.",
    evidence: [{ ...changed, path: "head/change.txt" }],
  }] })
  const submitted = new Set<string>()
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const prompt = await request.text()
    const phase = prompt.includes("Verify this candidate") ? "verify" : "discover"
    if (submitted.has(phase)) return modelResponse("Done")
    submitted.add(phase)
    return resultToolResponse(phase === "verify" ? "review_submit_verification" : "review_submit_discovery", phase === "verify" ? rejected : discovery)
  } })
  try {
    await mkdir(join(material, "head"), { recursive: true })
    await mkdir(join(material, "merge-base"), { recursive: true })
    await writeFile(join(material, "head/change.txt"), "change\n")
    await writeFile(join(material, "merge-base/change.txt"), "before\n")
    const started = Date.now()
    const result = await runIsolatedWorker({
      runDirectory: root, materialDirectory: material, apiKey: "invalid-citation-test-key",
      model: { providerID: "test", modelID: "test-model", baseURL: `http://127.0.0.1:${server.port}/v1` },
      phaseDeadlines: {
        prepareInitEpochMs: started + 5_000, discoveryEpochMs: null, analysisStopEpochMs: started + 20_000,
        workerKillEpochMs: started + 25_000, finalEpochMs: started + 26_000,
      },
      phaseValidation: { changedHeadPaths: [changed.path], includedFiles: [changed, baseline].map(({ side, path }) => ({ side, path })) },
      prompts: [{ name: "discover", text: "Discover this change." }, { name: "verify", text: "Verify this candidate." }],
    }, { workerPath, clock: deadlineClock })
    expect(result).toMatchObject({ status: "failed", code: "citation-invalid", sessions: [
      { name: "discover", status: "complete" }, { name: "verify", status: "failed", rawText: rejected },
    ] })
    const saved = z.object({ sessions: z.array(z.object({ rawText: z.string().optional() })) })
      .parse(JSON.parse(await readFile(join(root, "runtime/result.json"), "utf8")))
    expect(saved.sessions[1]?.rawText).toBe(rejected)
    expect(JSON.stringify(saved)).not.toContain("invalid-citation-test-key")
  } finally {
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

// The installed SDK runs its model server in-process, so a stalled worker spawns no descendant of
// its own. The group-kill guarantee the parent relies on still has to cover any descendant a
// future SDK or plugin spawns, so this drive hangs a real detached leader with one hung child that
// ignores every catchable signal, and proves the parent's negative-pid kill ends the whole group.
const hungTreeChild = "process.on('SIGINT', () => {}); process.on('SIGUSR2', () => {}); setInterval(() => {}, 1_000);"
test("the production supervisor kills a hung worker group at its exact kill deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-group-kill-"))
  const started = Date.now()
  let now = started
  const timers = new Map<() => void, number>()
  const clock = {
    now: () => now,
    schedule(ms: number, callback: () => void) {
      timers.set(callback, now + ms)
      return () => { timers.delete(callback) }
    },
  }
  const advanceTo = (offset: number) => {
    now = started + offset
    for (const [callback, deadline] of [...timers].sort((a, b) => a[1] - b[1])) {
      if (deadline <= now && timers.delete(callback)) callback()
    }
  }
  let pending: ReturnType<typeof runIsolatedWorker> | undefined
  try {
    const script = join(root, "hung-tree.ts")
    const reportPath = join(root, "hung-tree.json")
    const signalPath = join(root, "interrupted")
    const discoverySignalPath = join(root, "discovery-interrupted")
    const material = join(root, "material")
    const phaseDeadlines = { prepareInitEpochMs: started + 60_000, discoveryEpochMs: null, analysisStopEpochMs: started + 290_000, workerKillEpochMs: started + 298_000, finalEpochMs: started + 300_000 }
    const progress = { ...runtimeFailure("in progress", "interrupted", false, "run-interrupted"), phaseDeadlines: { ...phaseDeadlines, discoveryEpochMs: started + 150_000 } }
    await mkdir(material)
    await writeFile(script, `
const { writeFileSync } = require("node:fs")
process.on("SIGINT", () => writeFileSync(${JSON.stringify(signalPath)}, "interrupted"))
process.on("SIGUSR2", () => writeFileSync(${JSON.stringify(discoverySignalPath)}, "discovery interrupted"))
const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(hungTreeChild)}], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
writeFileSync(process.argv[3] + ".progress.json", ${JSON.stringify(JSON.stringify(progress))})
writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ pid: process.pid, child: child.pid }))
setInterval(() => {}, 1_000)
`, { mode: 0o600 })
    pending = runIsolatedWorker({
      runDirectory: root, materialDirectory: material,
      model: { providerID: "test", baseURL: "http://127.0.0.1:9/v1", modelID: "hung" },
      apiKey: "test-key", prompts: [{ name: "smoke", text: "Reply OK." }],
      phaseDeadlines,
    }, { clock, workerPath: script })
    let reported: { pid: number; child: number } | undefined
    for (let attempt = 0; attempt < 40 && reported === undefined; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      try {
        reported = z.object({ pid: z.int().positive(), child: z.int().positive() }).parse(JSON.parse(await readFile(reportPath, "utf8")))
      } catch { /* the leader has not reported its tree yet */ }
    }
    if (reported === undefined) throw new Error("the hung leader never reported its descendant")
    advanceTo(30_000)
    for (let attempt = 0; attempt < 40 && ![...timers.values()].includes(started + 150_000); attempt++) await Bun.sleep(25)
    advanceTo(149_999)
    expect(await Bun.file(discoverySignalPath).exists()).toBe(false)
    advanceTo(150_000)
    for (let attempt = 0; attempt < 40 && !await Bun.file(discoverySignalPath).exists(); attempt++) await Bun.sleep(25)
    expect(await Bun.file(discoverySignalPath).text()).toBe("discovery interrupted")
    advanceTo(289_999)
    expect(await Bun.file(signalPath).exists()).toBe(false)
    advanceTo(290_000)
    for (let attempt = 0; attempt < 40 && !await Bun.file(signalPath).exists(); attempt++) await Bun.sleep(25)
    expect(await Bun.file(signalPath).text()).toBe("interrupted")
    advanceTo(297_999)
    expect(() => process.kill(reported.pid, 0)).not.toThrow()
    expect(() => process.kill(reported.child, 0)).not.toThrow()
    advanceTo(298_000)
    const result = await pending
    expect(result).toMatchObject({ status: "timeout", cleanup: { forced: true }, usage: { kind: "unknown" } })
    for (let attempt = 0; attempt < 40; attempt++) {
      try { process.kill(-reported.pid, 0) } catch { break }
      await Bun.sleep(25)
    }
    expect(() => process.kill(reported.pid, 0)).toThrow()
    expect(() => process.kill(reported.child, 0)).toThrow()
    expect(() => process.kill(-reported.pid, 0)).toThrow()
  } finally {
    advanceTo(300_000)
    await pending?.catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)
