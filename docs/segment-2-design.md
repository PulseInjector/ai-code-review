# Segment 2 design: reliable feedback on a PR

This document is the synthesized design decision for Segment 2 of `ai-code-review`. It was produced from three independent candidate designs and a cross-judge review, as required by the architect workflow. It targets repository commit `806291af46fbc0e6bec13d4a636baed412b33233`, and every source reference below refers to that commit. Section 8 records what was grafted and why.

The document is written for an implementer with no other context. Data structures, boundaries, and runtime behavior are specified to the field and byte level. Nothing here requires a decision from the implementer.

## 1. Problem and constraints from the existing code

The product must review the current API snapshot of a collaborator PR, preserve evidence when work fails, and update one bot-owned issue comment. A model result and permission to publish are separate facts. The review job produces data with a read token. The publish job validates that data, obtains current PR state, and owns all comment writes with a write token.

The chosen shape has two deep entry points. `runPrReview` owns PR capture, frozen configuration, local review, and handoff creation. `publishReview` owns artifact admission, freshness, old-report preservation, rendering, and comment reconciliation. Callers do not coordinate the individual GitHub reads or comment writes.

### Existing ownership and the exact changes

| Source | Existing behavior | Design decision |
| --- | --- | --- |
| `src/contracts.ts:12`, `:18`, `:29`, `:52`, `:114` | `Snapshot`, `CodeReference`, `Candidate`, `Verification`, and `ReviewResult` validate the review domain. The result has four statuses, at most five kept issues, coverage, errors, usage, and hashes. | Reuse these concepts. Keep `Snapshot` a Git concept. Put repository and run identity beside it in the PR envelope. Export the existing component schemas needed by the envelope. Strengthen bounded coverage and typed stage errors at this boundary. |
| `src/context.ts:14`, `:33`, `:139` | `ReviewInput`, `ContextManifest`, and `prepareContext` resolve revisions, compute the merge base, export Git objects, and atomically rename prepared material. Instructions come from fixed `baseSha`. Limits currently come from the product's `review.config.json`. | Keep the exporter and local interface. Add a parsed configuration reader for an explicitly selected regular blob at fixed base. Pass limits into `prepareContext`. The PR adapter supplies a dedicated bare Git repository containing fixed objects. It never checks out the head. |
| `src/context.ts:52`, `:108`, `:119` | Git uses argument arrays and a deadline. Path exclusions, text decoding, regular modes, and material caps prevent unsafe exports. | Reuse these policies for PR material. Extract only the fixed-object read helpers needed by the PR adapter into the same module. Do not introduce a second exporter. |
| `src/review.ts:25` | `runReview` starts its own clock and UUID. Preparation happens before its error catcher. Prompt construction, model configuration, worker invocation, and result writing follow. | Keep `runReview` for the local path. Extend its options with a shared execution budget, run ID, and progress sink. `runPrReview` starts that budget before the first API call and catches pre-snapshot failures into the PR envelope. For a PR run, `runReview` writes into `<out>/replay`, never into `<out>` itself. Local calls still generate a UUID and a 300-second budget. |
| `src/discovery.ts:27`, `:46`, `:68` | `DiscoveryFailure` keeps runtime data and discovery candidates. `runDiscoveryAndVerification` requires both completed sessions and clean host close. It validates outputs again after worker validation. | Replace the failure payload with a typed stage checkpoint plus a failure code. Preserve parent-side validation as the subprocess trust boundary. Derive usable results from the last validated checkpoint instead of treating every runtime failure as an empty failed review. |
| `src/phase-validation.ts:11`, `:26`, `:40` | The validator checks fixed material, changed head locations, candidate ID sets, lines, and matching excerpts. | Reuse for analysis. Export a small `validateReferences` function and use the same line and excerpt rules against a fixed-object reader during publish admission. The publisher obtains source from Git, never from artifact-provided source text. |
| `src/report.ts:26`, `:59`, `:113` | `renderMarkdown` creates local links. `createRunArtifacts` maps any error to `failed` and removes issues. `writeRunArtifacts` writes files with `wx`. | Retain local rendering and replay files. Replace status selection with the checkpoint reducer. Add atomic file writes for final result replacement. The GitHub renderer and comment state live in `src/comment.ts`, a pure module, and the write orchestration lives in `src/publish.ts`. |
| `src/cli.ts:4` | `parseReviewInput` accepts four flags. Local review writes one JSON summary. Exit 0 covers complete, partial, and skipped. Exit 1 covers failed and input errors. | Replace the parser with a discriminated command parser. Preserve the legacy flag-only local invocation and `parseReviewInput` only as a compatibility parser for that invocation during the same checkpoint. All execution routes then call one dispatcher. Keep existing exit semantics. |
| `src/runtime/contracts.ts:23`, `:47`, `:55` | Worker IPC has a deadline and phase results, but no phase budgets, submission state, or request ledger. | Extend IPC once with absolute phase limits, request records, typed failure codes, and validated checkpoints. Do not expose SDK transport records in product types. |
| `src/runtime/worker-process.ts:29`, `:45` | `buildWorkerEnvironment` allows only basic system variables and the model key. `runIsolatedWorker` starts a detached process, reads atomic progress, interrupts before deadline, kills the process group, and removes the worker HOME. | Preserve this security boundary. Pass phase deadlines, read typed checkpoints after a forced exit, and leave ten seconds for cleanup and final artifacts. Never add a GitHub token to this environment. |
| `src/runtime/worker.ts:15` | `save` writes a temporary file and renames it. | Reuse that protocol for worker progress. Add a monotonically increasing checkpoint sequence inside each worker result. Read one complete file, not a set of partially related files. |
| `src/runtime/opencode-v227.ts:24`, `:36`, `:50`, `:126` | `completedTurn`, `listMessages`, `runSession`, and `runRuntime` use durable messages, independent discovery and verification sessions, event wakeups, and a poll backstop. Prompt acceptance currently has no recovery after an unknown response. | Keep the lifecycle and same-session message reader. Add a submission state machine, phase interrupts, and a policy plugin for retries. Never recreate a session or resend an accepted prompt to recover a timeout. |
| `src/runtime/isolation.ts:18`, `:30`, `:58` | System configuration, material paths, ancestor instructions, and separate directories are checked. | Reuse unchanged. PR run directories live under a clean runner temporary parent with no ancestor `AGENTS.md`. |
| `src/runtime/context-limits.ts:18`, `:48` | One synchronous worker budget caps tool text and records pending reads. | Reuse byte and continuation accounting. Add retry and request hooks in a separate policy plugin, not in the read-budget plugin. |
| `src/verification/cli.ts:72`, `src/verification/review-cli.ts:14` | The verifier drives real CLI processes and disposable Git repositories. Areas are CLI, snapshot, runtime, and Java. | Add the `github` area and `src/verification/github-cli.ts`. Drive the public PR commands against loopback test adapters through constructor injection in the test process. Production CLI gets no test-state flags. Keep existing CLI journeys passing. |

The current configuration has three limits, `maxChangedFiles: 50`, `maxPatchBytes: 262144`, and `maxSnapshotBytes: 8388608`. Bun is `1.4.4`. The SDK and plugin are `2.2.7`. Zod is `4.6.7`. These stay pinned.

Every review still covers the full `mergeBaseSha` to `headSha` diff. Segment 2 has no issue identity across runs, disposition parser, incremental checkpoint, automatic fix, or test execution against PR content.

## 2. Usage first: the caller's view

### CLI invocations

The existing local invocation remains valid.

```sh
bun run review -- --repo /tmp/java-review --base main --head defect --out /tmp/review-local-1
```

The explicit command form selects PR capture from the API. The default configuration path is `review.config.json` in the fixed base tree.

```sh
bun run src/cli.ts review --repository PulseInjector/java-review --pr 17 --out /tmp/review-pr-17
bun run src/cli.ts review --repository PulseInjector/java-review --pr 17 --config review.config.json --out /tmp/review-pr-17-manual
```

`GITHUB_TOKEN` authenticates PR reads and fixed-object fetches. `REVIEW_MODEL_PROVIDER_ID`, `REVIEW_MODEL_BASE_URL`, `REVIEW_MODEL_ID`, and `REVIEW_MODEL_API_KEY` configure analysis. A local PR run receives a local execution identity and can create replay and handoff files. It cannot publish, because local identity does not prove the Actions single-writer boundary.

The publish command runs only in the publish job of the reusable workflow. The workflow supplies the directory downloaded from the exact run artifact. A missing directory is an expected input and activates the missing-artifact path.

```sh
bun run src/cli.ts publish --repository PulseInjector/java-review --pr 17 --package /tmp/review-handoff --review-job-result failure
```

The publisher gets the expected run ID and attempt from parsed Actions environment and confirms them through the API. It does not accept either as a public flag. `--review-job-result` accepts `success`, `failure`, `cancelled`, or `skipped`, as emitted by `needs.review.result`. It is evidence of the job outcome, never evidence that an artifact is valid.

### Caller workflow

The reusable workflow must reference the earlier product Action commit A. A caller must reference the later workflow commit B. Neither future SHA exists at this design checkpoint. The implementation produces the caller YAML through `renderCallerWorkflow(workflowCommit)`, where `workflowCommit` is parsed from `git rev-parse HEAD` after committing B. This is a defined generation operation, not a release tag or a user-editable placeholder. The generated `examples/caller.yml` contains the actual full SHA and no interpolation token.

```ts
function renderCallerWorkflow(workflowCommit: GitSha): string {
	return `name: Code review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, edited]
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number to review
        type: string
        required: true
permissions:
  contents: read
  pull-requests: write
  actions: read
jobs:
  review:
    uses: PulseInjector/ai-code-review/.github/workflows/review.yml@${workflowCommit}
    with:
      pr: \${{ github.event.pull_request.number && format('{0}', github.event.pull_request.number) || inputs.pr }}
      config: review.config.json
      model-provider-id: \${{ vars.REVIEW_MODEL_PROVIDER_ID }}
      model-base-url: \${{ vars.REVIEW_MODEL_BASE_URL }}
      model-id: \${{ vars.REVIEW_MODEL_ID }}
    secrets:
      model-api-key: \${{ secrets.REVIEW_MODEL_API_KEY }}
`;
}
```

The caller has no concurrency group. The reusable workflow is its sole owner. The caller explicitly passes one model secret. It does not use `secrets: inherit`. Draft and fork filtering occurs in the program, so the run produces a skipped record even when triggered. A base-only change might not cause a listed event, so maintainers use the manual PR input after such a change.

The caller grants `contents: read`, `pull-requests: write`, and `actions: read`. Permissions cannot increase through a reusable-workflow call, so the caller must grant the maximum the two jobs need, and each called job narrows its own token.

### Product call sites

The CLI supplies environment, not transport details, to the two operations.

```ts
const command = parseCommand(process.argv.slice(2));
const budget = createBudget(systemClock, command.kind === "publish" ? 120_000 : 300_000);
const execution = await readExecutionContext(process.env, budget);
switch (command.kind) {
	case "review-pr": {
		const outcome = await runPrReview(command, {
			github: createGitHubReader(process.env),
			execution,
			progress: createActionsProgress(process.env),
			model: () => loadModelConfiguration(),
			budget,
		});
		writeCliSummary(outcome);
		process.exitCode = outcome.exitCode;
		break;
	}
	case "publish": {
		const outcome = await publishReview(command, {
			github: createGitHubPublisher(process.env),
			execution: requireActionsExecution(execution),
			progress: createActionsProgress(process.env),
			...await readProductIdentity(),
			budget,
		});
		writeCliSummary(outcome);
		process.exitCode = outcome.exitCode;
		break;
	}
	case "review-local": {
		const run = await runReview(command.input);
		writeCliSummary({ runDirectory: run.runDirectory, result: run.artifacts.result });
		process.exitCode = run.artifacts.result.status === "failed" ? 1 : 0;
		break;
	}
}
```

PR capture feeds the existing local reviewer and supplies one shared clock. The layout rule is exact. `runPrReview` owns `<out>` and creates it as a new directory. `runReview` receives `join(command.out, "replay")` as its output, never `<out>` itself. `runReview` keeps its Segment 1 rule that its output directory must not exist, and each workflow attempt receives a fresh runner temporary parent, so the replay subdirectory is always new. The handoff directory is a sibling, `<out>/handoff`.

```ts
const captured = await github.capturePullRequest({ repository: command.repository, pr: command.pr, budget });
const backup = await readPreviousReportBackup({ identity: captured.identity, github, budget });
if (captured.eligibility.kind === "skip") {
	return writePrHandoff({ captured, execution, backup, outcome: { kind: "skipped", reason: captured.eligibility.reason }, out: command.out });
}
const fixed = await github.prepareFixedRepository({ captured, configPath: command.config, budget });
const run = await runReview(
	{ repo: fixed.directory, base: captured.baseSha, head: captured.headSha, out: join(command.out, "replay") },
	{
		budget,
		runId: execution.reviewRunId,
		limits: fixed.config,
		progress,
		getModelConfiguration: model,
	},
);
return writePrHandoff({ captured, execution, run, backup, out: command.out });
```

The publisher sees a domain decision and performs one reconciliation operation.

```ts
const admitted = await admitHandoff(command.packageDirectory, expected, github, budget);
const current = await github.capturePullRequest({ repository: command.repository, pr: command.pr, budget });
const previous = await github.readProductComment({ identity: current.identity, budget });
const decision = decidePublish({ expected, admitted, current, previous });
return reconcileComment({ decision, previous, github, budget, progress });
```

