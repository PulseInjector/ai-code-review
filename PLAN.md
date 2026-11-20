# Project plan

This document is the product plan for the review tool. It records the scope,
the implementation steps, and the acceptance criteria for each feature segment.
`CONTRIBUTING.md` covers the change workflow. `ENVIRONMENT.md` covers the
toolchain, the commands, and the model configuration.

This plan holds scope and acceptance. It does not track pull request status.
Current progress lives in "Current state" and in the pull requests on `main`.

## Current state

Segment 1, one complete local review, is merged. Pull request #3 added the
review command and the reports. Pull request #5 added the verification CLI and
the project skill.

Stage-one acceptance passed on 2026-11-18. The defect case published one
verified finding. The guarded case published none. The incomplete-material
case reported partial coverage. `bun run smoke:review` reruns the three live
cases.

Segment 2, GitHub PR feedback, is next. It has not started.

## Goal and scope

Ship a reviewable, attachable GitHub PR review product. A developer pushes
changes and receives a report of functional defects with code evidence. After a
fix or a written disposition, the next review follows up on the same numbered
issue. A maintainer can replay fixed cases, compare versions, and publish
improvements.

The delivery includes the review program, an Action with a reusable workflow,
the prompts, fixed cases with an eval program, the onboarding docs, and a
record of one independent user completing onboarding and a fix loop.

The scope is fixed to collaborator branches in one repository and to ordinary
functional correctness. A self-built Java repository provides acceptance.
TypeScript orchestrates the product. OpenCode v2.2.7 runs the model and the tool
loop. GitHub Actions executes. One PR summary comment holds the current issue
state, and run artifacts hold the detailed records.

The first release assists human review. It is not a merge gate. Automatic
fixes, generated tests, production deployment monitoring, fork PRs, multi-model
voting, cross-repository indexing, and a standalone backend are out of scope.
The eval program runs self-built cases. Reviewing a user PR only reads code and
existing tests.

## Verified technical baseline

On 2026-11-13, a local checkout of `opencode` at tag v2.2.7, commit
`fedc6f208aa2bd54c1019227214568083f6380ad`, was read directly. The tag source,
the official docs in that repository, and the npm version metadata support the
embedded integration described below. Third-party search results for OpenCode
mix in old versions, so no such example decided an interface here.

The product uses `@opencode/sdk@2.2.7`. The older `@opencode-ai/sdk/v2` entry
from early drafts was replaced in segment 1. Source citations in this plan, such
as `packages/core/src/config/discovery.ts:26`, are package paths relative to
that v2.2.7 checkout.

## Segment overview

Build the segments in order. Each segment states its goal, its steps, and its
acceptance. Later segments reuse the earlier entry points.

| Order | Deliverable |
| --- | --- |
| 1. One real review locally | Fixed commits, tool-assisted reading, discovery and verification, a local report, and a replayable run. |
| 2. Reliable feedback on a PR | Automatic and manual triggers, one summary comment, failure and partial feedback, stale handling, and retries. |
| 3. Incremental review and fix follow-up | Stable issue numbers, incremental checkpoints, per-issue rechecks, author dispositions, and recovery. |
| 4. Compare quality and tune prompts and models | A fixed-case eval, a paired verification control, one real prompt change, and a model comparison. |
| 5. Release and independent onboarding | A versioned release, one independent user, measured results, and recorded evidence. |

## Segment 1: one real review locally

### Goal

A developer supplies a local Git repository and a base and head commit, then
receives a review report with trigger conditions, consequences, and code
locations, plus the scope that was not reviewed. At least one cross-file
defect, one protected normal change, and one insufficient-material case must
run end to end. This segment is local only. The later PR integration reuses
the same review entry.

### Steps

1. **Start from the entry point and executable cases.** Create the repository
   with Bun 1.4.4 and TypeScript. Pin `@opencode/sdk` and `@opencode/plugin`
   to 2.2.7 and commit the lockfile. Create `src/cli.ts`, `src/contracts.ts`,
   `src/context.ts`, `src/review.ts`, `src/runtime/opencode-v227.ts`,
   `src/runtime/worker.ts`, `src/runtime/context-limits.ts`, and
   `src/report.ts`, and point the `review` script at the CLI.
   `contracts.ts` defines the data types and one boundary validation layer.
   Parse the input into internal types once, and do not revalidate it in every
   layer.

   Build the case repository in `fixtures/java-review/`. A service method
   changes an empty-result branch from returning an empty collection to
   returning `null`, while an unchanged caller still iterates the result. A
   Java assertion program proves that the base passes, the defect head fails,
   and the fix passes. A guarded branch with a null-checked caller is a normal
   change. Record the commit SHAs, the business rule, and the test outputs.
   Truth labels live in `evals/labels/` and never enter the model material.

2. **Define the minimum data that flows through, then prepare the snapshot.**
   `Snapshot` holds `baseSha`, `headSha`, and `mergeBaseSha`. Add the repository
   ID, the PR number, and the run ID and attempt after the GitHub integration.
   `Candidate` holds a candidate ID, the change location, a trigger, a
   consequence, a root-cause claim, and code citations. `Verification` returns
   `keep`, `reject`, or `unknown` for each candidate, with a reason and
   evidence. `ReviewResult` holds the snapshot, one of
   `complete`, `partial`, `failed`, or `skipped`, the verified issues,
   coverage, stage errors, usage, and versions. A citation carries the snapshot
   side, a relative path, start and end lines, and a short excerpt. A Markdown
   link alone is not a citation.

   `context.ts` resolves both revisions to commit SHAs, computes the merge
   base, and uses Git file lists and per-file diffs to prepare the material.
   The discovery range is `mergeBase → head`, and the current base branch SHA
   is recorded separately. The material is built from Git objects into
   `material/merge-base/`, `material/head/`, and `material/patches/`. The
   user's worktree is never the run directory. Keep rename and deletion
   information. Copy plain text files only, and exclude binaries, symlinks,
   secret-like files, and runtime configuration directories. The target
   repository's `.opencode`, `.agents`, and `.claude` directories and its
   `AGENTS.md` never sit in an auto-discoverable location. Review instructions
   are read from the fixed base and passed in as explicitly sourced material.

   The initial limits live in `review.config.json`: at most 50 changed text
   files, 256 KiB of patches, and 8 MiB of searchable snapshot text. Include
   files in a fixed order: changed files first, then same-directory source
   files, then other paths, sorted. The full file list is always kept. When a
   limit trips, write the included and omitted lists and mark the run
   `partial`. Never call silent truncation a complete input. Normalize real
   paths and keep no symlinks.

