import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const TLA_TOOLS_VERSION = "1.7.4"
const TLA_TOOLS_SHA1 = "bee4a54f3ee3d4afc347c3240ec2d9e93b075104"
const TLA_TOOLS_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLA_TOOLS_VERSION}/tla2tools.jar`
const modelDirectory = join(import.meta.dir, "../.claude/skills/verify-request-policy")
const cacheBase = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache")
const jarPath = join(cacheBase, "ai-code-review", `tla2tools-${TLA_TOOLS_VERSION}.jar`)

function sha1(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex")
}

async function ensureTlaTools(): Promise<void> {
  try {
    const cached = await readFile(jarPath)
    if (sha1(cached) === TLA_TOOLS_SHA1) return
    await rm(jarPath, { force: true })
  } catch { /* Download a missing cache entry. */ }

  await mkdir(join(cacheBase, "ai-code-review"), { recursive: true })
  const response = await fetch(TLA_TOOLS_URL, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`TLA+ Tools download failed with HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const actual = sha1(bytes)
  if (actual !== TLA_TOOLS_SHA1) throw new Error(`TLA+ Tools checksum mismatch: expected ${TLA_TOOLS_SHA1}, got ${actual}`)
  const temporaryJar = `${jarPath}.${process.pid}.tmp`
  await writeFile(temporaryJar, bytes, { mode: 0o600 })
  await rename(temporaryJar, jarPath)
}

function runTlc(configName: string, metadataDirectory: string) {
  const result = spawnSync("java", [
    "-XX:+UseParallelGC", "-cp", jarPath, "tlc2.TLC", "-workers", "1", "-metadir", metadataDirectory,
    "-config", configName, "RequestPolicy",
  ], { cwd: modelDirectory, encoding: "utf8", timeout: 120_000 })
  if (result.error) throw result.error
  return { exitCode: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` }
}

await ensureTlaTools()
const evidenceDirectory = await mkdtemp(join(tmpdir(), "request-policy-tlc-"))
try {
  await mkdir(join(evidenceDirectory, "passing"), { recursive: true })
  await mkdir(join(evidenceDirectory, "broken"), { recursive: true })
  const passing = runTlc("RequestPolicy.cfg", join(evidenceDirectory, "passing"))
  await writeFile(join(evidenceDirectory, "passing.out"), passing.output)
  process.stdout.write("PASSING MODEL\n")
  process.stdout.write(passing.output)
  if (passing.exitCode !== 0 || !passing.output.includes("Model checking completed. No error has been found.")) {
    throw new Error("the request-policy model did not pass")
  }

  const broken = runTlc("RequestPolicy-broken.cfg", join(evidenceDirectory, "broken"))
  await writeFile(join(evidenceDirectory, "broken.out"), broken.output)
  process.stdout.write("BROKEN MODEL, EXPECTED COUNTEREXAMPLE\n")
  process.stdout.write(broken.output)
  const expectedCounterexample =
    broken.output.includes("Invariant PolicyInvariant is violated") &&
    broken.output.includes("wireAttempts = 4") &&
    broken.output.includes("approvals = 3")
  if (broken.exitCode === 0 || !expectedCounterexample) {
    throw new Error("the broken model did not report the expected PolicyInvariant fourth-request counterexample")
  }
  console.log(`request-policy TLC check passed; TLC output retained at ${evidenceDirectory}`)
} catch (error) {
  console.error(`TLC evidence retained at ${evidenceDirectory}`)
  throw error
}
