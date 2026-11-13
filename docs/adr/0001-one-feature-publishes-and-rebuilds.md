# One feature publishes and rebuilds the shared files, without a hub

Documentation from several source repos lands in one docs repo, and shared files (`versions.json`, `index.json`, Latest copies) used to be edited in place by each producer, so close releases could race or roll a summary back. An earlier design split the work in two: `docs_publisher` in each source repo wrote only its own folders, and a `docs_hub` feature in the docs repo, driven by a central Registry of Areas, was the sole writer of the shared files. We dropped the hub: `docs_publisher` alone writes an Area's Version folders and rebuilds that whole Area's shared files from them in the same commit, so a team can adopt it without installing anything in the docs repo or adding a Registry entry.

## Considered Options

- **Publisher plus hub with a central Registry** — rejected: every new Area needed a change in the docs repo, and two features had to agree on root, branch, image names and metadata rules that nothing checked.
- **Publisher writes the shared files in place, as before** — rejected: that is the race this work removes.
- **Publisher rebuilds the whole Area from its Version folders on every publish** — chosen: the result depends only on the folders present, never on the order of publishes, so a summary cannot roll back, and a rejected push retries from a fresh fetch.

## Consequences

- There is no central list of allowed Areas. Ownership lives in each folder's `.meta.json` (`source`): the first repo to publish into an Area owns it, and a rename or handover is fixed by editing `source` in the docs repo.
- There is no nightly repair. Each publish checks the Area it writes and stops, with no commit, on any invalid folder; the manual run is the repair path after hand edits.
- Images stay next to the docs that use them. The hub's flat `images/` folder and its image-link rewrite are gone.