These are three call sites, not three public protocols. `runPrReview` and `publishReview` hide these internal steps. The last two snippets live inside their owning modules and make their runtime flow reviewable.

## 3. Shape

### Module map and public interfaces

| Module | Owns | Public imports |
| --- | --- | --- |
| `src/contracts.ts` | Existing review domain, statuses, validated evidence, and typed stage errors. | Existing model types and schemas. |
| `src/identity.ts` | Branded primitives for commit SHAs, digests, repository and run IDs, PR numbers, comment IDs, repository full names, and instants. | The branded schemas and inferred types below. No GitHub response shapes. |
| `src/pr-contracts.ts` | Parsed PR identity, execution identity, PR outcome, and domain errors shared by the two entry points. | Schemas and inferred domain types below. It composes `identity.ts` and `contracts.ts` and contains no GitHub response shapes. |
| `src/github.ts` | GitHub HTTP, response schemas, pagination, run and artifact provenance, bare Git transport, frozen base configuration, and token handling. | `createGitHubReader`, `createGitHubPublisher`, `readExecutionContext`, `GitHubReader`, and `GitHubPublisher`. Raw REST schemas remain private. |
| `src/pr-review.ts` | `runPrReview`, PR state capture, total clock, prior-comment backup, local reviewer adaptation, and handoff finalization. | `runPrReview`. |
| `src/handoff.ts` | The two private wire schemas, exact byte format, atomic commit, digest checks, size caps, and package admission. | `writePrHandoff` and `admitHandoff`. The wire schemas are not re-exported by `pr-contracts.ts`. Tests import them from this owner. |
| `src/comment.ts` | The product marker, comment state schema, state encoding and parsing, deterministic body rendering, plain-text escaping, and size fit. | `PRODUCT_MARKER`, `commentStateSchema`, `parseStateBlock`, `renderCommentBody`, `scanProductComments`, `sanitizeCommentText`. The module is pure. It performs no I/O and imports no GitHub types. |
| `src/publish.ts` | The pure publish decision, single-writer preconditions, and uncertain-write reconciliation. | `publishReview`. Pure functions remain file-local except explicit test exports. |
| `src/progress.ts` | Structured events, safe Actions logging, job summary, and output-file escaping. | `ProgressSink`, `createActionsProgress`. |
| `src/budget.ts` | Monotonic total clock, stage deadlines, and backoff scheduling. | `ExecutionBudget`, `Clock`, `createBudget`. |
| `src/runtime/request-policy.ts` | OpenCode session retry and HTTP request hooks, request accounting, phase request admission, and structured retry errors. | `createRequestPolicyPlugin`. |
| Existing runtime modules | Worker isolation, durable session lifecycle, phase output validation, tool budget, and cleanup. | Existing boundaries with the extensions below. |
| `src/cli.ts` | Argument and environment parsing, dispatch, stdout summary, and exit mapping. | `parseCommand` for tests. It performs no GitHub policy. |
| `src/verification/github-cli.ts` | Disposable PR, API, and runtime fixtures and recorded behavioral evidence. | `verifyGitHubCli`. No production import points here. |

The dominant read paths are identity to captured PR, result to citations, and marker to comment. Each has one structure. There is no historical issue store or mutable run index. A comment stores one previous usable report and the latest publication metadata. Artifacts store full records per execution.

The existing local entry receives one extended options type. If the caller supplies `budget`, that budget owns the deadline and `timeoutMs` is rejected. Otherwise `runReview` constructs its existing local timeout. The parent starts the shared budget before capture and never resets it at this call.

```ts
type ReviewOptions = {
	runWorker?: DiscoveryWorker;
	configuration?: ReturnType<typeof loadModelConfiguration>;
	getModelConfiguration?: () => ReturnType<typeof loadModelConfiguration>;
	limits?: ReviewLimits;
	timeoutMs?: number;
	budget?: ExecutionBudget;
	runId?: string;
	progress?: ProgressSink;
};
function runReview(input: ReviewInput, options?: ReviewOptions): Promise<ReviewRun>;
```

`configuration` and `getModelConfiguration` are mutually exclusive at the options boundary. The PR path supplies the lazy getter. `runReview` calls it only after export proves that at least one changed file is included. No-change and all-omitted reviews therefore preserve Segment 1's zero-request behavior without requiring model credentials.

### Branded identity primitives

The following definitions are the authoritative contents of `src/identity.ts`. Schemas at raw boundaries produce branded semantic values. Pure code trusts these values. The selected GitHub.com release accepts 40-character commit SHAs. The existing local Git schema can continue to accept SHA-256 repositories.

```ts
import { z } from "zod";

export const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/).brand<"GitSha">();
export const digestSchema = z.string().regex(/^[0-9a-f]{64}$/).brand<"Sha256">();
export const repositoryIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/).brand<"RepositoryId">();
export const runIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/).brand<"WorkflowRunId">();
export const attemptSchema = z.int().positive().max(1_000_000).brand<"RunAttempt">();
export const prNumberSchema = z.int().positive().max(2_147_483_647).brand<"PullRequestNumber">();
export const commentIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/).brand<"CommentId">();
export const instantSchema = z.iso.datetime({ offset: true });
export const repositoryNameSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/);
```

`repositoryId` and workflow run IDs use canonical decimal strings. GitHub JSON numeric IDs must be positive safe integers before conversion. Reject values outside JavaScript's exact integer range rather than silently round them. IDs from environment are parsed as decimal text and compared with the parsed API identity.

### Domain schemas

The following definitions are the authoritative additions in `src/pr-contracts.ts`.

```ts
import { z } from "zod";
import { relativePathSchema, reviewResultSchema, snapshotSchema } from "./contracts";
import {
	attemptSchema, commentIdSchema, gitShaSchema, instantSchema,
	prNumberSchema, repositoryIdSchema, repositoryNameSchema, runIdSchema,
} from "./identity";

export const identitySchema = z.strictObject({
	repositoryId: repositoryIdSchema,
	repository: repositoryNameSchema,
	pr: prNumberSchema,
});
export const triggerSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("pull-request"), action: z.enum(["opened", "synchronize", "reopened", "ready_for_review", "edited"]) }),
	z.strictObject({ kind: z.literal("manual") }),
	z.strictObject({ kind: z.literal("local") }),
]);
export const actionsExecutionSchema = z.strictObject({
	kind: z.literal("actions"),
	reviewRunId: z.string().regex(/^gh-[1-9][0-9]{0,19}-[1-9][0-9]{0,6}$/),
	workflowRunId: runIdSchema,
	attempt: attemptSchema,
	trigger: triggerSchema,
	triggeredAt: instantSchema,
	startedAt: instantSchema,
	runUrl: z.url(),
});
export const localExecutionSchema = z.strictObject({
	kind: z.literal("local"),
	reviewRunId: z.uuid(),
	trigger: z.strictObject({ kind: z.literal("local") }),
	triggeredAt: instantSchema,
	startedAt: instantSchema,
});
export const executionSchema = z.discriminatedUnion("kind", [actionsExecutionSchema, localExecutionSchema]);
export const skipReasonSchema = z.enum(["draft", "closed", "fork", "no-changes"]);
export const failureCodeSchema = z.enum([
	"input-invalid", "github-auth", "github-forbidden", "github-not-found", "github-rate-limit", "github-unavailable",
	"snapshot-fetch", "config-invalid", "isolation-rejected", "prepare-timeout", "runtime-init", "model-auth", "model-config",
	"model-refusal", "model-format", "citation-invalid", "candidate-set-invalid", "retry-exhausted", "acceptance-unknown",
	"discovery-timeout", "verification-timeout", "run-interrupted", "read-budget", "request-budget", "cleanup-failed", "artifact-write",
	"artifact-missing", "artifact-invalid", "identity-mismatch", "attempt-mismatch", "artifact-provenance",
	"comment-state-invalid", "comment-list-limit", "comment-write", "comment-write-unknown", "postcheck-unavailable",
	"writer-context-required", "writer-attempt-inactive",
]);
export const failureSchema = z.strictObject({
	code: failureCodeSchema,
	stage: z.enum(["input", "capture", "preparation", "initialization", "discovery", "verification", "cleanup", "handoff", "publish"]),
	message: z.string().min(1).max(2_000),
});
const usableReviewResultSchema = z.intersection(
	reviewResultSchema,
	z.object({ status: z.enum(["complete", "partial"]) }),
);
const reportFields = { result: usableReviewResultSchema };
export const prOutcomeSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("reviewed"), ...reportFields }),
	z.strictObject({ kind: z.literal("failed"), failure: failureSchema, snapshot: snapshotSchema.nullable() }),
	z.strictObject({ kind: z.literal("skipped"), reason: skipReasonSchema, snapshot: snapshotSchema.nullable() }),
]);
export const jobResultSchema = z.enum(["success", "failure", "cancelled", "skipped"]);

export type PullRequestIdentity = z.infer<typeof identitySchema>;
export type ActionsExecution = z.infer<typeof actionsExecutionSchema>;
export type Execution = z.infer<typeof executionSchema>;
export type Trigger = z.infer<typeof triggerSchema>;
export type Failure = z.infer<typeof failureSchema>;
export type PrOutcome = z.infer<typeof prOutcomeSchema>;
export type JobResult = z.infer<typeof jobResultSchema>;
```

Boundary refinements require `reviewRunId === gh-${workflowRunId}-${attempt}` for Actions. A local execution always has a local trigger. An Actions execution never has a local trigger. `reviewed.result.status` must be `complete` or `partial`. Its `result.runId` equals `execution.reviewRunId`. Failed and skipped outcomes do not invent a merge base when capture or fetch failed. The full local `ReviewResult` stays in replay records whenever a real snapshot exists.

`readExecutionContext` parses only `GITHUB_REPOSITORY`, `GITHUB_REPOSITORY_ID`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_SERVER_URL`, and runner output paths. It reads at most 1 MiB of event JSON. A PR event contributes its action and requested PR number only. Neither base nor head enters the snapshot from that payload. A manual event contributes its parsed PR input. The expected PR from the command must equal the event PR or manual input. The origin is fixed to `https://github.com` and the API to `https://api.github.com` in this release. A different configured Actions server fails with `input-invalid`.

`triggeredAt` comes from the workflow run API's `created_at`, which measures GitHub's creation of the run. It does not claim to be the exact push receipt time. `startedAt` records entry into the review command. Capture also records API observation time. Attempt start time from the run API is retained in detailed timing. A rerun keeps the original trigger time and records a fresh attempt and actual start.

`readExecutionContext` lives in `github.ts`. It first parses environment into a local identity or an Actions seed. For Actions it constructs the read adapter internally and resolves run timestamps and current attempt through `readWorkflow`. For a local invocation it never constructs a GitHub adapter or requires a GitHub token. Its capture time is the command-entry time supplied before the API read. The resulting timestamps and API requests consume the caller's budget. The CLI constructs that budget before calling it and passes the same budget onward to `runPrReview` or `publishReview`.

### GitHub adapter boundary

The adapter uses built-in `fetch`. It adds `Authorization: Bearer`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, and a fixed product user agent. Redirects are disabled for API JSON requests. Artifact archive redirects may target only the GitHub-owned storage URL returned by the current API call. They receive no forwarded bearer header. Response bodies have byte caps before JSON parsing. API errors expose a classified code and sanitized message, never the response body or authorization header.

The following are domain interfaces. GitHub response JSON is private to `github.ts` and parsed with private Zod schemas using `.passthrough()` only for unused REST fields. The domain objects below contain only selected fields.

```ts
type PullRequestCapture = {
	identity: PullRequestIdentity;
	baseSha: GitSha;
	headSha: GitSha;
	observedAt: string;
	eligibility: { kind: "review" } | { kind: "skip"; reason: "draft" | "closed" | "fork" };
};
type WorkflowObservation = {
	repositoryId: PullRequestIdentity["repositoryId"];
	runId: ActionsExecution["workflowRunId"];
	currentAttempt: ActionsExecution["attempt"];
	createdAt: string;
	attemptStartedAt: string;
	status: "queued" | "in_progress" | "completed";
	event: "pull_request" | "workflow_dispatch";
};
type FixedRepository = {
	directory: string;
	config: ReviewLimits;
	configSource: { kind: "base-blob"; path: string; sha: GitSha; digest: Sha256 } | { kind: "product-default"; digest: Sha256 };
	dispose(): Promise<void>;
};
type ProductComment = {
	id: z.infer<typeof commentIdSchema>;
	authorId: string;
	authorLogin: string;
	body: string;
	createdAt: string;
	updatedAt: string;
};
type CommentObservation =
	| { kind: "absent"; duplicateIds: [] }
	| { kind: "valid"; canonical: ProductComment; state: CommentState; duplicateIds: string[] }
	| { kind: "invalid"; canonical: ProductComment; reason: string; duplicateIds: string[] };
type ArtifactReceipt = { id: string; name: string; workflowRunId: string; bytes: number; expired: boolean; digest: Sha256 | null };
type SourceLineRequest = { sha: GitSha; path: string; startLine: number; endLine: number };
interface GitHubReader {
	capturePullRequest(input: { repository: string; pr: number; budget: ExecutionBudget }): Promise<PullRequestCapture>;
	readWorkflow(input: { repository: string; runId: string; budget: ExecutionBudget }): Promise<WorkflowObservation>;
	prepareFixedRepository(input: { captured: PullRequestCapture; configPath: string; budget: ExecutionBudget }): Promise<FixedRepository>;
	readProductComment(input: { identity: PullRequestIdentity; budget: ExecutionBudget }): Promise<CommentObservation>;
	readArtifactReceipt(input: { identity: PullRequestIdentity; execution: ActionsExecution; budget: ExecutionBudget }): Promise<ArtifactReceipt | null>;
	readFixedLines(input: SourceLineRequest & { repository: string; budget: ExecutionBudget }): Promise<string>;
}
interface GitHubPublisher extends GitHubReader {
	writeComment(input: { identity: PullRequestIdentity; existingId: string | null; body: string; budget: ExecutionBudget }): Promise<
		{ kind: "confirmed"; comment: ProductComment } | { kind: "unknown"; failure: Failure }
	>;
}
```

