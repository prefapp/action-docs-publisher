import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cloneDocs, cloneSource, commitSource, entriesFile, exists, featureFiles, git, makeDocsRemote, makeSource,
  mirrorEntry, readFile, readRemote, readTree, releaseCommit, releaseEntry, remoteCommitCount, runPublisher,
  seedDocs, unnamedReleaseEntry,
} from '../test/harness.mjs'

let world
beforeEach(() => { world = makeDocsRemote() })
afterEach(() => { world.cleanup() })
const DATE = '2026-01-02T03:04:05Z'

const skippedFile = (source, tags = {}) => `${JSON.stringify({ source, tags }, null, 2)}\n`

describe('publisher reservations', () => {
  test.each(['index.json', 'versions.json', '.meta.json', 'latest'])('an unnamed Area file may not use %s', (to) => {
    const source = makeSource(world)
    releaseCommit(source, { 'README.md': '# docs', 'index.yaml': 'kind: CRD', ...entriesFile([unnamedReleaseEntry({ areaFiles: [{ from: 'README.md', to }] })]) }, 'v1.0.0', DATE)
    const before = remoteCommitCount(world)
    const run = runPublisher(cloneDocs(world), { source, tag: 'v1.0.0' })
    expect(run.status).toBe(2)
    expect(run.output).toContain(`areaFiles to "${to}"`)
    expect(remoteCommitCount(world)).toBe(before)
  })

  test.each(['.meta.json', 'sub/.meta.json'])('collect may not write %s', (to) => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ collect: [{ from: 'schema.json', to }] })]) }, 'alpha-v1.0.0', DATE)
    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' })
    expect(run.status).toBe(2)
    expect(run.output).toContain(`collect to "${to}"`)
  })

  test('a glob may not smuggle nested .meta.json into a Version folder', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), 'packages/alpha/templates/docs/sub/.meta.json': '{}', ...entriesFile([releaseEntry({ collect: [{ from: 'templates/docs/**', to: '.' }] })]) }, 'alpha-v1.0.0', DATE)
    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' })
    expect(run.status).toBe(2)
    expect(run.output).toContain('collect from "packages/alpha/templates/docs/sub/.meta.json"')
  })

  test.each(['meta.json', 'sub/meta.json', 'sub/1.0.0', '01.0.0'])('ordinary collected file %s is not publisher metadata', (to) => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ mainFile: to, collect: [{ from: 'schema.json', to }] })]) }, 'alpha-v1.0.0', DATE)
    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' })
    expect(run.status).toBe(0)
    expect(readFile(readRemote(world), `site/raw/features/alpha/1.0.0/${to}`)).toBe('{}\n')
  })

  test.each(['1.0.0', 'v1.0.0', 'latest', 'versions.json', 'index.json', '.meta.json'])('a nested Area may not be named %s', (name) => {
    const source = makeSource(world)
    commitSource(source, { 'docs/a.md': '# docs', ...entriesFile([mirrorEntry({ area: `features/${name}` })]) })
    const run = runPublisher(cloneDocs(world), { source })
    expect(run.status).toBe(2)
    expect(run.output).toContain('uses a name the publisher reserves')
  })

  test('images is not a reserved Area or package name', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('images'), ...entriesFile([releaseEntry({ area: 'images/features' })]) }, 'images-v1.0.0', DATE)
    const run = runPublisher(cloneDocs(world), { source, tag: 'images-v1.0.0' })
    expect(run.status).toBe(0)
    expect(readFile(readRemote(world), 'site/raw/images/features/images/1.0.0/intro.md')).toBe('# images\n')
  })
})

const AREA = 'site/raw/features'
const SKIPPED = `${AREA}/.skipped-tags.json`
const MIRROR_AREA = 'site/raw/core/docs'
const OWNERSHIP = 'belongs to other/repo, but this repo is acme/source. Choose another Area.'

// Every write mode, driven the way its event drives it: a release tag, a push range, a manual reconcile, and a plan
// against a pull request's range. Only the plan writes nothing, so only it reports the refusal in its comment.
function runMode(source, mode) {
  const before = git(source, 'rev-parse', 'HEAD')
  commitSource(source, { 'packages/alpha/templates/docs/intro.md': '# alpha v2\n' }, 'change a package')
  const after = git(source, 'rev-parse', 'HEAD')
  const suffix = `${mode}-${Math.random().toString(36).slice(2)}`
  const planFile = join(world.base, `plan-${suffix}.md`)
  const result = runPublisher(cloneDocs(world, `docs-${suffix}`), {
    source: cloneSource(world, source, `checkout-${suffix}`),
    ...(mode === 'release' ? { tag: 'alpha-v1.0.0' } : mode === 'reconcile' ? { reconcile: true } : { before, after }),
    ...(mode === 'plan' ? { plan: true, planFile } : {}),
  })
  return { ...result, text: mode === 'plan' ? readFileSync(planFile, 'utf8') : result.output }
}

