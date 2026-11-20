# Runtime Checks

The runtime starts an isolated SDK worker, bounds tool reads and execution time, and records cleanup and usage state for review runs.

## Sub-features

- `runtime-timeout` stops a stalled worker within the configured deadline.
- `runtime-cleanup` closes SDK hosts and leaves no worker process group.
- `runtime-live-review` runs discovery and verification against the configured model.

## How to get to it (user POV)

- Run `bun run verify --area runtime` for local worker and SDK checks.
- Run `bun run verify --live` for the model smoke and three-case review acceptance.
- Run `bun run verify doctor --live` to check model settings are present and parseable.

## Driving it with the verification CLI

Preconditions:

- `bun run verify doctor` passes for local runtime tests.
- Live checks require all four `REVIEW_MODEL_*` values from `ENVIRONMENT.md`; model connectivity is confirmed only by `--live`.

- **Local timeout.** Run `bun run verify --area runtime`. The stalled local endpoint must receive a request, worker status must be `timeout`, usage must be `unknown`, the credential sentinel must not appear in artifacts, and the process group must be gone.
- **SDK lifecycle.** The same area runs `smoke:sdk`; it must report a passed lifecycle and clean host close.
- **Live phases.** Run `bun run verify --live`. It runs `smoke:model`, then acceptance cases for defect, guarded, and incomplete coverage. Confirm the case statuses and retained reports; a failed model smoke causes acceptance to be skipped.

## Gotchas

- `doctor --live` does not make a network request and does not validate provider credentials.
- Live tests can incur provider charges and must not run as part of the default local suite.
- Timeout usage must remain unknown when a request is interrupted before the SDK settles the terminal turn.
