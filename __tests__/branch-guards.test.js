import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
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
  readRemote,
  readTree,
  ROOT,
  releaseCommit,
  releaseEntry,
  remoteCommitCount,
  runPublisher,
  runReconcile,
  seedDocs,
  startPublisher,
  tagRelease,
  unnamedReleaseEntry,
  waitForFile,
  write,
} from '../test/harness.mjs'

const DATE = '2026-01-02T03:04:05Z'
const CRDS = 'kind: CustomResourceDefinition\n'
const CRDS_AREA = 'site/raw/core/crds'
const FEATURES_AREA = 'site/raw/features'
const OWNERSHIP = 'Area "core/crds" belongs to other/producer, but this repo is acme/source. Choose another Area.'
const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

// The sentence the ownership guard returns, complete: the README quotes it as it is.
const ownership = (area) =>
  `Area "${area}" belongs to other/producer, but this repo is acme/source. Choose another Area. If this repo was renamed or is taking over the Area, update "source" in that Area's .meta.json files in the docs repo.`

let world

beforeEach(() => {
  world = makeDocsRemote()
})

afterEach(() => {
  world.cleanup()
})

// The branch-only release Area the re-check reproduced: one release entry that publishes `main` and collects one
// file, so no Version folder and no Area files stand around the Branch Version folder.
function crdsSource(overrides = {}) {
  const source = makeSource(world)
  releaseCommit(
    source,
    { 'index.yaml': CRDS, ...entriesFile([unnamedReleaseEntry({ publishSourceBranch: true, ...overrides })]) },
    'v1.0.0',
    DATE,
  )
  return source
}

function push(source, options = {}) {
  const before = git(source, 'rev-parse', 'HEAD')
  commitSource(source, { 'index.yaml': 'kind: changed\n' }, 'change the collected file')
  return runPublisher(cloneDocs(world), { source, before, after: git(source, 'rev-parse', 'HEAD'), ...options })
}

