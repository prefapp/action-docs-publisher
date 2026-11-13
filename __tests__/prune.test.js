import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import {
  cloneDocs,
  cloneSource,
  commitSource,
  entriesFile,
  exists,
  featureFiles,
  makeDocsRemote,
  makeSource,
  meta,
  mirrorEntry,
  readFile,
  readJson,
  readRemote,
  releaseCommit,
  releaseEntry,
  remoteCommitCount,
  runPublisher,
  runReconcile,
  seedDocs,
  unnamedReleaseEntry,
  write,
  renderedScript,
} from '../test/harness.mjs'

const { applyPrune, planPrune } = await import(renderedScript('prune.mjs'))

let world
beforeEach(() => { world = makeDocsRemote() })
afterEach(() => { world.cleanup() })

const DATE = '2026-01-02T03:04:05Z'
const FEATURES = 'site/raw/features'
const CRDS = 'site/raw/core/crds'
const REPO = 'acme/source'

// A source with two released packages, both already published by a first manual run.
function publishedSource(entries = [releaseEntry()]) {
  const source = makeSource(world)
  releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile(entries) }, 'alpha-v1.0.0', DATE)
  releaseCommit(source, featureFiles('beta'), 'beta-v1.0.0', DATE)
  const run = runManual(source)
  expect(run.status).toBe(0)
  return source
}

function runManual(source) {
  return runReconcile(world, source)
}

// A push run: no tag and no --reconcile.
function runPush(source) {
  return runPublisher(cloneDocs(world, `docs-${Math.random()}`), {
    source: cloneSource(world, source, `checkout-${Math.random()}`),
  })
}

test('classifies gone Areas, mode changes and gone packages independently of their reason text', () => {
  const source = makeSource(world)
  commitSource(source, featureFiles('alpha'))
  const mirror = meta({ source: REPO, sourceRevision: 'a'.repeat(40), sourceBranch: 'main', date: DATE })
  seedDocs(world, {
    'site/raw/removed-mirror/.meta.json': mirror,
    'site/raw/mirror-to-release/.meta.json': mirror,
    'site/raw/removed-release/old/1.0.0/.meta.json': meta({ source: REPO, tag: 'old-v1.0.0', date: DATE }),
    'site/raw/release-to-mirror/v1.0.0/.meta.json': meta({ source: REPO, tag: 'v1.0.0', date: DATE }),
    [`${FEATURES}/gone/1.0.0/.meta.json`]: meta({ source: REPO, tag: 'gone-v1.0.0', date: DATE }),
  })

  const prune = planPrune({
    docs: cloneDocs(world), source, root: 'site/raw', repository: REPO,
    entries: [releaseEntry(), releaseEntry({ area: 'mirror-to-release' }), mirrorEntry({ area: 'release-to-mirror' })],
  })

  expect(prune.removals).toEqual([
    { dir: 'site/raw/mirror-to-release', areaDir: 'site/raw/mirror-to-release', kind: 'mode-change', reason: 'its entry is now in release mode' },
    { dir: 'site/raw/removed-mirror', areaDir: 'site/raw/removed-mirror', kind: 'area-gone', reason: 'its entry is gone from docs_publisher.yaml' },
    { dir: `${FEATURES}/gone`, areaDir: FEATURES, kind: 'package-gone', reason: '`packages/gone` is gone from the source repo' },
    { dir: 'site/raw/release-to-mirror/v1.0.0', areaDir: 'site/raw/release-to-mirror', kind: 'mode-change', reason: 'its entry is now in mirror mode' },
    { dir: 'site/raw/release-to-mirror/latest', areaDir: 'site/raw/release-to-mirror', kind: 'mode-change', reason: 'its entry is now in mirror mode' },
    { dir: 'site/raw/removed-release/old', areaDir: 'site/raw/removed-release', kind: 'area-gone', reason: 'its entry is gone from docs_publisher.yaml' },
  ])
})

