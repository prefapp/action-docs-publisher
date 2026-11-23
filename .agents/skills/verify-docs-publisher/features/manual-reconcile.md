# Manual reconcile

Manual reconcile runs `action-docs-publisher` on demand via `workflow_dispatch` so the Docs repo branch matches `.github/docs_publisher.yaml` and the Source repo's tags, repairs drift, and makes no changes when the Docs repo already matches.

## Sub-features

- `reconcile-dispatch` triggers a Manual run from `workflow_dispatch` and reports `run-mode: reconcile`.
- `reconcile-sync` brings the Docs repo branch in sync with `.github/docs_publisher.yaml`, stamping legacy Version markers with `sourceRevision` and recording skipped tags.
- `reconcile-idempotent` runs a second Manual run immediately after and reports `docs-changed: false` with no new commit on the Docs repo branch.

## How to get to it (user POV)

- Open Actions, select the `Docs publisher` workflow in the Source repo, and click `Run workflow` on `main`.
- Run `gh workflow run docs-publisher.yml -R pre-vieitesss/features --ref main` from the terminal.

## Driving it with sandbox.sh

Preconditions:

- `sandbox.sh launch --sha "$ACTION_SHA"` has completed and `RUN_ID` is set.
- `sandbox.sh doctor --run-id "$RUN_ID"` prints `doctor=ok`.

- **Trigger first reconcile.** Dispatch the workflow on `main`. Run `TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)" && gh workflow run docs-publisher.yml -R pre-vieitesss/features --ref main` and `RUN1="$("$SANDBOX" wait-run --event workflow_dispatch --after "$TS")"`. The run concludes `success` with `event: workflow_dispatch`.
- **Inspect first run outputs.** Extract `WF_RUN_1="$(printf '%s' "$RUN1" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).databaseId)')"`, then capture evidence with `"$SANDBOX" capture --run-id "$RUN_ID" --feature manual-reconcile-1 --workflow-run-id "$WF_RUN_1" --docs-paths "site/raw/features/hello-world/1.0.78873/.meta.json,site/raw/features/.skipped-tags.json,site/raw/features/index.json"`. The `run.log` shows `run-mode` is `reconcile`, and `site/raw/features/hello-world/1.0.78873/.meta.json` contains a 40-character `sourceRevision` field.
- **Trigger second reconcile (idempotency).** Dispatch the workflow again without changing either repo. Run `TS2="$(date -u +%Y-%m-%dT%H:%M:%SZ)" && gh workflow run docs-publisher.yml -R pre-vieitesss/features --ref main` and `RUN2="$("$SANDBOX" wait-run --event workflow_dispatch --after "$TS2")"`. The run concludes `success`.
- **Confirm no-op.** Extract `WF_RUN_2` from `RUN2` and run `"$SANDBOX" capture --run-id "$RUN_ID" --feature manual-reconcile-2 --workflow-run-id "$WF_RUN_2" --docs-paths "site/raw/features/hello-world/1.0.78873/.meta.json,site/raw/features/.skipped-tags.json"`. The `run.log` reports `docs-changed` as `false` (no commit pushed), and the top SHA in `docs-commits.json` matches the top SHA from `manual-reconcile-1`.

## Gotchas

- `gh workflow run` returns before GitHub creates the run record. Record `TS` before dispatching and use `sandbox.sh wait-run --after "$TS"`.
- On a fresh `verify-<run-id>` branch cut from `docs-e2e` `main`, the first reconcile with a post-#7 build writes `sourceRevision` into legacy `.meta.json` files and writes `.skipped-tags.json` if historical tags are skipped. Expect `docs-changed: true` on the first run and `docs-changed: false` on the second.
- If `docs-e2e` `main` already has `sourceRevision` and `.skipped-tags.json`, the first reconcile reports `docs-changed: false`; delete one published Version folder on `verify-<run-id>` first if you need to observe a write.
