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
  mirrorEntry,
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
  SOURCE_REPO,
  tagRelease,
  unnamedReleaseEntry,
} from '../test/harness.mjs'

const { discoverAreas } = await import(renderedScript('discovery.mjs'))

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

  test('a push refreshes a Branch Version folder its own range does not name', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ publishSourceBranch: true })]) },
      'alpha-v1.0.0',
      DATE,
    )
    expect(runPublisher(cloneDocs(world, 'seeded'), { source, tag: 'alpha-v1.0.0' }).status).toBe(0)
    const seeded = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'packages/alpha/templates/docs/intro.md': '# alpha on main\n' }, 'alpha docs on main')
    expect(runPublisher(cloneDocs(world, 'alpha-push'), { source, before: seeded, after: git(source, 'rev-parse', 'HEAD') }).status).toBe(0)
    // The push that reaches alpha builds its folder, and a later push moves the branch on without naming alpha again.
    commitSource(source, { 'packages/alpha/templates/docs/intro.md': '# alpha after the race\n' }, 'alpha docs again')
    const unrelated = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'README.md': '# Features (main)\n' }, 'a file no package holds')

    const run = runPublisher(cloneDocs(world, 'later-push'), { source, before: unrelated, after: git(source, 'rev-parse', 'HEAD') })

    expect(run.status).toBe(0)
    expect(readTree(readRemote(world), `${FEATURES_AREA}/alpha/main`)).toEqual({
      '.meta.json': branchMeta(source, 'features'),
      'CHANGELOG.md': '# Changelog\n',
      'images/logo.png': image('alpha-logo'),
      'intro.md': '# alpha after the race\n',
      'schema.json': '{}\n',
    })
  })

  test('a push from the branch tip rebuilds a Branch Version folder whose marker names a commit it does not have', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ publishSourceBranch: true })]) },
      'alpha-v1.0.0',
      DATE,
    )
    // The folder was built from a history the source branch has since been rewritten away from.
    seedDocs(world, {
      [`${FEATURES_AREA}/alpha/main/.meta.json`]: meta({
        source: SOURCE_REPO, area: 'features', branch: 'main', sourceRevision: 'a'.repeat(40), date: DATE,
      }),
      [`${FEATURES_AREA}/alpha/main/intro.md`]: '# a build from a history this repo no longer has\n',
    })
    commitSource(source, { 'packages/alpha/templates/docs/intro.md': '# alpha at the tip\n' }, 'the history is rewritten')
    const head = git(source, 'rev-parse', 'HEAD')

    // The range names no package: only the marker can tell that the folder is not the tip's build.
    const run = runPublisher(cloneDocs(world, 'docs-rewritten'), { source, before: head, after: head })

    expect(run.status).toBe(0)
    expect(readTree(readRemote(world), `${FEATURES_AREA}/alpha/main`)).toEqual({
      '.meta.json': branchMeta(source, 'features'),
      'CHANGELOG.md': '# Changelog\n',
      'images/logo.png': image('alpha-logo'),
      'intro.md': '# alpha at the tip\n',
      'schema.json': '{}\n',
    })
  })

  test('a push from a checkout behind the published Branch Version folder leaves it alone', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ publishSourceBranch: true })]) },
      'alpha-v1.0.0',
      DATE,
    )
    const behind = cloneSource(world, source, 'checkout-behind')
    const seeded = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'packages/alpha/templates/docs/intro.md': '# alpha on main\n' }, 'alpha docs on main')
    expect(runPublisher(cloneDocs(world, 'docs-tip'), { source, before: seeded, after: git(source, 'rev-parse', 'HEAD') }).status).toBe(0)
    const published = readTree(readRemote(world), `${FEATURES_AREA}/alpha/main`)
    // The range names alpha, so this push would rebuild it from a checkout that never had the published commit.
    git(behind, 'fetch', '--quiet', 'origin')

    const run = runPublisher(cloneDocs(world, 'docs-behind'), { source: behind, before: seeded, after: git(source, 'rev-parse', 'HEAD') })

    expect(run.status).toBe(0)
    expect(readTree(readRemote(world), `${FEATURES_AREA}/alpha/main`)).toEqual(published)
  })

  test('a push from behind the tip leaves a Branch Version folder whose marker names an unknown commit', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ publishSourceBranch: true })]) },
      'alpha-v1.0.0',
      DATE,
    )
    const unknown = meta({
      source: SOURCE_REPO, area: 'features', branch: 'main', sourceRevision: 'a'.repeat(40), date: DATE,
    })
    seedDocs(world, {
      [`${FEATURES_AREA}/alpha/main/.meta.json`]: unknown,
      [`${FEATURES_AREA}/alpha/main/intro.md`]: '# a build from a history this repo no longer has\n',
    })
    const behind = cloneSource(world, source, 'checkout-behind-unknown')
    const head = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'notes.md': '# Notes\n' }, 'the branch moves on')
    git(behind, 'fetch', '--quiet', 'origin')

    const run = runPublisher(cloneDocs(world, 'docs-unknown'), { source: behind, before: head, after: head })

    expect(run.status).toBe(0)
    expect(readTree(readRemote(world), `${FEATURES_AREA}/alpha/main`)).toEqual({
      '.meta.json': unknown,
      'intro.md': '# a build from a history this repo no longer has\n',
    })
  })

  test('a push from behind the tip does not recreate a Branch Version folder a newer run retired', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ publishSourceBranch: true })]) },
      'alpha-v1.0.0',
      DATE,
    )
    expect(runReconcile(world, source).status).toBe(0)
    expect(exists(readRemote(world), `${FEATURES_AREA}/alpha/main`)).toBe(true)
    // The push changes alpha, and a newer run retires the folder before this one resumes.
    const behind = cloneSource(world, source, 'checkout-behind-retired')
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'packages/alpha/templates/docs/intro.md': '# alpha on main\n' }, 'alpha docs on main')
    const after = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { ...entriesFile([releaseEntry()]) }, 'stop publishing the branch')
    expect(runReconcile(world, source).status).toBe(0)
    expect(exists(readRemote(world), `${FEATURES_AREA}/alpha/main`)).toBe(false)
    git(behind, 'fetch', '--quiet', 'origin')

    const run = runPublisher(cloneDocs(world, 'docs-retired'), { source: behind, before, after })

    expect(run.status).toBe(0)
    expect(exists(readRemote(world), `${FEATURES_AREA}/alpha/main`)).toBe(false)
  })

  test('a push from the tip leaves a Branch Version folder built from a commit ahead of it', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ publishSourceBranch: true })]) },
      'alpha-v1.0.0',
      DATE,
    )
    // The docs hold a build from a commit the branch tip does not contain, and this checkout has it.
    const tip = git(source, 'rev-parse', 'HEAD')
    git(source, 'checkout', '--quiet', '-b', 'ahead')
    commitSource(source, { 'packages/alpha/templates/docs/intro.md': '# alpha ahead\n' }, 'a commit the tip does not have')
    const ahead = meta({
      source: SOURCE_REPO, area: 'features', branch: 'main', sourceRevision: git(source, 'rev-parse', 'HEAD'), date: DATE,
    })
    git(source, 'checkout', '--quiet', 'main')
    seedDocs(world, {
      [`${FEATURES_AREA}/alpha/main/.meta.json`]: ahead,
      [`${FEATURES_AREA}/alpha/main/intro.md`]: '# alpha ahead\n',
    })

    const run = runPublisher(cloneDocs(world, 'docs-ahead'), { source, before: tip, after: tip })

    expect(run.status).toBe(0)
    expect(readTree(readRemote(world), `${FEATURES_AREA}/alpha/main`)).toEqual({
      '.meta.json': ahead,
      'intro.md': '# alpha ahead\n',
    })
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

  test('a run on a new source branch keeps the Branch Version folder the old branch published', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ publishSourceBranch: true })]) },
      'alpha-v1.0.0',
      DATE,
    )
    expect(runReconcile(world, source).status).toBe(0)
    const branch = readTree(readRemote(world), `${FEATURES_AREA}/alpha/main`)

    // The folder was built from main, and prune decides when it retires: the shared files of the Area keep it.
    const run = runPublisher(cloneDocs(world), {
      source: cloneSource(world, source, 'checkout-develop'), reconcile: true, sourceBranch: 'develop',
    })

    expect(run.status).toBe(0)
    expect(readTree(readRemote(world), `${FEATURES_AREA}/alpha/main`)).toEqual(branch)
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

