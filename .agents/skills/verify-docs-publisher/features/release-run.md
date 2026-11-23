# Release run

Release run triggers when a GitHub Release is published in the Source repo, writes the matching Version folder and Version marker into the Docs repo, rebuilds Shared files, and skips tags that do not match any Release Area.

## Sub-features

- `release-publish` publishes a matching package release tag (`<pkg>-v<semver>`) into `<area>/<pkg>/<semver>/` with `.meta.json` and updates `versions.json`, `index.json`, and the Latest copy.
- `release-skip-prerelease` skips a prerelease tag when the entry sets `prereleases: false` and writes nothing to the Docs repo.
- `release-skip-unmatched` runs in `skipped` mode for a tag that is not a release tag and reads nothing from the Docs repo.

## How to get to it (user POV)

- Publish a GitHub Release in the Source repo UI (`Releases`, `Draft a new release`, `Publish release`).
- Run `gh release create <tag> -R pre-vieitesss/features --target main` from the terminal.

## Driving it with sandbox.sh

Preconditions:

- `sandbox.sh launch --sha "$ACTION_SHA"` has completed and `RUN_ID` is set.
- `sandbox.sh doctor --run-id "$RUN_ID"` prints `doctor=ok`.
- Pick a synthetic version higher than existing `hello-world` versions (check `site/raw/features/hello-world/versions.json`), such as `hello-world-v99.0.1` for a stable release and `hello-world-v99.0.2-rc.1` for a prerelease.

- **Publish a stable release.** Create a release for `hello-world`. Run `TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)" && gh release create "hello-world-v99.0.1" -R pre-vieitesss/features --target main --title "hello-world-v99.0.1" --notes "verify-$RUN_ID"` and `RUN1="$("$SANDBOX" wait-run --event release --after "$TS")"`. The run concludes `success`. When the tag already exists (a moved or re-run tag), omit `--target`: `gh release create <tag> -R pre-vieitesss/features --notes "verify-$RUN_ID"` attaches the Release to the existing ref instead of trying to move it.
- **Verify Version folder and Shared files.** Extract `WF_RUN_1` from `RUN1` and run `"$SANDBOX" capture --run-id "$RUN_ID" --feature release-publish --workflow-run-id "$WF_RUN_1" --docs-paths "site/raw/features/hello-world/99.0.1/.meta.json,site/raw/features/hello-world/versions.json,site/raw/features/index.json"`. The `run.log` shows `run-mode: release`, `docs-changed: true`, and `Published \`hello-world-v99.0.1\` to \`verify-<run-id>\` under \`site/raw/features/hello-world/99.0.1\``. The `.meta.json` contains `source`, `tag`, `sourceRevision`, `date`, and `specHash`, and `versions.json` lists `99.0.1` first.
- **Publish a prerelease tag.** Create a prerelease for `hello-world` while `prereleases: false`. Run `TS2="$(date -u +%Y-%m-%dT%H:%M:%SZ)" && gh release create "hello-world-v99.0.2-rc.1" -R pre-vieitesss/features --target main --prerelease --title "hello-world-v99.0.2-rc.1" --notes "verify-$RUN_ID"` and `RUN2="$("$SANDBOX" wait-run --event release --after "$TS2")"`. Capture with `--feature release-prerelease`. The `run.log` reports `docs-changed: false` and `Skipped \`hello-world-v99.0.2-rc.1\`: a prerelease is published only by an entry with \`prereleases: true\``.
- **Publish a non-release tag.** Create a release with a non-semver tag. Run `TS3="$(date -u +%Y-%m-%dT%H:%M:%SZ)" && gh release create "not-a-release-verify-$RUN_ID" -R pre-vieitesss/features --target main --title "not-a-release" --notes "verify-$RUN_ID"` and `RUN3="$("$SANDBOX" wait-run --event release --after "$TS3")"`. Capture with `--feature release-skipped`. The `run.log` reports `run-mode: skipped`, `docs-changed: false`, and no new commit in `docs-commits.json`.
- **Clean up semver test releases.** Delete the semver tags before session cleanup: `gh release delete "hello-world-v99.0.1" -R pre-vieitesss/features --yes --cleanup-tag && gh release delete "hello-world-v99.0.2-rc.1" -R pre-vieitesss/features --yes --cleanup-tag`.

## Gotchas

- `sandbox.sh cleanup` automatically removes tags containing `verify-<run-id>`, not plain semver tags like `hello-world-v99.0.1`. Always delete semver test releases manually before calling `cleanup`.
- GitHub only fires `on: release: types: [published]` when a Release object is created, not on a plain `git push --tags`.
- A `release` run checks out `main` (per the workflow `ref:`), reads `.github/docs_publisher.yaml` from `main`, and reads package contents from the tagged commit.
