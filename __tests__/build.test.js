import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import {
  cloneDocs,
  cloneSource,
  entriesFile,
  exists,
  featureFiles,
  makeDocsRemote,
  makeSource,
  readFile,
  readRemote,
  releaseCommit,
  releaseEntry,
  remoteCommitCount,
  runPublisher,
  startPublisher,
  unnamedReleaseEntry,
} from '../test/harness.mjs'

const DATE = '2026-01-02T03:04:05Z'
const CRD_A = 'kind: CustomResourceDefinition\nname: a\n'
const CRD_B = 'kind: CustomResourceDefinition\nname: b\n'
const CRDS_INDEX = `${CRD_A}${CRD_B}`
const CONCATENATE = 'cat crds/*.yaml > index.yaml'

let world

beforeEach(() => {
  world = makeDocsRemote()
})

afterEach(() => {
  world.cleanup()
})

function crdFiles() {
  return { 'crds/a.yaml': CRD_A, 'crds/b.yaml': CRD_B }
}

describe('a build on an unnamed release entry', () => {
  test('runs at the repo root before collecting, so the published file is the built one', () => {
    const entry = unnamedReleaseEntry({ build: CONCATENATE })
    const source = makeSource(world)
    releaseCommit(source, { ...crdFiles(), ...entriesFile([entry]) }, 'v1.2.0', DATE)
    const docs = cloneDocs(world)

    const run = runPublisher(docs, { source, tag: 'v1.2.0' })

    expect(run.status).toBe(0)
    expect(readFile(readRemote(world), 'site/raw/core/crds/v1.2.0/index.yaml')).toBe(CRDS_INDEX)
  })

  test('a failing build exits 2 and pushes nothing', () => {
    const entry = unnamedReleaseEntry({ build: 'echo kaboom >&2; exit 3' })
    const source = makeSource(world)
    releaseCommit(source, { 'index.yaml': CRDS_INDEX, ...entriesFile([entry]) }, 'v1.2.0', DATE)
    const docs = cloneDocs(world)
    const before = remoteCommitCount(world)

    const run = runPublisher(docs, { source, tag: 'v1.2.0' })

    expect(run.status).toBe(2)
    expect(run.output).toContain('build failed in the source checkout (exit 3)')
    expect(run.output).toContain('kaboom')
    expect(remoteCommitCount(world)).toBe(before)
  })
})

describe('a build on a named release entry', () => {
  test('runs in the package folder, not the repo root', () => {
    const entry = releaseEntry({ mainFile: 'built.md', build: 'cp templates/docs/intro.md built.md', collect: [{ from: 'built.md', to: 'built.md' }] })
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('docs_publisher'), ...entriesFile([entry]) }, 'docs_publisher-v1.0.0', DATE)
    const docs = cloneDocs(world)

    const run = runPublisher(docs, { source, tag: 'docs_publisher-v1.0.0' })

    expect(run.status).toBe(0)
    expect(readFile(readRemote(world), 'site/raw/features/docs_publisher/1.0.0/built.md')).toBe('# docs_publisher\n')
  })

  test('a failing build exits 2 and pushes nothing', () => {
    const entry = releaseEntry({ build: 'exit 1' })
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('docs_publisher'), ...entriesFile([entry]) }, 'docs_publisher-v1.0.0', DATE)
    const docs = cloneDocs(world)
    const before = remoteCommitCount(world)

    const run = runPublisher(docs, { source, tag: 'docs_publisher-v1.0.0' })

    expect(run.status).toBe(2)
    expect(run.output).toContain('build failed in packages/docs_publisher (exit 1)')
    expect(remoteCommitCount(world)).toBe(before)
  })
})

describe('two entries whose builds touch one collected file', () => {
  test('each entry publishes its own post-build bytes', () => {
    const entries = [
      unnamedReleaseEntry({
        area: 'core/one',
        mainFile: 'shared.txt',
        build: 'echo one > shared.txt',
        collect: [{ from: 'shared.txt', to: 'shared.txt' }],
      }),
      unnamedReleaseEntry({
        area: 'core/two',
        mainFile: 'shared.txt',
        build: 'echo two > shared.txt',
        collect: [{ from: 'shared.txt', to: 'shared.txt' }],
      }),
    ]
    const source = makeSource(world)
    releaseCommit(source, { ...entriesFile(entries) }, 'v1.2.0', DATE)
    const docs = cloneDocs(world)

    const run = runPublisher(docs, { source, tag: 'v1.2.0' })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/core/one/v1.2.0/shared.txt')).toBe('one\n')
    expect(readFile(landed, 'site/raw/core/two/v1.2.0/shared.txt')).toBe('two\n')
  })
})

