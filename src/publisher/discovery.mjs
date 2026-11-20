import path from 'node:path'
import { SEMVER_REGEX } from './entries.mjs'
import { FatalError, folderNames, lstatOrNull, markerRecordAt, namesGitPath } from './files.mjs'
import { skippedRecordAt, skippedTagsPath } from './skipped.mjs'

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

export function markerRecords(docs, root, base, damaged) {
  const records = []
  walkMarkers(docs, root, base, (_dir, record) => {
    if (record) records.push(record)
  }, damaged)
  return records
}

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
    if (error.outsideRoot || !SEMVER_REGEX.test(path.posix.basename(dir).replace(/^v/, ''))) throw error
    markerDamage.push({ dir, message: error.message })
  })
  const claims = [...markers, ...skipped]
  return {
    claims,
    damaged: [...markerDamage, ...skippedDamage],
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
