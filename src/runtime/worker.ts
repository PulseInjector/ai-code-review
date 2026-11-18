import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { runtimeFailure, workerInputSchema, type RuntimeResult } from "./contracts"
import { runRuntime } from "./opencode-v227"

const inputPath = process.argv[2]
const outputPath = process.argv[3]
if (!inputPath || !outputPath) throw new Error("worker requires input and output paths")

const controller = new AbortController()
const onInterrupt = () => controller.abort()
process.on("SIGINT", onInterrupt)
const apiKey = process.env.OPENAI_API_KEY
function save(path: string, value: RuntimeResult) {
  const serialized = JSON.stringify(value)
  writeFileSync(`${path}.tmp`, apiKey ? serialized.replaceAll(apiKey, "[REDACTED]") : serialized, { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

let result: RuntimeResult
try {
  const input = workerInputSchema.parse(JSON.parse(readFileSync(inputPath, "utf8")))
  const home = homedir()
  if (["CONFIG", "CACHE", "DATA", "STATE"].some((name) => process.env[`XDG_${name}_HOME`] !== join(home, name.toLowerCase())) ||
    input.configDirectory !== join(home, "config") || process.cwd() !== input.materialDirectory ||
    Object.keys(process.env).some((key) => key.startsWith("OPENCODE_"))) {
    throw new Error("worker environment is not isolated")
  }
  result = await runRuntime(input, controller.signal, (progress) => save(`${outputPath}.progress.json`, progress))
} catch (error) {
  result = runtimeFailure(error instanceof Error ? error.message : String(error))
}

save(outputPath, result)
process.removeListener("SIGINT", onInterrupt)
if (result.status !== "complete") process.exitCode = 1
