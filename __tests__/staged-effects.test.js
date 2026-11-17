import { afterEach, beforeEach, expect, test } from '@jest/globals'
import {
  cloneDocs, cloneSource, commitSource, entriesFile, featureFiles, git, makeDocsRemote, makeSource,
  meta, mirrorEntry, releaseCommit, releaseEntry, runPublisher, seedDocs,
} from '../test/harness.mjs'

const DATE = '2026-01-02T03:04:05Z'
let world
beforeEach(() => { world = makeDocsRemote() })
afterEach(() => { world.cleanup() })

test.each(['reconcile', 'push'])('%s names only the retired Area when its prepared Areas stage no change', (mode) => {
  const source = makeSource(world)
  releaseCommit(source, {
    ...featureFiles('alpha'), 'docs/index.md': '# Docs\n',
    ...entriesFile([
      releaseEntry(), releaseEntry({ area: 'other' }), mirrorEntry(), mirrorEntry({ area: 'guide' }),
    ]),
  }, 'alpha-v1.0.0', DATE)
  const before = git(source, 'rev-parse', 'HEAD')
  if (mode === 'push') commitSource(source, { 'unrelated.txt': 'unrelated\n' }, 'ordinary push')
  const initial = runPublisher(cloneDocs(world, 'initial'), { source: cloneSource(world, source, 'initial-source'), reconcile: true })
  expect(initial.status).toBe(0)
  seedDocs(world, {
    'site/raw/old/.meta.json': meta({ source: 'acme/source', sourceRevision: 'a'.repeat(40), sourceBranch: 'main', date: DATE }),
    'site/raw/old/index.md': 'OLD\n',
  })

  const result = runPublisher(cloneDocs(world, 'run'), {
    source: cloneSource(world, source, 'run-source'), ...(mode === 'reconcile' ? { reconcile: true } : { before, after: git(source, 'rev-parse', 'HEAD') }),
  })

  expect(result.status).toBe(0)
  expect(git(world.remote, 'log', '-1', '--pretty=%s', 'main')).toBe('docs: prune old')
  expect(result.summary).not.toContain('Reconciled `features other`')
  expect(result.summary).not.toContain('Mirrored core/docs guide')
})

test('a reconcile that only deletes a file from a Branch Version folder names the release Area', () => {
  const source = makeSource(world)
  releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ publishSourceBranch: true })]) }, 'alpha-v1.0.0', DATE)
  const initial = runPublisher(cloneDocs(world, 'initial'), { source: cloneSource(world, source, 'initial-source'), reconcile: true })
  expect(initial.status).toBe(0)
  seedDocs(world, { 'site/raw/features/alpha/main/obsolete.txt': 'OBSOLETE\n' })

  const result = runPublisher(cloneDocs(world, 'run'), { source: cloneSource(world, source, 'run-source'), reconcile: true })

  expect(result.status).toBe(0)
  expect(git(world.remote, 'show', '--format=', '--name-status', 'main')).toBe('D\tsite/raw/features/alpha/main/obsolete.txt')
  expect(git(world.remote, 'log', '-1', '--pretty=%s', 'main')).toBe('docs: reconcile features')
  expect(result.summary).toContain('Reconciled `features` to `main`.')
})

test('a file that moves from a release Area to a Mirror Area names both Areas', () => {
  const source = makeSource(world)
  releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
  const initial = runPublisher(cloneDocs(world, 'initial'), { source: cloneSource(world, source, 'initial-source'), reconcile: true })
  expect(initial.status).toBe(0)
  commitSource(source, entriesFile([
    releaseEntry({ areaFiles: [] }),
    mirrorEntry({ area: 'guide', collect: [{ from: 'README.md', to: 'README.md' }], paths: ['README.md'] }),
  ]), 'move landing page')

  const result = runPublisher(cloneDocs(world, 'run'), { source: cloneSource(world, source, 'run-source'), reconcile: true })

  expect(result.status).toBe(0)
  expect(git(world.remote, 'log', '-1', '--pretty=%s', 'main')).toBe('docs: reconcile features guide')
  expect(result.summary).toContain('Reconciled `features` to `main`.')
})