describe('pruning a package that is gone from the source repo', () => {
  test.each([
    ['a manual run', runManual],
    ['a push', runPush],
  ])('%s deletes the package and drops its index.json row', (_name, run) => {
    const source = publishedSource()
    commitSource(source, { 'packages/beta': null }, 'remove beta')

    const result = run(source)

    expect(result.status).toBe(0)
    const landed = readRemote(world)
    expect(exists(landed, `${FEATURES}/beta`)).toBe(false)
    expect(exists(landed, `${FEATURES}/alpha/1.0.0/.meta.json`)).toBe(true)
    expect(readJson(landed, `${FEATURES}/index.json`).features.map((row) => row.name)).toEqual(['alpha'])
    expect(readFile(landed, `${FEATURES}/README.md`)).toBe('# Features\n')
    expect(result.summary).toContain('Pruned `site/raw/features/beta`')
    expect(result.summary).toContain('`packages/beta` is gone from the source repo')
  })

  test('is a no-op on the next run', () => {
    const source = publishedSource()
    commitSource(source, { 'packages/beta': null }, 'remove beta')
    expect(runManual(source).status).toBe(0)
    const before = remoteCommitCount(world)

    const again = runManual(source)

    expect(again.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(before)
    expect(again.summary).not.toContain('Pruned')
  })

  test('does not republish the tags of a retired package, and says so', () => {
    const source = publishedSource()
    commitSource(source, { 'packages/beta': null }, 'remove beta')

    const run = runManual(source)

    expect(run.status).toBe(0)
    expect(exists(readRemote(world), `${FEATURES}/beta`)).toBe(false)
    expect(run.summary).toContain('`beta-v1.0.0`: the package folder is gone from `main`, so the package is retired')
  })

  test('says when a tag has no package folder at that commit', () => {
    const source = makeSource(world)
    commitSource(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha')
    releaseCommit(source, { 'packages/alpha': null, ...featureFiles('beta') }, 'alpha-v1.0.0', DATE)
    commitSource(source, featureFiles('alpha'), 'alpha is back')

    const run = runManual(source)

    expect(run.status).toBe(0)
    expect(run.summary).toContain('`alpha-v1.0.0`: the package folder does not exist at that tag')
  })

  test('warns when a pruned version has no tag to rebuild it from', () => {
    const source = publishedSource()
    seedDocs(world, {
      [`${FEATURES}/beta/0.5.0/.meta.json`]: meta({ source: REPO, tag: 'beta-v0.5.0', date: DATE }),
      [`${FEATURES}/beta/0.5.0/schema.json`]: 'legacy',
    })
    commitSource(source, { 'packages/beta': null }, 'remove beta')

    const run = runManual(source)

    expect(run.status).toBe(0)
    expect(exists(readRemote(world), `${FEATURES}/beta`)).toBe(false)
    expect(run.summary).toContain('pruned `site/raw/features/beta/0.5.0` has no tag `beta-v0.5.0`')
  })

  test('refuses to prune from a checkout that has no packages folder, and pushes nothing', () => {
    const source = publishedSource()
    commitSource(source, { packages: null }, 'remove every package')
    const before = remoteCommitCount(world)

    const run = runManual(source)

    expect(run.status).toBe(2)
    expect(run.output).toContain('the packages folder "packages" is not in the source checkout')
    expect(remoteCommitCount(world)).toBe(before)
    expect(exists(readRemote(world), `${FEATURES}/alpha/1.0.0/.meta.json`)).toBe(true)
  })

  test('stops, with no commit, when the package also holds Version folders of another repo', () => {
    const source = publishedSource()
    seedDocs(world, {
      [`${FEATURES}/beta/2.0.0/.meta.json`]: meta({ source: 'other/repo', tag: 'beta-v2.0.0', date: DATE }),
      [`${FEATURES}/beta/2.0.0/schema.json`]: 'FOREIGN',
    })
    commitSource(source, { 'packages/beta': null }, 'remove beta')
    const before = remoteCommitCount(world)

    const run = runManual(source)

    expect(run.status).toBe(2)
    expect(run.output).toContain('Area "features" belongs to other/repo, but this repo is acme/source. Choose another Area.')
    expect(run.output).toContain('other/repo')
    expect(remoteCommitCount(world)).toBe(before)
    expect(readFile(readRemote(world), `${FEATURES}/beta/2.0.0/schema.json`)).toBe('FOREIGN')
  })

  test.each([
    ['no marker', { [`${FEATURES}/beta/0.9.0/README.md`]: 'UNKNOWN OWNER, NO TAG\n' }, `Version folder ${FEATURES}/beta/0.9.0 has no .meta.json`],
    ['a folder where the marker belongs', { [`${FEATURES}/beta/0.9.0/.meta.json/not-json`]: 'damaged marker\n' }, `invalid .meta.json: ${FEATURES}/beta/0.9.0/.meta.json`],
  ])('stops, deleting nothing, when a Version folder under the package has %s', (_name, files, problem) => {
    const source = publishedSource()
    seedDocs(world, files)
    commitSource(source, { 'packages/beta': null }, 'remove beta')
    const before = remoteCommitCount(world)

    const run = runManual(source)

    expect(run.status).toBe(2)
    expect(run.output).toContain(`docs_publisher: ${problem}`)
    expect(remoteCommitCount(world)).toBe(before)
    const landed = readRemote(world)
    expect(exists(landed, `${FEATURES}/beta/0.9.0`)).toBe(true)
    expect(exists(landed, `${FEATURES}/beta/1.0.0/.meta.json`)).toBe(true)
    expect(exists(landed, `${FEATURES}/alpha/1.0.0/.meta.json`)).toBe(true)
  })
})

describe('pruning an Area whose entry is gone', () => {
  function twoAreaSource() {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), 'index.yaml': 'v1', ...entriesFile([releaseEntry(), unnamedReleaseEntry()]) }, 'alpha-v1.0.0', DATE)
    releaseCommit(source, { 'index.yaml': 'crds v1' }, 'v1.0.0', DATE)
    expect(runManual(source).status).toBe(0)
    return source
  }

  test.each([
    ['a manual run', runManual],
    ['a push', runPush],
  ])('%s deletes a release Area, shared files included, and keeps the others', (_name, run) => {
    const source = twoAreaSource()
    expect(exists(readRemote(world), `${CRDS}/v1.0.0/.meta.json`)).toBe(true)
    commitSource(source, entriesFile([releaseEntry()]), 'drop the crds entry')

    const result = run(source)

    expect(result.status).toBe(0)
    const landed = readRemote(world)
    expect(exists(landed, CRDS)).toBe(false)
    expect(exists(landed, `${FEATURES}/alpha/1.0.0/.meta.json`)).toBe(true)
    expect(result.summary).toContain('its entry is gone from docs_publisher.yaml')
  })

  test('leaves an Area alone when it holds no folder of this repo', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
    seedDocs(world, {
      [`${CRDS}/v1.0.0/.meta.json`]: meta({ source: 'firestartr-pro/firestartr', tag: 'v1.0.0', date: DATE }),
      [`${CRDS}/v1.0.0/index.yaml`]: 'THEIRS',
      [`${CRDS}/versions.json`]: '[]\n',
    })

    const run = runManual(source)

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, `${CRDS}/v1.0.0/index.yaml`)).toBe('THEIRS')
    expect(exists(landed, `${CRDS}/versions.json`)).toBe(true)
  })

  test('deletes an owned Mirror Area with no entry, but not one of another repo', () => {
    const source = makeSource(world)
    commitSource(source, { 'docs/a.md': '# a', ...entriesFile([mirrorEntry({ area: 'core/docs' })]) }, 'mirror entry')
    seedDocs(world, {
      'site/raw/core/old/.meta.json': meta({ source: REPO, sourceRevision: 'a'.repeat(40), sourceBranch: 'main', date: DATE }),
      'site/raw/core/old/page.md': '# old',
      'site/raw/core/other/.meta.json': meta({ source: 'other/repo', sourceRevision: 'b'.repeat(40), sourceBranch: 'main', date: DATE }),
      'site/raw/core/other/page.md': '# theirs',
    })

    const run = runPush(source)

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(exists(landed, 'site/raw/core/old')).toBe(false)
    expect(readFile(landed, 'site/raw/core/other/page.md')).toBe('# theirs')
    expect(readFile(landed, 'site/raw/core/docs/a.md')).toBe('# a')
    expect(run.summary).toContain('Pruned `site/raw/core/old`')
  })

  test('keeps a Mirror Area nested in the pruned Area', () => {
    const source = makeSource(world)
    releaseCommit(source, { 'index.yaml': 'v1', 'docs/n.md': '# nested', ...entriesFile([unnamedReleaseEntry()]) }, 'v1.0.0', DATE)
    expect(runManual(source).status).toBe(0)
    seedDocs(world, {
      [`${CRDS}/feat/.meta.json`]: meta({ source: REPO, sourceRevision: 'c'.repeat(40), sourceBranch: 'main', date: DATE }),
      [`${CRDS}/feat/n.md`]: '# nested',
    })
    commitSource(source, entriesFile([mirrorEntry({ area: 'core/crds/feat', collect: [{ from: 'docs/**', to: '.' }], paths: ['docs/**'] })]), 'mirror only')

    const run = runManual(source)

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(exists(landed, `${CRDS}/v1.0.0`)).toBe(false)
    expect(exists(landed, `${CRDS}/versions.json`)).toBe(false)
    expect(readFile(landed, `${CRDS}/feat/n.md`)).toBe('# nested')
  })
})

