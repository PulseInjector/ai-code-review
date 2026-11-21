import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAction, type ActionCommand } from "./action-entry"

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

async function fixture(mode = "review") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "action entry $; ' ")))
  temporary.push(root)
  const product = join(root, "product $; ' path")
  await symlink(join(import.meta.dir, ".."), product)
  const eventPath = join(root, "event.json")
  await writeFile(eventPath, JSON.stringify({ inputs: { pr: "17" } }))
  const env: NodeJS.ProcessEnv = {
    GITHUB_ACTION_PATH: product, REVIEW_PRODUCT_DIRECTORY: product, REVIEW_PRODUCT_COMMIT: "a".repeat(40),
    RUNNER_TEMP: root, GITHUB_RUN_ID: "1234", GITHUB_RUN_ATTEMPT: "2", GITHUB_REPOSITORY: "owner/repo",
    GITHUB_REPOSITORY_ID: "987654321", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_EVENT_PATH: eventPath,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_OUTPUT: join(root, "outputs"), REVIEW_ACTION_MODE: mode, REVIEW_ACTION_PR: "17",
    REVIEW_ACTION_CONFIG: "rules/config $; '.json", REVIEW_MODEL_API_KEY: "mask%\r\nkey",
    REVIEW_JOB_RESULT: "failure", REVIEW_DOWNLOAD_OUTCOME: "failure",
  }
  const logs: string[] = []
  const calls: ActionCommand[] = []
  return { root, env, logs, calls, execute: async (call: ActionCommand) => {
    expect(await readFile(env.GITHUB_OUTPUT!, "utf8")).toContain("status=failed\n")
    calls.push(call)
    return { exitCode: 1, stdout: "" }
  } }
}

test("review outputs precede execution and arguments preserve paths without shell expansion", async () => {
  const f = await fixture()
  expect(await runAction(f.env, { execute: f.execute, stdout: (s) => f.logs.push(s) })).toBe(1)
  expect(f.logs[0]).toBe("::add-mask::mask%25%0D%0Akey\n")
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]!.argv).toEqual([process.execPath, "--no-env-file", "run", join(f.env.GITHUB_ACTION_PATH!, "src/cli.ts"),
    "review", "--repository", "owner/repo", "--pr", "17", "--config", "rules/config $; '.json", "--out", join(f.root, "ai-code-review-1234-2")])
  expect(f.calls[0]!.cwd).toBe(f.env.GITHUB_ACTION_PATH!)
  expect(f.calls[0]!.env.REVIEW_MODEL_API_KEY).toBe(f.env.REVIEW_MODEL_API_KEY)
  const outputs = await readFile(f.env.GITHUB_OUTPUT!, "utf8")
  expect(outputs).toContain(`handoff-directory=${join(f.root, "ai-code-review-1234-2/handoff")}\n`)
  expect(outputs).toContain("handoff-artifact=ai-code-review-handoff-1234-2\nreplay-artifact=ai-code-review-replay-1234-2\n")
})

test("publish never reads model environment and invokes the publisher after a failed download", async () => {
  const f = await fixture("publish")
  for (const name of ["REVIEW_MODEL_API_KEY", "REVIEW_MODEL_ID", "REVIEW_MODEL_BASE_URL", "REVIEW_MODEL_PROVIDER_ID", "OPENAI_API_KEY", "INPUT_MODEL-API-KEY", "INPUT_MODEL_API_KEY"]) {
    Object.defineProperty(f.env, name, { enumerable: true, get() { throw new Error("model environment was read") } })
  }
  expect(await runAction(f.env, { execute: async (call) => {
    await f.execute(call)
    for (const name of Object.keys(call.env)) expect(name.startsWith("REVIEW_MODEL_") || name === "OPENAI_API_KEY" || name.startsWith("INPUT_MODEL_") || name === "INPUT_MODEL-API-KEY").toBe(false)
    return { exitCode: 1, stdout: JSON.stringify({ publication: { kind: "failed" }, commentId: "501" }) + "\n" }
  }, stdout: (s) => f.logs.push(s) })).toBe(1)
  expect(f.calls[0]!.argv.slice(4)).toEqual(["publish", "--repository", "owner/repo", "--pr", "17", "--package", join(f.root, "ai-code-review-download"), "--review-job-result", "failure"])
  expect(await readFile(f.env.GITHUB_OUTPUT!, "utf8")).toContain("run-directory=\nhandoff-directory=\nhandoff-artifact=\nreplay-artifact=\n")
  expect(await readFile(f.env.GITHUB_OUTPUT!, "utf8")).toContain("comment-id=501\n")
  expect(f.logs.join("")).not.toContain("add-mask")
})

test.each([
  ["REVIEW_ACTION_MODE", "unknown"], ["REVIEW_ACTION_PR", "017"], ["GITHUB_RUN_ATTEMPT", "02"],
  ["REVIEW_PRODUCT_COMMIT", "main"], ["REVIEW_PRODUCT_COMMIT", "v1"], ["REVIEW_PRODUCT_DIRECTORY", "/tmp"],
  ["REVIEW_DOWNLOAD_OUTCOME", "unknown"],
])("invalid %s prevents command execution", async (name, value) => {
  const f = await fixture("publish")
  f.env[name] = value
  expect(await runAction(f.env, { execute: f.execute, stderr: () => {} })).toBe(1)
  expect(f.calls).toHaveLength(0)
})

test("an entry preflight failure masks the key before its diagnostic", async () => {
  const f = await fixture()
  f.env.REVIEW_PRODUCT_COMMIT = "main"
  expect(await runAction(f.env, { execute: f.execute, stdout: (s) => f.logs.push(s), stderr: (s) => f.logs.push(s) })).toBe(1)
  expect(f.logs[0]).toStartWith("::add-mask::")
  expect(f.logs[1]).toContain("[input-invalid]")
  expect(f.logs[1]).not.toContain("main")
  expect(f.calls).toHaveLength(0)
})

test.each(["review", "publish"])("a %s execution failure reports its sanitized cause", async (mode) => {
  const f = await fixture(mode)
  f.env.GITHUB_TOKEN = "fake-github-token"
  if (mode === "publish") {
    for (const name of ["REVIEW_MODEL_API_KEY", "REVIEW_MODEL_ID", "REVIEW_MODEL_BASE_URL", "REVIEW_MODEL_PROVIDER_ID"]) {
      Object.defineProperty(f.env, name, { enumerable: true, get() { throw new Error("publish read model environment") } })
    }
  }
  expect(await runAction(f.env, {
    execute: async () => { throw new Error(`spawn failed with ${mode === "review" ? f.env.REVIEW_MODEL_API_KEY : f.env.GITHUB_TOKEN}`) },
    stdout: (s) => f.logs.push(s), stderr: (s) => f.logs.push(s),
  })).toBe(1)
  const diagnostic = f.logs.at(-1)!
  expect(diagnostic).toContain("[runtime-init]")
  expect(diagnostic).toContain("spawn failed with [redacted]")
  expect(diagnostic).not.toContain("mask%")
  expect(diagnostic).not.toContain("fake-github-token")
})
