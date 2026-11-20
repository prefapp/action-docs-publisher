import { afterEach, describe, expect, test } from '@jest/globals'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { meta, renderedScript, write } from '../test/harness.mjs'

const { discoverAreas } = await import(renderedScript('discovery.mjs'))

const DATE = '2026-01-02T03:04:05Z'
const REPO = 'acme/source'
const ROOT = 'site/raw'
const REVISION = 'a'.repeat(40)

const versionMeta = (tag = 'alpha-v1.0.0') => meta({ source: REPO, tag, date: DATE })
const branchMeta = (area) => meta({ source: REPO, area, branch: 'main', sourceRevision: REVISION, date: DATE })
const mirrorMeta = () => meta({ source: REPO, sourceRevision: REVISION, sourceBranch: 'main', date: DATE })
const skippedTags = (source = REPO) => `${JSON.stringify({ source, tags: {} }, null, 2)}\n`

const trees = []
afterEach(() => {
  for (const dir of trees.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// A docs checkout, as the walk sees it: files placed exactly where a run would find them.
function docsTree(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'docs-publisher-discovery-')))
  trees.push(dir)
  write(dir, files)
  return dir
}

const claims = (discovered) => discovered.claims.map((claim) => [claim.kind, claim.dir])

describe('the traversal Area claim discovery owns', () => {
  test('stops at a Version folder: the Skipped tags file and the Area inside one are a tag\'s content, not claims', () => {
    const docs = docsTree({
      [`${ROOT}/features/alpha/1.0.0/.meta.json`]: versionMeta(),
      [`${ROOT}/features/alpha/1.0.0/.skipped-tags.json`]: skippedTags('other/repo'),
      [`${ROOT}/features/alpha/1.0.0/manual/.meta.json`]: mirrorMeta(),
      [`${ROOT}/features/.skipped-tags.json`]: skippedTags(),
    })

    const discovered = discoverAreas(docs, ROOT)

    expect(claims(discovered)).toEqual([
      ['Version', `${ROOT}/features/alpha/1.0.0`],
      ['Skipped', `${ROOT}/features`],
    ])
    expect(discovered.claims.at(-1).rel).toBe(`${ROOT}/features/.skipped-tags.json`)
    expect(discovered.damaged).toEqual([])
  })

  test('enters a Mirror Area: another Area of this repo or of another repo can sit inside it', () => {
    const docs = docsTree({
      [`${ROOT}/core/docs/.meta.json`]: mirrorMeta(),
      [`${ROOT}/core/docs/inner/.meta.json`]: mirrorMeta(),
      [`${ROOT}/core/crds/main/.meta.json`]: branchMeta('core/crds'),
      [`${ROOT}/core/docs/inner/.skipped-tags.json`]: skippedTags('other/repo'),
    })

    const discovered = discoverAreas(docs, ROOT)

    expect(claims(discovered)).toEqual([
      ['Branch', `${ROOT}/core/crds/main`],
      ['Mirror', `${ROOT}/core/docs`],
      ['Mirror', `${ROOT}/core/docs/inner`],
      ['Skipped', `${ROOT}/core/docs/inner`],
    ])
    expect(discovered.damaged).toEqual([])
  })

  test('reports the damaged claims it defers marker first, then Skipped tags file, in walk order', () => {
    const docs = docsTree({
      [`${ROOT}/a/.skipped-tags.json`]: '{',
      [`${ROOT}/b/1.0.0/.meta.json`]: meta({ source: REPO, date: DATE }),
      [`${ROOT}/b/1.0.0/nested/.meta.json`]: mirrorMeta(),
      [`${ROOT}/c/.skipped-tags.json`]: '{',
      [`${ROOT}/d/2.0.0/.meta.json`]: meta({ source: REPO, tag: 'd-v2.0.0', date: 'not-a-date' }),
    })

    const discovered = discoverAreas(docs, ROOT)

    expect(discovered.claims).toEqual([])
    expect(discovered.damaged).toEqual([
      { dir: `${ROOT}/b/1.0.0`, message: `invalid .meta.json: ${ROOT}/b/1.0.0/.meta.json` },
      { dir: `${ROOT}/d/2.0.0`, message: `invalid .meta.json: ${ROOT}/d/2.0.0/.meta.json` },
      { dir: `${ROOT}/a`, rel: `${ROOT}/a/.skipped-tags.json`, message: `invalid .skipped-tags.json: ${ROOT}/a/.skipped-tags.json` },
      { dir: `${ROOT}/c`, rel: `${ROOT}/c/.skipped-tags.json`, message: `invalid .skipped-tags.json: ${ROOT}/c/.skipped-tags.json` },
    ])
  })

  test.each([
    ['a damaged Mirror marker', `${ROOT}/core/docs/.meta.json`, meta({ source: REPO, date: DATE })],
    ['a damaged Branch Version marker', `${ROOT}/core/crds/main/.meta.json`, meta({ source: REPO, branch: 'main', date: DATE })],
    ['a damaged Version marker whose Area leaves the root', `${ROOT}/1.0.0/.meta.json`, meta({ source: REPO, tag: 'p-v1.0.0', date: DATE })],
  ])('stops the run on %s it cannot defer, instead of reporting it', (_name, marker, content) => {
    const docs = docsTree({ [marker]: content })

    expect(() => discoverAreas(docs, ROOT)).toThrow(`invalid .meta.json: ${marker}`)
  })

  test('stops at a damaged marker: the Area inside it stays undiscovered', () => {
    const docs = docsTree({
      [`${ROOT}/b/1.0.0/.meta.json`]: meta({ source: REPO, date: DATE }),
      [`${ROOT}/b/1.0.0/manual/.meta.json`]: mirrorMeta(),
      [`${ROOT}/b/1.0.0/.skipped-tags.json`]: skippedTags(),
    })

    expect(discoverAreas(docs, ROOT).claims).toEqual([])
  })
})

describe('the release Areas discovery derives from its claims', () => {
  const tree = () => docsTree({
    [`${ROOT}/core/crds/main/.meta.json`]: branchMeta('core/crds'),
    [`${ROOT}/core/docs/.meta.json`]: mirrorMeta(),
    [`${ROOT}/core/docs/.skipped-tags.json`]: skippedTags(),
    [`${ROOT}/features/.skipped-tags.json`]: skippedTags(),
    [`${ROOT}/features/alpha/1.0.0/.meta.json`]: versionMeta(),
  })

  test('a Version folder, a Branch Version folder and a Skipped tags file claim one, and a Mirror Area never does', () => {
    const discovered = discoverAreas(tree(), ROOT)

    expect([...discovered.releaseAreas()].sort()).toEqual([`${ROOT}/core/crds`, `${ROOT}/core/docs`, `${ROOT}/features`])
  })

  test('a Skipped tags file the caller publishes as content claims no release Area', () => {
    const discovered = discoverAreas(tree(), ROOT)
    const content = new Set([`${ROOT}/core/docs/.skipped-tags.json`])

    expect([...discovered.releaseAreas({ content })].sort()).toEqual([`${ROOT}/core/crds`, `${ROOT}/features`])
  })

  test('an Area a Version folder also claims stays a release Area when its Skipped tags file is content', () => {
    const discovered = discoverAreas(tree(), ROOT)
    const content = new Set([`${ROOT}/features/.skipped-tags.json`])

    expect([...discovered.releaseAreas({ content })].sort()).toEqual([`${ROOT}/core/crds`, `${ROOT}/core/docs`, `${ROOT}/features`])
  })
})