`capturePullRequest` reads `GET /repos/{owner}/{repo}` and `GET /repos/{owner}/{repo}/pulls/{number}`. It verifies repository ID, PR number, base repository ID, head repository ID, state, and draft status. A missing or null head repository yields `fork` or `closed` according to state and never initiates a fetch. The eligibility priority is closed, fork, then draft. A head with a different repository ID is a fork even if its full name looks similar. Caller collaborators are the configured trust scope, not a claim inferred from the event author login.

`readPreviousReportBackup` is private to `pr-review.ts`. It calls `readProductComment` once after capture, copies at most 60,000 bytes of canonical owned body into replay, and records the backup receipt. An invalid owned state is still copied as diagnostic bytes. A read failure produces an `unavailable` receipt and a job-summary warning without changing analysis completeness. Backup access never changes model input or authorizes a later write. The publisher reads fresh comment state for itself.

`readProductComment` uses `GET /repos/{owner}/{repo}/issues/{pr}/comments?per_page=100&page=N`. It follows parsed same-origin `Link` pagination or increments pages until a short page, tracks IDs, and detects repeated pages. It scans all pages before choosing absence. It limits the scan to 200 pages and 20 MiB total decoded JSON. Exceeding either limit fails with `comment-list-limit`, rather than creating a comment after an incomplete scan. A human may copy the marker. That comment never counts, because author type, login, and numeric ID do not match the product bot policy. Human comments that carry the marker text are reported by ID in the job summary and never modified.

This release uses the GitHub.com Actions bot account, login `github-actions[bot]`, numeric user ID `41898282`, and type `Bot`. All three must match. The same account runs review comment reads and publish writes. Supporting a GitHub App requires a later explicit bot identity configuration, not a permissive fallback.

`prepareFixedRepository` creates a new bare repository under a clean temporary directory. It disables system and global Git config, hooks, external diff, filters, submodules, credential helpers, and prompts. It fetches the captured base and head object IDs from the canonical HTTPS repository URL, with `--no-tags` and no shallow limit, then verifies both IDs with `cat-file` and `rev-parse`. It computes the merge base locally. If a force push removes an object before fetch, the run fails with `snapshot-fetch` and does not substitute a newer SHA. The next run re-captures current state.

The Git token reaches Git only through a child-only environment variable read by a fixed, product-owned askpass helper. The helper contains no token. Git gets `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, an empty credential helper, and no ambient `GIT_*` values. The remote URL never includes credentials. The bare repository is never part of material, never runs a script from its tree, and is removed on completion.

The default `--config review.config.json` permits a missing base blob and then uses the product default, with a recorded `product-default` source. An explicitly different path must exist. An existing malformed config always fails. The blob must be a regular file, at most 16 KiB, valid UTF-8 JSON, and match the existing three-field strict limits schema. No symlink, code import, environment expansion, endpoint, or secret is allowed. A head edit cannot alter this configuration. The result records both the raw configuration blob hash and the effective configuration hash used by `ReviewResult.versions.config`.

`readFixedLines` groups citations by side and path, fetches their fixed objects once into a separate temporary bare repository, validates regular modes and the normalized path, and applies the existing line and excerpt rules. It also recomputes the merge base and changed head path set. It rejects an issue whose change location is not a changed head path. It reads each file with an 8 MiB cap and the total set with a 16 MiB cap. It does not execute target tests or files.

### CLI grammar and exit codes

```ts
type Command =
	| { kind: "review-local"; input: ReviewInput }
	| { kind: "review-pr"; repository: string; pr: number; config: string; out: string }
	| { kind: "publish"; repository: string; pr: number; packageDirectory: string; reviewJobResult: JobResult };
function parseCommand(argv: readonly string[]): Command;
function readExecutionContext(env: NodeJS.ProcessEnv, budget: ExecutionBudget): Promise<Execution>;
function runPrReview(command: Extract<Command, { kind: "review-pr" }>, deps: PrReviewDependencies): Promise<ReviewCommandOutcome>;
function publishReview(command: Extract<Command, { kind: "publish" }>, deps: PublishDependencies): Promise<PublishCommandOutcome>;
```

The dependency and result definitions complete these entry signatures. Defaults construct the production adapters. Tests inject the same interfaces, never a different command grammar.

```ts
type ProgressEvent = {
	runId: string;
	sequence: number;
	at: string;
	phase: "capture" | "preparation" | "initialization" | "discovery" | "verification" | "cleanup" | "handoff" | "publish";
	event: "start" | "progress" | "end" | "failure";
	changedFilesIncluded: number | null;
	changedFilesTotal: number | null;
	candidatesDiscovered: number | null;
	candidatesVerified: number | null;
	remainingMs: number;
	runUrl: string | null;
};
type ProgressSink = (event: ProgressEvent) => void;
type Clock = {
	monotonicMs(): number;
	wallTime(): string;
	sleep(ms: number, signal: AbortSignal): Promise<void>;
};
type PrReviewDependencies = {
	github: GitHubReader;
	execution: Execution;
	progress: ProgressSink;
	model: () => ReturnType<typeof loadModelConfiguration>;
	budget: ExecutionBudget;
	runWorker?: DiscoveryWorker;
};
type PublishDependencies = {
	github: GitHubPublisher;
	execution: ActionsExecution;
	progress: ProgressSink;
	productCommit: GitSha;
	programHash: Sha256;
	budget: ExecutionBudget;
};
type ReviewCommandOutcome = {
	outcome: PrOutcome;
	runDirectory: string;
	handoffDirectory: string | null;
	artifactName: string | null;
	exitCode: 0 | 1;
};
type PublishCommandOutcome = {
	publication: PublicationResult;
	runUrl: string;
	commentId: string | null;
	evidenceDirectory: string;
	exitCode: 0 | 1;
};
```

`productCommit` and `programHash` in publish dependencies come from the fixed Action context and installed product files. The CLI supplies them through one `readProductIdentity()` result when constructing dependencies. They do not come from the package. Library callers create their budget before calling either operation. Tests construct it with a manual clock. There is one orchestration implementation.

The parser removes one initial `--`, accepts a subcommand or the legacy local flag form, rejects unknown flags, duplicate flags, missing values, positional extras, zero or negative PR numbers, mixed local and PR flags, and mixed review and publish flags. A help-only command exits 0 before reading secrets. A relative config path uses `relativePathSchema`. Output paths use the existing new-directory and outside-repository rules. CLI values enter subprocesses as argument array elements and enter HTTP paths through segment encoding.

The CLI writes exactly one JSON summary line to stdout after a handled terminal outcome. Progress goes to stderr and the job summary. Invalid arguments write a sanitized error to stderr and no stdout result. Exit 0 means reviewed complete, reviewed partial without an infrastructure error, skipped, stale-before-write, or already-published. Exit 1 means a failed review, a partial review caused by interruption, timeout, or cleanup failure, a rejected package, a missing-artifact failure note, a failed publish, or invalid input. Partial coverage caused only by material caps, the five-issue publication cap, or unverified candidates remains advisory and exits 0. A truncated model JSON output remains a format failure. Findings never determine exit status.

The distinction between a usable partial report and a failed job is deliberate. A timed-out run can publish verified partial work, but it still leaves Actions red. The CLI never catches a publish exception and converts it into success.

### Exact handoff schemas and layout

The handoff is small and separate from replay data.

```text
<out>/
  handoff/
    review-result.json
    run-manifest.json
  replay/
    result.json
    manifest.json
    report.md
    input.json
    material/
    candidates.json
    verifications.json
    sessions.json
    tool-trace.json
    timing.json
    usage.json
    cleanup.json
    configuration.json
    prompts.json
    versions.json
    previous-comment.json
```

`runPrReview` owns `<out>` and its staging sibling. `runReview` writes into `<out>/replay`, which remains a new directory as required by Segment 1. `previous-comment.json` is a bounded backup, not authority for publication. It is never inserted into prompts. Existing local runs retain their current flat layout.

The following schemas live only in `src/handoff.ts`. They compose the authoritative domain schemas instead of copying their fields.

```ts
const versionRecordSchema = z.strictObject({
	productCommit: gitShaSchema,
	programHash: digestSchema,
	bun: z.literal("1.4.4"),
	sdk: z.literal("2.2.7"),
	plugin: z.literal("2.2.7"),
	discoverPrompt: digestSchema,
	verifyPrompt: digestSchema,
});
const configRecordSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("base-blob"), path: relativePathSchema, sourceSha: gitShaSchema, sourceDigest: digestSchema, effectiveDigest: digestSchema }),
	z.strictObject({ kind: z.literal("product-default"), sourceDigest: digestSchema, effectiveDigest: digestSchema }),
]);
const modelRecordSchema = z.strictObject({
	providerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
	modelId: z.string().trim().min(1).max(256),
});
const backupReceiptSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("absent") }),
	z.strictObject({ kind: z.literal("captured"), commentId: commentIdSchema, bodyDigest: digestSchema, updatedAt: instantSchema }),
	z.strictObject({ kind: z.literal("unavailable"), code: failureCodeSchema }),
]);
const capturedSnapshotSchema = z.strictObject({
	baseSha: gitShaSchema,
	headSha: gitShaSchema,
	mergeBaseSha: gitShaSchema.nullable(),
	observedAt: instantSchema,
});
const reviewResultFileSchema = z.strictObject({
	schemaVersion: z.literal(1),
	identity: identitySchema,
	execution: executionSchema,
	captured: capturedSnapshotSchema.nullable(),
	outcome: prOutcomeSchema,
	backup: backupReceiptSchema,
	completedAt: instantSchema,
});
const resultReceiptSchema = z.strictObject({
	name: z.literal("review-result.json"),
	bytes: z.int().positive().max(524_288),
	sha256: digestSchema,
});
const runManifestFileSchema = z.strictObject({
	schemaVersion: z.literal(1),
	identity: identitySchema,
	execution: executionSchema,
	captured: capturedSnapshotSchema.nullable(),
	versions: versionRecordSchema,
	config: configRecordSchema.nullable(),
	model: modelRecordSchema.nullable(),
	result: resultReceiptSchema,
	artifactName: z.string().regex(/^ai-code-review-handoff-[1-9][0-9]{0,19}-[1-9][0-9]{0,6}$/).nullable(),
	replayArtifactName: z.string().regex(/^ai-code-review-replay-[1-9][0-9]{0,19}-[1-9][0-9]{0,6}$/).nullable(),
	completedAt: instantSchema,
});
type ReviewResultFile = z.infer<typeof reviewResultFileSchema>;
type RunManifestFile = z.infer<typeof runManifestFileSchema>;
```

The model record captures configured identity, not usage. The review job resolves it once at initialization from the non-secret model environment, before any request exists. An Actions execution always has a non-null model record, because the reusable workflow declares the model inputs as required. An all-omitted or zero-request run still records the configuration it would have used. Admission therefore requires a non-null model record for every Actions manifest, whatever the outcome, and resolves no ambiguity between "the model was never called" and "the record is missing". A local execution may have a null model record when no model environment is present.

Cross-field validation is part of package admission. Both identities, executions, captures, and completion timestamps must match exactly. A reviewed result requires non-null configuration and merge base, and, for Actions, a non-null model record. Its three snapshot SHAs and program, config, and prompt versions must equal the manifest. A skipped run may have captured base and head without a merge base. An early failure may have no capture. A captured failure never claims a completed `ReviewResult`. Local manifests have null artifact names. Actions manifests derive both names from the exact decimal run ID and attempt, never from file input.

`programHash` preserves the existing sorted TypeScript source hash algorithm. `productCommit` records the fixed Action checkout. Prompt digests hash the exact installed prompt bytes. Configuration source digests hash exact base blob bytes or exact product default bytes. The effective digest hashes the canonical serialized effective run configuration using stable object keys, including model ID, limits, read limits, phase caps, step cap, and issue caps. Secrets and endpoint credentials are absent. The non-secret endpoint remains in `replay/configuration.json`, not in the publication state.

Serialization uses UTF-8, LF, `JSON.stringify(value, null, 2) + "\n"`. SHA-256 covers the exact bytes of `review-result.json`, including its newline. The manifest does not hash itself. There is no recursive digest. The manifest has a 32 KiB byte cap. The result has a 512 KiB cap. The handoff directory must contain exactly these two regular files, each with link count one, and no symlink, directory, or extra entry. The download step writes only into a newly created directory below runner temp. The pinned download Action owns archive extraction. The artifact producer is fixed product code that uploads only the committed two-file directory. Admission independently checks the extracted file shape, total size, identity, digest, and source evidence before any write. The design does not claim to implement a separate hostile ZIP parser. The download Action and GitHub artifact service remain in the trusted computing base.

`writePrHandoff` writes both files into a new sibling staging directory, flushes and closes them, then renames that directory into `<out>/handoff`. It never uploads a directory with only one committed file. If the result would exceed its cap, it writes a bounded `artifact-write` failure envelope with no issues and leaves the oversized original in replay. Coverage arrays are capped during aggregation to 2,000 included paths, 2,000 omitted descriptions, eight candidate IDs, and 128 notes. An overflow adds an exact omitted-entry count and makes coverage partial. It never silently calls a truncated inventory complete. The complete inventory remains in the detailed context manifest.

The upload artifact is `ai-code-review-handoff-${runId}-${attempt}`. The separate replay artifact is `ai-code-review-replay-${runId}-${attempt}`. Both have seven-day retention for Segment 2 acceptance. The replay uploader uses an explicit allowlist of the paths above and excludes the worker `runtime` directory, temporary Git repository, askpass environment, and credential sources. A replay cap of 64 MiB records omitted trace bytes in `replay/artifact-omissions.json`. This does not alter analyzed scope, but the summary states that replay is incomplete. No artifact is overwritten across attempts.

`admitHandoff` returns a domain `AdmittedRun` without exposing either wire schema.

```ts
type ExpectedPublication = {
	identity: PullRequestIdentity;
	execution: ActionsExecution;
	reviewJobResult: JobResult;
	productCommit: GitSha;
	programHash: Sha256;
};
type AdmittedRun = {
	identity: PullRequestIdentity;
	execution: ActionsExecution;
	captured: { baseSha: GitSha; headSha: GitSha; mergeBaseSha: GitSha | null } | null;
	outcome: PrOutcome;
	resultDigest: Sha256;
	completedAt: string;
};
type Admission =
	| { kind: "valid"; run: AdmittedRun }
	| { kind: "missing"; failure: Failure }
	| { kind: "rejected"; failure: Failure };