describe('an Area that changes mode', () => {
  test('a mirror that became a release Area is replaced by its versions', () => {
    const source = makeSource(world)
    releaseCommit(source, { 'index.yaml': 'v1', ...entriesFile([unnamedReleaseEntry()]) }, 'v1.0.0', DATE)
    seedDocs(world, {
      [`${CRDS}/.meta.json`]: meta({ source: REPO, sourceRevision: 'a'.repeat(40), sourceBranch: 'main', date: DATE }),
      [`${CRDS}/page.md`]: '# mirrored',
    })

    const run = runManual(source)

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(exists(landed, `${CRDS}/page.md`)).toBe(false)
    expect(readFile(landed, `${CRDS}/latest/index.yaml`)).toBe('v1')
    expect(exists(landed, `${CRDS}/v1.0.0/.meta.json`)).toBe(true)
    expect(run.summary).toContain('its entry is now in release mode')
  })

  test('a release Area that became a mirror is replaced by the mirror', () => {
    const source = makeSource(world)
    releaseCommit(source, { 'index.yaml': 'v1', 'docs/a.md': '# a', ...entriesFile([unnamedReleaseEntry()]) }, 'v1.0.0', DATE)
    expect(runManual(source).status).toBe(0)
    commitSource(source, entriesFile([mirrorEntry({ area: 'core/crds' })]), 'now a mirror')

    const run = runPush(source)

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(exists(landed, `${CRDS}/v1.0.0`)).toBe(false)
    expect(exists(landed, `${CRDS}/versions.json`)).toBe(false)
    expect(readFile(landed, `${CRDS}/a.md`)).toBe('# a')
    expect(readJson(landed, `${CRDS}/.meta.json`).source).toBe(REPO)
    expect(run.summary).toContain('its entry is now in mirror mode')
  })
})

