import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pkg from "../../package.json"

const root = join(import.meta.dir, "../..")
const areas = ["cli", "snapshot", "runtime", "github", "java"] as const
type Area = (typeof areas)[number]
type Mode = { kind: "local"; area?: Area } | { kind: "live" } | { kind: "doctor"; live: boolean } | { kind: "help" }
const usage = `Usage: bun run verify [--area ${areas.join("|")} | --live]\n       bun run verify doctor [--live]`

function parseArgs(args: string[]): Mode {
  if (args[0] === "--") args = args.slice(1)
  if (args.length === 0) return { kind: "local" }
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { kind: "help" }
  if (args.length === 1 && args[0] === "--live") return { kind: "live" }
  if (args[0] === "doctor" && (args.length === 1 || (args.length === 2 && args[1] === "--live"))) return { kind: "doctor", live: args.length === 2 }
  const area = areas.find((name) => name === args[1])
  if (args.length === 2 && args[0] === "--area" && area) return { kind: "local", area }
  throw new Error(usage)
}

const run = (script: string) => [process.execPath, "run", script]
const test = (...paths: string[]) => [process.execPath, "test", ...paths]

type CommandResult = { exitCode: number; stdout: string; stderr: string }
export type Drive = (name: string, command: string[], overrides?: NodeJS.ProcessEnv) => Promise<CommandResult>

async function execute(command: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<CommandResult> {
  const child = Bun.spawn(command, { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout, killSignal: "SIGTERM" })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { exitCode, stdout, stderr }
}

async function configuredModel() {
  const { loadModelConfiguration } = await import("../runtime/worker-process")
  return loadModelConfiguration()
}

async function installedVersion(name: string): Promise<string> {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8"))
    if (manifest && typeof manifest === "object" && "version" in manifest && typeof manifest.version === "string") return manifest.version
  } catch { return "not installed or unreadable" }
  return "invalid manifest"
}

