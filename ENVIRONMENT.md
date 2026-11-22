# Development Environment

## Prerequisites

- macOS is the local development platform. The reusable workflow runs on `ubuntu-24.04`.
- Bun `1.4.4` runs TypeScript files directly and installs dependencies from `bun.lock`.
- `@opencode/sdk` and `@opencode/plugin` are pinned to `2.2.7` in `package.json`.
- `javac` and `java` must be available for the Java toolchain check.

The project uses the pinned OpenCode SDK and its embedded host API. A separately installed OpenCode CLI is not required.

The review runtime disables model HTTP redirects, optional title generation,
and background compaction. Primary review calls and foreground compaction
can send up to three requests per call. Only transient failures can retry.
Retries wait 1,000 ms and 2,000 ms respectively, or longer if `Retry-After`
requires it. Each send needs at least 2,000 ms left in the phase.

The runtime blocks standalone `sessions.generate` before it contacts the
provider. Review does not use it, and OpenCode 2.2.7 does not expose a retry
hook for that call. If the prompt response is lost, the worker checks the
original session for the prompt and never resubmits it.

## Install and Check

From the repository root:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run smoke:sdk
bun run smoke:java
```

`typecheck` runs `tsc --noEmit`. The SDK check starts and closes an embedded host without requesting a model. The Java check compiles and runs a temporary class. Both smoke checks use temporary directories.

## Verification CLI

This section documents the implemented commands. The
[verification tooling design](docs/verification-tooling-design.md) proposes
inspection, selection, replay, and workflow collection. Those proposed commands
are not available yet.

```sh
bun run verify doctor
bun run verify
bun run verify --area snapshot
bun run verify --area github
```

`doctor` checks the checkout, locked dependency versions, and local toolchain without starting the SDK. `verify` runs type checking, tests, and the SDK and Java checks, then drives the public `review` command on disposable Git repositories. Use `--area cli`, `--area snapshot`, `--area runtime`, `--area github`, or `--area java` to run one group. The GitHub area checks the Action contract and exercises the handoff, admission, and publication journeys through injected adapters. Its composite-equivalent runner uses an offline frozen install and the loopback scripted model endpoint. These checks do not contact a live GitHub or model service.

The command prints an evidence directory containing `summary.json`, command logs, and any generated review reports. Temporary fixture repositories are removed; the evidence remains. A verification command exits `1` if a check fails. See the [project verification skill](.claude/skills/verify-ai-code-review/SKILL.md) for what each journey proves. A relative symlink at `.agents/skills/verify-ai-code-review` keeps the same content discoverable for agents that read `.agents/skills` instead.

## Model Connection

Copy `.env.example` to `.env.local` and set all four fields:

| Field | Value |
| --- | --- |
| `REVIEW_MODEL_PROVIDER_ID` | Local name for this provider in the SDK session. |
| `REVIEW_MODEL_BASE_URL` | Base URL of the model endpoint. |
| `REVIEW_MODEL_ID` | Model ID exposed by that endpoint. |
| `REVIEW_MODEL_API_KEY` | Nonempty API key required by the current smoke check. |

`.env.local` is ignored by Git. To make a live model request, run:

```sh
bun run smoke:model
```

`bun run smoke:review` runs three full live reviews against the Java defect, guarded, and incomplete-material cases. The incomplete case makes the supporting caller exceed the snapshot limit. Successful and failed run artifacts remain under the printed temporary directory for inspection. To keep a run, use `~/.local/share/ai-code-review/runs/<date>-<case>/`, for example `~/.local/share/ai-code-review/runs/20261120-defect/`. That location has no ancestor `AGENTS.md`, so SDK tools cannot load ambient instructions.

`bun run verify --live` runs the model smoke check first and, on success, runs the three-case acceptance. Both steps make live API calls and can incur charges. `bun run verify doctor --live` only checks that the four settings have the expected format; it does not contact the provider or validate credentials.

This check creates an SDK session using the configured provider and model, waits for an assistant reply, and closes the host. It runs in an isolated child process so it does not read the host's existing OpenCode configuration. The check uses the OpenAI-compatible provider adapter, so the endpoint must support that protocol. Other provider protocols are outside this check's current support.

## Local Review Preparation

The `review` command prepares fixed Git material, runs discovery and independent verification, then writes a JSON result, Markdown report, coverage, phase outputs, tool trace, timing, and usage to the requested new run directory:

```sh
bun run review -- --repo /path/to/repo --base <revision> --head <revision> --out /path/to/new-run-directory
```

The output directory must be new, with an existing parent outside the target repository. The command resolves both revisions and their merge base to commit SHAs, writes `manifest.json`, and places text snapshots and numbered per-change patches under `material/`. The JSON result records verified issues, coverage, stage errors, usage, duration, and configuration and prompt hashes. `report.md` summarizes findings with fixed-snapshot code evidence. `manifest.json` records every tracked file, rename and deletion status, included paths, omitted paths and reasons, and the preparation status. The initial limits in `review.config.json` are 50 changed text files, 256 KiB of patches, and 8 MiB of snapshot text. Excluded files and exhausted limits are recorded; an omitted changed file or size-limited supporting file makes the preparation status `partial`.

The source checkout is never used as the material directory. `REVIEW.md`, when present, is read from the fixed base commit as an explicitly sourced instruction in the manifest. Target `AGENTS.md`, runtime configuration directories, secrets, binary files, and symbolic links are not copied into searchable material.

Run artifacts include:

| File | Contents |
| --- | --- |
| `result.json`, `report.md` | Final status, at most five verified issues, code evidence, coverage, duration, usage, and version hashes. |
| `manifest.json`, `input.json`, `material/` | Fixed commits, input inventory, inclusion/omission reasons, text snapshots, and patches. |
| `configuration.json`, `prompts.json`, `versions.json` | Non-secret model/settings, rendered discovery prompt and verification template, and source/config/prompt hashes. The verification template's marker is replaced with the discovery session's validated canonical JSON. |
| `candidates.json`, `verifications.json`, `sessions.json` | Structured decisions, canonical phase JSON, and bounded accepted/rejected tool submissions with errors and explicit diagnostic truncation. |
| `coverage.json`, `tool-trace.json`, `timing.json`, `usage.json`, `cleanup.json` | Unfinished work, tool reads and pending pages, phase timing, settled or unknown token usage, and host shutdown. |

The 300-second budget covers preparation, worker initialization, both sessions, cleanup, and reporting. Git commands share the remaining deadline; the parent interrupts the worker before its deadline and kills its process group if needed. Credential files and the worker's temporary HOME are removed when it exits.

The command writes one JSON summary to stdout. Exit code `0` means `complete`, `partial`, or `skipped`; findings do not make this advisory tool fail. Exit code `1` means a failed review or invalid command. Inspect `result.status` and coverage before interpreting zero findings. With no changed files it skips model calls. If all changed files are omitted, it reports `partial` without starting a model. Invalid input or snapshot preparation fails before a run directory is published; errors after preparation retain a failure report and available replay records.

## Pull request review

Use the PR form to capture the current API snapshot and run the same local reviewer:

```sh
bun run src/cli.ts review --repository PulseInjector/java-review --pr 17 --config review.config.json --out /path/to/new-run-directory
```

`--config` defaults to `review.config.json` in the captured base commit. GitHub reads require `GITHUB_TOKEN`. Analysis also uses the four `REVIEW_MODEL_*` settings described above.

The new output directory contains `handoff/` with exactly `review-result.json` and `run-manifest.json`. It also contains `replay/` and an allowlisted `replay-export/`. The replay export is capped at 64 MiB. If the cap omits files, `replay/artifact-omissions.json` records the omitted bytes and the JSON summary sets `replayIncomplete` to `true`.

The publish form consumes the handoff from the same active Actions run and attempt:

```sh
bun run src/cli.ts publish --repository PulseInjector/java-review --pr 17 --package /tmp/review-handoff --review-job-result failure
```

`--review-job-result` accepts `success`, `failure`, `cancelled`, or `skipped`. Publication requires the fixed Action commit and installed product directory. The package cannot supply product identity. A local PR review can produce a handoff but cannot publish it.

The publisher validates the package, selects the lowest-ID owned bot comment, and checks the current PR before each report write. A lost create response triggers complete comment scans without another create in that invocation. A changed PR after a confirmed write gets a stale annotation that retains the covered commits. A failed freshness check gets an unconfirmed warning when the comment API remains available.

The command prints one JSON summary with the publication result, comment ID, evidence directory, and exit code. `publish-result.json` records the checks, intended body digests, write intents, and failures. Actions runs place it in `publish-evidence` under the attempt's runner temporary directory. Missing artifacts, rejected packages, failed reviews, and failed publication exit `1`. Stale results and already published results exit `0`. Failure and skip notes retain the last usable report in a separate section.

The deployed form of these commands is in [GitHub Action and reusable workflow](#github-action-and-reusable-workflow).

## GitHub Action and reusable workflow

The root `action.yml` is a composite Action. It accepts `mode` (`review` or `publish`), `config`, `pr`, and `model-api-key`. It installs Bun `1.4.4`, runs `bun install --frozen-lockfile --ignore-scripts` in the product directory, and runs `src/action-entry.ts`. The review mode receives the model key. The publish mode does not. The Action outputs `status`, `run-directory`, `handoff-directory`, `handoff-artifact`, `replay-artifact`, and `comment-id`.

`.github/workflows/review.yml` is a `workflow_call` workflow. It accepts `pr`, `config`, `model-provider-id`, `model-base-url`, and `model-id`, plus the `model-api-key` secret. The workflow sets `permissions: {}`. The review job has `contents: read`, `pull-requests: read`, and `actions: read`. The publish job has `contents: read`, `pull-requests: write`, and `actions: read`. Only the review job receives the model secret.

The workflow uses one concurrency group for the product, a repository, and a pull request, with `cancel-in-progress: false`. The review job uploads the handoff and replay artifacts with names that include the run ID and attempt, and keeps them for seven days. It uploads them even when the job fails. The publish job downloads only the current run's handoff and writes the summary comment.

Callers pin the reusable workflow to a full commit SHA. The workflow pins the product Action to a full commit SHA in both jobs. The caller triggers are `opened`, `synchronize`, `reopened`, `ready_for_review`, and `edited`, plus a `workflow_dispatch` input for the pull request number. `renderCallerWorkflow` in `scripts/workflows.ts` generates `examples/caller.yml` from a workflow commit. Regenerate the example when the workflow commit changes.

The workflow is the only comment writer for a repository and a pull request. A caller that runs another publisher outside the workflow breaks that guarantee. The publish command refuses local writes.

If the canonical comment state is invalid, the publisher keeps the previous report and writes nothing. If a create response is lost, the publisher reads the comment list up to three times and never creates a second comment in the same invocation. A later run or a manual rerun updates the original comment. Full findings and traces stay in the run artifacts. The comment carries a bounded summary.

A base branch update does not necessarily trigger the product event. Rerun the caller workflow manually with the pull request number after a base change. [docs/segment-2-design.md](docs/segment-2-design.md) records the publication freshness rules and the full failure analysis.
