import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  cloneDocs, cloneSource, commitSource, entriesFile, exists, featureFiles, git, makeDocsRemote,
  makeSource, mirrorEntry, readFile, readJson, readRemote, readTree, releaseCommit, releaseEntry,
  remoteCommitCount, renderedScript, runPublisher, runReconcile, seedDocs, write,
} from '../test/harness.mjs'

const { readEntries, specHash } = await import(pathToFileURL(renderedScript('entries.mjs')).href)

const DATE = '2026-01-02T03:04:05Z'
const AREA = 'site/raw/features'
const SKIPPED = `${AREA}/.skipped-tags.json`
let world
beforeEach(() => { world = makeDocsRemote() })
afterEach(() => { world.cleanup() })

const revision = (source, tag) => git(source, 'rev-parse', `refs/tags/${tag}^{commit}`)

// A build that leaves the evidence of having run, and fails wherever the tag's package folder holds no BUILD_OK.
function countingEntry(counter) {
  return releaseEntry({ build: `echo build >> "${counter}"; test -f BUILD_OK` })
}

function packageFolder(name, files = {}) {
  return {
    [`packages/${name}/templates/docs/intro.md`]: `# ${name}\n`,
    [`packages/${name}/templates/docs/images/logo.png`]: `image-bytes:${name}-logo`,
    [`packages/${name}/CHANGELOG.md`]: '# Changelog\n',
    [`packages/${name}/schema.json`]: '{}\n',
    ...files,
  }
}

// One source repo whose tags are skipped for each of the four reasons: a retired package, a gap before the package
// folder existed, an unconfigured prerelease, and a tag whose build fails.
function fourReasonsSource(entry) {
  const source = makeSource(world)
  const files = entriesFile([entry])
  releaseCommit(source, { ...featureFiles('alpha'), ...files }, 'alpha-v1.0.0', DATE)
  git(source, 'tag', 'gap-v1.0.0')
  releaseCommit(source, {
    'packages/alpha/BUILD_OK': '',
    'packages/alpha/templates/docs/intro.md': '# alpha rc\n',
    ...packageFolder('gap'),
    ...packageFolder('gone'),
  }, 'alpha-v2.0.0-rc.1', DATE)
  git(source, 'tag', 'gone-v1.0.0')
  releaseCommit(source, { 'packages/alpha/templates/docs/intro.md': '# alpha 1.1\n' }, 'alpha-v1.1.0', DATE)
  commitSource(source, { 'packages/gone': null }, 'retire the gone package')
  return source
}

// One tag whose build fails at its own commit: the only tag a run has to check out.
function contentSkipSource(counter, entry = countingEntry(counter)) {
  const source = makeSource(world)
  releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([entry]) }, 'alpha-v1.0.0', DATE)
  commitSource(source, { 'packages/alpha/BUILD_OK': '' }, 'make the package buildable')
  return source
}

const buildCount = (counter) => (exists(world.base, 'builds.log') ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0)

describe('the Skipped tags file a Reconcile writes', () => {
  test('records one entry per skipped tag, sorted, naming the state it was skipped under', () => {
    const counter = join(world.base, 'builds.log')
    const entry = countingEntry(counter)
    const source = fourReasonsSource(entry)

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    const hash = specHash(readEntries(join(source, '.github/docs_publisher.yaml'))[0])
    const expected = {
      source: 'acme/source',
      tags: {
        'alpha-v1.0.0': {
          sourceRevision: revision(source, 'alpha-v1.0.0'),
          reason: 'content',
          specHash: hash,
          detail: 'build failed in packages/alpha (exit 1)',
        },
        'alpha-v2.0.0-rc.1': { sourceRevision: revision(source, 'alpha-v2.0.0-rc.1'), reason: 'prerelease' },
        'gap-v1.0.0': { sourceRevision: revision(source, 'gap-v1.0.0'), reason: 'no folder', specHash: hash },
        'gone-v1.0.0': { sourceRevision: revision(source, 'gone-v1.0.0'), reason: 'retired' },
      },
    }
    expect(readFile(landed, SKIPPED)).toBe(`${JSON.stringify(expected, null, 2)}\n`)
    // The tags that fit still publish: the file records the skip, it does not stand in for the publish.
    expect(exists(landed, `${AREA}/alpha/1.1.0/.meta.json`)).toBe(true)
    expect(exists(landed, `${AREA}/alpha/1.0.0/.meta.json`)).toBe(false)
  })

  test('checks out and builds a skipped tag once, and not again while its recorded state holds', () => {
    const counter = join(world.base, 'builds.log')
    const source = contentSkipSource(counter)
    expect(runReconcile(world, source).status).toBe(0)
    expect(buildCount(counter)).toBe(1)
    const commits = remoteCommitCount(world)

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    expect(buildCount(counter)).toBe(1)
    expect(remoteCommitCount(world)).toBe(commits)
    // The tag is not named again: the summary counts the skips it reused instead of repeating their history.
    expect(run.summary).toContain('- 1 previously skipped tag unchanged.')
    expect(run.summary).not.toContain('`alpha-v1.0.0`')
    expect(readJson(readRemote(world), SKIPPED).tags['alpha-v1.0.0']).toEqual({
      sourceRevision: revision(source, 'alpha-v1.0.0'),
      reason: 'content',
      specHash: specHash(readEntries(join(source, '.github/docs_publisher.yaml'))[0]),
      detail: 'build failed in packages/alpha (exit 1)',
    })
  })
})

