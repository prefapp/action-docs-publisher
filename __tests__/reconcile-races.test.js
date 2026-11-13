import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
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
  packageFiles,
  pushAttempts,
  readFile,
  readJson,
  readRemote,
  rejectPushes,
  releaseCommit,
  releaseEntry,
  remoteCommitCount,
  runPublisher,
  runReconcile,
  seedDocs,
  startPublisher,
  waitForFile,
  write,
  unnamedReleaseEntry,
} from '../test/harness.mjs'

const AREA = 'site/raw/features'

let world

beforeEach(() => {
  world = makeDocsRemote()
})

afterEach(() => {
  world.cleanup()
})

function featuresSource({ releases = [], entries = [releaseEntry()], head = {} }) {
  const source = makeSource(world)
  for (const { tag, date, files } of releases) releaseCommit(source, files, tag, date)
  commitSource(source, {
    ...entriesFile(entries),
    'README.md': '# Features (main)\n',
    ...head,
  })
  return source
}

describe('a reconcile that runs again or loses a race', () => {
  test('keeps newer release Area files already published before the initial metadata snapshot', () => {
    const source = featuresSource({
      releases: [{ tag: 'docs_publisher-v1.0.0', date: '2026-01-01T00:00:00Z', files: packageFiles('docs_publisher') }],
    })
    const checkout = cloneSource(world, source, 'manual-before-release')
    const tag = 'docs_publisher-v1.1.0'
    releaseCommit(source, {
      ...packageFiles('docs_publisher', '# New release\n'),
      'README.md': '# New Area README\n',
      ...entriesFile([releaseEntry()]),
    }, tag, '2026-02-01T00:00:00Z')
    expect(runPublisher(cloneDocs(world, 'new-release'), { source, tag }).status).toBe(0)
    expect(git(checkout, 'tag', '--list', tag)).toBe('')

    const run = runPublisher(cloneDocs(world, 'old-manual'), { source: checkout, reconcile: true })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, `${AREA}/README.md`)).toBe('# New Area README\n')
    expect(run.output).toContain('not an ancestor of the manual checkout')
    expect(exists(landed, `${AREA}/docs_publisher/1.0.0/.meta.json`)).toBe(true)
    expect(exists(landed, `${AREA}/docs_publisher/1.1.0/.meta.json`)).toBe(true)
    expect(git(checkout, 'tag', '--list', tag)).toBe(tag)
  })

  test.each(['mapped', 'unnamed'])('keeps Area files when the %s release is not an ancestor of the manual checkout', (layout) => {
    const named = layout === 'mapped'
    const area = named ? AREA : 'site/raw/core/crds'
    const entry = named
      ? releaseEntry({ tagNames: 'custom.json' })
      : unnamedReleaseEntry({ areaFiles: [{ from: 'README.md', to: 'README.md' }] })
    const config = named ? { 'custom.json': JSON.stringify({ packages: { 'packages/net-and-sub': { component: 'net-sub' } } }) } : {}
    const source = featuresSource({
      releases: [{
        tag: named ? 'net-sub-v1.0.0' : 'v1.0.0',
        date: '2026-01-01T00:00:00Z',
        files: named ? packageFiles('net-and-sub') : { 'index.yaml': 'old\n' },
      }],
      entries: [entry],
      head: config,
    })
    const checkout = cloneSource(world, source, 'old-manual-source')
    const tag = named ? 'net-sub-v1.1.0' : 'v1.1.0'
    releaseCommit(source, {
      ...(named ? packageFiles('net-and-sub') : { 'index.yaml': 'new\n' }),
      'README.md': '# New Area README\n',
      ...entriesFile([entry]),
      ...config,
    }, tag, '2026-02-01T00:00:00Z')
    expect(runPublisher(cloneDocs(world, 'new-release'), { source, tag }).status).toBe(0)

    const run = runPublisher(cloneDocs(world, 'old-manual'), { source: checkout, reconcile: true })

    expect(run.status).toBe(0)
    expect(readFile(readRemote(world), `${area}/README.md`)).toBe('# New Area README\n')
    expect(run.output).toContain('not an ancestor of the manual checkout')
  })

  test('refreshes Area files when an existing legacy version has no matching source tag', () => {
    const source = featuresSource({
      releases: [{ tag: 'docs_publisher-v1.0.0', date: '2026-01-01T00:00:00Z', files: packageFiles('docs_publisher') }],
    })
    seedDocs(world, {
      [`${AREA}/README.md`]: '# Legacy\n',
      [`${AREA}/docs_publisher/0.9.0/.meta.json`]: meta({
        source: 'acme/source', tag: 'docs_publisher-v0.9.0', date: '2025-12-01T00:00:00Z',
      }),
    })

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    expect(readFile(readRemote(world), `${AREA}/README.md`)).toBe('# Features (main)\n')
    expect(run.output).not.toContain('Skipped Area files')
  })

  test.each(['build', 'push'])('keeps newer release Area files when it overlaps during the Reconcile %s', async (phase) => {
    const ready = join(world.base, 'reconcile-ready')
    const resume = join(world.base, 'reconcile-resume')
    const gate = `touch "${ready}"; while [ ! -f "${resume}" ]; do sleep 0.01; done`
    const source = featuresSource({
      releases: [{ tag: 'docs_publisher-v1.0.0', date: '2026-01-01T00:00:00Z', files: packageFiles('docs_publisher') }],
      entries: [releaseEntry(phase === 'build' ? { build: gate } : {})],
    })
    const checkout = cloneSource(world, source, 'source-reconcile')
    const docs = cloneDocs(world, 'docs-reconcile')
    if (phase === 'push') {
      write(docs, { '.git/hooks/pre-push': `#!/bin/sh\n${gate}\n` })
      chmodSync(join(docs, '.git/hooks/pre-push'), 0o755)
    }
    const pending = startPublisher(docs, { source: checkout, reconcile: true })
    let release
    try {
      await waitForFile(ready)
      releaseCommit(source, {
        ...packageFiles('docs_publisher', '# New release\n'),
        'README.md': '# New Area README\n',
        ...entriesFile([releaseEntry()]),
      }, 'docs_publisher-v1.1.0', '2026-02-01T00:00:00Z')
      release = runPublisher(cloneDocs(world, 'docs-release'), { source, tag: 'docs_publisher-v1.1.0' })
    } finally {
      write(world.base, { 'reconcile-resume': '' })
    }
    const reconcile = await pending

    expect(release.status).toBe(0)
    expect(reconcile.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, `${AREA}/README.md`)).toBe('# New Area README\n')
    expect(reconcile.output).toContain('Skipped Area files')
    expect(exists(landed, `${AREA}/docs_publisher/1.0.0/.meta.json`)).toBe(true)
    expect(exists(landed, `${AREA}/docs_publisher/1.1.0/.meta.json`)).toBe(true)
  }, 15000)

  test('keeps a newer specification already published when its own push is rejected', async () => {
    const source = makeSource(world)
    const oldEntry = releaseEntry({ collect: [{ from: 'templates/docs/intro.md', to: 'schema.json' }] })
    const newEntry = releaseEntry({ collect: [{ from: 'schema.json', to: 'schema.json' }] })
    releaseCommit(source, {
      ...featureFiles('alpha'),
      'packages/alpha/templates/docs/intro.md': '# OLD SPEC\n',
      ...entriesFile([oldEntry]),
    }, 'alpha-v1.0.0', '2026-01-02T03:04:05Z')
    const staleSource = cloneSource(world, source, 'stale-source')
    const docs = cloneDocs(world, 'stale-docs')
    const ready = join(world.base, 'stale-ready')
    const resume = join(world.base, 'stale-resume')
    write(docs, { '.git/hooks/pre-push': `#!/bin/sh\ntouch "${ready}"\nwhile [ ! -f "${resume}" ]; do sleep 0.01; done\n` })
    chmodSync(join(docs, '.git/hooks/pre-push'), 0o755)
    const pending = startPublisher(docs, { source: staleSource, reconcile: true })
    let currentHash
    let current
    try {
      await waitForFile(ready)
      commitSource(source, entriesFile([newEntry]), 'the specification changes')
      current = runReconcile(world, source)
      currentHash = readJson(readRemote(world), `${AREA}/alpha/1.0.0/.meta.json`).specHash
    } finally {
      write(world.base, { 'stale-resume': '' })
    }
    const rejected = await pending

    expect(current.status).toBe(0)
    expect(rejected.status).toBe(0)
    expect(rejected.output).toContain('syncing and retrying')
    const landed = readRemote(world)
    expect(readFile(landed, `${AREA}/alpha/1.0.0/schema.json`)).toBe('{}\n')
    expect(readJson(landed, `${AREA}/alpha/1.0.0/.meta.json`).specHash).toBe(currentHash)
    expect(rejected.summary).toContain(`- Skipped \`${AREA}/alpha/1.0.0\`: the source branch \`main\` moved past the checkout`)
  }, 30000)

  test('re-plans a push reconcile after a manual run republishes the same drifted version', async () => {
    const ready = join(world.base, 'reconcile-ready')
    const resume = join(world.base, 'reconcile-resume')
    const source = featuresSource({
      releases: [{ tag: 'docs_publisher-v1.0.0', date: '2026-01-01T00:00:00Z', files: packageFiles('docs_publisher') }],
    })
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([releaseEntry({ collect: [{ from: 'schema.json', to: 'schema.json' }] })]), 'change the specification')
    seedDocs(world, {
      [`${AREA}/docs_publisher/1.0.0/.meta.json`]: meta({ source: 'acme/source', tag: 'docs_publisher-v1.0.0', date: '2026-01-01T00:00:00Z', specHash: '0'.repeat(64) }),
      [`${AREA}/docs_publisher/1.0.0/schema.json`]: 'drifted',
      [`${AREA}/docs_publisher/1.0.0/extra.md`]: 'obsolete',
    })
    const commits = remoteCommitCount(world)
    const docs = cloneDocs(world, 'push-reconcile')
    write(docs, { '.git/hooks/pre-push': `#!/bin/sh\ntouch "${ready}"; while [ ! -f "${resume}" ]; do sleep 0.01; done\n` })
    chmodSync(join(docs, '.git/hooks/pre-push'), 0o755)
    const pending = startPublisher(docs, {
      source: cloneSource(world, source, 'push-source'), before, after: git(source, 'rev-parse', 'HEAD'),
    })
    let manual
    try {
      await waitForFile(ready)
      manual = runReconcile(world, source)
    } finally {
      write(world.base, { 'reconcile-resume': '' })
    }
    const pushed = await pending

    expect(manual.status).toBe(0)
    expect(pushed.status).toBe(0)
    expect(pushed.output).toContain('Push to "main" rejected (attempt 1 of 5), syncing and retrying')
    expect(pushed.output).toContain(`- Kept \`${AREA}/docs_publisher/1.0.0\`: specHash matches the current entry.`)
    expect(pushed.output).toContain('Nothing to reconcile')
    expect(remoteCommitCount(world)).toBe(commits + 1)
    const landed = readRemote(world)
    expect(readFile(landed, `${AREA}/docs_publisher/1.0.0/schema.json`)).toBe('{}\n')
    expect(readFile(landed, `${AREA}/docs_publisher/schema.json`)).toBe('{}\n')
    expect(exists(landed, `${AREA}/docs_publisher/1.0.0/extra.md`)).toBe(false)
    expect(exists(landed, `${AREA}/docs_publisher/extra.md`)).toBe(false)
  }, 15000)

  test('makes no commit when it runs again on a docs repo it already finished', () => {
    const source = featuresSource({
      releases: [{ tag: 'docs_publisher-v1.1.0', date: '2026-03-01T00:00:00Z', files: packageFiles('docs_publisher') }],
    })
    seedDocs(world, { [`${AREA}/README.md`]: '# Legacy\n' })
    expect(runReconcile(world, source).status).toBe(0)
    const before = remoteCommitCount(world)

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    expect(run.summary).toContain('Nothing to reconcile')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('re-applies the whole Reconcile after rejected pushes, and lands it in one commit', () => {
    const source = featuresSource({
      releases: [{ tag: 'docs_publisher-v1.1.0', date: '2026-03-01T00:00:00Z', files: packageFiles('docs_publisher') }],
    })
    seedDocs(world, {
      [`${AREA}/README.md`]: '# Legacy\n',
      [`${AREA}/docs_publisher/versions.json`]: JSON.stringify(
        [{ version: '1.0.0', date: '2026-02-01T10:00:00+02:00', url: 'https://example.test/1.0.0/schema.json' }],
        null,
        2,
      ) + '\n',
      [`${AREA}/docs_publisher/1.0.0/schema.json`]: '{}\n',
      [`${AREA}/docs_publisher/1.0.0/.meta.json`]: meta({ source: 'acme/source', tag: 'docs_publisher-v1.0.0', date: '2026-02-01T08:00:00Z' }),
    })
    rejectPushes(world, 2)
    const before = remoteCommitCount(world)

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    expect(pushAttempts(world)).toBe(3)
    expect(remoteCommitCount(world)).toBe(before + 1)
    const landed = readRemote(world)
    expect(exists(landed, `${AREA}/docs_publisher/1.1.0/.meta.json`)).toBe(true)
    expect(exists(landed, `${AREA}/docs_publisher/1.0.0/.meta.json`)).toBe(true)
    expect(readFile(landed, `${AREA}/README.md`)).toBe('# Features (main)\n')
    expect(run.summary).toContain(`- Kept \`${AREA}/docs_publisher/1.0.0\`: no matching tag in this repo to republish it from.`)
  })
})