3. **Embed the v2.2.7 SDK in a child process.** `cli.ts` calls `review.ts`,
   which starts the clock and then starts `worker.ts`. The child process owns
   the SDK host for one run and creates the discovery session and then the
   verification session. The parent process owns the total deadline and the
   result files, so an explicit terminal state exists even after the child
   exits. After the first install, run a no-model import, create, and close
   check before any model work. That check is the first integration
   acceptance.

   `opencode-v227.ts` uses the public Promise SDK entry with one argument:

   ```ts
   import { OpenCode } from "@opencode/sdk"

   const host = await OpenCode.create({
     config: {
       directory: runConfigDir,
       project: false,
       claude: false,
       content: JSON.stringify(reviewConfig),
     },
     fs: { filewatcher: false },
     plugins: [contextLimitsPlugin],
   })
   ```

   The variables come from the implementation, and `contextLimitsPlugin`
   follows step 5. Before startup, give the child its own HOME, XDG, and
   config directories for this run. Assemble the PATH, the needed system
   environment, and the model key explicitly. Never inherit the host's
   `OPENCODE_*` values, existing authentication, or connection configuration.
   The first version supports macOS local development and Linux CI. The
   preflight reads these system config sources: `/etc/opencode` on Linux, and
   on macOS `/Library/Application Support/opencode`,
   `/Library/Managed Preferences/<user>/ai.opencode.managed.plist`, and
   `/Library/Managed Preferences/ai.opencode.managed.plist`. If a loadable
   system config exists, fail with "a clean environment is required" and exit.
   Never delete the host configuration.

   `reviewConfig` uses the V2 `permissions` rule array: first
   `action:"*", resource:"*", effect:"deny"`, then allow `read`, `grep`, and
   `glob`. Pass the same set at session creation. Set `agents.build.steps` to
   12, `plugins` to `["-opencode.config.instruction"]`, `snapshots` to `false`,
   and `share` to `"disabled"`. Keep the built-in plugin that provides the
   three code tools. Do not use `plugins: ["-*"]`. For permission rules the
   later match wins, so reads outside the directory stay denied.

   Isolation comes from the clean environment, the disabled project config,
   and the read-only snapshot together. `config.directory` does not disable
   system config by itself, and the public `OpenCode.create` takes no second
   `overrides` argument. The built-in `read` tool can still discover a nearby
   `AGENTS.md`, so the material directory excludes auto-loadable instructions
   and the needed rules are passed in explicitly. Sources:
   `packages/sdk/src/opencode.ts:10`,
   `packages/core/src/config/discovery.ts:26`,
   `packages/core/src/tool/plugin/read.ts:129`.

4. **Complete one session lifecycle, then reuse it for both phases.** The
   default connection is an OpenAI-compatible provider. The parent maps
   `REVIEW_MODEL_API_KEY` from the caller to `OPENAI_API_KEY` in the worker,
   and the worker checks that it is nonempty. Add
   `providers: { openai: { settings: { apiKey: "{env:OPENAI_API_KEY}" } } }`
   to `reviewConfig`. The substitution happens in memory at runtime, and the
   parsed configuration is never printed.

   The model ID is named explicitly. Check it against the list from
   `host.model.list({ location: { directory: materialRoot }, types: ["chat"] })`:
   the entry must have the expected provider ID, the exact model ID, and
   enabled status. Never guess a model or silently take the first one. The
   list only proves the model is enabled in the runtime directory. The first
   model call proves real API access. An authentication or model error fails
   the run outright.

   Create each session with
   `host.sessions.create({ location: { directory: materialRoot }, model: { providerID, id: modelID }, permissions })`.
   Create discovery and verification separately. Never fork one from the
   other, because a fork inherits reasoning.

   Subscribe to `host.events.subscribe(...)` and wait for the connection
   before calling `host.sessions.prompt({ sessionID, text })`. The
   subscription is lazy, so holding the iterator does not mean listening.
   Read `event.data` and watch `session.status`. Events only wake the reader
   and show progress. The prompt call returns acceptance, not the result.

   Page through `host.message.list({ sessionID, order: "asc", cursor })` to
   find the `type: "idle"` message after this input, and check that
   `outcome` is `succeeded`, `failed`, or `interrupted`. Poll once per second
   as a backstop for missed events. The idle state at session creation never
   counts as success. On success, take the last assistant text before the
   terminal state, check for assistant and idle errors, and read the
   cumulative usage from `host.sessions.get({ sessionID })`. Per-step messages
   serve phase analysis and cumulative fields serve the totals. Never add
   both. In `finally`, cancel the event subscription and `await host.close()`.
   Sources: `packages/client/src/promise/generated/types.ts:3328` and `:3920`,
   `packages/client/src/promise/generated/client.ts:1749`,
   `packages/schema/src/session-message.ts:291`, and the same-version official
   SDK docs at `services/site/src/docs/content/build/sdk/index.mdx`.

