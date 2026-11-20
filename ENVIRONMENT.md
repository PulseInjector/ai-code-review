# Development Environment

## Prerequisites

- macOS is the current local development platform.
- Bun `1.4.4` runs TypeScript files directly and installs dependencies from `bun.lock`.
- `@opencode/sdk` and `@opencode/plugin` are pinned to `2.2.7` in `package.json`.
- `javac` and `java` must be available for the Java toolchain check.

The project uses the pinned OpenCode SDK and its embedded host API. A separately installed OpenCode CLI is not required.

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

```sh
bun run verify doctor
bun run verify
bun run verify --area snapshot
```

`doctor` checks the checkout, locked dependency versions, and local toolchain without starting the SDK. `verify` runs type checking, tests, and the SDK and Java checks, then drives the public `review` command on disposable Git repositories. Use `--area cli`, `--area snapshot`, `--area runtime`, or `--area java` to run one group. These checks do not contact a live model provider.

The command prints an evidence directory containing `summary.json`, command logs, and any generated review reports. Temporary fixture repositories are removed; the evidence remains. A verification command exits `1` if a check fails. See the [project verification skill](.agents/skills/verify-ai-code-review/SKILL.md) for what each journey proves.

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
| `configuration.json`, `prompts.json`, `versions.json` | Non-secret model/settings, rendered discovery prompt and verification template, and source/config/prompt hashes. The verification template's marker is replaced with the discovery session's final JSON. |
| `candidates.json`, `verifications.json`, `sessions.json` | Structured decisions and raw final phase text, including invalid output retained on failure. |
| `coverage.json`, `tool-trace.json`, `timing.json`, `usage.json`, `cleanup.json` | Unfinished work, tool reads and pending pages, phase timing, settled or unknown token usage, and host shutdown. |

The 300-second budget covers preparation, worker initialization, both sessions, cleanup, and reporting. Git commands share the remaining deadline; the parent interrupts the worker before its deadline and kills its process group if needed. Credential files and the worker's temporary HOME are removed when it exits.

The command writes one JSON summary to stdout. Exit code `0` means `complete`, `partial`, or `skipped`; findings do not make this advisory tool fail. Exit code `1` means a failed review or invalid command. Inspect `result.status` and coverage before interpreting zero findings. With no changed files it skips model calls. If all changed files are omitted, it reports `partial` without starting a model. Invalid input or snapshot preparation fails before a run directory is published; errors after preparation retain a failure report and available replay records.
