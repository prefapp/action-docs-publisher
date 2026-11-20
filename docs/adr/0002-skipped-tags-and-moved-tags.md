# Track skipped tags per Area in the docs repo and republish moved tags

Repositories with many historical tags that cannot be published (retired packages, missing folders, unconfigured prereleases, or failed builds/collects) used to re-evaluate every skipped tag on every Reconcile and Plan mode run, and list all of them inline in pull request plan comments. We store a per-Release-Area `.skipped-tags.json` in the docs repo recording skipped tags and the state under which they were skipped, and we record each tag's target commit SHA (`sourceRevision`) in both Version markers and `.skipped-tags.json` so any tag moved to a new commit is re-checked and republished.

## Considered Options

- **Watermark ("reviewed until tag X") or ignore list in `.github/docs_publisher.yaml`** — rejected: watermarks break on multi-package repos, backports, and out-of-order tags, and a source-repo manifest would require manual upkeep or giving the action write access to the source repo.
- **GitHub Actions cache** — rejected: ephemeral and evicted after inactivity, making PR plans non-deterministic.
- **Keep published Version folders immutable when a tag moves** — rejected: moving a tag to fix broken or outdated documentation should update the published Version folder rather than keeping stale bytes.
- **Per-Area `.skipped-tags.json` in the docs repo plus `sourceRevision` on Version markers** — chosen: keeps all publisher state in the docs repo with zero source-repo setup, handles backports and multi-package layouts, and automatically invalidates skips or republishes versions when a tag moves or the entry spec changes.

## Consequences

- **Plan mode** stays strictly read-only: a newly skipped tag stops being re-checked after the next Reconcile writes `.skipped-tags.json`.
- `.skipped-tags.json` carries `source` so it participates in Area ownership checks and Prune even when a Release Area has only skipped tags and no Version folders; it is deleted when empty and fails the run if corrupted.
- Existing Version markers without `sourceRevision` are stamped in place on Reconcile without rebuilding, and republished if a Release run fires for them.
- If a previously published tag moves to a commit that fails to build or collect during Reconcile, the existing Version folder is kept and the tag is reported as skipped; a Release run fails as usual.