5. **Write the first prompts so that tool reading follows evidence.**
   `prompts/discover.md` receives the change description, the file list, the
   diffs, the snapshot paths, and the review conventions. The task is to find
   functional defects introduced or exposed by this change, with a possible
   trigger, a consequence, and code citations. The model uses `glob` to find
   files, `grep` to find symbols and calls, and `read` to confirm the
   implementation. The program never hardcodes a call order.
   `prompts/verify.md` receives the same snapshot and the structured
   candidate claims only. It checks caller protections, complete branches,
   existing behavior, and counter-evidence for each candidate. It never
   receives the discovery session's reasoning.

   The first version uses "the final text is exactly one JSON object" plus
   `JSON.parse` and application-level field validation. The v2.2.7 prompt
   contract has no `json_schema` parameter, so this is not server-enforced
   structured output. A refusal, incomplete output, or a structure error is a
   failure. Never auto-repair JSON and never run a secret extra round. At
   most 8 candidates enter, and at most 5 new issues publish. The excess and
   any candidate left unverified by the budget go into coverage.
   Insufficient material yields `unknown`, which never publishes.

   `context-limits.ts` registers a product plugin with
   `Plugin.define({ id: "review.context-limits", setup })` and passes it as
   an SDK `plugins` argument. An `execute.before` hook on `read`, `grep`, and
   `glob` clamps `event.input.limit` to 1 through 100 and sets it to 100 when
   absent. It keeps `read`'s offset so the next call can continue. An
   `execute.after` hook caps each text return at 32 KiB and the whole run at
   512 KiB of reads, counted in UTF-8 bytes, trimmed on whole lines with room
   left for the truncation note. The cumulative budget is decremented in a
   synchronous callback on shared worker state, so parallel tool calls cannot
   overshoot. The hook replaces `event.result.content`, clears the old
   `output`, sets `metadata.truncated: true`, appends a truncation note naming
   the unreturned range, and writes to the parent-visible coverage record.
   When the budget is exhausted, the before hook throws an explicit
   tool-budget error and tells the orchestrator to stop.

   A limit applying is not the same as a truncation. Record uncovered only
   when the native tool reported a truncation, the hook actually clipped, or
   the cumulative budget was reached. Offset continuation stays allowed, and
   the report names the requests never completed. Truncated model JSON output
   is still an invalid result. The plugin setup returns a cleanup function
   that disposes both hook registrations, and the SDK close releases its
   scope. The built-in tools still do the actual reads and searches, so the
   product writes no tool loop of its own. `tool_output` is not a uniform
   hard cap for built-in tools with truncation metadata, which is why the
   explicit hooks exist. Sources: `packages/plugin/src/promise/tool.ts:38`,
   `packages/core/src/tool.ts:175`,
   `packages/core/src/tool-output.ts:69`.

6. **The program checks the results and writes the report.** `review.ts` runs
   prepare, discover, validate candidates, verify, and assemble. It checks
   that candidate IDs cover everything, that citations point at the fixed
   snapshot with existing lines, that excerpts match exactly, and that field
   lengths and states are legal. Group duplicate candidates by file, symbol,
   and root cause, and never force an uncertain merge. `report.ts` writes
   JSON and Markdown: the commits, the issues with evidence, the uncovered
   scope, the run result, the duration, and the usage. Issues excluded by the
   five-issue cap are recorded, never counted as nonexistent.

   The whole run has one 300-second budget covering preparation, worker
   initialization, both sessions, and cleanup. External Git commands share
   the remaining deadline and the parent can stop them. The tool step count
   and the model request count are different measures. `agents.build.steps`
   caps the tool loop, and one final summary request may still follow. Ten
   seconds before the total deadline the parent requests a worker interrupt.
   The cleanup grace fits inside 300 seconds. If the absolute deadline
   passes, the parent kills the process group, and unsettled usage is marked
   unknown. Segments 2 and 3 reuse this mechanism for their phase budgets.
   Source: `packages/core/src/session/runner/llm.ts:256`.

7. **Keep replay records in the run artifacts.** Each run writes
   `manifest.json`, the snapshots and input list, the candidates, the
   verifications, the tool trace, the final result, the phase timings, and
   the versions to `runs/<runId>/`. The prompt bodies live in versioned files
   and the artifacts record their hashes. Secrets never enter a file. Keep
   actual failures and the runs before and after a fix, for tuning and for
   diagnosing hard cases.

   The command contract is
   `bun run review -- --repo <fixture-path> --base <SHA> --head <SHA> --out <run-dir>`.
   `cli.ts` parses the arguments, and Git operations run through argument
   arrays, never through concatenated shell text.

### Acceptance

| Input or action | Expected result | Evidence |
| --- | --- | --- |
| Install the pinned dependencies, create and close the SDK, then run the defect base and head. | The SDK exits. The cross-file defect reaches the report through discovery and verification, and its citations jump to real code at fixed commits. | Lockfile, exit codes, candidate and verification JSON, tool trace, report. |
| Run the normal variant with a protected caller. | The report has no defect for it. If discovery raised it, verification gives the exclusion reason. | Base and head code, the matching candidate, the verification reason. |
| Delete a key caller file, or lower the material limits. | The report says insufficient material or partial. A zero-issue report never stands in for a complete pass. | `manifest.json`, coverage, final report. |
| Make a test adapter return invalid JSON, a missing candidate ID, or an out-of-range citation. | The application rejects the invalid result, the error names the stage, and no fabricated location is published. | Orchestration behavior tests, failure results. |
| Use a fixture with a sentinel plugin, an `AGENTS.md`, and an out-of-directory reference, then trigger a timeout. | The target repository's plugin stays inactive, `AGENTS.md` enters only as explicit material, the out-of-directory read is denied, the over-limit tool returns an explicit marker, and the child exits by the total deadline. | SDK integration tests, plugin marker checks, exit and usage records. |

Model output is not identical every run. When a defect or a normal case
misses its expected outcome, locate the fault in the input, the discovery, or
the verification, fix it, and rerun the acceptance. Keep the failed records.
Deterministic tests check the engineering contract, and live calls check the
model capability.

### Stage-one development checkpoints

The feature segment above remains the source for product behavior. Segment 1
uses `feat/local-review`, created from `main`, as its integration branch.
Complete the checkpoints in order on that branch, using local task branches
when they help. Verify each checkpoint before starting the next. No
checkpoint requires an Issue or a pull request.

