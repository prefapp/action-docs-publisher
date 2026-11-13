import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cloneDocs,
  cloneSource,
  commitSource,
  entriesFile,
  exists,
  featureFiles,
  makeDocsRemote,
  makeSource,
  mirrorEntry,
  git,
  readFile,
  readJson,
  readRemote,
  releaseCommit,
  releaseEntry,
  remoteCommitCount,
  runPublisher,
  seedDocs,
  unnamedReleaseEntry,
} from '../test/harness.mjs'

// A docs repo can already hold a folder that has the name of an Area, made by hand and owned by nobody: its own
// `docs/`, `src/` or a leftover. No marker names any source repo. Publishing must refuse and leave every file alone.
const TAG = 'alpha-v1.0.0'
const DATE = '2026-01-02T03:04:05Z'

let world

beforeEach(() => {
  world = makeDocsRemote()
})

afterEach(() => {
  world.cleanup()
})

const ROOTS = [
  { label: 'a subfolder root', root: 'site/raw' },
  { label: 'a dot root', root: '.' },
]

for (const { label, root } of ROOTS) {
  const at = (rel) => (root === '.' ? rel : `${root}/${rel}`)

  describe(`with ${label}, a hand-made Area folder`, () => {
    test('a release refuses and keeps its files', () => {
      seedDocs(world, { [at('features/hand-made.md')]: '# Hand made\n' })
      const source = makeSource(world)
      releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, TAG, DATE)

      const run = runPublisher(cloneDocs(world, `docs-${label}`), { source, tag: TAG, root })

      expect(run.status).not.toBe(0)
      expect(readFile(readRemote(world), at('features/hand-made.md'))).toBe('# Hand made\n')
      expect(run.output).toContain(`refusing to publish \`${at('features')}\`: the folder holds no .meta.json`)
      expect(run.output).toContain('hand-made.md')
    })

    test('a mirror publish refuses and keeps its files', () => {
      seedDocs(world, { [at('core/docs/hand-made.md')]: '# Hand made\n' })
      const source = makeSource(world)
      commitSource(source, { 'docs/index.md': '# Docs\n', ...entriesFile([mirrorEntry()]) }, 'mirror')

      const run = runPublisher(cloneDocs(world, `docs-${label}`), { source, root })

      expect(run.status).not.toBe(0)
      expect(readFile(readRemote(world), at('core/docs/hand-made.md'))).toBe('# Hand made\n')
      expect(run.output).toContain(`refusing to publish \`${at('core/docs')}\`: the folder holds no .meta.json`)
      expect(run.output).toContain('hand-made.md')
    })

    test('a reconcile refuses and keeps its files', () => {
      seedDocs(world, { [at('features/hand-made.md')]: '# Hand made\n' })
      const source = makeSource(world)
      releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, TAG, DATE)

      const run = runPublisher(cloneDocs(world, `docs-${label}`), {
        source: cloneSource(world, source, `checkout-${label}`), root, reconcile: true,
      })

      expect(run.status).not.toBe(0)
      expect(readFile(readRemote(world), at('features/hand-made.md'))).toBe('# Hand made\n')
      expect(run.output).toContain(`refusing to publish \`${at('features')}\`: the folder holds no .meta.json`)
      expect(run.output).toContain('hand-made.md')
    })

    test('a prune keeps its files', () => {
      seedDocs(world, { [at('by-hand/notes.md')]: '# By hand\n' })
      const source = makeSource(world)
      releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, TAG, DATE)

      const run = runPublisher(cloneDocs(world, `docs-${label}`), {
        source: cloneSource(world, source, `checkout-${label}`), root, reconcile: true,
      })

      expect(run.status).toBe(0)
      // A prune deletes only folders whose .meta.json names this source repo.
      expect(readFile(readRemote(world), at('by-hand/notes.md'))).toBe('# By hand\n')
      expect(exists(readRemote(world), at('features'))).toBe(true)
    })
  })
}

