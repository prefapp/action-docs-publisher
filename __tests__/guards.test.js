import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { cloneDocs, entriesFile, featureFiles, makeDocsRemote, makeSource, meta, git, readTree, releaseCommit, releaseEntry, remoteCommitCount, runPublisher, seedDocs } from '../test/harness.mjs'

let world
beforeEach(() => { world = makeDocsRemote() })
afterEach(() => { world.cleanup() })
const DATE = '2026-01-02T03:04:05Z'
const marker = (source = 'acme/source') => meta({ source, tag: 'old-v1.0.0', date: DATE })
const ownership = 'Area "features" belongs to other/repo, but this repo is acme/source. Choose another Area. If this repo was renamed or is taking over the Area, update "source" in that Area\'s .meta.json files in the docs repo.'

function publish(files) {
  const source = makeSource(world)
  releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ mainFile: 'schema.json' })]) }, 'alpha-v2.0.0', DATE)
  seedDocs(world, files)
  const docs = cloneDocs(world)
  const before = remoteCommitCount(world)
  const tree = readTree(docs)
  const run = runPublisher(docs, { source, tag: 'alpha-v2.0.0' })
  expect(run.status).toBe(2)
  expect(remoteCommitCount(world)).toBe(before)
  expect(readTree(docs)).toEqual(tree)
  return run
}