| Checkpoint | Scope | Depends on | Acceptance evidence |
| --- | --- | --- | --- |
| 1. Cases and contracts | Create the Java Git cases, the review data contracts, boundary validation, and the deterministic test entry point. Keep truth labels separate from model input. | None | Java assertions show the base passes, the defect commit fails, the fix passes, and the guarded variant passes. The model material contains no labels. |
| 2. Input and snapshots | Parse CLI inputs. Resolve fixed commits and the merge base. Build file manifests, diffs, and searchable snapshots. Enforce exclusions and size limits. | Checkpoint 1 | Temporary-repository tests cover fixed-SHA behavior, rename, deletion, binary and symlink exclusion, and a partial manifest when limits are exceeded. |
| 3. Controlled model runtime | Add the isolated SDK worker, the model configuration, session completion, read limits, timeout, interruption, and cleanup. | Checkpoint 1 | SDK lifecycle and isolation checks pass. A configured live model call completes. Failure and timeout produce explicit results and release resources. |
| 4. Discovery and verification | Use the snapshot through separate discovery and verification sessions. Validate candidates, citations, and keep, reject, and unknown decisions before publication. | Checkpoints 2 and 3 | Deterministic tests reject malformed JSON, missing candidate IDs, and invalid citations. A guarded caller cannot become a confirmed defect. |
| 5. Review command and report | Connect the full command and produce JSON, Markdown, coverage information, and replayable run artifacts. | Checkpoint 4 | Run the real command on the defect, guarded, and insufficient-material cases. Inspect the report, the code evidence, the coverage, and the process exit. |

For checkpoint 3, the repository configuration in `ENVIRONMENT.md` is
authoritative: `REVIEW_MODEL_PROVIDER_ID`, `REVIEW_MODEL_BASE_URL`,
`REVIEW_MODEL_ID`, and `REVIEW_MODEL_API_KEY`. The smoke check uses an
OpenAI-compatible endpoint. This wording supersedes any older provider text,
and the implementation must not silently narrow the supported configuration.

Run the full stage-one acceptance on `feat/local-review` after all five
checkpoints. Stage one finishes only when the real model run produces a report
with verifiable code evidence for the cross-file defect, does not publish the
guarded variant as a confirmed issue, exposes incomplete coverage or a
failure, and closes its worker within the run budget. Only after that
acceptance passes, open one pull request from the integration branch to
`main`. Missing model credentials leave the live acceptance criteria open.

## Segment 2: reliable feedback on a PR

### Goal

A PR that is opened, updated, reopened, or marked ready gets reviewed
automatically, and a maintainer can rerun a review manually. The author sees
progress in Actions and the final feedback in one PR summary comment. A
failure, a partial completion, and a stale result are each distinguishable.
Every run still reviews the full PR. Cross-run issue identity arrives in
segment 3.

### Steps

1. **Connect the local entry to real PRs.** Add `src/github.ts` and
   `src/publish.ts`, and extend the CLI with `review/publish`.
   `review --repository owner/repo --pr N` re-queries the PR at start and
   saves the repository ID, the PR number, the current base, head, and merge
   base, the trigger time, the actual start time, and the workflow run ID and
   attempt. It reads the previous product comment as the old-report backup.
   Take the head from the API, never from the event payload or the Actions
   default merge ref. Draft, closed, and fork PRs produce `skipped` with a
   reason.

   Fetch the fixed objects into a dedicated directory, reusing segment 1's
   Git export and snapshot logic. Read the product configuration from the
   frozen base, so a PR edit to configuration cannot change this run's
   rules. First create a real PR on the self-built Java repository, run the
   same `review` entry, and confirm the artifacts match the local run.

2. **Build the two-job workflow.** Add the root `action.yml`, a composite
   Action with `mode`, `config`, and `pr` inputs that calls the fixed product
   program, and `.github/workflows/review.yml`, a `workflow_call` workflow
   that takes the PR number, the model configuration, and one model secret.
   The review job gets `contents: read` and `pull-requests: read`, and the
   model secret goes only to the review step. The publish job gets its read
   permissions plus `pull-requests: write`, receives no model secret, and
   runs no model. Put the caller event workflow in `examples/caller.yml`,
   with `pull_request` types `opened`, `synchronize`, `reopened`,
   `ready_for_review`, and `edited`, plus a `workflow_dispatch` PR input.

   The composite Action locates the product directory through
   `GITHUB_ACTION_PATH`, installs the pinned Bun, runs
   `bun install --frozen-lockfile` there, and calls the CLI. The target
   repository goes into a separate input directory. The product program comes
   from a fixed product commit, and PR content only generates analysis
   material. A same-named script in the PR workspace never runs. Commit the
   runnable Action first, then the reusable workflow that references it, and
   have callers pin the workflow commit. GitHub's reusable-workflow rules for
   inputs, secrets, permission inheritance, and artifact handoff follow the
   official docs.

3. **Define one handoff package per run.** The review job produces
   `review-result.json` and `run-manifest.json`, and the artifact name
   contains the run ID and attempt. The manifest holds the repository, PR,
   and commits, the program and runtime versions, the prompt and config
   hashes, the model identifier, and the result-file digests. Detailed
   traces are stored separately. The upload step also runs when the review
   job fails.

   The publish job downloads only this run's artifact, then validates its
   identity, SHAs, schema, size, and citations. A digest alone never makes an
   arbitrary artifact trusted. The publish job waits with `needs` and runs
   when the review failed but the workflow was not cancelled. When no
   artifact exists, it writes a failure note from `needs.review.result`.
   Normal-failure tests must cover this branch. A handled failure still
   leaves Actions in a failed state, so writing the note never turns the
   review job green. A missing valid artifact and "the model returned zero
   issues" are two different outcomes.