describe('a Branch Version folder a run replaces', () => {
  test('a push behind a symlinked parent folder changes nothing outside the docs checkout', () => {
    const source = crdsSource({ areaFiles: [] })
    const outside = join(world.base, 'outside')
    mkdirSync(join(outside, 'main'), { recursive: true })
    writeFileSync(join(outside, 'main', 'keep.md'), 'OUTSIDE THE CHECKOUT\n')
    const seed = cloneDocs(world, 'symlink-seed')
    mkdirSync(join(seed, 'site/raw/core'), { recursive: true })
    symlinkSync(outside, join(seed, `${CRDS_AREA}`.replace('/main', '')))
    git(seed, 'add', '-A')
    git(seed, 'commit', '-m', 'symlink the Area')
    git(seed, 'push', 'origin', 'main')
    const commits = remoteCommitCount(world)

    const run = push(source)

    expect(run.status).toBe(2)
    // A push reaches the Branch Version folder first; a reconcile plans its Version folders first. Both are behind the
    // same symlink, so both refuse it.
    expect(run.summary).toContain(`refusing to write through symlink: ${CRDS_AREA}/`)
    expect(readFileSync(join(outside, 'main', 'keep.md'), 'utf8')).toBe('OUTSIDE THE CHECKOUT\n')
    expect(remoteCommitCount(world)).toBe(commits)
  })

  test('a push refuses a symlink inside the folder before it removes anything', () => {
    const source = crdsSource({ areaFiles: [] })
    const outside = join(world.base, 'foreign-marker.json')
    const foreign = meta({ source: 'other/producer', area: 'core/crds', branch: 'main', sourceRevision: 'a'.repeat(40), date: DATE })
    writeFileSync(outside, foreign)
    const seed = cloneDocs(world, 'symlink-tree-seed')
    mkdirSync(join(seed, `${CRDS_AREA}/main`), { recursive: true })
    writeFileSync(join(seed, `${CRDS_AREA}/main/keep.md`), 'FOREIGN\n')
    symlinkSync(outside, join(seed, `${CRDS_AREA}/main/.meta.json`))
    git(seed, 'add', '-A')
    git(seed, 'commit', '-m', 'symlink the marker')
    git(seed, 'push', 'origin', 'main')
    const commits = remoteCommitCount(world)

    const run = push(source)

    expect(run.status).toBe(2)
    expect(run.output).toContain(`refusing to publish symlink: ${CRDS_AREA}/main/.meta.json`)
    expect(readFileSync(outside, 'utf8')).toBe(foreign)
    expect(exists(readRemote(world), `${CRDS_AREA}/main/keep.md`)).toBe(true)
    expect(remoteCommitCount(world)).toBe(commits)
  })

  test('a push refuses to replace a Branch Version folder another repo owns', () => {
    const source = crdsSource({ areaFiles: [] })
    const foreign = meta({ source: 'other/producer', area: 'core/crds', branch: 'main', sourceRevision: 'a'.repeat(40), date: DATE })
    seedDocs(world, {
      [`${CRDS_AREA}/main/.meta.json`]: foreign,
      [`${CRDS_AREA}/main/keep.md`]: 'FOREIGN\n',
    })
    const commits = remoteCommitCount(world)

    const run = push(source)

    expect(run.status).toBe(2)
    expect(run.summary).toContain(OWNERSHIP)
    expect(readTree(readRemote(world), `${CRDS_AREA}/main`)).toEqual({ '.meta.json': foreign, 'keep.md': 'FOREIGN\n' })
    expect(remoteCommitCount(world)).toBe(commits)
  })

  test('a push keeps a Mirror Area inside a Branch Version folder another repo owns', () => {
    const source = crdsSource({ areaFiles: [] })
    seedDocs(world, {
      [`${CRDS_AREA}/main/notes/.meta.json`]: meta({
        source: 'other/producer', sourceRevision: 'a'.repeat(40), sourceBranch: 'main', date: DATE,
      }),
      [`${CRDS_AREA}/main/notes/keep.md`]: 'FOREIGN MIRROR\n',
    })
    const commits = remoteCommitCount(world)

    const run = push(source)

    expect(run.status).toBe(2)
    expect(run.summary).toContain(OWNERSHIP)
    expect(readFile(readRemote(world), `${CRDS_AREA}/main/notes/keep.md`)).toBe('FOREIGN MIRROR\n')
    expect(remoteCommitCount(world)).toBe(commits)
  })

  test('a reconcile refuses to replace a Branch Version folder another repo owns', () => {
    const source = crdsSource()
    const foreign = meta({ source: 'other/producer', area: 'core/crds', branch: 'main', sourceRevision: 'a'.repeat(40), date: DATE })
    seedDocs(world, {
      [`${CRDS_AREA}/main/.meta.json`]: foreign,
      [`${CRDS_AREA}/main/keep.md`]: 'FOREIGN\n',
    })
    const commits = remoteCommitCount(world)

    const run = runReconcile(world, source)

    expect(run.status).toBe(2)
    expect(run.summary).toContain(OWNERSHIP)
    expect(readTree(readRemote(world), `${CRDS_AREA}/main`)).toEqual({ '.meta.json': foreign, 'keep.md': 'FOREIGN\n' })
    expect(remoteCommitCount(world)).toBe(commits)
  })

  test('turning publishSourceBranch off deletes a named Branch Version folder', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ publishSourceBranch: true })]) },
      'alpha-v1.0.0',
      DATE,
    )
    expect(runReconcile(world, source).status).toBe(0)
    expect(exists(readRemote(world), `${FEATURES_AREA}/alpha/main/.meta.json`)).toBe(true)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([releaseEntry()]), 'stop publishing the branch')

    const run = runPublisher(cloneDocs(world), {
      source: cloneSource(world, source, 'checkout-branch-off'), before, after: git(source, 'rev-parse', 'HEAD'),
    })

    expect(run.status).toBe(0)
    expect(run.summary).toContain(
      `- Pruned \`${FEATURES_AREA}/alpha/main\`: its entry no longer publishes the source branch.`,
    )
    const landed = readRemote(world)
    expect(exists(landed, `${FEATURES_AREA}/alpha/main`)).toBe(false)
    expect(exists(landed, `${FEATURES_AREA}/alpha/1.0.0/schema.json`)).toBe(true)
  })
})