describe('reporting the skips a run reused', () => {
  test('summarizes every tag it reused as one count line', () => {
    const counter = join(world.base, 'builds.log')
    const source = fourReasonsSource(countingEntry(counter))
    expect(runReconcile(world, source).status).toBe(0)
    const builds = buildCount(counter)

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    expect(buildCount(counter)).toBe(builds)
    expect(run.summary).toContain('- 4 previously skipped tags unchanged.')
    expect(run.summary).not.toContain('- Skipped `')
  })

  test('names a fresh skip of the same tag in another Area beside the reuse', () => {
    const counter = join(world.base, 'builds.log')
    const entry = countingEntry(counter)
    // Two Areas publish the same tag: one already recorded the skip, the other has to derive it again.
    const second = releaseEntry({ area: 'core/extra', areaFiles: [], build: entry.build })
    const source = makeSource(world)
    releaseCommit(
      source,
      { ...featureFiles('alpha'), ...entriesFile([{ ...entry, areaFiles: [] }, second]) },
      'alpha-v1.0.0',
      DATE,
    )
    seedDocs(world, {
      [SKIPPED]: `${JSON.stringify({
        source: 'acme/source',
        tags: {
          'alpha-v1.0.0': {
            sourceRevision: revision(source, 'alpha-v1.0.0'),
            reason: 'content',
            specHash: specHash(readEntries(join(source, '.github/docs_publisher.yaml'))[0]),
            detail: 'build failed in packages/alpha (exit 1)',
          },
        },
      }, null, 2)}\n`,
    })

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    expect(buildCount(counter)).toBe(1)
    expect(run.summary).toContain('- 1 previously skipped tag unchanged.')
    expect(run.summary).toContain('- Skipped `alpha-v1.0.0`: its content does not fit the entry (build failed in packages/alpha (exit 1)).')
  })

  test('keeps a newly skipped tag on its own line beside the count', () => {
    const counter = join(world.base, 'builds.log')
    const source = contentSkipSource(counter)
    expect(runReconcile(world, source).status).toBe(0)
    // A tag at a commit whose build fails: this run has to check it out, while the recorded skip is reused.
    git(source, 'tag', 'alpha-v1.1.0', 'HEAD~1')

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    expect(buildCount(counter)).toBe(2)
    expect(run.summary).toContain('- 1 previously skipped tag unchanged.')
    expect(run.summary).toContain('- Skipped `alpha-v1.1.0`: its content does not fit the entry (')
    expect(run.summary).not.toContain('`alpha-v1.0.0`')
  })
})