4. **Translate run states into feedback.** `complete` means the agreed scope
   finished, with or without issues. `partial` means uncovered files remain,
   verification is unfinished, or the budget cut the run short, and already
   verified partial results may be shown. `failed` means no usable result
   this run. `skipped` means the review never started. The previous report is
   kept separately as the last result, and a later failure never clears it.

   The base budget stays at 300 seconds: preparation and initialization at
   most 60 seconds, discovery at most 120 seconds, verification in the
   remaining time, and the final 10 seconds reserved for cleanup. These are
   caps inside one total deadline, not added durations. Check the remaining
   budget before each new request. Retry a 429 or a transient network or
   service error at most twice with backoff, and the backoff time counts
   too. On a timeout with unknown acceptance, read the same session's
   messages first instead of resending the prompt. The outer layer never
   retries an already accepted run. Internal retries consume the same total
   deadline, and the run records the actual requests and usage. Credential,
   model configuration, and result format errors fail outright.

   Progress goes to the Actions stage logs and the job summary: the current
   phase, the files and candidates processed, the remaining time, and the run
   link. The PR comment is updated only at the end, so progress never
   spams comments. Round count, tokens, and output caps are observable stop
   conditions, not a precise billing cap, because usage reporting lags.

5. **Render deterministically and publish repeatably.** The comment carries
   a fixed product marker, the repository and PR identity, the head it
   covers, a run link, a status summary, and readable issues. Model text is
   escaped as plain content. The publisher lists the PR comments with
   pagination, finds the one comment by bot identity and product marker,
   updates it when found, and creates it only when not found. If a create
   succeeded but the response was lost, the retry queries by marker first
   and never blindly creates again. Read requests may retry a limited number
   of times. When the outcome of a side-effecting request is unknown,
   confirm the existing state first. The state schema for this segment stores
   `lastReport`, the last successful report, and `lastPublishedRun`.
   Segment 3 extends it with issue state. When historical duplicate markers
   are found, pick one canonical comment, report the duplication, and stop
   creating new ones. The product updates its own comments and never
   modifies human ones. Publishing uses the issue comments API.

6. **Finish continuous pushes and the publish boundary in one pass.** The
   whole reusable workflow uses one concurrency group per product,
   repository, and PR, with `cancel-in-progress: false` and the default
   single pending slot. Configure it only at this layer. A caller reusing
   the same group would wait on itself. A newer pending run can replace an
   older one, so every start re-reads the PR.

   Before publishing, re-fetch the PR's open state and its base and head. A
   mismatch with this run marks the run stale and leaves the valid report in
   place. Only a matching run and attempt may publish. After writing, query
   the commits again. If H2 landed between validation and write, the
   just-written report is annotated with its H1, marked stale, and updated
   by the next or a manual run. The check and the write are not atomic, so
   the promise is that reports are bound to a commit and stale results are
   handled, never that every instant is current. If publishing itself fails,
   Actions keeps the result and the failure entry, and a PR note is not
   guaranteed. A base update does not necessarily trigger this product's
   event, so the manual rerun path is documented.

### Acceptance

| Input or action | Expected result | Evidence |
| --- | --- | --- |
| Open a defect PR, then a normal PR, on the self-built Java repository. Rerun manually. | Automatic and manual runs use the same program. The report matches the API's current SHA, and a rerun updates the same comment. | Both PRs, the workflow runs, artifacts, comment IDs. |
| Model refusal, invalid key, simulated interruption, with and without usable stage results. | The comment shows `failed` or `partial`. A zero-issue `complete` shows differently. A previous valid report stays identifiable. | The three comment kinds, job summary, stage results. |
| Fail the review job before upload. In another run, fail the comment API. | The first case gets a failure note from the publish job. The second keeps a failure and a downloadable artifact in Actions. | `needs` result, run logs, artifact links. |
| Push H2 while analyzing H1. In another run, pause after publish validation, then push H2. | The first run blocks H1. The second writes, marks H1 stale, and the next run updates it. | The SHAs before and after publishing, comment content, run timeline. |
| Simulate a create that succeeded but whose response was lost, then rerun publishing. | The retry finds the original comment by marker and updates it. The product comment count does not grow. | Fault injection record, comment IDs, the PR comment list. |
| Feed the publisher a wrong PR, a wrong attempt, or a corrupt package. | Publishing rejects it with the reason. The current valid report is not replaced. | Publish behavior tests, rejection logs. |

Fault injection lives in API and runtime adapters under tests. The public
commands gain no "write arbitrary state" entry point.

## Segment 3: incremental review and fix follow-up

### Goal

After a fix or a disposition, the same issue keeps its number, and the
report says `persists`, `addressed`, or `unknown`. A partial completion, a
force push, and a damaged comment still recover a sane review scope. The
user never matches reports across rounds by hand.

### Steps

1. **Extend the state before the scope.** Add `src/state.ts` and
   `src/feedback.ts`. Upgrade the comment state to a versioned compact
   structure: `repositoryId` and `prNumber`, `generation`,
   `lastCompleteSnapshot`, `lastAttempt`, `nextFindingNumber`, and
   `findings`. Each finding stores a stable ID, a root-cause summary, the
   file and symbol, the commit where it was first found, the last recheck
   commit and evidence, one of `persists`, `addressed`, or `unknown`, and
   separate author disposition fields. Numbers use the generation plus an
   incrementing counter. A rebuild switches generation so old replies cannot
   dispose of new issues. Runs with an old schema get an explicit migration
   function, and a migration failure falls back to a rebuild.

   The current state lives in a schema-versioned encoded JSON block inside
   the comment, and the readable part still lists the issues and their
   states. Detailed candidates, full evidence, and historical snapshots go
   to the artifacts. The program validates the comment author, the product
   marker, the repository, and the PR. Only parsed state enters the program,
   and model text is never treated as a state command.

