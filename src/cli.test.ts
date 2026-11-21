import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { isHelpOnlyCommand, parseCommand, parseReviewInput, reviewPrSummaryLine } from "./cli"

const localArgs = ["--repo", "/tmp/java review", "--base", "main", "--head", "defect", "--out", "/tmp/review-1"]

test("the legacy local invocation retains its parsed shape", () => {
  expect(parseCommand(["--", ...localArgs])).toEqual({
    kind: "review-local",
    input: { repo: "/tmp/java review", base: "main", head: "defect", out: "/tmp/review-1" },
  })
  expect(parseReviewInput(localArgs)).toEqual({ repo: "/tmp/java review", base: "main", head: "defect", out: "/tmp/review-1" })
})

test("the PR command parses a default config and an explicit config", () => {
  expect(parseCommand(["review", "--repository", "PulseInjector/java-review", "--pr", "17", "--out", "/tmp/review-17"])).toEqual({
    kind: "review-pr", repository: "PulseInjector/java-review", pr: 17, config: "review.config.json", out: "/tmp/review-17",
  })
  expect(parseCommand(["review", "--repository", "PulseInjector/java-review", "--pr", "18", "--config", "config/review.json", "--out", "/tmp/review-18"]))
    .toMatchObject({ kind: "review-pr", pr: 18, config: "config/review.json" })
})

test("the publish grammar is parsed without dispatching publication", () => {
  expect(parseCommand([
    "publish", "--repository", "PulseInjector/java-review", "--pr", "17", "--package", "/tmp/handoff", "--review-job-result", "failure",
  ])).toEqual({
    kind: "publish", repository: "PulseInjector/java-review", pr: 17, packageDirectory: "/tmp/handoff", reviewJobResult: "failure",
  })
})

test.each([
  ["unknown option", ["review", "--repository", "o/r", "--pr", "1", "--out", "/tmp/out", "--extra", "x"]],
  ["duplicate option", ["review", "--repository", "o/r", "--repository", "o/r", "--pr", "1", "--out", "/tmp/out"]],
  ["missing option value", ["review", "--repository", "o/r", "--pr", "1", "--out"]],
  ["positional extra", ["review", "--repository", "o/r", "--pr", "1", "--out", "/tmp/out", "extra"]],
  ["zero PR", ["review", "--repository", "o/r", "--pr", "0", "--out", "/tmp/out"]],
  ["negative PR", ["review", "--repository", "o/r", "--pr", "-1", "--out", "/tmp/out"]],
  ["local and PR options", ["--repo", "/tmp/repo", "--base", "main", "--head", "fix", "--out", "/tmp/out", "--repository", "o/r"]],
  ["review and publish options", ["review", "--repository", "o/r", "--pr", "1", "--out", "/tmp/out", "--package", "/tmp/pkg"]],
])("rejects %s", (_name, argv) => {
  expect(() => parseCommand(argv)).toThrow()
})

test("help is recognized only as a help-only command", () => {
  expect(isHelpOnlyCommand(["--", "--help"])).toBe(true)
  expect(isHelpOnlyCommand(["review", "-h"])).toBe(true)
  expect(isHelpOnlyCommand(["review", "--help", "--repository", "o/r"])).toBe(false)
})

test("a handled PR outcome serializes as one JSON summary line", () => {
  const line = reviewPrSummaryLine({
    outcome: { kind: "failed", failure: { code: "github-unavailable", stage: "capture", message: "read failed" }, snapshot: null },
    runDirectory: "/tmp/review-17",
    handoffDirectory: null,
    replayExportDirectory: null,
    replayIncomplete: true,
    omittedTraceBytes: 0,
    artifactName: null,
    exitCode: 1,
  })
  expect(line.split(/\r?\n/u)).toHaveLength(1)
  expect(JSON.parse(line)).toMatchObject({ outcome: { kind: "failed" }, replayIncomplete: true, omittedTraceBytes: 0 })
})

async function invoke(...args: string[]) {
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url))
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], {
    env: { ...process.env, GITHUB_TOKEN: "cli-test-sentinel" }, stdout: "pipe", stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

test("help exits before reading credentials", async () => {
  const result = await invoke("review", "--help")
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("--repository <owner/name>")
  expect(result.stderr).toBe("")
})

test("the legacy local help text stays unchanged", async () => {
  const result = await invoke("--help")
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe("usage: bun run src/cli.ts --repo <path> --base <revision> --head <revision> --out <new-directory>\n")
})

test("invalid CLI input writes a sanitized error and no JSON summary", async () => {
  const result = await invoke("review", "--unknown", "cli-test-sentinel")
  expect(result.exitCode).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).not.toContain("cli-test-sentinel")
})

test.each(["017", "00017", "+17", "17.0", " 17", "17 "])("noncanonical PR text %s rejects at both command boundaries", (pr) => {
  expect(() => parseCommand(["review", "--repository", "o/r", "--pr", pr, "--out", "/tmp/out"])).toThrow()
  expect(() => parseCommand(["publish", "--repository", "o/r", "--pr", pr, "--package", "/tmp/pkg", "--review-job-result", "success"])).toThrow()
})