describe('the environment of a build', () => {
  test.each(['stdout', 'stderr'])('streams more than 1 MiB of %s without killing a successful build', async (stream) => {
    const entry = unnamedReleaseEntry({
      build: `node -e 'process.${stream}.write("x".repeat(2 * 1024 * 1024))'`,
    })
    const source = makeSource(world)
    releaseCommit(source, { 'index.yaml': CRDS_INDEX, ...entriesFile([entry]) }, 'v1.2.0', DATE)

    const run = await startPublisher(cloneDocs(world), { source, tag: 'v1.2.0' })

    expect(run.status).toBe(0)
    expect(run.output).toContain('x'.repeat(128))
    expect(readFile(readRemote(world), 'site/raw/core/crds/v1.2.0/index.yaml')).toBe(CRDS_INDEX)
  })

  test('finds no token in its environment, and the token file is gone before it runs', () => {
    const entry = unnamedReleaseEntry({
      build: 'echo "${GITHUB_TOKEN:-}|${GH_TOKEN:-}|${DOCS_PUBLISHER_DOCS_TOKEN_FILE:-}|${DOCS_PUBLISHER_SOURCE_TOKEN_FILE:-}|$(ls "$TOKENS")" > index.yaml',
    })
    const source = makeSource(world)
    releaseCommit(source, { ...crdFiles(), ...entriesFile([entry]) }, 'v1.2.0', DATE)
    const docs = cloneDocs(world)
    const tokens = join(world.base, 'tokens')
    mkdirSync(tokens)
    writeFileSync(join(tokens, 'source'), 'source-token')
    writeFileSync(join(tokens, 'docs'), 'docs-token')

    const run = runPublisher(docs, {
      source,
      tag: 'v1.2.0',
      env: {
        TOKENS: tokens,
        GITHUB_TOKEN: 'ambient-token',
        GH_TOKEN: 'ambient-token',
        DOCS_PUBLISHER_SOURCE_TOKEN_FILE: join(tokens, 'source'),
        DOCS_PUBLISHER_DOCS_TOKEN_FILE: join(tokens, 'docs'),
      },
    })

    expect(run.status).toBe(0)
    expect(readFile(readRemote(world), 'site/raw/core/crds/v1.2.0/index.yaml')).toBe('||||\n')
  })

  test('passes each token only to the git commands that fetch from or push to its remote', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...crdFiles(), ...entriesFile([unnamedReleaseEntry({ build: CONCATENATE })]) }, 'v1.2.0', DATE)
    const docs = cloneDocs(world)
    const stubs = join(world.base, 'stubs')
    const log = join(stubs, 'git-log')
    mkdirSync(stubs)
    writeFileSync(join(stubs, 'source-token'), 'source-token\n')
    writeFileSync(join(stubs, 'docs-token'), 'docs-token\n')
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    writeFileSync(join(stubs, 'git'), [
      '#!/bin/sh',
      'for arg in "$@"; do',
      '  case "$arg" in fetch|push) echo "$arg $(basename "$PWD") ${GIT_CONFIG_KEY_0:-none} ${GIT_CONFIG_VALUE_0:-none}" >> "$GIT_LOG"; exec "$REAL_GIT" "$@";; esac',
      'done',
      'if [ -n "${GIT_CONFIG_VALUE_0:-}" ]; then echo "leak $*" >> "$GIT_LOG"; fi',
      'exec "$REAL_GIT" "$@"',
      '',
    ].join('\n'), { mode: 0o755 })

    const checkout = cloneSource(world, source, 'checkout')
    const run = runPublisher(docs, {
      source: checkout,
      reconcile: true,
      env: {
        PATH: `${stubs}:${process.env.PATH}`,
        GIT_LOG: log,
        REAL_GIT: realGit,
        DOCS_PUBLISHER_SOURCE_TOKEN_FILE: join(stubs, 'source-token'),
        DOCS_PUBLISHER_DOCS_TOKEN_FILE: join(stubs, 'docs-token'),
      },
    })

    expect(run.output).not.toContain('docs_publisher:')
    expect(run.status).toBe(0)
    const header = (token) => `http.https://github.com/.extraheader AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
    const calls = [...new Set(readFileSync(log, 'utf8').split('\n').filter(Boolean))].sort()
    expect(calls).toEqual([
      `fetch ${basename(checkout)} ${header('source-token')}`,
      `fetch ${basename(docs)} ${header('docs-token')}`,
      `push ${basename(docs)} ${header('docs-token')}`,
    ])
  })

  test('runs in a reconcile only for the tags it publishes, not for the Versions the docs already hold', () => {
    const entry = unnamedReleaseEntry({ build: `echo built >> "$BUILD_LOG"; ${CONCATENATE}` })
    const source = makeSource(world)
    releaseCommit(source, { ...crdFiles(), ...entriesFile([entry]) }, 'v1.0.0', DATE)
    releaseCommit(source, { 'crds/c.yaml': 'kind: CustomResourceDefinition\nname: c\n' }, 'v1.1.0', DATE)
    const log = join(world.base, 'build-log')
    const reconcile = (name) => runPublisher(cloneDocs(world, name), {
      source: cloneSource(world, source, `checkout-${name}`), reconcile: true, env: { BUILD_LOG: log },
    })

    expect(reconcile('first').status).toBe(0)
    expect(readFileSync(log, 'utf8')).toBe('built\nbuilt\n')

    releaseCommit(source, { 'crds/d.yaml': 'kind: CustomResourceDefinition\nname: d\n' }, 'v1.2.0', DATE)
    const second = reconcile('second')
    expect(second.status).toBe(0)
    expect(readFileSync(log, 'utf8')).toBe('built\nbuilt\nbuilt\n')
    expect(second.summary).toContain('- Published `site/raw/core/crds/v1.2.0`.')
    expect(second.summary).toContain('- Kept `site/raw/core/crds/v1.0.0`, `site/raw/core/crds/v1.1.0`: specHash matches the current entry.')
  })

  test('inherits the publisher environment', () => {
    const entry = unnamedReleaseEntry({
      build: 'echo "$GITHUB_REPOSITORY" > index.yaml',
    })
    const source = makeSource(world)
    releaseCommit(source, { ...crdFiles(), ...entriesFile([entry]) }, 'v1.2.0', DATE)
    const docs = cloneDocs(world)

    expect(runPublisher(docs, { source, tag: 'v1.2.0' }).status).toBe(0)
    expect(readFile(readRemote(world), 'site/raw/core/crds/v1.2.0/index.yaml')).toBe('acme/source\n')
    expect(exists(readRemote(world), 'site/raw/core/crds/v1.2.0/.meta.json')).toBe(true)
  })
})
