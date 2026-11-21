import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { digestSchema, gitShaSchema, type GitSha, type Sha256 } from "./identity"

const sourceDirectory = fileURLToPath(new URL(".", import.meta.url))

export async function hashProductSources(signal?: AbortSignal): Promise<Sha256> {
  const hash = createHash("sha256")
  const paths = (await readdir(sourceDirectory, { recursive: true }))
    .filter((path) => path.endsWith(".ts"))
    .sort()
  for (const path of paths) {
    signal?.throwIfAborted()
    hash.update(path).update("\0").update(await readFile(join(sourceDirectory, path), { signal })).update("\0")
  }
  return digestSchema.parse(hash.digest("hex"))
}

export async function hashPromptTemplates(): Promise<{ discoverPrompt: Sha256; verifyPrompt: Sha256 }> {
  const [discover, verify] = await Promise.all([
    readFile(join(sourceDirectory, "../prompts/discover.md")),
    readFile(join(sourceDirectory, "../prompts/verify.md")),
  ])
  return {
    discoverPrompt: digestSchema.parse(createHash("sha256").update(discover).digest("hex")),
    verifyPrompt: digestSchema.parse(createHash("sha256").update(verify).digest("hex")),
  }
}

export async function readProductCommit(): Promise<GitSha> {
  const configured = process.env.REVIEW_PRODUCT_COMMIT
  if (configured !== undefined && configured !== "") return gitShaSchema.parse(configured)
  const result = Bun.spawnSync(["git", "-C", sourceDirectory, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error("the fixed product commit is unavailable")
  return gitShaSchema.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).trim())
}