describe('a recorded skip is only reused while its conditions hold', () => {
  test('re-checks a skipped tag whose tag moved to another commit', () => {
    const counter = join(world.base, 'builds.log')
    const source = contentSkipSource(counter)
    expect(runReconcile(world, source).status).toBe(0)
    expect(buildCount(counter)).toBe(1)
    commitSource(source, { 'packages/alpha/BUILD_OK': null, 'packages/alpha/templates/docs/intro.md': '# moved\n' }, 'move the tag')
    git(source, 'tag', '-f', 'alpha-v1.0.0')

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    expect(buildCount(counter)).toBe(2)
    expect(readJson(readRemote(world), SKIPPED).tags).toEqual({
      'alpha-v1.0.0': {
        sourceRevision: revision(source, 'alpha-v1.0.0'), reason: 'content',
        specHash: specHash(readEntries(join(source, '.github/docs_publisher.yaml'))[0]),
        detail: 'build failed in packages/alpha (exit 1)',
      },
    })
  })

  test('re-checks a skipped tag when the entry spec changes', () => {
    const counter = join(world.base, 'builds.log')
    const source = contentSkipSource(counter)
    expect(runReconcile(world, source).status).toBe(0)
    const recorded = readJson(readRemote(world), SKIPPED).tags['alpha-v1.0.0']
    const stricter = releaseEntry({ build: `echo build >> "${counter}"; test -f BUILD_OK && test -f BUILD_OK` })
    commitSource(source, entriesFile([stricter]), 'change the spec without moving a tag')

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    expect(buildCount(counter)).toBe(2)
    const current = readJson(readRemote(world), SKIPPED).tags['alpha-v1.0.0']
    expect(current.sourceRevision).toBe(recorded.sourceRevision)
    expect(current.specHash).toBe(specHash(readEntries(join(source, '.github/docs_publisher.yaml'))[0]))
  })

  test('publishes a recorded prerelease once the entry publishes prereleases', () => {
    const entry = releaseEntry()
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([entry]) }, 'alpha-v2.0.0-rc.1', DATE)
    expect(runReconcile(world, source).status).toBe(0)
    expect(readJson(readRemote(world), SKIPPED).tags['alpha-v2.0.0-rc.1'].reason).toBe('prerelease')
    commitSource(source, entriesFile([releaseEntry({ prereleases: true })]), 'publish prereleases')

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(exists(landed, `${AREA}/alpha/2.0.0-rc.1/.meta.json`)).toBe(true)
    expect(exists(landed, SKIPPED)).toBe(false)
  })

  test('publishes a recorded retirement once the package folder is back', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      { ...featureFiles('alpha'), ...packageFolder('gone'), ...entriesFile([releaseEntry()]) },
      'gone-v1.0.0',
      DATE,
    )
    commitSource(source, { 'packages/gone': null }, 'retire the gone package')
    expect(runReconcile(world, source).status).toBe(0)
    expect(readJson(readRemote(world), SKIPPED).tags['gone-v1.0.0'].reason).toBe('retired')
    commitSource(source, packageFolder('gone'), 'bring the package folder back')

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readJson(landed, `${AREA}/gone/1.0.0/.meta.json`)).toEqual(expect.objectContaining({ tag: 'gone-v1.0.0' }))
    expect(exists(landed, SKIPPED)).toBe(false)
  })
})

