# Snapshot Coverage

Snapshot coverage tells users which tracked files were prepared from the selected revisions, and whether the review result is complete. Omitted content is one cause of a partial result; candidate accounting, publication caps, read-budget exhaustion, and pending tool pages are others.

## Sub-features

- `snapshot-fixed` reads committed blobs rather than working-tree content.
- `snapshot-excluded` records excluded files and omission reasons.
- `status-derivation` decides `complete` versus `partial` from every coverage dimension, not omitted paths alone.

## How to get to it (user POV)

- Run the `review` CLI with explicit `--base`, `--head`, and a new `--out` directory.
- Inspect the resulting `manifest.json`, `result.json`, `report.md`, `coverage.json`, `tool-trace.json`, and `material/` directory.

## Driving it with the verification CLI

Preconditions:

- `bun run verify doctor` passes.
- No live model configuration is required; the journey uses a local request-counting endpoint.

- **Prepare revisions.** Run `bun run verify --area snapshot`. The harness commits a tracked note and a changed `.env.example`, then adds an uncommitted edit after recording `HEAD`.
- **Review.** The public CLI exits `0`, reports `partial`, and lists only `.env.example` as omitted with reason `excluded-path`.
- **Prove fixed input.** The `material/head/notes.txt` contains committed content, not the subsequent working edit; the changed `.env.example` is absent from material. Git refs and status match the before-run state.
- **Prove no hidden model work.** The local endpoint request counter is zero and `sessions.json` is empty. Inspect `manifest.json` and `report.md` for matching omission and partial status.
- **Prove status derivation.** `deriveReviewStatus` returns `complete` only when omitted paths, unverified candidates, unpublished candidates, coverage notes, and stage errors are all empty and pending tool pages are zero. Rejected candidates count as unverified. Focus the newer rules with `bun test src/pr-contracts.test.ts src/report.test.ts` and the pending-page and read-budget cases in `src/pr-contracts.test.ts`.

## Gotchas

- A fully included snapshot can still be `partial`: an omitted changed file, an unverified candidate, a publication-cap overflow, an exhausted tool read budget, or a pending tool page each force it, even when the review command exits `0`.
- Never infer complete coverage from the findings list alone.
- `coverage.json` carries `unverifiedCandidateIds`, `unpublishedCandidateIds`, and the notes; `tool-trace.json` carries the read-budget records. They are the direct evidence for the status derivation.
- This journey proves a known excluded path and fixed-snapshot behavior; size-limit cases remain covered by unit tests and live acceptance, not by this one CLI journey.
