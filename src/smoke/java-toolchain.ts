import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const directory = await mkdtemp(join(tmpdir(), "ai-code-review-java-"))
const sourcePath = join(directory, "Smoke.java")

try {
  await writeFile(
    sourcePath,
    [
      "public final class Smoke {",
      "  public static void main(String[] args) {",
      '    System.out.println("java-toolchain-ok");',
      "  }",
      "}",
      "",
    ].join("\n"),
  )

  const compile = Bun.spawnSync(["javac", sourcePath], { stdout: "pipe", stderr: "pipe" })
  if (compile.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(compile.stderr).trim() || "javac failed")
  }

  const run = Bun.spawnSync(["java", "-cp", directory, "Smoke"], { stdout: "pipe", stderr: "pipe" })
  if (run.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(run.stderr).trim() || "java failed")
  }

  const output = new TextDecoder().decode(run.stdout).trim()
  if (output !== "java-toolchain-ok") {
    throw new Error(`unexpected Java output: ${output}`)
  }

  console.log(JSON.stringify({ smoke: "java-toolchain", status: "passed" }))
} finally {
  await rm(directory, { recursive: true, force: true })
}