describe('keeping the Skipped tags file current', () => {
  test('drops a tag deleted from git and keeps the rest, without re-checking them', () => {
    const counter = join(world.base, 'builds.log')
    const source = makeSource(world)
    releaseCommit(
      source,
      { ...featureFiles('alpha'), ...packageFolder('beta'), ...entriesFile([countingEntry(counter)]) },
      'alpha-v1.0.0',
      DATE,
    )
    git(source, 'tag', 'beta-v1.0.0')
    commitSource(source, { 'packages/alpha/BUILD_OK': '', 'packages/beta/BUILD_OK': '' }, 'buildable')
    expect(runReconcile(world, source).status).toBe(0)
    expect(Object.keys(readJson(readRemote(world), SKIPPED).tags).sort()).toEqual(['alpha-v1.0.0', 'beta-v1.0.0'])
    const builds = buildCount(counter)
    git(source, 'tag', '-d', 'beta-v1.0.0')

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    expect(buildCount(counter)).toBe(builds)
    expect(Object.keys(readJson(readRemote(world), SKIPPED).tags)).toEqual(['alpha-v1.0.0'])
  })

  test('removes the file when a later run publishes the last skipped tag', () => {
    const counter = join(world.base, 'builds.log')
    const source = contentSkipSource(counter)
    expect(runReconcile(world, source).status).toBe(0)
    expect(exists(readRemote(world), SKIPPED)).toBe(true)
    commitSource(source, { 'packages/alpha/templates/docs/intro.md': '# retagged\n' }, 'move the tag onto a buildable commit')
    git(source, 'tag', '-f', 'alpha-v1.0.0')
    const commits = remoteCommitCount(world)

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(commits + 1)
    const landed = readRemote(world)
    expect(exists(landed, SKIPPED)).toBe(false)
    expect(exists(landed, `${AREA}/alpha/1.0.0/.meta.json`)).toBe(true)
  })

  test('records a published tag whose moved commit no longer fits, and reuses the skip next run', () => {
    const counter = join(world.base, 'builds.log')
    const source = makeSource(world)
    releaseCommit(source, {
      ...featureFiles('alpha'),
      'packages/alpha/BUILD_OK': '',
      ...entriesFile([countingEntry(counter)]),
    }, 'alpha-v1.0.0', DATE)
    expect(runReconcile(world, source).status).toBe(0)
    expect(exists(readRemote(world), `${AREA}/alpha/1.0.0/.meta.json`)).toBe(true)
    expect(buildCount(counter)).toBe(1)
    // The tag moves onto a commit whose collect finds nothing, so the Version the docs hold cannot be rebuilt.
    commitSource(source, { 'packages/alpha/schema.json': null }, 'move the tag onto an unfit commit')
    git(source, 'tag', '-f', 'alpha-v1.0.0')

    const moved = runReconcile(world, source)

    expect(moved.status).toBe(0)
    expect(buildCount(counter)).toBe(2)
    let landed = readRemote(world)
    // The older Version folder keeps its bytes, and the skip is recorded, so the next run need not build the tag again.
    expect(exists(landed, `${AREA}/alpha/1.0.0/.meta.json`)).toBe(true)
    expect(readJson(landed, SKIPPED).tags['alpha-v1.0.0']).toEqual({
      sourceRevision: revision(source, 'alpha-v1.0.0'),
      reason: 'content',
      specHash: specHash(readEntries(join(source, '.github/docs_publisher.yaml'))[0]),
      detail: 'not found: schema.json',
    })

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    expect(buildCount(counter)).toBe(2)
    expect(run.summary).toContain('- 1 previously skipped tag unchanged.')
    expect(run.summary).not.toContain('Republished')
    landed = readRemote(world)
    expect(exists(landed, `${AREA}/alpha/1.0.0/.meta.json`)).toBe(true)
    expect(readJson(landed, SKIPPED).tags['alpha-v1.0.0'].sourceRevision).toBe(revision(source, 'alpha-v1.0.0'))
  })

  test('treats a tag deleted on origin as gone, however the checkout still holds it', () => {
    const counter = join(world.base, 'builds.log')
    const source = contentSkipSource(counter)
    expect(runReconcile(world, source).status).toBe(0)
    expect(exists(readRemote(world), SKIPPED)).toBe(true)
    // A checkout made while the tag still existed: its fetch must not keep a ref origin has dropped.
    const checkout = cloneSource(world, source, 'checkout-with-the-tag')
    expect(git(checkout, 'tag', '--list', 'alpha-v1.0.0')).toBe('alpha-v1.0.0')
    git(source, 'tag', '--delete', 'alpha-v1.0.0')

    const run = runPublisher(cloneDocs(world), { source: checkout, reconcile: true })

    expect(run.status).toBe(0)
    expect(buildCount(counter)).toBe(1)
    expect(exists(readRemote(world), SKIPPED)).toBe(false)
    expect(run.summary).not.toContain('previously skipped')
  })

  test('reuses a content record that carries no detail', () => {
    const counter = join(world.base, 'builds.log')
    const source = contentSkipSource(counter)
    // A record without the reason line is still a skip of a known commit under a known spec: no build re-derives it.
    seedDocs(world, {
      [SKIPPED]: `${JSON.stringify({
        source: 'acme/source',
        tags: {
          'alpha-v1.0.0': {
            sourceRevision: revision(source, 'alpha-v1.0.0'),
            reason: 'content',
            specHash: specHash(readEntries(join(source, '.github/docs_publisher.yaml'))[0]),
          },
        },
      }, null, 2)}\n`,
    })

    const run = runReconcile(world, source)

    expect(run.status).toBe(0)
    expect(buildCount(counter)).toBe(0)
    expect(run.summary).toContain('- 1 previously skipped tag unchanged.')
    expect(run.summary).not.toContain('its content does not fit')
    // The record is reused as it is: the run adds no reason it never derived.
    expect(readJson(readRemote(world), SKIPPED).tags['alpha-v1.0.0'].detail).toBeUndefined()
  })

  test('leaves the file untouched when the source branch moved past the checkout', () => {
    const counter = join(world.base, 'builds.log')
    const source = contentSkipSource(counter)
    expect(runReconcile(world, source).status).toBe(0)
    const bytes = readFile(readRemote(world), SKIPPED)
    const commits = remoteCommitCount(world)
    const stale = cloneSource(world, source, 'checkout-behind')
    commitSource(source, { 'packages/alpha/CHANGELOG.md': '# v2\n' }, 'the source branch moves on')

    const run = runPublisher(cloneDocs(world), { source: stale, reconcile: true })

    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(commits)
    expect(readFile(readRemote(world), SKIPPED)).toBe(bytes)
  })
})

