# Review CLI

The review CLI has three command forms. The legacy local form reviews two Git revisions and writes a Markdown report for the fixed revision range. The `review` subcommand reviews a pull request and writes a handoff package. The `publish` subcommand consumes a handoff package inside Actions. The legacy form is what the verification CLI journeys drive.

## Sub-features

- `review-help` prints the legacy usage for `--help` alone and the full three-form syntax for `review --help` or `publish --help`.
- `review-invalid` rejects an invalid revision before publishing artifacts.
- `review-unchanged` skips model work for identical revisions.
- `review-grammar` rejects mixed forms, unknown or duplicate flags, noncanonical PR text, and missing values before any credential is read.

## How to get to it (user POV)

- Run `bun run review -- --repo <path> --base <revision> --head <revision> --out <new-directory>` for the legacy local form.
- Run `bun run review -- review --help` or `bun run review -- publish --help` for the full syntax of all three forms.
- Note that `bun run review -- --help` prints only the legacy local usage line, not the full syntax.

## Driving it with the verification CLI

Preconditions:

- `bun run verify doctor` passes.
- Run from the repository root; the harness creates a disposable Git repository and a new evidence directory.

- **Help.** Run `bun run verify --area cli`. The public review command exits `0` and prints the documented `--repo`, `--base`, `--head`, and `--out` usage. Prove the full grammar separately: `bun run review -- review --help` and `bun run review -- publish --help` each exit `0` and print the three-form usage.
- **Invalid revision.** The same journey passes a nonexistent base revision. The CLI exits `1`, writes an error to stderr, and does not create the requested output directory.
- **Unchanged range.** The journey uses equal base and head SHAs while the fixture working tree contains an uncommitted edit. The CLI exits `0`, reports `skipped`, creates no runtime sessions, preserves the working edit, and reports the exact fixed SHAs.
- **Grammar rejection.** `bun run review -- review --repository owner/repo --pr 017 --out <new-directory>` exits `1` with `--pr must be a positive decimal number` on stderr and creates no output directory. The same rule rejects `+17`, `17.0`, surrounding whitespace, and leading zeros at every PR-input boundary, in both the review and publish forms.
- **Proof.** Inspect the printed evidence directory's `summary.json`, command stdout/stderr files, `unchanged/result.json`, `unchanged/report.md`, and `unchanged/material/head/notes.txt`. `cli-model-requests.json` must report zero.

## Gotchas

- Exit code `0` for the legacy form includes `skipped` and `partial`; inspect `result.status` and coverage. The PR and publish forms have their own exit mappings; see the PR review handoff and publish comment feature files.
- The help text names the subcommands as `bun run src/cli.ts review ...` while the legacy line uses `bun run review -- ...`; both spellings invoke the same entry point.
- `--out` must be a new directory outside the target repository.
- The uncommitted edit must not appear in the snapshot, and Git refs and status must remain unchanged by review.
- The verification CLI journeys cover only the legacy local form. The PR and publish dispatch paths are covered by `bun test src/cli.test.ts src/pr-review.test.ts src/publish.test.ts` and need an Actions context for a full live run.
