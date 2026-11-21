---
name: pr-cycle
description: Ship a finished change through the OŁCyŚ git flow — feature branch, PR into develop, CI and Greptile review, fixing findings, replying to and resolving review threads, merging; also releases and hotfixes. Use when a work package is ready to push, when a PR has new Greptile findings, or when preparing a release or hotfix.
---

# PR cycle (git flow + Greptile)

Run the `pre-pr-review` skill first; this skill starts when the change is done and verified.

## 1. Branch and commits

- Branch from the latest `origin/develop`: `git fetch origin && git switch -c feature/<area> origin/develop`.
- Commit messages `<area>: <imperative summary>`. Commits are signed by the git configuration — never disable
  signing. No AI attribution trailers or footers.
- Stage explicit paths (not `git add -A`). Never commit `data/`, `.env`, agent worktrees (`.claude/worktrees/`) or
  other local-only files.

## 2. Push and open the PR

- `git push -u origin <branch>`. With gh-based authentication:
  `git -c credential.helper= -c credential.helper='!gh auth git-credential' push -u origin <branch>`.
- `gh pr create --base develop --title "<area>: <summary>" --body "<what, why, tests, docs>"` — a plain description,
  no attribution.
- Greptile reviews automatically when the PR is opened (`.greptile/`). PRs into `main` are not reviewed.

## 3. Wait for CI and the review

- Wait in the background (a polling loop or event listener), not with foreground sleeps, until `gh pr checks <n>` has
  no pending checks and `gh api repos/{owner}/{repo}/pulls/<n>/reviews` contains a review by `greptile-apps[bot]`
  whose `commit_id` is the commit you asked about — the PR head (`gh pr view <n> --json headRefOid`) for a new PR or
  a re-review. An older review does not count.
- Read the summary comment (confidence score, findings, the "Fix with agent prompt" block) and the inline comments
  (`gh api repos/{owner}/{repo}/pulls/<n>/comments`).

## 4. Triage and fix

- Verify every finding against the code. Fix valid ones in follow-up commits on the same branch, each with a
  regression test. When a finding is wrong, explain why in its thread instead of changing code.
- `pnpm check` must pass; update the Polish READMEs and `docs/**` when behaviour changes.
- Reply in each thread with what changed and the commit sha:
  `gh api repos/{owner}/{repo}/pulls/<n>/comments/<comment-id>/replies -f body="Fixed in <sha>: …"`.
- Resolve the addressed threads: GraphQL `resolveReviewThread(input: {threadId})`, thread ids from
  `repository.pullRequest(number).reviewThreads`.
- After substantive fixes, request a re-review by commenting `@greptileai` on the PR, then wait again as in step 3
  for a review of the new head commit. Skip re-reviews for trivial follow-ups (wording, typos, one-line fixes a
  review already asked for): review credits are limited.

## 5. Merge

- Merge only when CI is green, a review of the latest substantive commit leaves no valid open finding and every
  thread is answered:
  `gh pr merge <n> --merge --delete-branch`, then `git fetch --prune origin`.

## Releases and hotfixes

- Release: `release/<version>` from `develop` → PR into `main` → merge → signed tag `v<version>` on the merge commit
  (`git tag -s`) → merge `main` back into `develop`.
- Hotfix: `hotfix/<topic>` from `main` → PR into `main` → bring the same change into `develop`.
