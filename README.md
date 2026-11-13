# Docs publisher

## Overview

Publishes a repository's docs into the docs repo: the one central repository where the documentation of every repository that installs this feature is gathered. Each release writes its docs into a new version folder. Each push to the source branch refreshes the folders that always follow that branch: the mirror entries, and the Branch Version folders of the release entries that ask for one. The publisher also keeps the docs repo tidy: it rebuilds the version lists, the index and the latest copies, and it deletes docs whose source is gone. A pull request that changes what gets published receives a comment that lists the changes it would make, without writing anything.

You list what to publish, and where, in `.github/docs_publisher.yaml`. Nothing needs to be installed in the docs repo.

The words used here (Docs repo, Source repo, Area, Version folder, Mirror Area…) are defined in [GLOSSARY.md](./GLOSSARY.md).

## How it works

Each entry names a folder of the docs repo (its **Area**), the files to copy into it, and a mode:

- **`release`**: versioned docs. Each release tag writes a new **Version folder**, such as `features/state_repo/1.2.0/`, and never changes an older one. A tag published again keeps its Version folder, and the run writes nothing for it. Only a [reconcile](#manual-run) republishes an old version, and only when the entry's `collect`, `build` or `packages` changed since. A release runs the workflow from the tagged commit. A tag cut before the publisher was installed therefore publishes nothing: run the [manual run](#manual-run) for it. An entry that sets `publishSourceBranch` also publishes a **Branch Version folder**, such as `features/state_repo/main/`, which holds the build output of the tip of `source_branch` rather than a tag's.
- **`mirror`**: docs that follow the source branch. Each push that changes the entry's files replaces the whole Area with what the branch has now. A mirror compares the commit it was last published from with the checked-out `HEAD`, not only the push's range, so a push whose run failed or never started cannot lose docs changes. A mirror always publishes what the checked-out branch holds, whatever commit the Area was last published from: the last run to push wins.

| When | What runs |
| --- | --- |
| A release is published | Every release entry that matches the tag writes its Version folder, then the Area's shared files are rebuilt. An entry whose Version folder already exists for the same tag writes nothing. |
| A push to `source_branch` | Every mirror entry whose files changed is replaced, the Branch Version folder of every release entry with `publishSourceBranch` is replaced with the build output of the branch tip, and the shared files of every release Area with `areaFiles` are rebuilt, writing only what differs. A push never republishes a Version and never prunes. A push that changes `.github/docs_publisher.yaml`, whose list of changed files cannot be known, or that has [docs to prune](#removing-docs), runs a [reconcile](#manual-run) instead. |
| You start it by hand (Actions, Docs publisher, Run workflow) | A [manual run](#manual-run), which is a reconcile: it makes the docs repo match the entries file and the tags. |
| A pull request to `source_branch` | A [plan](#pull-request-plan): a comment that lists what the merge would publish or delete. It runs only when the pull request changes the entries file or a release package folder, and it writes nothing to the docs repo. A pull request that stops changing them gets its earlier comment replaced with a notice. |

Runs of one kind publish one at a time. There is one line per release tag, one for all pushes, one for manual runs, and one per pull request. A new push to a pull request cancels the plan still running for it. No other run is cancelled: it waits in its line, which holds up to 100 runs (`queue: max`). GitHub cancels the runs that arrive at a full line.

If the push to the docs branch is rejected, the publisher fetches the branch, plans again and retries, up to 5 attempts. Each retry is logged. A push decides once, before its first attempt, whether it runs as a [reconcile](#manual-run): no retry prunes, so a run that only finds docs to prune after a retry leaves them to the next run.

The publisher rebuilds a release Area's shared files from its Version folders on every publish, so the result never depends on the order of releases. The shared files are:

- `versions.json`: one per package, or one per Area without `packages`. It lists every version, newest first, with its date and a link to its `mainFile`. A docs site reads it to offer a version picker. Without `packages`, the `version` value is the tag, such as `v1.2.0`.

  ```json
  [
    {
      "version": "1.2.0",
      "date": "2025-03-04T10:15:00Z",
      "url": "https://raw.githubusercontent.com/my-org/docs/main/site/raw/features/state_repo/1.2.0/schema.json"
    },
    {
      "version": "1.1.0",
      "date": "2025-01-14T09:02:00Z",
      "url": "https://raw.githubusercontent.com/my-org/docs/main/site/raw/features/state_repo/1.1.0/schema.json"
    }
  ]
  ```

- `index.json`: one per Area with `packages`. It lists every package that has a stable version, with its latest stable version and links to that version's Markdown files, `README.md` first. A docs site reads it to list the packages. The top-level key is the last part of the Area name.

  ```json
  {
    "features": [
      {
        "name": "state_repo",
        "version": "1.2.0",
        "files": [
          {
            "name": "README.md",
            "url": "https://raw.githubusercontent.com/my-org/docs/main/site/raw/features/state_repo/README.md"
          }
        ]
      }
    ]
  }
  ```

- The latest copies: the files of the latest version, kept outside any Version folder so their links do not change between releases.
- The Area files: the files listed in `areaFiles`.
- The Branch Version folders: for an entry that sets `publishSourceBranch`, the build output of the source branch tip, in a folder named after the branch. They are not versions: `versions.json`, `index.json` and the latest copy never name them.

See [Docs repo tree](#docs-repo-tree) for where each one lives.

A publisher only touches folders whose `.meta.json` names its own repo as `source`. The first repo to publish into an Area owns it. Publishing into an Area that belongs to another repo fails. A Branch Version marker names its release Area, so a release Area that holds no Version folder yet still has an owner: a release, a reconcile, a plan or a push that would publish into such an Area stops, with the same refusal.

## Install

1. **Add the feature** to the repo:

   ```yaml
   features:
     - name: docs_publisher
       ref: docs_publisher-v1
       args:
         docs_repository: my-org/docs
         docs_root_folder: site/raw
   ```

2. **Give it push access to the docs repo.** The source repo needs a GitHub App that can push to the docs repo. Put its id in the repo variable `DOCS_APP_ID` and its private key in the secret `DOCS_APP_PRIVATE_KEY`, or name other ones with `docs_app_id_variable` and `docs_app_key_secret`.

3. **Fill in the entries.** The install creates `.github/docs_publisher.yaml` with an empty list. It is yours from then on: feature upgrades never touch it. While it is empty the publisher does nothing.

Then run the [manual run](#manual-run) once, so the docs repo holds the versions you have already released, and read the run summary.

### Args

| Arg | Required | Default | What it is |
| --- | --- | --- | --- |
| `docs_repository` | yes | | The [docs repo](./GLOSSARY.md) (`org/repo`) to publish to: the central repository that gathers the docs. |
| `docs_root_folder` | yes | | The folder of the docs repo that holds the Areas, such as `site/raw`. It cannot contain a `.git` folder. |
| `docs_branch` | no | `main` | The docs repo branch to publish to. |
| `source_branch` | no | `main` | The branch that pushes are published from, and that entries are read from. |
| `docs_app_id_variable` | no | `DOCS_APP_ID` | Repo variable with the App id. |
| `docs_app_key_secret` | no | `DOCS_APP_PRIVATE_KEY` | Repo secret with the App private key. |

Links in `versions.json` and `index.json` look like `https://raw.githubusercontent.com/<docs_repository>/<docs_branch>/<docs_root_folder>/...`.

Changing `source_branch` replaces every mirror on the next reconcile or mirror publish, even when no watched file changed. Each mirror records the branch it was published from.

To change `docs_repository`, `docs_root_folder` or `docs_branch` later, see [Changing the destination](#changing-the-destination).

## The entries file

`.github/docs_publisher.yaml` is a list of entries. The publisher always reads it from `source_branch`, not from the tag, so an edit applies from the next release. A run with no mirror entries publishes no mirror and writes a summary line: `No mirror entries; nothing to mirror.` when the file has release entries, or ``No mirror entries to publish. Add entries to `.github/docs_publisher.yaml`.`` when it has none.

```yaml
- area: features
  mode: release
  packages: packages                    # one package per folder
  mainFile: schema.json                 # what versions.json links to; default README.md
  tagNames: release-please-config.json  # see "Tags and package names"
  publishSourceBranch: true             # also publish features/<name>/main
  areaFiles:
    - { from: README.md, to: README.md }
  collect:
    - { from: "templates/docs/*", to: . }
    - { from: CHANGELOG.md, to: CHANGELOG.md }
- area: core/docs
  mode: mirror
  paths: ["docs/**"]
  collect:
    - { from: "docs/**", to: . }
```

### Docs repo tree

The entries above produce this tree under the docs root (`site/raw`, from the install example):

```
site/raw/
├── features/                          # release Area
│   ├── index.json                     # packages and their latest versions
│   ├── README.md                      # Area file
│   └── state_repo/                    # package folder
│       ├── versions.json              # every version, newest first
│       ├── main/                      # Branch Version folder (publishSourceBranch)
│       │   ├── .meta.json             # Branch Version marker
│       │   ├── README.md
│       │   ├── schema.json
│       │   └── CHANGELOG.md
│       ├── README.md                  # latest copy (1.2.0)
│       ├── schema.json                # latest copy (1.2.0)
│       ├── CHANGELOG.md               # latest copy (1.2.0)
│       ├── 1.2.0/                     # Version folder
│       │   ├── .meta.json             # Version marker
│       │   ├── README.md
│       │   ├── schema.json
│       │   └── CHANGELOG.md
│       └── 1.1.0/
│           ├── .meta.json
│           ├── README.md
│           ├── schema.json
│           └── CHANGELOG.md
└── core/
    └── docs/                          # mirror Area
        ├── .meta.json                 # Mirror Area marker
        ├── guide.md                   # from docs/guide.md
        └── backstage/                 # mirror Area inside a mirror Area
            ├── .meta.json
            └── index.md
```

- Latest is the highest stable version, never a prerelease. A backport (`1.2.9` after `2.0.0`) does not replace it.
- Without `packages`, each Version folder sits directly in the Area (`features/v1.2.0/`). The latest copy is in `features/latest/`, and `versions.json` sits at the Area root. There is no `index.json`.
- A Branch Version folder sits where the Version folders of its layout sit: `<area>/<name>/<branch>/` with `packages`, and `<area>/<branch>/` without. Its name is the `source_branch`, so a branch name with a `/`, a version, `latest`, `versions.json`, `index.json` or `.meta.json` is refused before anything is written.
- Each rebuild deletes top-level files in a release Area that the publisher did not write. Other folders in the Area stay. Inside a package folder, each rebuild replaces the latest copy and the Branch Version folder, and deletes anything else at its top that is not a Version folder or `versions.json`.
- A Mirror Area can sit inside another Mirror Area, but never inside a release Area, and never inside a Version folder or a Branch Version folder. A release Area never sits inside another Area, and a Mirror Area cannot contain a release Area. A Branch Version folder is evidence of its Area on its own: a Mirror Area is refused beside one even when the release Area holds no Version folder yet.
- The last part of an `area` cannot be a version, `latest`, `versions.json`, `index.json` or `.meta.json`.

### Fields

Every entry takes these fields:

| Field | Required / only when | What it does |
| --- | --- | --- |
| `area` | Required | The folder to publish into, inside the docs root (`features`, `core/docs`). See the [docs repo tree](#docs-repo-tree) for where Areas may sit. It cannot contain a `.git` folder. |
| `mode` | Required | `release` or `mirror`. |
| `collect` | Required, at least one rule | The files to copy: a list of `from`/`to` rules. See [Collect rules](#collect-rules). |
| `build` | Optional | A shell command run before copying, for files that must be generated. It runs in the folder that `collect` reads from. |

Mirror entries (`mode: mirror`) also take:

| Field | Required / only when | What it does |
| --- | --- | --- |
| `paths` | Required when `build` is set; otherwise optional | The files that trigger the mirror: a push that changes none of them skips it. Defaults to the `from` values of `collect`. |

Release entries (`mode: release`) also take:

| Field | Required / only when | What it does |
| --- | --- | --- |
| `packages` | Optional | The folder that holds one subfolder per package. Each package gets its own folder: `<area>/<name>/<version>/`. Leave it out for one Version folder per tag: `<area>/<tag>/`. |
| `tagNames` | Only when `packages` is set | Path to a release-please config file, from the repo root. See [Tags and package names](#tags-and-package-names). |
| `mainFile` | Optional, release only | The file `versions.json` links to for each version. Default `README.md`. A new version that lacks it fails before anything is committed. An older version that lacks it gets a warning. |
| `prereleases` | Optional, release only | `true` to publish prerelease tags too. Default `false`. |
| `areaFiles` | Optional, release only | Single files written at the top of the Area, like its `README.md`. A release keeps them up to date, and so does every push. |
| `publishSourceBranch` | Optional, release only | `true` to also publish the build output of the tip of `source_branch` into a folder named after the branch, beside the Version folders. Default `false`. See [Branch Version folders](#branch-version-folders). |

The run fails, and publishes nothing, when:

- an entry has an unknown key (`unknown key "name"`), or a key its mode does not allow (`"packages" is not allowed on a mirror entry`);
- `publishSourceBranch` is not `true` or `false` (`publishSourceBranch must be true or false (write true or false without quotes)`), or names a folder the Area cannot hold: a `source_branch` with a `/`, a version, `latest`, `versions.json`, `index.json` or `.meta.json`. The run refuses it before it builds anything, for example: `entry 1 (area "features"): publishSourceBranch would publish an Area folder named "release/1.0.0": a branch name cannot contain "/"`;
- `tagNames` is set without `packages` (`tagNames needs packages`);
- a mirror entry has `build` but no `paths` (`a mirror entry with build needs paths`);
- two entries share one Area (`two entries publish the Area "features"`);
- two rules write the same file;
- a path is absolute or leaves the repo (`collect from must be a relative path inside the repo`), or is a symlink;
- a `.git` folder appears in `area`, or in `from` or `to` of `collect` or `areaFiles`, for example: `collect from ".git/config" uses ".git", the Git administrative folder`;
- a release Area sits inside another Area, or a Mirror Area sits inside a release Area. The run refuses the entries file before it collects anything, for example: `entry 2 (area "outer/inner"): release Area "outer/inner" sits inside Area "outer" of entry 1`, or `entry 2 (area "outer/notes"): Mirror Area "outer/notes" sits inside release Area "outer" of entry 1`.

The error names the entry. Quote values that YAML would read as numbers: write `area: "2024"`, not `area: 2024`.

### Collect rules

- **One file**: a `from` with no `*` or `?` copies that file to `to`, which is then a file path.
- **Many files**: a `from` with `*` (inside one folder), `**` (across folders, at any depth) or `?` (one character) copies every match into the `to` folder, keeping the path below the pattern's fixed part: `templates/docs/images/*` with `to: images` gives `images/<file>`. No match copies nothing. A glob never matches the `.git` folder.
- With `packages`, `from` is read from the package folder. Without it, from the repo root. `areaFiles` always read from the repo root.
- `build` runs in that same folder. Put anything long in a script in the repo and call it from `build`.
- `build` gets no token. The docs repo token and the source repo token are not in its environment, and neither checkout keeps credentials in its git config. A build that downloads something private needs its own credential. This is not a sandbox: the command still runs as the runner's user, so point `build` only at code you trust.
- **Errors**: a missing `from` file, a `from` that is not a file, a failed `build`, or, for a release tag, a `collect` that matches no file. For a release publish, the run fails and publishes nothing. A manual run and a PR plan skip that tag and list it in the run summary or plan, as [Manual run](#manual-run) describes. For a mirror, a push or manual run fails and publishes nothing.
- A collected file cannot be named like a version (`1.2.0`, `v1.2.0`) at the root of a Version folder. It cannot be named `.meta.json` either: the run refuses it with `collect from "<from>" would publish <rel>: .meta.json marks an Area|a Version folder, which the publisher writes`.
- **Mirrored Markdown** is copied unchanged. A link or image keeps the target it has in the source repo, so it works in the docs repo when the file it names is collected to the same relative path.
- **File and folder at one path**: two rules that write a file and a folder at the same path in one Area are refused before anything is written, for example `Area "core/docs": collect "README.md" to "x" writes the file x, but collect "docs/guide.md" to "x/y" writes x/y inside it`.

### Tags and package names

A release entry only publishes tags of the form `<name>-v<semver>` when it has `packages`, and `v<semver>` when it has not. Prerelease tags are skipped unless the entry sets `prereleases: true`.

With `packages`, the `<name>` part of the tag, everything before `-v`, must be the name of the package folder. For example, `state_repo-v1.2.0` publishes `packages/state_repo`.

If your tags are named differently from the folders, set `tagNames` to a release-please config file. The publisher reads its `packages` map, as the [release-please manifest config](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md) defines it. For each package, it uses the `component` as the name in its tags, or the `package-name` when there is no `component`. The key of each package is `<packages>/<folder>`, or just `<folder>` when `packages` is the repo root (`.`). A tag whose name matches no `component` or `package-name` uses the folder name. If the file is missing, every tag uses its folder name. The folder still names the Version folder in the docs repo. Two package folders that resolve to the same tag name are refused, and the error names both: `release-please config <file>: component "<name>" maps to more than one package folder: packages/alpha, packages/beta`.

For example, with this entry:

```yaml
- area: features
  mode: release
  packages: packages
  tagNames: release-please-config.json
  collect:
    - { from: "templates/docs/*", to: . }
```

and this `release-please-config.json` at the repo root:

```json
{
  "packages": {
    "packages/state_repo": { "component": "state-repo" },
    "packages/net": { "package-name": "network" }
  }
}
```

these tags publish to these folders:

| Tag | Package folder | Version folder |
| --- | --- | --- |
| `state-repo-v1.2.0` | `packages/state_repo` | `features/state_repo/1.2.0/` |
| `network-v0.4.0` | `packages/net` | `features/net/0.4.0/` |
| `state_repo-v1.2.0` | `packages/state_repo` (folder name, no `component` matches) | `features/state_repo/1.2.0/` |

`state_repo-v1.2.0` targets the same Version folder as `state-repo-v1.2.0`. See the next paragraph for what happens when both publish.

A Version folder keeps the tag that published it. A tag whose name resolves to a folder another tag already published, through the folder-name fallback or in the same run, fails the run with exit code 2 and writes nothing, naming both tags and the folder: ``refusing to publish `alpha-v1.0.0` over `a-v1.0.0` in `site/raw/features/alpha/1.0.0`: a Version folder keeps the tag that published it``. A [reconcile](#manual-run) refuses the same folder when its recorded `tag` differs from the tag it would republish from.

### Branch Version folders

An entry that sets `publishSourceBranch: true` also publishes the docs of the tip of `source_branch`, so a docs site can offer the docs of the branch people work on, not only the docs of the releases. It collects and builds the same way a Version folder does, from the same folder:

- with `packages`, one folder per package: `<area>/<name>/<branch>/`, such as `features/state_repo/main/`;
- without `packages`, one folder: `<area>/<branch>/`, such as `core/crds/main/`.

The folder holds one build output. Each relevant push replaces it whole, so a file the source branch no longer has leaves with it; with `packages`, a push rebuilds only the packages it touched. An unrelated push writes nothing.

- It is written on every push that changes the entry's files and on every [reconcile](#manual-run), so a folder deleted by hand comes back.
- It is not a version: `versions.json`, `index.json`, the latest copy and the Version folders never name it. Link to it by its path.
- A build failure here fails only its Area on a push: the push publishes the rest, and the run summary names the problem.
- Its marker places it: the run reads the release Area from `area` and the folder must sit exactly one segment below it (`<area>/<branch>/`) or two (`<area>/<name>/<branch>/`), named after `branch`. A folder anywhere else is damaged metadata — `invalid .meta.json: <path>`, exit code 2, nothing written or deleted — and the run never infers another Area from the path.
- A run replaces it only when the folder, and every Area marker inside it, names this repo as `source`: another repo's folder stops the run with exit code 2 and publishes nothing, saying ``Area "core/crds" belongs to other/producer, but this repo is acme/source. Choose another Area. If this repo was renamed or is taking over the Area, update "source" in that Area's .meta.json files in the docs repo.``. A path that reaches the folder through a symlink, or a symlink anywhere inside it, stops it the same way, before anything is removed.
- It is deleted when the entry turns the field off, when the entry goes, when its Area changes mode, and, with `packages`, when the package folder leaves the repo. The same ownership rule applies: only the repo its `.meta.json` names as `source` deletes it.

## Metadata files

The publisher writes a `.meta.json` in each Version folder, in each Branch Version folder and in each Mirror Area. It writes no other kind. A marker says which kind it is: a Version marker holds a `tag`, a Mirror marker a `sourceBranch`, and a Branch Version marker a `branch` and the `area` it was published into.

### Version marker

Written as `<area>/<name>/<version>/.meta.json`, or `<area>/<version>/.meta.json` without `packages`.

```json
{
  "source": "my-org/features",
  "tag": "state_repo-v1.2.0",
  "date": "2025-03-04T10:15:00Z",
  "specHash": "4f65f6e4a934962b837e347333dac9cb80b9a39a18e2d54612ae2b195c451867"
}
```

- `source`: the repo that published the version.
- `tag`: the tag that published it.
- `date`: the tag's creation date.
- `specHash`: a hash of the entry's `collect`, `build` and `packages`. A [reconcile](#manual-run) republishes the version from its tag when the hash differs from the current entry. So changing any of those three fields refreshes the old versions the next time the entries file is pushed or the manual run starts. The other fields do not change the hash. `specHash` is optional: a marker without it counts as changed, so a reconcile republishes its version from the tag.

### Mirror marker

Written as `<area>/.meta.json`, at the root of the Mirror Area, on every mirror publish.

```json
{
  "source": "my-org/features",
  "sourceRevision": "a565a838aaa73a97c0becfae4c15fe6e5e92de71",
  "sourceBranch": "main",
  "date": "2025-03-04T10:15:00Z"
}
```

- `source`: the repo that published the Area.
- `sourceRevision`: the commit the Area was mirrored from, required as a 40- or 64-character lowercase hexadecimal Git revision. A later push checks it, as [described above](#how-it-works).
- `sourceBranch`: the branch the Area was mirrored from.
- `date`: the date of that commit.

### Branch Version marker

Written as `<area>/<name>/<branch>/.meta.json`, or `<area>/<branch>/.meta.json` without `packages`, on every publish of the folder.

```json
{
  "source": "my-org/features",
  "area": "features",
  "branch": "main",
  "sourceRevision": "a565a838aaa73a97c0becfae4c15fe6e5e92de71",
  "date": "2025-03-04T10:15:00Z"
}
```

- `source`: the repo that published the folder.
- `area`: the entry's `area`, exactly as it appears in the entries file: the release Area the folder was published into. It is read with the same rules as the entries file's `area`: a normalized relative path inside the repo, whose last segment is not reserved and which holds no `.git`. The publisher reads the release Area from here, so the folder's own path never decides it. The folder still has to sit where that Area's layout puts it, one segment below it or `<name>/<branch>`, named after `branch`.
- `branch`: the branch the folder holds, which is also its name.
- `sourceRevision`: the commit of that branch the folder was built from.
- `date`: the date of that commit.

A Branch Version marker holds no `tag`. That is what tells it from a [Version marker](#version-marker), and its `branch` is what tells it from a [Mirror marker](#mirror-marker): the publisher never mistakes one kind for another. Every field shown above is required. A missing or empty `source`, an invalid `date` or `sourceRevision`, a marker without a valid `area`, or a folder its `area` and `branch` cannot place is damaged metadata: the run refuses it with `invalid .meta.json: <path>`, exits with code 2 and writes or deletes nothing. Every reader of the marker makes the same check, so no run trusts a folder the marker cannot place.

All three marker kinds use one reader for their body and placement. A Mirror marker also requires every field shown above; its `date` and a Branch Version marker's `date` must be a real UTC timestamp in `YYYY-MM-DDTHH:mm:ssZ` form. Their `sourceRevision` must be a 40- or 64-character lowercase hexadecimal Git revision. Every damaged marker uses the same `invalid .meta.json: <path>` refusal. Ownership checks use the resulting records, including Version and Branch Version records in an Area whose entry has been removed.

## Manual run

Run it from Actions, Docs publisher, Run workflow. The branch you pick doesn't matter: it works on `source_branch`. A push that changes `.github/docs_publisher.yaml`, whose changed files cannot be known, or that has [docs to prune](#removing-docs) runs the same reconcile.

A reconcile makes the docs repo match the entries file and the tags. It reads the tags, not the release-please manifest. A tag is checked out, and its `build` run, only when the run publishes or republishes its Version folder: a folder that is kept costs one read of its `.meta.json`. For every tag that matches a release entry:

- **No Version folder yet**: it publishes the version from the tag.
- **A Version folder this repo owns, with the same `specHash` as the current entry**: it keeps the folder as it is, byte for byte.
- **A Version folder this repo owns, with a different `specHash` or none**: it republishes the version from the tag, because `collect`, `build` or `packages` changed since it was published. A run that started from a commit behind `source_branch` keeps the folder as it is instead.
- **A Version folder this repo owns, whose tag no longer exists**: it keeps the folder, because there is nothing to republish it from. The run summary lists it under `Kept`, with no matching tag.
- **A folder with the name of a version but no `.meta.json`**: the publish stops, because the publisher cannot tell whose it is. See [adopting the publisher](#adopting-the-publisher-on-areas-that-already-hold-docs).

A tag whose content does not fit today's entry (`build` fails, `collect` finds nothing, the package is gone or the tag is a prerelease) is skipped and listed in the run summary. The other versions are still published.

It also republishes every mirror entry, every Branch Version folder, rebuilds the shared files of every release Area, and [prunes](#removing-docs). Everything is planned and checked before any file is written, and then published in one commit. A failure publishes nothing.

It is also the repair path after someone edits the docs repo by hand. Running it again when everything is in place changes nothing.

### Adopting the publisher on Areas that already hold docs

The publisher stops, and publishes nothing, when a folder named like a version (`1.2.0`, `v1.2.0`) has no `.meta.json`. It cannot tell whether the folder is someone else's docs, so nothing is adopted by guessing. Do it one Area at a time:

1. Install the publisher in the source repo first, with no entry for the Area yet. Check that the first run gets its token: when the variable or secret named by `docs_app_id_variable` and `docs_app_key_secret` is missing, it fails at `Generate GitHub App token`. Do not write any `.meta.json` into the Area before this step: a run with no entry for the Area [prunes](#removing-docs) every folder whose `.meta.json` names this repo.
2. List the Version folders of the Area that have no matching tag. Give each of them a `.meta.json` by hand: `{ "source": "<org/repo>", "tag": "<tag name>", "date": "<timestamp>" }`, without `specHash`. `source` must be the repo that publishes the Area. The publisher keeps such folders, because it has no tag to republish them from. This does not save the folder of a package that is gone from the source repo: that package is pruned.
3. In the same change, delete the Area's other content in the docs repo:
   - the folders that have a tag: the publisher publishes them again from the tag, and one left without a `.meta.json` stops the run;
   - the folders that are not versions, such as old branch folders: the publisher ignores them, so they stay until someone deletes them.
4. Right after that merges, merge the change that adds the Area's entry to `.github/docs_publisher.yaml`. That push runs the reconcile, so every version is republished from its tag. No manual run is needed.

Readers may get 404s between steps 3 and 4.

A Mirror Area inside another Mirror Area must be adopted right after its parent. The parent's publish replaces everything in its Area except nested folders that have a `.meta.json`, so a nested Area that has not been adopted yet loses its content until its own publish.

If the docs repo builds a site from these folders, check that build first. It must not fail while an Area is empty, and it must find images inside each Area, where the publisher keeps them.

## Pull request plan

A pull request to `source_branch` that changes `.github/docs_publisher.yaml`, or a file inside a release entry's `packages` folder (any file, when `packages` is `.`), gets a plan. The plan is a [reconcile](#manual-run) that runs against the pull request's head and writes nothing to the docs repo. It works on a temporary copy of the docs root, runs the `build` commands of the versions it would publish or republish (mirror builds do not run), and gets a read-only docs token. The result is one comment, kept up to date on every push to the pull request.

Each Area with changes gets a section. This comment shows every kind of line a plan can contain:

```
## Docs publisher plan

Mirror content changes are not listed; mirror builds do not run in plan mode.

### `api`
- Replace Area: its entry is now in mirror mode.

### `core/docs`
- Add Mirror Area.

### `features`
- Delete version `old_pkg/0.4.0`: `packages/old_pkg` is gone from the source repo.
- Warning: deleting version `old_pkg/0.4.0`: no tag exists to rebuild it from.
- Add version `state_repo/1.3.0`.
- Republish version `state_repo/1.2.0`: specHash changed.
- Add Branch Version folder `state_repo/main`.
- Refresh Branch Version folder `net/main`.
- Skipped Area files for `site/raw/features`: a published version's tag is not an ancestor of the manual checkout.
- Skipped `old_pkg-v0.4.0`: the package folder is gone from `main`, so the package is retired.
- Skipped `state_repo-v0.9.0`: the package folder does not exist at that tag.
- Skipped `state_repo-v0.8.0`: no such tag.
- Skipped `network-v0.1.0-rc.1`: a prerelease, and the entry does not publish prereleases.
- Skipped `state_repo-v1.0.0`: its content does not fit the entry (collect matched no files).

### `old_docs`
- Delete Area: its entry is gone from docs_publisher.yaml.

This change would fail to publish:
- invalid .meta.json: site/raw/features/alpha/0.9.0/.meta.json
```

- A plan with nothing to change says `No changes to add, republish, delete or replace.` instead of the sections.
- A line says what the merge would do: add or republish a version, add or refresh a Branch Version folder, delete a version or a Branch Version folder, add a Mirror Area, delete an Area, or replace an Area when its mode changed.
- A change that would fail to publish (an invalid entry, a failed `build`, a folder that belongs to another repo, invalid `.meta.json`) lists its problems under `This change would fail to publish:`. The job still ends with exit code `0`. An unexpected error fails the job.
- A pull request that stops changing those files gets its comment replaced with `This pull request no longer changes docs publishing.`. A pull request that never had a comment gets none. Other pull requests print `Skipped plan: no changed entries file or release package folder.` in the run summary.
- Pull requests from forks get no plan, because GitHub gives them no secrets. The run summary says so.
- An entries file that is not valid YAML shows as a warning instead of failing the job, and the comment lists the YAML error under `This change would fail to publish:`. A push or a manual run stops at the conversion step, prints the error and exits 1, so nothing is published.

## Removing docs

Every manual run, and every push that has something to prune, makes the docs repo match the source: the push runs a [reconcile](#manual-run) for it. It only deletes folders whose `.meta.json` names this repo. A [plan](#pull-request-plan) lists these deletions before the pull request merges.

- **An entry is removed** from `docs_publisher.yaml`: its whole Area is deleted. This includes renaming an `area`: the old Area goes, and the push of the entries file publishes every tagged version under the new name.
- **A package is removed** from the repo: `<area>/<name>/` is deleted, and its row leaves `index.json`. This includes its Branch Version folder.
- **An entry changes mode**: the Area is deleted and published again in the new mode. A push of the entries file does both in one commit, and fills a release Area from its tags.
- **`publishSourceBranch` turns off**: `<area>/<branch>/`, or `<area>/<name>/<branch>/`, is deleted. Turning it on publishes the folder on the same run, since the entries file changed.
- **A Version folder with no tag** is deleted along with its Area or package. The run summary warns about it, because only the docs repo's git history can restore it.

The publisher refuses to prune when an entry's `packages` folder is missing from the checkout, since it could not tell a removed package from a broken checkout. It also refuses to prune a package folder that holds Version folders of another repo.

A run also prunes nothing when `source_branch` moved past the checkout it started from: it cannot tell which docs are stale from an old commit, so a push then stays a push instead of running a reconcile for that prune. The run summary says ``Skipped prune: the source branch `<branch>` moved past the checkout, so this run cannot tell which docs are stale.``, and the next run, which starts from the new tip, prunes. For the same reason a push leaves the [Area files](#how-it-works) of its release Areas alone, and says ``Skipped the Area files of `<area>`: the source branch `<branch>` moved past the checkout, so this run cannot tell whether newer ones are already published.`` A reconcile in that position also republishes no Version whose `specHash` differs from the entry it read, and says ``Skipped `<version folder>`: the source branch `<branch>` moved past the checkout, so this run cannot tell whether a newer spec is already published.`` It publishes no [Branch Version folder](#branch-version-folders) either, and says ``Skipped `<branch folder>`: the source branch `<branch>` moved past the checkout, so this run cannot tell whether a newer build is already published.``

Prune never deletes outside the docs root. A Version folder whose Area would sit above the root stops the run with exit code 2, and nothing is deleted. Before it deletes anything, a run walks every tree it would remove — each folder a removal names, and the Branch Version folders a parent removal carries away with it — and refuses a symlink anywhere in one: `refusing to write through symlink: <path>`, exit code 2, nothing deleted.

A Version folder with a damaged `.meta.json` (for example an invalid `date`) is never pruned. A release or a manual run that reaches its Area stops with `invalid .meta.json: <path>` and writes nothing, rather than writing around the folder. A push never writes around it either, but it publishes the rest: it keeps the Area files of that Area and says ``Kept the Area files of `<area>`: invalid .meta.json: <path>; run a manual run to repair it.`` A push that has something to prune runs a [reconcile](#manual-run) instead, and the reconcile refuses the same way, so a removal never lands without the shared files that list it.

## Changing the destination

`docs_repository`, `docs_root_folder` and `docs_branch` say where the publisher writes. Changing one moves future writes only. The old destination keeps its content, and the publisher does not delete it.

To move:

1. **Create the branch.** If `docs_branch` changed, create it in the docs repo first. The publisher does not create a missing branch: the run fails with `could not fetch the docs branch "<branch>" from origin: ...`. If `docs_repository` changed, give the App push access to it, as in [Install](#install).
2. **Change the arg** in the `args` of the `docs_publisher` feature. The push that the change makes publishes the mirror entries at the new destination, and, for every release Area with `areaFiles`, rebuilds its Area files and its release links (`versions.json`, `index.json`) there. It publishes no Version folder, and only the Branch Version folders of the release Areas whose files it changed: an Area without `packages` holds every file, so its folder is published, while an Area with `packages` publishes only the folders of the packages the push touched, which is none for a change outside `packages`. The rest — every Version folder, the other Branch Version folders and the links of an Area without `areaFiles` — comes from step 3, so run it.
3. **Run the [manual run](#manual-run).** It publishes each release version that is missing at the new destination, and rewrites the shared files there, so their links point at the new `docs_branch` and `docs_root_folder`.
4. **Check** that the links in `versions.json` and `index.json` contain the new values.
5. **Clean the old location by hand.** Delete the Areas this repo published there, one at a time. Other source repos may publish into the same root, so keep any Area or nested Area whose `.meta.json` names another `source`.

## When something is wrong

| Exit code | Meaning |
| --- | --- |
| `0` | Published, skipped or nothing to do. The run summary says which. Also the exit code of a plan, even when the plan finds that the change would fail to publish: the comment lists the problems. |
| `2` | Nothing was published. The run summary and log say why: a wrong entry, a failed `build`, a missing file, a folder that belongs to another repo, an invalid `.meta.json`, a docs branch that doesn't exist, or a push rejected 5 times in a row. |
