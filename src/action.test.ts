import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { safeLoad } from "js-yaml"

test("the root composite preserves the fixed inputs, outputs, steps, and secret route", async () => {
  const action = safeLoad(await readFile(new URL("../action.yml", import.meta.url), "utf8"))
  expect(action).toEqual({
    name: "AI code review",
    description: "Review a fixed PR snapshot or publish its validated result",
    inputs: {
      mode: { description: "review or publish", required: true },
      config: { description: "Configuration path in the frozen base tree", default: "review.config.json" },
      pr: { description: "Pull request number", required: true },
      "model-api-key": { description: "Model credential used only by the review command step", default: "" },
    },
    outputs: Object.fromEntries(["status", "run-directory", "handoff-directory", "handoff-artifact", "replay-artifact", "comment-id"].map((name) => [name, { value: `\${{ steps.command.outputs.${name} }}` }])),
    runs: { using: "composite", steps: [
      { uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6", with: { "bun-version": "1.4.4" } },
      { name: "Install product dependencies", shell: "bash", "working-directory": "${{ github.action_path }}", run: "bun install --frozen-lockfile --ignore-scripts" },
      { name: "Run product command", id: "command", shell: "bash", env: {
        REVIEW_ACTION_MODE: "${{ inputs.mode }}", REVIEW_ACTION_CONFIG: "${{ inputs.config }}", REVIEW_ACTION_PR: "${{ inputs.pr }}",
        REVIEW_PRODUCT_DIRECTORY: "${{ github.action_path }}", REVIEW_PRODUCT_COMMIT: "${{ github.action_ref }}",
        REVIEW_MODEL_API_KEY: "${{ inputs.mode == 'review' && inputs.model-api-key || '' }}",
      }, run: 'bun --no-env-file run "$GITHUB_ACTION_PATH/src/action-entry.ts"' },
    ] },
  })
})