// The docs repo can move while the run pushes, so a guard that only ran in the first plan would let the second
// attempt replace what the first never saw. The hook holds the push open while the race lands.
describe('a rejected push that moves the docs repo', () => {
  async function racyRun(kind, seed) {
    const source = crdsSource({ areaFiles: [] })
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'index.yaml': 'kind: changed\n' }, 'change the collected file')
    const checkout = cloneSource(world, source, `checkout-race-${kind}-${Math.random()}`)
    const docs = cloneDocs(world, `docs-race-${kind}-${Math.random()}`)
    const ready = join(world.base, `ready-${Math.random()}`)
    const resume = join(world.base, `resume-${Math.random()}`)
    write(docs, { '.git/hooks/pre-push': `#!/bin/sh\ntouch "${ready}"\nwhile [ ! -f "${resume}" ]; do sleep 0.01; done\n` })
    chmodSync(join(docs, '.git/hooks/pre-push'), 0o755)
    const pending = startPublisher(docs, kind === 'push'
      ? { source: checkout, before, after: git(source, 'rev-parse', 'HEAD') }
      : { source: checkout, reconcile: true })
    try {
      await waitForFile(ready)
      seed()
    } finally {
      writeFileSync(resume, '')
    }
    return pending
  }

  const foreign = meta({ source: 'other/producer', area: 'core/crds', branch: 'main', sourceRevision: 'a'.repeat(40), date: DATE })

  test.each(['push', 'reconcile'])('a %s rechecks the owner of a Branch Version folder the race reveals', async (kind) => {
    const run = await racyRun(kind, () => seedDocs(world, {
      [`${CRDS_AREA}/main/.meta.json`]: foreign,
      [`${CRDS_AREA}/main/keep.md`]: 'FOREIGN\n',
    }))

    expect(run.status).toBe(2)
    expect(run.summary).toContain(OWNERSHIP)
    expect(readTree(readRemote(world), `${CRDS_AREA}/main`)).toEqual({ '.meta.json': foreign, 'keep.md': 'FOREIGN\n' })
  }, 30000)

  test.each(['push', 'reconcile'])('a %s rechecks the path of a Branch Version folder the race reveals', async (kind) => {
    const outside = join(world.base, `outside-race-${Math.random()}`)
    const run = await racyRun(kind, () => {
      mkdirSync(join(outside, 'main'), { recursive: true })
      writeFileSync(join(outside, 'main', 'keep.md'), 'OUTSIDE THE CHECKOUT\n')
      const seed = cloneDocs(world, `seed-race-${Math.random()}`)
      mkdirSync(join(seed, 'site/raw/core'), { recursive: true })
      symlinkSync(outside, join(seed, CRDS_AREA))
      git(seed, 'add', '-A')
      git(seed, 'commit', '-m', 'symlink the Area')
      git(seed, 'push', 'origin', 'main')
    })

    expect(run.status).toBe(2)
    // A push reaches the Branch Version folder first; a reconcile plans its Version folders first. Both are behind the
    // same symlink, so both refuse it.
    expect(run.summary).toContain(`refusing to write through symlink: ${CRDS_AREA}/`)
    expect(readFileSync(join(outside, 'main', 'keep.md'), 'utf8')).toBe('OUTSIDE THE CHECKOUT\n')
  }, 30000)
})

