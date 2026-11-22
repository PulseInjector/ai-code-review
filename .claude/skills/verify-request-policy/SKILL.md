---
name: verify-request-policy
description: "Model-check retry and deadline behavior in the OpenCode model-request policy. Use after changes to request admission, retry classification, retry limits, delay selection, or phase deadlines."
---

# Verify Request Policy

Use this check after changing `src/runtime/request-policy.ts` or code that changes its phase deadlines or SDK hook ordering. Run from the repository root:

```sh
bun run scripts/check-request-policy-model.ts
```

The command downloads the official TLA+ Tools `1.7.4` jar when needed, verifies its published SHA-1 checksum, caches it outside the repository, and runs TLC with one worker. It checks the normal configuration and a deliberately broken configuration. The normal model must have no invariant violation. The broken model must violate `PolicyInvariant` with exactly the distinguishing evidence that four requests were sent after three retry approvals. Read the TLC outputs with the pstack `/statechart` skill. The runner retains both outputs in the temporary evidence directory it prints.

## Property and harm

One logical model call sends at most three requests. A fourth request can waste provider cost and exceed the runtime's retry policy. `PolicyInvariant` combines this limit with the required retry approval, deadline admission, retry classification, and delay rules.

## Model and code mapping

`RequestPolicy.tla` models one serialized primary request call and follows the production hook order:

- `ModelRequest` models `model.request`. It resets `lastAttempt` unless a retry approval remains set.
- `SendRequest` models `http.request`. It checks the attempt cap, deadline admission, and retry approval, records the wire request, increments `lastAttempt`, and consumes the approval.
- `ReturnError` passes a representative provider error to the retry decision.
- `RejectNonRetriable`, `RejectRetryCap`, `RejectRetryDelay`, `RejectRetryDeadline`, and `ApproveRetry` model the ordered decisions in the production `retry` hook.
- `MaxAttempts` maps to `MAX_ATTEMPTS`; `RetryDelay2` and `RetryDelay3` map to `RETRY_DELAYS_MS`; `AdmissionMs` maps to `MODEL_ADMISSION_MS`.
- Error records model the retryable provider types, the non-retriable type precedence, and representative HTTP statuses used by `isRetriableRequestError`.

The TLA+ model is an abstraction of the production code, not an executable model extracted from TypeScript. It models one primary call with serialized SDK hooks. When a mapped branch, constant, or pinned SDK hook order changes, inspect the code and update the model before moving the sync commit. Read the TypeScript tests as well. If TLC reports a violation, use its path to decide whether it exposes a product defect or a mismatch between the model and the code. Do not weaken the invariant to make TLC pass.

## Scope

TLC exhausts the finite state graph for the normal constants: a three-request contract, a six-unit phase budget, retry-after values 0 and 3, and representative transport, provider-type, and HTTP-status errors. The current normal model has 252 distinct reachable states. The broken configuration changes the implementation cap to four and enables an additional fourth-attempt delay, so TLC can show the resulting fourth request while the invariant keeps the required cap at three.

The model does not include provider response duration, concurrent sessions, compaction, title or standalone generation calls, redirects, request-ledger capacity, or OpenCode SDK internals. It proves the combined invariant for every reachable state in these finite configurations, not for every behavior of the application.

## Coverage record

- Covered code: `src/runtime/request-policy.ts`, `createRequestPolicyPlugin`, `isRetriableRequestError`, and the primary `model.request` / `http.request` / `retry` sequence.
- Model files: `RequestPolicy.tla`, `RequestPolicy.cfg`, and `RequestPolicy-broken.cfg` in this directory.
- Sync commit: `131f6168a9433c2c12225f676348bf0fcd20cd87`.
- Move the sync commit forward only after confirming that the model still describes the code at the new commit.
- Sensitivity mutation: increase `MAX_ATTEMPTS` to 4 and add a fourth delay to `RETRY_DELAYS_MS`. The request-policy tests must reject this combined change. Restore both values, then run the model and tests.
