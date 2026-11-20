import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ENTRIES_PATH, cloneDocs, cloneSource, commitSource, entriesFile, entriesJson, featureFiles, git, makeDocsRemote, makeSource, readFile, readJson, readRemote, releaseCommit, releaseEntry, renderedScript, runPublisher, seedDocs, meta, mirrorEntry, mirrorMeta } from '../test/harness.mjs'

const { specHash } = await import(pathToFileURL(renderedScript('entries.mjs')).href)

let world
beforeEach(() => { world = makeDocsRemote() })
afterEach(() => { world.cleanup() })
const DATE = '2026-01-02T03:04:05Z'
const MARKER = '<!-- docs-publisher-plan -->'
const IRRELEVANT = '<!-- docs-publisher-plan-irrelevant -->'

function bytes(dir) {
  const tree = {}
  const walk = (rel) => {
    const absolute = join(dir, rel)
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) tree[rel] = { link: readlinkSync(absolute) }
    else if (stat.isDirectory()) for (const child of readdirSync(absolute)) walk(join(rel, child))
    else tree[rel] = readFileSync(absolute).toString('base64')
  }
  walk('.')
  return tree
}

function plan(source, before, extra = {}) {
  const { prepare, entries, ...options } = extra
  const checkout = cloneSource(world, source, `source-${Math.random()}`)
  const head = git(checkout, 'rev-parse', 'HEAD')
  git(checkout, 'checkout', '--quiet', '--detach', head)
  const docs = cloneDocs(world, `docs-${Math.random()}`)
  const original = bytes(docs)
  const docsHead = git(docs, 'rev-parse', 'HEAD')
  const remoteHead = git(world.remote, 'rev-parse', 'main')
  const remoteOriginal = bytes(world.remote)
  const planFile = join(world.base, `plan-${Math.random()}.md`)
  const snapshots = join(world.base, `snapshots-${Math.random()}`)
  mkdirSync(snapshots)
  prepare?.(checkout)
  const run = runPublisher(docs, {
    source: checkout, plan: true, planFile, before, after: head,
    ...options, ...(entries === undefined ? {} : { entries: isAbsolute(entries) ? entries : join(checkout, entries) }),
    env: { RUNNER_TEMP: snapshots, ...options.env },
  })
  expect(readdirSync(snapshots)).toEqual([])
  expect(git(docs, 'rev-parse', 'HEAD')).toBe(docsHead)
  expect(git(world.remote, 'rev-parse', 'main')).toBe(remoteHead)
  expect(bytes(world.remote)).toEqual(remoteOriginal)
  expect(bytes(docs)).toEqual(original)
  expect(git(docs, 'status', '--porcelain')).toBe('')
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head)
  const body = existsSync(planFile) ? readFileSync(planFile, 'utf8') : null
  if (body !== null) expect(body.startsWith(MARKER)).toBe(true)
  return { ...run, body }
}