describe('a Mirror Area around a Branch Version folder', () => {
  function mirrorSource(area) {
    const source = makeSource(world)
    commitSource(source, { 'docs/index.md': 'MIRROR\n', ...entriesFile([mirrorEntry({ area })]) }, 'mirror entry')
    return source
  }

  // No Version folder and no release entry: the Branch Version folder is the only evidence that the docs hold a
  // release Area there, and its marker names the Area.
  function seedBranch(dir, area) {
    seedDocs(world, {
      [`${dir}/.meta.json`]: meta({
        source: 'other/producer', area, branch: 'main', sourceRevision: 'a'.repeat(40), date: DATE,
      }),
      [`${dir}/keep.md`]: 'FOREIGN\n',
    })
  }

  function seedBranchFolder() {
    seedBranch(`${CRDS_AREA}/main`, 'core/crds')
  }

  const releaseAreaRefusal = (areaDir, releaseArea) =>
    `refusing to publish ${areaDir}: it sits inside the release Area ${releaseArea}, and a Mirror Area cannot sit inside a release Area. Choose another Area.`

  function mirroredPush(source) {
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'docs/index.md': 'MIRROR CHANGED\n' }, 'change the mirror docs')
    return runPublisher(cloneDocs(world), { source, before, after: git(source, 'rev-parse', 'HEAD') })
  }

  test('a Mirror Area cannot sit beside a Branch Version folder of a release Area', () => {
    const source = mirrorSource('core/crds/notes')
    seedBranchFolder()
    const commits = remoteCommitCount(world)

    const run = mirroredPush(source)

    expect(run.status).toBe(2)
    expect(run.summary).toContain(
      'refusing to publish site/raw/core/crds/notes: it sits inside the release Area site/raw/core/crds, and a Mirror Area cannot sit inside a release Area. Choose another Area.',
    )
    expect(remoteCommitCount(world)).toBe(commits)
  })

  test('a Mirror Area cannot sit inside a Branch Version folder', () => {
    const source = mirrorSource('core/crds/main/notes')
    seedBranchFolder()
    const commits = remoteCommitCount(world)

    const run = mirroredPush(source)

    expect(run.status).toBe(2)
    expect(run.summary).toContain(
      'refusing to publish site/raw/core/crds/main/notes: it sits inside a Branch Version folder at site/raw/core/crds/main',
    )
    expect(remoteCommitCount(world)).toBe(commits)
  })

  test('a Mirror Area cannot replace the release Area a foreign Branch Version marker names', () => {
    const source = mirrorSource('core/crds')
    seedBranchFolder()
    seedDocs(world, { [`${CRDS_AREA}/README.md`]: 'FOREIGN AREA README\n' })
    const commits = remoteCommitCount(world)

    const run = mirroredPush(source)

    expect(run.status).toBe(2)
    expect(run.output).toContain(ownership('core/crds'))
    const landed = readRemote(world)
    expect(readFile(landed, `${CRDS_AREA}/README.md`)).toBe('FOREIGN AREA README\n')
    expect(exists(landed, `${CRDS_AREA}/main/keep.md`)).toBe(true)
    expect(exists(landed, `${CRDS_AREA}/.meta.json`)).toBe(false)
    expect(remoteCommitCount(world)).toBe(commits)
  })

  test('a Mirror Area cannot contain the release Area a foreign Branch Version marker names', () => {
    const source = mirrorSource('core')
    seedBranchFolder()
    seedDocs(world, { [`${CRDS_AREA}/README.md`]: 'FOREIGN AREA README\n' })
    const commits = remoteCommitCount(world)

    const run = mirroredPush(source)

    expect(run.status).toBe(2)
    expect(run.output).toContain(ownership('core'))
    const landed = readRemote(world)
    expect(readFile(landed, `${CRDS_AREA}/README.md`)).toBe('FOREIGN AREA README\n')
    expect(exists(landed, `${CRDS_AREA}/main/keep.md`)).toBe(true)
    expect(exists(landed, 'site/raw/core/.meta.json')).toBe(false)
    expect(remoteCommitCount(world)).toBe(commits)
  })

  test('a Mirror Area cannot sit beside the release Area a named Branch Version marker names', () => {
    const source = mirrorSource('features/notes')
    seedBranch('site/raw/features/alpha/main', 'features')
    const commits = remoteCommitCount(world)

    const run = mirroredPush(source)

    expect(run.status).toBe(2)
    expect(run.output).toContain(releaseAreaRefusal('site/raw/features/notes', 'site/raw/features'))
    expect(exists(readRemote(world), 'site/raw/features/alpha/main/keep.md')).toBe(true)
    expect(remoteCommitCount(world)).toBe(commits)
  })

  test('a Mirror Area cannot sit beside a nested named Branch Version folder', () => {
    const source = mirrorSource('core/crds/notes')
    seedBranch('site/raw/core/crds/alpha/main', 'core/crds')
    const commits = remoteCommitCount(world)

    const run = mirroredPush(source)

    expect(run.status).toBe(2)
    expect(run.output).toContain(releaseAreaRefusal('site/raw/core/crds/notes', 'site/raw/core/crds'))
    expect(exists(readRemote(world), 'site/raw/core/crds/alpha/main/keep.md')).toBe(true)
    expect(remoteCommitCount(world)).toBe(commits)
  })

  test.each([
    ['site/raw/crds/main', 'crds'],
    ['site/raw/core/crds/main', 'core/crds'],
    ['site/raw/features/alpha/main', 'features'],
  ])('publishes a sibling Mirror Area beside the Branch Version folder at %s', (dir, area) => {
    const source = mirrorSource('core/docs')
    seedBranch(dir, area)

    const run = mirroredPush(source)

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(exists(landed, 'site/raw/core/docs/.meta.json')).toBe(true)
    expect(exists(landed, `${dir}/keep.md`)).toBe(true)
  })
})

