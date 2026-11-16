# Development Workflow

This guide covers changes made from a source checkout. Environment setup and model configuration are in [ENVIRONMENT.md](ENVIRONMENT.md).

## Start a Change

If `.local/project-context.md` exists, read it for local project context before starting a task. Keep private links and notes out of commits and shared PR descriptions.

Check the working tree before starting. Keep each branch to one logical change and create it from `main`. Use a short, descriptive lowercase name with a prefix such as `feat/`, `fix/`, `docs/`, or `chore/` (for example, `docs/development-workflow`).

## Make and Check the Change

Keep code, tests, and documentation consistent with the behavior changed. Run the checks relevant to the change and record what ran:

- `bun run typecheck` for TypeScript changes.
- `bun run smoke:sdk` for changes affecting SDK host startup or shutdown.
- `bun run smoke:java` for changes affecting the Java toolchain.
- `bun run smoke:model` for changes affecting model configuration or SDK model requests. This makes a live API call and requires the configuration described in [ENVIRONMENT.md](ENVIRONMENT.md#model-connection).

Review the diff before committing. Stage only files belonging to the change, keep commits focused, and write a message that states the result clearly. Do not commit `.env.local` or credentials.

## Share and Review

When a remote is available, push the task branch and open a pull request against `main`. Use the PR template to explain why the change is needed, what changed, and which checks actually ran. Keep the PR to one logical change.

Address review feedback on the same branch, rerun checks affected by the revisions, and update the PR description when its account of the change becomes inaccurate. Merge after review and applicable checks are complete.
