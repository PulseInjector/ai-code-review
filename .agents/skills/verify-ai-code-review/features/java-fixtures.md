# Java Fixtures

The Java fixture supplies a small executable behavior oracle so the review acceptance cases have known defect, fix, and guarded outcomes.

## Sub-features

- `java-toolchain` checks Java and javac availability by compiling and running a temporary class.
- `java-defect` proves the defect fixture fails its assertions.
- `java-fix` proves the corrected fixture passes.
- `java-guarded` proves the guarded variant passes.

## How to get to it (user POV)

- Run `bun run smoke:java` for the toolchain check.
- Run `bun test src/fixtures/java-review.test.ts` for the fixture behavior oracle.
- Run `bun run verify --area java` for both checks through the verification CLI.

## Driving it with the verification CLI

Preconditions:

- `bun run verify doctor` reports Java and javac as runnable.

- **Toolchain.** Run `bun run verify --area java`. The temporary Java program compiles and prints the expected success marker.
- **Fixture outcomes.** The fixture tests require base and fix to pass, the injected defect to fail, and the guarded branch to pass. The test process exits `0` only when all four behaviors match.
- **Proof.** Inspect the printed evidence directory's command logs and `summary.json`; the fixture test must have exit code `0`.

## Gotchas

- A missing JDK is an unmet prerequisite, not evidence that the review detector failed.
- The Java toolchain smoke and fixture tests use temporary files; fixture commit SHAs are fixed by deterministic fixture tests.
- Live model accuracy is covered separately by `bun run verify --live`.
