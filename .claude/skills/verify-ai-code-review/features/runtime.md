# Runtime Checks

The runtime runs an isolated SDK worker under a shared phase plan, bounds tool reads and execution time, gates model requests through a retry and admission policy, and records cleanup, usage, and request-ledger state for review runs.

## Sub-features

- `runtime-timeout` stops a stalled worker within the configured deadline.
- `runtime-cleanup` closes SDK hosts, records `hostClosed`, `forced`, and `closeFailure`, and leaves no worker process group; forced termination sets usage to `unknown`.
- `runtime-request-policy` admits requests only while phase time remains, caps a logical call at three wire attempts, applies deterministic retry delays, disables redirects, blocks standalone `generate`, and records a bounded request ledger.
- `runtime-recovery` resubmits an accepted prompt exactly once and recovers a lost acceptance response within the same session.
- `runtime-live-review` runs discovery and verification against the configured model.

## How to get to it (user POV)

- Run `bun run verify --area runtime` for the local worker, timeout, and SDK checks.
- Run `bun run verify` for the full suite, the only local path that includes `src/runtime/request-policy.test.ts` and `src/runtime/scripted-provider.test.ts`.
- Run `bun run verify --live` for the model smoke and three-case review acceptance.
- Run `bun run verify doctor --live` to check model settings are present and parseable.

## Driving it with the verification CLI

Preconditions:

- `bun run verify doctor` passes for local runtime tests.
- Live checks require all four `REVIEW_MODEL_*` values from `ENVIRONMENT.md`; model connectivity is confirmed only by `--live`.

- **Local timeout.** Run `bun run verify --area runtime`. The stalled local endpoint must receive a request, worker status must be `timeout`, usage must be `unknown`, the credential sentinel must not appear in artifacts, and the process group must be gone. The same area runs `smoke:sdk`; it must report a passed lifecycle and clean host close.
- **Policy surfaces.** The area command runs both request-policy and scripted-provider tests. They cover admission gating, the three-attempt cap, retry delays, the ledger cap, redirects, compaction, title calls, blocked `generate`, and same-session recovery.
- **Live phases.** Run `bun run verify --live`. It runs `smoke:model`, then acceptance cases for defect, guarded, and incomplete coverage. Confirm the case statuses and retained reports; a failed model smoke causes acceptance to be skipped.

## Gotchas

- `doctor --live` does not make a network request and does not validate provider credentials. Its model-settings check runs only when every earlier doctor check passes first.
- Live tests can incur provider charges and must not run as part of the default local suite.
- Timeout usage must remain unknown when a request is interrupted before the SDK settles the terminal turn.
- Request admission, retry classification, retry caps, delay selection, and phase deadlines have a separate TLA+ gate in the `verify-request-policy` skill. Run `bun run scripts/check-request-policy-model.ts` after changing `src/runtime/request-policy.ts` or the deadline set. Surfaces the model excludes, such as provider response duration, compaction, title and `generate` calls, redirects, and ledger capacity, are covered by the TypeScript tests above, not by the model.
