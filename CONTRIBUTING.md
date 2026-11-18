# Development Workflow

This guide covers changes made from a source checkout. Environment setup and model configuration are in [ENVIRONMENT.md](ENVIRONMENT.md).

## Start a Change

If `.local/project-context.md` exists, read it for local project context before starting a task. Keep private links and notes out of commits and shared PR descriptions.

Check the working tree before starting. For a standalone change, create a task branch from `main`. For a feature with several development checkpoints, create an integration branch from `main`. Work through the checkpoints in order on that branch, using local task branches when isolation helps. Keep commits focused. Use short, descriptive lowercase branch names with a prefix such as `feat/`, `fix/`, `docs/`, or `chore/` (for example, `docs/development-workflow`).

## Make and Check the Change

Keep code, tests, and documentation consistent with the behavior changed. Run the checks relevant to the change and record what ran:

- `bun run typecheck` for TypeScript changes.
- `bun run smoke:sdk` for changes affecting SDK host startup or shutdown.
- `bun run smoke:java` for changes affecting the Java toolchain.
- `bun run smoke:model` for changes affecting model configuration or SDK model requests. This makes a live API call and requires the configuration described in [ENVIRONMENT.md](ENVIRONMENT.md#model-connection).
- `bun run smoke:review` for the complete local review command and report. This makes three live model runs and checks defect, guarded, and partial-coverage cases.

Review the diff before committing. Stage only files belonging to the change and write a message that states the result clearly. At each checkpoint, run its relevant checks and record the results for the final PR. Do not commit `.env.local` or credentials.

## Share and Review

For a standalone change, push the task branch and open a pull request against `main` when a remote is available. For a feature with several checkpoints, merge any local task branches into the integration branch after their checks pass. Push the integration branch when needed to back up or share progress; individual checkpoints do not require Issues or pull requests.

Run the feature's end-to-end acceptance on the integration branch. Only after it passes, open one pull request from that branch to `main`. Use the PR template to explain the change and report the checks actually run. Address review feedback on the same branch, rerun affected checks, and update the PR description when needed. Merge into `main` after review and applicable checks are complete.
