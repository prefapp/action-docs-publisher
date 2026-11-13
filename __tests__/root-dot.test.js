import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SOURCE_REPO,
  cloneDocs,
  cloneSource,
  commitSource,
  entriesFile,
  exists,
  featureFiles,
  git,
  makeDocsRemote,
  makeSource,
  meta,
  mirrorEntry,
  readFile,
  readJson,
  readRemote,
  releaseCommit,
  releaseEntry,
  runPublisher,
  seedDocs,
} from '../test/harness.mjs'

// The docs repo may be only a documentation repo: with a root of `.`, each Area sits at the top of the checkout
// instead of under a folder such as `site/raw`. Every run mode has to work there, and the docs repo's own files have
// to survive it.
const TAG = 'alpha-v1.0.0'
const DATE = '2026-01-02T03:04:05Z'

let world

beforeEach(() => {
  world = makeDocsRemote()
})

afterEach(() => {
  world.cleanup()
})

const docsCheckout = () => cloneDocs(world, `docs-${Math.random().toString(36).slice(2)}`)
const sourceCheckout = (source) => cloneSource(world, source, `checkout-${Math.random().toString(36).slice(2)}`)

function releaseSource(entries = [releaseEntry()]) {
  const source = makeSource(world)
  releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile(entries) }, TAG, DATE)
  return source
}

// The docs repo's own files: a README, site config and a workflow, none of them an Area.
const DOCS_OWN_FILES = {
  'README.md': '# Docs site\n',
  'mkdocs.yml': 'site_name: Docs\n',
  '.github/workflows/site.yml': 'name: site\n',
}

describe('a dot root publishes at the top of the docs repo', () => {
  test('a release', () => {
    const source = releaseSource()

    const run = runPublisher(docsCheckout(), { source, tag: TAG, root: '.' })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, 'features/alpha/1.0.0/intro.md')).toBe('# alpha\n')
    expect(readJson(landed, 'features/alpha/versions.json')).toEqual([{
      version: '1.0.0',
      date: DATE,
      url: 'https://raw.githubusercontent.com/firestartr-pro/docs/main/features/alpha/1.0.0/schema.json',
    }])
    // No URL carries the dot root's `/./` or a leading `./`.
    expect(JSON.stringify(readJson(landed, 'features/index.json'))).not.toMatch(/(^|\/)\.[/"]/)
    expect(readFile(landed, 'README.md')).toBe('# docs\n')
  })

  test('a mirror', () => {
    const source = makeSource(world)
    commitSource(source, { 'docs/index.md': '# Docs\n', ...entriesFile([mirrorEntry()]) }, 'mirror')

    const run = runPublisher(docsCheckout(), { source, root: '.', reconcile: true })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, 'core/docs/index.md')).toBe('# Docs\n')
    expect(readFile(landed, 'README.md')).toBe('# docs\n')
  })

  test('a push', () => {
    const source = makeSource(world)
    commitSource(source, { 'docs/index.md': '# Docs\n', ...entriesFile([mirrorEntry()]) }, 'mirror')

    const run = runPublisher(docsCheckout(), { source, root: '.' })

    expect(run.status).toBe(0)
    expect(readFile(readRemote(world), 'core/docs/index.md')).toBe('# Docs\n')
  })

  test('a prune', () => {
    const source = releaseSource()
    seedDocs(world, {
      'stale/v1.0.0/.meta.json': meta({ source: SOURCE_REPO, tag: 'v1.0.0', date: DATE }),
      'stale/v1.0.0/index.md': '# Stale\n',
      'other/notes.md': '# Another repo\n',
    })

    const run = runPublisher(docsCheckout(), { source: sourceCheckout(source), root: '.', reconcile: true })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(exists(landed, 'stale')).toBe(false)
    // A folder no marker names is not the publisher's to delete.
    expect(readFile(landed, 'other/notes.md')).toBe('# Another repo\n')
    expect(readFile(landed, 'features/alpha/1.0.0/intro.md')).toBe('# alpha\n')
  })

  test('a plan', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([]) }, TAG, DATE)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([releaseEntry()]))
    const checkout = sourceCheckout(source)
    const head = git(checkout, 'rev-parse', 'HEAD')
    git(checkout, 'checkout', '--quiet', '--detach', head)
    const docs = docsCheckout()
    const docsHead = git(docs, 'rev-parse', 'HEAD')
    const remoteHead = git(world.remote, 'rev-parse', 'main')
    const planFile = join(world.base, 'plan.md')
    const snapshots = join(world.base, 'snapshots')
    mkdirSync(snapshots)

    const run = runPublisher(docs, {
      source: checkout, root: '.', plan: true, planFile, before, after: head,
      env: { RUNNER_TEMP: snapshots },
    })

    expect(run.status).toBe(0)
    const body = readFileSync(planFile, 'utf8')
    expect(body).toContain('### `features`')
    expect(body).toContain('- Add version `alpha/1.0.0`.')
    expect(git(docs, 'rev-parse', 'HEAD')).toBe(docsHead)
    expect(git(world.remote, 'rev-parse', 'main')).toBe(remoteHead)
  })
})

describe('the docs repo keeps its own files with a dot root', () => {
  test('they survive a prune and a reconcile', () => {
    const source = releaseSource()
    seedDocs(world, {
      ...DOCS_OWN_FILES,
      'stale/v1.0.0/.meta.json': meta({ source: SOURCE_REPO, tag: 'v1.0.0', date: DATE }),
      'stale/v1.0.0/index.md': '# Stale\n',
    })

    const first = runPublisher(docsCheckout(), { source: sourceCheckout(source), root: '.', reconcile: true })
    expect(first.status).toBe(0)
    expect(exists(readRemote(world), 'stale')).toBe(false)

    // A second reconcile finds nothing to do, and the same files are still there.
    const second = runPublisher(docsCheckout(), { source: sourceCheckout(source), root: '.', reconcile: true })
    expect(second.status).toBe(0)

    const landed = readRemote(world)
    for (const [rel, content] of Object.entries(DOCS_OWN_FILES)) {
      expect(readFile(landed, rel)).toBe(content)
    }
    expect(exists(landed, '.git/config')).toBe(true)
    expect(readFile(landed, 'features/alpha/1.0.0/intro.md')).toBe('# alpha\n')
  })
})