describe('a Release run and the Skipped tags file', () => {
  function skippedFile(tags) {
    return `${JSON.stringify({ source: 'acme/source', tags }, null, 2)}\n`
  }

  test('removes the tag it publishes, and leaves the tags it does not', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
    const tags = {
      'alpha-v0.9.0': { sourceRevision: 'b'.repeat(40), reason: 'no folder', specHash: 'c'.repeat(64) },
      'alpha-v1.0.0': { sourceRevision: revision(source, 'alpha-v1.0.0'), reason: 'content', specHash: 'a'.repeat(64) },
    }
    seedDocs(world, { [SKIPPED]: skippedFile(tags) })
    const commits = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' })

    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(commits + 1)
    expect(readJson(readRemote(world), SKIPPED)).toEqual({ source: 'acme/source', tags: { 'alpha-v0.9.0': tags['alpha-v0.9.0'] } })
  })

  test('deletes the file it empties, in the commit that publishes the tag', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
    seedDocs(world, {
      [SKIPPED]: skippedFile({
        'alpha-v1.0.0': { sourceRevision: revision(source, 'alpha-v1.0.0'), reason: 'content', specHash: 'a'.repeat(64) },
      }),
    })

    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(exists(landed, SKIPPED)).toBe(false)
    expect(exists(landed, `${AREA}/alpha/1.0.0/.meta.json`)).toBe(true)
  })

  test('writes nothing at all when it publishes nothing', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.1.0-rc.1', DATE)
    const tags = { 'alpha-v1.1.0-rc.1': { sourceRevision: revision(source, 'alpha-v1.1.0-rc.1'), reason: 'prerelease' } }
    seedDocs(world, { [SKIPPED]: skippedFile(tags) })
    const commits = remoteCommitCount(world)
    const tree = readTree(readRemote(world))

    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.1.0-rc.1' })

    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(commits)
    expect(readTree(readRemote(world))).toEqual(tree)
  })
})

describe('a Push run and the Skipped tags file', () => {
  test('preserves the file while it rebuilds the Area it sits in', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
    expect(runReconcile(world, source).status).toBe(0)
    const bytes = `${JSON.stringify({
      source: 'acme/source',
      tags: { 'alpha-v0.9.0': { sourceRevision: 'b'.repeat(40), reason: 'prerelease' } },
    }, null, 2)}\n`
    seedDocs(world, { [SKIPPED]: bytes })
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'README.md': '# Features v2\n' }, 'change the Area file')
    const after = git(source, 'rev-parse', 'HEAD')

    const run = runPublisher(cloneDocs(world), { source, before, after })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, `${AREA}/README.md`)).toBe('# Features v2\n')
    expect(readFile(landed, SKIPPED)).toBe(bytes)
  })
})

function plainSource() {
  const source = makeSource(world)
  releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
  return source
}

const emptySkipFile = (tags) => `${JSON.stringify({ source: 'acme/source', tags }, null, 2)}\n`
const SHA = 'a'.repeat(40)

describe('a Plan run and the Skipped tags file', () => {
  test('writes nothing, and leaves the file and its tags to the next Reconcile', () => {
    const source = plainSource()
    seedDocs(world, {
      [SKIPPED]: emptySkipFile({
        'alpha-v1.0.0': { sourceRevision: revision(source, 'alpha-v1.0.0'), reason: 'content', specHash: 'a'.repeat(64), detail: 'build failed' },
      }),
    })
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([releaseEntry({ prereleases: true })]), 'change the entries file')
    const after = git(source, 'rev-parse', 'HEAD')
    const docs = cloneDocs(world, 'docs-plan')
    const head = git(docs, 'rev-parse', 'HEAD')
    const planFile = join(world.base, 'plan.md')

    const run = runPublisher(docs, {
      source: cloneSource(world, source, 'checkout'), plan: true, planFile, before, after,
    })

    expect(run.status).toBe(0)
    const body = readFileSync(planFile, 'utf8')
    expect(body).toContain('- Add version `alpha/1.0.0`.')
    expect(body).not.toContain('.skipped-tags.json')
    expect(git(docs, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(docs, 'status', '--porcelain')).toBe('')
  })
})

