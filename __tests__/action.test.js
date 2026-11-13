import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startApiStub } from '../test/api-stub.mjs'
import {
  ENTRIES_PATH,
  commitSource,
  entriesFile,
  entriesJson,
  exists,
  featureFiles,
  git,
  makeDocsRemote,
  makeSource,
  meta,
  readRemote,
  releaseCommit,
  releaseEntry,
  remoteCommitCount,
  seedDocs,
} from '../test/harness.mjs'

// The action's own entry point, run the way a job runs it: the runner passes the inputs as `INPUT_*` variables, the
// event in `GITHUB_EVENT_PATH`, the workspace in `GITHUB_WORKSPACE`, and reads the outputs from `GITHUB_OUTPUT`.
const ENTRY = fileURLToPath(new URL('../src/index.mjs', import.meta.url))
const DATE = '2026-01-02T03:04:05Z'
const REPOSITORY = 'acme/source'
const DOCS_REPOSITORY = 'firestartr-pro/docs'
const ROOT = 'site/raw'
const BOT = 'docs-publisher[bot]'

let world
let api

beforeEach(async () => {
  world = makeDocsRemote()
  api = await startApiStub({ login: BOT, id: 12345 })
  // The action derives the docs URL from `GITHUB_SERVER_URL`, as it does for github.com and for a GitHub Enterprise
  // install. Here that server is a folder of bare repositories: the clone and the pushes are real git commands with
  // no network in the way, and no token is needed for them.
  const server = join(world.base, 'github')
  mkdirSync(join(server, 'firestartr-pro'), { recursive: true })
  renameSync(world.remote, join(server, 'firestartr-pro', 'docs.git'))
  world.remote = join(server, 'firestartr-pro', 'docs.git')
  world.server = `file://${server}`
})

afterEach(async () => {
  await api.close()
  world.cleanup()
})

