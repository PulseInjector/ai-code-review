# AI Code Review Verification Map

Read this index before running a user-facing verification journey. The app is a short-lived CLI; `bun run verify doctor` is the read-only baseline check and `bun run verify` runs the default local suite.

## Baseline

- Work from the repository root with Bun `1.4.4` and locked dependencies installed.
- Use `bun run verify doctor`; require every check to pass before driving a journey.
- The verification CLI creates isolated Git repositories and evidence under a fresh system temporary directory.
- Never point a verification command at the user's active repository as a fixture or delete a directory that the run did not create.
- Live model calls are excluded from local journeys. `bun run verify --live` is opt-in and can incur API charges.

## Proof rules

- Exercise the public `review` CLI; do not call internal context preparation helpers as proof of the user journey.
- Preserve command stdout/stderr, exit code, report, result, manifest, and exact snapshot evidence.
- Check Git refs and working-tree state before and after the review to prove the command used fixed revisions.
- For no-model journeys, require the local endpoint request counter to remain zero and runtime session artifacts to be empty.
- Treat `partial` and `skipped` as distinct from `complete`, even when the command exits with code zero.

## Features

- [Review CLI](./review-cli.md) covers help, invalid input, unchanged revisions, and safe command execution.
- [Snapshot coverage](./snapshot-coverage.md) covers included and excluded inputs, partial status, and fixed-commit snapshots.
- [Runtime checks](./runtime.md) covers worker timeout, SDK lifecycle, session cleanup, and explicit live acceptance.
- [Java fixtures](./java-fixtures.md) covers the behavioral oracle for defect, fix, and guarded code.