describe('validating the Skipped tags file', () => {
  test.each([
    ['broken JSON', '{'],
    ['a list', '[]'],
    ['a missing source', JSON.stringify({ tags: {} })],
    ['an empty source', JSON.stringify({ source: '', tags: {} })],
    ['a missing tags map', JSON.stringify({ source: 'acme/source' })],
    ['a tags map that is a list', JSON.stringify({ source: 'acme/source', tags: [] })],
    ['a record that is not an object', JSON.stringify({ source: 'acme/source', tags: { 'alpha-v1.0.0': 'content' } })],
    ['an unknown reason', emptySkipFile({ 'alpha-v1.0.0': { sourceRevision: SHA, reason: 'because' } })],
    ['a missing revision', emptySkipFile({ 'alpha-v1.0.0': { reason: 'prerelease' } })],
    ['a revision that is not a commit', emptySkipFile({ 'alpha-v1.0.0': { sourceRevision: 'HEAD', reason: 'prerelease' } })],
    ['a content skip with no specHash', emptySkipFile({ 'alpha-v1.0.0': { sourceRevision: SHA, reason: 'content' } })],
    ['a specHash that is not a hash', emptySkipFile({ 'alpha-v1.0.0': { sourceRevision: SHA, reason: 'no folder', specHash: 'x' } })],
    ['an empty detail', emptySkipFile({ 'alpha-v1.0.0': { sourceRevision: SHA, reason: 'content', specHash: 'b'.repeat(64), detail: '' } })],
  ])('refuses %s and writes nothing', (_name, content) => {
    const source = plainSource()
    seedDocs(world, { [SKIPPED]: content })
    const commits = remoteCommitCount(world)
    const tree = readTree(readRemote(world))

    const run = runPublisher(cloneDocs(world), { source: cloneSource(world, source, 'checkout'), reconcile: true })

    expect(run.status).toBe(2)
    expect(run.output).toContain(`invalid .skipped-tags.json: ${SKIPPED}`)
    expect(remoteCommitCount(world)).toBe(commits)
    expect(readTree(readRemote(world))).toEqual(tree)
  })

  test.each(['a folder', 'a symlink'])('refuses %s at the file path', (kind) => {
    const source = plainSource()
    const docs = cloneDocs(world, 'seed-damaged')
    mkdirSync(join(docs, AREA), { recursive: true })
    if (kind === 'a folder') write(docs, { [`${SKIPPED}/keep.md`]: 'not a file\n' })
    else symlinkSync('/etc/hosts', join(docs, SKIPPED))
    git(docs, 'add', '-A')
    git(docs, 'commit', '--no-verify', '-m', `seed ${kind}`)
    git(docs, 'push', 'origin', 'main')
    const commits = remoteCommitCount(world)
    const tree = readTree(readRemote(world))

    const run = runPublisher(cloneDocs(world), { source: cloneSource(world, source, 'checkout'), reconcile: true })

    expect(run.status).toBe(2)
    expect(run.output).toContain(`invalid .skipped-tags.json: ${SKIPPED}`)
    expect(remoteCommitCount(world)).toBe(commits)
    expect(readTree(readRemote(world))).toEqual(tree)
  })
})

describe('reserving the Skipped tags file name', () => {
  test('refuses an Area file named after it', () => {
    const source = makeSource(world)
    const entry = releaseEntry({ areaFiles: [{ from: 'README.md', to: '.skipped-tags.json' }] })
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([entry]) }, 'alpha-v1.0.0', DATE)
    const commits = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' })

    expect(run.status).toBe(2)
    expect(run.output).toContain(
      'areaFiles to ".skipped-tags.json" in area "features" is one of the publisher\'s shared files',
    )
    expect(remoteCommitCount(world)).toBe(commits)
  })

  test('refuses an Area named after it', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ area: '.skipped-tags.json' })]) },
      'alpha-v1.0.0',
      DATE,
    )
    const commits = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' })

    expect(run.status).toBe(2)
    expect(run.output).toContain('area ".skipped-tags.json" uses a name the publisher reserves')
    expect(remoteCommitCount(world)).toBe(commits)
  })

  test('refuses a collect rule that would write it at the top of a Mirror Area', () => {
    const source = makeSource(world)
    const entry = mirrorEntry({ collect: [{ from: 'docs/config.json', to: '.skipped-tags.json' }] })
    commitSource(source, { 'docs/config.json': '{}\n', ...entriesFile([entry]) }, 'mirror entry')

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(2)
    expect(run.output).toContain('collect from "docs/config.json" would publish site/raw/core/docs/.skipped-tags.json')
  })
})
