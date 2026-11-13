import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  branchMeta,
  cloneDocs,
  cloneSource,
  commitSource,
  entriesFile,
  exists,
  featureFiles,
  git,
  image,
  makeDocsRemote,
  makeSource,
  meta,
  packageFiles,
  readFile,
  readJson,
  readRemote,
  readTree,
  releaseCommit,
  releaseEntry,
  remoteCommitCount,
  renderedScript,
  runPublisher,
  runReconcile,
  seedDocs,
  tagRelease,
  unnamedReleaseEntry,
} from '../test/harness.mjs'

const { scan } = await import(renderedScript('prune.mjs'))

const DATE = '2026-01-02T03:04:05Z'
const CRDS_AREA = 'site/raw/core/crds'
const FEATURES_AREA = 'site/raw/features'
const CRDS = 'kind: CustomResourceDefinition\n'

let world

beforeEach(() => {
  world = makeDocsRemote()
})

afterEach(() => {
  world.cleanup()
})

function crdsSource() {
  const source = makeSource(world)
  releaseCommit(
    source,
    { 'index.yaml': CRDS, ...entriesFile([unnamedReleaseEntry({ publishSourceBranch: true })]) },
    'v1.2.0',
    DATE,
  )
  return source
}

describe('a release entry that publishes its source branch', () => {
  test('a push publishes <area>/main beside the Version folders, and no version list names it', () => {
    const source = crdsSource()
    expect(runPublisher(cloneDocs(world, 'seeded'), { source, tag: 'v1.2.0' }).status).toBe(0)
    const versions = readFile(readRemote(world), `${CRDS_AREA}/versions.json`)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'index.yaml': `${CRDS}more\n` }, 'CRDs on main')

    const run = runPublisher(cloneDocs(world), { source, before, after: git(source, 'rev-parse', 'HEAD') })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readTree(landed, `${CRDS_AREA}/main`)).toEqual({
      '.meta.json': branchMeta(source, 'core/crds'),
      'index.yaml': `${CRDS}more\n`,
    })
    expect(readJson(landed, `${CRDS_AREA}/versions.json`).map((row) => row.version)).toEqual(['v1.2.0'])
    expect(readFile(landed, `${CRDS_AREA}/versions.json`)).toBe(versions)
    expect(exists(landed, `${CRDS_AREA}/index.json`)).toBe(false)
    expect(readFile(landed, `${CRDS_AREA}/latest/index.yaml`)).toBe(CRDS)
  })

  test('a push touching one package refreshes only that package branch folder', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      {
        ...featureFiles('alpha'),
        ...packageFiles('beta'),
        ...entriesFile([releaseEntry({ publishSourceBranch: true })]),
      },
      'alpha-v1.0.0',
      DATE,
    )
    expect(runPublisher(cloneDocs(world, 'seeded'), { source, tag: 'alpha-v1.0.0' }).status).toBe(0)
    const seeded = readRemote(world)
    const versions = readFile(seeded, `${FEATURES_AREA}/alpha/versions.json`)
    const index = readFile(seeded, `${FEATURES_AREA}/index.json`)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'packages/alpha/templates/docs/intro.md': '# alpha on main\n' }, 'alpha docs on main')

    const run = runPublisher(cloneDocs(world), { source, before, after: git(source, 'rev-parse', 'HEAD') })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readTree(landed, `${FEATURES_AREA}/alpha/main`)).toEqual({
      '.meta.json': branchMeta(source, 'features'),
      'CHANGELOG.md': '# Changelog\n',
      'images/logo.png': image('alpha-logo'),
      'intro.md': '# alpha on main\n',
      'schema.json': '{}\n',
    })
    expect(exists(landed, `${FEATURES_AREA}/beta/main`)).toBe(false)
    expect(readFile(landed, `${FEATURES_AREA}/alpha/versions.json`)).toBe(versions)
    expect(readFile(landed, `${FEATURES_AREA}/index.json`)).toBe(index)
    expect(readJson(landed, `${FEATURES_AREA}/index.json`).features.map((row) => row.name)).toEqual(['alpha'])
    expect(readFile(landed, `${FEATURES_AREA}/alpha/1.0.0/intro.md`)).toBe('# alpha\n')
  })

  test('turning publishSourceBranch off prunes the branch folder and keeps the Version folders', () => {
    const source = crdsSource()
    expect(runReconcile(world, source).status).toBe(0)
    expect(exists(readRemote(world), `${CRDS_AREA}/main/.meta.json`)).toBe(true)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { ...entriesFile([unnamedReleaseEntry()]) }, 'stop publishing the branch')
    const commits = remoteCommitCount(world)
    const checkout = cloneSource(world, source, 'checkout-no-branch')

    const run = runPublisher(cloneDocs(world), { source: checkout, before, after: git(source, 'rev-parse', 'HEAD') })

    expect(run.status).toBe(0)
    expect(run.summary).not.toContain('This push needs a prune')
    expect(run.summary).toContain(`- Pruned \`${CRDS_AREA}/main\`: its entry no longer publishes the source branch.`)
    const landed = readRemote(world)
    expect(exists(landed, `${CRDS_AREA}/main`)).toBe(false)
    expect(exists(landed, `${CRDS_AREA}/v1.2.0/index.yaml`)).toBe(true)
    expect(readJson(landed, `${CRDS_AREA}/versions.json`).map((row) => row.version)).toEqual(['v1.2.0'])
    expect(remoteCommitCount(world)).toBe(commits + 1)
  })

  test('refuses a source branch that is not a git branch name before it can empty a folder outside the Area', () => {
    const source = crdsSource()
    // `..` would make the Branch Version folder the Area itself, and the replacement would delete every file in it.
    seedDocs(world, { [`${CRDS_AREA}/hand-made.md`]: '# Hand made\n' })
    const head = git(source, 'rev-parse', 'HEAD')
    const before = remoteCommitCount(world)
    const docs = cloneDocs(world, 'docs-invalid-branch')
    const docsHead = git(docs, 'rev-parse', 'HEAD')

    const run = runPublisher(docs, { source, before: head, after: head, sourceBranch: '..' })

    expect(run.status).toBe(2)
    expect(run.output).toContain('source-branch ".." is not a valid git branch name')
    expect(readFile(readRemote(world), `${CRDS_AREA}/hand-made.md`)).toBe('# Hand made\n')
    expect(remoteCommitCount(world)).toBe(before)
    expect(git(docs, 'rev-parse', 'HEAD')).toBe(docsHead)
  })

  test('a release that rebuilds the Area keeps its branch folder', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ publishSourceBranch: true })]) },
      'alpha-v1.0.0',
      DATE,
    )
    expect(runReconcile(world, source).status).toBe(0)
    const branch = readTree(readRemote(world), `${FEATURES_AREA}/alpha/main`)
    releaseCommit(source, { 'packages/alpha/templates/docs/intro.md': '# alpha 1.1.0\n' }, 'alpha-v1.1.0', '2026-01-03T03:04:05Z')

    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.1.0' })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readTree(landed, `${FEATURES_AREA}/alpha/main`)).toEqual(branch)
    expect(readFile(landed, `${FEATURES_AREA}/alpha/1.1.0/intro.md`)).toBe('# alpha 1.1.0\n')
    expect(readJson(landed, `${FEATURES_AREA}/alpha/versions.json`).map((row) => row.version)).toEqual(['1.1.0', '1.0.0'])
  })

  test('a package that leaves the repo goes with its branch folder', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      {
        ...featureFiles('alpha'),
        ...packageFiles('beta'),
        ...entriesFile([releaseEntry({ publishSourceBranch: true })]),
      },
      'alpha-v1.0.0',
      DATE,
    )
    tagRelease(source, 'beta-v1.0.0', DATE)
    expect(runReconcile(world, source).status).toBe(0)
    expect(exists(readRemote(world), `${FEATURES_AREA}/alpha/main`)).toBe(true)
    rmSync(join(source, 'packages/alpha'), { recursive: true, force: true })
    commitSource(source, {}, 'retire alpha')

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    expect(run.summary).toContain(
      `- Pruned \`${FEATURES_AREA}/alpha\`, \`${FEATURES_AREA}/alpha/main\`: \`packages/alpha\` is gone from the source repo.`,
    )
    const landed = readRemote(world)
    expect(exists(landed, `${FEATURES_AREA}/alpha`)).toBe(false)
    expect(exists(landed, `${FEATURES_AREA}/beta/main`)).toBe(true)
    expect(readJson(landed, `${FEATURES_AREA}/index.json`).features.map((row) => row.name)).toEqual(['beta'])
  })

  test('a reconcile publishes the branch folder again after it was deleted', () => {
    const source = crdsSource()
    expect(runReconcile(world, source).status).toBe(0)
    const tree = readTree(readRemote(world), `${CRDS_AREA}/main`)
    seedDocs(world, { [`${CRDS_AREA}/main`]: null })
    expect(exists(readRemote(world), `${CRDS_AREA}/main`)).toBe(false)

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    expect(readTree(readRemote(world), `${CRDS_AREA}/main`)).toEqual(tree)
  })
})

