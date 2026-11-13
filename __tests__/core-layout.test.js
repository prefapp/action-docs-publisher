import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import {
  branchMeta,
  cloneDocs,
  commitSource,
  entriesFile,
  exists,
  git,
  image,
  makeDocsRemote,
  makeSource,
  meta,
  mirrorEntry,
  mirrorMeta,
  readRemote,
  readTree,
  releaseCommit,
  remoteCommitCount,
  runPublisher,
  unnamedReleaseEntry,
  renderedScript,
} from '../test/harness.mjs'
import { CLAIMS_SCHEMA, CORE_CRDS, CORE_DOCS, CRDS_INDEX, coreFiles } from '../test/core-fixture.mjs'

const { specHash } = await import(renderedScript('entries.mjs'))

const DATE = '2026-01-02T03:04:05Z'

let world

beforeEach(() => {
  world = makeDocsRemote()
})

afterEach(() => {
  world.cleanup()
})

describe('the core CRDs as an unnamed release', () => {
  test('a v1.2.0 tag publishes the built index.yaml as core/crds/v1.2.0, with its .meta.json', () => {
    const source = makeSource(world)
    releaseCommit(source, coreFiles(), 'v1.2.0', DATE)
    const docs = cloneDocs(world)

    const run = runPublisher(docs, { source, tag: 'v1.2.0' })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readTree(landed, 'site/raw/core/crds/v1.2.0')).toEqual({
      'index.yaml': CRDS_INDEX,
      '.meta.json': meta({ source: 'acme/source', tag: 'v1.2.0', date: DATE, specHash: specHash(CORE_CRDS) }),
    })
  })

  test('a failing build pushes nothing', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      { ...coreFiles(), ...entriesFile([unnamedReleaseEntry({ build: 'exit 7' }), CORE_DOCS]) },
      'v1.2.0',
      DATE,
    )
    const docs = cloneDocs(world)
    const before = remoteCommitCount(world)

    const run = runPublisher(docs, { source, tag: 'v1.2.0' })

    expect(run.status).toBe(2)
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('a prerelease tag is skipped, and nothing is published for it', () => {
    const source = makeSource(world)
    releaseCommit(source, coreFiles(), 'v1.3.0-rc.1', DATE)
    const docs = cloneDocs(world)
    const before = remoteCommitCount(world)

    const run = runPublisher(docs, { source, tag: 'v1.3.0-rc.1' })

    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(before)
    expect(exists(readRemote(world), 'site/raw/core/crds/v1.3.0-rc.1')).toBe(false)
  })
})

describe('the core mirrors on a push to main', () => {
  test('publishes core/crds/main from the index its build reads from main', () => {
    const source = makeSource(world)
    releaseCommit(source, coreFiles(), 'v1.2.0', DATE)
    const docs = cloneDocs(world)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'docs/notes.md': '# Notes\n' }, 'notes on main')

    const run = runPublisher(docs, { source, before, after: git(source, 'rev-parse', 'HEAD') })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readTree(landed, 'site/raw/core/crds/main')).toEqual({
      '.meta.json': branchMeta(source, 'core/crds'),
      'index.yaml': CRDS_INDEX,
    })
  })

  test('publishes the core docs with their images, and the claims schema its build produced', () => {
    const source = makeSource(world)
    releaseCommit(source, coreFiles(), 'v1.2.0', DATE)
    const docs = cloneDocs(world)

    const run = runPublisher(docs, { source })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readTree(landed, 'site/raw/core/docs')).toEqual({
      '.meta.json': mirrorMeta(source),
      'generated/claims-schema.json': CLAIMS_SCHEMA,
      'images/logo.png': image('core-logo'),
      'index.md': '# Core\n\n![logo](images/logo.png)\n',
    })
  })

  test('a failing build in a mirror pushes nothing', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      { ...coreFiles(), ...entriesFile([CORE_CRDS, mirrorEntry({ area: 'core/docs', build: 'exit 4', collect: [{ from: 'docs/**', to: '.' }], paths: ['docs/**'] })]) },
      'v1.2.0',
      DATE,
    )
    const docs = cloneDocs(world)
    const before = remoteCommitCount(world)

    const run = runPublisher(docs, { source })

    expect(run.status).toBe(2)
    expect(run.output).toContain('build failed in the source checkout (exit 4)')
    expect(remoteCommitCount(world)).toBe(before)
    expect(exists(readRemote(world), 'site/raw/core/crds/main/index.yaml')).toBe(false)
  })
})
