import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeLoad } from "js-yaml"
import { z } from "zod"
import pkg from "../../package.json"

const root = join(import.meta.dir, "../..")
const evidence = await mkdtemp(join(tmpdir(), "ai-code-review-action-"))

async function run(name: string, argv: string[], timeout = 1_200_000): Promise<void> {
  const child = Bun.spawn(argv, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill("SIGTERM"), timeout)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    await Bun.write(join(evidence, `${name}.stdout.txt`), stdout)
    await Bun.write(join(evidence, `${name}.stderr.txt`), stderr)
    if (exitCode !== 0) throw new Error(`${name} failed with exit ${exitCode}; evidence: ${evidence}`)
    console.log(`PASS ${name}`)
  } finally {
    clearTimeout(timer)
  }
}

try {
  const manifest = z.object({ runs: z.object({ steps: z.array(z.object({ uses: z.string().optional() })) }) }).parse(safeLoad(await readFile(join(root, "action.yml"), "utf8")))
  if (manifest.runs?.steps?.[0]?.uses !== "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6") throw new Error("the setup-bun step differs from the root Action contract")
  if (Bun.version !== pkg.engines.bun) throw new Error(`Bun ${Bun.version} does not match Action version ${pkg.engines.bun}`)
  console.log("PASS pinned Bun setup equivalent")
  await run("frozen-install", [process.execPath, "--no-env-file", "install", "--offline", "--frozen-lockfile", "--ignore-scripts"])
  await run("command-step", [process.execPath, "--no-env-file", "test",
    "src/action.test.ts", "src/action-entry.test.ts", "src/cli.test.ts", "src/pr-review.test.ts",
    "src/handoff.test.ts", "src/publish.test.ts", "src/comment.test.ts", "src/github.test.ts",
    "src/runtime/request-policy.test.ts", "src/runtime/scripted-provider.test.ts"])
} finally {
  await rm(evidence, { recursive: true, force: true })
}
