# PR Review Handoff

The PR review command reviews a GitHub pull request by owner/name and number, captures a fixed base and head from the GitHub API, freezes configuration from the base commit or the product default, runs the local reviewer against a disposable fixed repository, and writes a two-file handoff package plus a bounded replay export into a new output directory. The handoff package is the only review output the publisher trusts.

## Sub-features

- `pr-review-grammar` parses the review subcommand with canonical PR text and a relative config path.
- `pr-review-skip` skips without model work for draft, closed, fork, and unchanged PRs while still writing a handoff.
- `pr-review-handoff` commits exactly `review-result.json` and `run-manifest.json` through a staging rename with byte caps.
- `pr-review-replay` exports the allowlisted replay copy with a 64 MiB cap and exact omission records.

## How to get to it (user POV)

- Run `bun run review -- review --repository <owner/name> --pr <number> [--config <relative-path>] --out <new-directory>`.
- The command prints one JSON summary line: `runDirectory`, `outcome`, `handoffDirectory`, `artifactName`, `replayExportDirectory`, `replayIncomplete`, `omittedTraceBytes`.
- A full live dispatch requires `GITHUB_TOKEN` and an Actions execution context. Help and argument-rejection paths run locally.

## Driving it

Preconditions:

- `bun run verify doctor` passes.
- This surface is driven by `bun test src/pr-review.test.ts src/cli.test.ts src/handoff.test.ts`, which the full `bun run verify` suite includes. Per the map's sync rule, this driving section changes in the commit that adds a dedicated area journey.

- **Grammar and rejection.** `bun run review -- review --help` exits `0` with the full syntax. `--pr 017` exits `1` with `--pr must be a positive decimal number` and no output directory.
- **Dispatch journeys.** The unit tests drive the production dispatcher with injected adapters: a draft PR proves a skip with no model or worker calls, a fake worker with one candidate and one keep proves a reviewed result, a capture 404 proves a failed outcome with no handoff, and seven journeys cover complete, partial, skipped, capture failure, preparation failure, runtime failure, and interrupted partial through real parsing, one stdout line, and exit mapping.
- **Proof.** For a captured run the handoff directory holds exactly two regular files; the replay export matches the allowlist; `replayIncomplete` is `false` unless bytes were omitted.

## Gotchas

- Exit `0` covers complete, partial, and skipped; a reviewed result exits `1` only for a red stage error such as `retry-exhausted`, `discovery-timeout`, `verification-timeout`, `run-interrupted`, or `cleanup-failed`. `read-budget` and `request-budget` alone stay advisory with exit `0`.
- `--pr` must be canonical decimal text; `017`, `+17`, `17.0`, and whitespace reject.
- `--out` must be a new directory outside both the caller checkout and the product checkout, validated through the parent's real path before capture.
- `runDirectory` is `<out>/replay` on the successful path but `<out>` on a pre-replay failure.
- A captured-but-skipped or captured-but-failed run still writes a handoff. `handoffDirectory` is `null` when identity was never captured or the package could not be committed; a skipped run whose handoff cannot be committed converts to an `artifact-write` failure with exit `1`.
- `artifactName` is `null` for local execution and `ai-code-review-handoff-<runId>-<attempt>` only under Actions.
- `previous-comment.json` is a bounded diagnostic backup, never authority for publication and never inserted into prompts.
