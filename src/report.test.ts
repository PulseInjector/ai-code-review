import { expect, test } from "bun:test"
import { createRunArtifacts, renderMarkdown } from "./report"
import type { ContextManifest } from "./context"

const sha = "a".repeat(40)
const context: ContextManifest = {
  snapshot: { baseSha: sha, headSha: "b".repeat(40), mergeBaseSha: sha },
  status: "complete",
  limits: { maxChangedFiles: 50, maxPatchBytes: 262144, maxSnapshotBytes: 8388608 },
  files: [],
  changes: [{ status: "M", newPath: "src/A.java", included: true }],
  coverage: { includedPaths: ["src/A.java"], omittedPaths: [] },
}

const common = {
  context,
  runId: "run-1",
  durationMs: 150,
  programVersion: "0.1.0",
  sdkVersion: "2.2.7",
  configHash: "a".repeat(64),
}

test("renders a complete zero-finding review with explicit snapshot and coverage", () => {
  const artifacts = createRunArtifacts(common)
  expect(artifacts.result.status).toBe("complete")
  expect(artifacts.markdown).toContain(`base \`${sha}\``)
  expect(artifacts.markdown).toContain("No verified findings.")
  expect(artifacts.markdown).toContain("Included paths: 1.")
})

test("marks omitted material partial and model errors failed without publishing issues", () => {
  const partial = createRunArtifacts({ ...common, context: { ...context, status: "partial", coverage: { includedPaths: [], omittedPaths: ["src/A.java"] } } })
  expect(partial.result.status).toBe("partial")
  expect(partial.markdown).toContain("src/A.java")

  const failed = createRunArtifacts({ ...common, error: { stage: "discovery", message: "model unavailable" } })
  expect(failed.result.status).toBe("failed")
  expect(failed.result.stageErrors[0]?.stage).toBe("discovery")
  expect(renderMarkdown(failed.result)).toContain("model unavailable")
})
