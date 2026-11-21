import type { Drive } from "./cli"

type Journey = { name: string; files: string[] }

const journeys: Journey[] = [
  { name: "pr-review-handoff", files: ["src/cli.test.ts", "src/pr-review.test.ts", "src/handoff.test.ts"] },
  { name: "handoff-admission", files: ["src/handoff.test.ts", "src/github.test.ts", "src/publish.test.ts"] },
  { name: "publish-comments", files: ["src/comment.test.ts", "src/publish.test.ts", "src/github.test.ts"] },
]

export async function verifyGithubCli(drive: Drive): Promise<void> {
  for (const journey of journeys) {
    const result = await drive(`github-${journey.name}`, [process.execPath, "test", ...journey.files])
    if (result.exitCode !== 0) throw new Error(`${journey.name} failed; inspect its saved stdout and stderr`)
  }
  const composite = await drive("github-action-composite", [process.execPath, "run", "src/verification/action-cli.ts"])
  if (composite.exitCode !== 0) throw new Error("the composite-equivalent Action runner failed; inspect its command logs")
}
