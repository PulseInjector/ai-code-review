import type { ReviewInput } from "./context"
import { relativePathSchema } from "./contracts"
import { createBudget, systemClock } from "./budget"
import { createGitHubReader, readExecutionContext } from "./github"
import { modelRecordSchema } from "./handoff"
import { prNumberSchema, repositoryNameSchema } from "./identity"
import { jobResultSchema, type JobResult } from "./pr-contracts"
import { runPrReview } from "./pr-review"
import { runReview } from "./review"
import { loadModelConfiguration } from "./runtime/worker-process"
import { readProductCommit } from "./product-identity"

export type Command =
  | { kind: "review-local"; input: ReviewInput }
  | { kind: "review-pr"; repository: string; pr: number; config: string; out: string }
  | { kind: "publish"; repository: string; pr: number; packageDirectory: string; reviewJobResult: JobResult }

export function parseReviewInput(argv: string[]): ReviewInput {
  const args = argv[0] === "--" ? argv.slice(1) : argv
  if (args.includes("--help") || args.includes("-h")) {
    throw new Error("usage: bun run review -- --repo <path> --base <revision> --head <revision> --out <new-directory>")
  }
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key || !["--repo", "--base", "--head", "--out"].includes(key) || !value || value.startsWith("--") || values.has(key)) {
      throw new Error("expected unique --repo, --base, --head, and --out options with values")
    }
    values.set(key, value)
  }
  if (values.size !== 4) throw new Error("--repo, --base, --head, and --out are required")
  return { repo: values.get("--repo")!, base: values.get("--base")!, head: values.get("--head")!, out: values.get("--out")! }
}

const HELP = ["usage: bun run review -- --repo <path> --base <revision> --head <revision> --out <new-directory>",
  "       bun run src/cli.ts review --repository <owner/name> --pr <number> [--config <path>] --out <new-directory>",
  "       bun run src/cli.ts publish --repository <owner/name> --pr <number> --package <directory> --review-job-result <result>"].join("\n")

function normalizedArgs(argv: readonly string[]): string[] {
  return argv[0] === "--" ? [...argv.slice(1)] : [...argv]
}

export function isHelpOnlyCommand(argv: readonly string[]): boolean {
  const args = normalizedArgs(argv)
  return args.length === 1 && (args[0] === "--help" || args[0] === "-h") ||
    args.length === 2 && (args[0] === "review" || args[0] === "publish") && (args[1] === "--help" || args[1] === "-h")
}

function parseFlagValues(args: readonly string[], allowed: readonly string[]): Map<string, string> {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    if (key === undefined || !allowed.includes(key)) throw new Error("unknown option or positional argument")
    if (values.has(key)) throw new Error(`duplicate option ${key}`)
    const value = args[index + 1]
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${key}`)
    values.set(key, value)
    index += 1
  }
  return values
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key)
  if (value === undefined || value === "") throw new Error(`missing required option ${key}`)
  return value
}

function parseRepository(value: string): string {
  const parsed = repositoryNameSchema.safeParse(value)
  if (!parsed.success) throw new Error("--repository must be an owner/name pair")
  return parsed.data
}

function parsePullRequest(value: string): number {
  if (!/^[0-9]+$/u.test(value)) throw new Error("--pr must be a positive decimal number")
  const parsed = prNumberSchema.safeParse(Number(value))
  if (!parsed.success) throw new Error("--pr must be a positive decimal number")
  return parsed.data
}

export function parseCommand(argv: readonly string[]): Command {
  const args = normalizedArgs(argv)
  if (args.length === 0) throw new Error(HELP)
  if (args[0]!.startsWith("--")) return { kind: "review-local", input: parseReviewInput(args) }
  const [subcommand, ...flags] = args
  if (subcommand === "review") {
    const values = parseFlagValues(flags, ["--repository", "--pr", "--config", "--out"])
    const repository = parseRepository(required(values, "--repository"))
    const pr = parsePullRequest(required(values, "--pr"))
    const config = relativePathSchema.safeParse(values.get("--config") ?? "review.config.json")
    if (!config.success) throw new Error("--config must be a normalized relative path")
    return { kind: "review-pr", repository, pr, config: config.data, out: required(values, "--out") }
  }
  if (subcommand === "publish") {
    const values = parseFlagValues(flags, ["--repository", "--pr", "--package", "--review-job-result"])
    const result = jobResultSchema.safeParse(required(values, "--review-job-result"))
    if (!result.success) throw new Error("--review-job-result must be success, failure, cancelled, or skipped")
    return {
      kind: "publish",
      repository: parseRepository(required(values, "--repository")),
      pr: parsePullRequest(required(values, "--pr")),
      packageDirectory: required(values, "--package"),
      reviewJobResult: result.data,
    }
  }
  throw new Error(HELP)
}

function sanitizeCliError(error: unknown): string {
  let message = error instanceof Error ? error.message : "the command failed"
  for (const name of ["GITHUB_TOKEN", "REVIEW_MODEL_API_KEY"]) {
    const secret = process.env[name]
    if (secret !== undefined && secret !== "") message = message.replaceAll(secret, "[redacted]")
  }
  return message.replaceAll("::", ": :").replace(/[\r\n]+/gu, " ").slice(0, 2_000) || "the command failed"
}

async function runPrCommand(command: Extract<Command, { kind: "review-pr" }>): Promise<void> {
  const budget = createBudget(systemClock, 300_000)
  const executionContext = await readExecutionContext(process.env, budget, {}, { pr: command.pr })
  const github = createGitHubReader(process.env)
  const outcome = await runPrReview(command, {
    github,
    execution: executionContext.execution,
    progress: (event) => console.error(JSON.stringify(event)),
    modelIdentity: () => modelRecordSchema.parse({
      providerId: process.env.REVIEW_MODEL_PROVIDER_ID,
      modelId: process.env.REVIEW_MODEL_ID,
    }),
    model: () => loadModelConfiguration(),
    budget,
    productCommit: await readProductCommit(),
    ...(executionContext.attemptStartedAt !== null ? { attemptStartedAt: executionContext.attemptStartedAt } : {}),
  })
  console.log(JSON.stringify({
    runDirectory: outcome.runDirectory,
    outcome: outcome.outcome,
    handoffDirectory: outcome.handoffDirectory,
    artifactName: outcome.artifactName,
    replayExportDirectory: outcome.replayExportDirectory,
    replayIncomplete: outcome.replayIncomplete,
    omittedTraceBytes: outcome.omittedTraceBytes,
  }))
  process.exitCode = outcome.exitCode
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  if (isHelpOnlyCommand(argv)) {
    console.log(HELP)
    process.exit(0)
  }
  try {
    const command = parseCommand(argv)
    switch (command.kind) {
      case "review-local": {
        const run = await runReview(command.input)
        console.log(JSON.stringify({ runDirectory: run.runDirectory, result: run.artifacts.result }))
        if (run.artifacts.result.status === "failed") process.exitCode = 1
        break
      }
      case "review-pr":
        await runPrCommand(command)
        break
      case "publish":
        throw new Error("the publish command is outside this checkpoint")
    }
  } catch (error) {
    console.error(sanitizeCliError(error))
    process.exitCode = 1
  }
}