function admitHandoff(directory: string, expected: ExpectedPublication, github: GitHubReader, budget: ExecutionBudget): Promise<Admission>;
```

The admission order is expected Actions context, current run attempt, artifact provenance, file shape and caps, digest, schemas, identity equality, fixed snapshot equality, version hashes, and independent citation checks. The publisher lists artifacts for the current workflow run, filters the exact attempt-bearing name, requires one unexpired match, and compares the receipt with the downloaded artifact. The artifact ID and digest emitted by upload are recorded when available, but job outputs are not required, because failed jobs might not expose them. The run-scoped artifact endpoint and exact expected name are mandatory. The publisher rejects multiple exact-name artifacts or an artifact associated with another run. It independently hashes its own fixed product source and prompt files, and requires the manifest to match.

A checksum detects corruption. Trust also depends on the fixed product code, the read-only review job, no execution of PR code, the current-run artifact endpoint, and identity validation. A collaborator who can replace a trusted caller workflow or its secret configuration is already an administrator of this integration. Segment 2 does not claim cryptographic isolation from that administrator.

### Publish decision model

The analysis status remains one of `complete`, `partial`, `failed`, or `skipped`. Freshness is a separate publication property. A stale result does not become a fifth analysis status.

```ts
type Freshness =
	| { kind: "current" }
	| { kind: "stale"; observedBase: GitSha; observedHead: GitSha; reason: "base-changed" | "head-changed" | "base-and-head-changed" | "closed" | "draft" | "fork" };
type PublishDecision =
	| { kind: "reject"; failure: Failure }
	| { kind: "retain"; reason: "stale-before-write" | "older-publication" | "already-published"; run: AdmittedRun | null }
	| { kind: "write"; state: CommentState; body: string; expectedHead: GitSha; expectedBase: GitSha }
	| { kind: "write-failure-note"; state: CommentState; body: string; expectedHead: GitSha; expectedBase: GitSha; failure: Failure };
type PublicationResult =
	| { kind: "published"; commentId: string; freshness: Freshness }
	| { kind: "retained"; reason: "stale-before-write" | "older-publication" | "already-published" }
	| { kind: "rejected"; failure: Failure }
	| { kind: "failed"; failure: Failure; commentId: string | null };
function decidePublish(input: {
	expected: ExpectedPublication;
	admitted: Admission;
	current: PullRequestCapture;
	previous: CommentObservation;
}): PublishDecision;
```

Decision precedence is fixed.

1. Reject invalid identity, inactive attempt, or a rejected package. A wrong PR, wrong attempt, or corrupt package never changes a comment, including its failure banner. Write a rejection summary in Actions and keep the current valid report.
2. Reject an invalid owned comment state. Preserve its body and provide the canonical comment ID in Actions. Do not infer state from rendered text, create a replacement comment, or silently clear history. A human can remove the damaged bot comment and rerun after inspecting its saved body.
3. Compare publication order with `lastPublishedRun`. For the same run ID, an attempt must be greater or identical. Across runs compare `(triggeredAt, workflowRunId as BigInt)`. An older tuple cannot replace a newer publication even if both reference the same head. Equal run and attempt with an equal digest is already published. Equal run and attempt with a different digest is an artifact conflict and rejects.
4. For an analyzed or failed captured run, re-fetch and compare the PR's repository ID, PR number, open state, draft and fork eligibility, base SHA, and head SHA. A changed tuple retains the comment unchanged and records `stale-before-write`. No stale H1 report replaces a valid H2 report. A skipped outcome can write a skip note when the current identity, SHAs, and skip reason still match capture. The note updates only run metadata while retaining `lastReport`. It never presents a previous report as current for a draft, closed, or fork PR. A skip reason that changes before write causes retention until a new run captures it.
5. A valid complete or partial review updates `lastReport` and `lastPublishedRun`. A failed or skipped run updates only `lastPublishedRun`. The last usable report stays separately labeled with its covered commit, status, and run.
6. A genuinely missing package uses `needs.review.result` to construct a failure note against the PR state captured now. It does not invent the analyzed head. Its `lastPublishedRun` has `snapshot: null` and `status: failed`. The visible note says that no validated review artifact exists and names the review job outcome. It preserves `lastReport`. Even a successful review job with no artifact yields `artifact-missing` and a failed publish job.

`lastReport` includes complete and partial reports with validated analysis. A partial report can have zero issues and unverified candidates. The visible text must say `Partial review. No verified findings in the completed work.` A zero-issue complete report says `Complete review. No verified findings.` A failed report says `Review failed. This run has no usable report.` These strings have separate golden tests.

### Comment state and deterministic body

The comment module is pure. `src/comment.ts` defines the marker, the state schema, the encoder and parser, the renderer, and the escaper. `src/publish.ts` supplies all I/O.

The first line is an exact product and identity marker.

```text
<!-- ai-code-review:v1 repo=123456789 pr=17 -->
```

Only canonical decimal digits appear in the marker. The repository name is displayed separately because names can change. Matching uses repository numeric ID and PR number. Comment discovery requires the author policy and the exact marker line at byte offset zero. It does not use substring matching.

The final block carries canonical JSON as base64url, with no padding or whitespace.

```ts
function encodeStateBlock(state: CommentState): string {
	const encoded = Buffer.from(canonicalJson(state), "utf8").toString("base64url");
	return ["<!-- ai-code-review-state:v1", encoded, "-->"].join("\n");
}
```

`canonicalJson` sorts object keys recursively, preserves array order, uses JSON string escaping, and emits no insignificant whitespace. The parser accepts only the renderer's canonical base64url representation and bounds decoded bytes before JSON parsing. There is exactly one state block and one identity marker. Extra markers or blocks make the comment invalid. Marker-like text from model content is escaped before rendering.

The private schemas in `src/comment.ts` are as follows.

```ts
const boundedLocationSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("inline"), side: z.enum(["merge-base", "head"]), path: relativePathSchema, startLine: z.int().positive(), endLine: z.int().positive() }),
	z.strictObject({ kind: z.literal("artifact"), referenceDigest: digestSchema }),
]);
const issueSummarySchema = z.strictObject({
	ordinal: z.int().min(1).max(5),
	trigger: z.string().max(240),
	consequence: z.string().max(240),
	rootCause: z.string().max(240),
	verification: z.string().max(240),
	location: boundedLocationSchema,
	summarized: z.boolean(),
});
const reportSummarySchema = z.strictObject({
	status: z.enum(["complete", "partial"]),
	snapshot: snapshotSchema,
	execution: actionsExecutionSchema,
	resultDigest: digestSchema,
	completedAt: instantSchema,
	issues: z.array(issueSummarySchema).max(5),
	coverage: z.strictObject({ included: z.int().nonnegative(), omitted: z.int().nonnegative(), unverified: z.int().min(0).max(8), unpublished: z.int().min(0).max(8) }),
	usage: z.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("known"), inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative() }),
		z.strictObject({ kind: z.literal("unknown") }),
	]),
	durationMs: z.int().nonnegative(),
	summarized: z.boolean(),
});
const freshnessSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("current") }),
	z.strictObject({ kind: z.literal("stale"), observedBase: gitShaSchema, observedHead: gitShaSchema, reason: z.enum(["base-changed", "head-changed", "base-and-head-changed", "closed", "draft", "fork"]) }),
	z.strictObject({ kind: z.literal("unconfirmed"), reason: z.literal("postcheck-unavailable") }),
	z.strictObject({ kind: z.literal("not-reviewed") }),
]);
const publishedRunFields = {
	execution: actionsExecutionSchema,
	freshness: freshnessSchema,
};
const lastPublishedRunSchema = z.discriminatedUnion("status", [
	z.strictObject({ ...publishedRunFields, status: z.enum(["complete", "partial"]), snapshot: snapshotSchema, resultDigest: digestSchema }),
	z.strictObject({ ...publishedRunFields, status: z.literal("failed"), snapshot: snapshotSchema.nullable(), resultDigest: digestSchema.nullable(), failure: failureSchema }),
	z.strictObject({ ...publishedRunFields, status: z.literal("skipped"), snapshot: snapshotSchema.nullable(), resultDigest: digestSchema, skipReason: skipReasonSchema }),
]);
const commentStateSchema = z.strictObject({
	schemaVersion: z.literal(1),
	identity: identitySchema,
	lastReport: reportSummarySchema.nullable(),
	lastPublishedRun: lastPublishedRunSchema,
	duplicateCommentIds: z.array(commentIdSchema).max(20),
	additionalDuplicateCount: z.int().nonnegative(),
});
type CommentState = z.infer<typeof commentStateSchema>;
```

State parsing validates run URLs by rebuilding them from the fixed origin, repository, run ID, and attempt. It validates identity, snapshot SHAs, issue ordinal continuity, line ranges, status-specific fields, and report and publication ordering. A failed publication requires a failure. A skipped publication requires a skip reason. Complete and partial require a snapshot and result digest. `lastReport.execution` cannot be newer than `lastPublishedRun.execution`. A failed run can therefore retain an older `lastReport` without contradiction.

The renderer never embeds the full `ReviewResult` in state. It stores a bounded summary and links the full report to the immutable Actions run and artifact. Each issue in the comment carries a one-line citation reference only, never an excerpt block. A citation line reads `src/OrderService.java:42-45 (head)`, built from the bounded location fields. Full evidence, including excerpts, stays in the replay artifact and the run link. This keeps the body small and makes a fence war with model text impossible, because no evidence excerpt is ever rendered.

Each issue string is normalized to LF and trimmed to 240 UTF-16 code units without splitting a surrogate pair. The renderer adds an explicit ellipsis and sets `summarized: true` when it trims text. If canonical decoded state exceeds 16 KiB, it reduces issue strings to 120, then 60, then zero code units. Within each pass, it visits descending issue ordinal and the fields verification, rootCause, trigger, then consequence. It retains counts, digests, status, and provenance.

If the state still exceeds 16 KiB, convert locations in descending ordinal order to the SHA-256 digest of their canonical original `CodeReference`, stored as the `artifact` location kind. The visible issue then links to the run artifact for the full citation. This preserves a verifiable reference without retaining arbitrarily long paths in a shared comment. The implementation checks the final minimal state against maximum-length legal identity, URL, IDs, and errors. If unexpected serialization overflow remains, publication fails before a write. It does not clear `lastReport`.

The body is deterministic for identical state. It contains the marker, current run status, freshness warning, covered base and head, run link, last usable report if retained, at most five numbered issue summaries with one-line citations, coverage counts, usage state, and the encoded block. It has a 60,000-byte UTF-8 cap. The state encoding consumes at most 21,846 bytes. Visible output has a 32,000-byte cap. If visible detail exceeds that cap, the renderer reduces issue summaries by the same fixed shrinking rules and adds the full-artifact link. State and visible content derive from the same final bounded summary, never from separate mutable copies.

Every untrusted string passes through `sanitizeCommentText`. It encodes `&`, `<`, `>`, quotes, Markdown punctuation, and `@` as an entity. It replaces every `<!--` with `<! -` so model text cannot open an HTML comment. It replaces every occurrence of the marker token `ai-code-review:v1` with the plain text `ai-code-review (marker removed)`, so model text cannot forge the marker line. Newlines in prose become spaces. Paths in URLs use per-segment percent encoding. The renderer builds the API host, repository route, commit SHA, and run route itself. Model text cannot provide a link destination, raw HTML, image, task checkbox, command annotation, hidden comment, or user mention. Logs also neutralize `::` at line starts to prevent Actions command injection.

### Comment upsert, uncertain writes, and duplicates

There is exactly one writer for a repository and PR, the whole reusable workflow under its concurrency group. The public publish operation requires an active Actions run whose current API attempt equals `GITHUB_RUN_ATTEMPT`. It refuses local writes. The guarantee assumes callers use the supplied workflow and do not run another publisher outside that group. The issue comments API has no compare-and-swap create operation, so the product does not claim exactly-once creation under unrelated external writers.

The upsert algorithm is a reconciliation loop with at most three write attempts, all under one publish budget.

1. List all issue comments with pagination. Filter by bot policy and exact identity marker. Sort by numeric comment ID. The lowest ID is canonical. Record every other matching ID as a duplicate. Do not delete or update duplicate comments. Never create when any owned marker exists, even if its state cannot be parsed.
2. Read the canonical state and calculate the next state. If its publication tuple and digest already match, perform only any needed freshness recheck, then return `already-published`.
3. Immediately before each write attempt, recheck active run attempt, PR eligibility, and base and head. A stale planned analyzed result stops without a write. Re-list after an earlier uncertain write before deciding create versus update.
4. If canonical exists, `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}` with the deterministic body. If none exists, `POST /repos/{owner}/{repo}/issues/{pr}/comments`. Never call the pull request review API.
5. A confirmed response must have the expected author, issue identity, and exact body. A disconnect, timeout, connection reset, or transient response with uncertain mutation enters reconciliation. It never directly repeats POST or PATCH.
6. A POST whose outcome is unknown is never repeated within this invocation. Re-list the complete comment set up to three times with bounded backoff. Look for a bot comment with the product marker whose state's `lastPublishedRun` run identity equals this run, or whose body bytes equal the intended body. If found, adopt that comment, PATCH it to the intended body if it differs, and continue with the post-write check. If it is not found after three reads, end the invocation with `comment-write-unknown` and create nothing. The next workflow run or manual rerun lists by marker first and updates the original comment. The product never blindly creates a second comment after an ambiguous create.
7. A PATCH with an unknown outcome is safe to repeat after a read confirms that the canonical comment still contains an older publication, because the target ID is known and the body is deterministic. A newer publication aborts this attempt. A 404 on PATCH requires a fresh list. If the owned canonical was deleted, the absence path of step 6 applies to a single new POST, with the same no-repeat rule after an uncertain response. The product never PATCHes a human comment ID received from the artifact.
8. After confirmation, re-fetch PR base and head and eligibility. If unchanged, record current freshness. If changed, PATCH the same canonical comment to mark the just-written report stale and show both covered and observed SHAs. The report stays explicitly bound to H1. An uncertain annotation PATCH follows the same read-before-write recovery of step 7. If the postcheck cannot complete, PATCH a deterministic `unconfirmed` warning if possible, fail the publish job, and retain artifacts. The comment may still show the earlier body if GitHub is unavailable.

The annotation in step 8 is a different write intent from the initial report write. It keeps `lastReport`, execution, and result digest unchanged and changes only freshness metadata and its visible warning. It requires the active attempt and the same canonical publication, but it does not require the current PR to match H1. Reapplying the initial predicate would prevent the required stale annotation. Annotation recovery confirms the exact desired body digest, not only the run and result digest, because both pre-annotation and post-annotation bodies share the run and result digest. If a newer publication appears, the old annotation stops. One successful postcheck and any required annotation end this execution. A later H3 still leaves an explicitly stale H1 report until the next run.

The tradeoff of the strict no-repeat rule is accepted. A POST that never left the client costs one failed publish, recovered by the next run or a manual rerun. It removes the only path where the product could create a second comment, and it makes the acceptance fault-injection row deterministic.

No finite number of absence reads can prove that an unacknowledged POST will never appear later in a distributed service. The design's lost-response guarantee covers a committed comment visible to subsequent list requests, as in the required fault injection. If a delayed server write creates a historical duplicate anyway, the next run selects the lowest ID and stops creating. This limitation belongs in the final product docs rather than an invented exactly-once claim.

Duplicates appear in the job summary and visible comment warning with their IDs and count. Store the first 20 IDs and an additional count in state. Do not create a separate warning comment. Invalid state in a duplicate does not block updating a valid canonical comment, but invalid canonical state does block writes. The review-time backup is diagnostic only. The publisher always re-reads current state and never overwrites it from that backup.

### Workflow and Action wiring

`action.yml` is a composite Action. Its inputs are `mode` required with `review` or `publish`, `config` default `review.config.json`, `pr` required as a decimal string, and `model-api-key` with an empty default. The last input reaches only the command step in review mode. Publish omits it. Repository identity comes from the caller's `GITHUB_REPOSITORY`, not a second input. Publish receives `REVIEW_JOB_RESULT` from the workflow. Non-secret model settings arrive as environment on the review Action step. The Action validates inputs before invoking the CLI.

Its outputs are `status`, `run-directory`, `handoff-directory`, `handoff-artifact`, `replay-artifact`, and `comment-id`. Publish leaves review path outputs empty. The review script writes output paths before the model starts, so later upload steps do not depend on a successful final return. The reusable workflow also knows the deterministic runner-temp paths and uses those directly when an Action fails before outputs are available.

```yaml
name: AI code review
description: Review a fixed PR snapshot or publish its validated result
inputs:
  mode:
    description: review or publish
    required: true
  config:
    description: Configuration path in the frozen base tree
    default: review.config.json
  pr:
    description: Pull request number
    required: true
  model-api-key:
    description: Model credential used only by the review command step
    default: ''
