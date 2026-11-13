import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { join } from 'node:path'
import {
  ENTRIES_PATH,
  cloneDocs,
  commitSource,
  exists,
  featureFiles,
  entriesFile,
  entriesJson,
  makeDocsRemote,
  makeSource,
  meta,
  mirrorEntry,
  mirrorMeta,
  readRemote,
  readTree,
  releaseCommit,
  releaseEntry,
  remoteCommitCount,
  runPublisher,
  runReconcile,
  unnamedReleaseEntry,
  renderedScript,
} from '../test/harness.mjs'

const { readEntries, specHash } = await import(renderedScript('entries.mjs'))

const TAG = 'docs_publisher-v1.0.0'
const DATE = '2026-01-02T03:04:05Z'
const RELEASE = { tag: TAG }

let world
let seq = 0

beforeEach(() => {
  world = makeDocsRemote()
})

afterEach(() => {
  world.cleanup()
})

function publishWith(entries, { tag, files = {}, repository } = {}) {
  const source = makeSource(world, `source-${++seq}`)
  const content = typeof entries === 'string' ? entries : entriesJson(entries)
  const tree = { ...featureFiles('docs_publisher'), ...files, [ENTRIES_PATH]: content }
  if (tag) releaseCommit(source, tree, tag, DATE)
  else commitSource(source, tree, 'entries')
  const before = remoteCommitCount(world)
  const run = runPublisher(cloneDocs(world, `docs-${seq}`), { source, tag, repository })
  return { run, before, source }
}

function expectRefused({ run, before }, message) {
  expect(run.status).toBe(2)
  expect(run.output).toContain(message)
  expect(remoteCommitCount(world)).toBe(before)
}

