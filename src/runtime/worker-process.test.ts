import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { runIsolatedWorker } from "./worker-process"
import { runtimeFailure } from "./contracts"

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
