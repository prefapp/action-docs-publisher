import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { cloneDocs, cloneSource, commitSource, entriesFile, exists, featureFiles, git, makeDocsRemote, makeSource, meta, mirrorEntry, pushAttempts, readFile, readJson, readRemote, readTree, rejectPushes, releaseCommit, releaseEntry, remoteCommitCount, runPublisher, runReconcile, seedDocs, tagRelease, unnamedReleaseEntry, write } from '../test/harness.mjs'

let world
beforeEach(() => { world = makeDocsRemote() })
afterEach(() => { world.cleanup() })
const DATE = '2026-01-02T03:04:05Z'
const AREA = 'site/raw/features'
function manualSource(entry = releaseEntry()) {
  const source = makeSource(world)
  releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([entry]) }, 'alpha-v1.0.0', DATE)
  return source
}

describe('manual runs remain compatible with release shared files', () => {
  test('publishes every matching source tag and rebuilds the Area once', () => {
    const source = manualSource()
    releaseCommit(source, { 'packages/alpha/templates/docs/intro.md': '# v2\n' }, 'alpha-v2.0.0', DATE)
    const before = remoteCommitCount(world)
    const run = runReconcile(world, source)
    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(before + 1)
    const landed = readRemote(world)
    expect(readJson(landed, `${AREA}/alpha/1.0.0/.meta.json`)).toEqual({ source: 'acme/source', tag: 'alpha-v1.0.0', date: DATE, specHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(readJson(landed, `${AREA}/alpha/versions.json`).map((row) => row.version)).toEqual(['2.0.0', '1.0.0'])
    expect(readJson(landed, `${AREA}/index.json`).features[0].version).toBe('2.0.0')
    expect(readFile(landed, `${AREA}/alpha/intro.md`)).toBe('# v2\n')
    expect(exists(landed, `${AREA}/alpha/.meta.json`)).toBe(false)
  })

  test.each([false, true])('unnamed layout respects prereleases: %s', (prereleases) => {
    const source = makeSource(world)
    releaseCommit(source, { 'index.yaml': 'stable', ...entriesFile([unnamedReleaseEntry({ prereleases })]) }, 'v1.0.0', DATE)
    releaseCommit(source, { 'index.yaml': 'preview' }, 'v2.0.0-rc.1', DATE)
    const run = runReconcile(world, source)
    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/core/crds/latest/index.yaml')).toBe('stable')
    expect(exists(landed, 'site/raw/core/crds/v2.0.0-rc.1/.meta.json')).toBe(prereleases)
    expect(readJson(landed, 'site/raw/core/crds/versions.json').map((row) => row.version)).toEqual(prereleases ? ['v2.0.0-rc.1', 'v1.0.0'] : ['v1.0.0'])
  })

  test('uses tagNames from source_branch and keeps the original tag in metadata', () => {
    const entry = releaseEntry({ tagNames: 'tags.json' })
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([entry]) }, 'component-v1.0.0', DATE)
    commitSource(source, { 'tags.json': '{"packages":{"packages/alpha":{"component":"component"}}}' }, 'tag mapping')
    const run = runReconcile(world, source)
    expect(run.status).toBe(0)
    expect(readJson(readRemote(world), `${AREA}/alpha/1.0.0/.meta.json`).tag).toBe('component-v1.0.0')
  })

  test('keeps an existing Version folder byte-for-byte when its specHash matches', () => {
    const source = manualSource()
    expect(runReconcile(world, source).status).toBe(0)
    const metadata = readFile(readRemote(world), `${AREA}/alpha/1.0.0/.meta.json`)
    seedDocs(world, { [`${AREA}/alpha/1.0.0/schema.json`]: 'hand edit', [`${AREA}/alpha/1.0.0/extra.md`]: 'keep' })
    const run = runReconcile(world, source)
    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, `${AREA}/alpha/1.0.0/.meta.json`)).toBe(metadata)
    expect(readFile(landed, `${AREA}/alpha/1.0.0/schema.json`)).toBe('hand edit')
    expect(readFile(landed, `${AREA}/alpha/1.0.0/extra.md`)).toBe('keep')
    expect(run.summary).toContain(`- Kept \`${AREA}/alpha/1.0.0\`: specHash matches the current entry.`)
  })

  test('reports an unchanged Version folder as kept even if its tag no longer fits the entry', () => {
    const source = manualSource()
    expect(runReconcile(world, source).status).toBe(0)
    const tree = readTree(readRemote(world), `${AREA}/alpha/1.0.0`)
    commitSource(source, { 'packages/alpha/schema.json': null }, 'unfit replacement tag')
    git(source, 'tag', '-f', 'alpha-v1.0.0')
    const before = remoteCommitCount(world)
    const run = runReconcile(world, source)
    expect(run.status).toBe(0)
    expect(readTree(readRemote(world), `${AREA}/alpha/1.0.0`)).toEqual(tree)
    expect(remoteCommitCount(world)).toBe(before)
    expect(run.summary).toContain(`- Kept \`${AREA}/alpha/1.0.0\`: specHash matches the current entry.`)
    expect(run.summary).not.toContain('Skipped `alpha-v1.0.0`')
  })

  test('republishes a drifted Version folder as a whole and rebuilds its latest copy', () => {
    const source = manualSource()
    seedDocs(world, {
      [`${AREA}/alpha/1.0.0/.meta.json`]: meta({ source: 'acme/source', tag: 'alpha-v1.0.0', date: '2020-01-01T00:00:00Z', specHash: '0'.repeat(64) }),
      [`${AREA}/alpha/1.0.0/schema.json`]: 'hand edit',
      [`${AREA}/alpha/1.0.0/extra.md`]: 'obsolete',
    })
    const before = remoteCommitCount(world)
    const run = runReconcile(world, source)
    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(before + 1)
    const landed = readRemote(world)
    expect(readFile(landed, `${AREA}/alpha/1.0.0/schema.json`)).toBe('{}\n')
    expect(exists(landed, `${AREA}/alpha/1.0.0/extra.md`)).toBe(false)
    expect(exists(landed, `${AREA}/alpha/extra.md`)).toBe(false)
    expect(readJson(landed, `${AREA}/alpha/1.0.0/.meta.json`)).toEqual({
      source: 'acme/source', tag: 'alpha-v1.0.0', date: DATE,
      specHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(readJson(landed, `${AREA}/alpha/1.0.0/.meta.json`).specHash).not.toBe('0'.repeat(64))
    expect(run.summary).toContain(`- Republished \`${AREA}/alpha/1.0.0\`: spec changed.`)
    const completed = remoteCommitCount(world)
    expect(runReconcile(world, source).status).toBe(0)
    expect(remoteCommitCount(world)).toBe(completed)
  })

  test('lists every unmigrated Version folder and every Area problem before writing anything', () => {
    const source = manualSource()
    commitSource(source, {
      'docs/index.md': '# Mirror\n',
      ...entriesFile([releaseEntry(), releaseEntry({ area: 'more' }), mirrorEntry()]),
    }, 'another release Area and a mirror')
    seedDocs(world, {
      [`${AREA}/alpha/1.0.0/intro.md`]: 'unmigrated tag',
      [`${AREA}/alpha/0.9.0/schema.json`]: 'unmigrated without a tag',
      [`${AREA}/broken/1.0.0/.meta.json`]: '{',
      [`${AREA}/foreign/1.0.0/.meta.json`]: meta({ source: 'other/repo', tag: 'foreign-v1.0.0', date: DATE }),
      [`${AREA}/deleted/versions.json`]: '[]',
      'site/raw/more/alpha/1.0.0/schema.json': 'unmigrated in another Area',
    })
    const docs = cloneDocs(world)
    const tree = readTree(docs)
    const before = remoteCommitCount(world)
    const run = runReconcile(world, source, docs)
    expect(run.status).toBe(2)
    expect(run.output).toContain(`Version folder ${AREA}/alpha/1.0.0 has no .meta.json`)
    expect(run.output).toContain(`Version folder ${AREA}/alpha/0.9.0 has no .meta.json`)
    expect(run.output).toContain(`invalid .meta.json: ${AREA}/broken/1.0.0/.meta.json`)
    expect(run.output).toContain('Area "features" belongs to other/repo, but this repo is acme/source. Choose another Area.')
    expect(run.output).toContain(`half-deleted package: ${AREA}/deleted has shared files or a latest copy but no Version folders`)
    expect(run.output).toContain('Version folder site/raw/more/alpha/1.0.0 has no .meta.json')
    expect(remoteCommitCount(world)).toBe(before)
    expect(readTree(docs)).toEqual(tree)
    expect(git(docs, 'status', '--porcelain')).toBe('')
  })

  test.each([releaseEntry(), unnamedReleaseEntry()].flatMap((entry) => [false, true].map((tagged) => ({ entry, tagged }))))('rejects an invalid-date Version folder in $entry.area without pruning it (tag exists: $tagged)', ({ entry, tagged }) => {
    const source = makeSource(world)
    const tag = entry.packages ? 'alpha-v0.9.0' : 'v0.9.0'
    releaseCommit(source, { ...featureFiles('alpha'), 'index.yaml': 'CRD\n', ...entriesFile([entry]) }, tagged ? tag : tag.replace('0.9.0', '1.0.0'), DATE)
    const dir = entry.packages ? `${AREA}/alpha/0.9.0` : 'site/raw/core/crds/v0.9.0'
    seedDocs(world, {
      [`${dir}/.meta.json`]: meta({ source: 'acme/source', tag, date: 'invalid' }),
      [`${dir}/${entry.mainFile}`]: 'preserve invalid version\n',
    })
    const docs = cloneDocs(world)
    const tree = readTree(docs)
    const head = git(docs, 'rev-parse', 'HEAD')
    const commits = remoteCommitCount(world)

    const run = runReconcile(world, source, docs)

    expect(run.status).toBe(2)
    expect(run.output).toContain(`docs_publisher: invalid .meta.json: ${dir}/.meta.json`)
    expect(remoteCommitCount(world)).toBe(commits)
    expect(git(docs, 'rev-parse', 'HEAD')).toBe(head)
    expect(readTree(docs)).toEqual(tree)
    expect(readTree(readRemote(world))).toEqual(tree)
    expect(git(docs, 'status', '--porcelain')).toBe('')
  })

  test.each([true, false])('reconciles migrated metadata without specHash (tag exists: %s)', (tagged) => {
    const source = manualSource()
    const version = tagged ? '1.0.0' : '0.9.0'
    const dir = `${AREA}/alpha/${version}`
    const metadata = meta({ source: 'acme/source', tag: `alpha-v${version}`, date: DATE })
    seedDocs(world, { [`${dir}/.meta.json`]: metadata, [`${dir}/schema.json`]: 'legacy', [`${dir}/extra.md`]: 'legacy extra' })
    const run = runReconcile(world, source)
    expect(run.status).toBe(0)
    const landed = readRemote(world)
    if (tagged) {
      expect(readFile(landed, `${dir}/schema.json`)).toBe('{}\n')
      expect(exists(landed, `${dir}/extra.md`)).toBe(false)
      expect(readJson(landed, `${dir}/.meta.json`).specHash).toMatch(/^[a-f0-9]{64}$/)
      expect(run.summary).toContain(`- Republished \`${dir}\`: spec changed.`)
    } else {
      expect(readFile(landed, `${dir}/.meta.json`)).toBe(metadata)
      expect(readFile(landed, `${dir}/schema.json`)).toBe('legacy')
      expect(readFile(landed, `${dir}/extra.md`)).toBe('legacy extra')
      expect(run.summary).toContain(`- Kept \`${dir}\`: no matching tag in this repo to republish it from.`)
    }
  })

  test('publishes mirrors and releases in one commit through rejected pushes', () => {
    const source = manualSource()
    commitSource(source, { 'docs/a.md': '# mirror', ...entriesFile([releaseEntry(), mirrorEntry()]) }, 'mirror entry')
    rejectPushes(world, 2)
    const before = remoteCommitCount(world)
    const run = runReconcile(world, source)
    expect(run.status).toBe(0)
    expect(pushAttempts(world)).toBe(3)
    expect(remoteCommitCount(world)).toBe(before + 1)
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/core/docs/a.md')).toBe('# mirror')
    expect(readJson(landed, `${AREA}/alpha/versions.json`)).toHaveLength(1)
  })

  test.each([
    ['a missing literal from', releaseEntry(), { 'packages/alpha/schema.json': null }, 'not found: schema.json'],
    ['a build that fails', releaseEntry({ build: 'test -f BUILD_OK' }), {}, 'build failed in packages/alpha (exit 1)'],
    ['a collect that finds nothing', releaseEntry({ mainFile: 'intro.md', collect: [{ from: 'templates/docs/*.md', to: '.' }] }), { 'packages/alpha/templates/docs/intro.md': null }, 'collect matched no files'],
  ].flatMap(([name, entry, legacy, reason]) => [false, true].map((existing) => ({ name, entry, legacy, reason, existing }))))('skips and reports an old tag with $name, and publishes the others (existing: $existing)', ({ entry, legacy, reason, existing }) => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...legacy, ...entriesFile([entry]) }, 'alpha-v1.0.0', DATE)
    releaseCommit(source, { ...featureFiles('alpha'), 'packages/alpha/BUILD_OK': '' }, 'alpha-v2.0.0', DATE)
    const old = {
      [`${AREA}/alpha/1.0.0/.meta.json`]: meta({ source: 'acme/source', tag: 'alpha-v1.0.0', date: DATE, specHash: '0'.repeat(64) }),
      [`${AREA}/alpha/1.0.0/schema.json`]: 'legacy',
      [`${AREA}/alpha/1.0.0/extra.md`]: 'keep on failure',
    }
    if (existing) seedDocs(world, old)
    const checkout = cloneSource(world, source, 'checkout')
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source: checkout, reconcile: true })

    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(before + 1)
    expect(git(checkout, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    const landed = readRemote(world)
    expect(exists(landed, `${AREA}/alpha/1.0.0`)).toBe(existing)
    if (existing) {
      for (const [rel, bytes] of Object.entries(old)) expect(readFile(landed, rel)).toBe(bytes)
    }
    expect(exists(landed, `${AREA}/alpha/2.0.0/.meta.json`)).toBe(true)
    expect(readJson(landed, `${AREA}/alpha/versions.json`).map((row) => row.version)).toEqual(existing ? ['2.0.0', '1.0.0'] : ['2.0.0'])
    expect(run.summary).toContain(`- Skipped \`alpha-v1.0.0\`: its content does not fit the entry (${reason}).`)
    expect(run.summary).toContain(`- Published \`${AREA}/alpha/2.0.0\`.`)
    expect(run.summary).not.toContain('Republished')
  })

  test('groups the skipped tags that share a reason', () => {
    const source = makeSource(world)
    const { 'packages/alpha/schema.json': _schema, ...legacy } = featureFiles('alpha')
    releaseCommit(source, { ...legacy, ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
    releaseCommit(source, { 'packages/alpha/CHANGELOG.md': '# v1.1\n' }, 'alpha-v1.1.0', DATE)
    releaseCommit(source, { 'packages/alpha/schema.json': '{}\n' }, 'alpha-v2.0.0', DATE)

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    expect(run.summary).toContain('- Skipped `alpha-v1.0.0`, `alpha-v1.1.0`: its content does not fit the entry (not found: schema.json).')
  })

  test('publishes only the Area files and exits 0 when every old tag is skipped', () => {
    const source = manualSource(releaseEntry({ build: 'exit 1' }))
    const checkout = cloneSource(world, source, 'checkout')

    const run = runPublisher(cloneDocs(world), { source: checkout, reconcile: true })

    expect(run.status).toBe(0)
    expect(git(checkout, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    const landed = readRemote(world)
    expect(Object.keys(readTree(landed, AREA)).sort()).toEqual(['README.md', 'index.json'])
    expect(run.summary).toContain('its content does not fit the entry (build failed in packages/alpha (exit 1))')
  })

  test('still aborts the whole run on a collected symlink', () => {
    const source = makeSource(world)
    write(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) })
    symlinkSync('/etc/hosts', join(source, 'packages/alpha/templates/docs/link.md'))
    git(source, 'add', '-A')
    git(source, 'commit', '--no-verify', '-m', 'release with a symlink')
    tagRelease(source, 'alpha-v1.0.0', DATE)
    const before = remoteCommitCount(world)

    const run = runReconcile(world, source)

    expect(run.status).toBe(2)
    expect(run.output).toContain('refusing to publish symlink')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test.each([
    ['a missing literal from', releaseEntry(), { 'packages/alpha/schema.json': null }, 'not found: schema.json'],
    ['a build that fails', releaseEntry({ build: 'exit 1' }), {}, 'build failed in packages/alpha (exit 1)'],
    ['a collect that finds nothing', releaseEntry({ mainFile: 'intro.md', collect: [{ from: 'templates/docs/*.md', to: '.' }] }), { 'packages/alpha/templates/docs/intro.md': null }, 'collect matched no files'],
  ])('fails a release publish for %s, and pushes nothing', (_name, entry, change, reason) => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...change, ...entriesFile([entry]) }, 'alpha-v1.0.0', DATE)
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' })

    expect(run.status).toBe(2)
    expect(run.output).toContain(reason)
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('refuses two tags that resolve to one Version folder in one run', () => {
    const source = makeSource(world)
    releaseCommit(source, {
      ...featureFiles('alpha'),
      'tags.json': '{"packages":{"packages/alpha":{"component":"a"}}}',
      ...entriesFile([releaseEntry({ tagNames: 'tags.json' })]),
    }, 'a-v1.0.0', DATE)
    git(source, 'tag', 'alpha-v1.0.0')
    const before = remoteCommitCount(world)

    const run = runReconcile(world, source)

    expect(run.status).toBe(2)
    expect(run.output).toContain('two tags publish one Version folder `site/raw/features/alpha/1.0.0`: `a-v1.0.0` and `alpha-v1.0.0`')
    expect(remoteCommitCount(world)).toBe(before)
    expect(exists(readRemote(world), `${AREA}/alpha/1.0.0/.meta.json`)).toBe(false)
  })

  test('refuses to republish a Version folder from a tag other than the one it records', () => {
    const source = manualSource()
    seedDocs(world, {
      [`${AREA}/alpha/1.0.0/.meta.json`]: meta({ source: 'acme/source', tag: 'other-v1.0.0', date: DATE }),
      [`${AREA}/alpha/1.0.0/schema.json`]: 'OLD\n',
    })
    const before = remoteCommitCount(world)

    const run = runReconcile(world, source)

    expect(run.status).toBe(2)
    expect(run.output).toContain(
      'refusing to republish `site/raw/features/alpha/1.0.0` from `alpha-v1.0.0`: it holds the Version of `other-v1.0.0`',
    )
    expect(remoteCommitCount(world)).toBe(before)
    expect(readFile(readRemote(world), `${AREA}/alpha/1.0.0/schema.json`)).toBe('OLD\n')
  })

  test('is idempotent on a completed Area', () => {
    const source = manualSource()
    expect(runReconcile(world, source).status).toBe(0)
    const before = remoteCommitCount(world)
    const run = runReconcile(world, source)
    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(before)
  })
  test('names a nested Mirror Area without the unchanged Mirror Area around it', () => {
    const source = makeSource(world)
    commitSource(source, {
      'docs/index.md': '# Docs\n',
      'backstage/guide.md': '# Guide\n',
      ...entriesFile([
        mirrorEntry(),
        mirrorEntry({ area: 'core/docs/backstage', collect: [{ from: 'backstage/**', to: '.' }], paths: ['backstage/**'] }),
      ]),
    }, 'mirrors')
    expect(runReconcile(world, source).status).toBe(0)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'docs/index.md': '# Docs v2\n' }, 'change the outer mirror')
    const after = git(source, 'rev-parse', 'HEAD')
    // The push brings only the outer Mirror Area to the new revision.
    expect(runPublisher(cloneDocs(world, 'push'), { source, before, after }).status).toBe(0)

    const run = runReconcile(world, source)

    // Only the nested Mirror Area's marker changes: its staged write is not a change of the Area around it.
    expect(run.status).toBe(0)
    expect(readJson(readRemote(world), 'site/raw/core/docs/backstage/.meta.json').sourceRevision).toBe(after)
    expect(run.summary).toContain('Mirrored core/docs/backstage to `main`.')
  })
})

describe('run summary diagnostics', () => {
  test('names the source branch in retirement lines and the docs branch in the opening line', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('beta'), ...entriesFile([releaseEntry()]) }, 'beta-v1.0.0', DATE)
    git(world.remote, 'branch', 'published', 'main')
    commitSource(source, { 'packages/beta': null }, 'retire beta')
    const checkout = cloneSource(world, source, 'develop')

    const run = runPublisher(cloneDocs(world), {
      source: checkout, reconcile: true, branch: 'published', sourceBranch: 'develop',
    })

    expect(run.status).toBe(0)
    expect(run.summary).toContain('Reconciled `features` to `published`.')
    expect(run.summary).toContain('- Skipped `beta-v1.0.0`: the package folder is gone from `develop`, so the package is retired.')
    expect(run.summary).not.toContain('gone from `published`')
  })
})