describe('a prune whose source branch moved under the run', () => {
  function gatedDocs(name) {
    const docs = cloneDocs(world, name)
    write(docs, { '.git/hooks/pre-push': `#!/bin/sh\ntouch "${join(world.base, name + '-ready')}"\nwhile [ ! -f "${join(world.base, name + '-resume')}" ]; do sleep 0.01; done\n` })
    chmodSync(join(docs, '.git/hooks/pre-push'), 0o755)
    return docs
  }

  test('keeps the Area when a pushed entry removal is followed by the entry coming back', async () => {
    const source = featuresSource({
      releases: [{ tag: 'beta-v1.0.0', date: '2026-01-01T00:00:00Z', files: packageFiles('beta') }],
    })
    expect(runPublisher(cloneDocs(world, 'seed-beta'), { source, tag: 'beta-v1.0.0' }).status).toBe(0)
    commitSource(source, entriesFile([]), 'drop the entry')
    const before = git(source, 'rev-parse', 'HEAD~1')
    const after = git(source, 'rev-parse', 'HEAD')
    const docs = gatedDocs('push-removal')
    const pending = startPublisher(docs, { source: cloneSource(world, source, 'push-removal-source'), before, after })
    let winner
    try {
      await waitForFile(join(world.base, 'push-removal-ready'))
      commitSource(source, entriesFile([releaseEntry()]), 'the entry comes back')
      releaseCommit(source, { 'packages/beta/templates/docs/intro.md': '# v2\n' }, 'beta-v2.0.0', '2026-02-01T00:00:00Z')
      winner = runPublisher(cloneDocs(world, 'winner-removal'), { source, tag: 'beta-v2.0.0' })
    } finally {
      write(world.base, { 'push-removal-resume': '' })
    }
    const pushed = await pending

    expect(winner.status).toBe(0)
    expect(pushed.status).toBe(0)
    expect(pushed.output).toContain('Push to "main" rejected (attempt 1 of 5), syncing and retrying')
    const landed = readRemote(world)
    expect(exists(landed, `${AREA}/beta/1.0.0/.meta.json`)).toBe(true)
    expect(exists(landed, `${AREA}/beta/2.0.0/.meta.json`)).toBe(true)
    expect(pushed.summary).toContain('Skipped prune: the source branch `main` moved past the checkout')
  }, 20000)

  test('keeps a package an ordinary push removed when a later push brings it back', async () => {
    const source = featuresSource({
      releases: [{ tag: 'beta-v1.0.0', date: '2026-01-01T00:00:00Z', files: packageFiles('beta') }],
    })
    expect(runPublisher(cloneDocs(world, 'seed-package'), { source, tag: 'beta-v1.0.0' }).status).toBe(0)
    commitSource(source, { 'packages/beta': null, 'packages/alpha/README.md': '# alpha\n' }, 'remove the package')
    const before = git(source, 'rev-parse', 'HEAD~1')
    const after = git(source, 'rev-parse', 'HEAD')
    const docs = gatedDocs('push-package')
    const pending = startPublisher(docs, { source: cloneSource(world, source, 'push-package-source'), before, after })
    try {
      await waitForFile(join(world.base, 'push-package-ready'))
      commitSource(source, packageFiles('beta'), 'the package comes back')
      const writer = cloneDocs(world, 'other-writer')
      write(writer, { 'site/raw/elsewhere/keep.txt': 'keep\n' })
      git(writer, 'add', '-A')
      git(writer, 'commit', '--quiet', '-m', 'docs: another writer')
      git(writer, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
    } finally {
      write(world.base, { 'push-package-resume': '' })
    }
    const pushed = await pending

    expect(pushed.status).toBe(0)
    expect(pushed.output).toContain('Push to "main" rejected (attempt 1 of 5), syncing and retrying')
    const landed = readRemote(world)
    expect(exists(landed, `${AREA}/beta/1.0.0/.meta.json`)).toBe(true)
    expect(readJson(landed, `${AREA}/index.json`).features.map((row) => row.name)).toEqual(['beta'])
    expect(pushed.summary).toContain('Skipped prune: the source branch `main` moved past the checkout')
  }, 20000)
})
