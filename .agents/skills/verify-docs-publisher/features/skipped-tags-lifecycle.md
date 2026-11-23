# Skipped tags lifecycle

Skipped tags lifecycle (#7) covers what happens to a tag after a Reconcile records it in an Area's `.skipped-tags.json`: a Release run publishes a previously skipped tag and clears its record in the same Docs commit, a tag moved onto content that no longer collects keeps the published Version folder and records the skip at the new commit, a Release run for a skipped tag writes nothing, a deleted tag is dropped by the next Reconcile, a corrupted file fails the run with the documented diagnostic, and an Area that holds only `.skipped-tags.json` is written with its `source` and pruned with its entry.

## Sub-features

- `skipped-release-clears` publishes a tag that Reconcile skipped (for example `retired`) from a Release run and removes its `.skipped-tags.json` record in the same commit.
- `skipped-moved-tag-content` keeps the existing Version folder byte-identical and records the skip at the tag's new `sourceRevision` when a published tag moves onto content that does not fit the entry.
- `skipped-moved-tag-release` fails a Release run for that moved tag instead of publishing it.
- `skipped-release-noop` skips a prerelease tag on a Release run with `docs-changed: false` and no Docs commit.
- `skipped-tag-dropped` drops the record of a tag whose ref was deleted on the next Reconcile.
- `skipped-file-corrupt` fails the run with `invalid .skipped-tags.json: <path>` when the file cannot be parsed, and runs clean again once the file is restored.
- `skipped-only-area` writes an Area that holds only `.skipped-tags.json` with its owning `source`, and prunes that Area when its entry is removed from `.github/docs_publisher.yaml`.

## How to get to it (user POV)

- Publish a GitHub Release for a tag that a previous Reconcile listed as skipped.
- Move a released tag onto a commit whose package content changed or no longer collects.
- Delete a Release and its tag in the Source repo, then run a Manual run.
- Edit `.skipped-tags.json` in the Docs repo (by hand or by a broken external writer).
- Add and then remove a Release Area entry in the Source repo's `.github/docs_publisher.yaml`.

## Driving it with sandbox.sh

Preconditions:

- `sandbox.sh launch --sha "$ACTION_SHA"` has completed, `RUN_ID` is set, and `sandbox.sh doctor --run-id "$RUN_ID"` prints `doctor=ok`.
- `SANDBOX=".agents/skills/verify-docs-publisher/scripts/sandbox.sh"` and `WORK_REPO="/tmp/verify-docs-publisher-work/$RUN_ID/features"` are set, and `WORK_REPO` is checked out on `main`.
- The first Manual run of the session has already written `site/raw/features/.skipped-tags.json` (see [skipped-and-moved-tags.md](./skipped-and-moved-tags.md)).
- Before each run whose commit you want to diff, save `PREV_DOCS_SHA="$(gh api "repos/pre-vieitesss/docs-e2e/git/ref/heads/verify-$RUN_ID" --jq '.object.sha')"` and pass `--compare "$PREV_DOCS_SHA"` to `capture`; `docs-compare.json` then lists that commit's `filename` and `status` pairs only.

- **Publish a previously skipped `retired` tag from a Release run.** Create a disposable package, cut a tag at the commit that still has it, then retire the package from `main` so the next Reconcile can only skip that tag:

  ```bash
  git -C "$WORK_REPO" checkout -q -b "verify-$RUN_ID-retired" main
  mkdir -p "$WORK_REPO/packages/verifypkg/templates/docs"
  printf '{"title":"verifypkg"}\n' > "$WORK_REPO/packages/verifypkg/schema.json"
  printf '# verifypkg changelog\n' > "$WORK_REPO/packages/verifypkg/CHANGELOG.md"
  printf '# verifypkg\n' > "$WORK_REPO/packages/verifypkg/templates/docs/README.md"
  git -C "$WORK_REPO" add packages/verifypkg
  git -C "$WORK_REPO" commit -qm "feat(verify): add disposable package verifypkg verify-$RUN_ID"
  A="$(git -C "$WORK_REPO" rev-parse HEAD)"
  git -C "$WORK_REPO" push -q origin main
  gh api -X POST "repos/pre-vieitesss/features/git/refs" -f ref=refs/tags/verifypkg-v0.0.1 -f sha="$A"
  git -C "$WORK_REPO" rm -rq packages/verifypkg
  git -C "$WORK_REPO" commit -qm "feat(verify): retire the disposable package verifypkg verify-$RUN_ID"
  git -C "$WORK_REPO" push -q origin main
  ```

  Trigger a Manual run (`TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)" && gh workflow run docs-publisher.yml -R pre-vieitesss/features --ref main`, then `RUN="$("$SANDBOX" wait-run --event workflow_dispatch --after "$TS")"`) and capture with `--feature skipped-retired-recorded --docs-paths "site/raw/features/.skipped-tags.json"`. The record reads `"verifypkg-v0.0.1": {"sourceRevision":"<A>","reason":"retired",…}`. Then save `PREV_DOCS_SHA`, publish the Release, and wait for the Release run:

  ```bash
  PREV_DOCS_SHA="$(gh api "repos/pre-vieitesss/docs-e2e/git/ref/heads/verify-$RUN_ID" --jq '.object.sha')"
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)" && gh release create verifypkg-v0.0.1 -R pre-vieitesss/features --notes "verify-$RUN_ID"
  RUN="$("$SANDBOX" wait-run --event release --after "$TS")"
  ```

  Capture with `--feature skipped-release-clears --compare "$PREV_DOCS_SHA" --docs-paths "site/raw/features/.skipped-tags.json,site/raw/features/verifypkg/0.0.1/.meta.json"`. Confirm `run.log` reports `run-mode: release`, `docs-changed: true`, and ``Published `verifypkg-v0.0.1` to `verify-<run-id>` under `site/raw/features/verifypkg/0.0.1`.``, and that `docs-compare.json` puts `modified site/raw/features/.skipped-tags.json` in the same commit as the added `site/raw/features/verifypkg/0.0.1/*` files. The published record is gone from `.skipped-tags.json`, and `.meta.json` carries `sourceRevision: <A>`, `tag`, and `specHash`. Delete the disposable release before `cleanup`: `gh release delete verifypkg-v0.0.1 -R pre-vieitesss/features --yes --cleanup-tag`.
- **Move a published tag onto content that fails, and keep the Version folder.** Publish a disposable tag with a Manual run first: `gh api -X POST "repos/pre-vieitesss/features/git/refs" -f ref=refs/tags/hello-world-v99.4.0 -f sha="$(git -C "$WORK_REPO" rev-parse main)"`, one Manual run, and capture with `--feature skipped-moved-tag-published --docs-paths "site/raw/features/hello-world/99.4.0/.meta.json"`. Then snapshot the folder, commit a content failure, and force-move the tag onto it:

  ```bash
  gh api "repos/pre-vieitesss/docs-e2e/contents/site/raw/features/hello-world/99.4.0?ref=verify-$RUN_ID" --jq '[.[]|{name,sha,size}]' > /tmp/version-before.json
  PREV_DOCS_SHA="$(gh api "repos/pre-vieitesss/docs-e2e/git/ref/heads/verify-$RUN_ID" --jq '.object.sha')"
  git -C "$WORK_REPO" rm -q packages/hello-world/CHANGELOG.md
  git -C "$WORK_REPO" commit -qm "test(verify): drop hello-world CHANGELOG verify-$RUN_ID"
  git -C "$WORK_REPO" push -q origin main
  FAIL_SHA="$(git -C "$WORK_REPO" rev-parse HEAD)"
  gh api -X PATCH "repos/pre-vieitesss/features/git/refs/tags/hello-world-v99.4.0" -f sha="$FAIL_SHA" -F force=true
  gh api "repos/pre-vieitesss/features/commits/hello-world-v99.4.0" --jq '.sha'
  ```

  Trigger a Manual run and capture with `--feature skipped-moved-tag-content --compare "$PREV_DOCS_SHA" --docs-paths "site/raw/features/.skipped-tags.json,site/raw/features/hello-world/99.4.0/.meta.json"`. Confirm `run.log` reports ``Skipped `hello-world-v99.4.0`: its content does not fit the entry (not found: CHANGELOG.md).``, `docs-compare.json` lists only `modified site/raw/features/.skipped-tags.json`, and the record's `sourceRevision` equals `FAIL_SHA` with `reason` `content`. Re-snapshot the folder and diff it against the snapshot from before the run:

  ```bash
  gh api "repos/pre-vieitesss/docs-e2e/contents/site/raw/features/hello-world/99.4.0?ref=verify-$RUN_ID" --jq '[.[]|{name,sha,size}]' > /tmp/version-after.json
  diff /tmp/version-before.json /tmp/version-after.json
  ```

  No output means every blob SHA and size is unchanged.
- **A Release run for the same moved tag fails.** `TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)" && gh release create hello-world-v99.4.0 -R pre-vieitesss/features --notes "verify-$RUN_ID"` and `RUN="$("$SANDBOX" wait-run --event release --after "$TS" --allow-failure)"`. Capture with `--feature skipped-moved-tag-release` and confirm `"conclusion":"failure"`, failing step `Publish docs`, and log `docs_publisher: not found: CHANGELOG.md`; the `docs-commits.json` head is unchanged, so the failed run committed nothing. Delete the release before `cleanup`.
- **A skipped Release run is a no-op.** Cut a bare prerelease tag at `main`'s tip and publish a Release for it with `prereleases: false`: `gh api -X POST "repos/pre-vieitesss/features/git/refs" -f ref=refs/tags/hello-world-v99.5.0-rc.1 -f sha="$(git -C "$WORK_REPO" rev-parse main)"`, `TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)" && gh release create hello-world-v99.5.0-rc.1 -R pre-vieitesss/features --prerelease --notes "verify-$RUN_ID"`, `RUN="$("$SANDBOX" wait-run --event release --after "$TS")"`. Capture with `--feature skipped-release-noop` and confirm `run-mode: release`, ``Skipped `hello-world-v99.5.0-rc.1`: a prerelease is published only by an entry with `prereleases: true`.``, `DOCS_CHANGED: false`, an empty `DOCS_COMMIT_SHA:`, and an unchanged `docs-commits.json` head.
- **A deleted tag is dropped from `.skipped-tags.json`.** Delete the Release and its tag, confirm the ref is gone, then compare the recorded tag set across one Manual run:

  ```bash
  gh release delete hello-world-v99.5.0-rc.1 -R pre-vieitesss/features --yes --cleanup-tag
  gh api "repos/pre-vieitesss/features/git/matching-refs/tags/hello-world-v99.5" --jq '[.[].ref]'
  gh api "repos/pre-vieitesss/docs-e2e/contents/site/raw/features/.skipped-tags.json?ref=verify-$RUN_ID" --jq '.content' | base64 -d > /tmp/skips-before.json
  node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tags).sort().join("\n"))' /tmp/skips-before.json > /tmp/skips-before.txt
  ```

  Trigger a Manual run, then fetch the file again into `/tmp/skips-after.json`, render `/tmp/skips-after.txt` with the same `node` one-liner, and `diff /tmp/skips-before.txt /tmp/skips-after.txt`. Confirm `hello-world-v99.5.0-rc.1` appears only as a removed (`<`) line. A line added (`>`) by a `retired` follow-on from an earlier recipe is expected; nothing else may change.
- **Corrupt `.skipped-tags.json` and restore it.** Save the bytes and the blob SHA, then write an unparsable file with the contents API:

  ```bash
  SKIPPED="site/raw/features/.skipped-tags.json"
  gh api "repos/pre-vieitesss/docs-e2e/contents/${SKIPPED}?ref=verify-$RUN_ID" --jq '.content' | base64 -d > /tmp/skips-orig.json
  CUR="$(gh api "repos/pre-vieitesss/docs-e2e/contents/${SKIPPED}?ref=verify-$RUN_ID" --jq '.sha')"
  BAD='{"source": "pre-vieitesss/features", "tags": {'
  gh api -X PUT "repos/pre-vieitesss/docs-e2e/contents/${SKIPPED}" \
    -f message="chore(verify): corrupt .skipped-tags.json verify-$RUN_ID" \
    -f content="$(printf '%s' "$BAD" | base64 | tr -d '\n')" \
    -f sha="$CUR" -f branch="verify-$RUN_ID"
  ```

  Run a Manual run with `--allow-failure` (`RUN="$("$SANDBOX" wait-run --event workflow_dispatch --after "$TS" --allow-failure)"`) and capture with `--feature skipped-file-corrupt`. Confirm the run concluded `failure` and the `Publish docs` step printed exactly `docs_publisher: invalid .skipped-tags.json: site/raw/features/.skipped-tags.json` with no new Docs commit. Restore the saved bytes the same way (re-read `CUR` for the corrupted blob), run a Manual run, and confirm `run-mode: reconcile`, `DOCS_CHANGED: false`, and log `Nothing to reconcile`.
- **An Area that holds only `.skipped-tags.json` is owned and pruned.** Add a packageless entry (no `packages:`, so only unnamed `v<semver>` tags match it) plus two disposable unnamed tags at `main`'s tip:

  ```bash
  gh api -X POST "repos/pre-vieitesss/features/git/refs" -f ref=refs/tags/v99.9.1 -f sha="$(git -C "$WORK_REPO" rev-parse main)"
  gh api -X POST "repos/pre-vieitesss/features/git/refs" -f ref=refs/tags/v99.9.2 -f sha="$(git -C "$WORK_REPO" rev-parse main)"
  git -C "$WORK_REPO" checkout -q main
  printf -- '- area: verify-area\n  mode: release\n  collect:\n    - { from: "verify-docs/*.md", to: . }\n' >> "$WORK_REPO/.github/docs_publisher.yaml"
  git -C "$WORK_REPO" commit -qam "chore(verify): add verify-area entry verify-$RUN_ID"
  SHA="$(git -C "$WORK_REPO" rev-parse HEAD)"
  git -C "$WORK_REPO" push -q origin main
  RUN="$("$SANDBOX" wait-run --event push --head-sha "$SHA")"
  ```

  A push that changes the entries file escalates, so `run.log` reports `run-mode: reconcile`. Confirm `gh api "repos/pre-vieitesss/docs-e2e/contents/site/raw/verify-area?ref=verify-$RUN_ID" --jq '[.[]|{name,type}]'` returns exactly one file, `.skipped-tags.json`, and that it carries `"source": "pre-vieitesss/features"` plus a record per tag with `"detail":"collect matched no files"` (capture with `--docs-paths "site/raw/verify-area/.skipped-tags.json"`). Then remove the entry and run again:

  ```bash
  git -C "$WORK_REPO" checkout "$SHA"~1 -- .github/docs_publisher.yaml
  git -C "$WORK_REPO" commit -qm "chore(verify): remove verify-area entry verify-$RUN_ID"
  SHA2="$(git -C "$WORK_REPO" rev-parse HEAD)"
  git -C "$WORK_REPO" push -q origin main
  RUN="$("$SANDBOX" wait-run --event push --head-sha "$SHA2")"
  gh api "repos/pre-vieitesss/docs-e2e/contents/site/raw/verify-area?ref=verify-$RUN_ID" >/dev/null 2>&1; echo "PRUNED_EXIT=$?"
  ```

  Confirm `run.log` reports ``Pruned `site/raw/verify-area`: its entry is gone from docs_publisher.yaml.`` and `PRUNED_EXIT=1` (the contents API returns 404). Delete the `v99.9.1` and `v99.9.2` tags before `cleanup`.

## Gotchas

- `sandbox.sh wait-run` exits non-zero on a non-success conclusion. Every run that is supposed to fail (the moved-tag Release run, the corrupted-file Manual run) needs `--allow-failure`.
- `gh release create` for a tag that already exists must not pass `--target`; `--target` tries to move the tag and fails. Attach the Release to the existing ref instead.
- A bare tag created with the refs API fires no workflow. Only `gh release create` fires `on: release`, which keeps setup quiet between Manual runs.
- A contents-API write to the Docs branch does not trigger a workflow run. The Manual run you trigger afterwards is what exercises the reader, so always trigger one after writing `.skipped-tags.json` by hand.
- After `skipped-release-clears` publishes `verifypkg-v0.0.1`, the next Reconcile re-records it as `retired` and prunes the just-published folder, because the package folder is still gone from `main`. That is the documented `retired` rule; assert the same-commit clear first, then any later Reconcile is free to undo the publish.
- `sandbox.sh cleanup` only removes refs whose name contains `verify-<run-id>`. Delete every disposable release and tag whose name does not (`verifypkg-v0.0.1`, `hello-world-v99.4.0`, `hello-world-v99.5.0-rc.1`, `v99.9.1`, `v99.9.2`) before cleanup.
- Never move or delete a real historical tag in `pre-vieitesss/features`. Every tag in this file is disposable and synthetic.
