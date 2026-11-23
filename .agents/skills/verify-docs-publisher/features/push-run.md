# Push run

Push run triggers on a push to `source-branch` (`main`), refreshes only changed `areaFiles`, Mirror Areas, or Branch Version folders without touching Version folders, and escalates to a Reconcile when `.github/docs_publisher.yaml` changes.

## Sub-features

- `push-area-file` updates a changed `areaFiles` file (such as `README.md`) in `push` mode and leaves Version folders untouched.
- `push-noop` reports `run-mode: push` and `docs-changed: false` when a push touches no published file and does not change `.github/docs_publisher.yaml`.
- `push-escalate-reconcile` reports `run-mode: reconcile` when a push edits `.github/docs_publisher.yaml`.

## How to get to it (user POV)

- Push a commit or merge a pull request into `main` in the Source repo.

## Driving it with sandbox.sh

Preconditions:

- `sandbox.sh launch --sha "$ACTION_SHA"` has completed and `RUN_ID` is set.
- `sandbox.sh doctor --run-id "$RUN_ID"` prints `doctor=ok`.
- `WORK_REPO="/tmp/verify-docs-publisher-work/$RUN_ID/features"` is checked out on `main`.

- **Push an `areaFiles` edit.** Append a line to `README.md` (which `.github/docs_publisher.yaml` lists under `areaFiles`), commit with `verify-$RUN_ID` in the message, and push. Run `printf '\n<!-- verify-%s -->\n' "$RUN_ID" >> "$WORK_REPO/README.md" && git -C "$WORK_REPO" commit -am "docs(verify): touch README for verify-$RUN_ID" && SHA1="$(git -C "$WORK_REPO" rev-parse HEAD)" && git -C "$WORK_REPO" push origin main` and `RUN1="$("$SANDBOX" wait-run --event push --head-sha "$SHA1")"`. The run concludes `success`.
- **Verify `push` output and file.** Extract `WF_RUN_1` from `RUN1` and run `"$SANDBOX" capture --run-id "$RUN_ID" --feature push-area-file --workflow-run-id "$WF_RUN_1" --docs-paths "site/raw/features/README.md"`. The `run.log` reports `run-mode: push` and `docs-changed: true`, and `docs-files/site/raw/features/README.md` contains `<!-- verify-<run-id> -->`.
- **Push an unrelated file.** Edit a file outside `README.md` and `.github/docs_publisher.yaml` (for example, `.gitignore` or a comment in `.github/workflows/docs-publisher.yml`), commit with `verify-$RUN_ID`, and push. Wait with `wait-run --event push --head-sha "$SHA2"` and capture with `--feature push-noop`. The `run.log` reports `run-mode: push` and `docs-changed: false`.
- **Push an entries-file change.** Append a harmless YAML comment to `.github/docs_publisher.yaml`, commit with `verify-$RUN_ID`, and push. Run `printf '\n# verify-%s\n' "$RUN_ID" >> "$WORK_REPO/.github/docs_publisher.yaml" && git -C "$WORK_REPO" commit -am "chore(verify): touch entries for verify-$RUN_ID" && SHA3="$(git -C "$WORK_REPO" rev-parse HEAD)" && git -C "$WORK_REPO" push origin main` and `RUN3="$("$SANDBOX" wait-run --event push --head-sha "$SHA3")"`. Capture with `--feature push-escalate-reconcile`. The `run.log` reports `run-mode: reconcile`.

## Gotchas

- Every temporary commit pushed to `pre-vieitesss/features` `main` must contain `verify-$RUN_ID` in its commit message so `sandbox.sh cleanup` resets `main` cleanly back to `ORIG_FEATURES_MAIN_SHA`.
- `pre-vieitesss/features` currently defines one Release Area (`features`) with `areaFiles: [{ from: README.md, to: README.md }]` and no Mirror Area. To verify Mirror Area push behavior, add a temporary Mirror entry in `.github/docs_publisher.yaml` on `main` (which first runs Reconcile), then push a change to that mirror's source folder.