describe('an Area whose only folders are Branch Version folders', () => {
  // A release entry publishes the Branch Version folder before its first tag, so an Area can hold the folder and its
  // shared files with no Version folder to establish ownership from.
  function branchOnly(source, files = {}) {
    commitSource(source, { 'index.yaml': CRDS, 'docs/a.md': '# a', ...entriesFile([unnamedReleaseEntry({ publishSourceBranch: true })]), ...files }, 'publish the branch')
    seedDocs(world, {
      [`${CRDS_AREA}/main/.meta.json`]: branchMeta(source, 'core/crds'),
      [`${CRDS_AREA}/main/index.yaml`]: CRDS,
      [`${CRDS_AREA}/README.md`]: '# CRDS\n',
      [`${CRDS_AREA}/index.json`]: '[]\n',
    })
    return source
  }

  test('retires its top-level files when its entry is gone', () => {
    const source = branchOnly(makeSource(world))
    commitSource(source, entriesFile([]), 'drop the crds entry')

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(exists(landed, `${CRDS_AREA}/main`)).toBe(false)
    expect(exists(landed, `${CRDS_AREA}/README.md`)).toBe(false)
    expect(exists(landed, `${CRDS_AREA}/index.json`)).toBe(false)
    expect(exists(landed, CRDS_AREA)).toBe(false)
  })

  test('leaves nothing behind to block a switch of the Area to mirror mode', () => {
    const source = branchOnly(makeSource(world))
    commitSource(source, entriesFile([mirrorEntry({ area: 'core/crds' })]), 'now a mirror')

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, `${CRDS_AREA}/a.md`)).toBe('# a')
    expect(exists(landed, `${CRDS_AREA}/main`)).toBe(false)
    expect(exists(landed, `${CRDS_AREA}/README.md`)).toBe(false)
    expect(exists(landed, `${CRDS_AREA}/index.json`)).toBe(false)
    expect(run.summary).toContain('its entry is now in mirror mode')
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

      const found = discoverAreas(dir, 'site/raw')
      const claims = (kind) => found.claims.filter((claim) => claim.kind === kind)

      expect(claims('Branch')).toEqual([{
        dir: 'site/raw/core/crds/main', areaDir: 'site/raw/core/crds', area: 'core/crds', name: null,
        branch: 'main', source: 'acme/source', kind: 'Branch', sourceRevision: 'a'.repeat(40), date: DATE,
      }])
      expect(claims('Mirror').map((mirror) => mirror.dir)).toEqual(['site/raw/core/docs'])
      expect(claims('Version').map((version) => version.dir)).toEqual(['site/raw/core/crds/v1.2.0'])
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
