# Docs publisher verification map

This directory is the maintained source for verifying the user-facing behavior of `action-docs-publisher` in the `pre-vieitesss` sandbox. Read this index before driving the action, then follow the matching feature file.

## Baseline preconditions

- `gh` is authenticated with write access to `pre-vieitesss/features` and `pre-vieitesss/docs-e2e`, and SSH push access works for `git@github.com:pre-vieitesss/features.git`.
- The commit SHA under test is pushed to `prefapp/action-docs-publisher`.
- `sandbox.sh launch --sha "$ACTION_SHA"` has succeeded and printed `RUN_ID`, `DOCS_BRANCH=verify-<run-id>`, and `EVIDENCE_DIR`.
- `sandbox.sh doctor --run-id "$RUN_ID"` prints `doctor=ok`.
- Never write to `pre-vieitesss/docs-e2e` `main` or drive the sandbox when another `verify-*` session owns it.

## Driving conventions

- Set `SANDBOX=".agents/skills/verify-docs-publisher/scripts/sandbox.sh"` and `WORK_REPO="/tmp/verify-docs-publisher-work/$RUN_ID/features"`.
- Include `verify-$RUN_ID` in every temporary commit message on `pre-vieitesss/features` `main` so `sandbox.sh cleanup` can identify and reset verification commits cleanly.
- Prefix every temporary PR branch with `verify-$RUN_ID-`.
- Record a UTC timestamp (`TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"`) right before triggering `workflow_dispatch` or `release` events so `wait-run --after "$TS"` matches the new run.
- Delete any semver test tag or release whose name does not include `verify-$RUN_ID` before running `sandbox.sh cleanup`.
- The first Reconcile of a session evaluates every historical tag, so it runs much longer than later runs: `sandbox.sh wait-run` defaults to `--timeout 1800`. Pass a larger `--timeout` only when a run legitimately exceeds that.
- Pushing to `pre-vieitesss/features` `main` triggers `release-please`, which may synchronize its open release PRs and start read-only `pull_request` plan runs. These runs do not write to `pre-vieitesss/docs-e2e` and do not block `sandbox.sh doctor`.
- Never remove `/tmp/verify-docs-publisher-evidence/$RUN_ID/` during cleanup.
- A run that is expected to fail needs `sandbox.sh wait-run … --allow-failure`; without it the helper exits non-zero on the non-success conclusion.
- A run that commits nothing is proven by an empty `DOCS_COMMIT_SHA:` line together with an unchanged head in `docs-commits.json`.

## Proof and skip reporting

- Capture both the workflow run (`run.json`, `run.log`) and the resulting Docs repo state (`docs-commits.json`, fetched `docs-files/`) via `sandbox.sh capture`.
- Pass `--compare <base-sha>` to `capture` to also write `docs-compare.json`, the changed-file list of `docs-e2e` `<base-sha>...verify-<run-id>` (`filename` and `status` per file). Use it to prove that two writes landed in the same commit, that a Version folder was untouched, or that a prune deleted an Area folder.
- For Plan mode, also capture `pr-comments.json` with `--pr <number>`.
- Check the `Record publish outputs` step in `run.log` or the job summary table for `run-mode`, `docs-changed`, and `docs-commit-sha`.
- Read `docs-changed` from the `DOCS_CHANGED:` line of the `Record publish outputs` step in `run.log`; a `docs-changed: false` run prints `DOCS_COMMIT_SHA:` with no value. Grepping `run.log` directly for `docs-changed` is unreliable in a long run because the step prints env lines, not a summary line.
- Report any unreachable entry point with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses four H2 sections in this order:

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with sandbox.sh` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can invalidate a verification run.

## Features

- [Manual reconcile](./manual-reconcile.md) covers `workflow_dispatch` reconciliation, legacy marker stamping, and idempotency on a second run.
- [Release run](./release-run.md) covers publishing a new package release, rebuilding Shared files, and skipping non-matching or prerelease tags.
- [Push run](./push-run.md) covers refreshing changed `areaFiles` on `main` without touching Version folders, and escalating to Reconcile when `.github/docs_publisher.yaml` changes.
- [PR plan comment](./pr-plan-comment.md) covers posting and updating the sticky plan comment, clearing it when docs changes are reverted, and keeping the Docs repo read-only.
- [Skipped and moved tags](./skipped-and-moved-tags.md) covers writing and reusing `.skipped-tags.json`, folding large skip lists in PR plans, and republishing a Version folder when its tag moves.
- [Skipped tags lifecycle](./skipped-tags-lifecycle.md) covers what happens to a tag after it is recorded as skipped: a Release run publishing it and clearing the record, a moved tag whose content fails, a skipped Release run, a deleted tag, a corrupted file, and an Area holding only `.skipped-tags.json`.
