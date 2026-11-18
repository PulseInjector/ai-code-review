import type { ReviewInput } from "./context"
import { runReview } from "./review"

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

if (import.meta.main) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("usage: bun run review -- --repo <path> --base <revision> --head <revision> --out <new-directory>")
    process.exit(0)
  }
  try {
    const run = await runReview(parseReviewInput(process.argv.slice(2)))
    console.log(JSON.stringify({ runDirectory: run.runDirectory, result: run.artifacts.result }))
    if (run.artifacts.result.status === "failed") process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
