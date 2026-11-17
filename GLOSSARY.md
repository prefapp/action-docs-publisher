# docs_publisher

The GitHub Action `prefapp/action-docs-publisher`, which each source repo runs from the workflow its `docs_publisher` feature installs. It gathers the repo's docs into the Areas it owns in one docs repo, under one root folder, and rebuilds each release Area's shared files from its Version folders. Building the website is out of scope.

## Language

**Docs repo**:
The one central repository where the documentation of every source repo is gathered, on one branch and under one root folder. A source repo names it in `docs_repository`. Nothing is installed in it.
_Avoid_: hub, docs hub, central repo

**Source repo**:
A repo that has `docs_publisher` installed and publishes into the docs repo.
_Avoid_: producer, publisher repo

**Area**:
A folder under the root folder (at the top of the docs repo when the root is `.`) that one source repo owns, for example `features` or `core/crds`. The first source repo to publish into it owns it.
_Avoid_: section, Registry entry

**Entry**:
One item of the source repo's entries file: an Area, its entry mode and the files to collect into it.
_Avoid_: publisher entry, Registry entry

**Entry mode**:
How an Entry publishes its Area: `release` makes a Release Area, `mirror` makes a Mirror Area.
_Avoid_: mode (alone), Area type

**Release Area**:
An Area that holds one Version folder per released version, plus its shared files. It never holds a Mirror Area.
_Avoid_: versioned Area, release mode Area

**Mirror Area**:
An Area that holds a copy of the source repo's current docs. A publish replaces it as a whole. It may sit inside another Mirror Area, and never inside a Release Area, a Version folder or a Branch Version folder.
_Avoid_: sync Area, latest Area

**Version folder**:
The folder holding one released version's docs and its `.meta.json`.
_Avoid_: release folder, version directory

**Branch Version folder**:
The folder holding the build output of the tip of the source branch, named after that branch, written by a release entry that sets `publishSourceBranch`. It is not a version: no version list, Latest copy or Version folder names it, and it holds no tag. Its marker names the release Area it was published into. A run replaces it whole, so a folder with no marker of its own is hand-made: the run refuses it instead of deleting its files.
_Avoid_: branch folder, main docs, snapshot folder

**Branch Version marker**:
The `.meta.json` of a Branch Version folder: the source repo, the release Area the folder was published into, the branch, the commit it was built from and that commit's date. Every field is required. It holds no tag, and a marker with a missing source repo, invalid revision, invalid date or invalid Area is damaged metadata. Its Area is read with the entries file's rules, and it places its folder: one segment below that Area, or `<name>/<branch>`, named after the branch.
_Avoid_: branch metadata, snapshot marker

**Latest copy**:
An exact copy of the latest stable version's docs, at a fixed path, without `.meta.json`.
_Avoid_: latest folder, current copy

**Shared files**:
The files the publisher rebuilds from a release Area's Version folders on every publish: `versions.json`, `index.json`, Latest copies and Area files.
_Avoid_: derived files, summaries

**Area files**:
Single files from the source repo placed at the top of a release Area, for example `features/README.md`.
_Avoid_: top files, landing files

**Collect rule**:
One `{from, to}` pair of an entry. It copies either one file (a literal `from`) or every file a glob matches into the Version folder or the Area.
_Avoid_: copy rule, mapping, glob rule

**Prune**:
Deleting the docs of an Area whose entry is gone, or of a package whose folder is gone from the source repo, and a Branch Version folder whose entry stopped asking for it. It only deletes folders whose `.meta.json` names this source repo, and it refuses a symlink in a tree it would clear.
_Avoid_: cleanup, garbage collection

**Run mode**:
What one run of the action does, reported in the `run-mode` output: `release`, `push`, `reconcile`, `plan` or `skipped`. The event that started the run selects it.
_Avoid_: mode (alone), run type

**Release run**:
The `release` run mode. A run started by a published release that publishes that release's version into its Release Area.
_Avoid_: publish run, tag run

**Push run**:
The `push` run mode. A run started by a push to the source branch that republishes only the docs the push changed. It becomes a Reconcile, and reports `reconcile`, when the push changes the entries file or has docs to prune.
_Avoid_: incremental run, sync

**Skipped run**:
The `skipped` run mode. A run started by a release whose tag is not a release of this source repo's Areas. It reads nothing from the docs repo and writes nothing to it.
_Avoid_: no-op, ignored release

**Reconcile**:
A run that makes the docs repo match the entries file and the source repo's tags. It adds missing versions, republishes versions whose spec changed, publishes Branch Version folders, prunes, replaces Areas whose entry mode changed, republishes mirrors and rebuilds release Areas.
_Avoid_: Backfill, sync

**Plan mode**:
A reconcile against a pull request's head that writes nothing to the docs repo and reports what it would do.
_Avoid_: dry run, preview publish

**Manual run**:
A reconcile started by hand, also used to repair hand edits. A push that changes the entries file, or that has docs to prune, starts the same reconcile, including republishing versions whose spec changed.
_Avoid_: Backfill, migration, sync