outputs:
  status:
    value: ${{ steps.command.outputs.status }}
  run-directory:
    value: ${{ steps.command.outputs.run-directory }}
  handoff-directory:
    value: ${{ steps.command.outputs.handoff-directory }}
  handoff-artifact:
    value: ${{ steps.command.outputs.handoff-artifact }}
  replay-artifact:
    value: ${{ steps.command.outputs.replay-artifact }}
  comment-id:
    value: ${{ steps.command.outputs.comment-id }}
runs:
  using: composite
  steps:
    - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6
      with:
        bun-version: 1.4.4
    - name: Install product dependencies
      shell: bash
      working-directory: ${{ github.action_path }}
      run: bun install --frozen-lockfile --ignore-scripts
    - name: Run product command
      id: command
      shell: bash
      env:
        REVIEW_ACTION_MODE: ${{ inputs.mode }}
        REVIEW_ACTION_CONFIG: ${{ inputs.config }}
        REVIEW_ACTION_PR: ${{ inputs.pr }}
        REVIEW_PRODUCT_DIRECTORY: ${{ github.action_path }}
        REVIEW_PRODUCT_COMMIT: ${{ github.action_ref }}
        REVIEW_MODEL_API_KEY: ${{ inputs.mode == 'review' && inputs.model-api-key || '' }}
      run: bun --no-env-file run "$GITHUB_ACTION_PATH/src/action-entry.ts"