describe('reading the rendered entries', () => {
  test('reads one JSON document holding the entries, and publishes the rules it holds', () => {
    const { run } = publishWith([releaseEntry()], RELEASE)

    expect(run.status).toBe(0)
    const tree = readTree(readRemote(world), 'site/raw/features/docs_publisher/1.0.0')
    expect(tree['intro.md']).toBe('# docs_publisher\n')
    expect(tree['CHANGELOG.md']).toBe('# Changelog\n')
    expect(Object.keys(tree).sort()).toEqual(
      ['.meta.json', 'CHANGELOG.md', 'images/logo.png', 'intro.md', 'schema.json'],
    )
    expect(JSON.parse(tree['.meta.json'])).toMatchObject({ source: 'acme/source', tag: TAG, date: DATE })
  })

  test('defaults mainFile to README.md and accepts an explicit link target', () => {
    const { source } = publishWith([releaseEntry({ mainFile: undefined }), releaseEntry({ area: 'extra', mainFile: 'schema.json' })], RELEASE)
    const entries = readEntries(join(source, ENTRIES_PATH))
    expect(entries.map((entry) => entry.mainFile)).toEqual(['README.md', 'schema.json'])
  })

  test('skips a prerelease tag when the entry does not set prereleases', () => {
    const { run, before } = publishWith([releaseEntry()], { tag: 'docs_publisher-v1.0.0-rc.1' })

    expect(run.status).toBe(0)
    expect(run.summary).toContain('Skipped `docs_publisher-v1.0.0-rc.1`')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('publishes a prerelease tag when the entry sets prereleases: true', () => {
    const { run } = publishWith([releaseEntry({ prereleases: true })], { tag: 'docs_publisher-v1.0.0-rc.1' })

    expect(run.status).toBe(0)
    expect(exists(readRemote(world), 'site/raw/features/docs_publisher/1.0.0-rc.1/.meta.json')).toBe(true)
  })

  test('reads no entries from an empty file, so a release publishes nothing', () => {
    const { run, before } = publishWith('', RELEASE)

    expect(run.status).toBe(0)
    expect(run.summary).toContain('no release entry publishes it')
    expect(run.summary).toContain('Add entries to `.github/docs_publisher.yaml`')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('reads no entries on a push either, so no mirror publishes anything', () => {
    const { run, before } = publishWith('[]', {})

    expect(run.status).toBe(0)
    expect(run.summary).toContain('No mirror entries to publish')
    expect(run.summary).toContain('Add entries to `.github/docs_publisher.yaml`')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('asks for no entries when the entries file holds release entries only, so a push publishes no mirror', () => {
    const { run, before } = publishWith([releaseEntry()], {})

    expect(run.status).toBe(0)
    expect(run.summary).toContain('No mirror entries; nothing to mirror.')
    expect(run.summary).not.toContain('Add entries to `.github/docs_publisher.yaml`')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('fails when the entries file is not valid JSON', () => {
    expectRefused(publishWith('{"area": "features",', RELEASE), 'entries: not valid JSON')
  })

  test('treats a null document as no entries, so a release publishes nothing', () => {
    const { run, before } = publishWith('null\n', RELEASE)

    expect(run.status).toBe(0)
    expect(run.summary).toContain('no release entry publishes it')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('rejects a document that is not a list', () => {
    expectRefused(publishWith('{"area": "features"}', RELEASE), 'entries must be a list')
  })

  test('rejects an unknown key', () => {
    expectRefused(
      publishWith([releaseEntry({ surprise: true })], RELEASE),
      'entry 1 (area "features"): unknown key "surprise"',
    )
  })

  test('requires an explicit release or mirror mode', () => {
    expectRefused(
      publishWith([releaseEntry({ mode: undefined })], RELEASE),
      'entry 1 (area "features"): mode must be release or mirror',
    )
    expectRefused(
      publishWith([mirrorEntry({ mode: 'other' })]),
      'entry 1 (area "core/docs"): mode must be release or mirror',
    )
  })

  test('rejects the removed tag key as an unknown key, on either kind of entry', () => {
    expectRefused(
      publishWith([releaseEntry({ tag: '<name>-v<semver>' })], RELEASE),
      'entry 1 (area "features"): unknown key "tag"',
    )
    expectRefused(
      publishWith([mirrorEntry({ tag: 'v<semver>' })]),
      'entry 1 (area "core/docs"): unknown key "tag"',
    )
  })

  test('publishes a mirror entry: its area, its collected files and its .meta.json', () => {
    const { run, source } = publishWith([mirrorEntry()], { files: { 'docs/index.md': '# Core\n' } })

    expect(run.status).toBe(0)
    expect(readTree(readRemote(world), 'site/raw/core/docs')).toEqual({
      '.meta.json': mirrorMeta(source),
      'index.md': '# Core\n',
    })
  })

  test.each([
    ['packages', 'packages'],
    ['prereleases', true],
    ['areaFiles', []],
    ['mainFile', 'schema.json'],
    ['tagNames', 'config.json'],
  ])('rejects a release-only key %s on a mirror entry', (key, value) => {
    expectRefused(
      publishWith([mirrorEntry({ [key]: value })]),
      `entry 1 (area "core/docs"): "${key}" is not allowed on a mirror entry`,
    )
  })

  test('defaults mirror paths to collect sources and requires paths with a build', () => {
    const { run } = publishWith([mirrorEntry({ paths: undefined })], { files: { 'docs/index.md': '# Core\n' } })
    expect(run.status).toBe(0)
    expect(readTree(readRemote(world), 'site/raw/core/docs')['index.md']).toBe('# Core\n')
    expectRefused(
      publishWith([mirrorEntry({ paths: undefined, build: 'npm run docs' })]),
      'entry 1 (area "core/docs"): a mirror entry with build needs paths',
    )
  })

  test('rejects a mirror entry without a non-empty paths list', () => {
    expectRefused(
      publishWith([mirrorEntry({ paths: [] })]),
      'entry 1 (area "core/docs"): a mirror entry needs a non-empty paths list',
    )
    expectRefused(
      publishWith([mirrorEntry({ paths: [''] })]),
      'entry 1 (area "core/docs"): paths must be a list of non-empty strings',
    )
  })

  test.each([
    ['two release entries', [releaseEntry(), releaseEntry()], 'entry 2 (area "features"): two entries publish the Area "features"'],
    ['a release and a mirror entry', [releaseEntry(), mirrorEntry({ area: 'features' })], 'entry 2 (area "features"): two entries publish the Area "features"'],
    ['two mirror entries', [mirrorEntry(), mirrorEntry()], 'entry 2 (area "core/docs"): two mirror entries publish the Area "core/docs"'],
  ])('rejects %s for one Area on every trigger', (_label, entries, message) => {
    expectRefused(publishWith(entries, RELEASE), message)
    expectRefused(publishWith(entries), message)
    const { source } = publishWith(entries, RELEASE)
    const before = remoteCommitCount(world)
    const run = runReconcile(world, source)
    expect(run.status).toBe(2)
    expect(run.output).toContain(message)
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('rejects an empty collect list on a release or a mirror entry', () => {
    expectRefused(
      publishWith([releaseEntry({ collect: [] })], RELEASE),
      'entry 1 (area "features"): collect must list at least one rule',
    )
    expectRefused(
      publishWith([mirrorEntry({ collect: [] })]),
      'entry 1 (area "core/docs"): collect must list at least one rule',
    )
  })

  test('rejects a collect that is not a list, naming the entry', () => {
    expectRefused(
      publishWith([releaseEntry(), releaseEntry({ collect: 'templates/docs/*.md' })], RELEASE),
      'entry 2 (area "features"): collect must be a list',
    )
  })

  test('hints to quote the value when a string field arrives as a number', () => {
    const refused = publishWith([releaseEntry({ area: 123 })], RELEASE)

    expectRefused(refused, 'entry 1: area must be a relative path inside the repo')
    expect(refused.run.output).toContain('quote the value in docs_publisher.yaml')
  })

  test('rejects a missing collect key', () => {
    expectRefused(
      publishWith([mirrorEntry({ collect: undefined })]),
      'entry 1 (area "core/docs"): collect must list at least one rule',
    )
  })

  test('runs the build of a release entry before it collects', () => {
    const { run } = publishWith(
      [releaseEntry({ mainFile: 'BUILT.md', build: 'echo built > BUILT.md', collect: [{ from: 'BUILT.md', to: 'BUILT.md' }] })],
      RELEASE,
    )

    expect(run.status).toBe(0)
    expect(readTree(readRemote(world), 'site/raw/features/docs_publisher/1.0.0')['BUILT.md']).toBe('built\n')
  })

  test('runs the build of a mirror entry before it collects', () => {
    const { run } = publishWith([
      mirrorEntry({ build: 'echo built > BUILT.md', collect: [{ from: 'BUILT.md', to: 'BUILT.md' }] }),
    ])

    expect(run.status).toBe(0)
    expect(readTree(readRemote(world), 'site/raw/core/docs')['BUILT.md']).toBe('built\n')
  })

  test('publishes a release entry that declares no build, without running one', () => {
    const { run } = publishWith([releaseEntry()], RELEASE)

    expect(run.status).toBe(0)
    expect(exists(readRemote(world), 'site/raw/features/docs_publisher/1.0.0/.meta.json')).toBe(true)
  })

  test.each([
    ['an empty string', ''],
    ['a list', ['make']],
  ])('rejects a build that is %s', (_, build) => {
    expectRefused(
      publishWith([mirrorEntry({ build })]),
      'entry 1 (area "core/docs"): build must be a non-empty string',
    )
  })

  test('publishes an unnamed release entry as its v<semver> Version folder, with its .meta.json', () => {
    const { run } = publishWith([unnamedReleaseEntry()], { tag: 'v1.2.0', files: { 'index.yaml': 'kind: CRD\n' } })

    expect(run.status).toBe(0)
    expect(readTree(readRemote(world), 'site/raw/core/crds/v1.2.0')).toEqual({
      'index.yaml': 'kind: CRD\n',
      '.meta.json': meta({ source: 'acme/source', tag: 'v1.2.0', date: DATE, specHash: specHash(unnamedReleaseEntry()) }),
    })
  })

  test.each(['.', './'])('maps release-please tagNames for packages at the repo root %s', (packages) => {
    const { run } = publishWith([releaseEntry({
      packages,
      tagNames: 'release-please-config.json',
      collect: [{ from: 'schema.json', to: 'schema.json' }],
    })], {
      tag: 'component-v1.0.0',
      files: {
        'alpha/schema.json': '{"root":true}\n',
        'release-please-config.json': '{"packages":{"alpha":{"component":"component"}}}\n',
      },
    })

    expect(run.status).toBe(0)
    const tree = readTree(readRemote(world), 'site/raw/features/alpha/1.0.0')
    expect(tree['schema.json']).toBe('{"root":true}\n')
    expect(JSON.parse(tree['.meta.json']).tag).toBe('component-v1.0.0')
  })

  test('rejects tagNames without packages or outside the repo', () => {
    expectRefused(
      publishWith([unnamedReleaseEntry({ tagNames: 'rp.json' })], { tag: 'v1.2.0' }),
      'entry 1 (area "core/crds"): tagNames needs packages',
    )
    expectRefused(
      publishWith([releaseEntry({ tagNames: '../rp.json' })], RELEASE),
      'entry 1 (area "features"): tagNames must be a relative path inside the repo',
    )
  })

  test('rejects a mainFile outside the version folder and paths on release entries', () => {
    expectRefused(
      publishWith([releaseEntry({ mainFile: '../README.md' })], RELEASE),
      'entry 1 (area "features"): mainFile must be a relative path inside the repo',
    )
    expectRefused(
      publishWith([releaseEntry({ paths: ['docs/**'] })], RELEASE),
      'entry 1 (area "features"): "paths" is not allowed on a release entry',
    )
  })

  test('rejects a prereleases value that is not a boolean', () => {
    expectRefused(
      publishWith([releaseEntry({ prereleases: 'yes' })], RELEASE),
      'entry 1 (area "features"): prereleases must be true or false',
    )
  })

  test('rejects an area or packages folder that leaves the repo', () => {
    expectRefused(
      publishWith([releaseEntry({ area: '../features' })], RELEASE),
      'entry 1 (area "../features"): area must be a relative path inside the repo',
    )
    expectRefused(
      publishWith([releaseEntry({ packages: '/packages' })], RELEASE),
      'entry 1 (area "features"): packages must be a relative path inside the repo',
    )
  })

  test('rejects a collect source or destination that leaves the folder', () => {
    expectRefused(
      publishWith([releaseEntry({ collect: [{ from: '../secrets/*.md', to: '.' }] })], RELEASE),
      'entry 1 (area "features"): collect from must be a relative path inside the repo',
    )
    expectRefused(
      publishWith([releaseEntry({ collect: [{ from: 'templates/docs/*.md', to: '../out' }] })], RELEASE),
      'entry 1 (area "features"): collect to must be a relative path inside the repo',
    )
  })

  test('rejects an Area or a destination inside the .git folder', () => {
    expectRefused(
      publishWith([releaseEntry({ area: 'features/.git' })], RELEASE),
      'entry 1 (area "features/.git"): area "features/.git" uses ".git", the Git administrative folder',
    )
    expectRefused(
      publishWith([releaseEntry({ collect: [{ from: 'schema.json', to: '.git/config' }] })], RELEASE),
      'entry 1 (area "features"): collect to ".git/config" uses ".git", the Git administrative folder',
    )
    expectRefused(
      publishWith([mirrorEntry({ collect: [{ from: 'docs/**', to: '.git/x' }] })]),
      'entry 1 (area "core/docs"): collect to ".git/x" uses ".git", the Git administrative folder',
    )
  })

  test('rejects a collect or areaFiles source inside the .git folder', () => {
    expectRefused(
      publishWith([releaseEntry({ collect: [{ from: '.git/config', to: 'config' }] })], RELEASE),
      'entry 1 (area "features"): collect from ".git/config" uses ".git", the Git administrative folder',
    )
    expectRefused(
      publishWith([releaseEntry({ areaFiles: [{ from: '.git/config', to: 'config' }] })], RELEASE),
      'entry 1 (area "features"): areaFiles from ".git/config" uses ".git", the Git administrative folder',
    )
  })

  test('rejects a glob in a destination', () => {
    expectRefused(
      publishWith([releaseEntry({ areaFiles: [{ from: 'README.md', to: '*.md' }] })], RELEASE),
      'entry 1 (area "features"): areaFiles to must not contain a glob',
    )
  })

  test('rejects a literal file whose destination is a folder, naming the entry and the rule', () => {
    const run = publishWith([releaseEntry({ collect: [{ from: 'CHANGELOG.md', to: '.' }] })], RELEASE)

    expectRefused(
      run,
      'entry 1 (area "features"): collect rule from "CHANGELOG.md" to "." in area "features": ' +
        "a file's `to` is its destination file path, not a folder",
    )
    expect(run.run.output).not.toContain('EISDIR')
    expectRefused(
      publishWith([releaseEntry({ collect: [{ from: 'schema.json', to: 'out/' }] })], RELEASE),
      'entry 1 (area "features"): collect rule from "schema.json" to "out/" in area "features": ',
    )
  })

  test('rejects a literal areaFile whose destination is a folder', () => {
    expectRefused(
      publishWith([releaseEntry({ areaFiles: [{ from: 'README.md', to: './' }] })], RELEASE),
      'entry 1 (area "features"): areaFiles rule from "README.md" to "./" in area "features": ',
    )
  })

  test('rejects a glob areaFile source, which would publish its file name as a folder', () => {
    expectRefused(
      publishWith([releaseEntry({ areaFiles: [{ from: 'docs/*.md', to: 'README.md' }] })], RELEASE),
      'entry 1 (area "features"): areaFiles from "docs/*.md" in area "features" must be one file, not a glob',
    )
  })

  test('rejects a rule that is not a from/to pair', () => {
    expectRefused(
      publishWith([releaseEntry({ collect: [{ from: 'CHANGELOG.md', to: 'CHANGELOG.md', extra: 1 }] })], RELEASE),
      'entry 1 (area "features"): collect rule must have only from and to',
    )
  })
})

describe('release tag names', () => {
  test('skips a tag whose numeric prerelease has a leading zero: it is not a semver tag', () => {
    const { run, before } = publishWith([releaseEntry()], { tag: 'docs_publisher-v1.0.0-01' })

    expect(run.status).toBe(0)
    expect(run.summary).toContain('it is not a `<name>-v<semver>`')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('publishes a tag with build metadata, whose dash is not a prerelease', () => {
    const { run } = publishWith([releaseEntry()], { tag: 'docs_publisher-v1.0.0+b-1' })

    expect(run.status).toBe(0)
    expect(exists(readRemote(world), 'site/raw/features/docs_publisher/1.0.0+b-1/.meta.json')).toBe(true)
  })

})

  test.each([['features/'], ['core/../features'], ['.']])('rejects a non-canonical area %s', (area) => {
    expectRefused(
      publishWith([releaseEntry({ area })], RELEASE),
      `entry 1 (area "${area}"): area "${area}" must be a normalized Area path`,
    )
  })

  test('rejects a non-canonical area on a mirror entry', () => {
    expectRefused(
      publishWith([mirrorEntry({ area: 'core/docs/' })], {}),
      'entry 1 (area "core/docs/"): area "core/docs/" must be a normalized Area path',
    )
  })
describe('publishing from a bad entries file', () => {
  test('fails, and pushes nothing, when the entries file is missing', () => {
    const source = makeSource(world, 'no-entries-src')
    releaseCommit(source, featureFiles('docs_publisher'), TAG, DATE)
    const docs = cloneDocs(world, 'no-entries-docs')
    const before = remoteCommitCount(world)

    const run = runPublisher(docs, { source, tag: TAG })

    expect(run.status).toBe(2)
    expect(run.output).toContain('entries file not found')
    expect(remoteCommitCount(world)).toBe(before)
  })
})

describe('release Areas nested in another configured Area', () => {
  const nested = [releaseEntry({ area: 'outer' }), releaseEntry({ area: 'outer/inner' })]

  test('rejects them on the first reconcile, naming both entries', () => {
    const source = makeSource(world, 'nested-release')
    commitSource(source, { ...featureFiles('docs_publisher'), ...entriesFile(nested) }, 'entries')
    const before = remoteCommitCount(world)

    const run = runReconcile(world, source)

    expect(run.status).toBe(2)
    expect(run.output).toContain(
      'entry 2 (area "outer/inner"): release Area "outer/inner" sits inside Area "outer" of entry 1',
    )
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('rejects them whatever the entry order', () => {
    const { run, before } = publishWith([nested[1], nested[0]], RELEASE)

    expectRefused(
      { run, before },
      'entry 1 (area "outer/inner"): release Area "outer/inner" sits inside Area "outer" of entry 2',
    )
  })

  test('rejects a release Area nested in a Mirror Area before collecting anything', () => {
    expectRefused(
      publishWith([mirrorEntry({ area: 'outer' }), releaseEntry({ area: 'outer/inner' })], RELEASE),
      'release Area "outer/inner" sits inside Area "outer" of entry 1',
    )
  })

  test('rejects a Mirror Area nested in a release Area before collecting anything', () => {
    expectRefused(
      publishWith([releaseEntry({ area: 'outer' }), mirrorEntry({ area: 'outer/notes' })], RELEASE),
      'entry 2 (area "outer/notes"): Mirror Area "outer/notes" sits inside release Area "outer" of entry 1',
    )
  })

  test('rejects a Mirror Area nested in a release Area whatever the entry order', () => {
    expectRefused(
      publishWith([mirrorEntry({ area: 'outer/notes' }), releaseEntry({ area: 'outer' })], RELEASE),
      'entry 1 (area "outer/notes"): Mirror Area "outer/notes" sits inside release Area "outer" of entry 2',
    )
  })

  test('accepts a Mirror Area nested in another Mirror Area', () => {
    const { run } = publishWith(
      [
        mirrorEntry(),
        mirrorEntry({ area: 'core/docs/backstage', collect: [{ from: 'backstage/**', to: '.' }], paths: ['backstage/**'] }),
      ],
      { files: { 'docs/guide.md': '# Guide\n', 'backstage/index.md': '# Backstage\n' } },
    )

    expect(run.status).toBe(0)
    expect(exists(readRemote(world), 'site/raw/core/docs/backstage/index.md')).toBe(true)
    expect(exists(readRemote(world), 'site/raw/core/docs/guide.md')).toBe(true)
  })

  test('accepts sibling Areas and an Area whose name only starts like another', () => {
    const { run } = publishWith([releaseEntry({ area: 'outer' }), releaseEntry({ area: 'outer2' })], RELEASE)

    expect(run.status).toBe(0)
    expect(exists(readRemote(world), 'site/raw/outer2/docs_publisher/1.0.0/.meta.json')).toBe(true)
  })
})

describe('publishSourceBranch names a folder inside the Area', () => {
  test.each([
    ['release/1.0.0', 'a branch name cannot contain "/"'],
    ['1.2.0', 'that name is reserved: a version, `latest`, `versions.json`, `index.json` or `.meta.json`'],
    ['latest', 'that name is reserved: a version, `latest`, `versions.json`, `index.json` or `.meta.json`'],
    ['versions.json', 'that name is reserved: a version, `latest`, `versions.json`, `index.json` or `.meta.json`'],
  ])('refuses the source branch %s before writing anything', (sourceBranch, reason) => {
    const source = makeSource(world, `branch-source-${++seq}`)
    releaseCommit(
      source,
      { ...featureFiles('docs_publisher'), ...entriesFile([releaseEntry({ publishSourceBranch: true })]) },
      TAG,
      DATE,
    )
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world, `branch-docs-${seq}`), { source, tag: TAG, sourceBranch })

    expect(run.status).toBe(2)
    expect(run.output).toContain(
      `entry 1 (area "features"): publishSourceBranch would publish an Area folder named "${sourceBranch}": ${reason}`,
    )
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('is refused on a mirror entry', () => {
    expectRefused(
      publishWith([mirrorEntry({ publishSourceBranch: true })], RELEASE),
      '"publishSourceBranch" is not allowed on a mirror entry',
    )
  })

  test('must be true or false, and says how to write it', () => {
    expectRefused(
      publishWith([releaseEntry({ publishSourceBranch: 'yes' })], RELEASE),
      'entry 1 (area "features"): publishSourceBranch must be true or false (write true or false without quotes)',
    )
  })
})
