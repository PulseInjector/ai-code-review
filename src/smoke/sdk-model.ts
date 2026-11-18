import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadModelConfiguration, runIsolatedWorker } from "../runtime/worker-process"

const { model, apiKey } = loadModelConfiguration()

const runDirectory = await mkdtemp(join(tmpdir(), "ai-code-review-model-"))

try {
  const materialDirectory = join(runDirectory, "material")
  await mkdir(materialDirectory)
  const result = await runIsolatedWorker({
    model: {
      providerID: model.providerID,
      baseURL: model.baseURL,
      modelID: model.modelID,
    },
    apiKey,
    materialDirectory,
    runDirectory,
    timeoutMs: 60_000,
    readLimits: { perToolBytes: 32 * 1024, totalBytes: 512 * 1024, maxLines: 100 },
    prompts: [{ name: "smoke", text: "Reply with the single word OK. Do not use tools." }],
  })
  if (result.status !== "complete") throw new Error(result.error ?? `SDK model smoke ended with ${result.status}`)
  console.log(JSON.stringify({ smoke: "sdk-model", status: "passed", providerID: model.providerID, modelID: model.modelID, usage: result.usage }))
} finally {
  await rm(runDirectory, { recursive: true, force: true })
}
