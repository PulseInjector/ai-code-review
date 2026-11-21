# Publish Comments

The publish command runs inside the review workflow and reconciles exactly one owned bot comment on the PR. It preserves the last usable report across failures and skips, orders publications by run, attempt, and trigger time, never replaces a newer result, turns a lost comment response into a re-list rather than a duplicate create, and annotates the comment as stale or unconfirmed after a confirmed write. It writes sanitized evidence to `publish-result.json`.

## Sub-features

- `publish-decision` applies the fixed precedence: reject invalid identity, attempt, or package; reject invalid owned state; compare publication order; retain stale results; update `lastReport` only for complete or partial reviews.
- `publish-reconcile` lists all comments with pagination, selects the lowest owned ID as canonical, records duplicates, and never creates when any owned marker exists.
- `publish-uncertain-write` never repeats a POST after an unknown outcome; it re-lists up to three times, adopts a matching comment, and ends with `comment-write-unknown` when none appears. An uncertain PATCH followed by an absent read also ends in `comment-write-unknown` and never authorizes a POST.
- `publish-postcheck` re-fetches the PR after a confirmed write and annotates stale or unconfirmed freshness while keeping `lastReport` unchanged.
- `publish-comment-state` renders the deterministic body with the marker, bounded state block, at most five issue summaries, and the strict escaper.

## How to get to it (user POV)

- Run `bun run review -- publish --repository <owner/name> --pr <number> --package <handoff-dir> --review-job-result <success|failure|cancelled|skipped>`.
- Requires an Actions execution context: the full `GITHUB_*` key set, `GITHUB_TOKEN`, `GITHUB_ACTION_PATH`, `REVIEW_PRODUCT_COMMIT`, and `REVIEW_PRODUCT_DIRECTORY`. A local invocation is refused.
- Produces one JSON stdout line (`publication`, `runUrl`, `commentId`, `evidenceDirectory`, `exitCode`) and `<evidenceDirectory>/publish-result.json`.

## Driving it

Preconditions:

- `bun run verify doctor` passes.
- `bun run verify --area github` passes the `publish-comments` journey through the public dispatcher, injected publisher, and deterministic state renderer.

- **Publication journeys.** The tests drive the production dispatcher with an injected publisher: a first publication creates one comment; a repeat of the same attempt and digest returns `already-published` with no write; a lost POST response retains the original comment ID after a re-list; an H2 race yields a stale annotation still bound to H1; a missing artifact yields an `artifact-missing` failure note; a corrupt package yields `rejected` with zero writes.
- **Marker forgery.** The comment tests prove model text cannot open an HTML comment, forge the marker line, inject links, commands, or mentions, and that extra markers or state blocks make a comment invalid.
- **Proof.** `publish-result.json` carries the precheck, intended body digest, write intents, relist attempts, duplicate IDs, and final publication; token values appear as `[redacted]`.

## Gotchas

- Exit `0` includes `published`, all `retained` reasons, stale annotations, and advisory partial and skip outcomes; a retained run may still write one annotation PATCH while exiting `0`. Exit `1` covers missing artifact, rejected package, failed publication, and a failed or red admitted review.
- Ownership is strict: author ID `41898282`, login `github-actions[bot]`, type `Bot`. A human comment whose first line is the marker is recorded, never updated.
- At most three writes per invocation, shared across report and annotation. One create maximum; a 404 PATCH triggers a fresh list and at most one genuine re-create.
- `lastReport` is immutable during failed and skipped publication; a metadata overflow rejects before writing rather than shrinking a retained report.
- Comment byte caps: 16 KiB decoded state, 21,846 encoded state, 32,000 visible bytes, 60,000 total body bytes. Oversized content shrinks summaries in descending ordinal and field order, then converts citations to artifact digests.
- Publishing is single-writer by context: the workflow must be the current `in_progress` attempt before every report write.
- An evidence file over 1 MiB throws; no `publish-result.json` or stdout JSON is produced for that case.