2. **A complete checkpoint decides the discovery scope.** Freeze the current
   base, head, and merge base each round. When there is no checkpoint, the
   base or merge base changed, history objects are missing, or the
   checkpoint is not an ancestor of the current head, fall back to
   `mergeBase → head` and record the reason. Otherwise the discovery range
   is the incremental diff `lastCompleteHead → currentHead`. The first
   version always goes full when the base changed, to reduce the influence
   of an old baseline.

   Add `coverage.discoveryComplete` and `coverage.recheckComplete`. The
   checkpoint rule is conservative: advance `lastCompleteSnapshot` only
   when the discovery scope was complete, every due recheck was handled, the
   result is valid, and it was published against a still-matching snapshot.
   `partial`, `failed`, and `stale` never advance. When A is complete, B is
   partial, and C arrives, C compares A to C. Trusted findings do not block
   a complete flow. A publish cap or a key-material truncation keeps the old
   checkpoint.

3. **Prepare old issues before discovery, and recheck each in verification.**
   The discovery prompt carries the old issue IDs and root causes in compact
   form to help flag duplicates, but an old-issue recheck never depends on
   the model rediscovering it. The verification input holds the new
   candidates and the old issues together, and returns candidate verdicts
   and rechecks separately. Every old ID must get a result. The program
   fills `unknown` for a missing, skipped, or over-budget item and keeps the
   previous evidence. A missing recheck is never a fix.

   `addressed` requires code evidence from the current snapshot that
   removes the original trigger path or root cause. Not being re-reported, a
   moved line number, or a deleted file is not enough. A recheck that finds
   the issue still present updates the citations. New-to-old matching
   prefers explicit old IDs, then file, symbol, and root cause with the
   verifier's stated link. An unclear match stays pending confirmation, and
   the program never auto-closes or force-merges. `duplicate-of` records a
   human-confirmed link. Verification is still a separate session, isolated
   from the discovery reasoning.

4. **Author dispositions in the same recheck flow.** Support fixed-format
   replies: `/ai-review <ID> false-positive <reason>`, `expected`, `defer`,
   `reopen`, and `duplicate-of <ID>`. The first version accepts only authors
   with write, maintain, or admin permission on the repository. Deduplicate
   by comment ID and `updated_at`, and let the latest valid opinion after
   an edit win. Feedback is read at the next automatic or manual review.
   No new `issue_comment` trigger and no chat service are added. Store
   `authorDisposition`, the actor, the time, the source comment, and the
   reason, separately from `codeVerdict`. `defer` is not a fix.
   `false-positive` and `expected` are author rulings and never pose as
   model proof that the root cause is gone. The same root cause is not
   re-raised as a new alert. After related code changes, the recheck still
   runs and shows the current evidence, and a materially changed root cause
   is filed as a new issue. An unauthorized or malformed reply changes
   nothing, and the next report explains why.

5. **One budget for discovery, rechecks, and retries.** The 300-second total
   continues. Preparation takes at most 60 seconds. With old issues
   present, reserve up to 90 seconds for rechecks, give discovery at most
   90 seconds, and let new-candidate verification use the rest, with the
   final 10 seconds for cleanup inside the total. Without old issues,
   reuse the segment 2 split. Stage caps obey one absolute deadline.
   Unused time flows to later stages, and retries and backoff draw from
   the same pool.

   Sort old issues by the files touched this round, unresolved status, and
   the longest time since a recheck. Batches of at most 8 use separate
   verification sessions, until the remaining budget cannot start another
   batch. Record each batch's sessions, steps, usage, and processed IDs.
   The unprocessed items become `unknown`. The candidate cap stays at 8 and
   published new issues stay at 5, and these caps never trim old-issue
   state. Stop starting new work when a resource threshold trips. After an
   interrupt, wait for the session's turn to settle, total the settled
   usage, and close the SDK. The parent confirms the exit, and at the
   300-second absolute deadline the whole process group is killed. A forced
   termination records the missing usage and the unprocessed IDs. The
   `steps` limit and the billed network requests are reported separately.

6. **Handle state growth and rebuilds.** The comment has a 40,000-character
   product soft cap. First shrink excerpts and move history detail to the
   run artifacts. Then drop resolved detail entries older than 30 days and
   keep a count summary. Unresolved issues, valid author dispositions, and
   the current checkpoint are kept first. When serialization still exceeds
   the cap, never write state that would be truncated. Do not advance the
   checkpoint, keep the last valid comment, and explain in a compact notice
   and in Actions that cleanup is needed. The full result stays in the
   artifact.

   On comment deletion or damage, start a new generation, run a full
   review, and mark the continuity as rebuilt. Never reconstruct current
   state from arbitrary old artifacts. They remain for manual reading, may
   be stale, and no completeness is promised for old numbers, old
   dispositions, or issues not rediscovered. The new number space prevents
   old replies from disposing of new issues. This tradeoff follows from
   using the comment as the lightweight state carrier, and the onboarding
   docs state the recovery limits and the retention window plainly.

### Acceptance

| Input or action | Expected result | Evidence |
| --- | --- | --- |
| Change an unrelated line, then fix the root cause, then rename a file, on the same defect PR. | The issue keeps its number across both commits, and the citations update. A rename alone never closes it. | Each commit, state JSON, issue numbers, code evidence. |
| A is complete, B is partial, then C is pushed. | C uses A as its checkpoint and does not miss B's changes. The checkpoint advances to C only after a successful complete publish. | Git diff ranges, coverage, checkpoint transitions. |
| Force-push makes the old checkpoint a non-ancestor, or the base updates. | The run falls back to the full PR with the reason recorded. Old issues are rechecked item by item, and unconfirmed ones are kept. | Commit relations, scope selection records, rechecks. |
| Reply `defer` or `false-positive` on one issue, then push a related change. In another run, add an unauthorized reply. | The disposition and the code verdict stay separate. The same root cause is not re-alerted. The unauthorized opinion changes no state. | Permission query results, feedback sources, state and report. |
| Interrupt one old-issue recheck batch, or make verification omit one old ID. | The unfinished items become `unknown`, old issues are not closed wholesale, the checkpoint does not advance, and the process exits. | Batch records, the filled results, exit code, cleanup records. |
| Grow to the length cap, then damage, then delete the comment state. | No unresolved issue is silently lost. The rebuild switches generation, falls back to a full review, and never applies old replies. | State size tests, the rebuilt PR report. |

