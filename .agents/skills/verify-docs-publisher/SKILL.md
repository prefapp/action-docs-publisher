---
name: verify-docs-publisher
description: Verify action-docs-publisher live in the pre-vieitesss GitHub sandbox against a pushed commit SHA. Use when proving a release run, push run, pull request plan comment, manual reconcile, or skipped and moved tag behavior before merge.
---

# Verify docs publisher

This skill drives `prefapp/action-docs-publisher` live in the `pre-vieitesss` GitHub organization. `pre-vieitesss/features` is the Source repo and `pre-vieitesss/docs-e2e` is the Docs repo.

Read [features/README.md](features/README.md) before driving a feature. Each feature file holds the exact trigger commands and observable proof for one user journey.

## Isolation rules

- **Docs branch.** Every verification run writes only to a disposable branch named `verify-<run-id>` on `pre-vieitesss/docs-e2e`, cut from `main`. Never write to `pre-vieitesss/docs-e2e` `main` or `gh-pages`.
- **Workflow pin.** `launch` records the original `main` SHA of `pre-vieitesss/features` and updates `.github/workflows/docs-publisher.yml` to pin `prefapp/action-docs-publisher@<full-40-char-sha>` and `docs-branch: verify-<run-id>`. `cleanup` restores `pre-vieitesss/features` `main` and deletes `verify-<run-id>`.
- **Single-driver lock.** `pre-vieitesss/features` has one `main` workflow file. `launch` refuses to start if `.github/workflows/docs-publisher.yml` already targets a `verify-*` branch or if any mutating `docs-publisher.yml` run (`push`, `release`, `workflow_dispatch`) is `queued`, `in_progress`, or `waiting`. Do not bypass this guard or run two sessions concurrently.
- **No Firestartr claim edits.** Pin the workflow directly on `pre-vieitesss/features` for the session. Do not edit Firestartr claims, repos, GitHub Apps, secrets, or variables.

## Launch

Prerequisites: `gh` authenticated with access to `pre-vieitesss`, SSH push access to `git@github.com:pre-vieitesss/features.git`, `git`, and `node`. The commit under test must already be pushed to `prefapp/action-docs-publisher`.

```bash
SANDBOX=".agents/skills/verify-docs-publisher/scripts/sandbox.sh"
ACTION_SHA="$(git rev-parse HEAD)"
"$SANDBOX" launch --sha "$ACTION_SHA"
```

`launch` does the following in order:

1. Verifies `ACTION_SHA` exists on `prefapp/action-docs-publisher`.
2. Checks the single-driver lock on `pre-vieitesss/features`.
3. Cuts `verify-<run-id>` from `pre-vieitesss/docs-e2e` `main`.
4. Pins `.github/workflows/docs-publisher.yml` on `pre-vieitesss/features` `main` to `ACTION_SHA` and `verify-<run-id>` in one commit.
5. Waits for the triggered `push` workflow run on that pin commit to conclude `success`.

Launch is ready when `launch` prints `RUN_ID`, `DOCS_BRANCH`, `EVIDENCE_DIR`, and a `PIN_RUN` JSON object with `"conclusion":"success"`. Save `RUN_ID` in your shell for the rest of the session.

## Doctor

Run this read-only check before driving a feature and whenever a run behaves unexpectedly:

```bash
"$SANDBOX" doctor --run-id "$RUN_ID"
```

`doctor` exits `0` and prints `doctor=ok` only when all five checks pass:

1. `gh auth status` succeeds.
2. `.github/workflows/docs-publisher.yml` on `pre-vieitesss/features` `main` pins `ACTION_SHA`.
3. `docs-branch` in that workflow equals `verify-<run-id>`.
4. `verify-<run-id>` exists on `pre-vieitesss/docs-e2e` and `pre-vieitesss/docs-e2e` `main` still points at `ORIG_DOCS_MAIN_SHA`.
5. No mutating `docs-publisher.yml` run (`push`, `release`, `workflow_dispatch`) is currently active on `pre-vieitesss/features`. Read-only `pull_request` runs (such as `release-please` PR syncs triggered by a `main` push) do not block the lock.

Run `"$SANDBOX" doctor` without `--run-id` to inspect the sandbox state before launching and after `cleanup`. Without `--run-id` it also prints `docs_verify_branches`, `features_verify_heads`, and `features_verify_tags`, and exits non-zero when any of them is non-empty, so a restored sandbox proves it holds no leftover `verify-*` branch or tag.

## Drive

Trigger GitHub events on `pre-vieitesss/features` using `gh` and `git` from the session clone at `/tmp/verify-docs-publisher-work/$RUN_ID/features`, then wait for each run with `sandbox.sh wait-run`:

- **Manual run (Reconcile):** `gh workflow run docs-publisher.yml -R pre-vieitesss/features --ref main`, then `"$SANDBOX" wait-run --event workflow_dispatch --after "$TS"`.
- **Push run:** commit a change on `main` whose commit message includes `verify-$RUN_ID`, push to `origin main`, then `"$SANDBOX" wait-run --event push --head-sha "$SHA"`.
- **Release run:** create a tag and release with `gh release create "<tag>" -R pre-vieitesss/features --target main --notes "verify-$RUN_ID"`, then `"$SANDBOX" wait-run --event release --after "$TS"`.
- **Plan mode (pull request):** push a branch named `verify-$RUN_ID-<topic>`, open a PR with `gh pr create -R pre-vieitesss/features --base main --head "verify-$RUN_ID-<topic>"`, then `"$SANDBOX" wait-run --event pull_request --head-sha "$SHA"`.

Follow the exact recipes in [features/](features/README.md):

- [Manual reconcile](features/manual-reconcile.md)
- [Release run](features/release-run.md)
- [Push run](features/push-run.md)
- [PR plan comment](features/pr-plan-comment.md)
- [Skipped and moved tags](features/skipped-and-moved-tags.md)
- [Skipped tags lifecycle](features/skipped-tags-lifecycle.md)

## Evidence

Store every proof under `/tmp/verify-docs-publisher-evidence/<run-id>/<feature>/` using `sandbox.sh capture`:

```bash
"$SANDBOX" capture \
  --run-id "$RUN_ID" \
  --feature manual-reconcile \
  --workflow-run-id "$WF_RUN_ID" \
  --docs-paths "site/raw/features/.skipped-tags.json,site/raw/features/hello-world/1.0.78873/.meta.json"
```

Pass `--pr <number>` when capturing a Plan mode run so `pr-comments.json` is saved. Pass `--compare <base-sha>` when the proof is a commit's changed-file list, such as a Version folder that must stay untouched or a same-commit write; `docs-compare.json` then holds the `filename` and `status` of every file changed between `<base-sha>` and `verify-<run-id>`.

Proof standards:

- Exercise the real GitHub event path (`workflow_dispatch`, `push`, `release`, or `pull_request`) against the pinned `ACTION_SHA`.
- Capture both the action execution (`run.json`, `run.log`) and the resulting Docs repo state (`docs-commits.json`, fetched `docs-files/`).
- Verify side effects directly on `pre-vieitesss/docs-e2e` at `verify-<run-id>` (commits, `.meta.json`, `.skipped-tags.json`, shared files) and on PR comments for Plan mode.
- For Plan mode and Skipped runs, verify that `docs-commits.json` on `verify-<run-id>` did not gain a new commit.

## Cleanup

Run cleanup after every verification session, including failed attempts:

```bash
"$SANDBOX" cleanup --run-id "$RUN_ID"
```

`cleanup` does the following:

1. Closes any open PRs on `pre-vieitesss/features` whose branch starts with `verify-<run-id>-` and deletes those branches.
2. Deletes any releases and tags containing `verify-<run-id>` or `verify.<run-id>`.
3. Restores `pre-vieitesss/features` `main` to `ORIG_FEATURES_MAIN_SHA` (or restores `.github/workflows/docs-publisher.yml` by commit if an unrelated commit landed on `main`) and waits for the restore push run to finish.
4. Deletes `verify-<run-id>` on `pre-vieitesss/docs-e2e`.
5. Verifies `pre-vieitesss/docs-e2e` `main` still equals `ORIG_DOCS_MAIN_SHA`.
6. Removes `/tmp/verify-docs-publisher-work/<run-id>/` and confirms `/tmp/verify-docs-publisher-evidence/<run-id>/` still exists.

If you created a release tag that does not contain `verify-<run-id>` (for example, a semver test tag such as `hello-world-v0.0.1`), delete that release and tag before calling `cleanup`:

```bash
gh release delete "<tag>" -R pre-vieitesss/features --yes --cleanup-tag
```

## Helpers

The skill ships one executable script: [scripts/sandbox.sh](scripts/sandbox.sh).

| Command | Purpose |
| --- | --- |
| `sandbox.sh launch --sha <40-char-sha> [--run-id <id>]` | Cut `verify-<run-id>` on `docs-e2e`, pin `features` workflow, wait for pin run. |
| `sandbox.sh doctor [--run-id <id>]` | Read-only check of auth, workflow pin, branch existence, `docs-e2e` `main` integrity, and active runs. |
| `sandbox.sh wait-run --event <event> [--head-sha <sha>] [--branch <branch>] [--after <iso-ts>] [--timeout <sec>] [--allow-failure]` | Wait for a matching `docs-publisher.yml` run to complete and print its JSON summary. `--timeout` defaults to 1800 s because a first Reconcile evaluates every tag. |
| `sandbox.sh capture --run-id <id> --feature <slug> --workflow-run-id <gh-run-id> [--pr <num>] [--docs-paths <p1,p2>] [--compare <base-sha>]` | Save run metadata, logs, Docs repo commits, requested Docs repo files, an optional `docs-compare.json` changed-file list against a base commit, and optional PR comments into `/tmp/verify-docs-publisher-evidence/<run-id>/<feature>/`. |
| `sandbox.sh cleanup --run-id <id>` | Remove verification PRs, branches, tags, and `verify-<run-id>` on `docs-e2e`, restore `features` `main`, delete scratch workspace, and keep evidence. |