describe('a Version folder the root does not contain', () => {
  // A named tag at site/raw/1.0.0 reads as area "site", package "raw": the inferred Area is above the root.
  const escapedDocs = {
    'site/raw/1.0.0/.meta.json': meta({ source: REPO, tag: 'p-v1.0.0', date: DATE }),
    'site/raw/1.0.0/README.md': 'owned\n',
    'site/raw/unowned/keep.txt': 'UNOWNED\n',
    'site/keep-outside-root.txt': 'OUTSIDE ROOT\n',
  }

  test.each([
    ['a manual run', runManual],
    ['a push', runPush],
  ])('%s stops with an error naming the path, and deletes nothing', (_name, run) => {
    const source = makeSource(world)
    commitSource(source, entriesFile([]), 'no entries')
    seedDocs(world, escapedDocs)
    const before = remoteCommitCount(world)

    const result = run(source)

    expect(result.status).toBe(2)
    expect(result.output).toContain('site/raw/1.0.0')
    expect(result.output).toContain('invalid .meta.json: site/raw/1.0.0/.meta.json')
    expect(remoteCommitCount(world)).toBe(before)
    const landed = readRemote(world)
    expect(readFile(landed, 'site/keep-outside-root.txt')).toBe('OUTSIDE ROOT\n')
    expect(readFile(landed, 'site/raw/1.0.0/README.md')).toBe('owned\n')
    expect(readFile(landed, 'site/raw/unowned/keep.txt')).toBe('UNOWNED\n')
  })

  test('an unnamed tag whose Version folder is the root itself is rejected too', () => {
    seedDocs(world, { 'site/raw/v1.0.0/.meta.json': meta({ source: REPO, tag: 'v1.0.0', date: DATE }) })

    expect(() => planPrune({
      docs: cloneDocs(world), source: makeSource(world), root: 'site/raw', repository: REPO, entries: [],
    })).toThrow('site/raw/v1.0.0')
  })

  test('applyPrune will not delete anything outside the root, whatever the plan holds', () => {
    const docs = cloneDocs(world)
    write(docs, { 'site/keep/keep.txt': 'OUTSIDE ROOT\n', 'site/raw/owned/a.md': '# owned\n' })
    const plan = { plannedDirs: new Set(['site']), files: [] }

    expect(() => applyPrune(docs, { ...plan, removals: [{ dir: 'site', kind: 'area-gone', reason: 'test' }] }, 'site/raw'))
      .toThrow('refusing to delete site: it is not under the docs root "site/raw"')
    expect(() => applyPrune(docs, { ...plan, removals: [], files: [{ rel: 'site/keep/keep.txt' }] }, 'site/raw'))
      .toThrow('site/keep/keep.txt')
    expect(readFile(docs, 'site/keep/keep.txt')).toBe('OUTSIDE ROOT\n')
  })
})

