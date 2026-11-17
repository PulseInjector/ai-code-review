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

This check creates an SDK session using the configured provider and model, waits for an assistant reply, and closes the host. It runs in an isolated child process so it does not read the host's existing OpenCode configuration. The check uses the OpenAI-compatible provider adapter, so the endpoint must support that protocol. Other provider protocols are outside this check's current support.

## Local Review Preparation

The current `review` command prepares fixed Git material. It does not start a model or produce review findings yet:

```sh
bun run review -- --repo /path/to/repo --base <revision> --head <revision> --out /path/to/new-run-directory
```

The output directory must be new, with an existing parent outside the target repository. The command resolves both revisions and their merge base to commit SHAs, writes `manifest.json`, and places text snapshots and numbered per-change patches under `material/`. `manifest.json` records every tracked file, rename and deletion status, included paths, omitted paths and reasons, and the preparation status. The initial limits in `review.config.json` are 50 changed text files, 256 KiB of patches, and 8 MiB of snapshot text. Excluded files and exhausted limits are recorded; an omitted changed file or size-limited supporting file makes the preparation status `partial`.

The source checkout is never used as the material directory. `REVIEW.md`, when present, is read from the fixed base commit as an explicitly sourced instruction in the manifest. Target `AGENTS.md`, runtime configuration directories, secrets, binary files, and symbolic links are not copied into searchable material.