describe('a Skipped tags file claims its Area', () => {
  test.each(['release', 'push', 'reconcile', 'plan'])(
    '%s refuses an Area another repo claims by its Skipped tags file, and writes nothing',
    (mode) => {
      const source = makeSource(world)
      releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
      seedDocs(world, { [SKIPPED]: skippedFile('other/repo') })
      const commits = remoteCommitCount(world)
      const tree = readTree(readRemote(world))

      const result = runMode(source, mode)

      expect(result.status).toBe(mode === 'plan' ? 0 : 2)
      expect(result.text).toContain(`Area "features" ${OWNERSHIP}`)
      expect(remoteCommitCount(world)).toBe(commits)
      expect(readTree(readRemote(world))).toEqual(tree)
    },
  )

  test.each(['push', 'plan'])('%s refuses a Mirror Area another repo claims by its Skipped tags file', (mode) => {
    const source = makeSource(world)
    commitSource(source, { 'docs/a.md': '# a\n', ...entriesFile([mirrorEntry({ area: 'core/docs' })]) }, 'mirror entry')
    seedDocs(world, { [`${MIRROR_AREA}/.skipped-tags.json`]: skippedFile('other/repo') })
    const before = git(source, 'rev-parse', 'HEAD')
    // A plan only runs when the range changes the entries file or a release package folder, and the mirror entry is
    // the change it can see.
    commitSource(source, mode === 'plan'
      ? entriesFile([mirrorEntry({ area: 'core/docs', paths: ['docs/**', 'README.md'] })])
      : { 'docs/b.md': '# b\n' }, 'change the mirror')
    const after = git(source, 'rev-parse', 'HEAD')
    const commits = remoteCommitCount(world)
    const planFile = join(world.base, `plan-mirror-${Math.random().toString(36).slice(2)}.md`)

    const result = runPublisher(cloneDocs(world), {
      source: cloneSource(world, source, `checkout-mirror-${mode}`),
      ...(mode === 'plan' ? { plan: true, planFile, before, after } : { before, after }),
    })

    expect(result.status).toBe(mode === 'plan' ? 0 : 2)
    expect(mode === 'plan' ? readFileSync(planFile, 'utf8') : result.output).toContain(`Area "core/docs" ${OWNERSHIP}`)
    expect(remoteCommitCount(world)).toBe(commits)
  })

  test('the same repo may publish into it: the folder counts as a marked Area', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
    const bytes = skippedFile('acme/source', {
      'alpha-v0.9.0': { sourceRevision: 'b'.repeat(40), reason: 'no folder', specHash: 'c'.repeat(64) },
    })
    seedDocs(world, { [SKIPPED]: bytes, [`${AREA}/hand.txt`]: 'BY HAND\n' })

    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    // The Area is the publisher's, so a stray top-level file goes, and the tags it does not publish stay recorded.
    expect(exists(landed, `${AREA}/hand.txt`)).toBe(false)
    expect(readFile(landed, SKIPPED)).toBe(bytes)
    expect(exists(landed, `${AREA}/alpha/1.0.0/.meta.json`)).toBe(true)
  })
})

describe('placement guards read a Skipped tags file like an Area marker', () => {
  test('a release Area may not sit inside an Area claimed only by a Skipped tags file', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ area: 'tools/features' })]) },
      'alpha-v1.0.0',
      DATE,
    )
    seedDocs(world, { 'site/raw/tools/.skipped-tags.json': skippedFile('other/repo') })

    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' })

    expect(run.status).toBe(2)
    expect(run.output).toContain('refusing to publish site/raw/tools/features: it sits inside a release Area at site/raw/tools')
  })

  test('a Mirror Area may not sit inside an Area claimed only by a Skipped tags file', () => {
    const source = makeSource(world)
    commitSource(source, { 'docs/a.md': '# a\n', ...entriesFile([mirrorEntry({ area: 'tools/docs' })]) }, 'mirror entry')
    seedDocs(world, { 'site/raw/tools/.skipped-tags.json': skippedFile('other/repo') })
    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(2)
    expect(run.output).toContain(
      'refusing to publish site/raw/tools/docs: it sits inside the release Area site/raw/tools, and a Mirror Area cannot sit inside a release Area. Choose another Area.',
    )
  })
})