// The README quotes the guards' messages as they are, so a reader can grep the run's output for them.
describe('the README error examples', () => {
  test('quotes the ownership refusal in full', () => {
    expect(README).toContain(ownership('core/crds'))
    expect(README).not.toContain('Choose another Area. ...')
  })
})

describe('the plan of a Branch Version folder', () => {
  function plan(source, before) {
    const planFile = join(world.base, `plan-${Math.random()}.md`)
    const run = runPublisher(cloneDocs(world), {
      source: cloneSource(world, source, `plan-checkout-${Math.random()}`), plan: true, planFile,
      before, after: git(source, 'rev-parse', 'HEAD'),
    })
    expect(run.status).toBe(0)
    return readFileSync(planFile, 'utf8')
  }

  test('lists the folder the merge would delete', () => {
    const source = crdsSource()
    expect(runReconcile(world, source).status).toBe(0)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([unnamedReleaseEntry()]), 'stop publishing the branch')

    const body = plan(source, before)

    expect(body).toContain('- Delete Branch Version folder `main`: its entry no longer publishes the source branch.')
  })

  test('lists each Area only its own folders', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      {
        ...featureFiles('alpha'),
        ...entriesFile([
          releaseEntry({ publishSourceBranch: true }),
          releaseEntry({ area: 'other', publishSourceBranch: true }),
        ]),
      },
      'alpha-v1.0.0',
      DATE,
    )
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'packages/alpha/templates/docs/intro.md': '# alpha on main\n' }, 'change the alpha docs')

    const body = plan(source, before)

    const sections = body.split('\n### ')
    const section = (name) => sections.find((part) => part.startsWith(`\`${name}\``)) ?? ''
    const branchLines = (text) => text.split('\n').filter((line) => line.includes(' Branch Version folder '))
    expect(branchLines(section('features'))).toEqual(['- Add Branch Version folder `alpha/main`.'])
    expect(branchLines(section('other'))).toEqual(['- Add Branch Version folder `alpha/main`.'])
  })
})

// The README states what a destination change publishes and what it leaves to the reconcile; this pins that split,
// and the text that claims it, so a README that overpromises fails as well as code that does.
describe('changing the destination', () => {
  test('the README leaves Version folders and Branch Version folders to the reconcile', () => {
    expect(README).toContain(
      'It publishes no Version folder, and only the Branch Version folders of the release Areas whose files it changed',
    )
    expect(README).toContain(
      'The rest — every Version folder, the other Branch Version folders and the links of an Area without `areaFiles` — comes from step 3, so run it.',
    )
  })

  test('the push leaves Version folders and Branch Version folders to the reconcile', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ publishSourceBranch: true })]) },
      'alpha-v1.0.0',
      DATE,
    )
    expect(runReconcile(world, source).status).toBe(0)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'claim.yaml': 'docs_root_folder: site/new\n' }, 'change the destination')

    const run = runPublisher(cloneDocs(world, 'docs-new-destination'), {
      source: cloneSource(world, source, 'checkout-new-destination'),
      root: 'site/new', before, after: git(source, 'rev-parse', 'HEAD'),
    })

    expect(run.status).toBe(0)
    expect(Object.keys(readTree(readRemote(world), 'site/new'))).toEqual(['features/README.md', 'features/index.json'])

    const reconcile = runPublisher(cloneDocs(world, 'docs-new-destination-reconcile'), {
      source: cloneSource(world, source, 'checkout-new-destination-reconcile'), root: 'site/new', reconcile: true,
    })

    expect(reconcile.status).toBe(0)
    const landed = readRemote(world)
    expect(exists(landed, 'site/new/features/alpha/1.0.0/schema.json')).toBe(true)
    expect(exists(landed, 'site/new/features/alpha/main/.meta.json')).toBe(true)
  })
})

