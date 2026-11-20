import fs from 'node:fs'
import path from 'node:path'
import { specHash } from './entries.mjs'
import { FatalError, lstatOrNull, metaFile } from './files.mjs'
import { SKIPPED_TAGS_FILE } from './area-names.mjs'

// The reasons a tag is skipped, and the ones whose skip depends on the entry's spec: a changed `collect`, `build` or
// `packages` can make the tag fit again, so only the hash recorded with the skip can tell.
const REASONS = new Set(['retired', 'no folder', 'prerelease', 'content'])
const SPEC_SENSITIVE_REASONS = new Set(['content', 'no folder'])

const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const SPEC_HASH = /^[a-f0-9]{64}$/

export function skippedTagsPath(areaDir) {
  return path.posix.join(areaDir, SKIPPED_TAGS_FILE)
}

// The Area's Skipped tags file, validated whole, or null when it has none. A damaged file stops the run instead of
// reading as an Area with no skips, which would re-check and rewrite every tag it names.
function readSkippedTagsFile(docs, areaDir) {
  const rel = skippedTagsPath(areaDir)
  const invalid = () => {
    throw new FatalError(`invalid ${SKIPPED_TAGS_FILE}: ${rel}`)
  }
  const stat = lstatOrNull(path.join(docs, rel))
  if (!stat) return null
  // A symlink or a folder is never the publisher's file, whatever it holds.
  if (!stat.isFile()) invalid()
  let data
  try { data = JSON.parse(fs.readFileSync(path.join(docs, rel), 'utf8')) } catch { invalid() }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) invalid()
  if (typeof data.source !== 'string' || data.source === '') invalid()
  if (data.tags === null || typeof data.tags !== 'object' || Array.isArray(data.tags)) invalid()
  const records = new Map()
  for (const [tag, record] of Object.entries(data.tags)) {
    if (tag === '' || record === null || typeof record !== 'object' || Array.isArray(record)) invalid()
    if (typeof record.sourceRevision !== 'string' || !COMMIT_SHA.test(record.sourceRevision)) invalid()
    if (!REASONS.has(record.reason)) invalid()
    if (SPEC_SENSITIVE_REASONS.has(record.reason) && record.specHash === undefined) invalid()
    if (record.specHash !== undefined && (typeof record.specHash !== 'string' || !SPEC_HASH.test(record.specHash))) {
      invalid()
    }
    if (record.detail !== undefined && (typeof record.detail !== 'string' || record.detail === '')) invalid()
    records.set(tag, record)
  }
  return { source: data.source, tags: records }
}

// The tags the Skipped tags file records, or null when the Area has none.
export function readSkippedTags(docs, areaDir) {
  return readSkippedTagsFile(docs, areaDir)?.tags ?? null
}

// The record the Skipped tags file makes of the folder it sits in: it names the repo that owns the Area, the way a
// `.meta.json` record does, so ownership, placement and Prune read it with the same rules. A Release Area holding one
// and no Version folder is still an Area another repo may not publish into, and Prune may delete.
export function skippedRecordAt(docs, areaDir) {
  const file = readSkippedTagsFile(docs, areaDir)
  return file === null ? null : { kind: 'Skipped', source: file.source, dir: areaDir, areaDir }
}

// The file's bytes: the owner, then one entry per tag in a fixed order, so a run that changes nothing rewrites the
// same bytes and stages nothing.
export function skippedTagsFile({ source, tags }) {
  const sorted = [...tags].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return metaFile({ source, tags: Object.fromEntries(sorted) })
}

// The tags this run skipped, with the state it skipped them under. A tag whose Version folder the docs already hold
// is recorded too: its bytes stay where they are, and a later run reuses the skip instead of rebuilding the tag to
// find out it still does not fit. A Release publishing the tag clears the record again. A tag that names nothing git
// holds is no skip: only what this run genuinely passed over is written.
export function skippedTagsToRecord({ packages, report, entry }) {
  const tags = new Map()
  for (const pkg of report.skipped) {
    if (!packages.includes(pkg) || !pkg.note) continue
    if (pkg.note === 'missing tag' || pkg.sourceRevision === undefined) continue
    const record = { sourceRevision: pkg.sourceRevision, reason: pkg.note }
    if (SPEC_SENSITIVE_REASONS.has(pkg.note)) record.specHash = specHash(entry)
    if (pkg.note === 'content' && pkg.reason !== undefined) record.detail = pkg.reason
    tags.set(pkg.tag, record)
  }
  return tags
}

// Skips a recorded entry still covers: the tag is not checked out and its build never runs again. The record only
// ever agrees with what this run re-derived without a checkout, and only a `content` skip stands in for a build, so
// a moved tag, a changed spec, a package folder that came back or a prerelease now published is re-evaluated. A tag
// whose Version folder the docs hold is no exception: the record speaks for the tag, and the run keeps the bytes.
export function reuseSkippedTags({ records, pending, entry, areaDir, report }) {
  if (!records) return
  for (const { pkg } of pending) {
    const record = records.get(pkg.tag)
    if (!record) continue
    // The recorded commit has to agree with the one the run read, retired packages included: a tag moved onto another
    // commit is another tag state, and its skip may not hold anymore.
    if (record.sourceRevision !== pkg.sourceRevision) continue
    // The record only covers a skip this run re-derived: a `content` record is the one reason it may stand in for,
    // because that is the only reason a run cannot reach without a checkout and a build.
    if (record.reason !== (pkg.note ?? 'content')) continue
    // A spec-sensitive skip is the same skip only while the entry still hashes the same.
    if (SPEC_SENSITIVE_REASONS.has(record.reason) && record.specHash !== specHash(entry)) continue
    // A `content` record stands in for the build that would have derived the reason, so the record's own detail is
    // the only wording this run may report: a record that carries none leaves the skip without one.
    if (record.reason === 'content' && !pkg.note) pkg.reason = record.detail
    pkg.note = record.reason
    report.previouslySkipped.push({ areaDir, tag: pkg.tag, reason: pkg.note })
  }
}
