import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url))

async function invoke(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { exitCode, stdout, stderr }
}

test("verification CLI help lists its supported user entry points", async () => {
  const result = await invoke("--help")
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("bun run verify doctor [--live]")
  expect(result.stdout).toContain("--area cli|snapshot|runtime|github|java")
})

test("verification CLI rejects unknown areas without creating evidence", async () => {
  const result = await invoke("--area", "unknown")
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain("Usage: bun run verify")
})

test("read-only doctor exits successfully with the installed toolchain", async () => {
  const result = await invoke("doctor")
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("PASS bun:")
  expect(result.stdout).toContain("PASS checkout:")
  expect(result.stdout).not.toContain("API_KEY")
})