```

`src/action-entry.ts` is a thin fixed product entry. It verifies mode, derives `${RUNNER_TEMP}/ai-code-review-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`, sets outputs, and invokes `src/cli.ts` with an argument array, absolute product path, and `--no-env-file`. Its working directory is the product Action directory. It hashes fixed product files to validate provenance. It does not call `bun run review` in the caller workspace. It does not source `.env.local`. The review and publish entry use the same product commit A.

`REVIEW_PRODUCT_DIRECTORY` is a parsed path used for provenance. The actual location comes from `GITHUB_ACTION_PATH`, which the runner provides. `REVIEW_PRODUCT_COMMIT` comes from the remote Action's `github.action_ref` and must parse as a full commit SHA. A branch or tag invocation fails the publish preflight. Downloaded Action directories need no `.git` metadata. Local PR review obtains its product commit from the product checkout instead. A path or commit supplied by PR content cannot replace these values.

The following is the exact body returned by `renderReusableWorkflow(actionCommit)`. The implementation writes the result to `.github/workflows/review.yml` only after commit A contains the runnable root Action. The future commit is substituted during generation, just as in the caller generator. GitHub sees a literal full SHA in each `uses` field.

```ts
function renderReusableWorkflow(actionCommit: GitSha): string {
	return `name: Reliable PR review
on:
  workflow_call:
    inputs:
      pr:
        type: string
        required: true
      config:
        type: string
        default: review.config.json
      model-provider-id:
        type: string
        required: true
      model-base-url:
        type: string
        required: true
      model-id:
        type: string
        required: true
    secrets:
      model-api-key:
        required: true
permissions: {}
concurrency:
  group: ai-code-review-v1-\${{ github.repository_id }}-pr-\${{ inputs.pr }}
  cancel-in-progress: false
jobs:
  review:
    runs-on: ubuntu-24.04
    timeout-minutes: 8
    permissions:
      contents: read
      pull-requests: read
      actions: read
    steps:
      - name: Review current PR
        id: review
        uses: PulseInjector/ai-code-review@${actionCommit}
        with:
          mode: review
          config: \${{ inputs.config }}
          pr: \${{ inputs.pr }}
          model-api-key: \${{ secrets.model-api-key }}
        env:
          GITHUB_TOKEN: \${{ github.token }}
          REVIEW_MODEL_PROVIDER_ID: \${{ inputs.model-provider-id }}
          REVIEW_MODEL_BASE_URL: \${{ inputs.model-base-url }}
          REVIEW_MODEL_ID: \${{ inputs.model-id }}
      - name: Upload publication handoff
        if: \${{ always() && !cancelled() }}
        id: handoff
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: ai-code-review-handoff-\${{ github.run_id }}-\${{ github.run_attempt }}
          path: \${{ runner.temp }}/ai-code-review-\${{ github.run_id }}-\${{ github.run_attempt }}/handoff/
          if-no-files-found: warn
          retention-days: 7
      - name: Upload replay evidence
        if: \${{ always() && !cancelled() }}
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: ai-code-review-replay-\${{ github.run_id }}-\${{ github.run_attempt }}
          path: \${{ runner.temp }}/ai-code-review-\${{ github.run_id }}-\${{ github.run_attempt }}/replay-export/
          if-no-files-found: warn
          retention-days: 7
  publish:
    needs: review
    if: \${{ always() && !cancelled() }}
    runs-on: ubuntu-24.04
    timeout-minutes: 4
    permissions:
      contents: read
      pull-requests: write
      actions: read
    steps:
      - name: Download this execution's handoff
        id: download
        continue-on-error: true
        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
        with:
          name: ai-code-review-handoff-\${{ github.run_id }}-\${{ github.run_attempt }}
          path: \${{ runner.temp }}/ai-code-review-download
      - name: Publish validated feedback
        if: \${{ !cancelled() }}
        uses: PulseInjector/ai-code-review@${actionCommit}
        with:
          mode: publish
          config: \${{ inputs.config }}
          pr: \${{ inputs.pr }}
        env:
          GITHUB_TOKEN: \${{ github.token }}
          REVIEW_JOB_RESULT: \${{ needs.review.result }}
          REVIEW_DOWNLOAD_OUTCOME: \${{ steps.download.outcome }}
      - name: Upload publication evidence
        if: \${{ always() && !cancelled() }}
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: ai-code-review-publish-\${{ github.run_id }}-\${{ github.run_attempt }}
          path: \${{ runner.temp }}/ai-code-review-\${{ github.run_id }}-\${{ github.run_attempt }}/publish-evidence/
          if-no-files-found: warn
          retention-days: 7
`;
}
```

`action-entry.ts` selects `${RUNNER_TEMP}/ai-code-review-download` for publish mode. It validates the download step outcome and still invokes the publisher when download fails. The package directory may be absent. The publisher queries artifact metadata to distinguish absence from a corrupt download or unavailable artifact service. A metadata lookup failure is `github-unavailable`, not a fabricated absence. The action does not read model environment in publish mode and has no runtime import of `review.ts` or SDK modules on that dispatch path. Use dynamic imports in the CLI so loading the publisher cannot start or initialize model infrastructure.

The review step has no `continue-on-error`. Upload steps run after failure, and the publish job runs after a failed review job. The workflow therefore remains failed after a successful failure note. Upload failure also fails the review job. A cancelled workflow skips publication. A cancelled review job inside a non-cancelled workflow can produce a missing-artifact failure note. The publisher's `needs` condition uses `always()` to override default success propagation.

The review command's 300-second budget excludes dependency installation, queue time, artifact transfer, and the separate publish job. Actions timing records those costs separately. The review job timeout of eight minutes leaves space for install and evidence upload. The publisher has a 120-second operation budget within its four-minute job, including metadata, comment pagination, source checks, writes, and postchecks. Those are not added to the model's 300-second budget.

No target checkout Action is needed. The product fetches immutable target objects into a dedicated directory and reuses Segment 1 export. All third-party refs are full commits. The refs shown were resolved from upstream on 2026-11-21. They correspond to setup-bun's current `v2` ref, upload-artifact `v4.6.2`, and download-artifact `v4.3.0`. They require source review at the Action checkpoint before committing. Newer upstream tags are not substituted automatically. Segment 5 owns the ongoing third-party ref governance policy, so this segment records the resolved commits and defers the update cadence decision.

The workflow concurrency group uses product ID, numeric repository ID, and the canonical PR input. The caller generator and Action parser require canonical decimal formatting, so `017` and `17` cannot produce separate groups. The workflow input is a string to preserve exact formatting. The default single pending slot stays unchanged. An active run finishes. A newer pending run can replace an older pending run. Each actual start re-reads the current PR and never trusts a queued event's head.

### Budget, retries, and durable acceptance

The worker's atomic progress record extends the existing `RuntimeResult` with `checkpointSequence`, `submission`, `requests`, and absolute phase deadlines. A parent accepts completed phase text only after its own schema and citation validation. The validated checkpoint is a parent-owned domain value, not a claim trusted from the child.

```ts
const phaseCheckpointSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("none") }),
	z.strictObject({ kind: z.literal("discovered"), output: discoveryOutputSchema }),
	z.strictObject({ kind: z.literal("verified"), discovery: discoveryOutputSchema, verification: verificationOutputSchema }),
]);
type PhaseCheckpoint = z.infer<typeof phaseCheckpointSchema>;
const requestRecordSchema = z.strictObject({
	sequence: z.int().positive(),
	phase: z.enum(["initialization", "discovery", "verification"]),
	sessionId: z.string().min(1).max(256),
	kind: z.enum(["primary", "compaction", "title", "generate"]),
	attempt: z.int().min(1).max(3),
	startedAt: instantSchema,
	finishedAt: instantSchema.nullable(),
	status: z.int().min(100).max(599).nullable(),
	outcome: z.enum(["started", "response", "transport-error", "unknown"]),
});
type RequestRecord = z.infer<typeof requestRecordSchema>;
type PhaseDeadlines = {
	prepareInitEpochMs: number;
	discoveryEpochMs: number | null;
	analysisStopEpochMs: number;
	workerKillEpochMs: number;
	finalEpochMs: number;
};
```

`discoveryOutputSchema` and `verificationOutputSchema` are the existing authoritative schemas from `contracts.ts`. The verified checkpoint additionally requires exact candidate ID-set equality and source validation through `phase-validation.ts`. The parent reconstructs `PhaseCheckpoint` from complete raw session outputs. It does not parse an interrupted assistant fragment. The worker's sequence is monotonic and its final and progress filename protocol remains atomic.

Request records cap at 256 entries in IPC. Reaching that cap stops new requests with `request-budget`. The full trace writer cannot silently drop a request. The reducer treats this code as a recoverable cap after a valid checkpoint and records the exact stop reason. This limit bounds IPC and artifacts even if auxiliary SDK behavior changes.

`src/budget.ts` holds one monotonic clock. Wall-clock timestamps are for evidence only. A clock has `monotonicMs()`, `wallTime()`, and `sleep(ms, signal)`. Tests supply a manual clock.

```ts
type Stage = "prepare-init" | "discovery" | "verification" | "cleanup" | "publish";
type ExecutionBudget = {
	startedAt: string;
	deadlineEpochMs: number;
	remainingMs(): number;
	stageDeadline(stage: Stage): number;
	canStartRequest(stage: Stage, minimumMs: number): boolean;
	assertRemaining(stage: Stage): void;
};
function createBudget(clock: Clock, timeoutMs: number): ExecutionBudget;
```

At review entry set `T0`, absolute end `T0 + 300000`, and analysis stop `T0 + 290000`. Preparation and initialization together end no later than `T0 + 60000`. PR API capture, comment backup, object fetch, frozen configuration, export, prompts, and SDK and model initialization all consume that first cap. Discovery ends at `min(discoveryStart + 120000, T0 + 290000)`. Verification ends at `T0 + 290000`. Cleanup, final validation, summaries, and handoff finish by `T0 + 300000`. Early preparation leaves more verification time, not more discovery time.

The parent starts a stage timer when the worker reports initialization complete and phase start. The worker receives the same absolute limits so its request admission agrees. The parent interrupts the active session at the stage deadline. Discovery timeout prevents verification. A verification timeout preserves validated discovery and any already completed verification checkpoint. The final ten seconds include SDK close, forced process-group cleanup if needed, result assembly, and atomic handoff. Reserve the final two seconds of that window for parent file writes. Kill an unsettled worker at `T0 + 298000`. The maximum review wall duration remains 300 seconds even when cleanup hangs. The parent records forced cleanup and unknown usage.

Every new HTTP request, prompt submission, Git process, or backoff checks remaining stage and total time. Start no model request with less than 2,000 ms of analysis time. A scheduled retry must leave that minimum after its delay. If it cannot fit, stop with the stage timeout code. This minimum is an admission rule, not a promise that the model finishes in two seconds.

GitHub reads retry transient transport errors, 429, and 500, 502, 503, 504 at most twice, with delays of 1,000 and 2,000 ms. A `Retry-After` delay is a lower bound. Secondary rate-limit 403 retries only when the response has explicit rate-limit evidence. Authentication, ordinary permission 403, 404, schema mismatch, malformed JSON, TLS validation failure, and invalid URL fail outright. If a required delay cannot fit, return `github-rate-limit` or the stage timeout. Per-request timeouts are `min(10000, remaining stage time)`.

Side-effecting GitHub calls do not use that generic retry helper. `writeComment` returns confirmed or unknown. The reconciliation algorithm owns its bounded re-read and possible repeat. HTTP 401, permission 403, validation 422, and an identity mismatch fail directly. A transport failure before send may be retried after the standard read, so all writes follow one recovery path.

OpenCode's installed 2.2.7 source has a retry policy with up to ten recurrences and jitter. The session runner lets a plugin replace the decision through `ctx.session.hook("retry", ...)`, as declared in `node_modules/@opencode/plugin/dist/promise/session.d.ts:132`. The hook's `SessionRetry` carries the session ID, agent, model, error, attempt, and a `decision` of `{retry: false}` or `{retry: true, delay}`. Hook existence alone does not prove that every auxiliary request passes through it. The implementation must install `createRequestPolicyPlugin` alongside the existing context-limits plugin. It registers `http.request`, `http.response`, and `retry` hooks for this product's sessions.

The retry hook keeps a counter per active model request, with a hard maximum of two retries. Only 429, explicit rate-limit errors, 500, 502, 503, 504, 529, and SDK-classified transient network errors are eligible. It replaces SDK jitter with deterministic delays of 1,000 and 2,000 ms, bounded below by `retryAfterMs`. Credential, model configuration, refusal, content filtering, output format, citation, and candidate-set errors never retry. After a successful response begins the next model request, the counter resets for that request. Counters for the whole run also record actual outbound attempts. The hook records decisions synchronously before allowing them, so concurrent callbacks cannot overspend a retry count.

`http.request` checks the active phase deadline and logs one request sequence number, phase, session ID, SDK request kind, attempt ordinal, and start time. `http.response` records HTTP status, end time, and selected numeric retry metadata. It never records request headers, bodies, full URLs, or response bodies. Auxiliary requests such as title or compaction share the phase budget and request ledger. The product either suppresses optional title generation through the versioned plugin API or records it. It never excludes such requests from accounting. Model usage still comes from cumulative session fields once, rather than summing both request and session totals.

Coverage of the retry hook over every request kind is a blocking checkpoint condition, not an assumption. Checkpoint 3 must drive the actual installed SDK against a scripted OpenAI-compatible endpoint and prove that primary, compaction, title, and generate requests all pass through the hooks, that a third retry never reaches the provider, and that an ambiguous prompt response uses only one user message. If a hidden retry path bypasses the hook, implementation stops at that checkpoint and constrains the provider transport at its supported public hook. Compliance is never claimed from a mock alone.

The runtime prompt submission state is a discriminated union.

```ts
type Submission =
	| { kind: "not-submitted" }
	| { kind: "submitting"; sessionId: string; baselineUserIds: string[]; promptDigest: Sha256; submittedAt: string }
	| { kind: "accepted"; sessionId: string; userMessageId: string; promptDigest: Sha256 }
	| { kind: "acceptance-unknown"; sessionId: string; promptDigest: Sha256 };