function eventFile(event, payload) {
  const file = join(world.base, `event-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(file, JSON.stringify({ ...payload, event }))
  return file
}

// The runner's output file, in the two forms it defines: `name=value`, and a name followed by `<<` and a delimiter,
// the value, and the delimiter again on its own line.
function outputs(file) {
  const lines = (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n')
  const read = {}
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line === '') continue
    const heredoc = /^([^<]+)<<(.+)$/.exec(line)
    if (heredoc) {
      const value = []
      while (lines[++index] !== heredoc[2]) value.push(lines[index])
      read[heredoc[1]] = value.join('\n')
      continue
    }
    const at = line.indexOf('=')
    read[line.slice(0, at)] = line.slice(at + 1).replace(/%0A/g, '\n')
  }
  return read
}

// The API stub answers in this process, so the action runs in a child this process awaits: a synchronous spawn
// would block the event loop the stub answers on.
function runAction({ event, payload = {}, inputs = {}, env = {}, workspace }) {
  const outputFile = join(world.base, `output-${Math.random().toString(36).slice(2)}.txt`)
  const summaryFile = join(world.base, `summary-${Math.random().toString(36).slice(2)}.md`)
  writeFileSync(outputFile, '')
  writeFileSync(summaryFile, '')
  const child = spawn('node', [ENTRY], {
    env: {
      ...process.env,
      GITHUB_WORKSPACE: workspace,
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_SERVER_URL: world.server,
      GITHUB_API_URL: api.url,
      GITHUB_EVENT_NAME: event,
      GITHUB_EVENT_PATH: eventFile(event, payload),
      GITHUB_SHA: payload.sha ?? payload.pull_request?.head?.sha ?? '',
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      RUNNER_TEMP: join(world.base, 'runner-temp'),
      'INPUT_DOCS-REPOSITORY': DOCS_REPOSITORY,
      'INPUT_DOCS-ROOT-FOLDER': ROOT,
      'INPUT_DOCS-BRANCH': 'main',
      'INPUT_SOURCE-BRANCH': 'main',
      'INPUT_DOCS-TOKEN': 'docs-token',
      'INPUT_GITHUB-TOKEN': 'github-token',
      ...inputs,
      ...env,
    },
  })
  let logged = ''
  child.stdout.on('data', (chunk) => (logged += chunk))
  child.stderr.on('data', (chunk) => (logged += chunk))
  return new Promise((resolve) => {
    child.on('close', (status) => resolve({
      status,
      output: logged,
      outputs: outputs(outputFile),
      summary: readFileSync(summaryFile, 'utf8'),
    }))
  })
}

const releasePayload = { release: { tag_name: 'docs_publisher-v1.0.0' } }

describe('the action on a published release', () => {
  test('publishes the Version folder from the workspace, and reports the commit it pushed', async () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('docs_publisher'), ...entriesFile([releaseEntry()]) }, 'docs_publisher-v1.0.0', DATE)
    const before = remoteCommitCount(world)

    const run = await runAction({ event: 'release', payload: releasePayload, workspace: source })

    expect(run.status).toBe(0)
    expect(run.outputs).toEqual({ 'run-mode': 'release', 'docs-changed': 'true', 'docs-commit-sha': git(world.remote, 'rev-parse', 'main') })
    expect(remoteCommitCount(world)).toBe(before + 1)
    expect(exists(readRemote(world), `${ROOT}/features/docs_publisher/1.0.0/schema.json`)).toBe(true)
    expect(run.summary).toContain('Published `docs_publisher-v1.0.0` to `main` under `site/raw/features/docs_publisher/1.0.0`.')
  })

  test('commits as the account the docs token belongs to, so the docs repo links the commit to it', async () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('docs_publisher'), ...entriesFile([releaseEntry()]) }, 'docs_publisher-v1.0.0', DATE)

    const run = await runAction({ event: 'release', payload: releasePayload, workspace: source })

    expect(run.status).toBe(0)
    expect(git(world.remote, 'log', '-1', '--format=%an|%ae')).toBe(`${BOT}|12345+${BOT}@users.noreply.github.com`)
    expect(api.calls.map((call) => `${call.method} ${decodeURIComponent(call.url)}`)).toEqual([
      'POST /graphql',
      `GET /users/${BOT}`,
    ])
  })

  test('commits as the user a personal token belongs to, whose login carries no [bot] suffix', async () => {
    const personal = await startApiStub({ login: 'octocat', id: 583231 })
    try {
      const source = makeSource(world)
      releaseCommit(source, { ...featureFiles('docs_publisher'), ...entriesFile([releaseEntry()]) }, 'docs_publisher-v1.0.0', DATE)

      const run = await runAction({
        event: 'release',
        payload: releasePayload,
        workspace: source,
        env: { GITHUB_API_URL: personal.url },
      })

      expect(run.status).toBe(0)
      expect(git(world.remote, 'log', '-1', '--format=%an|%ae')).toBe('octocat|583231+octocat@users.noreply.github.com')
      expect(personal.calls.map((call) => `${call.method} ${decodeURIComponent(call.url)}`)).toEqual([
        'POST /graphql',
        'GET /users/octocat',
      ])
      expect(api.calls).toEqual([])
    } finally {
      await personal.close()
    }
  })

  test('clones the docs repo outside the source workspace, and leaves neither behind', async () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('docs_publisher'), ...entriesFile([releaseEntry()]) }, 'docs_publisher-v1.0.0', DATE)

    const run = await runAction({ event: 'release', payload: releasePayload, workspace: source })

    expect(run.status).toBe(0)
    expect(existsSync(join(world.base, 'runner-temp', 'docs-publisher-docs'))).toBe(false)
    expect(existsSync(join(source, 'docs'))).toBe(false)
    expect(git(source, 'status', '--porcelain')).toBe('')
  })

  test('runs the build with no token in its environment, whatever name the job put it under', async () => {
    const dump = join(world.base, 'build-environment.txt')
    const source = makeSource(world)
    releaseCommit(
      source,
      {
        ...featureFiles('docs_publisher'),
        ...entriesFile([releaseEntry({ build: 'printenv > "$BUILD_ENVIRONMENT"' })]),
      },
      'docs_publisher-v1.0.0',
      DATE,
    )

    const run = await runAction({
      event: 'release',
      payload: releasePayload,
      workspace: source,
      env: { BUILD_ENVIRONMENT: dump, GITHUB_TOKEN: 'ambient-github-token', SOME_OTHER_NAME: 'docs-token' },
    })

    expect(run.status).toBe(0)
    const environment = readFileSync(dump, 'utf8')
    for (const secret of ['docs-token', 'github-token', 'ambient-github-token']) {
      expect(environment).not.toContain(secret)
    }
    expect(environment).not.toMatch(/^INPUT_/m)
  })
})

describe('the action with an entries file of its own', () => {
  test('reads the entries from the path the workflow names, relative to the workspace', async () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      {
        ...featureFiles('docs_publisher', '# Features\n'),
        [join('docs', 'publisher.yaml')]: entriesJson([releaseEntry()]),
      },
      'docs_publisher-v1.0.0',
      DATE,
    )

    const run = await runAction({
      event: 'release',
      payload: releasePayload,
      workspace: source,
      inputs: { 'INPUT_ENTRIES-FILE': 'docs/publisher.yaml' },
    })

    expect(run.status).toBe(0)
    expect(run.outputs).toMatchObject({ 'run-mode': 'release', 'docs-changed': 'true' })
    expect(exists(readRemote(world), `${ROOT}/features/docs_publisher/1.0.0/schema.json`)).toBe(true)
    expect(exists(source, join('.github', 'docs_publisher.yaml'))).toBe(false)
  })

  test('refuses an entries file a symlink inside the workspace points at outside it, before it clones the docs repo', async () => {
    const source = makeSource(world)
    const outside = join(world.base, 'outside.yaml')
    writeFileSync(outside, '- area: features\n')
    mkdirSync(join(source, '.github'), { recursive: true })
    symlinkSync(outside, join(source, ENTRIES_PATH))
    const before = remoteCommitCount(world)

    const run = await runAction({ event: 'release', payload: releasePayload, workspace: source })

    expect(run.status).toBe(1)
    expect(run.output).toContain(
      '::error::docs_publisher: entries-file must be a relative path inside the source checkout: ".github/docs_publisher.yaml"',
    )
    expect(existsSync(join(world.base, 'runner-temp', 'docs-publisher-docs'))).toBe(false)
    expect(remoteCommitCount(world)).toBe(before)
    expect(api.calls).toEqual([])
  })

  test('refuses an entries path that leaves the workspace, before it clones the docs repo', async () => {
    const source = makeSource(world)
    commitSource(source, entriesFile([]))
    const before = remoteCommitCount(world)

    const run = await runAction({
      event: 'release',
      payload: releasePayload,
      workspace: source,
      inputs: { 'INPUT_ENTRIES-FILE': '../publisher.yaml' },
    })

    expect(run.status).toBe(1)
    expect(run.output).toContain(
      '::error::docs_publisher: entries-file must be a relative path inside the source checkout: "../publisher.yaml"',
    )
    expect(remoteCommitCount(world)).toBe(before)
    expect(api.calls).toEqual([])
  })
})

describe('the action when it cannot start', () => {
  test('names a docs branch the docs repo does not have, as the publisher refuses it', async () => {
    const source = makeSource(world)
    commitSource(source, entriesFile([]))

    const run = await runAction({
      event: 'release',
      payload: releasePayload,
      workspace: source,
      inputs: { 'INPUT_DOCS-BRANCH': 'release' },
    })

    expect(run.status).toBe(1)
    expect(run.output).toContain('::error::docs_publisher: could not fetch the docs branch "release" from origin:')
    expect(run.summary).toContain('could not fetch the docs branch "release" from origin:')
  })
})

describe('the action on a push', () => {
  test('pushes nothing when the push changes no doc, and says so in its outputs', async () => {
    const source = makeSource(world)
    git(source, 'remote', 'add', 'origin', source)
    commitSource(source, entriesFile([]))
    const head = git(source, 'rev-parse', 'HEAD')
    const before = remoteCommitCount(world)

    const run = await runAction({ event: 'push', payload: { before: head, sha: head }, workspace: source })

    expect(run.status).toBe(0)
    expect(run.outputs).toEqual({ 'run-mode': 'push', 'docs-changed': 'false' })
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('reports the reconcile that a push with docs to prune escalates to', async () => {
    const source = makeSource(world)
    git(source, 'remote', 'add', 'origin', source)
    releaseCommit(source, { ...featureFiles('docs_publisher'), ...entriesFile([releaseEntry()]) }, 'docs_publisher-v1.0.0', DATE)
    seedDocs(world, {
      'site/raw/features/retired/1.0.0/.meta.json': meta({ source: REPOSITORY, tag: 'retired-v1.0.0', date: DATE }),
      'site/raw/features/retired/1.0.0/schema.json': 'retired',
    })
    const head = git(source, 'rev-parse', 'HEAD')
    const before = remoteCommitCount(world)

    const run = await runAction({ event: 'push', payload: { before: head, sha: head }, workspace: source })

    expect(run.status).toBe(0)
    // The push alone would report `push`; the prune makes it a reconcile, and the output says so.
    expect(run.outputs).toEqual({ 'run-mode': 'reconcile', 'docs-changed': 'true', 'docs-commit-sha': git(world.remote, 'rev-parse', 'main') })
    expect(remoteCommitCount(world)).toBe(before + 1)
    expect(exists(readRemote(world), 'site/raw/features/retired')).toBe(false)
    expect(run.summary).toContain('This push needs a prune, so it ran a reconcile.')
  })
})

describe('the action on a pull request', () => {
  function pullRequestWorld() {
    const source = makeSource(world)
    // A checkout the workflow made has an origin; a plan fetches tags from it.
    git(source, 'remote', 'add', 'origin', source)
    releaseCommit(source, { ...featureFiles('docs_publisher'), ...entriesFile([releaseEntry()]) }, 'docs_publisher-v1.0.0', DATE)
    const base = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'packages/docs_publisher/schema.json': '{"schema":true}\n' })
    const head = git(source, 'rev-parse', 'HEAD')
    return { source, base, head }
  }

  test('writes one comment with the plan, and pushes nothing', async () => {
    const { source, base, head } = pullRequestWorld()
    const before = remoteCommitCount(world)

    const run = await runAction({
      event: 'pull_request',
      payload: { pull_request: { number: 7, base: { sha: base }, head: { sha: head } } },
      workspace: source,
    })

    expect(run.status).toBe(0)
    expect(run.outputs).toEqual({ 'run-mode': 'plan', 'docs-changed': 'false' })
    expect(remoteCommitCount(world)).toBe(before)
    const posted = api.calls.filter((call) => call.method === 'POST' && call.url.includes('/issues/'))
    expect(posted).toHaveLength(1)
    expect(posted[0].url).toBe(`/repos/${REPOSITORY}/issues/7/comments`)
    expect(posted[0].body.body.startsWith('<!-- docs-publisher-plan -->')).toBe(true)
    expect(posted[0].body.body).toContain('Add version `docs_publisher/1.0.0`.')
  })

  test('replaces its earlier comment instead of adding a second one', async () => {
    const { source, base, head } = pullRequestWorld()
    api.comments.push({ id: 99, body: '<!-- docs-publisher-plan -->\nstale plan\n' })

    const run = await runAction({
      event: 'pull_request',
      payload: { pull_request: { number: 7, base: { sha: base }, head: { sha: head } } },
      workspace: source,
    })

    expect(run.status).toBe(0)
    expect(api.calls.filter((call) => call.method === 'POST' && call.url.includes('/issues/'))).toHaveLength(0)
    const patched = api.calls.filter((call) => call.method === 'PATCH')
    expect(patched).toHaveLength(1)
    expect(patched[0].url).toBe(`/repos/${REPOSITORY}/issues/comments/99`)
  })
})

describe('the action on an event it does not publish', () => {
  test('fails the job with the reason, before it clones anything', async () => {
    const source = makeSource(world)
    commitSource(source, entriesFile([]))
    const before = remoteCommitCount(world)

    const run = await runAction({ event: 'schedule', payload: {}, workspace: source })

    expect(run.status).toBe(1)
    expect(run.output).toContain('::error::docs_publisher: unsupported event: "schedule"')
    expect(run.summary).toContain('unsupported event: "schedule"')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('fails the job when an input the run needs is missing', async () => {
    const source = makeSource(world)
    commitSource(source, entriesFile([]))

    const run = await runAction({ event: 'workflow_dispatch', payload: {}, workspace: source, inputs: { 'INPUT_DOCS-TOKEN': '' } })

    expect(run.status).toBe(1)
    expect(run.output).toContain('Input required and not supplied: docs-token')
  })
})
