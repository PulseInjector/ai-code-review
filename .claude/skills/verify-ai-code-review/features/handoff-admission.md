# Handoff Admission

Admission is the publisher's defense against a corrupted, stale, or forged handoff package. It re-reads the active workflow attempt and artifact receipt, requires an exact two-file package with a matching byte digest, validates strict schemas and canonical serialization, and rechecks identity, attempt, product provenance, the fixed-snapshot merge base, and citations before any comment mutation. A rejected package causes zero publish writes.

## Sub-features

- `admission-shape` requires exactly `review-result.json` and `run-manifest.json`, each a regular single-link file, within the 32 KiB manifest and 512 KiB result caps.
- `admission-identity` matches repository, PR, run, attempt, and the fixed run URL against the expected Actions context.
- `admission-provenance` recomputes the product source and prompt hashes from the installed files and requires the manifest to match.
- `admission-citations` validates every finding citation against the fixed snapshot and changed-head paths, with an 8 MiB per-file and 16 MiB aggregate source cap.
- `admission-receipt` requires one unexpired exact-name artifact receipt for the current run.

## How to get to it (user POV)

- Admission runs inside `bun run review -- publish --repository <owner/name> --pr <number> --package <handoff-dir> --review-job-result <result>`; it is not user-invoked alone.
- Its verdict appears as `publication.kind` in the evidence `publish-result.json` and the process exit code.

## Driving it

Preconditions:

- `bun run verify doctor` passes.
- `bun run verify --area github` passes the `handoff-admission` journey through the public dispatcher and injected GitHub adapters.

- **Valid admission.** The tests build a package with `writePrHandoff`, admit it against a matching in-progress workflow and one exact-name unexpired receipt, and assert `{ kind: "valid" }` with the expected result digest.
- **Mutation cases.** Each mutation must reject with the right code: a third file, a symlink or hard link, one flipped result byte, a changed expected attempt, an expired receipt, two matching receipts, a completed workflow, a changed product commit, and a citation outside `changedHeadPaths`.
- **Idempotent repeat.** An identical already-committed package returns success without a rewrite; conflicting bytes reject without replacement.

## Gotchas

- The manifest's `result.sha256` must equal the SHA-256 of the exact `review-result.json` bytes including the trailing newline, and `result.bytes` must equal the byte length.
- Both files must re-serialize byte-identically with UTF-8, LF, two-space JSON, and a trailing newline.
- A reviewed outcome requires a non-null capture with a merge base, a non-null config record, and, for Actions, a non-null model record.
- The expected run URL is the fixed `/actions/runs/<runId>` route; the review execution context stores the un-attempted URL while the comment state later uses the attempt-qualified route.
- Product identity comes from the fixed Action context and installed files, never from the package: publish requires `REVIEW_PRODUCT_COMMIT`, absolute `GITHUB_ACTION_PATH` and `REVIEW_PRODUCT_DIRECTORY`, and both real paths must equal the installed product directory.
- A missing artifact is separate from rejection: publish writes a bounded `artifact-missing` failure note and exits `1`.
