import fs from 'node:fs'
import path from 'node:path'
import { specHash } from './entries.mjs'
import { FatalError, lstatOrNull, metaFile, writeFile } from './files.mjs'
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
  return file === null ? null : { kind: 'Skipped', source: file.source, dir: areaDir, areaDir, rel: skippedTagsPath(areaDir) }
}

// The file's bytes: the owner, then one entry per tag in a fixed order, so a run that changes nothing rewrites the
// same bytes and stages nothing.
function skippedTagsFile({ source, tags }) {
  const sorted = [...tags].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return metaFile({ source, tags: Object.fromEntries(sorted) })
}

const byTag = (left, right) => (left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0)

// The one edit the Area's Skipped tags file needs for the records it ends with: its bytes, or the removal when it
// records none. Null when the Area never had the file and gains nothing for it, so a run that changes nothing stages
// nothing.
function skippedTagsChange({ rel, existed, tags, repository }) {
  if (tags.size > 0) return { rel, file: skippedTagsFile({ source: repository, tags }) }
  return existed ? { rel, remove: true } : null
}

// The record the Area's file keeps of a tag this run skipped: the commit the skip was decided at, the reason it was
// decided for, the entry's hash when that reason depends on it, and the detail a `content` skip carries.
function skipRecord(pkg, spec) {
  const record = { sourceRevision: pkg.sourceRevision, reason: pkg.note }
  if (SPEC_SENSITIVE_REASONS.has(pkg.note)) record.specHash = spec
  if (pkg.note === 'content' && pkg.reason !== undefined) record.detail = pkg.reason
  return record
}

// One tag this run skipped in one Area, as the Area's file records it and the summary names it: the skip it derived,
// the detail a `content` skip carries, and whether a record stood in for the build that would have derived it.
function skipOutcome(areaDir, pkg, reused) {
  return { areaDir, tag: pkg.tag, skip: pkg.note, detail: pkg.note === 'content' ? pkg.reason : undefined, reused }
}

// The Skipped tags file of one Release Area over one run: the records it read, the skips this run leaves the Area with,
// and the one file edit the Area needs. `reuse` stands a recorded skip in for the build that would re-derive it,
// `record` takes the outcome of a skip this run derived, `outcomes` is what the Area skipped (fresh and reused, this
// Area's own) and `change` is the bytes the file ends with or its removal. Matching a record to a package, deciding
// whether it still covers it, and encoding the bytes stay here; when the file is written, and what a Run mode does
// with the outcomes, stay with the callers.
export function planAreaSkips({ docs, areaDir, entry, repository }) {
  // Null when the Area has no such file: a file the run leaves no skips for is removed, not written empty.
  const records = readSkippedTags(docs, areaDir)
  const spec = specHash(entry)
  // The skips the run leaves the Area with, and the record each one writes: a tag that names nothing git holds is no
  // skip the file records, because only what this run genuinely passed over is written.
  const skipped = new Map()
  const keep = (pkg, reused) => skipped.set(pkg.tag, {
    outcome: skipOutcome(areaDir, pkg, reused),
    record: pkg.note === 'missing tag' || pkg.sourceRevision === undefined ? null : skipRecord(pkg, spec),
  })
  const outcomes = () => [...skipped.values()].map(({ outcome }) => outcome).sort(byTag)
  return {
    // Skips a recorded entry still covers: the tag is not checked out and its build never runs again. The record only
    // ever agrees with what this run re-derived without a checkout, and only a `content` skip stands in for a build, so
    // a moved tag, a changed spec, a package folder that came back or a prerelease now published is re-evaluated. A tag
    // whose Version folder the docs hold is no exception: the record speaks for the tag, and the run keeps the bytes.
    reuse(pending) {
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
        if (SPEC_SENSITIVE_REASONS.has(record.reason) && record.specHash !== spec) continue
        // A `content` record stands in for the build that would have derived the reason, so the record's own detail is
        // the only wording this run may report: a record that carries none leaves the skip without one.
        if (record.reason === 'content' && !pkg.note) pkg.reason = record.detail
        pkg.note = record.reason
        keep(pkg, true)
      }
    },
    // The outcome of a tag this run skipped, which the Area's file records and the summary names. A tag whose Version
    // folder the docs already hold is recorded too: its bytes stay where they are, and a later run reuses the skip
    // instead of rebuilding the tag to find out it still does not fit. A Release publishing the tag clears the record
    // again. A tag that names nothing git holds is reported but never written.
    record(pkg) {
      // A record that already spoke for this tag keeps the outcome: this run did not derive the skip.
      if (skipped.has(pkg.tag)) return
      if (!pkg.note) return
      keep(pkg, false)
    },
    // The Area's own skips in tag order, so the bytes a run writes and the lines it reports agree.
    outcomes,
    // The bytes the Area's file holds after this run, or its removal when it records no skip anymore.
    change() {
      const tags = new Map()
      for (const [tag, skip] of skipped) if (skip.record !== null) tags.set(tag, skip.record)
      return skippedTagsChange({ rel: skippedTagsPath(areaDir), existed: records !== null, tags, repository })
    },
  }
}

// The one file edit that takes a tag a Release just published out of its Area's Skipped tags file: the bytes without
// it, or the removal when it recorded nothing else. Null when the file never recorded the tag.
export function planTagClear({ docs, areaDir, tag, repository }) {
  const records = readSkippedTags(docs, areaDir)
  if (!records?.has(tag)) return null
  records.delete(tag)
  return skippedTagsChange({ rel: skippedTagsPath(areaDir), existed: true, tags: records, repository })
}

// Applies an edit a Skipped tags decision made. A Reconcile plans every write of its attempt together and stages them
// at once, so this is for the edit a Release makes beside the publish it just decided.
export function applySkippedTagsChange(docs, change) {
  if (change.remove) fs.rmSync(path.join(docs, change.rel), { force: true })
  else writeFile(docs, change.rel, change.file)
}
