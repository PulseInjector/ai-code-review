# Java review cases

`bun run test` builds a temporary Git repository from `base/` and `patches/`.
Its four fixed commits are recorded in `commits.json`. The defect and fix are
consecutive commits on `main`; `guarded` branches from `base`.

The business rule is in the repository's `REVIEW.md`: a missing customer's item
count is zero. The service may return an empty list or `null`, but the caller
must handle the value before iterating. The defect changes only the service,
leaving an unguarded caller. The guarded variant changes both sides and is a
normal modification. `ReviewAssertions` checks missing and active customers.

Truth labels live separately in `evals/labels/java-review.json`. They are not
copied into the temporary repository and must not be included in model material.
