import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { chmodSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
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
  pushAttempts,
  readFile,
  readJson,
  readRemote,
  readTree,
  rejectPushes,
  releaseCommit,
  releaseEntry,
  remoteCommitCount,
  runPublisher,
  seedDocs,
  startPublisher,
  waitForFile,
  write,
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

function release(tag = TAG, date = DATE, files = {}) {
  const source = makeSource(world)
  releaseCommit(
    source,
    { ...featureFiles('docs_publisher'), ...entriesFile([releaseEntry()]), ...files },
    tag,
    date,
  )
  return source
}

describe('publishing against a remote that moves underneath it', () => {
  test.each([false, true])('retries past transient push rejections and publishes (ignored generated mirror artifacts: %s)', (ignored) => {
    const source = ignored ? makeSource(world) : release()
    const cache = 'site/raw/core/docs/backstage/generated/cache.json'
    if (ignored) {
      commitSource(source, {
        'docs/index.md': '# Docs\n',
        'docs/.gitignore': '/generated/\n',
        ...entriesFile([mirrorEntry({
          build: `mkdir -p docs/generated && printf '%s' '{"generated":true}' > docs/generated/schema.json && cp docs/generated/schema.json 'docs/generated/schema[1].json'`,
        })]),
      }, 'generated mirror artifacts')
      seedDocs(world, {
        'site/raw/core/docs/backstage/.meta.json': meta({ source: 'other/producer', sourceRevision: 'a'.repeat(40), sourceBranch: 'main', date: DATE }),
        'site/raw/core/docs/backstage/.gitignore': '/generated/\n',
      })
    }
    const docs = cloneDocs(world)
    if (ignored) write(docs, { [cache]: 'UNPUBLISHED CACHE\n' })
    rejectPushes(world, 2)

    const run = runPublisher(docs, { source, ...(ignored ? {} : { tag: TAG }) })

    expect(run.status).toBe(0)
    expect(pushAttempts(world)).toBe(3)
    const landed = readRemote(world)
    if (!ignored) {
      expect(exists(landed, 'site/raw/features/docs_publisher/1.0.0/.meta.json')).toBe(true)
      return
    }
    expect(exists(landed, 'site/raw/core/docs/generated/schema.json')).toBe(true)
    expect(readFile(landed, 'site/raw/core/docs/generated/schema.json')).toBe('{"generated":true}')
    expect(readFile(landed, 'site/raw/core/docs/generated/schema[1].json')).toBe('{"generated":true}')
    expect(exists(landed, cache)).toBe(false)
    expect(readFile(landed, 'site/raw/core/docs/.gitignore')).toBe('/generated/\n')
    const before = git(source, 'rev-parse', 'HEAD')
    expect(JSON.parse(readFile(landed, 'site/raw/core/docs/.meta.json')).sourceRevision).toBe(before)
    const commits = remoteCommitCount(world)
    commitSource(source, { 'README.md': '# Unrelated\n' }, 'unrelated push')

    const unrelated = runPublisher(cloneDocs(world, 'unrelated'), { source, before, after: git(source, 'rev-parse', 'HEAD') })

    expect(unrelated.status).toBe(0)
    expect(unrelated.summary).toContain('no changed file matches')
    expect(remoteCommitCount(world)).toBe(commits)
    expect(readFile(readRemote(world), 'site/raw/core/docs/generated/schema.json')).toBe('{"generated":true}')
  })

  test('gives up after 5 attempts, and the remote is unchanged', () => {
    const source = release()
    const docs = cloneDocs(world)
    rejectPushes(world, 5)
    const before = remoteCommitCount(world)

    const run = runPublisher(docs, { source, tag: TAG })

    expect(run.status).toBe(2)
    expect(run.output).toContain('push failed after 5 attempts')
    expect(run.output).toContain('Push to "main" rejected (attempt 1 of 5), syncing and retrying')
    expect(run.output).toMatch(/Push to "main" rejected \(attempt 5 of 5\): /)
    expect(pushAttempts(world)).toBe(5)
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('moves onto a main that moved before its push, and keeps the other folder', () => {
    const source = release()
    const docs = cloneDocs(world, 'docs-stale')
    const other = cloneDocs(world, 'docs-other')
    write(other, {
      'site/raw/features/other_feature/2.0.0/.meta.json': meta({ source: 'acme/source', tag: 'other_feature-v2.0.0', date: '2026-01-03T00:00:00Z' }),
    })
    git(other, 'add', '-A')
    git(other, 'commit', '--quiet', '-m', 'docs: publish other_feature 2.0.0')
    git(other, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')

    const run = runPublisher(docs, { source, tag: TAG })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(exists(landed, 'site/raw/features/other_feature/2.0.0/.meta.json')).toBe(true)
    expect(exists(landed, 'site/raw/features/docs_publisher/1.0.0/.meta.json')).toBe(true)
  })

  test('two publishers at once both land their Version folder', async () => {
    const sourceA = release('docs_publisher-v1.0.0', '2026-01-02T03:04:05Z')
    const sourceB = release('other_feature-v2.0.0', '2026-01-03T00:00:00Z', {
      ...featureFiles('other_feature'),
    })
    const cloneA = cloneSource(world, sourceA, 'source-a')
    const cloneB = cloneSource(world, sourceB, 'source-b')
    const docsA = cloneDocs(world, 'docs-a')
    const docsB = cloneDocs(world, 'docs-b')

    const [resultA, resultB] = await Promise.all([
      startPublisher(docsA, { source: cloneA, tag: 'docs_publisher-v1.0.0' }),
      startPublisher(docsB, { source: cloneB, tag: 'other_feature-v2.0.0' }),
    ])

    expect(resultA.status).toBe(0)
    expect(resultB.status).toBe(0)
    const landed = readRemote(world)
    expect(exists(landed, 'site/raw/features/docs_publisher/1.0.0/.meta.json')).toBe(true)
    expect(exists(landed, 'site/raw/features/other_feature/2.0.0/.meta.json')).toBe(true)
  }, 30000)

  test('publishing the same tag twice makes no second commit', () => {
    const source = release()
    const docsFirst = cloneDocs(world, 'docs-first')
    expect(runPublisher(docsFirst, { source, tag: TAG }).status).toBe(0)
    const afterFirst = remoteCommitCount(world)

    const docsSecond = cloneDocs(world, 'docs-second')
    const run = runPublisher(docsSecond, { source, tag: TAG })

    expect(run.status).toBe(0)
    expect(run.summary).toContain(`Already published \`${TAG}\``)
    expect(remoteCommitCount(world)).toBe(afterFirst)
  })
})

describe('push reconciliation', () => {
  test.each([false, true])('preserves an invalid-date Version folder on an ordinary push (tag exists: %s)', (tagged) => {
    const source = release(tagged ? 'docs_publisher-v0.9.0' : TAG)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'packages/docs_publisher/schema.json': '{"head":true}\n' }, 'ordinary package push')
    const dir = 'site/raw/features/docs_publisher/0.9.0'
    seedDocs(world, {
      [`${dir}/.meta.json`]: meta({ source: 'acme/source', tag: 'docs_publisher-v0.9.0', date: 'invalid' }),
      [`${dir}/schema.json`]: 'preserve invalid version\n',
    })
    const docs = cloneDocs(world)
    const tree = readTree(docs)
    const head = git(docs, 'rev-parse', 'HEAD')
    const commits = remoteCommitCount(world)

    const run = runPublisher(docs, { source, before, after: git(source, 'rev-parse', 'HEAD') })

    // The push keeps the Area it cannot rebuild, reports the problem, and still publishes nothing else it found.
    expect(run.status).toBe(0)
    expect(run.summary).toContain(
      `Kept the Area files of \`site/raw/features\`: invalid .meta.json: ${dir}/.meta.json; run a manual run to repair it.`,
    )
    expect(remoteCommitCount(world)).toBe(commits)
    expect(git(docs, 'rev-parse', 'HEAD')).toBe(head)
    expect(readTree(docs)).toEqual(tree)
    expect(readTree(readRemote(world))).toEqual(tree)
    expect(git(docs, 'status', '--porcelain')).toBe('')
  })

  test.each([false, true])('rejects an invalid-date Version folder on an entries-file push (tag exists: %s)', (tagged) => {
    const source = release(tagged ? 'docs_publisher-v0.9.0' : TAG)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([releaseEntry({ prereleases: true })]), 'entries-file push')
    const dir = 'site/raw/features/docs_publisher/0.9.0'
    seedDocs(world, {
      [`${dir}/.meta.json`]: meta({ source: 'acme/source', tag: 'docs_publisher-v0.9.0', date: 'invalid' }),
      [`${dir}/schema.json`]: 'preserve invalid version\n',
    })
    const docs = cloneDocs(world)
    const tree = readTree(docs)
    const head = git(docs, 'rev-parse', 'HEAD')
    const commits = remoteCommitCount(world)
    const checkout = cloneSource(world, source, 'push-source')

    const run = runPublisher(docs, { source: checkout, before, after: git(source, 'rev-parse', 'HEAD') })

    expect(run.status).toBe(2)
    expect(run.output).toContain(`docs_publisher: invalid .meta.json: ${dir}/.meta.json`)
    expect(remoteCommitCount(world)).toBe(commits)
    expect(git(docs, 'rev-parse', 'HEAD')).toBe(head)
    expect(readTree(docs)).toEqual(tree)
    expect(readTree(readRemote(world))).toEqual(tree)
    expect(git(docs, 'status', '--porcelain')).toBe('')
  })

  test('leaves release Areas untouched and only updates matching mirrors on a push to docs/index.md', () => {
    const source = release(TAG, DATE, {
      'docs/index.md': '# Docs\n',
      'guide/index.md': '# Guide\n',
      ...entriesFile([
        releaseEntry(),
        mirrorEntry(),
        mirrorEntry({ area: 'guide', paths: ['guide/**'], collect: [{ from: 'guide/**', to: '.' }] }),
      ]),
    })
    expect(runPublisher(cloneDocs(world, 'area-seed'), { source, tag: TAG }).status).toBe(0)
    expect(runPublisher(cloneDocs(world, 'initial-mirrors'), { source }).status).toBe(0)
    const initial = readRemote(world)
    const releaseTree = readTree(initial, 'site/raw/features')
    const guideTree = readTree(initial, 'site/raw/guide')
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'docs/index.md': '# Changed\n' }, 'ordinary push')
    const commits = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, before, after: git(source, 'rev-parse', 'HEAD') })

    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(commits + 1)
    const landed = readRemote(world)
    expect(readTree(landed, 'site/raw/features')).toEqual(releaseTree)
    expect(readTree(landed, 'site/raw/guide')).toEqual(guideTree)
    expect(readFile(landed, 'site/raw/core/docs/index.md')).toBe('# Changed\n')
    expect(run.summary).toContain('Skipped mirror `guide`: no changed file matches its paths.')
    expect(run.summary).toContain('Mirrored core/docs to `main`.')
    expect(run.summary).not.toContain('Reconciled')
    // The release Area rebuild landed the same bytes, so the subject names only the mirror.
    expect(git(world.remote, 'log', '-1', '--pretty=%s', 'main')).toBe('docs: mirror core/docs')
  })

  test('rebuilds a release Area on a push to an Area-file source, and no Version', () => {
    const source = release(TAG, DATE, {
      'docs/index.md': '# Docs\n',
      'guide/index.md': '# Guide\n',
      ...entriesFile([
        releaseEntry(),
        mirrorEntry(),
        mirrorEntry({ area: 'guide', paths: ['guide/**'], collect: [{ from: 'guide/**', to: '.' }] }),
      ]),
    })
    seedDocs(world, {
      'site/raw/features/README.md': 'release Area files stay unchanged',
      'site/raw/features/docs_publisher/1.0.0/.meta.json': meta({ source: 'acme/source', tag: TAG, date: DATE, specHash: '0'.repeat(64) }),
      'site/raw/features/docs_publisher/1.0.0/schema.json': 'drift stays unchanged',
    })
    expect(runPublisher(cloneDocs(world, 'initial-mirrors'), { source }).status).toBe(0)
    const initial = readRemote(world)
    const mirrorTree = readTree(initial, 'site/raw/core/docs')
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'README.md': '# Changed\n' }, 'ordinary push')
    const commits = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, before, after: git(source, 'rev-parse', 'HEAD') })

    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(commits + 1)
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/features/README.md')).toBe('# Changed\n')
    // A push never republishes a Version: the drift stays exactly as it is.
    expect(readTree(landed, 'site/raw/features/docs_publisher/1.0.0'))
      .toEqual(readTree(initial, 'site/raw/features/docs_publisher/1.0.0'))
    expect(readTree(landed, 'site/raw/core/docs')).toEqual(mirrorTree)
    expect(git(world.remote, 'log', '-1', '--pretty=%s', 'main')).toBe('docs: rebuild features')
    expect(run.summary).toContain('No mirror entry matches this push.')
  })

  test('keeps the Area files of a push whose source branch moved past its checkout', () => {
    const source = release()
    expect(runPublisher(cloneDocs(world, 'area-seed'), { source, tag: TAG }).status).toBe(0)
    commitSource(source, { 'README.md': '# moved on\n' }, 'newer area files')
    commitSource(source, { 'packages/docs_publisher/schema.json': '{"head":true}\n' }, 'replacement push')
    const before = git(source, 'rev-parse', 'HEAD~1')
    const after = git(source, 'rev-parse', 'HEAD')
    const checkout = cloneSource(world, source, 'stale-area-source')
    commitSource(source, { 'notes.md': '# later\n' }, 'later push')
    const commits = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source: checkout, before, after })

    // A checkout behind the tip cannot tell whether a newer run already replaced the files it would publish.
    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(commits)
    expect(readFile(readRemote(world), 'site/raw/features/README.md')).toBe('# Features\n')
    expect(run.summary).toContain(
      'Skipped the Area files of `site/raw/features`: the source branch `main` moved past the checkout',
    )
  })

  test('deletes a stray top-level file when a push rebuilds a release Area', () => {
    const source = release()
    expect(runPublisher(cloneDocs(world, 'area-seed'), { source, tag: TAG }).status).toBe(0)
    seedDocs(world, { 'site/raw/features/hand.txt': 'hand edit\n' })
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'README.md': '# Changed\n' }, 'ordinary push')
    const commits = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, before, after: git(source, 'rev-parse', 'HEAD') })

    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(commits + 1)
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/features/README.md')).toBe('# Changed\n')
    expect(exists(landed, 'site/raw/features/hand.txt')).toBe(false)
    expect(readFile(landed, 'site/raw/features/docs_publisher/1.0.0/intro.md')).toBe('# docs_publisher\n')
  })

  test('publishes a push whose rebuild deletes a folder holding only ignored files', () => {
    const source = release()
    expect(runPublisher(cloneDocs(world, 'area-seed'), { source, tag: TAG }).status).toBe(0)
    seedDocs(world, { '.gitignore': 'cache/\n' })
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'README.md': '# Changed\n' }, 'ordinary push')
    const after = git(source, 'rev-parse', 'HEAD')
    const docs = cloneDocs(world)
    const cache = 'site/raw/features/docs_publisher/cache/item'
    write(docs, { [cache]: 'UNPUBLISHED CACHE\n' })
    expect(git(docs, 'status', '--porcelain', '--ignored')).toContain('site/raw/features/docs_publisher/cache')
    const commits = remoteCommitCount(world)

    const run = runPublisher(docs, { source, before, after })

    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(commits + 1)
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/features/README.md')).toBe('# Changed\n')
    expect(exists(landed, cache)).toBe(false)
    expect(git(docs, 'status', '--porcelain')).toBe('')
  })

  test('runs a reconcile for a push that retires a package, and says why', () => {
    const source = makeSource(world)
    releaseCommit(source, {
      ...packageFiles('alpha'),
      ...packageFiles('beta'),
      ...entriesFile([releaseEntry()]),
      'README.md': '# Features\n',
    }, 'alpha-v1.0.0', '2026-01-01T00:00:00Z')
    expect(runPublisher(cloneDocs(world, 'alpha-seed'), { source, tag: 'alpha-v1.0.0' }).status).toBe(0)
    expect(exists(readRemote(world), 'site/raw/features/alpha/1.0.0/.meta.json')).toBe(true)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'packages/alpha': null }, 'remove the alpha package')
    const after = git(source, 'rev-parse', 'HEAD')
    const commits = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source: cloneSource(world, source, 'push-source'), before, after })

    // A push whose prune has work runs a reconcile: the deletion, the shared files that list it and the tags are
    // planned together, so the push cannot publish half of the reconciliation.
    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(commits + 1)
    const landed = readRemote(world)
    expect(exists(landed, 'site/raw/features/alpha')).toBe(false)
    expect(readJson(landed, 'site/raw/features/index.json').features).toEqual([])
    expect(run.summary).toContain('This push needs a prune, so it ran a reconcile.')
    expect(run.summary).toContain('- Pruned `site/raw/features/alpha`: `packages/alpha` is gone from the source repo.')
    expect(run.summary).toContain('- Skipped `alpha-v1.0.0`: the package folder is gone from `main`, so the package is retired.')
    expect(git(world.remote, 'log', '-1', '--pretty=%s', 'main')).toBe('docs: reconcile features')
  })

  test('stops a push that needs a prune when its reconcile finds a problem', () => {
    const source = makeSource(world)
    releaseCommit(source, packageFiles('alpha'), 'alpha-v1.0.0', '2026-01-01T00:00:00Z')
    releaseCommit(source, packageFiles('beta'), 'beta-v1.0.0', '2026-02-01T00:00:00Z')
    commitSource(source, { ...entriesFile([releaseEntry()]), 'README.md': '# Features\n' }, 'entries')
    expect(runPublisher(cloneDocs(world, 'alpha-seed'), { source, tag: 'alpha-v1.0.0' }).status).toBe(0)
    expect(runPublisher(cloneDocs(world, 'beta-seed'), { source, tag: 'beta-v1.0.0' }).status).toBe(0)
    const betaMarker = 'site/raw/features/beta/1.0.0/.meta.json'
    seedDocs(world, { [betaMarker]: meta({ source: 'acme/source', tag: 'beta-v1.0.0', date: 'invalid' }) })
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'packages/alpha': null }, 'remove the alpha package')
    const docs = cloneDocs(world)
    const tree = readTree(docs)
    const commits = remoteCommitCount(world)

    const run = runPublisher(docs, { source: cloneSource(world, source, 'push-source'), before, after: git(source, 'rev-parse', 'HEAD') })

    // The push needs a prune, so it runs a reconcile, and a reconcile publishes nothing when an Area has a problem.
    expect(run.status).toBe(2)
    expect(run.output).toContain(`docs_publisher: invalid .meta.json: ${betaMarker}`)
    expect(remoteCommitCount(world)).toBe(commits)
    expect(readTree(readRemote(world))).toEqual(tree)
    expect(run.summary).toContain('This push needs a prune, so it ran a reconcile.')
  })

  test('stops a push that changes an Area mode when the release Area cannot be published', () => {
    const source = makeSource(world)
    commitSource(source, {
      'docs/page.txt': '# page\n',
      ...entriesFile([mirrorEntry({ area: 'features', collect: [{ from: 'docs/**', to: '.' }], paths: ['docs/**'] })]),
    }, 'mirror entry')
    expect(runPublisher(cloneDocs(world, 'mirror-seed'), { source }).status).toBe(0)
    const area = 'site/raw/features'
    expect(readFile(readRemote(world), `${area}/page.txt`)).toBe('# page\n')
    commitSource(source, entriesFile([releaseEntry({ area: 'features', areaFiles: [{ from: 'MISSING.md', to: 'README.md' }] })]), 'mirror became a release Area')
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'notes.md': '# unrelated\n' }, 'ordinary push')
    const after = git(source, 'rev-parse', 'HEAD')
    const commits = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source: cloneSource(world, source, 'push-source'), before, after })

    // A mode change is a prune, so the push runs a reconcile, and it stops for lack of its Area-file source before
    // writing anything: the Mirror Area stays whole rather than losing its docs to a half-published replacement.
    expect(run.status).toBe(2)
    expect(run.output).toContain('docs_publisher: not found: MISSING.md')
    expect(remoteCommitCount(world)).toBe(commits)
    expect(readFile(readRemote(world), `${area}/page.txt`)).toBe('# page\n')
    expect(run.summary).toContain('This push needs a prune, so it ran a reconcile.')
  })

  test('publishes into a folder whose nested Mirror Area the reconcile prunes', () => {
    const source = makeSource(world)
    commitSource(source, {
      'docs/index.md': '# Docs\n',
      ...entriesFile([mirrorEntry()]),
    }, 'mirror entry')
    const area = 'site/raw/core/docs'
    const old = `${area}/old`
    seedDocs(world, {
      [`${area}/.meta.json`]: meta({ source: 'acme/source', sourceRevision: git(source, 'rev-parse', 'HEAD'), sourceBranch: 'main', date: DATE }),
      [`${old}/.meta.json`]: meta({ source: 'acme/source', sourceRevision: git(source, 'rev-parse', 'HEAD'), sourceBranch: 'main', date: DATE }),
      [`${old}/page.md`]: '# Old\n',
    })
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'docs/old/page.md': '# Collected\n' }, 'collect into the pruned folder')
    const after = git(source, 'rev-parse', 'HEAD')

    const run = runPublisher(cloneDocs(world), { source, before, after })

    // The prune needs work, so the push runs a reconcile, which deletes the nested Mirror Area's marker before the
    // mirror writes: the parent may publish into the folder the Area held instead of being refused by that marker.
    expect(run.status).toBe(0)
    expect(run.summary).toContain('This push needs a prune, so it ran a reconcile.')
    const landed = readRemote(world)
    expect(readFile(landed, `${old}/page.md`)).toBe('# Collected\n')
    expect(exists(landed, `${old}/.meta.json`)).toBe(false)
    expect(run.summary).toContain(`Pruned \`${old}\``)
  })

  test('publishes its checkout over a mirror a newer run published', () => {
    const source = makeSource(world)
    commitSource(source, {
      'docs/index.md': '# Docs\n',
      'guide/index.md': '# Guide\n',
      ...entriesFile([
        mirrorEntry(),
        mirrorEntry({ area: 'guide', collect: [{ from: 'guide/**', to: '.' }], paths: ['guide/**'] }),
      ]),
    }, 'mirror entries')
    expect(runPublisher(cloneDocs(world, 'mirror-seed'), { source }).status).toBe(0)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'guide/index.md': '# Guide push\n' }, 'push the guide')
    const after = git(source, 'rev-parse', 'HEAD')
    const checkout = cloneSource(world, source, 'mirror-push-source')
    // A run from a newer commit publishes the docs mirror and drops the guide entry, which its prune removes.
    commitSource(source, {
      'docs/index.md': '# Docs newer\n',
      ...entriesFile([mirrorEntry()]),
    }, 'newer docs, guide mirror dropped')
    const winner = runPublisher(cloneDocs(world, 'mirror-winner'), {
      source,
      before: after,
      after: git(source, 'rev-parse', 'HEAD'),
    })

    const run = runPublisher(cloneDocs(world, 'mirror-push'), { source: checkout, before, after })

    expect(winner.status).toBe(0)
    expect(run.status).toBe(0)
    expect(run.output).not.toContain('Skipped mirror')
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/core/docs/index.md')).toBe('# Docs\n')
    expect(readFile(landed, 'site/raw/guide/index.md')).toBe('# Guide push\n')
    expect(git(world.remote, 'log', '-1', '--pretty=%s', 'main')).toBe('docs: mirror core/docs guide')
    expect(run.summary).toContain('Mirrored core/docs guide to `main`.')
  })

  test('names no mirror an escalated push does not change', () => {
    const source = makeSource(world)
    releaseCommit(source, {
      ...packageFiles('alpha'),
      ...packageFiles('beta'),
      'README.md': '# Features\n',
      'docs/index.md': '# Docs\n',
      ...entriesFile([releaseEntry(), mirrorEntry()]),
    }, 'alpha-v1.0.0', '2026-01-01T00:00:00Z')
    expect(runPublisher(cloneDocs(world, 'alpha-seed'), { source, tag: 'alpha-v1.0.0' }).status).toBe(0)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'packages/alpha': null }, 'retire alpha')
    const after = git(source, 'rev-parse', 'HEAD')
    expect(runPublisher(cloneDocs(world, 'retire-seed'), { source: cloneSource(world, source, 'retire-push-source'), before, after }).status).toBe(0)
    const mirror = readTree(readRemote(world), 'site/raw/core/docs')
    // A delayed release of the retired package restores the Version folder the prune deleted.
    seedDocs(world, {
      'site/raw/features/alpha/1.0.0/.meta.json': meta({ source: 'acme/source', tag: 'alpha-v1.0.0', date: '2026-01-01T00:00:00Z', specHash: '0'.repeat(64) }),
      'site/raw/features/alpha/1.0.0/schema.json': 'restored\n',
    })
    const commits = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source: cloneSource(world, source, 'retire-again-source'), before, after })

    // The same push escalates again and commits only release-Area changes: the mirror it did not change is not named.
    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(commits + 1)
    expect(readTree(readRemote(world), 'site/raw/core/docs')).toEqual(mirror)
    expect(run.summary).toContain('This push needs a prune, so it ran a reconcile.')
    expect(run.summary).toContain('- Pruned `site/raw/features/alpha`')
    expect(run.summary).not.toContain('Mirrored')
  })

  test('names a release Area as rebuilt only when its own shared files changed', () => {
    const source = makeSource(world)
    releaseCommit(source, {
      ...packageFiles('alpha'),
      'README.md': '# Features\n',
      'icons/gear.svg': image('gear'),
      ...entriesFile([
        releaseEntry(),
        mirrorEntry({ area: 'icons', collect: [{ from: 'icons/**', to: '.' }], paths: ['icons/**'] }),
      ]),
    }, 'alpha-v1.0.0', '2026-01-01T00:00:00Z')
    expect(runPublisher(cloneDocs(world, 'alpha-seed'), { source, tag: 'alpha-v1.0.0' }).status).toBe(0)
    const before = git(source, 'rev-parse', 'HEAD')
    // The release Area cannot rebuild its Area files, and the Mirror Area beside it changes: only the mirror did any work.
    commitSource(source, { 'README.md': null, 'icons/gear.svg': image('new-gear') }, 'drop the Area files source and change the mirror')
    const after = git(source, 'rev-parse', 'HEAD')

    const run = runPublisher(cloneDocs(world), { source, before, after })

    expect(run.status).toBe(0)
    expect(run.summary).toContain('Kept the Area files of `site/raw/features`')
    expect(git(world.remote, 'log', '-1', '--pretty=%s', 'main')).toBe('docs: mirror icons')
    expect(readFile(readRemote(world), 'site/raw/icons/gear.svg')).toBe(image('new-gear'))
  })

  test('names only the mirrors the commit changed', () => {
    const source = makeSource(world)
    commitSource(source, {
      'docs/index.md': '# Docs\n',
      'guide/index.md': '# Guide\n',
      ...entriesFile([
        mirrorEntry(),
        mirrorEntry({ area: 'guide', collect: [{ from: 'guide/**', to: '.' }], paths: ['guide/**'] }),
      ]),
    }, 'mirror entries')
    expect(runPublisher(cloneDocs(world, 'mirror-seed'), { source }).status).toBe(0)
    const revision = git(source, 'rev-parse', 'HEAD')
    // Another run already holds core/docs as it is, and only the guide drifted: only the guide is written.
    seedDocs(world, { 'site/raw/guide/index.md': '# Edited by hand\n' }, 'hand edit')
    const commits = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(commits + 1)
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/guide/index.md')).toBe('# Guide\n')
    expect(readJson(landed, 'site/raw/guide/.meta.json').sourceRevision).toBe(revision)
    expect(git(world.remote, 'log', '-1', '--pretty=%s', 'main')).toBe('docs: mirror guide')
    expect(run.summary).toContain('Mirrored guide to `main`.')
    expect(run.summary).not.toContain('Mirrored core/docs')
  })

  test('publishes the mirror and keeps a release Area whose Version metadata is a symlink', () => {
    const source = release(TAG, DATE, {
      'docs/index.md': '# Docs\n',
      ...entriesFile([releaseEntry(), mirrorEntry()]),
    })
    expect(runPublisher(cloneDocs(world, 'mirror-seed'), { source, tag: TAG }).status).toBe(0)
    expect(runPublisher(cloneDocs(world, 'mirror-seed-2'), { source }).status).toBe(0)
    const ghost = 'site/raw/features/ghost/1.0.0'
    const seeded = cloneDocs(world, 'symlink-seed')
    mkdirSync(join(seeded, ghost), { recursive: true })
    symlinkSync('../../../README.md', join(seeded, ghost, '.meta.json'))
    git(seeded, 'add', '-A')
    git(seeded, 'commit', '--quiet', '-m', 'docs: a Version folder with a symlinked marker')
    git(seeded, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'docs/index.md': '# Changed\n' }, 'ordinary push')
    const after = git(source, 'rev-parse', 'HEAD')

    const run = runPublisher(cloneDocs(world), { source, before, after })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/core/docs/index.md')).toBe('# Changed\n')
    expect(readFile(landed, 'site/raw/features/README.md')).toBe('# Features\n')
    expect(git(landed, 'ls-files', '-s', `${ghost}/.meta.json`)).toMatch(/^120000 /)
    expect(run.summary).toContain(
      `Kept the Area files of \`site/raw/features\`: refusing to write through symlink: ${ghost}/.meta.json; run a manual run to repair it.`,
    )
  })

  test('rebuilds the Area files a push retries when another writer changed only an unmanaged folder', async () => {
    const source = release(TAG, DATE, { 'README.md': '# one\n' })
    expect(runPublisher(cloneDocs(world, 'area-seed'), { source, tag: TAG }).status).toBe(0)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'README.md': '# two\n' }, 'ordinary push')
    const after = git(source, 'rev-parse', 'HEAD')
    const checkout = cloneSource(world, source, 'area-push-source')
    const docs = cloneDocs(world, 'area-push')
    const ready = join(world.base, 'unmanaged-ready')
    const resume = join(world.base, 'unmanaged-resume')
    write(docs, { '.git/hooks/pre-push': `#!/bin/sh\ntouch "${ready}"\nwhile [ ! -f "${resume}" ]; do sleep 0.01; done\n` })
    chmodSync(join(docs, '.git/hooks/pre-push'), 0o755)
    const pending = startPublisher(docs, { source: checkout, before, after })
    try {
      await waitForFile(ready)
      const writer = cloneDocs(world, 'unmanaged-writer')
      write(writer, { 'site/raw/features/unrelated/keep.txt': 'keep\n' })
      git(writer, 'add', '-A')
      git(writer, 'commit', '--quiet', '-m', 'docs: another writer')
      git(writer, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
    } finally {
      write(world.base, { 'unmanaged-resume': '' })
    }
    const pushed = await pending

    expect(pushed.status).toBe(0)
    expect(pushed.output).toContain('Push to "main" rejected (attempt 1 of 5), syncing and retrying')
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/features/README.md')).toBe('# two\n')
    expect(readFile(landed, 'site/raw/features/unrelated/keep.txt')).toBe('keep\n')
  }, 20000)

  test('publishes the Area files a superseded push left unpublished, and names only the rebuilt Area', () => {
    const other = releaseEntry({ area: 'other', areaFiles: [{ from: 'OTHER.md', to: 'README.md' }] })
    const source = release(TAG, DATE, { 'OTHER.md': '# other one\n', ...entriesFile([releaseEntry(), other]) })
    expect(runPublisher(cloneDocs(world, 'area-seed'), { source, tag: TAG }).status).toBe(0)
    // The superseded push moves the Area files; the push that replaces it changes nothing they read.
    commitSource(source, { 'README.md': '# features two\n' }, 'superseded push')
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'packages/docs_publisher/schema.json': '{"head":true}\n' }, 'replacement push')
    const commits = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, before, after: git(source, 'rev-parse', 'HEAD') })

    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(commits + 1)
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/features/README.md')).toBe('# features two\n')
    expect(readFile(landed, 'site/raw/other/README.md')).toBe('# other one\n')
    expect(git(world.remote, 'log', '-1', '--pretty=%s', 'main')).toBe('docs: rebuild features')
  })

  test('keeps Area files another release publishes while the push is rejected', async () => {
    const source = release(TAG, DATE, { 'README.md': '# one\n' })
    expect(runPublisher(cloneDocs(world, 'area-seed'), { source, tag: TAG }).status).toBe(0)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'README.md': '# two\n' }, 'ordinary push')
    const after = git(source, 'rev-parse', 'HEAD')
    const checkout = cloneSource(world, source, 'area-push-source')
    const docs = cloneDocs(world, 'area-push')
    const ready = join(world.base, 'area-push-ready')
    const resume = join(world.base, 'area-push-resume')
    write(docs, { '.git/hooks/pre-push': `#!/bin/sh\ntouch "${ready}"\nwhile [ ! -f "${resume}" ]; do sleep 0.01; done\n` })
    chmodSync(join(docs, '.git/hooks/pre-push'), 0o755)
    const pending = startPublisher(docs, { source: checkout, before, after })
    let winner
    try {
      await waitForFile(ready)
      commitSource(source, { 'README.md': '# three\n' }, 'newer area files')
      releaseCommit(source, { 'packages/docs_publisher/templates/docs/intro.md': '# v2\n' }, 'docs_publisher-v2.0.0', '2026-02-02T03:04:05Z')
      winner = runPublisher(cloneDocs(world, 'area-winner'), { source, tag: 'docs_publisher-v2.0.0' })
    } finally {
      write(world.base, { 'area-push-resume': '' })
    }
    const pushed = await pending

    expect(winner.status).toBe(0)
    expect(pushed.status).toBe(0)
    expect(pushed.output).toContain('Push to "main" rejected (attempt 1 of 5), syncing and retrying')
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/features/README.md')).toBe('# three\n')
    expect(exists(landed, 'site/raw/features/docs_publisher/1.0.0/.meta.json')).toBe(true)
    expect(exists(landed, 'site/raw/features/docs_publisher/2.0.0/.meta.json')).toBe(true)
    // The branch moved past the retrying checkout, so it publishes no Area files at all rather than older ones.
    expect(pushed.summary).toContain(
      'Skipped the Area files of `site/raw/features`: the source branch `main` moved past the checkout',
    )
  }, 20000)

  test.each(['entries changed', 'unknown diff'])('reconciles missing versions, spec drift, mirrors and prune when %s', (trigger) => {
    const entries = [releaseEntry({ collect: [{ from: 'schema.json', to: 'schema.json' }] }), mirrorEntry()]
    const source = release(TAG, DATE, trigger === 'unknown diff' ? entriesFile(entries) : {})
    releaseCommit(source, { 'packages/docs_publisher/schema.json': '{"version":2}\n' }, 'docs_publisher-v2.0.0', DATE)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, {
      'docs/index.md': '# Mirror\n',
      ...(trigger === 'entries changed' ? entriesFile(entries) : {}),
    }, 'push source changes')
    if (trigger === 'unknown diff') expect(git(source, 'diff', '--name-only', before, 'HEAD')).toBe('docs/index.md')
    seedDocs(world, {
      'site/raw/features/docs_publisher/1.0.0/.meta.json': meta({ source: 'acme/source', tag: TAG, date: DATE, specHash: '0'.repeat(64) }),
      'site/raw/features/docs_publisher/1.0.0/schema.json': 'drifted',
      'site/raw/features/docs_publisher/1.0.0/intro.md': 'no longer collected',
      'site/raw/features/retired/1.0.0/.meta.json': meta({ source: 'acme/source', tag: 'retired-v1.0.0', date: DATE }),
      'site/raw/features/retired/1.0.0/schema.json': 'retired',
    })
    const commits = remoteCommitCount(world)
    const checkout = cloneSource(world, source, 'push-source')
    const run = runPublisher(cloneDocs(world), {
      source: checkout,
      before: trigger === 'unknown diff' ? '0'.repeat(40) : before,
      after: git(source, 'rev-parse', 'HEAD'),
    })
    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(commits + 1)
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/features/docs_publisher/1.0.0/schema.json')).toBe('{}\n')
    expect(readJson(landed, 'site/raw/features/docs_publisher/1.0.0/.meta.json').specHash).toMatch(/^[a-f0-9]{64}$/)
    expect(readJson(landed, 'site/raw/features/docs_publisher/1.0.0/.meta.json').specHash).not.toBe('0'.repeat(64))
    expect(exists(landed, 'site/raw/features/docs_publisher/1.0.0/intro.md')).toBe(false)
    expect(readFile(landed, 'site/raw/features/docs_publisher/2.0.0/schema.json')).toBe('{"version":2}\n')
    expect(readJson(landed, 'site/raw/features/docs_publisher/versions.json').map(({ version }) => version)).toEqual(['2.0.0', '1.0.0'])
    expect(exists(landed, 'site/raw/features/retired')).toBe(false)
    expect(readFile(landed, 'site/raw/core/docs/index.md')).toBe('# Mirror\n')
    expect(run.summary).toContain('- Published `site/raw/features/docs_publisher/2.0.0`.')
    expect(run.summary).toContain('- Republished `site/raw/features/docs_publisher/1.0.0`: spec changed.')
    expect(run.summary).toContain('- Pruned `site/raw/features/retired`: `packages/retired` is gone from the source repo.')
    expect(run.summary).toContain('Mirrored core/docs to `main`.')
  })
})

