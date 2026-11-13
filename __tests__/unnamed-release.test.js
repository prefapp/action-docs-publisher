import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import {
  cloneDocs,
  entriesFile,
  exists,
  featureFiles,
  makeDocsRemote,
  makeSource,
  meta,
  readFile,
  readJson,
  commitSource,
  readRemote,
  readTree,
  releaseCommit,
  releaseEntry,
  remoteCommitCount,
  runPublisher,
  unnamedReleaseEntry,
  renderedScript,
} from '../test/harness.mjs'

const { specHash } = await import(renderedScript('entries.mjs'))

const TAG = 'v1.2.0'
const DATE = '2026-01-02T03:04:05Z'
const CRDS = 'kind: CustomResourceDefinition\n'
const VERSION_DIR = 'site/raw/core/crds/v1.2.0'

let world

beforeEach(() => {
  world = makeDocsRemote()
})

afterEach(() => {
  world.cleanup()
})

function releaseWith(files = {}, entries = [unnamedReleaseEntry()], tag = TAG, date = DATE) {
  const source = makeSource(world)
  releaseCommit(source, { 'index.yaml': CRDS, ...entriesFile(entries), ...files }, tag, date)
  return source
}

describe('a v<semver> release tag', () => {
  test('publishes an unnamed Version folder, versions.json and latest copy', () => {
    const source = releaseWith()
    const docs = cloneDocs(world)

    const run = runPublisher(docs, { source, tag: TAG })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readJson(landed, 'site/raw/core/crds/versions.json')).toEqual([{ version: TAG, date: DATE, url: 'https://raw.githubusercontent.com/firestartr-pro/docs/main/site/raw/core/crds/v1.2.0/index.yaml' }])
    expect(readTree(landed, 'site/raw/core/crds/latest')).toEqual({ 'index.yaml': CRDS })
    expect(readTree(landed, VERSION_DIR)).toEqual({
      'index.yaml': CRDS,
      '.meta.json': meta({ source: 'acme/source', tag: TAG, date: DATE, specHash: specHash(unnamedReleaseEntry()) }),
    })
  })

  test('publishes another release when a Version folder contains collected nested meta.json', () => {
    const entries = [unnamedReleaseEntry({ mainFile: 'sub/meta.json', collect: [{ from: 'payload.json', to: 'sub/meta.json' }] })]
    const source = releaseWith({ 'payload.json': '{"doc":true}\n' }, entries)
    releaseCommit(source, { 'payload.json': '{"doc":"new"}\n' }, 'v1.3.0', '2026-02-01T00:00:00Z')
    const docs = cloneDocs(world)
    expect(runPublisher(docs, { source, tag: TAG }).status).toBe(0)

    const run = runPublisher(docs, { source, tag: 'v1.3.0' })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, `${VERSION_DIR}/sub/meta.json`)).toBe('{"doc":true}\n')
    expect(readFile(landed, 'site/raw/core/crds/v1.3.0/sub/meta.json')).toBe('{"doc":"new"}\n')
  })

  test('skips a prerelease unless an entry says it publishes prereleases', () => {
    const source = releaseWith({}, [unnamedReleaseEntry()], 'v1.3.0-rc.1')
    const docs = cloneDocs(world)
    const before = remoteCommitCount(world)

    const run = runPublisher(docs, { source, tag: 'v1.3.0-rc.1' })

    expect(run.status).toBe(0)
    expect(run.summary).toContain('prereleases: true')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('publishes a prerelease when the entry declares prereleases: true', () => {
    const source = releaseWith({}, [unnamedReleaseEntry({ prereleases: true })], 'v1.3.0-rc.1')
    const docs = cloneDocs(world)

    const run = runPublisher(docs, { source, tag: 'v1.3.0-rc.1' })

    expect(run.status).toBe(0)
    expect(exists(readRemote(world), 'site/raw/core/crds/v1.3.0-rc.1/.meta.json')).toBe(true)
  })

  test('reads Area files from source_branch even when publishing an older unnamed tag', () => {
    const entries = [unnamedReleaseEntry({ areaFiles: [{ from: 'README.md', to: 'README.md' }] })]
    const source = makeSource(world)
    releaseCommit(source, { 'index.yaml': CRDS, 'README.md': '# New\n', ...entriesFile(entries) }, 'v1.2.0', DATE)
    releaseCommit(source, { 'index.yaml': CRDS, 'README.md': '# Old\n', ...entriesFile(entries) }, 'v1.1.0', '2025-06-01T00:00:00Z')
    commitSource(source, { 'README.md': '# Branch\n' }, 'Area files on source_branch')
    const docs = cloneDocs(world)

    expect(runPublisher(docs, { source, tag: 'v1.2.0' }).status).toBe(0)
    expect(runPublisher(docs, { source, tag: 'v1.1.0' }).status).toBe(0)

    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/core/crds/README.md')).toBe('# Branch\n')
    expect(exists(landed, 'site/raw/core/crds/v1.1.0/.meta.json')).toBe(true)
  })

  test('a v<semver> tag publishes only the unnamed entries, not the named ones', () => {
    const source = mixedSource(TAG)
    const docs = cloneDocs(world)

    expect(runPublisher(docs, { source, tag: TAG }).status).toBe(0)

    const landed = readRemote(world)
    expect(exists(landed, 'site/raw/core/crds/v1.2.0/index.yaml')).toBe(true)
    expect(exists(landed, 'site/raw/features')).toBe(false)
  })

  test('a <name>-v<semver> tag publishes only the named entries, not the unnamed ones', () => {
    const source = mixedSource('docs_publisher-v1.0.0')
    const docs = cloneDocs(world)

    expect(runPublisher(docs, { source, tag: 'docs_publisher-v1.0.0' }).status).toBe(0)

    const landed = readRemote(world)
    expect(exists(landed, 'site/raw/features/docs_publisher/1.0.0/.meta.json')).toBe(true)
    expect(exists(landed, 'site/raw/core')).toBe(false)
  })
})

function mixedSource(tag) {
  const source = makeSource(world)
  releaseCommit(
    source,
    { ...featureFiles('docs_publisher'), 'index.yaml': CRDS, ...entriesFile([releaseEntry(), unnamedReleaseEntry()]) },
    tag,
    DATE,
  )
  return source
}
