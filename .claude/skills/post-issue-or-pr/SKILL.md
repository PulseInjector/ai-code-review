---
name: post-issue-or-pr
description: Draft and post a GitHub issue or pull request description in this repository. Use whenever an issue or PR description is written, edited, or posted, by hand or on behalf of a delegate.
---

# Post an issue or a PR

Every issue and PR description in this repository follows its template and passes the mechanical
check before it posts. Hand-done drafts are verified by rerunning
`bun run check:post`, not by reading them again.

## Steps

1. Pick the kind. `bug`, `feature`, or `improvement` for issues, `pr` for a pull request
   description. Read the matching template first: `.github/ISSUE_TEMPLATE/bug_report.yml`,
   `feature_request.yml`, or `improvement.yml` for issues, `.github/pull_request_template.md`
   for a PR. The template names the title prefix and the required sections.
2. Draft facts only. No commentary about the writing itself, no machine-local paths such as
   `/Users/...`, `/tmp/...`, `~/.`, or `.audit/`, no secrets or token-shaped values, straight
   quotes, no em or en dashes. Point at files in the repository and commit SHAs instead of
   machine paths.
3. Save the draft to a file outside the repository and run the check.

   ```sh
   bun run check:post <draft.md> --kind bug --title "[BUG] Short sentence-case title"
   ```

4. Fix every finding by changing the draft. Never fix a finding by changing the checker or
   this skill. If a required section has nothing true to say, the kind is wrong, pick again.
5. Post with the checked body unchanged: `gh issue create --title ... --body-file ...` or
   `gh pr create --body-file ...`. Do not retype the body into the command line.

## Fences

The checker `scripts/check-postable.ts` and this skill are outside the write scope of any
delegate doing issue or PR work. A delegate that fails the check changes its draft, not the
check.
