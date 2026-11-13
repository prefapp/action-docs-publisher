import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  cloneDocs, cloneSource, commitSource, entriesFile, featureFiles, git, makeDocsRemote,
  makeSource, meta, readRemote, readTree, releaseCommit, releaseEntry, remoteCommitCount,
  renderedScript, runPublisher, seedDocs,
} from '../test/harness.mjs'

const { readMarkerRecord } = await import(pathToFileURL(renderedScript('files.mjs')).href)
const DATE = '2026-01-02T03:04:05Z'
const AREA = 'site/raw/features'
const SOURCE = 'acme/source'
const BRANCH = { source: SOURCE, area: 'features', branch: 'main', sourceRevision: 'a'.repeat(40), date: DATE }
let world
beforeEach(() => { world = makeDocsRemote() })
afterEach(() => { world.cleanup() })

function sourceRepo() {
  const source = makeSource(world)
  releaseCommit(source, { ...featureFiles('alpha'), ...featureFiles('beta'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
  return source
}

function run(source, mode, before) {
  const after = git(source, 'rev-parse', 'HEAD')
  const planFile = join(world.base, 'plan.md')
  const result = runPublisher(cloneDocs(world), {
    source: cloneSource(world, source, 'checkout'),
    ...(mode === 'release' ? { tag: 'alpha-v1.0.0' }
      : mode === 'reconcile' ? { reconcile: true }
        : { before, after, ...(mode === 'plan' ? { plan: true, planFile } : {}) }),
  })
  return { ...result, text: mode === 'plan' ? readFileSync(planFile, 'utf8') : result.output }
}

describe('one validated record API for every marker', () => {
  const examples = [
    { kind: 'Version', marker: `${AREA}/alpha/1.0.0/.meta.json`, fields: { source: SOURCE, tag: 'alpha-v1.0.0', date: DATE, specHash: 'a'.repeat(64) } },
    { kind: 'Branch', marker: `${AREA}/alpha/main/.meta.json`, fields: BRANCH },
    { kind: 'Mirror', marker: `${AREA}/.meta.json`, fields: { source: SOURCE, sourceRevision: 'b'.repeat(64), sourceBranch: 'main', date: DATE } },
  ]

  test.each(examples)('$kind records carry their owner, Area and kind-specific fields', ({ kind, marker, fields }) => {
    expect(readMarkerRecord(meta(fields), marker, 'site/raw')).toEqual(expect.objectContaining({
      ...fields, kind, source: SOURCE, areaDir: AREA,
    }))
  })

  test.each(examples.flatMap((example) => Object.keys(example.fields).flatMap((field) => [undefined, ''].map((value) =>
    ({ ...example, field, value }))).filter(({ field, value }) => field !== 'specHash' || value !== undefined)))(
    '$kind refuses $field = $value with the same marker-path diagnostic',
    ({ marker, fields, field, value }) => {
      expect(() => readMarkerRecord(meta({ ...fields, [field]: value }), marker, 'site/raw'))
        .toThrow(`invalid .meta.json: ${marker}`)
    },
  )

  test.each(examples)('$kind refuses broken JSON with the same marker-path diagnostic', ({ marker }) => {
    expect(() => readMarkerRecord('{', marker, 'site/raw')).toThrow(`invalid .meta.json: ${marker}`)
  })
})

describe('validated marker records guard every affected Area', () => {
  test.each(['Branch', 'Version'].flatMap((kind) => ['entry', 'package'].flatMap((retirement) =>
    ['push', 'reconcile', 'plan'].map((mode) => ({ kind, retirement, mode })))))(
    '$mode refuses $retirement retirement when a foreign $kind record claims the Area',
    ({ kind, retirement, mode }) => {
      const source = sourceRepo()
      seedDocs(world, {
        [`${AREA}/alpha/1.0.0/.meta.json`]: meta({ source: SOURCE, tag: 'alpha-v1.0.0', date: DATE }),
        [`${AREA}/alpha/1.0.0/schema.json`]: 'OWN VERSION\n',
        [`${AREA}/alpha/${kind === 'Branch' ? 'main' : '2.0.0'}/.meta.json`]: meta(kind === 'Branch'
          ? { ...BRANCH, source: 'other/producer' }
          : { source: 'other/producer', tag: 'alpha-v2.0.0', date: DATE }),
        [`${AREA}/README.md`]: 'AREA FILE\n',
        [`${AREA}/index.json`]: '{}\n',
      })
      const tree = readTree(readRemote(world))
      const commits = remoteCommitCount(world)
      const before = git(source, 'rev-parse', 'HEAD')
      commitSource(source, retirement === 'entry' ? entriesFile([]) : { 'packages/alpha': null }, 'retire docs')

      const result = run(source, mode, before)

      expect(result.status).toBe(mode === 'plan' ? 0 : 2)
      expect(result.text).toContain('Area "features" belongs to other/producer, but this repo is acme/source. Choose another Area.')
      expect(result.text).not.toContain('Delete Area')
      expect(remoteCommitCount(world)).toBe(commits)
      expect(readTree(readRemote(world))).toEqual(tree)
    },
  )

  test.each([
    ['missing source', { source: undefined }],
    ['bad date', { date: 'not-a-date' }],
    ['bad sourceRevision', { sourceRevision: 'not-a-revision' }],
  ].flatMap(([damage, fields]) => ['push', 'reconcile', 'release', 'plan'].map((mode) => ({ damage, fields, mode }))))(
    '$mode refuses a Branch record with $damage before publishing or pruning',
    ({ fields, mode }) => {
      const source = sourceRepo()
      const before = git(source, 'rev-parse', 'HEAD')
      commitSource(source, entriesFile([releaseEntry({ prereleases: true })]), 'change entry')
      const marker = `${AREA}/alpha/main/.meta.json`
      seedDocs(world, { [marker]: meta({ ...BRANCH, ...fields }), [`${AREA}/alpha/main/keep.md`]: 'KEEP\n' })
      const tree = readTree(readRemote(world))
      const commits = remoteCommitCount(world)

      const result = run(source, mode, before)

      expect(result.status).toBe(mode === 'plan' ? 0 : 2)
      expect(result.text).toContain(`invalid .meta.json: ${marker}`)
      expect(remoteCommitCount(world)).toBe(commits)
      expect(readTree(readRemote(world))).toEqual(tree)
    },
  )
})
