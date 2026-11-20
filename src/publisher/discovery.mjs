import path from 'node:path'
import { SEMVER_REGEX } from './entries.mjs'
import { FatalError, folderNames, lstatOrNull, markerRecordAt, namesGitPath } from './files.mjs'
import { skippedRecordAt, skippedTagsPath } from './skipped.mjs'

// Area claim discovery: one walk of the docs tree that reports the Area each folder claims and the claims it cannot
// read. Discovery reports evidence; what a run does with it, from deleting a folder to refusing a write, stays with
// the policy modules that ask for it.
//
// The traversal rules live here, in one place. The walk never enters the `.git` folder, never enters a Version folder
// (its content is a tag's build output, so a Skipped tags file a tag carries is content too), and never enters a
// folder whose marker it could not read. A folder whose marker is a symlink is entered but not read: the guards that
// refuse the links a run would write or delete through run elsewhere.

// Every folder under `base` reports what claims it to `claim`, or the marker it could not read to `damaged`, which
// decides whether the walk carries on past the damage. A folder either reports is not entered.
function walkMarkers(docs, root, base, claim, damaged) {
  const walk = (dir) => {
    for (const name of folderNames(path.join(docs, dir)).sort()) {
      if (namesGitPath(name)) continue
      const child = path.posix.join(dir, name)
      if (lstatOrNull(path.join(docs, child, '.meta.json'))?.isSymbolicLink()) { walk(child); continue }
      let record
      try { record = markerRecordAt(docs, root, child) } catch (error) {
        if (!(error instanceof FatalError) || !damaged) throw error
        damaged(child, error)
        continue
      }
      claim(child, record)
      if (record?.kind !== 'Version') walk(child)
    }
  }
  if (lstatOrNull(path.join(docs, base))?.isDirectory()) walk(base)
}

// The marker records under `base`, excluding the folder itself: a Version's content has its own nesting guards. A
// caller that defers damage passes `damaged` and decides what to do with it; a caller that cannot leaves it out and
// the run stops on the first damaged marker.
export function markerRecords(docs, root, base, damaged) {
  const records = []
  walkMarkers(docs, root, base, (_dir, record) => {
    if (record) records.push(record)
  }, damaged)
  return records
}

// Every Area claim under the root, as the docs tree holds it: a Version, Branch Version or Mirror marker, or a
// Skipped tags file, each validated whole. A claim whose marker or file is damaged is reported in `damaged`, in the
// order the diagnostics are read: the markers first, then the Skipped tags files.
export function discoverAreas(docs, root) {
  const markers = []
  const skipped = []
  const markerDamage = []
  const skippedDamage = []
  walkMarkers(docs, root, root, (dir, record) => {
    if (record) markers.push(record)
    if (record?.kind === 'Version') return
    try {
      const claim = skippedRecordAt(docs, dir)
      if (claim) skipped.push(claim)
    } catch (error) {
      if (!(error instanceof FatalError)) throw error
      skippedDamage.push({ dir, rel: skippedTagsPath(dir), message: error.message })
    }
  }, (dir, error) => {
    // An untouched version-shaped folder stays for the write guards' own reading: a plain push contains a broken
    // Area instead of failing over it. Any other damaged marker, and one whose Area leaves the root, stops the run.
    if (error.outsideRoot || !SEMVER_REGEX.test(path.posix.basename(dir).replace(/^v/, ''))) throw error
    markerDamage.push({ dir, message: error.message })
  })
  const claims = [...markers, ...skipped]
  return {
    claims,
    damaged: [...markerDamage, ...skippedDamage],
    // The folders the docs hold a release Area in: a Version folder, a Branch Version folder or a Skipped tags file
    // claims one, and a Mirror Area claim never does. `content` names the paths a caller publishes as content, where
    // a Skipped tags file is content a Mirror Area carries, not a claim.
    releaseAreas: ({ content = new Set() } = {}) => {
      const dirs = new Set()
      for (const claim of claims) {
        if (claim.kind === 'Mirror') continue
        if (claim.kind === 'Skipped' && content.has(claim.rel)) continue
        dirs.add(claim.areaDir)
      }
      return dirs
    },
  }
}
