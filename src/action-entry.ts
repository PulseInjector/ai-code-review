import { appendFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { z } from "zod"
import { relativePathSchema } from "./contracts"
import { attemptSchema, canonicalPrInputSchema, repositoryNameSchema, runIdSchema } from "./identity"
import { jobResultSchema } from "./pr-contracts"
import { readProductIdentity } from "./product-identity"

export type ActionCommand = { argv: string[]; cwd: string; env: NodeJS.ProcessEnv }
type CommandResult = { exitCode: number; stdout: string }
export type ActionDependencies = {
  execute?: (command: ActionCommand) => Promise<CommandResult>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

const absolutePath = z.string().min(1).refine((value) => isAbsolute(value) && !/[\r\n\0]/u.test(value), "an absolute single-line path is required")
const reviewSummary = z.object({ outcome: z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reviewed"), result: z.object({ status: z.enum(["complete", "partial"]) }) }),
  z.object({ kind: z.literal("failed") }), z.object({ kind: z.literal("skipped") }),
]) })
const publishSummary = z.object({ publication: z.object({ kind: z.enum(["published", "retained", "rejected", "failed"]) }), commentId: z.string().nullable() })

async function execute({ argv, cwd, env }: ActionCommand): Promise<CommandResult> {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "inherit" })
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  return { exitCode, stdout }
}

export async function runAction(env: NodeJS.ProcessEnv = process.env, deps: ActionDependencies = {}): Promise<0 | 1> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text))
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text))
  const mode = env.REVIEW_ACTION_MODE
  const key = mode === "review" ? env.REVIEW_MODEL_API_KEY : undefined
  if (key) stdout(`::add-mask::${key.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`)
  try {
    if (mode !== "review" && mode !== "publish") throw new Error("Action mode must be review or publish")
    const runId = runIdSchema.parse(env.GITHUB_RUN_ID)
    const attemptText = z.string().regex(/^[1-9][0-9]*$/u).parse(env.GITHUB_RUN_ATTEMPT)
    const attempt = attemptSchema.parse(Number(attemptText))
    const runnerTemp = absolutePath.parse(env.RUNNER_TEMP)
    const directory = absolutePath.parse(env.GITHUB_ACTION_PATH)
    const repository = repositoryNameSchema.parse(env.GITHUB_REPOSITORY)
    const pr = canonicalPrInputSchema.parse(env.REVIEW_ACTION_PR)
    const config = relativePathSchema.parse(env.REVIEW_ACTION_CONFIG ?? "review.config.json")
    const outputFile = absolutePath.parse(env.GITHUB_OUTPUT)
    const out = join(runnerTemp, `ai-code-review-${runId}-${attempt}`)
    const outputs = {
      status: "failed",
      "run-directory": mode === "review" ? out : "",
      "handoff-directory": mode === "review" ? join(out, "handoff") : "",
      "handoff-artifact": mode === "review" ? `ai-code-review-handoff-${runId}-${attempt}` : "",
      "replay-artifact": mode === "review" ? `ai-code-review-replay-${runId}-${attempt}` : "",
      "comment-id": "",
    }
    await appendFile(outputFile, Object.entries(outputs).map(([name, value]) => `${name}=${value}\n`).join(""))
    await readProductIdentity(env)
    const childEnv: NodeJS.ProcessEnv = {}
    for (const name of Object.keys(env)) {
      if (name === "OPENAI_API_KEY" || name.startsWith("INPUT_MODEL_") || name === "INPUT_MODEL-API-KEY" ||
        mode === "publish" && name.startsWith("REVIEW_MODEL_")) continue
      childEnv[name] = env[name]
    }
    const argv = [process.execPath, "--no-env-file", "run", join(directory, "src/cli.ts")]
    if (mode === "review") argv.push("review", "--repository", repository, "--pr", String(pr), "--config", config, "--out", out)
    else {
      z.enum(["success", "failure", "cancelled", "skipped"]).parse(env.REVIEW_DOWNLOAD_OUTCOME)
      const jobResult = jobResultSchema.parse(env.REVIEW_JOB_RESULT)
      argv.push("publish", "--repository", repository, "--pr", String(pr), "--package", join(runnerTemp, "ai-code-review-download"), "--review-job-result", jobResult)
    }
    const result = await (deps.execute ?? execute)({ argv, cwd: directory, env: childEnv })
    stdout(result.stdout)
    if (result.stdout.trim() !== "") {
      const summary: unknown = JSON.parse(result.stdout)
      if (mode === "review") {
        const { outcome } = reviewSummary.parse(summary)
        outputs.status = outcome.kind === "reviewed" ? outcome.result.status : outcome.kind
      } else {
        const parsed = publishSummary.parse(summary)
        outputs.status = parsed.publication.kind
        outputs["comment-id"] = parsed.commentId ?? ""
      }
      await appendFile(outputFile, `status=${outputs.status}\ncomment-id=${outputs["comment-id"]}\n`)
    }
    return result.exitCode === 0 ? 0 : 1
  } catch {
    stderr("The Action command failed validation or execution.\n")
    return 1
  }
}

if (import.meta.main) process.exitCode = await runAction()
