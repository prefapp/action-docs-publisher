# Skipped and moved tags

Skipped and moved tags (#7) records tags that a Reconcile cannot publish in a per-Area `.skipped-tags.json` in the Docs repo so subsequent runs reuse unchanged skips without re-evaluating them, collapses large skip batches in PR plan comments, stamps legacy Version markers with `sourceRevision`, and republishes a Version folder whenever its tag moves to a different commit.

## Sub-features

- `skipped-write` writes `<area>/.skipped-tags.json` with `source` and per-tag records (`sourceRevision`, `reason`, and `specHash` or `detail` when applicable) during Reconcile.
- `skipped-reuse` reuses unchanged records on the next Reconcile and summarizes them as `- <N> previously skipped tag(s) unchanged.` with `docs-changed: false`.
- `skipped-plan-collapse` folds more than 10 fresh skipped tags in a PR plan comment inside `<details><summary>Skipped <N> tags</summary>`.
- `marker-stamp` stamps existing Version markers that lack `sourceRevision` in place on Reconcile without rebuilding their Version folders.
- `moved-tag-republish` detects a tag pointing at a different commit than `sourceRevision` in its Version marker and republishes the Version folder on Reconcile or Release run.

## How to get to it (user POV)

- Run a Manual run (`workflow_dispatch`) to stamp legacy Version markers, write `.skipped-tags.json`, and verify reuse on a second Manual run.
- Move an existing release tag to a new commit (`git tag -f <tag> <new-sha> && git push -f origin <tag>`) and run a Manual run or open a PR to observe moved-tag detection and republication.
- Open a PR that touches `.github/docs_publisher.yaml` before and after Reconcile to observe the PR plan comment's skip folding and reuse.

## Driving it with sandbox.sh

Preconditions:

- `sandbox.sh launch --sha "$ACTION_SHA"` has completed and `RUN_ID` is set.
- `sandbox.sh doctor --run-id "$RUN_ID"` prints `doctor=ok`.
- `WORK_REPO="/tmp/verify-docs-publisher-work/$RUN_ID/features"` is checked out on `main`.

- **Write `.skipped-tags.json` and stamp legacy markers.** Trigger a first Manual run on `verify-<run-id>`. Run `TS1="$(date -u +%Y-%m-%dT%H:%M:%SZ)" && gh workflow run docs-publisher.yml -R pre-vieitesss/features --ref main` and `RUN1="$("$SANDBOX" wait-run --event workflow_dispatch --after "$TS1")"`. Capture with `"$SANDBOX" capture --run-id "$RUN_ID" --feature skipped-reconcile-1 --workflow-run-id "$WF_RUN_1" --docs-paths "site/raw/features/.skipped-tags.json,site/raw/features/hello-world/1.0.78873/.meta.json"`. Confirm `site/raw/features/.skipped-tags.json` exists with `"source": "pre-vieitesss/features"` and `tags` entries, and `site/raw/features/hello-world/1.0.78873/.meta.json` now includes `sourceRevision`.
- **Verify skip reuse on second Reconcile.** Trigger a second Manual run immediately. Run `TS2="$(date -u +%Y-%m-%dT%H:%M:%SZ)" && gh workflow run docs-publisher.yml -R pre-vieitesss/features --ref main` and `RUN2="$("$SANDBOX" wait-run --event workflow_dispatch --after "$TS2")"`. Capture with `--feature skipped-reconcile-2 --docs-paths "site/raw/features/.skipped-tags.json"`. Confirm `run.log` shows `previously skipped` and `docs-changed: false`, and `docs-commits.json` has no new commit.
- **Create a disposable release tag, publish it, then move it.** Publish a synthetic tag `hello-world-v99.1.0` at `main`, then create a commit on `main` (with `verify-$RUN_ID` in its message) that edits `packages/hello-world/schema.json` or `packages/hello-world/CHANGELOG.md`, force-move `hello-world-v99.1.0` to that new commit (`git -C "$WORK_REPO" tag -f hello-world-v99.1.0 HEAD && git -C "$WORK_REPO" push -f origin refs/tags/hello-world-v99.1.0`), and trigger a Manual run. Capture with `--feature moved-tag-reconcile --docs-paths "site/raw/features/hello-world/99.1.0/.meta.json,site/raw/features/hello-world/99.1.0/CHANGELOG.md"`. Confirm `run.log` reports `Republished` with `its tag points at a different commit.` and `sourceRevision` in `.meta.json` equals the new commit SHA.
- **Clean up synthetic semver tag.** Delete `hello-world-v99.1.0` (`gh release delete "hello-world-v99.1.0" -R pre-vieitesss/features --yes --cleanup-tag` or `gh api -X DELETE repos/pre-vieitesss/features/git/refs/tags/hello-world-v99.1.0`) before running `sandbox.sh cleanup`.

## Gotchas

- Never move a real historical tag in `pre-vieitesss/features`. Create a disposable synthetic tag (such as `hello-world-v99.1.0`), move only that tag, and delete it before cleanup.
- Plan mode never writes `.skipped-tags.json`. If you open a PR against a Docs branch that does not yet have `.skipped-tags.json`, Plan mode evaluates every historical tag fresh and folds more than 10 skips into `<details><summary>Skipped <N> tags</summary>`. After Reconcile writes `.skipped-tags.json`, the next PR plan reports `- <N> previously skipped tags unchanged.` instead.
- If a tag moves to a commit whose content fails to collect during Reconcile, the existing Version folder is kept while `.skipped-tags.json` records the skip at the new `sourceRevision`.