describe('an unmarked Branch Version folder', () => {
  for (const { label, root } of ROOTS) {
    const at = (rel) => (root === '.' ? rel : `${root}/${rel}`)
    const branch = at('owned/area/main')
    const handMade = `${branch}/hand-made.md`

    describe(`with ${label}`, () => {
      function branchSource() {
        const source = makeSource(world, `branch-source-${Math.random().toString(36).slice(2)}`)
        releaseCommit(
          source,
          {
            'index.yaml': 'kind: CustomResourceDefinition\n',
            ...entriesFile([unnamedReleaseEntry({ area: 'owned/area', publishSourceBranch: true })]),
          },
          'v1.2.0',
          DATE,
        )
        return source
      }

      test('a push refuses to replace it and keeps its files', () => {
        seedDocs(world, { [handMade]: '# Hand made\n' })
        const source = branchSource()
        const before = git(source, 'rev-parse', 'HEAD')
        commitSource(source, { 'index.yaml': 'kind: CustomResourceDefinition\nversion: v2\n' })
        const after = git(source, 'rev-parse', 'HEAD')
        const docs = cloneDocs(world, `docs-branch-push-${label}`)
        const docsHead = git(docs, 'rev-parse', 'HEAD')
        const remoteHead = git(world.remote, 'rev-parse', 'main')

        const run = runPublisher(docs, { source, root, before, after })

        expect(run.status).toBe(2)
        expect(run.output).toContain(`refusing to publish \`${branch}\`: the folder holds no .meta.json`)
        expect(run.output).toContain(handMade)
        expect(readFile(readRemote(world), handMade)).toBe('# Hand made\n')
        expect(git(world.remote, 'rev-parse', 'main')).toBe(remoteHead)
        expect(git(docs, 'rev-parse', 'HEAD')).toBe(docsHead)
      })

      test('a reconcile refuses to replace it and keeps its files', () => {
        seedDocs(world, { [handMade]: '# Hand made\n' })
        const source = branchSource()
        const before = remoteCommitCount(world)
        const remoteHead = git(world.remote, 'rev-parse', 'main')
        const docs = cloneDocs(world, `docs-branch-reconcile-${label}`)
        const docsHead = git(docs, 'rev-parse', 'HEAD')

        const run = runPublisher(docs, {
          source: cloneSource(world, source, `checkout-branch-${label}`), root, reconcile: true,
        })

        expect(run.status).toBe(2)
        expect(run.output).toContain(`refusing to publish \`${branch}\`: the folder holds no .meta.json`)
        expect(run.output).toContain(handMade)
        expect(readFile(readRemote(world), handMade)).toBe('# Hand made\n')
        expect(remoteCommitCount(world)).toBe(before)
        expect(git(world.remote, 'rev-parse', 'main')).toBe(remoteHead)
        expect(git(docs, 'rev-parse', 'HEAD')).toBe(docsHead)
      })
    })
  }
})

describe('an Area folder the publisher itself wrote without a marker', () => {
  test.each(['site/raw', '.'])('is reused by a second reconcile (root %s)', (root) => {
    const at = (rel) => (root === '.' ? rel : `${root}/${rel}`)
    const source = makeSource(world)
    commitSource(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'entries without a matching tag')
    const suffix = Math.random().toString(36).slice(2)

    const first = runPublisher(cloneDocs(world, `docs-first-${suffix}`), {
      source: cloneSource(world, source, `checkout-first-${suffix}`), root, reconcile: true,
    })
    expect(first.status).toBe(0)
    // A release entry with no tag writes Area files and index.json, and no .meta.json: the publisher's own Area.
    expect(readJson(readRemote(world), at('features/index.json'))).toEqual({ features: [] })

    const second = runPublisher(cloneDocs(world, `docs-second-${suffix}`), {
      source: cloneSource(world, source, `checkout-second-${suffix}`), root, reconcile: true,
    })
    expect(second.status).toBe(0)
    expect(readJson(readRemote(world), at('features/index.json'))).toEqual({ features: [] })
  })
})

describe('a plan over a hand-made Area folder', () => {
  test.each(['site/raw', '.'])('reports the refusal in the comment instead of deleting (root %s)', (root) => {
    const at = (rel) => (root === '.' ? rel : `${root}/${rel}`)
    seedDocs(world, { [at('features/hand-made.md')]: '# Hand made\n' })
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([]) }, TAG, DATE)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([releaseEntry()]))
    const suffix = Math.random().toString(36).slice(2)
    const checkout = cloneSource(world, source, `plan-source-${suffix}`)
    const head = git(checkout, 'rev-parse', 'HEAD')
    git(checkout, 'checkout', '--quiet', '--detach', head)
    const docs = cloneDocs(world, `plan-docs-${suffix}`)
    const docsHead = git(docs, 'rev-parse', 'HEAD')
    const remoteHead = git(world.remote, 'rev-parse', 'main')
    const planFile = join(world.base, `plan-${suffix}.md`)
    const snapshots = join(world.base, `snapshots-${suffix}`)
    mkdirSync(snapshots)

    const run = runPublisher(docs, {
      source: checkout, root, plan: true, planFile, before, after: head,
      env: { RUNNER_TEMP: snapshots },
    })

    expect(run.status).toBe(0)
    const body = readFileSync(planFile, 'utf8')
    expect(body).toContain('This change would fail to publish:')
    expect(body).toContain(`refusing to publish \`${at('features')}\`:`)
    expect(body).toContain(at('features/hand-made.md'))
    expect(readFile(readRemote(world), at('features/hand-made.md'))).toBe('# Hand made\n')
    expect(git(docs, 'rev-parse', 'HEAD')).toBe(docsHead)
    expect(git(world.remote, 'rev-parse', 'main')).toBe(remoteHead)
  })
})
