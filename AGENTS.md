# Repository Guidance

Follow `CONTRIBUTING.md` for branch, change, verification, and pull request
conventions. Follow `ENVIRONMENT.md` for the supported toolchain and local
configuration. Read `PLAN.md` for the current feature segment, its checkpoint
order, and its acceptance criteria.

Keep changes scoped to the requested behavior. Update relevant tests and
documentation with behavior changes. Run the checks that cover the files and
behavior changed, and report commands that were not run.

Draft every issue and pull request description through the repository
template and pass it with `bun run check:post` before posting. See
`.claude/skills/post-issue-or-pr` for the steps.

Do not commit `.env.local`, credentials, or generated local configuration.