## Segment 4: compare quality and tune prompts and models

### Goal

A maintainer replays the fixed cases with one command, sees which step
missed a defect, whether a normal change was flagged, and whether old issues
were rechecked correctly, then changes prompts and picks models from
comparable numbers. This segment must produce a real comparison and one
evidence-based prompt change. It does not need to prove that every mechanism
pays off.

### Steps

1. **Grow the cases into a small decidable set.** Add `src/eval.ts` and
   `evals/cases.json`, and add an `eval` command to the CLI. Keep the
   segment 1 cross-file `null` case and add three more scenario families:
   condition branches, return-field compatibility, and computed results.
   Each scenario has at least a defect change, a normal change, and a fix
   change. Also build independent acceptance scenarios with different
   business conditions and code structures, so the development and
   acceptance sets each cover four families. Group everything by root-cause
   family, and put near rewrites and fix versions in the same group as the
   original. The starting target is 8 scenario families and 24 change
   snapshots. That is an execution size, not a statistical claim.

   Each case records the input commits, the expected defect and trigger
   path, the business rule, the normal or fix rationale, the human
   adjudicator, and the date. Self-built Java tests and code walkthroughs
   confirm the truth. The controller owns the labels, and model input
   contains only material the product can normally obtain. Acceptance labels
   stay in a separate directory, and the snapshot builder never copies them.
   Segment 3's multi-round state and segment 2's failure and publishing
   cases enter the regression too, but stay separate from the model quality
   statistics.

2. **Save phase artifacts, and match human truth by root cause.** `eval`
   reuses the real `review` flow. Never build a parallel model pipeline for
   evaluation. Pin the runtime, the code, the prompts, the model, and the
   config versions for each batch. Write `runs/<batch>/cases.jsonl`,
   `judgements.jsonl`, `metrics.json`, and `summary.md`. Keep per case the
   candidates, verifications, publish filtering, coverage, usage, and
   duration. A human adjudicates TP, FP, and FN per root cause and trigger.
   A newly found unlabeled issue is adjudicated before the label version
   updates, and an undecidable one is listed apart. A deduplicated root
   cause counts once, and repeated feedback is tracked separately.

3. **Fix the comparison definitions and the acceptance rules before reading
   numbers.** The summary includes at least: adjudicated precision as
   `TP/(TP+FP)`, recall on known defects as `TP/(TP+FN)`, the share of
   normal changes that received a wrong suggestion, verification false
   kills, the recheck correctness rate for `persists` and `addressed` with
   the `unknown` share, the counts of complete, partial, and failed runs,
   per-stage and total duration, and tokens with available cost. A miss
   caused by a failed run or an exhausted budget still counts in the
   known-defect denominator. A zero denominator is reported as N/A, and
   every ratio lists its raw counts and pending adjudications.

   Write the initial acceptance rules into the batch config. A labeled
   high-impact functional regression does not accept a new miss introduced
   by verification. A recall drop on ordinary defects is considered only
   when the impact is confirmed per case, the false-positive reduction is
   proven valuable, and the 300-second budget holds. When quality does not
   improve while usage or wait time grows, keep the simpler configuration.
   Numeric thresholds for automated decisions are written down before use.
   With a small sample, decide per case with raw counts. Store prices by
   model and date. Without prices, compare tokens and never invent an
   amount.

4. **Run a paired verification control.** From one discovery round's
   candidates, run arm A with program validation and rendering only, and
   arm B with independent verification followed by the same validation and
   rendering. Keep the snapshot, the discovery prompt, the model, the
   candidates, and the publish cap identical. A and B share the discovery
   cost, counted once in each arm's total, and B adds the verification cost.
   This first isolates what verification does to existing candidates. Then
   run full A and B under the same 300-second total to measure verification
   squeezing discovery in practice. A is an eval mode only. The product
   default flow stays as configured.

   Repeat each development case at least 3 times and keep every raw result
   and its spread. Count separately the discovery misses, the verification
   exclusions of true issues, the `unknown` results, and the losses to
   dedup and the publish cap. Never blame all false negatives on
   verification. A human adjudicates common errors across discovery and
   verification together, because two sessions are not a statistical
   independence guarantee. The result decides whether to keep, adjust, or
   simplify verification, and a change to the default flow updates the
   product config, the acceptance, and the affected answers.

5. **Adjust one prompt from a real failure, then compare models.** Pick one
   reproducible false positive, miss, or output problem from the development
   set, and locate whether the input material, the discovery constraints, or
   the verification conditions need the change. Submit the first and the
   revised prompt, and keep the run that triggered the change. Adjust one
   key factor at a time and rerun the same development batch. When no
   quality defect exists, a real adjustment may instead target observed
   verbosity, cost, or stability. Never fabricate a failure or a gain.

   After the version settles, run the independent acceptance set. When
   acceptance exposes problems, record that this set has now been observed.
   The next formal confirmation needs a new retained scenario, and a
   repeatedly tuned set is never called unseen.

   Run the model comparison after the prompts and the budget are fixed.
   Pick the current main model and one cheaper candidate from models the
   same provider actually offers, run the same batch and repeats for both,
   and record the exact model IDs, parameters, and access. Without actual
   calls on a second model, the comparison is not done. That resource is
   required, and no winner is pre-filled here. Apply the quality, latency,
   and usage rules from step 3 to pick the default and the switch
   conditions. A newer model number alone is never a reason to switch.

