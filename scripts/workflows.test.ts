import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { safeLoad } from "js-yaml"
import { gitShaSchema } from "../src/identity"
import { renderCallerWorkflow, renderReusableWorkflow } from "./workflows"

const actionCommit = gitShaSchema.parse("ac913ef997c5a40cd5010a32e0a9ad854b9a998a")
const workflowCommit = gitShaSchema.parse("1234567890abcdef1234567890abcdef12345678")

test("the reusable workflow preserves the two-job privilege boundary and failure evidence", () => {
  expect(safeLoad(renderReusableWorkflow(actionCommit))).toEqual({
    name: "Reliable PR review",
    on: {
      workflow_call: {
        inputs: {
          pr: { type: "string", required: true },
          config: { type: "string", default: "review.config.json" },
          "model-provider-id": { type: "string", required: true },
          "model-base-url": { type: "string", required: true },
          "model-id": { type: "string", required: true },
        },
        secrets: { "model-api-key": { required: true } },
      },
    },
    permissions: {},
    concurrency: {
      group: "ai-code-review-v1-${{ github.repository_id }}-pr-${{ inputs.pr }}",
      "cancel-in-progress": false,
    },
    jobs: {
      review: {
        "runs-on": "ubuntu-24.04",
        "timeout-minutes": 8,
        permissions: { contents: "read", "pull-requests": "read", actions: "read" },
        steps: [
          {
            name: "Review current PR",
            id: "review",
            uses: "PulseInjector/ai-code-review@ac913ef997c5a40cd5010a32e0a9ad854b9a998a",
            with: {
              mode: "review",
              config: "${{ inputs.config }}",
              pr: "${{ inputs.pr }}",
              "model-api-key": "${{ secrets.model-api-key }}",
            },
            env: {
              GITHUB_TOKEN: "${{ github.token }}",
              REVIEW_MODEL_PROVIDER_ID: "${{ inputs.model-provider-id }}",
              REVIEW_MODEL_BASE_URL: "${{ inputs.model-base-url }}",
              REVIEW_MODEL_ID: "${{ inputs.model-id }}",
            },
          },
          {
            name: "Upload publication handoff",
            if: "${{ always() && !cancelled() }}",
            id: "handoff",
            uses: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
            with: {
              name: "ai-code-review-handoff-${{ github.run_id }}-${{ github.run_attempt }}",
              path: "${{ runner.temp }}/ai-code-review-${{ github.run_id }}-${{ github.run_attempt }}/handoff/",
              "if-no-files-found": "warn",
              "retention-days": 7,
            },
          },
          {
            name: "Upload replay evidence",
            if: "${{ always() && !cancelled() }}",
            uses: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
            with: {
              name: "ai-code-review-replay-${{ github.run_id }}-${{ github.run_attempt }}",
              path: "${{ runner.temp }}/ai-code-review-${{ github.run_id }}-${{ github.run_attempt }}/replay-export/",
              "if-no-files-found": "warn",
              "retention-days": 7,
            },
          },
        ],
      },
      publish: {
        needs: "review",
        if: "${{ always() && !cancelled() }}",
        "runs-on": "ubuntu-24.04",
        "timeout-minutes": 4,
        permissions: { contents: "read", "pull-requests": "write", actions: "read" },
        steps: [
          {
            name: "Download this execution's handoff",
            id: "download",
            "continue-on-error": true,
            uses: "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
            with: {
              name: "ai-code-review-handoff-${{ github.run_id }}-${{ github.run_attempt }}",
              path: "${{ runner.temp }}/ai-code-review-download",
            },
          },
          {
            name: "Publish validated feedback",
            if: "${{ !cancelled() }}",
            uses: "PulseInjector/ai-code-review@ac913ef997c5a40cd5010a32e0a9ad854b9a998a",
            with: { mode: "publish", config: "${{ inputs.config }}", pr: "${{ inputs.pr }}" },
            env: {
              GITHUB_TOKEN: "${{ github.token }}",
              REVIEW_JOB_RESULT: "${{ needs.review.result }}",
              REVIEW_DOWNLOAD_OUTCOME: "${{ steps.download.outcome }}",
            },
          },
          {
            name: "Upload publication evidence",
            if: "${{ always() && !cancelled() }}",
            uses: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
            with: {
              name: "ai-code-review-publish-${{ github.run_id }}-${{ github.run_attempt }}",
              path: "${{ runner.temp }}/ai-code-review-${{ github.run_id }}-${{ github.run_attempt }}/publish-evidence/",
              "if-no-files-found": "warn",
              "retention-days": 7,
            },
          },
        ],
      },
    },
  })
})

test("the caller pins the workflow and passes one explicit secret without another concurrency owner", () => {
  expect(safeLoad(renderCallerWorkflow(workflowCommit))).toEqual({
    name: "Code review",
    on: {
      pull_request: { types: ["opened", "synchronize", "reopened", "ready_for_review", "edited"] },
      workflow_dispatch: {
        inputs: { pr: { description: "Pull request number to review", type: "string", required: true } },
      },
    },
    permissions: { contents: "read", "pull-requests": "write", actions: "read" },
    jobs: {
      review: {
        uses: "PulseInjector/ai-code-review/.github/workflows/review.yml@1234567890abcdef1234567890abcdef12345678",
        with: {
          pr: "${{ github.event.pull_request.number && format('{0}', github.event.pull_request.number) || inputs.pr }}",
          config: "review.config.json",
          "model-provider-id": "${{ vars.REVIEW_MODEL_PROVIDER_ID }}",
          "model-base-url": "${{ vars.REVIEW_MODEL_BASE_URL }}",
          "model-id": "${{ vars.REVIEW_MODEL_ID }}",
        },
        secrets: { "model-api-key": "${{ secrets.REVIEW_MODEL_API_KEY }}" },
      },
    },
  })
})

for (const { name, render, occurrences } of [
  { name: "reusable", render: renderReusableWorkflow, occurrences: 2 },
  { name: "caller", render: renderCallerWorkflow, occurrences: 1 },
]) {
  test(`${name} generation is byte-identical for the same commit and pins each supplied commit literally`, () => {
    for (const commit of [actionCommit, workflowCommit]) {
      const first = render(commit)
      expect(Buffer.from(render(commit))).toEqual(Buffer.from(first))
      expect(first.match(new RegExp(`@${commit}(?=\\n)`, "g"))).toHaveLength(occurrences)
      expect(first).not.toContain(commit === actionCommit ? workflowCommit : actionCommit)
      expect(first).toEndWith("\n")
      expect(first).not.toContain("\r")
    }
  })
}

test("the committed reusable workflow is the exact generated output for Action A", async () => {
  const committed = await readFile(new URL("../.github/workflows/review.yml", import.meta.url))
  expect(committed).toEqual(Buffer.from(renderReusableWorkflow(actionCommit)))
})