async function doctor(live: boolean): Promise<boolean> {
  const checks: { name: string; ok: boolean; detail: string }[] = []
  checks.push({ name: "bun", ok: Bun.version === pkg.engines.bun, detail: `${Bun.version} (required ${pkg.engines.bun})` })
  for (const [name, expected] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const installed = await installedVersion(name)
    checks.push({ name, ok: installed === expected, detail: `${installed} (required ${expected})` })
  }
  for (const tool of ["git", "java", "javac"]) {
    const result = await execute([tool, "--version"], process.env, 5_000).catch(() => undefined)
    checks.push({ name: tool, ok: result?.exitCode === 0, detail: result?.exitCode === 0 ? (result.stdout || result.stderr).split("\n")[0] : "not runnable" })
  }
  const revision = await execute(["git", "rev-parse", "HEAD"], process.env, 5_000).catch(() => undefined)
  const ok = revision?.exitCode === 0
  checks.push({ name: "checkout", ok, detail: ok ? revision.stdout.trim() : "cannot resolve HEAD" })
  if (live && checks.every(({ ok }) => ok)) {
    const modelReady = await configuredModel().then(() => true, () => false)
    checks.push({ name: "model config", ok: modelReady, detail: modelReady ? "valid shape; connection and key not tested" : "missing or invalid REVIEW_MODEL_* settings; see ENVIRONMENT.md" })
  }
  for (const check of checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`)
  return checks.every(({ ok }) => ok)
}

type Check = { name: string; run: () => Promise<void> }

async function verify(mode: Extract<Mode, { kind: "local" | "live" }>): Promise<boolean> {
  const live = mode.kind === "live"
  const apiKey = live ? await configuredModel().then(({ apiKey }) => apiKey, () => {
    throw new Error("missing or invalid REVIEW_MODEL_* settings; run bun run verify doctor --live")
  }) : undefined
  const redact = (text: string) => apiKey ? text.replaceAll(apiKey, "[REDACTED]") : text
  const evidence = await mkdtemp(join(await realpath(tmpdir()), "ai-code-review-verify-"))
  const scratch = join(evidence, "scratch")
  await mkdir(scratch)
  console.log(`Evidence: ${evidence}`)
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: live ? evidence : scratch }
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key]
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" })
  if (!live) Object.assign(env, { REVIEW_MODEL_PROVIDER_ID: "", REVIEW_MODEL_BASE_URL: "", REVIEW_MODEL_ID: "", REVIEW_MODEL_API_KEY: "" })

  const commands: { name: string; argv: string[]; exitCode: number; durationMs: number; stdout: string; stderr: string }[] = []
  const drive: Drive = async (name, argv, overrides) => {
    const started = Date.now()
    const result = await execute(argv, { ...env, ...overrides }, live ? 1_000_000 : 120_000)
      .catch((error: unknown) => ({ exitCode: 1, stdout: "", stderr: String(error) }))
    const stdout = `${name}.stdout.txt`
    const stderr = `${name}.stderr.txt`
    await Promise.all([writeFile(join(evidence, stdout), redact(result.stdout)), writeFile(join(evidence, stderr), redact(result.stderr))])
    commands.push({ name, argv, exitCode: result.exitCode, durationMs: Date.now() - started, stdout, stderr })
    return result
  }
  const command = (name: string, argv: string[]): Check => ({ name, run: async () => {
    const result = await drive(name, argv)
    if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}; see ${name}.stderr.txt and ${name}.stdout.txt`)
  } })

  const cli = (area: "cli" | "snapshot"): Check => ({ name: area, run: async () => {
    const { verifyReviewCli } = await import("./review-cli")
    await verifyReviewCli({ area, drive, scratch, evidence })
  } })
  const sdk = command("sdk", run("smoke:sdk"))
  const java = command("java", run("smoke:java"))
  const local: Record<Area, Check[]> = {
    cli: [cli("cli")],
    snapshot: [cli("snapshot"), command("snapshot-tests", test("src/context.test.ts", "src/report.test.ts"))],
    runtime: [sdk, command("runtime-tests", test("src/runtime/runtime.test.ts", "src/runtime/worker-process.test.ts", "src/runtime/request-policy.test.ts", "src/runtime/scripted-provider.test.ts"))],
    github: [{ name: "github journeys", run: async () => {
      const { verifyGithubCli } = await import("./github-cli")
      await verifyGithubCli(drive)
    } }],
    java: [java, command("java-fixtures", test("src/fixtures/java-review.test.ts"))],
  }
  const checks = live ? [command("model", run("smoke:model")), command("acceptance", run("smoke:review"))]
    : mode.area ? local[mode.area] : [command("typecheck", run("typecheck")), command("tests", run("test")), sdk, java, cli("cli"), cli("snapshot")]
  const results: { name: string; status: "pass" | "fail" | "skipped"; reason?: string }[] = []
  let removedScratch = false
  try {
    for (const check of checks) {
      if (live && results.some(({ status }) => status === "fail")) {
        results.push({ name: check.name, status: "skipped", reason: "model connection check failed" })
        console.log(`SKIP ${check.name}: model connection check failed`)
        continue
      }
      try {
        await check.run()
        results.push({ name: check.name, status: "pass" })
        console.log(`PASS ${check.name}`)
      } catch (error) {
        const reason = redact(error instanceof Error ? error.message : String(error))
        results.push({ name: check.name, status: "fail", reason })
        console.log(`FAIL ${check.name}: ${reason}`)
      }
    }
  } finally {
    try {
      await rm(scratch, { recursive: true, force: true })
      removedScratch = true
    } finally {
      await writeFile(join(evidence, "summary.json"), `${JSON.stringify({ mode: live ? "live" : (mode.area ?? "local"), results, commands, removedScratch }, null, 2)}\n`)
    }
  }
  return results.every(({ status }) => status === "pass")
}

if (import.meta.main) {
  try {
    const mode = parseArgs(process.argv.slice(2))
    if (mode.kind === "help") console.log(usage)
    else if (!(await (mode.kind === "doctor" ? doctor(mode.live) : verify(mode)))) process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
