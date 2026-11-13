import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import {
  ROOT,
  cloneDocs,
  cloneSource,
  commitSource,
  entriesFile,
  featureFiles,
  makeDocsRemote,
  makeSource,
  mirrorEntry,
  readRemote,
  readTree,
  releaseCommit,
  releaseEntry,
  remoteCommitCount,
  runPublisher,
} from '../test/harness.mjs'

const TAG = 'docs_publisher-v1.0.0'
const DATE = '2026-01-02T03:04:05Z'

let world

beforeEach(() => {
  world = makeDocsRemote()
})

afterEach(() => {
  world.cleanup()
})

function release() {
  const source = makeSource(world)
  releaseCommit(source, { ...featureFiles('docs_publisher'), ...entriesFile([releaseEntry()]) }, TAG, DATE)
  return source
}

function expectFatal(run, detail) {
  expect(run.status).toBe(2)
  expect(run.output).toContain(detail)
}

describe('a release run publishes where its options say', () => {
  test('publishes under the root the args name, and nothing under the default root', () => {
    const source = release()

    const run = runPublisher(cloneDocs(world), { source, tag: TAG, root: 'docs/raw' })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readTree(landed, 'docs/raw')['features/docs_publisher/1.0.0/intro.md']).toBe('# docs_publisher\n')
    expect(readTree(landed, ROOT)).toEqual({})
  })

  test('exits 2 when the root is not a normalized folder, and pushes nothing', () => {
    const source = release()
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, tag: TAG, root: 'site/../raw' })

    expectFatal(run, 'root "site/../raw" must be a normalized folder')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test.each([
    ['an absolute root', '/site/raw', 'root must be a relative path inside the repo'],
    ['a root that leaves the repo', '../site', 'root must not leave the repo'],
    ['an empty root', '', 'root must be a relative path inside the repo'],
    ['a root with a backslash', 'site\\raw', 'root must be a relative path inside the repo'],
    ['a dot root', '.', 'must be a normalized folder'],
  ])('exits 2 on %s, and pushes nothing', (_, root, detail) => {
    const source = release()
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, tag: TAG, root })

    expectFatal(run, detail)
    expect(remoteCommitCount(world)).toBe(before)
  })

  test.each(['.git', '.git/raw', 'site/.git/raw'])('exits 2 on root %s inside the .git folder, and pushes nothing', (root) => {
    const source = release()
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, tag: TAG, root })

    expectFatal(run, `root "${root}" uses ".git", the Git administrative folder`)
    expect(remoteCommitCount(world)).toBe(before)
  })

  test.each(['', 'docs', 'https://github.com/acme/docs', 'acme/docs/extra'])('rejects invalid destination repository %s before publishing', (docsRepository) => {
    const source = release()
    const before = remoteCommitCount(world)
    const run = runPublisher(cloneDocs(world), { source, tag: TAG, docsRepository })
    expectFatal(run, 'docs-repository must be org/repo')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('exits 2 on an empty branch, and pushes nothing', () => {
    const source = release()
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, tag: TAG, branch: '' })

    expectFatal(run, 'branch must not be empty')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test.each([
    ['root', { root: null }],
    ['branch', { branch: null }],
    ['source-branch', { sourceBranch: null }],
    ['docs-repository', { docsRepository: null }],
  ])('exits 2 when --%s is missing, and pushes nothing', (name, options) => {
    const source = release()
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, tag: TAG, ...options })

    expectFatal(run, `missing --${name}`)
    expect(remoteCommitCount(world)).toBe(before)
  })
})

describe('every trigger publishes where its options say', () => {
  test.each([
    ['a push to main', () => {
      const source = makeSource(world)
      commitSource(source, { 'docs/index.md': 'mirror\n', ...entriesFile([mirrorEntry()]) }, 'push to main')
      return { source }
    }],
    ['a Reconcile', () => {
      const source = makeSource(world)
      releaseCommit(
        source,
        { ...featureFiles('docs_publisher'), ...entriesFile([releaseEntry()]) },
        TAG,
        DATE,
      )
      const checkout = cloneSource(world, source, 'reconcile-source')
      return { source: checkout, reconcile: true }
    }],
  ])('%s publishes under the root the args name', (_, options) => {
    const { source, ...rest } = options()

    const run = runPublisher(cloneDocs(world), { source, root: 'docs/raw', ...rest })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readTree(landed, 'docs/raw')).not.toEqual({})
    expect(readTree(landed, ROOT)).toEqual({})
  })
})
