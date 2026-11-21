# AI Code Review Verification Map

Read this index before running a user-facing verification journey. The app is a short-lived CLI; `bun run verify doctor` is the read-only baseline check and `bun run verify` runs the default local suite.

## Baseline

- Work from the repository root with Bun `1.4.4` and locked dependencies installed.
- Use `bun run verify doctor`; require every check to pass before driving a journey.
- The verification CLI creates isolated Git repositories and evidence under a fresh system temporary directory.
- Never point a verification command at the user's active repository as a fixture or delete a directory that the run did not create.
- Live model calls are excluded from local journeys. `bun run verify --live` is opt-in and can incur API charges.
- The `review` and `publish` subcommand forms need an Actions execution context for production dispatch. Area journeys cover their dispatcher behavior through injected adapters; they never contact a live GitHub or model service.

## Proof rules

- Exercise the public `review` CLI; do not call internal context preparation helpers as proof of the user journey.
- Preserve command stdout/stderr, exit code, report, result, manifest, and exact snapshot evidence.
- Check Git refs and working-tree state before and after the review to prove the command used fixed revisions.
- For no-model journeys, require the local endpoint request counter to remain zero and runtime session artifacts to be empty.
- Treat `partial` and `skipped` as distinct from `complete`, even when the command exits with code zero.
- A driving section names only journeys that exist in `src/verification` at the time it is written. When an area journey is added, renamed, or reorganized, the matching feature file's driving section changes in the same commit.

## Features

- [Review CLI](./review-cli.md) covers the three command forms, help, invalid input, unchanged revisions, and grammar rejection.
- [Snapshot coverage](./snapshot-coverage.md) covers included and excluded inputs, multi-dimensional status derivation, and fixed-commit snapshots.
- [Runtime checks](./runtime.md) covers worker timeout, SDK lifecycle, request policy, session cleanup, and explicit live acceptance.
- [Java fixtures](./java-fixtures.md) covers the behavioral oracle for defect, fix, and guarded code.
- [PR review handoff](./pr-review-handoff.md) covers the review subcommand, the handoff package, and the replay export.
- [Handoff admission](./handoff-admission.md) covers package validation at the publish trust boundary.
- [Publish comments](./publish-comments.md) covers the publish subcommand, comment reconciliation, and the comment state.
