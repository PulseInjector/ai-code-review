# Development Workflow

This guide covers changes made from a source checkout. Environment setup and model configuration are in [ENVIRONMENT.md](ENVIRONMENT.md).

## Start a Change

Read `PLAN.md` before starting a task. It records the current feature segment, its checkpoints, and its acceptance criteria. Keep personal notes, private planning links, and run artifacts out of commits, pull requests, and shared documentation. Write review runs outside the repository. [ENVIRONMENT.md](ENVIRONMENT.md#local-review-preparation) names the recommended output location.

Check the working tree before starting. For a standalone change, create a task branch from `main`. For a feature with several development checkpoints, create an integration branch from `main`. Work through the checkpoints in order on that branch. Use local task branches when isolation helps. Keep commits focused. Use short, lowercase branch names with a prefix such as `feat/`, `fix/`, `docs/`, or `chore/`, for example `docs/development-workflow`.

## Design the Change

Write or update the segment design at `docs/segment-N-design.md` before implementation. `AGENTS.md` lists what every design must settle. Write the design in English.

Review and approve the design before implementation. When behavior changes during implementation, update the design in the same branch and the same pull request. `PLAN.md` remains the authority for scope, order, and acceptance.

The [verification tooling proposal](docs/verification-tooling-design.md)
describes a scoped follow-up to Segment 2. Its checkpoints use this same
design approval and integration-branch workflow. Until implemented, use the
verification commands documented in `ENVIRONMENT.md`.

## Make and Check the Change

Keep code, tests, and documentation consistent with the behavior changed. Run the checks relevant to the change. Record the commands that ran, their results, and any relevant command that did not run:

- `bun run verify` for the default local suite and CLI journeys, or `bun run verify --area <name>` for a targeted group. See [Verification CLI](ENVIRONMENT.md#verification-cli) for scopes and evidence.
- `bun run typecheck` for TypeScript changes.
- `bun run smoke:sdk` for changes affecting SDK host startup or shutdown.
- `bun run smoke:java` for changes affecting the Java toolchain.
- `bun run smoke:model` for changes affecting model configuration or SDK model requests. This makes a live API call and requires the configuration described in [ENVIRONMENT.md](ENVIRONMENT.md#model-connection).
- `bun run smoke:review` for the complete local review command and report. This makes three live model runs and checks defect, guarded, and partial-coverage cases.

Review the diff before committing. Stage only files belonging to the change. Write a message that states the result clearly. At each checkpoint, run its relevant checks and record the results for the final pull request. Do not commit `.env.local`, credentials, or generated local configuration.

## Share and Review

For a standalone change, push the task branch and open a pull request against `main` when a remote is available. For a feature with several checkpoints, merge local task branches into the integration branch after their checks pass. Push the integration branch when needed to back up or share progress. Individual checkpoints do not require issues or pull requests.

After the feature's end-to-end acceptance passes, open one pull request from the integration branch to `main`. Use the matching repository template for every issue and pull request description. Run `bun run check:post` on the draft before posting. See `.claude/skills/post-issue-or-pr` for the steps. Address review feedback on the same branch, rerun the affected checks, and update the pull request description when needed. Merge into `main` after review and the applicable checks complete.