```

Before submission, read that session's complete message list and save existing user IDs. Submit exactly once. If `sessions.prompt` returns an accepted ID, use the existing `completedTurn` reader. If it times out or loses its response, immediately read the same session, with bounded read retries, and find the unique new user message whose exact prompt text hashes to `promptDigest`. The raw prompt text stays in replay only. If found, transition to accepted with that ID and continue waiting for its terminal idle. If no such message appears, keep reading the same session until the phase deadline. Never infer non-acceptance from one empty read and never submit a second prompt after uncertain acceptance. Multiple matching new user messages violate the single-submitter invariant and fail `acceptance-unknown`.

An explicit local SDK rejection before enqueue may retry the submit call only if the adapter proves `not-sent`. Unknown delivery never qualifies. Provider retries happen inside the accepted session under the plugin, not by resending the user prompt. The outer review layer never retries an accepted review. A human rerun creates a new workflow attempt, a new worker, and a new budget with separately recorded usage.

The progress schema records `{ runId, sequence, at, phase, event, changedFilesIncluded, changedFilesTotal, candidatesDiscovered, candidatesVerified, remainingMs, runUrl }`. Counts are integers or null while unknown. Emit phase start and end and a heartbeat at most every five seconds. Render these into sanitized stage log lines and rewrite one bounded job-summary section at phase boundaries. Never update the PR comment for progress. Round count, tool and read caps, token reports, retries, and request attempts are observables. They are not a precise dollar cap.

### Error taxonomy and terminal-state reducer

The failure enum above is closed. The following table specifies its producers and effects. Every error carries a stage and a sanitized message. Stack traces remain in trusted diagnostic logs with credential redaction and byte caps.

| Codes | Producer | Terminal behavior |
| --- | --- | --- |
| `input-invalid`, `writer-context-required` | CLI and Actions environment parser. | Exit 1. No comment write. No fabricated review result. |
| `github-auth`, `github-forbidden`, `github-not-found`, `github-rate-limit`, `github-unavailable` | GitHub adapter after permitted read retries. | Review failure envelope if identity is known. Publish fails without mutation unless a previously confirmed write already occurred. |
| `snapshot-fetch`, `config-invalid`, `isolation-rejected`, `prepare-timeout`, `runtime-init` | PR adapter, exporter, isolation preflight, and initialization timer. | Failed review, no issues. Upload bounded failure evidence if possible. |
| `model-auth`, `model-config`, `model-refusal` | Runtime terminal error classifier and final-text checks. | Failed review. No retry and no usable current report, even if discovery previously completed. Preserve previous comment report. |
| `model-format`, `citation-invalid`, `candidate-set-invalid` | Parent or worker phase validation. | Failed review. Reject all current issues. Never salvage a malformed JSON fragment or a subset of a malformed candidate set. |
| `retry-exhausted`, `acceptance-unknown`, `discovery-timeout`, `verification-timeout`, `run-interrupted`, `read-budget`, `request-budget`, `cleanup-failed` | Request policy, session state machine, stage timers, worker signal, tool plugin, or host close. | Partial if a valid discovery checkpoint exists. Include only fully validated keep verifications. Otherwise failed. Timeout, interruption, acceptance uncertainty, retry exhaustion, and cleanup failure exit 1 even when partial. A read or request cap alone exits 0 when it yields a usable partial report. |
| `artifact-write` | Atomic handoff writer or size admission. | Failed envelope if that smaller write succeeds. Otherwise job failure with no handoff. The publisher uses the missing-package path. |
| `artifact-missing` | Publisher sees no current-run exact-name artifact or no files after confirmed absence. | Preserve lastReport and write a failure note. Publish exits 1. |
| `artifact-invalid`, `identity-mismatch`, `attempt-mismatch`, `artifact-provenance` | Artifact admission and cross-field validation. | Reject before all comment writes. Exit 1 and record the rejection in Actions. |
| `writer-attempt-inactive` | Run API comparison before admission and each write. | Reject and exit 1. Old attempts cannot replace a newer attempt. |
| `comment-state-invalid`, `comment-list-limit` | Owned comment parser or incomplete pagination. | No comment write or create. Exit 1 with canonical ID if known. |
| `comment-write`, `comment-write-unknown` | Write adapter and exhausted reconciliation. | Exit 1. Keep artifacts and the exact intended body digest. A PR note is not guaranteed. |
| `postcheck-unavailable` | Post-write PR read exhausted its retries. | Mark unconfirmed if possible. Exit 1 and retain confirmed comment ID and evidence. |

`complete` requires a fully validated discovery output and verification output, no omitted work, no unverified or unpublished candidates, no pending tool pages, no relevant stage error, and successful cleanup. `partial` requires a validated discovery checkpoint and a recoverable incomplete-work condition, or material-only exclusion before model work. Its issue list contains only pairs with an accepted keep verification. `failed` means no usable report or an outright failure class. `skipped` means analysis never started because of PR eligibility or no changes.

A valid discovery checkpoint with eight candidates and an interrupted verification session produces partial with zero current findings and eight unverified IDs. A valid verification checkpoint followed by cleanup failure produces partial with retained kept issues and unknown usage if settlement failed. An invalid verification JSON produces failed even when discovery succeeded. A no-change PR produces skipped without opening a model session. An all-omitted change produces partial without a model session, as Segment 1 already does. The latter is a special usable coverage report with no discovery checkpoint.

## 4. Invariants and enforcement

| Invariant | Enforcement |
| --- | --- |
| The requested PR is the event or dispatch PR. | CLI and environment boundary equality check and CLI journey test. |
| Base and head come from the API at actual start. | `capturePullRequest`. The event schema discards commit fields. A fake event with wrong SHAs is a test. |
| Repository numeric ID, PR number, run ID, and attempt cannot be interchanged. | Branded schema-derived types and object arguments. |
| Review snapshot is fixed and its merge base is real. | Bare fetch object verification, `prepareContext`, and publish recomputation. |
| PR edits cannot replace product code, prompts, dependency lockfile, or review rules. | Fixed Action A, no PR checkout execution, frozen base config reader, and sentinel integration fixtures. |
| The model never receives a GitHub token or ambient project configuration. | Existing worker allowlist and clean-material checks, plus child environment capture tests. |
| Only validated keep pairs enter issues. | Existing paired issue schema, checkpoint reducer, citation validator, and failed-format tests. |
| Every partial report names unfinished work. | Bounded coverage aggregation with explicit counts and the `complete` refinement. |
| The total review stays inside 300 seconds. | Shared monotonic budget, parent timers, subprocess deadlines, and fake-clock boundary tests. |
| Preparation and initialization share 60 seconds, discovery has at most 120 seconds, cleanup keeps ten seconds. | Budget stage constructor and phase timer tests. |
| An uncertain prompt acceptance never creates a second prompt. | Submission union and same-session recovery tests. |
| Every eligible request has at most two retries. | Product session retry hook, GitHub read helper, ledger assertions, and scripted 429 tests. |
| Every request kind passes the retry hooks. | Scripted-provider integration test at checkpoint 3. This gate blocks progression until it passes. |
| Result and manifest refer to one execution and exact bytes. | Atomic directory commit, strict schemas, result digest, cross-field equality checks. |
| Artifact digest alone grants no publication authority. | Expected Actions context, run-scoped artifact receipt, fixed product hashes, and no-PR-code execution. |
| A wrong package cannot alter the existing report or failure banner. | Admission precedes decision and all write paths. Zero-write rejection assertions. |
| Exactly one workflow owns comment writes within supported deployment. | One reusable-workflow concurrency group, no caller group, Actions-only publish parser, and active attempt check. |
| A human comment can never become an update target. | Bot identity plus exact marker discovery. Artifact comment IDs never select write targets. |
| A listing failure cannot become proof of absence. | Complete bounded pagination required before create. Pagination fault tests. |
| An ambiguous create never produces a second POST in the same invocation. | Reconciliation step 6 and the post-commit response-loss fault test. |
| Duplicates stop new creates. | Lowest-ID canonical selection after a full scan. Duplicate tests across pages. |
| A stale H1 result cannot replace the current valid report before write. | PR tuple comparison immediately before each write. |
| A race after validation produces commit-bound output and a stale annotation. | Fixed links in body, post-write PR check, annotation PATCH, and paused-write test. |
| A failed or skipped run never clears lastReport. | The state reducer only assigns `lastReport` in reviewed branches. Transition matrix tests. |
| An older run or attempt never replaces a newer publication. | Ordered run comparison and the duplicate execution and digest check. |
| Comment text and state remain bounded and deterministic. | Explicit byte caps, structural bounded-location variant, canonical serializer, and maximum-size golden tests. |
| No secret enters logs, prompts, worker IPC, or artifacts. | Field selection, environment separation, redaction, allowlisted export, and a sentinel secret scan. |
| Failure notes do not make a failed review job green. | No review `continue-on-error`. Workflow structure assertion and live normal-failure acceptance. |
| Production commands cannot inject faults or arbitrary state. | Test-only dependency injection, no public test adapter flags, and parser rejection tests. |

The implementation keeps each invariant at one authoritative owner. Tests exercise it from the caller's observable behavior. Types express legal states. Boundary checks validate facts the compiler cannot know.

## 5. Idempotency and crash analysis

| Side effect or boundary | Double run | Crash before | Crash after |
| --- | --- | --- | --- |
| Create target bare repository. | Each review attempt has a distinct temporary directory. | No published state. | The next execution removes only its own recognizable temporary directories. It does not reuse unverified fetch state. |
| Fetch fixed objects. | Same IDs produce the same objects. | No review snapshot exists. | Verify object IDs and compute the merge base before export. No target scripts run. |
| Export material staging directory. | The local command still refuses an existing output. A PR rerun has a new attempt path. | The staging directory has no handoff and cannot publish. | Atomic rename exposes one complete context. The parent can create a failure handoff from it. |
| Save worker progress. | A later sequence replaces a previous whole checkpoint. | The reader sees the old valid checkpoint. | The reader sees the new complete checkpoint. A temporary file alone is ignored. |
| Submit model prompt. | The live worker tracks `Submission` and submits once. A fresh workflow attempt is a new paid review. | If known not submitted, submit once within budget. | If the response is lost, recover that same session's durable user and idle messages. Never resend after unknown acceptance. |
| Internal provider retry. | A counter keyed to the active request permits two retries. | No extra retry is recorded. | The ledger records the allowed attempt before transport begins. A restarted process never resumes the old session by submitting a new prompt. |
| Write replay files. | Per-run files use temporary-file rename for final versions. | Available earlier files remain evidence. | No replay file grants publish permission. Export only allowlisted complete files. |
| Commit handoff directory. | The same attempt cannot replace a committed handoff with different bytes. Identical bytes are a no-op. | Partial staging is not uploadable. | The two-file package is complete. A later failed job still uploads it. |
| Upload handoff and replay artifacts. | Names include run and attempt. A re-upload conflict fails and does not overwrite. | The publisher sees genuine absence and can note failure. | The publisher queries the current-run receipt and admits exact bytes. A lost uploader response does not require a second artifact create. |
| Create summary comment. | A full marker scan finds the canonical comment and PATCHes it, or returns already-published. | No comment exists. | A lost response triggers full marker reconciliation. The invocation never POSTs a second time. A committed visible create is recovered with the original ID, or the run ends with `comment-write-unknown` and the next run updates the original. |
| Update summary comment. | The same canonical body is a no-op after a re-read. | The existing report stays intact. | A lost response is recovered by body or publication digest. A newer state is never overwritten. |
| Post-write stale annotation. | The same stale state renders the same body. | The report still names H1, even if the stale warning is absent. | A re-read confirms the annotation. A next run re-evaluates current PR state either way. |
| Remove worker HOME and temporary Git. | Forced removal is safe for the current owned directory. | Parent process-group kill precedes cleanup. | No persistent credentials remain. A runner crash can leave ephemeral runner files, but artifacts exclude them. |

There is no persistent lock file and no multi-file mutable comment state. The workflow provides serialization, and each comment PATCH replaces visible text and encoded state together. The publisher writes `publish-result.json` locally after every terminal path, with the precheck tuple, intended body digest, observed comment ID, postcheck tuple, and any failure. An ambiguous create additionally records the intended body digest, the re-list attempt count, and whether the comment was found. That evidence directory contains no model secret and at most 1 MiB of sanitized JSON and intended body text. Its artifact upload uses `always() && !cancelled()` after the publish Action.

## 6. Security and trust boundaries

The PR source is hostile data even though fork PRs are unsupported. A collaborator can add a malicious shell script, model instruction, `AGENTS.md`, plugin, symlink, secret-like file, or workflow. The integration does not execute those files. It fetches objects, parses bounded JSON from the base configuration, exports allowed regular text, and runs a fixed product program. Existing read-only permissions, context hooks, ancestor instruction checks, clean HOME, and no project config remain required together.

The review token can read repository contents, PR metadata and comments, and current-run metadata. It cannot write PR comments. The publish token adds PR write permission, reads contents for independent citations, and reads Actions artifacts. It never reaches the model process. The model key exists only in the composite's command step and the model worker's `OPENAI_API_KEY`. The publish job receives no model secret input or environment value. The key is a named composite input because passing it as the whole Action step environment would also expose it to setup-bun and dependency installation. The root Action binds that input to `REVIEW_MODEL_API_KEY` only in `steps.command.env`. Composite inputs do not automatically create `INPUT_*` environment variables. The fixed setup and install steps do not read the input.

Install steps use fixed product dependencies and `--ignore-scripts`. `action-entry.ts` starts only the command child with the model key, masks it before any diagnostic, and removes it from all Git and artifact subprocess environments. The model provider ID, endpoint, and model ID can remain step environment because they are non-secret. The model secret never enters an interpolated shell command, output file, install environment, or target material. The masking call uses correct Actions command escaping, and normal logs never include the key value. Acceptance inspects the actual environment route.

The handoff is untrusted input at the write boundary. The publisher verifies origin context, identity, exact attempt, product version, digest, schemas, citation source, and size. It never uses an artifact's shell command, file path outside the package, API URL, comment ID, or claimed bot identity. The old comment is also external data. Its author and marker establish ownership, while its encoded block must still parse and satisfy invariants.

Permissions cannot increase through a reusable-workflow call. The caller must grant the maximum permissions the two jobs need, and each called job narrows its token. A caller with a read-only token gets a clear publish permission failure. The product does not fall back to a personal access token, `pull_request_target`, or another privilege route.

Comment escaping applies equally to finding text, errors, paths, coverage notes, and PR metadata. The product constructs all code and run links from validated GitHub identity and fixed SHAs. A model-provided URL remains literal text or is omitted. Base64url state cannot terminate an HTML comment. The visible renderer encodes marker-like strings, so a finding cannot inject a second machine-state block.

## 7. Verification and fault injection by acceptance row

Deterministic tests inject `GitHubReader`, `GitHubPublisher`, `Clock`, and the runtime host at constructor boundaries. Test code may run loopback HTTP servers and real disposable Git repositories. The production CLI accepts no fake endpoint, arbitrary comment state, forced status, delay, or fault flag. GitHub adapter tests use injected fetch directly. CLI journeys invoke an in-process command dispatcher with real argument parsing and injected adapters, while existing subprocess local journeys keep proving the installed public command.

| Segment 2 acceptance row | Deterministic proof | Fault injection | Live evidence |
| --- | --- | --- | --- |
| Defect PR, normal PR, and manual rerun use the same program and current SHA. | Run local `runReview` and `runPrReview` over the same fixed Java objects with one deterministic runtime result. Compare snapshot, candidates, verification, and final issues. Assert one public dispatcher, identical model path, fixed API head despite a wrong event merge SHA, frozen base config, and skipped draft, closed, and fork variants. | Change the API head between a queued event and start. Edit `review.config.json`, product-like scripts, and `AGENTS.md` only in the PR head. The captured head updates, base rules stay fixed, and sentinels never execute. Put more than 100 human comments before the bot comment. | Open real defect and guarded PRs in the self-built Java repository. Run each automatically and rerun manually. Save current API SHAs, run IDs and attempts, artifact names and digests, and canonical comment IDs. A rerun must keep the ID. |
| Refusal, invalid key, and interruption with and without usable stages remain distinct from complete zero findings. | Golden snapshots cover complete zero, complete findings, partial zero with unverified work, partial findings, failed with retained report, and skipped. Test the reducer for every failure class and valid checkpoint. Assert usage becomes unknown after an unsettled kill. | The runtime returns refusal, authentication 401, malformed JSON, a missing candidate ID, a wrong excerpt, interruption before the discovery checkpoint, interruption after discovery, and a cleanup crash after validated verification. Assert model format errors never retry or publish current issues. Script 429 twice then success, and 429 three times, with exact request counts and delay consumption. | Save the three comment kinds, the previous report section, the Actions summary, request ledger, stage outputs, exit codes, and the failed job conclusion for a handled failure. |
| Review fails before upload. The comment API fails. | Simulate Action setup or process failure before the handoff exists. The publish dispatcher receives `needs.review.result=failure`, confirms no artifact, preserves lastReport, and emits a failure note with a null analyzed snapshot. Assert CLI exit 1. A failed comment call leaves `publish-result.json` and the review artifact unchanged. | Throw before output paths, before directory rename, and during upload. Return permission 403, transient 503, and network uncertainty from the comment API independently. Verify a download failure is not automatically treated as artifact absence without metadata. | Use an acceptance-only caller branch that fails the review step before the product starts. In a second run, remove write permission to fail publish. Keep the needs result, workflow conclusion, artifact links, and evidence uploader logs. Do not add production fault flags. |
| Push H2 during H1 analysis and after publish validation. | Two scripted captures return H1 then H2 before the write. Assert zero comment mutation and stale-before-write evidence. A separate case returns H1 at the precheck, commits the write, then H2 at the postcheck. Assert two PATCH bodies or create plus PATCH, and a stale annotation bound to H1. | A test adapter barrier pauses between the final precheck and the write, then advances the PR tuple. Also test base-only changes, close, draft conversion, fork identity mismatch, postcheck failure, and a later H2 publication that an old H1 rerun cannot replace. | Record the two real timelines and SHAs. Use a test-controlled API adapter for deterministic race proof and one real continuous-push exercise for workflow behavior. The next or manual run replaces the stale report in the same comment. |
| Create succeeds, the response is lost, publish reruns. | The fake API persists the POST, then throws before returning. A complete paginated read returns that comment. Assert one POST, the original ID, matching final state, and no growth in owned comment count. Repeat publish with the same run and digest and assert no mutation. | Lose the POST response, lose the PATCH response, delay list visibility for one read, fail a reconciliation read, and create historical duplicates across pages. Assert that a read failure prevents another POST and that the invocation never POSTs twice. Canonical is the lowest ID. A human copy of the marker remains untouched. | Save the fault record, the full PR comment list, IDs, intended and observed digests, and duplicate warning behavior. The adapter fault lives under tests only. |
| Wrong PR, wrong attempt, corrupt package reject. | Table-driven mutations cover repository ID and name mismatch, PR mismatch, event and manual PR mismatch, old attempt, local execution, current run mismatch, artifact receipt mismatch, mismatched SHAs, bad digest, bad byte count, unknown schema version, wrong product hash, an extra file, a symlink, line overflow, a bad excerpt, an unpaired keep, and a same-run conflicting digest. Every case asserts zero writes and a byte-identical existing comment. | Oversized JSON, nested or extra extracted paths, repeated pagination links, an artifact metadata outage, invalid canonical encoded state, and a wrong bot author. Review the pinned download Action's extraction behavior as a dependency security check. | Save rejection logs, package hashes, exit codes, and before and after current comment bodies. No live corrupt package is required to mutate a real PR. |

Additional contract tests parse both generated workflows and the root Action with an established YAML parser in dev tooling. They assert the trigger list, input types, literal pinned references, one concurrency owner, the default single pending slot, no `cancel-in-progress: true`, the explicit secret route, review read permissions, publish write permissions, `needs`, `always() && !cancelled()`, and upload paths. Shell tests use spaces and shell metacharacters in safe local paths and verify that argument arrays preserve them.

The request-policy tests run the actual installed OpenCode plugin lifecycle with a scripted OpenAI-compatible endpoint. They prove that the session retry hook overrides the installed default, that a third retry never reaches the provider, that every request kind including auxiliary title and compaction requests passes through the hooks, and that an ambiguous prompt response uses only one user message. They record all outbound attempts. This test is the blocking gate for checkpoint 3. Live acceptance does not proceed until it passes.

The fake clock advances to 59,999, 60,000, discovery start plus 119,999 and 120,000, 289,999, 290,000, 298,000, and 300,000 ms. At each boundary, tests assert whether a new request is permitted, which signal fires, what checkpoint survives, and which artifacts remain. A real-process test hangs the worker and one descendant, confirms process-group termination, and scans replay exports for the model-key and Git-token sentinel values. It reuses the existing worker-process test mechanisms.

Commands for each checkpoint are recorded under the checkpoint sequence. The full end-to-end commands are `bun run typecheck`, `bun run test`, `bun run verify`, `bun run verify --area github`, `bun run smoke:sdk`, `bun run smoke:model`, and `bun run smoke:review`. The last two require a configured live endpoint and incur model calls. The GitHub live acceptance is a separate `bun run verify --live-github` mode with explicit repository and PR parameters validated by the verification CLI. It cannot publish arbitrary artifact state. It only invokes the same trusted workflow and reads its results.

## 8. Rationale

### How this document was produced

Three independent candidate designs were produced from one brief under the same constraints. A cross-judge review scored them against six criteria: foundations, boundaries and trust, failure and idempotency, implementability, reuse of Segment 1, and acceptance traceability. The candidate built on the GPT seat scored highest and became the base. Two mechanisms were grafted from the other candidates because they were better than the base's own, and three internal conflicts the judge found in the base were resolved here.

The judge shared a vendor with one candidate, so its scores carry that bias. The grafts and fixes below were each decided on stated grounds rather than on the scores alone.

### Grafts

The comment module is pure. The base placed the marker, state schema, renderer, and escaper inside `src/publish.ts`. The design splits them into `src/comment.ts`, which performs no I/O and imports no GitHub types, and leaves `src/publish.ts` with the decision and the write orchestration. A pure comment module can be exhaustively property-tested without an adapter, and Segment 3 extends the state schema without touching write logic.

An ambiguous create never repeats the POST in the same invocation. The base allowed one more POST after two clean absence reads. The design adopts the stricter rule: after a create with an unknown outcome, the invocation only re-lists, up to three reads with backoff, and ends with `comment-write-unknown` when the comment does not appear. The cost is that a POST which never left the client wastes one publish, recovered by the next run. The gain is that the product has no code path that can create a second comment after an uncertain response, which makes the required fault-injection row deterministic.

Issues in the comment carry one-line citation references, never excerpt blocks. A citation line is built from bounded location fields, such as `src/OrderService.java:42-45 (head)`. Full evidence stays in the replay artifact and the run link. This keeps the body well under the comment limit, removes the excerpt-removal rung from the shrink ladder, and makes a fence war with model text impossible because no evidence excerpt is ever rendered into the comment.

### Conflicts resolved

The output layout conflict. The base's call site passed `<out>` to `runReview` while its own layout section required `runReview` to write into `<out>/replay`. The design fixes the rule: `runPrReview` owns `<out>`, and `runReview` always receives `join(command.out, "replay")`. The Segment 1 rule that the output directory must be new applies to that subdirectory, and each workflow attempt receives a fresh runner temporary parent, so the subdirectory is always new.

The model record admission conflict. The base required a non-null model record for a reviewed outcome while also allowing runs that never call the model. The design resolves it by definition: the model record captures configured identity, resolved once at initialization from non-secret environment, not usage. An Actions manifest always carries it, because the workflow declares the model inputs as required, whatever the outcome and whatever the request count. Admission checks presence for Actions manifests without ambiguity.

The retry coverage assumption. The base treated universal hook coverage as an open question. The design promotes it to a blocking checkpoint gate. Checkpoint 3 must prove through a scripted provider that primary, compaction, title, and generate requests all pass through the session hooks before any later checkpoint relies on the policy. The hook's existence in the SDK declarations proves nothing about coverage.

### Tradeoffs accepted

We accept one workflow running at a time per PR in exchange for a real single-writer boundary without a backend lock service. The default pending slot can discard intermediate pushes. Every surviving start re-captures the current PR, so the product reviews the latest start snapshot rather than promising a report for every push.

We accept a separate 120-second publish budget in exchange for keeping the 300-second model budget and its cleanup invariant understandable. Queue time, setup, transfer, and publication remain visible in Actions timing. A complete feedback latency claim must include them.

We accept compact comment state in exchange for fitting the GitHub comment limit after repeated failures. Full findings, exact citations, model records, and traces stay in immutable per-run artifacts. The comment labels every summarized issue and links to its full record.

We accept a strict Actions-bot identity in exchange for preventing marker copies in human comments from becoming write targets. GitHub App identities and Enterprise hosts require an explicit later boundary, not implicit author matching.

We accept rejecting an invalid canonical state in exchange for preserving the previous report rather than guessing how to repair corrupted history. A manual remove-and-rerun path is documented and the damaged body is saved first.

We accept a small amount of specialized artifact code in exchange for admitting only one exact two-file package at the privileged boundary. A generic directory loader would expose filesystem and schema decisions to every caller.

Foundational thinking separated fixed Git snapshot, PR identity, execution identity, analysis outcome, and publication freshness into distinct data structures. Boundary discipline placed GitHub JSON, artifact, CLI input, and comment state parsers at their owning adapters. Type system discipline replaced optional result bags with discriminated unions and branded IDs. Making operations idempotent turned publication into a reconciliation over observed state and made handoff publication an atomic directory rename.

### Alternative shapes considered

A single privileged job could capture the PR, run the model, and directly update the comment through a `ReviewService` object. It would hide handoff serialization and reduce job wiring. It loses because the write token and model key coexist with untrusted PR material, the same process owns model behavior and publication authority, and a hard process failure has no independent publisher to produce the required missing-artifact note. Its interface looks smaller only because it exposes a larger failure and privilege domain to the caller.

A second viable shape uses artifacts as the entire report history and reconstructs `lastReport` by listing past successful workflow artifacts on every failure. It hides encoded comment state but exposes retention, run filtering, and historical artifact availability to failure handling. The comment register wins because a current comment retains its last usable report even after artifacts expire.

A third shape stored comment state in a fenced code block as plain JSON rather than a base64url HTML comment. It is easier to read in the rendered comment. It loses because the visible renderer must then defend a larger grammar, and any future rendering change risks a parse break in the wild. The base64url block is opaque to readers and to Markdown, and the parser accepts only the renderer's canonical form.

### Open questions and risks

Does the self-built Java repository already contain the default `review.config.json`, or will acceptance exercise the product-default fallback first? The design supports both deterministically, so the answer does not block implementation.

Will a seven-day artifact retention window suffice for the independent onboarding trial? Segment 2 uses seven days. A release can increase the constant and document storage cost without changing state schemas.

Can GitHub expose a committed comment later than all reconciliation reads in the deployment environment? The protocol cannot prove global absence after an unknown mutation. The selected policy bounds reads and stops all creation when any marker appears. It does not promise distributed exactly-once behavior.

Does the installed SDK emit every provider retry through the session retry hook, including auxiliary requests? The scripted-provider integration test answers this at checkpoint 3 before live acceptance. If a hidden retry bypasses the hook, implementation stops there and constrains the provider transport at its supported public hook.

## 9. Implementation checkpoint sequence

The integration branch starts from `main` under the repository's contribution rules. No Segment 2 implementation belongs in this design task. Each checkpoint below ends with executable evidence and a focused commit. Only the completed segment gets its one end-to-end PR.

1. Define `identity.ts`, `pr-contracts.ts`, the closed failure enum, domain execution identity, the handoff schemas, and the checkpoint reducer. Export the existing review component schemas needed for composition. Build bounded maximum-size fixtures and exact-byte round trips. Run `bun run typecheck`, the contracts tests, and reducer tests. The checkpoint is verifiable when impossible status combinations and wrong run identity reject before orchestration exists.
2. Add the GitHub reader, raw API boundary parsers, canonical event parsing, pagination, fixed bare fetch, frozen base config, and PR adapter. Use real temporary Git repositories with injected HTTP metadata. Run snapshot tests, new GitHub adapter tests, and `bun run verify --area snapshot`. The checkpoint is verifiable when the same deterministic runtime yields the same local and PR review and a head config edit cannot change limits.
3. Add the shared budget, phase caps, request ledger, retry plugin, and same-session acceptance recovery. Update worker IPC and the parent checkpoint reader together. Run runtime tests, real hung-process tests, `bun run smoke:sdk`, and the scripted-provider policy integration. The checkpoint is verifiable when actual SDK requests of every kind stop after two retries through the hooks and no timeout resends an accepted prompt. This gate blocks the sequence until it passes.
4. Implement `writePrHandoff`, the allowlisted replay export, the atomic commit, and `admitHandoff` with fixed-object citation validation. Add the PR CLI form and preserve the existing local form. Run CLI and snapshot journeys, handoff mutation tests, `bun run typecheck`, and `bun run verify`. The checkpoint is verifiable when a failed PR command still leaves a bounded usable handoff or a demonstrable absence, and corrupt packages cause zero publish writes.
5. Implement the pure `comment.ts`, deterministic rendering, ordered publication decisions, stale checks, paginated canonical selection, and uncertain-write reconciliation with the strict no-repeat create rule. Add the publish CLI and sanitized `publish-result.json`. Run all state transition, golden, maximum-size, pagination, lost-response, wrong-attempt, and race tests. The checkpoint is verifiable when a post-commit lost POST response retains the original ID and an H2 race yields a stale H1 annotation.
6. Commit runnable root Action A with the final secret-input route, fixed Bun setup, frozen install, absolute product execution, and both CLI modes. Review the pinned third-party sources and run Action contract tests plus a local composite-equivalent execution on clean Linux. Record A's full SHA. This checkpoint is verifiable before any reusable workflow references A.
7. Generate and commit reusable workflow B referencing A literally in both jobs. Include the publish evidence uploader, the exact current-run download, failure-safe upload, `needs`, permissions, the explicit model secret input, and the sole workflow concurrency group. Generate the caller YAML from B's SHA in the next documentation commit and pin the external Java caller to B. Run YAML contract tests and clean Linux verification. The checkpoint is verifiable when a deliberate early review failure still starts publish and produces its bounded failure note while Actions stays failed.
8. Run the six live acceptance rows against the self-built Java repository. Capture real defect and guarded reports, the manual rerun, key, refusal, and interruption behavior, the missing artifact, the comment permission failure, the continuous push race, and current SHA checks. Keep deterministic fault injection for uncertain-write and corrupt-package behavior. Run `bun run smoke:model`, `bun run smoke:review`, `bun run verify --area github`, and `bun run verify`. The checkpoint is verifiable when each acceptance row has run IDs, fixed SHAs, comment IDs, artifacts, and a pass or fail record.
9. Update `ENVIRONMENT.md`, `PLAN.md`, the root README, the caller example, and the project verification skill with the implemented commands, the manual base-change rerun, failure recovery, state limits, and scope. Review the diff, ensure no run artifact or credential is staged, and open the single Segment 2 PR from the integration branch. Report the checks actually run and any unavailable live checks. Do not mark acceptance complete from fixture tests alone.

The first implementation step is the typed identity layer, the checkpoint reducer, and the two-file handoff contract. Every later module benefits from an explicit answer to what this run knows and what the privileged publisher may trust.

## Documentation evidence

The design used repository source at the commit named in the opening, the full Segment 2 plan text, and the requested architectural principle skills. Current GitHub Actions documentation was consulted for reusable-workflow secret and permission handoff and for concurrency. The concurrency documentation confirms the default one-running and one-pending behavior and the replacement of an existing pending run. This design does not opt into the newer queue behavior.

The installed SDK 2.2.7 declaration and runtime files were read to confirm the retry hook rather than invent an SDK configuration option. No SDK migration or package change is part of this segment. Third-party Action commit refs were resolved with read-only `git ls-remote` calls. Source review and actual workflow validation remain implementation checkpoint requirements.
