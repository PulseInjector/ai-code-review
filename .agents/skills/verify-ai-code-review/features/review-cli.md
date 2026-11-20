# Review CLI

The review CLI accepts two Git revisions and an output directory, then returns a machine-readable status and writes a Markdown report for the fixed revision range.

## Sub-features

- `review-help` shows the required arguments.
- `review-invalid` rejects an invalid revision before publishing artifacts.
- `review-unchanged` skips model work for identical revisions.

## How to get to it (user POV)

- Run `bun run review -- --repo <path> --base <revision> --head <revision> --out <new-directory>`.
- Run `bun run review -- --help` for the command syntax.

## Driving it with the verification CLI

Preconditions:

- `bun run verify doctor` passes.
- Run from the repository root; the harness creates a disposable Git repository and a new evidence directory.

- **Help.** Run `bun run verify --area cli`. The public review command exits `0` and prints the documented `--repo`, `--base`, `--head`, and `--out` usage.
- **Invalid revision.** The same journey passes a nonexistent base revision. The CLI exits `1`, writes an error to stderr, and does not create the requested output directory.
- **Unchanged range.** The journey uses equal base and head SHAs while the fixture working tree contains an uncommitted edit. The CLI exits `0`, reports `skipped`, creates no runtime sessions, preserves the working edit, and reports the exact fixed SHAs.
- **Proof.** Inspect the printed evidence directory's `summary.json`, command stdout/stderr files, `unchanged/result.json`, `unchanged/report.md`, and `unchanged/material/head/notes.txt`. `cli-model-requests.json` must report zero.

## Gotchas

- Exit code `0` includes `skipped` and `partial`; inspect `result.status` and coverage.
- `--out` must be a new directory outside the target repository.
- The uncommitted edit must not appear in the snapshot, and Git refs and status must remain unchanged by review.
