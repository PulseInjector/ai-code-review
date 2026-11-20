import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { runIsolatedWorker } from "./worker-process"

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
      apiKey: "timeout-sentinel-key", timeoutMs: 2_000, cleanupGraceMs: 500,
      prompts: [{ name: "smoke", text: "Reply OK." }],
    })
    expect(requests).toBeGreaterThan(0)
    expect(result.status).toBe("timeout")
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(result.usage.kind).toBe("unknown")
    const saved = await readFile(join(root, "runtime/result.json"), "utf8")
    expect(saved).not.toContain("timeout-sentinel-key")
    expect(JSON.parse(saved).usage.kind).toBe("unknown")
    const { pid } = z.object({ pid: z.int().positive() }).parse(JSON.parse(await readFile(join(root, "runtime/process.json"), "utf8")))
    expect(() => process.kill(-pid, 0)).toThrow()
  } finally {
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 8_000)
