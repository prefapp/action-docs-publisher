# PR plan comment

PR plan comment runs `action-docs-publisher` in Plan mode when a pull request targeting `main` changes `.github/docs_publisher.yaml` or a release package folder, posts or updates a single sticky comment describing what merging would do, and never writes to the Docs repo.

## Sub-features

- `plan-create` posts one sticky comment marked with `<!-- docs-publisher-plan -->` when a PR touches `.github/docs_publisher.yaml` or `packages/`.
- `plan-readonly` leaves `verify-<run-id>` on `pre-vieitesss/docs-e2e` with zero new commits and reports `run-mode: plan` and `docs-changed: false`.
- `plan-update` edits the existing sticky comment in place on a second push rather than posting a duplicate comment.
- `plan-irrelevant` replaces the sticky comment body with `This pull request no longer changes docs publishing.` when the docs-related change is reverted.

## How to get to it (user POV)

- Open a pull request against `main` in the Source repo that edits `.github/docs_publisher.yaml` or files under `packages/`.
- Push follow-up commits to that pull request branch.

## Driving it with sandbox.sh

Preconditions:

- `sandbox.sh launch --sha "$ACTION_SHA"` has completed and `RUN_ID` is set.
- `sandbox.sh doctor --run-id "$RUN_ID"` prints `doctor=ok`.
- `WORK_REPO="/tmp/verify-docs-publisher-work/$RUN_ID/features"` is up to date with `origin/main`.
- Record the Docs branch head before opening the PR: `BEFORE_DOCS_SHA="$(gh api "repos/pre-vieitesss/docs-e2e/git/ref/heads/verify-$RUN_ID" --jq '.object.sha')"`.

- **Open a relevant PR.** Create branch `verify-$RUN_ID-plan`, add a comment line to `.github/docs_publisher.yaml`, push, and open a PR. Run `git -C "$WORK_REPO" checkout -b "verify-$RUN_ID-plan" main && printf '\n# plan verify-%s\n' "$RUN_ID" >> "$WORK_REPO/.github/docs_publisher.yaml" && git -C "$WORK_REPO" commit -am "chore(verify): plan test verify-$RUN_ID" && SHA1="$(git -C "$WORK_REPO" rev-parse HEAD)" && git -C "$WORK_REPO" push -u origin "verify-$RUN_ID-plan" && PR_URL="$(gh pr create -R pre-vieitesss/features --base main --head "verify-$RUN_ID-plan" --title "chore(verify): plan test $RUN_ID" --body "verify-$RUN_ID")" && PR_NUM="${PR_URL##*/}"`. Wait with `RUN1="$("$SANDBOX" wait-run --event pull_request --head-sha "$SHA1")"`. The run concludes `success`.
- **Verify sticky comment and read-only Docs branch.** Extract `WF_RUN_1` from `RUN1` and run `"$SANDBOX" capture --run-id "$RUN_ID" --feature pr-plan-open --workflow-run-id "$WF_RUN_1" --pr "$PR_NUM"`. Confirm `run.log` prints `Plan comment created.` and `docs-changed: false`, `pr-comments.json` has exactly one comment containing `<!-- docs-publisher-plan -->`, and `gh api "repos/pre-vieitesss/docs-e2e/git/ref/heads/verify-$RUN_ID" --jq '.object.sha'` still equals `BEFORE_DOCS_SHA`.
- **Revert the docs change on the same PR.** Revert `.github/docs_publisher.yaml` and edit an unrelated file instead (for example, append a comment to `.gitignore`). Run `git -C "$WORK_REPO" checkout main -- .github/docs_publisher.yaml && printf '\n# verify-%s\n' "$RUN_ID" >> "$WORK_REPO/.gitignore" && git -C "$WORK_REPO" commit -am "chore(verify): revert docs change verify-$RUN_ID" && SHA2="$(git -C "$WORK_REPO" rev-parse HEAD)" && git -C "$WORK_REPO" push origin "verify-$RUN_ID-plan"` and `RUN2="$("$SANDBOX" wait-run --event pull_request --head-sha "$SHA2")"`. Capture with `--feature pr-plan-irrelevant --pr "$PR_NUM"`. Confirm `run.log` prints `Plan comment updated.` and `pr-comments.json` still has one comment whose body contains `This pull request no longer changes docs publishing.`.
- **Return local clone to `main`.** Run `git -C "$WORK_REPO" checkout main`.

## Gotchas

- Cut the PR branch from `main` after `sandbox.sh launch`, not before. GitHub executes `.github/workflows/docs-publisher.yml` from the PR head commit, so cutting after `launch` ensures the PR runs the pinned `ACTION_SHA` and `verify-<run-id>` branch.
- Pushing rapidly to a PR cancels the previous in-progress plan run (`cancel-in-progress: true`). Wait for the first run to complete before pushing the second commit.
- `sandbox.sh cleanup` closes any open PR whose head branch starts with `verify-<run-id>-` and deletes the branch.