describe('the docs branch a run publishes to', () => {
  test('starts from that branch, so a branch behind main takes only its own folder', () => {
    git(world.remote, 'branch', 'published', 'main')
    seedDocs(world, { 'outside-owned-area.txt': 'MAIN ONLY\n' })
    const source = makeSource(world)
    commitSource(source, { 'docs/index.md': 'mirror\n', ...entriesFile([mirrorEntry()]) }, 'push to main')
    const before = git(world.remote, 'rev-parse', 'refs/heads/published')

    const run = runPublisher(cloneDocs(world), { source, branch: 'published' })

    expect(run.status).toBe(0)
    const published = git(world.remote, 'ls-tree', '-r', '--name-only', 'published').split('\n')
    expect(published).not.toContain('outside-owned-area.txt')
    expect(git(world.remote, 'diff', '--name-only', before, 'published').split('\n')).toEqual([
      'site/raw/core/docs/.meta.json',
      'site/raw/core/docs/index.md',
    ])
  })

  test('filters a push against the destination branch baseline, not the checked-out default branch', () => {
    git(world.remote, 'branch', 'published', 'main')
    const source = makeSource(world)
    commitSource(source, { 'docs/index.md': '# Docs\n', ...entriesFile([mirrorEntry()]) }, 'docs push')
    expect(runPublisher(cloneDocs(world, 'publish-main'), { source }).status).toBe(0)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'README.md': '# unrelated\n' }, 'README push')
    const after = git(source, 'rev-parse', 'HEAD')

    const run = runPublisher(cloneDocs(world), { source, branch: 'published', before, after })

    expect(run.status).toBe(0)
    expect(git(world.remote, 'show', 'published:site/raw/core/docs/index.md')).toBe('# Docs')
    expect(JSON.parse(git(world.remote, 'show', 'published:site/raw/core/docs/.meta.json')).sourceRevision).toBe(after)
    expect(JSON.parse(readFile(readRemote(world), 'site/raw/core/docs/.meta.json')).sourceRevision).toBe(before)
  })

  test('refuses a branch the docs remote does not have, and pushes nothing', () => {
    const source = makeSource(world)
    commitSource(source, { 'docs/index.md': 'mirror\n', ...entriesFile([mirrorEntry()]) }, 'push to main')

    const run = runPublisher(cloneDocs(world), { source, branch: 'published' })

    expect(run.status).toBe(2)
    expect(run.output).toContain('"published"')
    expect(git(world.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/published')).toBe('')
  })
})
