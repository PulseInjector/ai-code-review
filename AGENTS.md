# Repository Guidance

Follow `CONTRIBUTING.md` for branch, design, change, verification, template,
and pull request conventions. Follow `ENVIRONMENT.md` for the supported
toolchain, commands, and configuration. Read `PLAN.md` for the current
feature segment, its checkpoint order, and its acceptance criteria.

Keep changes scoped to the requested behavior.

## Segment designs

Write each segment design to `docs/segment-N-design.md`. A design settles:

- the inherited baseline and the proposed change, stated separately
- the caller-visible usage: commands, inputs, outputs, and exit behavior
- module ownership and the boundary between trusted and untrusted input
- data contracts, identities, and states that the code cannot construct
- failure, partial, skipped, and terminal states, including what survives
- idempotency, retry, recovery, and crash behavior for each side effect
- security and trust boundaries, including secret handling
- the owner that enforces each invariant and the check that proves the
  invariant
- verification for each acceptance row, with deterministic proof and live
  evidence kept separate
- the rationale, rejected alternatives, and accepted tradeoffs
- the implementation checkpoint order, with executable evidence for each
  checkpoint

Write repository documents in English.
