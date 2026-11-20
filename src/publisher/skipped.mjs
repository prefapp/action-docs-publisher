import fs from 'node:fs'
import path from 'node:path'
import { specHash } from './entries.mjs'
import { FatalError, lstatOrNull, metaFile, writeFile } from './files.mjs'
import { SKIPPED_TAGS_FILE } from './area-names.mjs'

const REASONS = new Set(['retired', 'no folder', 'prerelease', 'content'])
const SPEC_SENSITIVE_REASONS = new Set(['content', 'no folder'])

const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const SPEC_HASH = /^[a-f0-9]{64}$/

export function skippedTagsPath(areaDir) {
  return path.posix.join(areaDir, SKIPPED_TAGS_FILE)
}

function readSkippedTagsFile(docs, areaDir) {
  const rel = skippedTagsPath(areaDir)
  const invalid = () => {
    throw new FatalError(`invalid ${SKIPPED_TAGS_FILE}: ${rel}`)
  }
  const stat = lstatOrNull(path.join(docs, rel))
  if (!stat) return null
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

export function readSkippedTags(docs, areaDir) {
  return readSkippedTagsFile(docs, areaDir)?.tags ?? null
}

export function skippedRecordAt(docs, areaDir) {
  const file = readSkippedTagsFile(docs, areaDir)
  return file === null ? null : { kind: 'Skipped', source: file.source, dir: areaDir, areaDir, rel: skippedTagsPath(areaDir) }
}

function skippedTagsFile({ source, tags }) {
  const sorted = [...tags].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return metaFile({ source, tags: Object.fromEntries(sorted) })
}

const byTag = (left, right) => (left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0)

function skippedTagsChange({ rel, existed, tags, repository }) {
  if (tags.size > 0) return { rel, file: skippedTagsFile({ source: repository, tags }) }
  return existed ? { rel, remove: true } : null
}

function skipRecord(pkg, spec) {
  const record = { sourceRevision: pkg.sourceRevision, reason: pkg.note }
  if (SPEC_SENSITIVE_REASONS.has(pkg.note)) record.specHash = spec
  if (pkg.note === 'content' && pkg.reason !== undefined) record.detail = pkg.reason
  return record
}

function skipOutcome(areaDir, pkg, reused) {
  return { areaDir, tag: pkg.tag, skip: pkg.note, detail: pkg.note === 'content' ? pkg.reason : undefined, reused }
}

export function planAreaSkips({ docs, areaDir, entry, repository }) {
  const records = readSkippedTags(docs, areaDir)
  const spec = specHash(entry)
  const skipped = new Map()
  const keep = (pkg, reused) => skipped.set(pkg.tag, {
    outcome: skipOutcome(areaDir, pkg, reused),
    record: pkg.note === 'missing tag' || pkg.sourceRevision === undefined ? null : skipRecord(pkg, spec),
  })
  const outcomes = () => [...skipped.values()].map(({ outcome }) => outcome).sort(byTag)
  return {
    reuse(pending) {
      if (!records) return
      for (const { pkg } of pending) {
        const record = records.get(pkg.tag)
        if (!record) continue
        if (record.sourceRevision !== pkg.sourceRevision) continue
        if (record.reason !== (pkg.note ?? 'content')) continue
        if (SPEC_SENSITIVE_REASONS.has(record.reason) && record.specHash !== spec) continue
        if (record.reason === 'content' && !pkg.note) pkg.reason = record.detail
        pkg.note = record.reason
        keep(pkg, true)
      }
    },
    record(pkg) {
      if (skipped.has(pkg.tag)) return
      if (!pkg.note) return
      keep(pkg, false)
    },
    outcomes,
    change() {
      const tags = new Map()
      for (const [tag, skip] of skipped) if (skip.record !== null) tags.set(tag, skip.record)
      return skippedTagsChange({ rel: skippedTagsPath(areaDir), existed: records !== null, tags, repository })
    },
  }
}

export function planTagClear({ docs, areaDir, tag, repository }) {
  const records = readSkippedTags(docs, areaDir)
  if (!records?.has(tag)) return null
  records.delete(tag)
  return skippedTagsChange({ rel: skippedTagsPath(areaDir), existed: true, tags: records, repository })
}

export function applySkippedTagsChange(docs, change) {
  if (change.remove) fs.rmSync(path.join(docs, change.rel), { force: true })
  else writeFile(docs, change.rel, change.file)
}