describe('release Area guards', () => {
  test('lists missing metadata, invalid metadata, foreign sources and half-deleted packages in one error before any write', () => {
    const run = publish({
      'site/raw/features/missing/1.0.0/README.md': '# no marker',
      'site/raw/features/broken/1.0.0/.meta.json': '{',
      'site/raw/features/foreign/1.0.0/.meta.json': marker('other/repo'),
      'site/raw/features/deleted/versions.json': '[]',
      'site/raw/features/copy/README.md': '# stranded latest',
    })
    expect(run.output).toContain('Version folder site/raw/features/missing/1.0.0 has no .meta.json')
    expect(run.output).toContain('invalid .meta.json: site/raw/features/broken/1.0.0/.meta.json')
    expect(run.output).toContain(ownership)
    expect(run.output).toContain('half-deleted package: site/raw/features/deleted has shared files or a latest copy but no Version folders')
    expect(run.output).toContain('half-deleted package: site/raw/features/copy has shared files or a latest copy but no Version folders')
  })

  test.each(['null', '[]', '{"source":"acme/source"}', '{"source":"acme/source","tag":"old-v1.0.0","date":"soon"}', '{"source":"acme/source","tag":"old-v1.0.0","date":"2026-01-02T03:04:05Z","specHash":123}'])('refuses invalid Version metadata: %s', (content) => {
    expect(publish({ 'site/raw/features/old/1.0.0/.meta.json': content }).output).toContain('invalid .meta.json: site/raw/features/old/1.0.0/.meta.json')
  })

  test.each([
    ['features/sub', { 'site/raw/features/old/1.0.0/.meta.json': marker() }, 'it sits inside a release Area at site/raw/features'],
    ['features', { 'site/raw/features/.meta.json': meta({ source: 'other/repo', sourceRevision: 'a'.repeat(40), sourceBranch: 'main', date: DATE }) }, 'it sits inside a mirror Area at site/raw/features'],
    ['features/sub', { 'site/raw/features/.meta.json': meta({ source: 'acme/source', area: 'features', sourceRevision: 'a'.repeat(40), sourceBranch: 'main', date: DATE }) }, 'it sits inside a mirror Area at site/raw/features'],
    ['features/old/1.0.0/reference', { 'site/raw/features/old/1.0.0/.meta.json': marker() }, 'it sits inside a Version folder'],
  ])('refuses release Area %s inside another Area', (area, files, message) => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ area, mainFile: 'schema.json' })]) }, 'alpha-v2.0.0', DATE)
    seedDocs(world, files)
    const docs = cloneDocs(world)
    const tree = readTree(docs)
    const before = remoteCommitCount(world)
    const run = runPublisher(docs, { source, tag: 'alpha-v2.0.0' })
    expect(run.status).toBe(2)
    expect(run.output).toContain(message)
    expect(remoteCommitCount(world)).toBe(before)
    expect(readTree(docs)).toEqual(tree)
  })

  test.each(['old/1.0.0/.meta.json', 'old/1.0.0/images', 'old/versions.json', 'index.json', 'old'])('refuses symlink %s before writing', (rel) => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ mainFile: 'schema.json' })]) }, 'alpha-v2.0.0', DATE)
    const docs = cloneDocs(world)
    const target = join(docs, 'site/raw/features', rel)
    mkdirSync(join(target, '..'), { recursive: true })
    if (rel !== 'old' && rel !== 'old/1.0.0/.meta.json' && rel !== 'index.json') {
      const markerPath = join(docs, 'site/raw/features/old/1.0.0/.meta.json')
      mkdirSync(join(markerPath, '..'), { recursive: true })
      // A real Version folder makes every shared-file target managed.
      writeFileSync(markerPath, marker())
    }
    symlinkSync('/nonexistent-docs-publisher-target', target)
    git(docs, 'add', '-A'); git(docs, 'commit', '-m', 'symlink'); git(docs, 'push', 'origin', 'main')
    const before = remoteCommitCount(world)
    const run = runPublisher(docs, { source, tag: 'alpha-v2.0.0' })
    expect(run.status).toBe(2)
    expect(run.output).toContain('symlink')
    expect(remoteCommitCount(world)).toBe(before)
    expect(git(docs, 'status', '--porcelain')).toBe('')
  })

  test.each(['index.json', 'old/versions.json'])('refuses a folder blocking shared file %s', (rel) => {
    const run = publish({ 'site/raw/features/old/1.0.0/.meta.json': marker(), [`site/raw/features/${rel}/keep`]: 'keep' })
    expect(run.output).toContain(`not a file: site/raw/features/${rel}`)
  })

  test('names the foreign Mirror Area inside a release Area instead of clearing it', () => {
    const run = publish({
      'site/raw/features/old/1.0.0/.meta.json': marker(),
      'site/raw/features/old/manual/.meta.json': meta({ source: 'other/repo', sourceRevision: 'a'.repeat(40), sourceBranch: 'main', date: DATE }),
      'site/raw/features/old/manual/README.md': '# mirror',
    })
    expect(run.output).toContain(
      'refusing to publish site/raw/features: it holds the Mirror Area site/raw/features/old/manual, and a Mirror Area cannot sit inside a release Area. Choose another Area.',
    )
  })

  test('rejects same-run nested release Areas before either Area is written', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ area: 'features' }), releaseEntry({ area: 'features/sub' })]) }, 'alpha-v2.0.0', DATE)
    const docs = cloneDocs(world)
    const before = remoteCommitCount(world)
    const run = runPublisher(docs, { source, tag: 'alpha-v2.0.0' })
    expect(run.status).toBe(2)
    expect(run.output).toContain('release Area "features/sub" sits inside Area "features"')
    expect(remoteCommitCount(world)).toBe(before)
    expect(readTree(docs)).toEqual({})
  })

  test('aggregates guards across all published Areas', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ area: 'one' }), releaseEntry({ area: 'two' })]) }, 'alpha-v2.0.0', DATE)
    seedDocs(world, { 'site/raw/one/old/1.0.0/.meta.json': '{', 'site/raw/two/old/1.0.0/README.md': '# unmarked' })
    const docs = cloneDocs(world)
    const tree = readTree(docs)
    const run = runPublisher(docs, { source, tag: 'alpha-v2.0.0' })
    expect(run.status).toBe(2)
    expect(run.output).toContain('invalid .meta.json: site/raw/one/old/1.0.0/.meta.json')
    expect(run.output).toContain('Version folder site/raw/two/old/1.0.0 has no .meta.json')
    expect(readTree(docs)).toEqual(tree)
  })

  test('ownership belongs to the first source, with the specified handover message', () => {
    const run = publish({ 'site/raw/features/old/1.0.0/.meta.json': marker('other/repo') })
    expect(run.output).toContain(ownership)
  })
})
