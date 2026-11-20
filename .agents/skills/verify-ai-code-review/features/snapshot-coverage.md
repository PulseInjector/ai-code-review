# Snapshot Coverage

Snapshot coverage tells users which tracked files were prepared from the selected revisions and whether omitted content makes the review partial.

## Sub-features

- `snapshot-fixed` reads committed blobs rather than working-tree content.
- `snapshot-excluded` records excluded files and omission reasons.
- `snapshot-partial` distinguishes usable but incomplete input from a complete snapshot.

## How to get to it (user POV)

- Run the `review` CLI with explicit `--base`, `--head`, and a new `--out` directory.
- Inspect the resulting `manifest.json`, `result.json`, `report.md`, and `material/` directory.

## Driving it with the verification CLI

Preconditions:

- `bun run verify doctor` passes.
- No live model configuration is required; the journey uses a local request-counting endpoint.

- **Prepare revisions.** Run `bun run verify --area snapshot`. The harness commits a tracked note and a changed `.env.example`, then adds an uncommitted edit after recording `HEAD`.
- **Review.** The public CLI exits `0`, reports `partial`, and lists only `.env.example` as omitted with reason `excluded-path`.
- **Prove fixed input.** The `material/head/notes.txt` contains committed content, not the subsequent working edit; the changed `.env.example` is absent from material. Git refs and status match the before-run state.
- **Prove no hidden model work.** The local endpoint request counter is zero and `sessions.json` is empty. Inspect `manifest.json` and `report.md` for matching omission and partial status.

## Gotchas

- An omitted changed file makes coverage partial even though the review command exits `0`.
- Never infer complete coverage from the findings list alone.
- This journey proves a known excluded path and fixed-snapshot behavior; size-limit cases remain covered by unit tests and live acceptance, not by this one CLI journey.