describe('pull request plans', () => {
  test('keeps symlinks verbatim in the snapshot so existing guards still report them', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([]) }, 'alpha-v1.0.0', DATE)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([releaseEntry()]))
    seedDocs(world, {
      'site/raw/features/alpha/1.0.0/.meta.json': meta({ source: 'acme/source', tag: 'alpha-v1.0.0', date: DATE }),
      'site/raw/features/alpha/1.0.0/schema.json': '{}',
    })
    const seed = cloneDocs(world, 'symlink-seed')
    symlinkSync('schema.json', join(seed, 'site/raw/features/alpha/1.0.0/link.json'))
    git(seed, 'add', '-A')
    git(seed, 'commit', '-m', 'symlink guard fixture')
    git(seed, 'push', 'origin', 'main')
    const run = plan(source, before)
    expect(run.status).toBe(0)
    expect(run.body).toContain('This change would fail to publish:')
    expect(run.body).toContain('refusing to publish symlink: site/raw/features/alpha/1.0.0/link.json')
    expect(run.body + run.summary).not.toContain(world.base)
  })

  test('reports a foreign Mirror Area inside a release Area the plan would replace', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([]) }, 'alpha-v1.0.0', DATE)
    const before = git(source, 'rev-parse', 'HEAD')
    const marker = mirrorMeta(source)
    commitSource(source, entriesFile([releaseEntry()]))
    seedDocs(world, {
      'site/raw/features/.meta.json': marker,
      'site/raw/features/old.md': 'old',
      'site/raw/features/notes/.meta.json': marker.replace('acme/source', 'other/repo'),
      'site/raw/features/notes/index.md': 'nested foreign docs',
    })
    const run = plan(source, before)
    expect(run.status).toBe(0)
    expect(run.body).toContain('- Replace Area: its entry is now in release mode.')
    expect(run.body).toContain('- Add version `alpha/1.0.0`.')
    expect(run.body).toContain(
      '- refusing to publish site/raw/features: it holds the Mirror Area site/raw/features/notes, and a Mirror Area cannot sit inside a release Area. Choose another Area.',
    )
    expect(run.body).not.toContain('### `features/notes`')
  })

  test('lists the Branch Version folder its entry would publish', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([]) }, 'alpha-v1.0.0', DATE)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([releaseEntry({ publishSourceBranch: true })]))

    const run = plan(source, before)

    expect(run.status).toBe(0)
    expect(run.body).toContain('- Add version `alpha/1.0.0`.')
    expect(run.body).toContain('- Add Branch Version folder `alpha/main`.')
  })

  test('reports an invalid entry as a planning problem with exit zero', () => {
    const source = makeSource(world)
    commitSource(source, entriesFile([]))
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([{ ...releaseEntry(), unexpected: true }]))
    const run = plan(source, before)
    expect(run.status).toBe(0)
    expect(run.body).toContain('This change would fail to publish:')
    expect(run.body).toContain('unknown key "unexpected"')
  })

  test('names a missing entries file without leaking its absolute path', () => {
    const source = makeSource(world)
    commitSource(source, entriesFile([]))
    const before = git(source, 'rev-parse', 'HEAD')
    const run = plan(source, before, { entries: join(world.base, 'missing-entries.json') })
    expect(run.status).toBe(0)
    expect(run.body).toContain('This change would fail to publish:\n- entries file not found: ../missing-entries.json')
    expect(run.body).not.toContain(world.base)
  })

  test('reports an entries file that is not valid YAML as a planning problem with exit zero', () => {
    const source = makeSource(world)
    commitSource(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) })
    const before = git(source, 'rev-parse', 'HEAD')
    // A broken entries file is always a planning problem, whether or not its own change is what shows up here: the
    // plan reads it before it decides anything.
    commitSource(source, { [ENTRIES_PATH]: '- area: alpha\n  mode: [release\n' })
    const run = plan(source, before)
    expect(run.status).toBe(0)
    expect(run.body).toContain('This change would fail to publish:\n- entries: not valid YAML:')
    expect(run.body).not.toContain(world.base)
  })

  test('plans when only a custom entries file changed', () => {
    const entriesPath = '.config/publisher.yaml'
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([], entriesPath) }, 'alpha-v1.0.0', DATE)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([releaseEntry()], entriesPath), 'custom entries file')

    const run = plan(source, before, { entries: entriesPath })

    expect(run.status).toBe(0)
    expect(run.body).toContain('- Add version `alpha/1.0.0`.')
    expect(run.summary).not.toContain('Skipped plan')
  })

  test('plans when only the target of a symlinked entries file changed', () => {
    const source = makeSource(world)
    // The entries file is a link to the repo's own publisher.yaml, so git records its edits as `publisher.yaml`.
    mkdirSync(join(source, '.github'), { recursive: true })
    symlinkSync('../publisher.yaml', join(source, ENTRIES_PATH))
    releaseCommit(source, { ...featureFiles('alpha'), 'publisher.yaml': '[]\n' }, 'alpha-v1.0.0', DATE)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'publisher.yaml': entriesJson([releaseEntry()]) }, 'entries through the link')

    const run = plan(source, before, { entries: ENTRIES_PATH })

    expect(run.status).toBe(0)
    expect(run.body).toContain('- Add version `alpha/1.0.0`.')
    expect(run.summary).not.toContain('Skipped plan')
  })

  test('still fails on unexpected filesystem errors instead of claiming a valid plan', () => {
    const source = makeSource(world)
    commitSource(source, entriesFile([]))
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([releaseEntry()]))
    const run = plan(source, before, { env: { RUNNER_TEMP: join(world.base, 'missing-temp-parent') } })
    expect(run.status).toBe(2)
    expect(run.output).toContain('ENOENT')
    expect(run.body).toBeNull()
  })
  test.each([
    [{ tag: 'alpha-v1.0.0' }, '--plan runs without --tag or --reconcile'],
    [{ reconcile: true }, '--plan runs without --tag or --reconcile'],
    [{ before: undefined }, 'missing --before for --plan'],
    [{ after: undefined }, 'missing --after for --plan'],
    [{ planFile: undefined }, 'missing --plan-file for --plan'],
  ])('rejects invalid plan options %j before planning', (options, message) => {
    const source = makeSource(world)
    commitSource(source, { ...featureFiles('alpha'), ...entriesFile([]) })
    const before = git(source, 'rev-parse', 'HEAD')
    const run = plan(source, before, options)
    expect(run.status).toBe(2)
    expect(run.output).toContain(message)
    expect(run.body).toBeNull()
  })
  test('says nothing changes when the full reconcile would keep every version', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
    expect(runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' }).status).toBe(0)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'packages/alpha/schema.json': '{"head":true}' })
    const run = plan(source, before)
    expect(run.status).toBe(0)
    expect(run.body).toBe(`${MARKER}\n## Docs publisher plan\n\nMirror content changes are not listed; mirror builds do not run in plan mode.\n\nNo changes to add, republish, delete or replace.\n`)
  })

  test('writes an irrelevant-plan notice for unrelated files, even when the base branch diverged', () => {
    const source = makeSource(world)
    commitSource(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) })
    git(source, 'branch', 'pr')
    commitSource(source, { 'packages/alpha/base-only.md': '# base branch only' })
    const before = git(source, 'rev-parse', 'HEAD')
    git(source, 'checkout', '--quiet', 'pr')
    commitSource(source, { 'README.md': '# unrelated PR change' })
    const run = plan(source, before)
    expect(run.status).toBe(0)
    expect(run.body).toBe(`${MARKER}\n${IRRELEVANT}\n## Docs publisher plan\n\nThis pull request no longer changes docs publishing.\n`)
    expect(run.summary).toContain('Skipped plan: no changed entries file or release package folder.')
  })

  test.each(['.', './'])('plans package-only changes when packages is the repo root %s', (packages) => {
    const source = makeSource(world)
    const entry = releaseEntry({ packages, collect: [{ from: 'schema.json', to: 'schema.json' }] })
    releaseCommit(source, { 'README.md': '# Packages\n', 'alpha/schema.json': '{}\n', ...entriesFile([entry]) }, 'alpha-v1.0.0', DATE)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'alpha/schema.json': '{"head":true}\n' })
    expect(git(source, 'diff', '--name-only', before, 'HEAD')).toBe('alpha/schema.json')

    const run = plan(source, before)

    expect(run.status).toBe(0)
    expect(run.body).toContain('- Add version `alpha/1.0.0`.')
    expect(run.body).not.toContain('would fail to publish')
    expect(run.summary).not.toContain('Skipped plan:')
  })

  test('lists the Area file a new areaFiles rule would copy into a published Area', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
    expect(runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' }).status).toBe(0)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, {
      'REHEARSAL-PLAN.md': '# Rehearsal plan\n',
      ...entriesFile([releaseEntry({ areaFiles: [{ from: 'README.md', to: 'README.md' }, { from: 'REHEARSAL-PLAN.md', to: 'REHEARSAL-PLAN.md' }] })]),
    })

    const run = plan(source, before)

    expect(run.status).toBe(0)
    expect(run.body).toContain('### `features`\n- Add Area file `REHEARSAL-PLAN.md`.')
    expect(run.body).not.toContain('No changes to add, republish, delete or replace.')
    expect(run.body).not.toContain('would fail to publish')
  })

  test('lists a named Area areaFile named latest as an Area file, not a generated one', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
    expect(runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' }).status).toBe(0)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { ...entriesFile([releaseEntry({ areaFiles: [{ from: 'README.md', to: 'latest' }] })]) })

    const run = plan(source, before)

    expect(run.status).toBe(0)
    expect(run.body).toContain('- Add Area file `latest`.')
    expect(run.body).toContain('- Delete Area file `README.md`.')
    expect(run.body).not.toContain('shared file `latest`')
  })

  test('lists no shared file for a plan that only publishes a Version', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
    expect(runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' }).status).toBe(0)
    const before = git(source, 'rev-parse', 'HEAD')
    releaseCommit(source, { ...featureFiles('alpha'), 'packages/alpha/templates/docs/intro.md': '# alpha 1.1\n', ...entriesFile([releaseEntry()]) }, 'alpha-v1.1.0', DATE)

    const run = plan(source, before)

    expect(run.status).toBe(0)
    expect(run.body).toContain('- Add version `alpha/1.1.0`.')
    expect(run.body).not.toContain('shared file')
    expect(run.body).not.toContain('Area file')
  })

  test('lists a stale shared file when nothing else in the Area changes', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
    expect(runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' }).status).toBe(0)
    seedDocs(world, { 'site/raw/features/index.json': '{"hand":"edited"}\n' })
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'packages/alpha/schema.json': '{"head":true}' })

    const run = plan(source, before)

    expect(run.status).toBe(0)
    expect(run.body).toContain('### `features`\n- Replace shared file `index.json`.')
    expect(run.body).not.toContain('No changes to add, republish, delete or replace.')
  })

  test('lists a stale file in the Latest copy that the rebuild deletes and does not write back', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
    expect(runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' }).status).toBe(0)
    seedDocs(world, { 'site/raw/features/alpha/images/obsolete.png': 'stale\n' })
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'packages/alpha/schema.json': '{"head":true}' })

    const run = plan(source, before)

    expect(run.status).toBe(0)
    expect(run.body).toContain('### `features`\n- Delete shared file `alpha/images/obsolete.png`.')
    expect(run.body).not.toContain('logo.png')
    expect(run.body).not.toContain('No changes to add, republish, delete or replace.')
  })

  test('plans the Area files a changed entry would replace and delete', () => {
    const source = makeSource(world)
    releaseCommit(source, {
      ...featureFiles('alpha'),
      'NOTES.md': '# Notes\n',
      ...entriesFile([releaseEntry({ areaFiles: [{ from: 'README.md', to: 'README.md' }, { from: 'NOTES.md', to: 'NOTES.md' }] })]),
    }, 'alpha-v1.0.0', DATE)
    expect(runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.0' }).status).toBe(0)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, {
      'NOTES.md': '# Notes\n',
      ...entriesFile([releaseEntry({ areaFiles: [{ from: 'NOTES.md', to: 'NOTES.md' }] })]),
    })

    const run = plan(source, before)

    expect(run.status).toBe(0)
    expect(run.body).toContain('- Delete Area file `README.md`.')
    expect(run.body).not.toContain('shared file')
    expect(run.body).not.toContain('would fail to publish')
  })

  test('plans package changes from the merge base when the base is not an ancestor of the PR head', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
    git(source, 'branch', 'pr')
    commitSource(source, { 'README.md': '# base branch only' })
    const before = git(source, 'rev-parse', 'HEAD')
    git(source, 'checkout', '--quiet', 'pr')
    commitSource(source, { 'packages/alpha/schema.json': '{"pr":true}' })
    const run = plan(source, before)
    expect(run.status).toBe(0)
    expect(run.body).toContain('- Add version `alpha/1.0.0`.')
  })
  test('plans Mirror Area additions and mirror-to-release replacement without running mirror builds or listing mirror content', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([]), 'docs/index.md': '# docs' }, 'alpha-v1.0.0', DATE)
    const before = git(source, 'rev-parse', 'HEAD')
    const marker = mirrorMeta(source)
    commitSource(source, entriesFile([
      releaseEntry(),
      mirrorEntry({ area: 'new-mirror', build: 'exit 1' }),
      mirrorEntry({ area: 'existing-mirror', build: 'exit 1' }),
    ]))
    seedDocs(world, {
      'site/raw/features/.meta.json': marker,
      'site/raw/features/index.md': 'old mirror',
      'site/raw/existing-mirror/.meta.json': marker,
      'site/raw/existing-mirror/index.md': 'old content',
    })
    const run = plan(source, before)
    expect(run.status).toBe(0)
    expect(run.body).toContain('- Replace Area: its entry is now in release mode.')
    expect(run.body).toContain('- Add version `alpha/1.0.0`.')
    expect(run.body).toContain('### `new-mirror`\n- Add Mirror Area.')
    expect(run.body).not.toContain('### `existing-mirror`')
    expect(run.body).not.toContain('would fail to publish')
    expect(run.body).toContain('Mirror content changes are not listed; mirror builds do not run in plan mode.')
  })

  test('lists no deletion for the mirror files only its build writes', () => {
    const source = makeSource(world)
    // The build writes docs/generated/schema.json, and no glob matches it before the build runs.
    const build = "mkdir -p docs/generated && printf '{}' > docs/generated/schema.json"
    commitSource(source, { 'docs/index.md': '# Docs\n', ...entriesFile([]) })
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([mirrorEntry({ build })]))
    seedDocs(world, {
      'site/raw/core/docs/index.md': '# Docs\n',
      'site/raw/core/docs/generated/schema.json': '{}',
    })

    const run = plan(source, before)

    expect(run.status).toBe(0)
    expect(run.body).not.toContain('would fail to publish')
    expect(run.body).toContain('Mirror content changes are not listed; mirror builds do not run in plan mode.')
    // The run rewrites every file of the folder, so it does not refuse the folder the plan called unmarked either.
    const reconcile = runPublisher(cloneDocs(world, 'build-mirror-docs'), {
      source: cloneSource(world, source, 'build-mirror-source'), reconcile: true,
    })
    expect(reconcile.status).toBe(0)
    expect(readFile(readRemote(world), 'site/raw/core/docs/generated/schema.json')).toBe('{}')
  })

  test('reports a release Area nested in a Mirror Area as a configuration error without running the mirror build', () => {
    const source = makeSource(world)
    commitSource(source, { ...featureFiles('alpha'), ...entriesFile([]), 'docs/index.md': '# docs' })
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([
      mirrorEntry({ area: 'guide', build: 'exit 1' }),
      releaseEntry({ area: 'guide/releases' }),
    ]))
    const run = plan(source, before)
    expect(run.status).toBe(0)
    expect(run.body).toContain('This change would fail to publish:')
    expect(run.body).toContain('entry 2 (area "guide/releases"): release Area "guide/releases" sits inside Area "guide" of entry 1')
    expect(run.body).not.toContain('build failed')
  })

  test('says nothing changes when every candidate version is skipped and the Area has no Area file', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([]), 'packages/alpha/schema.json': null }, 'alpha-v0.1.0', DATE)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([releaseEntry({ areaFiles: [] })]))
    const run = plan(source, before)
    expect(run.status).toBe(0)
    expect(run.body).toContain('- Skipped `alpha-v0.1.0`: its content does not fit the entry (not found: schema.json).')
    expect(run.body).toContain('No changes to add, republish, delete or replace.')
  })

  test('plans the Area file the merge would add even when every candidate version is skipped', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([]), 'packages/alpha/schema.json': null }, 'alpha-v0.1.0', DATE)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([releaseEntry()]))
    const run = plan(source, before)
    expect(run.status).toBe(0)
    expect(run.body).toContain('- Skipped `alpha-v0.1.0`: its content does not fit the entry (not found: schema.json).')
    expect(run.body).toContain('- Add Area file `README.md`.')
    expect(run.body).not.toContain('No changes to add, republish, delete or replace.')
  })

  test('lists an unfit old tag as skipped with the reconcile reason', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([]), 'packages/alpha/schema.json': null }, 'alpha-v0.1.0', DATE)
    const before = git(source, 'rev-parse', 'HEAD')
    releaseCommit(source, { 'packages/alpha/schema.json': '{}', ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
    const run = plan(source, before)
    expect(run.status).toBe(0)
    expect(run.body).toContain('- Add version `alpha/1.0.0`.')
    expect(run.body).toContain('- Skipped `alpha-v0.1.0`: its content does not fit the entry (')
    expect(run.body).toContain('schema.json')
  })
  test.each([false, true])('reports an invalid-date Version folder as a publish failure, not a removed Mirror (tag exists: %s)', (tagged) => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, tagged ? 'alpha-v0.9.0' : 'alpha-v1.0.0', DATE)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'packages/alpha/schema.json': '{"head":true}\n' })
    seedDocs(world, {
      'site/raw/features/alpha/0.9.0/.meta.json': meta({ source: 'acme/source', tag: 'alpha-v0.9.0', date: 'invalid' }),
      'site/raw/features/alpha/0.9.0/schema.json': 'preserve invalid version\n',
    })

    const run = plan(source, before)

    expect(run.status).toBe(0)
    expect(run.body).toContain('This change would fail to publish:\n- invalid .meta.json: site/raw/features/alpha/0.9.0/.meta.json')
    expect(run.body).not.toContain('Delete Area')
  })

  test('reports every release guard problem without failing the PR or leaking temporary paths', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([]) }, 'alpha-v1.0.0', DATE)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([releaseEntry(), releaseEntry({ area: 'more' })]))
    seedDocs(world, {
      'site/raw/features/alpha/1.0.0/schema.json': 'unmigrated',
      'site/raw/features/broken/1.0.0/.meta.json': '{',
      'site/raw/features/foreign/1.0.0/.meta.json': meta({ source: 'other/repo', tag: 'foreign-v1.0.0', date: DATE }),
      'site/raw/features/foreign/1.0.0/schema.json': '{}',
      'site/raw/features/deleted/versions.json': '[]',
      'site/raw/more/alpha/1.0.0/schema.json': 'also unmigrated',
    })
    const run = plan(source, before)
    expect(run.status).toBe(0)
    expect(run.body).toContain('This change would fail to publish:')
    expect(run.body).toContain('Version folder site/raw/features/alpha/1.0.0 has no .meta.json')
    expect(run.body).toContain('Version folder site/raw/more/alpha/1.0.0 has no .meta.json')
    expect(run.body).toContain('invalid .meta.json: site/raw/features/broken/1.0.0/.meta.json')
    expect(run.body).toContain('Area "features" belongs to other/repo, but this repo is acme/source. Choose another Area.')
    expect(run.body).toContain('half-deleted package: site/raw/features/deleted')
    expect(run.body + run.summary).not.toContain(world.base)
    expect(run.body + run.summary).not.toMatch(/docs-publisher-plan-[A-Za-z0-9]/)
  })
  test('groups retired packages, deleted Areas, mode replacements and missing-tag warnings by Area', () => {
    const source = makeSource(world)
    commitSource(source, { ...featureFiles('alpha'), ...featureFiles('gone'), ...entriesFile([]), 'docs/index.md': '# docs' })
    const before = git(source, 'rev-parse', 'HEAD')
    const mirror = mirrorMeta(source)
    commitSource(source, { 'packages/gone': null, ...entriesFile([releaseEntry(), mirrorEntry({ area: 'changed' })]) })
    const version = (tag) => meta({ source: 'acme/source', tag, date: DATE })
    seedDocs(world, {
      'site/raw/features/gone/1.0.0/.meta.json': version('gone-v1.0.0'),
      'site/raw/features/gone/1.0.0/schema.json': '{}',
      'site/raw/retired/old/2.0.0/.meta.json': version('old-v2.0.0'),
      'site/raw/retired/old/2.0.0/schema.json': '{}',
      'site/raw/changed/alpha/1.0.0/.meta.json': version('alpha-v1.0.0'),
      'site/raw/changed/alpha/1.0.0/schema.json': '{}',
      'site/raw/removed-mirror/.meta.json': mirror,
      'site/raw/removed-mirror/index.md': '# removed',
    })
    const run = plan(source, before)
    expect(run.status).toBe(0)
    expect(run.body).toContain('### `features`\n- Delete version `gone/1.0.0`')
    expect(run.body).toContain('### `retired`\n- Delete Area: its entry is gone from docs_publisher.yaml.')
    expect(run.body).toContain('### `changed`\n- Replace Area: its entry is now in mirror mode.')
    expect(run.body).toContain('### `removed-mirror`\n- Delete Area: its entry is gone from docs_publisher.yaml.')
    expect(run.body).toContain('Warning: deleting version `gone/1.0.0`: no tag exists to rebuild it from.')
    expect(run.body).not.toContain('Add Mirror Area')
    expect(run.body).not.toContain('would fail to publish')
  })
  test('lists a drifted version for republishing with the current spec', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'packages/alpha/schema.json': '{"new": true}\n' })
    seedDocs(world, {
      'site/raw/features/alpha/1.0.0/.meta.json': meta({ source: 'acme/source', tag: 'alpha-v1.0.0', date: DATE, specHash: '0'.repeat(64) }),
      'site/raw/features/alpha/1.0.0/schema.json': 'old',
    })
    const run = plan(source, before)
    expect(run.status).toBe(0)
    expect(run.body).toContain('- Republish version `alpha/1.0.0`: specHash changed.')
    expect(run.body).not.toContain('would fail to publish')
  })
  test('lists a version whose tag moved for republishing without writing to the docs repo', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
    expect(runPublisher(cloneDocs(world, 'docs-seed'), { source, tag: 'alpha-v1.0.0' }).status).toBe(0)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'packages/alpha/templates/docs/intro.md': '# RETAGGED\n' })
    git(source, 'tag', '-f', 'alpha-v1.0.0')

    const run = plan(source, before)

    expect(run.status).toBe(0)
    expect(run.body).toContain('- Republish version `alpha/1.0.0`: its tag points at a different commit.')
    expect(run.body).not.toContain('specHash changed')
  })

  test('does not report a legacy marker gaining its tag commit as a change to publish', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry()]) }, 'alpha-v1.0.0', DATE)
    expect(runPublisher(cloneDocs(world, 'docs-seed'), { source, tag: 'alpha-v1.0.0' }).status).toBe(0)
    // A Version folder from before the publisher recorded the tag's commit.
    const marker = 'site/raw/features/alpha/1.0.0/.meta.json'
    const { sourceRevision, ...legacy } = readJson(readRemote(world), marker)
    expect(sourceRevision).toMatch(/^[a-f0-9]{40}$/)
    seedDocs(world, { [marker]: meta(legacy) })
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'packages/alpha/templates/docs/sub/deep.md': '# Deep v2\n' })

    const run = plan(source, before)

    expect(run.status).toBe(0)
    expect(run.body).not.toContain('Republish')
    expect(run.body).not.toContain('.meta.json')
    expect(run.body).toContain('No changes to add, republish, delete or replace.')
  })

  test('lists a missing version from a tag without changing the docs checkout or remote', () => {
    const source = makeSource(world)
    commitSource(source, { ...featureFiles('alpha'), ...entriesFile([]) })
    const before = git(source, 'rev-parse', 'HEAD')
    releaseCommit(source, entriesFile([releaseEntry()]), 'alpha-v1.0.0', DATE)
    const run = plan(source, before)
    expect(run.status).toBe(0)
    expect(run.body).toContain('### `features`')
    expect(run.body).toContain('- Add version `alpha/1.0.0`.')
    expect(run.body).not.toContain('would fail to publish')
  })
})

