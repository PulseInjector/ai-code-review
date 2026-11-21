# AI code review

This project reviews a fixed pull request snapshot and publishes one summary
comment with functional defects, code evidence, and the scope that was not
reviewed. The first release assists human review. It does not merge, fix, or
gate a pull request.

The supported scope is collaborator branches in one repository and ordinary
functional correctness. Automatic fixes, generated tests, production
deployment monitoring, fork pull requests, multi-model voting,
cross-repository indexing, and a standalone backend are out of scope.

## Quick start

The local review path needs Bun `1.4.4`. The Java fixture checks also need
`javac` and `java`.

```sh
bun install --frozen-lockfile
bun run verify
```

Run a local review against a Git repository and a fixed commit range:

```sh
bun run review -- --repo /path/to/repo --base <revision> --head <revision> --out /path/to/new-run-directory
```

For the pull request command, the Action, and the model configuration, read
[ENVIRONMENT.md](ENVIRONMENT.md).

## Documentation

- [AGENTS.md](AGENTS.md): repository rules and the segment design standard.
- [PLAN.md](PLAN.md): scope, segment order, and acceptance. Segment 3 is
  [incremental review and fix follow-up](PLAN.md#segment-3-incremental-review-and-fix-follow-up).
- [CONTRIBUTING.md](CONTRIBUTING.md): branch, design, check, and pull request
  workflow.
- [ENVIRONMENT.md](ENVIRONMENT.md): toolchain, commands, model configuration,
  and the GitHub Action contract.
- [docs/segment-2-design.md](docs/segment-2-design.md): Segment 2 design
  record.

This README is the initial entry point. Segment 5 completes the onboarding
documentation. Current progress is in [PLAN.md](PLAN.md#current-state).