6. **Let the iteration drive the next release.**
   `bun run eval -- --suite dev --config <config> --out <batch-dir>` and
   `--suite acceptance` read a frozen case list and produce recomputable
   reports. Run the deterministic engineering regression first, then only
   the model cases touched by the change. Never rerun everything for every
   small edit. A release candidate needs the independent acceptance batch
   plus the state and publishing regression. The output report states what
   changed, which cases moved, the cost in time and money, which version is
   kept, and the remaining limits, all taken straight from the batch data.

### Acceptance

| Input or action | Expected result | Evidence |
| --- | --- | --- |
| Run the development set and the independent acceptance set. | Labels never appear in model material. Every case traces to fixed commits and a human basis. | Input manifests, case grouping, adjudication records. |
| Run A and B on one candidate set, then the full control under the same total budget. | Verification filtering, false kills, and budget squeeze are separated, with one consistent time and cost measure. | Paired IDs, stage JSON, per-run results, the summary computation. |
| Perform one real prompt change and a two-model comparison. | The before and after difference and the model choice both have evidence, and a conclusion of no improvement or a revert is acceptable. | Prompt commits, the failing sample, comparison batches, the selection conclusion. |
| Add samples with failures, `unknown` results, duplicate root causes, pending adjudications, and zero denominators. | The metrics recompute by hand, and quality is never inflated by dropping failed or pending items. | Metric unit tests, raw counts, `metrics.json`. |
| Replay a fix, an unfixed issue, a location change, and a budget interruption. | The recheck correctness rate and the `unknown` share stay separate, and the engineering state rules still pass. | State regression results and recheck adjudications. |

## Segment 5: release and independent onboarding

### Goal

A person who never worked on this project, with repository configuration
permission, onboards against a fixed version, receives reports, sees recheck
results after a fix or a disposition, and recovers from a failure. The
maintainer holds one complete release and trial record, with facts measured
from this release and this trial.

### Steps

1. **Polish the onboarding interface and release a fixed version.** Complete
   the root `README.md`, `examples/caller.yml`, and a configuration sample.
   Cover the supported scope, the model secret and model ID, the PR and
   manual triggers, the report and disposition formats, the run budget, the
   caller-pays cost, the common configuration errors, and the rerun path.
   No new backend is needed. Draft and fork PRs are skipped by default, and
   no permission escalation goes around the scope. Every example comes from
   the working segment 2 workflow, and no placeholder that cannot run
   stays in the docs.

   Ship and verify the Action version A first, then the reusable workflow
   version B that references A, and have callers pin B to a commit SHA.
   Pin any third-party Action to a reviewed commit, with its name and
   version noted. The release pins Bun, the OpenCode packages, and the
   lockfile, and ships the segment 4 prompts and the default model
   configuration. Before release, run the regression and one full loop on a
   real PR, and save the tag, the SHA, and the results.

2. **Complete one independent onboarding and fix.** The user configures the
   secret and the model in their own Java repository, adds the caller
   workflow, opens a defect PR, reads the report, commits a fix or a
   fixed-format disposition, waits for the recheck, and reruns manually
   once. Record the onboarding window, the help requests, the configuration
   failure points, and the final report. This is separate from
   single-review latency. The developer provides docs and answers only.
   Only actual independent completion counts. If nobody participates yet,
   the item stays open, and a developer demo does not substitute.

3. **Fix one round from real feedback and regress it.** Pick one real
   problem from the trial and thread one run ID through the snapshot and
   retrieval, the candidates, the verification, the state merge, and the
   publishing. When no offline-versus-live gap has appeared, exercise the
   diagnosis path with a clearly labeled drill, such as a missing
   repository rule or a wrongly clipped diff, and never write it up as a
   real user incident. After the root cause is known, fix that module, add
   the case to the development regression, rerun the affected cases, and
   release the revision. Never change the prompt, the model, and the
   publishing logic at once over one feedback, or the cause is lost.

4. **Produce measured conclusions from the raw records.** The window runs
   from the release candidate's first onboarding test to the end of this
   trial round. Record the dates, the repositories, the deduplicated PR
   count, the snapshot count, and the run count. Quality uses the segment 4
   adjudicated cases. Online coverage is the share of in-scope PRs whose
   latest matching snapshot has a complete report at observation time.
   Feedback latency runs from the trigger to the successful report write,
   split into queue, prepare, analyze, and publish. Failed, cancelled, and
   stale requests report their own terminal state and latency, and their
   cost counts too. Adoption and fixes count only with an explicit
   disposition and enough observation time. `defer` is not a code fix.
   Without a comparable human-review experiment, never claim saved hours.
   A small sample reports raw counts and medians, never inflated to a
   team-wide gain.

### Acceptance

| Input or action | Expected result | Evidence |
| --- | --- | --- |
| The user onboards from an empty configuration against the pinned SHA. | Without touching the product source, the user receives a first valid report for the current commit. | The caller workflow, versions, configuration records, the first report. |
| The user commits a fix, adds a disposition, and reruns manually. | The original number is rechecked, the disposition applies, and a rerun never creates a duplicate summary comment. | PR commits, replies, state, comment IDs. |
| The user hits a configuration, model, or publishing failure and recovers by the docs. | The error source and the rerun entry are findable, and the last result and current state stay clear. | Help requests and failure points, the recovered workflow run. |
| One piece of feedback, or one labeled drill, is traced and regressed. | The root cause lands in one stage, the fix has matching verification, and the record says whether it was a real usage problem. | The original run, the revision commit, the regression batch. |
| The outward results recompute from the raw batch and trial records. | Sample sizes, windows, denominators, endpoints, and data sources agree, and the conclusions map to implementation. | Eval reports, Actions timings, PR records, commits. |

## Maintaining this plan

Keep the source, the tests, the prompts, the fixed fixtures, and the truth
labels in the repository. Keep run artifacts outside it. This plan is the
source for scope, order, dependencies, and acceptance. A pull request holds
its own discussion, checks, review outcome, and current status, and this
plan does not duplicate them.

When a segment's real implementation differs from a step written here, update
the step in the same pull request that changes the behavior. When a segment
finishes, move its state into "Current state" and cite the pull request.