describe('a plan over an unmarked Mirror Area folder', () => {
  test.each(['site/raw', '.'])('agrees with the reconcile that overwrites it (root %s)', (root) => {
    const at = (rel) => (root === '.' ? rel : `${root}/${rel}`)
    seedDocs(world, { [at('core/docs/index.md')]: '# Hand made\n' })
    const source = makeSource(world)
    commitSource(source, { 'docs/index.md': '# Docs\n', ...entriesFile([]) })
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([mirrorEntry()]))

    const planned = plan(source, before, { root })

    expect(planned.status).toBe(0)
    expect(planned.body).not.toContain('would fail to publish')

    const suffix = Math.random().toString(36).slice(2)
    const run = runPublisher(cloneDocs(world, `docs-mirror-${suffix}`), {
      source: cloneSource(world, source, `checkout-mirror-${suffix}`), root, reconcile: true,
    })
    expect(run.status).toBe(0)
    expect(readFile(readRemote(world), at('core/docs/index.md'))).toBe('# Docs\n')
  })

  test.each(['site/raw', '.'])('reports the file the reconcile then refuses to delete (root %s)', (root) => {
    const at = (rel) => (root === '.' ? rel : `${root}/${rel}`)
    seedDocs(world, { [at('core/docs/hand-made/notes.md')]: '# Notes\n' })
    const source = makeSource(world)
    commitSource(source, { 'docs/index.md': '# Docs\n', ...entriesFile([]) })
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, entriesFile([mirrorEntry()]))

    const planned = plan(source, before, { root })

    expect(planned.status).toBe(0)
    expect(planned.body).toContain('This change would fail to publish:')
    expect(planned.body).toContain(`refusing to publish \`${at('core/docs')}\``)
    expect(planned.body).toContain(at('core/docs/hand-made/notes.md'))

    const suffix = Math.random().toString(36).slice(2)
    const run = runPublisher(cloneDocs(world, `docs-mirror-${suffix}`), {
      source: cloneSource(world, source, `checkout-mirror-${suffix}`), root, reconcile: true,
    })
    expect(run.status).toBe(2)
    expect(run.output).toContain(`refusing to publish \`${at('core/docs')}\``)
    expect(readFile(readRemote(world), at('core/docs/hand-made/notes.md'))).toBe('# Notes\n')
  })
})