describe('the Branch Version folder marker', () => {
  test('is its own kind: never a Mirror marker and never a Version marker', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'docs-publisher-scan-')))
    try {
      for (const folder of ['core/crds/main', 'core/crds/v1.2.0', 'core/docs']) {
        mkdirSync(join(dir, 'site/raw', folder), { recursive: true })
      }
      const revision = 'a'.repeat(40)
      writeFileSync(join(dir, 'site/raw/core/crds/main/.meta.json'), meta({
        source: 'acme/source', area: 'core/crds', branch: 'main', sourceRevision: revision, date: DATE,
      }))
      writeFileSync(join(dir, 'site/raw/core/crds/v1.2.0/.meta.json'), meta({
        source: 'acme/source', tag: 'v1.2.0', date: DATE,
      }))
      writeFileSync(join(dir, 'site/raw/core/docs/.meta.json'), meta({
        source: 'acme/source', sourceRevision: revision, sourceBranch: 'main', date: DATE,
      }))

      const found = scan(dir, 'site/raw')

      expect(found.branches).toEqual([{
        dir: 'site/raw/core/crds/main', areaDir: 'site/raw/core/crds', area: 'core/crds', name: null,
        branch: 'main', source: 'acme/source', kind: 'Branch', sourceRevision: 'a'.repeat(40), date: DATE,
      }])
      expect(found.mirrors.map((mirror) => mirror.dir)).toEqual(['site/raw/core/docs'])
      expect(found.versions.map((version) => version.dir)).toEqual(['site/raw/core/crds/v1.2.0'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a marker without a valid area is not a Branch Version folder: the run refuses it like any damaged marker', () => {
    const source = crdsSource()
    const damaged = meta({ source: 'acme/source', branch: 'main', sourceRevision: 'a'.repeat(40), date: DATE })
    seedDocs(world, {
      [`${CRDS_AREA}/main/.meta.json`]: damaged,
      [`${CRDS_AREA}/main/keep.md`]: 'KEEP\n',
    })
    const commits = remoteCommitCount(world)

    const run = runReconcile(world, source)

    expect(run.status).toBe(2)
    expect(run.output).toContain(`invalid .meta.json: ${CRDS_AREA}/main/.meta.json`)
    expect(readFile(readRemote(world), `${CRDS_AREA}/main/keep.md`)).toBe('KEEP\n')
    expect(remoteCommitCount(world)).toBe(commits)
  })

  test('a push that changes nothing the entry holds keeps the folder, prunes nothing and commits nothing', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      { ...featureFiles('alpha'), ...packageFiles('beta'), ...entriesFile([releaseEntry({ publishSourceBranch: true })]) },
      'alpha-v1.0.0',
      DATE,
    )
    expect(runReconcile(world, source).status).toBe(0)
    const tree = readTree(readRemote(world), `${FEATURES_AREA}/alpha/main`)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'notes.md': '# Notes\n' }, 'unrelated push')
    const commits = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, before, after: git(source, 'rev-parse', 'HEAD') })

    expect(run.status).toBe(0)
    expect(run.summary).not.toContain('This push needs a prune')
    expect(readTree(readRemote(world), `${FEATURES_AREA}/alpha/main`)).toEqual(tree)
    expect(remoteCommitCount(world)).toBe(commits)
  })
})
