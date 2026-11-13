import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { cloneDocs, commitSource, entriesFile, featureFiles, makeDocsRemote, makeSource, mirrorEntry, readFile, readRemote, releaseCommit, releaseEntry, remoteCommitCount, runPublisher, unnamedReleaseEntry } from '../test/harness.mjs'

let world
beforeEach(() => { world = makeDocsRemote() })
afterEach(() => { world.cleanup() })
const DATE = '2026-01-02T03:04:05Z'

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