describe('a malformed Version marker', () => {
  test.each([
    ['named', 'site/raw/r/p/1.0.0', releaseEntry({ area: 'r' })],
    ['unnamed', 'site/raw/r/v1.0.0', unnamedReleaseEntry({ area: 'r' })],
  ])('%s layout: stops with an error naming the folder, and keeps it', (_name, dir, entry) => {
    const source = makeSource(world)
    commitSource(source, { ...featureFiles('p'), ...entriesFile([entry]) }, 'package p')
    seedDocs(world, {
      [`${dir}/.meta.json`]: meta({ source: REPO, date: DATE }),
      [`${dir}/README.md`]: 'IRREPLACEABLE WITHOUT TAG\n',
    })
    const before = remoteCommitCount(world)

    const run = runManual(source)

    expect(run.status).toBe(2)
    expect(run.output).toContain(dir)
    expect(run.output).not.toContain('its entry is gone')
    expect(remoteCommitCount(world)).toBe(before)
    expect(readFile(readRemote(world), `${dir}/README.md`)).toBe('IRREPLACEABLE WITHOUT TAG\n')
  })
})

describe('Version folders with no tag in this repo', () => {
  test('are kept, and the summary names them', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
    const metadata = meta({ source: REPO, tag: 'alpha-v0.9.0', date: DATE })
    seedDocs(world, { [`${FEATURES}/alpha/0.9.0/.meta.json`]: metadata, [`${FEATURES}/alpha/0.9.0/schema.json`]: 'legacy' })

    const run = runManual(source)

    expect(run.status).toBe(0)
    expect(readFile(readRemote(world), `${FEATURES}/alpha/0.9.0/.meta.json`)).toBe(metadata)
    expect(run.summary).toContain('Kept `site/raw/features/alpha/0.9.0`: no matching tag in this repo')
  })

  test('are not reported when the tag exists', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)

    const run = runManual(source)

    expect(run.status).toBe(0)
    expect(run.summary).not.toContain('no matching tag')
  })
})
