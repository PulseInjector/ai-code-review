---
name: verify-ai-code-review
description: "Verify the ai-code-review CLI and review pipeline. Use after code, snapshot, runtime, or Java-fixture changes and before accepting a later development phase."
---

# Verify AI Code Review

## Launch

This is a short-lived CLI; there is no server to keep alive. From the repository root, install the locked dependencies with `bun install --frozen-lockfile` if needed. Run `bun run verify doctor` first. It checks Bun and installed package versions, Git, Java, javac, and the current checkout without printing secrets. The full local check starts with:

```sh
bun run verify
```

It runs type checking, unit tests, SDK lifecycle, Java toolchain, and the `review` CLI against two isolated temporary Git repositories. No real credentials or live model endpoint are used. For a focused run, pass one of `--area cli`, `--area snapshot`, `--area runtime`, or `--area java`. A full live acceptance is explicit:

```sh
bun run verify --live
```

It requires the four `REVIEW_MODEL_*` settings described in `ENVIRONMENT.md`, sends a model smoke request and runs the three-case review acceptance. This may incur provider charges. `bun run verify doctor --live` checks only that the values parse; it does not prove connectivity or key validity.

## Doctor

If a check fails unexpectedly, run `bun run verify doctor` before driving it again. It is read-only and verifies the installed toolchain against `package.json` and resolves the current Git `HEAD`. Never reuse another verification run's process, temporary directory, or model session.

## Drive

This is a CLI, so drive it with the exact `bun run verify` commands above. The CLI feature tests call the public `review` command with help, invalid revisions, an unchanged commit range, and a changed excluded sample config. The model endpoint in those two deterministic journeys is a local request counter that rejects any request; a passing run proves that model sessions were skipped.

Read [features/README.md](features/README.md) before selecting a journey. Start with `bun run verify --area cli` for command behavior or `bun run verify --area snapshot` for fixed-snapshot and coverage behavior. Use `bun run verify --area runtime` for SDK and worker behavior, and `bun run verify --area java` for the Java fixture oracle. Run `bun run verify --live` only when the stage requires provider-backed review behavior.

## Evidence

Each `verify` run prints a new evidence directory under the system temporary directory. Keep it after the run. `summary.json` records each check's status and each command's exit code, duration, and stdout/stderr artifact names. The CLI journeys also retain the public command output, Git fixture command logs, run `result.json`, `report.md`, `manifest.json`, the generated snapshot, and a model request counter. A proof is valid only when the command action and its resulting status are both present, the snapshot comes from the requested Git SHAs rather than working-tree edits, and the model counter is zero for deterministic tests. A zero exit code from `review` is not by itself proof of a complete review; check `result.status` and coverage. Never claim live model behavior from a local stub.

## Cleanup

The CLI removes its own scratch directory; local loopback servers stop at the end of each journey. Evidence and review artifacts remain in the printed evidence directory. It never attaches to or kills processes by name. The live smoke and runtime remove their own temporary workspaces on exit, and acceptance removes its fixture repository. Do not remove evidence while investigating a failure.

## Helpers

No separate helper is required. The executable interface is `bun run verify`; supported scopes are shown by `bun run verify --help`.
