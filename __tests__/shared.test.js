import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { cloneDocs, entriesFile, featureFiles, makeDocsRemote, makeSource, meta, readJson, readRemote, releaseCommit, releaseEntry, runPublisher, commitSource, git, readTree, readFile, exists, seedDocs, remoteCommitCount } from '../test/harness.mjs'

let world
beforeEach(() => { world = makeDocsRemote() })
afterEach(() => { world.cleanup() })
const DATE = '2026-01-02T03:04:05Z'
const BASE = 'https://raw.githubusercontent.com/firestartr-pro/docs/main/site/raw'

describe('release shared files', () => {
  test('orders semver newest first, keeps the highest stable latest on backports, and copies recursively exactly', () => {
    const source = makeSource(world)
    const entries = entriesFile([releaseEntry({ mainFile: 'schema.json', prereleases: true, collect: [{ from: 'templates/docs/**', to: '.' }, { from: 'schema.json', to: 'schema.json' }] })])
    releaseCommit(source, { ...featureFiles('alpha'), ...entries, 'packages/alpha/templates/docs/stale.md': 'old' }, 'alpha-v1.0.0', DATE)
    const docs = cloneDocs(world)
    expect(runPublisher(docs, { source, tag: 'alpha-v1.0.0' }).status).toBe(0)
    seedDocs(world, { 'site/raw/features/alpha/hand.md': 'hand', 'site/raw/features/alpha/extra/file.txt': 'hand' })
    releaseCommit(source, { 'packages/alpha/templates/docs/intro.md': '# v2\n', 'packages/alpha/templates/docs/stale.md': null }, 'alpha-v2.0.0', DATE)
    expect(runPublisher(docs, { source, tag: 'alpha-v2.0.0' }).status).toBe(0)
    releaseCommit(source, { 'packages/alpha/templates/docs/intro.md': '# backport\n' }, 'alpha-v1.2.9', DATE)
    expect(runPublisher(docs, { source, tag: 'alpha-v1.2.9' }).status).toBe(0)
    releaseCommit(source, { 'packages/alpha/templates/docs/intro.md': '# rc\n' }, 'alpha-v3.0.0-rc.1', DATE)
    expect(runPublisher(docs, { source, tag: 'alpha-v3.0.0-rc.1' }).status).toBe(0)
    const landed = readRemote(world)
    expect(readJson(landed, 'site/raw/features/alpha/versions.json').map((item) => item.version)).toEqual(['3.0.0-rc.1', '2.0.0', '1.2.9', '1.0.0'])
    const latest = readTree(landed, 'site/raw/features/alpha')
    for (const name of Object.keys(latest).filter((name) => /^(?:1|2|3)\./.test(name) || name === 'versions.json')) delete latest[name]
    expect(latest).toEqual({ 'images/logo.png': 'image-bytes:alpha-logo', 'intro.md': '# v2\n', 'schema.json': '{}\n', 'sub/deep.md': '# Deep\n' })
  })

  test('a prerelease-only package has versions but no latest copy or index row', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ mainFile: 'schema.json', prereleases: true })]) }, 'alpha-v1.0.0-rc.1', DATE)
    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0-rc.1' })
    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readJson(landed, 'site/raw/features/alpha/versions.json')[0].version).toBe('1.0.0-rc.1')
    expect(readJson(landed, 'site/raw/features/index.json')).toEqual({ features: [] })
    expect(exists(landed, 'site/raw/features/alpha/intro.md')).toBe(false)
  })

  test('owns every top-level Area file but leaves unrelated folders alone', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ mainFile: 'schema.json' })]) }, 'alpha-v1.0.0', DATE)
    seedDocs(world, {
      // A marker anywhere in the Area says this repo published there, so the run may clear its stray files.
      'site/raw/features/alpha/0.9.0/.meta.json': meta({ source: 'acme/source', tag: 'alpha-v0.9.0', date: DATE }),
      'site/raw/features/hand.txt': 'hand', 'site/raw/features/README.md': 'old',
      'site/raw/features/unrelated/keep.txt': 'keep',
    })
    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' })
    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(exists(landed, 'site/raw/features/hand.txt')).toBe(false)
    expect(readFile(landed, 'site/raw/features/README.md')).toBe('# Features\n')
    expect(readFile(landed, 'site/raw/features/unrelated/keep.txt')).toBe('keep')
  })

  test('fails a new version missing mainFile without committing or writing the Area', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ mainFile: undefined })]) }, 'alpha-v1.0.0', DATE)
    const docs = cloneDocs(world)
    const before = remoteCommitCount(world)
    const run = runPublisher(docs, { source, tag: 'alpha-v1.0.0' })
    expect(run.status).toBe(2)
    expect(run.output).toContain('mainFile "README.md" is missing from new Version folder site/raw/features/alpha/1.0.0')
    expect(remoteCommitCount(world)).toBe(before)
    expect(readTree(docs)).toEqual({})
  })

  test('keeps links for older versions missing mainFile and warns in the run summary', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ mainFile: 'schema.json' })]) }, 'alpha-v2.0.0', DATE)
    seedDocs(world, {
      'site/raw/features/alpha/1.0.0/.meta.json': JSON.stringify({ source: 'acme/source', tag: 'alpha-v1.0.0', date: DATE }),
      'site/raw/features/alpha/1.0.0/intro.md': '# old',
    })
    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v2.0.0' })
    expect(run.status).toBe(0)
    expect(run.summary).toContain('Warning: mainFile "schema.json" is missing from older Version folder site/raw/features/alpha/1.0.0')
    expect(readJson(readRemote(world), 'site/raw/features/alpha/versions.json')[1].url).toBe(`${BASE}/features/alpha/1.0.0/schema.json`)
  })

  test('builds in a detached second folder while Area files and tagNames stay on source_branch', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ mainFile: 'schema.json', tagNames: 'tags.json' })]), 'tags.json': '{"packages":{}}' }, 'component-v1.0.0', DATE)
    const build = `test "$(git -C '${source}' symbolic-ref --short HEAD)" = main && test "$(git rev-parse --show-toplevel)" != '${source}' && echo built > schema.json`
    commitSource(source, { 'README.md': '# Branch\n', 'tags.json': '{"packages":{"packages/alpha":{"component":"component"}}}', ...entriesFile([releaseEntry({ mainFile: 'schema.json', tagNames: 'tags.json', build })]) }, 'branch settings')
    const before = git(source, 'rev-parse', 'HEAD')
    const worktrees = git(source, 'worktree', 'list', '--porcelain')
    const run = runPublisher(cloneDocs(world), { source, tag: 'component-v1.0.0' })
    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/features/README.md')).toBe('# Branch\n')
    expect(readFile(landed, 'site/raw/features/alpha/1.0.0/schema.json')).toBe('built\n')
    expect(git(source, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(git(source, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(source, 'status', '--porcelain')).toBe('')
    expect(git(source, 'worktree', 'list', '--porcelain')).toBe(worktrees)
  })

  test('ports numeric, prerelease and build-metadata semver precedence without floating-point loss', () => {
    const versions = ['9007199254740993.0.0', '9007199254740992.0.0', '2.0.0', '1.10.0', '1.9.9', '1.1.0+b-1', '1.0.0', '1.0.0-rc.1', '1.0.0-beta.11', '1.0.0-beta.2', '1.0.0-beta', '1.0.0-alpha.beta', '1.0.0-alpha.1', '1.0.0-alpha']
    const existing = Object.fromEntries(versions.filter((version) => version !== '2.0.0').flatMap((version) => [
      [`site/raw/features/alpha/${version}/.meta.json`, JSON.stringify({ source: 'acme/source', tag: `alpha-v${version}`, date: DATE })],
      [`site/raw/features/alpha/${version}/schema.json`, version],
    ]))
    seedDocs(world, existing)
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v2.0.0', DATE)
    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v2.0.0' })
    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readJson(landed, 'site/raw/features/alpha/versions.json').map((row) => row.version)).toEqual(versions)
    expect(readFile(landed, 'site/raw/features/alpha/schema.json')).toBe(versions[0])
    expect(exists(landed, 'site/raw/features/images')).toBe(false)
  })

  test('uses the destination repository, branch and root for raw URLs and indexes every Markdown file', () => {
    const source = makeSource(world)
    const entry = releaseEntry({ area: 'handbook/features', mainFile: 'reference/API guide.md', collect: [
      { from: 'templates/docs/intro.md', to: 'README.md' },
      { from: 'templates/docs/sub/deep.md', to: 'reference/API guide.md' },
      { from: 'CHANGELOG.md', to: 'NOTES.MD' },
    ] })
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([entry]) }, 'alpha-v1.0.0', DATE)
    const docs = cloneDocs(world)
    git(docs, 'push', 'origin', 'main:published')
    const run = runPublisher(docs, { source, tag: 'alpha-v1.0.0', docsRepository: 'acme/handbook', root: 'docs/raw', branch: 'published' })
    expect(run.status).toBe(0)
    const base = 'https://raw.githubusercontent.com/acme/handbook/published/docs/raw/handbook/features/alpha'
    expect(readJson(docs, 'docs/raw/handbook/features/alpha/versions.json')[0].url).toBe(`${base}/1.0.0/reference/API%20guide.md`)
    expect(readJson(docs, 'docs/raw/handbook/features/index.json')).toEqual({ features: [{ name: 'alpha', version: '1.0.0', files: [
      { name: 'README.md', url: `${base}/README.md` },
      { name: 'NOTES.MD', url: `${base}/NOTES.MD` },
      { name: 'reference/API guide.md', url: `${base}/reference/API%20guide.md` },
    ] }] })
  })

  test('writes Version metadata, versions.json and the hub-shaped index in one commit', () => {
    const source = makeSource(world)
    const entry = releaseEntry({ collect: [{ from: 'templates/docs/**', to: '.' }, { from: 'CHANGELOG.md', to: 'CHANGELOG.md' }, { from: 'schema.json', to: 'schema.json' }] })
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([entry]) }, 'alpha-v1.0.0', DATE)
    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' })
    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readJson(landed, 'site/raw/features/alpha/1.0.0/.meta.json')).toEqual({
      source: 'acme/source', tag: 'alpha-v1.0.0', date: DATE,
      specHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(readJson(landed, 'site/raw/features/alpha/versions.json')).toEqual([
      { version: '1.0.0', date: DATE, url: `${BASE}/features/alpha/1.0.0/schema.json` },
    ])
    expect(readJson(landed, 'site/raw/features/index.json')).toEqual({ features: [{
      name: 'alpha', version: '1.0.0', files: [
        { name: 'CHANGELOG.md', url: `${BASE}/features/alpha/CHANGELOG.md` },
        { name: 'intro.md', url: `${BASE}/features/alpha/intro.md` },
        { name: 'sub/deep.md', url: `${BASE}/features/alpha/sub/deep.md` },
      ],
    }] })
  })
})