// A Branch Version marker names the release Area the folder was published into, so it is release-Area evidence: every
// reader validates it the way it validates a Version marker — the shape of the Area, the folder depth its layout puts
// the folder at, its owner, and a symlink before any deletion.
describe('the release Area a Branch Version marker names', () => {
  const branchMarker = (fields) => meta({
    source: 'acme/source', branch: 'main', sourceRevision: 'a'.repeat(40), date: DATE, ...fields,
  })

  // The entries file reads an Area with its own rules, and the marker's `area` is one: an escaping or reserved path
  // is damaged metadata, so the run stops instead of taking the folder's own path for the Area.
  test.each(['..', '../outside', 'latest', 'core/.meta.json'])(
    'an area of %p stops the run before anything is deleted',
    (area) => {
      const source = makeSource(world)
      commitSource(source, { 'index.yaml': CRDS, ...entriesFile([]) }, 'no entries')
      seedDocs(world, {
        [`${CRDS_AREA}/main/.meta.json`]: branchMarker({ area }),
        [`${CRDS_AREA}/main/keep.md`]: 'KEEP\n',
      })
      const commits = remoteCommitCount(world)

      const run = runReconcile(world, source)

      expect(run.status).toBe(2)
      expect(run.output).toContain(`invalid .meta.json: ${CRDS_AREA}/main/.meta.json`)
      expect(readFile(readRemote(world), `${CRDS_AREA}/main/keep.md`)).toBe('KEEP\n')
      expect(remoteCommitCount(world)).toBe(commits)
    },
  )

  // The marker names the Area and the branch, so the folder must sit where its layout puts it: one segment below the
  // Area without `packages`, two with one, and always named after the branch. Nothing is inferred from the folder.
  test.each(['push', 'reconcile'])('a %s refuses a folder three segments below its area', (mode) => {
    const source = makeSource(world)
    releaseCommit(
      source,
      { 'index.yaml': CRDS, ...entriesFile([unnamedReleaseEntry({ publishSourceBranch: true })]) },
      'v1.2.0',
      DATE,
    )
    // The marker names `core`, three segments above the folder: no release layout puts a Branch Version folder there.
    seedDocs(world, {
      [`${CRDS_AREA}/alpha/main/.meta.json`]: branchMarker({ area: 'core' }),
      [`${CRDS_AREA}/alpha/main/keep.md`]: 'KEEP\n',
    })
    const commits = remoteCommitCount(world)

    const run = mode === 'push' ? push(source) : runReconcile(world, source)

    expect(run.status).toBe(2)
    expect(run.output).toContain(`invalid .meta.json: ${CRDS_AREA}/alpha/main/.meta.json`)
    expect(readFile(readRemote(world), `${CRDS_AREA}/alpha/main/keep.md`)).toBe('KEEP\n')
    expect(remoteCommitCount(world)).toBe(commits)
  })

  test('a plan reports the folder it cannot place instead of deleting it', () => {
    const source = makeSource(world)
    commitSource(
      source,
      { 'index.yaml': CRDS, ...entriesFile([unnamedReleaseEntry({ publishSourceBranch: true })]) },
      'entries',
    )
    // The marker names `core`, three segments above the folder: no release layout puts a Branch Version folder there.
    seedDocs(world, {
      [`${CRDS_AREA}/alpha/main/.meta.json`]: branchMarker({ area: 'core' }),
      [`${CRDS_AREA}/alpha/main/keep.md`]: 'KEEP\n',
    })
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([unnamedReleaseEntry({ publishSourceBranch: true, prereleases: true })]), 'entries')
    const planFile = join(world.base, `plan-${Math.random()}.md`)

    const run = runPublisher(cloneDocs(world), {
      source: cloneSource(world, source, `plan-checkout-${Math.random()}`),
      plan: true,
      planFile,
      before,
      after: git(source, 'rev-parse', 'HEAD'),
    })

    expect(run.status).toBe(0)
    const body = readFileSync(planFile, 'utf8')
    expect(body).toContain(`- invalid .meta.json: ${CRDS_AREA}/alpha/main/.meta.json`)
    expect(body).not.toContain('Delete Area')
  })

  // The Area holds a Branch Version folder, an Area file and an extra file, and no Version folder of its own, so the
  // marker is the only evidence that it is a release Area at all — and the only thing that says whose it is.
  describe("a release Area another repo's Branch Version marker names", () => {
    const areaFiles = [{ from: 'README.md', to: 'README.md' }]

    function seedForeignArea(entry = unnamedReleaseEntry({ areaFiles })) {
      const source = makeSource(world)
      commitSource(source, { 'index.yaml': CRDS, 'README.md': '# Ours\n', ...entriesFile([entry]) }, 'entries')
      seedDocs(world, {
        [`${CRDS_AREA}/main/.meta.json`]: branchMarker({ source: 'other/producer', area: 'core/crds' }),
        [`${CRDS_AREA}/main/keep.md`]: 'FOREIGN BRANCH\n',
        [`${CRDS_AREA}/README.md`]: 'FOREIGN AREA README\n',
        [`${CRDS_AREA}/extra.md`]: 'FOREIGN EXTRA\n',
      })
      return source
    }

    function expectForeignAreaIntact() {
      const landed = readRemote(world)
      expect(readFile(landed, `${CRDS_AREA}/README.md`)).toBe('FOREIGN AREA README\n')
      expect(exists(landed, `${CRDS_AREA}/extra.md`)).toBe(true)
      expect(exists(landed, `${CRDS_AREA}/main/keep.md`)).toBe(true)
    }

    test.each(['push', 'reconcile', 'release'])('a %s refuses to write the Area and changes nothing', (mode) => {
      const source = seedForeignArea()
      const commits = remoteCommitCount(world)
      let run
      if (mode === 'reconcile') run = runReconcile(world, source)
      else if (mode === 'push') run = push(source)
      else {
        tagRelease(source, 'v1.0.0', DATE)
        run = runPublisher(cloneDocs(world), {
          source: cloneSource(world, source, `release-checkout-${Math.random()}`), tag: 'v1.0.0',
        })
      }

      expect(run.status).toBe(2)
      expect(run.summary).toContain(ownership('core/crds'))
      expectForeignAreaIntact()
      expect(remoteCommitCount(world)).toBe(commits)
    })

    test('a plan lists the refusal instead of the writes it would make', () => {
      const source = seedForeignArea()
      const before = git(source, 'rev-parse', 'HEAD')
      commitSource(
        source,
        entriesFile([unnamedReleaseEntry({ areaFiles, prereleases: true })]),
        'change the entry',
      )
      const planFile = join(world.base, `plan-foreign-${Math.random()}.md`)

      const run = runPublisher(cloneDocs(world), {
        source: cloneSource(world, source, `plan-foreign-checkout-${Math.random()}`),
        plan: true, planFile, before, after: git(source, 'rev-parse', 'HEAD'),
      })

      expect(run.status).toBe(0)
      expect(readFileSync(planFile, 'utf8')).toContain(`- ${ownership('core/crds')}`)
    })
  })

  // A deletion clears a whole tree, and a symlink in it may point outside the docs checkout, so the run checks every
  // tree it would clear — the folder a removal names and every Branch Version folder a parent removal carries with it.
  describe('a prune that deletes a Branch Version folder', () => {
    function seedPublishedBranch() {
      const source = makeSource(world)
      commitSource(
        source,
        { 'index.yaml': CRDS, ...entriesFile([unnamedReleaseEntry({ publishSourceBranch: true })]) },
        'entries',
      )
      seedDocs(world, {
        [`${CRDS_AREA}/main/.meta.json`]: branchMarker({ area: 'core/crds' }),
        [`${CRDS_AREA}/main/keep.md`]: 'KEEP\n',
      })
      const seed = cloneDocs(world, `prune-symlink-seed-${Math.random()}`)
      symlinkSync('/nonexistent/target', join(seed, `${CRDS_AREA}/main/link`))
      git(seed, 'add', '-A')
      git(seed, 'commit', '-m', 'symlink inside the branch folder')
      git(seed, 'push', 'origin', 'main')
      // The next entries file retires the folder, so the run plans its removal.
      const before = git(source, 'rev-parse', 'HEAD')
      commitSource(source, entriesFile([unnamedReleaseEntry()]), 'retire its branch')
      return { source, before, after: git(source, 'rev-parse', 'HEAD') }
    }

    function expectNothingDeleted() {
      const landed = cloneDocs(world, `prune-check-${Math.random()}`)
      expect(readFile(landed, `${CRDS_AREA}/main/keep.md`)).toBe('KEEP\n')
      expect(lstatSync(join(landed, `${CRDS_AREA}/main/link`)).isSymbolicLink()).toBe(true)
    }

    test.each(['push', 'reconcile'])('a %s refuses a symlink inside the folder and deletes nothing', (mode) => {
      const { source } = seedPublishedBranch()
      const commits = remoteCommitCount(world)

      const run = mode === 'push' ? push(source) : runReconcile(world, source)

      expect(run.status).toBe(2)
      expect(run.output).toContain(`refusing to write through symlink: ${CRDS_AREA}/main/link`)
      expectNothingDeleted()
      expect(remoteCommitCount(world)).toBe(commits)
    })

    test('a plan reports the symlink instead of the deletion', () => {
      const { source, before, after } = seedPublishedBranch()
      const planFile = join(world.base, `plan-prune-symlink-${Math.random()}.md`)

      const run = runPublisher(cloneDocs(world), { source, plan: true, planFile, before, after })

      expect(run.status).toBe(0)
      const body = readFileSync(planFile, 'utf8')
      expect(body).toContain(`- refusing to write through symlink: ${CRDS_AREA}/main/link`)
      expect(body).not.toContain('Delete Branch Version folder')
    })

    // A Mirror Area removal clears the Area whole, so the Branch Version folders inside it go with it: the preflight
    // walks every tree the removal carries, not just the Area it names.
    test('an Area removal refuses a symlink inside a Branch Version folder it carries away', () => {
      const source = makeSource(world)
      commitSource(source, entriesFile([]), 'no entries')
      seedDocs(world, {
        [`${ROOT}/core/.meta.json`]: meta({ source: 'acme/source', sourceBranch: 'main', sourceRevision: 'b'.repeat(40), date: DATE }),
        [`${CRDS_AREA}/main/.meta.json`]: branchMarker({ area: 'core/crds' }),
        [`${CRDS_AREA}/main/keep.md`]: 'KEEP\n',
      })
      const seed = cloneDocs(world, `prune-area-symlink-${Math.random()}`)
      symlinkSync('/nonexistent/target', join(seed, `${CRDS_AREA}/main/scratch-link`))
      git(seed, 'add', '-A')
      git(seed, 'commit', '-m', 'symlink inside the branch folder')
      git(seed, 'push', 'origin', 'main')
      const commits = remoteCommitCount(world)

      const run = runReconcile(world, source)

      expect(run.status).toBe(2)
      expect(run.output).toContain(`refusing to write through symlink: ${CRDS_AREA}/main/scratch-link`)
      expect(readFile(readRemote(world), `${CRDS_AREA}/main/keep.md`)).toBe('KEEP\n')
      expect(remoteCommitCount(world)).toBe(commits)
    })
  })

  test('refuses a folder not named after its branch, and keeps it', () => {
    const source = makeSource(world)
    releaseCommit(source, { 'index.yaml': CRDS, ...entriesFile([unnamedReleaseEntry()]) }, 'v1.2.0', DATE)
    seedDocs(world, {
      [`${CRDS_AREA}/notes/.meta.json`]: branchMarker({ area: 'core/crds' }),
      [`${CRDS_AREA}/notes/keep.md`]: 'KEEP\n',
    })
    const commits = remoteCommitCount(world)

    const run = runReconcile(world, source)

    expect(run.status).toBe(2)
    expect(run.output).toContain(`invalid .meta.json: ${CRDS_AREA}/notes/.meta.json`)
    expect(readFile(readRemote(world), `${CRDS_AREA}/notes/keep.md`)).toBe('KEEP\n')
    expect(remoteCommitCount(world)).toBe(commits)
  })
})
