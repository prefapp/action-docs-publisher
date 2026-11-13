import { afterAll } from '@jest/globals'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import renderer from '@firestartr/firestartr-features_renderer'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const CLAIM_PATH = resolve(PACKAGE_DIR, '..', '..', 'generic-fixtures', 'cr.yaml')

export function renderInto(target, args) {
  const claim = yaml.load(readFileSync(CLAIM_PATH, 'utf8'))
  renderer.render(PACKAGE_DIR, target, claim, {}, args)
  return target
}

export function renderTestArgs(name = 'release-shared-default-destination') {
  const { tests } = yaml.load(readFileSync(join(PACKAGE_DIR, 'render_tests.yaml'), 'utf8'))
  return tests.find((test) => test.name === name).args
}

const rendered = renderInto(realpathSync(mkdtempSync(join(tmpdir(), 'docs-publisher-rendered-'))), renderTestArgs())
afterAll(() => rmSync(rendered, { recursive: true, force: true }))

export function renderedScript(name) {
  return join(rendered, '.github/scripts/docs-publisher', name)
}

export const SCRIPT = renderedScript('main.mjs')
export const ROOT = 'site/raw'
export const BRANCH = 'main'
export const ENTRIES_PATH = '.github/docs_publisher.yaml'
export const SOURCE_REPO = 'acme/source'

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function configureIdentity(dir) {
  git(dir, 'config', 'user.name', 'docs-publisher-test')
  git(dir, 'config', 'user.email', 'docs-publisher-test@example.com')
}

export function makeDocsRemote() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'docs-publisher-')))
  const remote = join(base, 'remote.git')
  const seed = join(base, 'seed')

  git(base, 'init', '--bare', '--initial-branch=main', remote)
  git(base, 'init', '--initial-branch=main', seed)
  configureIdentity(seed)
  write(seed, { 'README.md': '# docs\n' })
  git(seed, 'add', '-A')
  git(seed, 'commit', '-m', 'seed')
  git(seed, 'push', remote, 'main')

  return {
    base,
    remote,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

export function cloneDocs(world, name = 'docs') {
  const dir = join(world.base, name)
  git(world.base, 'clone', world.remote, dir)
  configureIdentity(dir)
  return dir
}

export function readRemote(world) {
  const dir = join(world.base, `read-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  git(world.base, 'clone', '--quiet', '--branch', 'main', world.remote, dir)
  return dir
}

export function remoteCommitCount(world) {
  return Number(git(world.remote, 'rev-list', '--count', 'main'))
}

export function makeSource(world, name = 'source') {
  const dir = join(world.base, name)
  git(world.base, 'init', '--initial-branch=main', dir)
  configureIdentity(dir)
  return dir
}

export function cloneSource(world, sourceDir, name) {
  const dir = join(world.base, name)
  git(world.base, 'clone', '--quiet', sourceDir, dir)
  return dir
}

export function commitSource(source, files, message = 'release') {
  write(source, files)
  git(source, 'add', '-A')
  git(source, 'commit', '--no-verify', '-m', message)
}

export function tagRelease(source, tag, date) {
  execFileSync('git', ['tag', '-a', tag, '-m', tag], {
    cwd: source,
    env: { ...process.env, GIT_COMMITTER_DATE: date },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export function releaseEntry(overrides = {}) {
  return {
    area: 'features',
    mode: 'release',
    packages: 'packages',
    mainFile: 'schema.json',
    collect: [
      { from: 'templates/docs/*.md', to: '.' },
      { from: 'templates/docs/images/*', to: 'images' },
      { from: 'CHANGELOG.md', to: 'CHANGELOG.md' },
      { from: 'schema.json', to: 'schema.json' },
    ],
    areaFiles: [{ from: 'README.md', to: 'README.md' }],
    ...overrides,
  }
}

export function unnamedReleaseEntry(overrides = {}) {
  return {
    area: 'core/crds',
    mode: 'release',
    mainFile: 'index.yaml',
    collect: [{ from: 'index.yaml', to: 'index.yaml' }],
    ...overrides,
  }
}

export function mirrorEntry(overrides = {}) {
  return {
    area: 'core/docs',
    mode: 'mirror',
    collect: [{ from: 'docs/**', to: '.' }],
    paths: ['docs/**'],
    ...overrides,
  }
}

export function seedDocs(world, files, message = 'legacy docs') {
  const dir = cloneDocs(world, `seed-${Math.random().toString(36).slice(2)}`)
  write(dir, files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '--no-verify', '-m', message)
  git(dir, 'push', 'origin', 'main')
}

export function entriesJson(entries) {
  return `${JSON.stringify(entries, null, 2)}\n`
}

export function entriesFile(entries) {
  return { [ENTRIES_PATH]: entriesJson(entries) }
}

export function packageFiles(name, intro = `# ${name}\n`) {
  return {
    [`packages/${name}/templates/docs/intro.md`]: intro,
    [`packages/${name}/templates/docs/images/logo.png`]: image(`${name}-logo`),
    [`packages/${name}/CHANGELOG.md`]: '# Changelog\n',
    [`packages/${name}/schema.json`]: '{}\n',
  }
}

export function featureFiles(name, readme = '# Features\n') {
  return {
    'README.md': readme,
    ...packageFiles(name),
    [`packages/${name}/templates/docs/sub/deep.md`]: '# Deep\n',
  }
}

export function releaseCommit(source, files, tag, date) {
  commitSource(source, files, `release ${tag}`)
  tagRelease(source, tag, date)
}

export function write(dir, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const target = join(dir, relPath)
    if (content === null) {
      rmSync(target, { recursive: true, force: true })
      continue
    }
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
}

export function meta(fields) {
  return JSON.stringify(fields, null, 2) + '\n'
}

export function mirrorMeta(source) {
  const sourceRevision = git(source, 'rev-parse', 'HEAD')
  const timestamp = git(source, 'show', '-s', '--format=%cI', sourceRevision)
  return meta({
    source: SOURCE_REPO,
    sourceRevision,
    sourceBranch: 'main',
    date: new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  })
}

// A Branch Version marker names the release Area the folder was published into, as the entry's `area` spells it.
export function branchMeta(source, area, branch = 'main') {
  const sourceRevision = git(source, 'rev-parse', 'HEAD')
  const timestamp = git(source, 'show', '-s', '--format=%cI', sourceRevision)
  return meta({
    source: SOURCE_REPO,
    area,
    branch,
    sourceRevision,
    date: new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  })
}

export function image(name) {
  return `image-bytes:${name}`
}

export function rejectPushes(world, count) {
  const hook = join(world.remote, 'hooks', 'pre-receive')
  const counter = join(world.base, 'pushes')
  writeFileSync(
    hook,
    [
      '#!/bin/sh',
      `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
      'n=$((n + 1))',
      `echo "$n" > "${counter}"`,
      `if [ "$n" -le ${count} ]; then`,
      '  echo "simulated race: main moved" >&2',
      '  exit 1',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  )
  chmodSync(hook, 0o755)
}

export function pushAttempts(world) {
  const counter = join(world.base, 'pushes')
  return existsSync(counter) ? Number(readFileSync(counter, 'utf8').trim()) : 0
}

function publisherArgs(docs, options) {
  const { script = SCRIPT, source, tag, reconcile, plan, planFile, before, after } = options
  let { entries, root, branch } = options
  if (entries === undefined) entries = join(source, ENTRIES_PATH)
  if (root === undefined) root = ROOT
  if (branch === undefined) branch = BRANCH
  return [
    script,
    '--source',
    source,
    '--docs',
    docs,
    ...(entries === null ? [] : ['--entries', entries]),
    ...(root === null ? [] : ['--root', root]),
    ...(branch === null ? [] : ['--branch', branch]),
    ...(options.sourceBranch === null ? [] : ['--source-branch', options.sourceBranch ?? 'main']),
    ...(options.docsRepository === null ? [] : ['--docs-repository', options.docsRepository ?? 'firestartr-pro/docs']),
    ...(tag === undefined ? [] : ['--tag', tag]),
    ...(reconcile ? ['--reconcile'] : []),
    ...(plan ? ['--plan'] : []),
    ...(planFile === undefined ? [] : ['--plan-file', planFile]),
    ...(before === undefined ? [] : ['--before', before]),
    ...(after === undefined ? [] : ['--after', after]),
  ]
}

function publisherEnv(summaryPath, repository) {
  return {
    ...process.env,
    GITHUB_REPOSITORY: repository ?? SOURCE_REPO,
    GITHUB_STEP_SUMMARY: summaryPath,
    DOCS_PUBLISHER_BACKOFF_STEP_MS: '250',
  }
}

export function runPublisher(docs, options) {
  const summaryPath = join(docs, '..', `run-summary-${Math.random().toString(36).slice(2)}.md`)
  const result = spawnSync('node', publisherArgs(docs, options), {
    cwd: docs,
    encoding: 'utf8',
    env: { ...publisherEnv(summaryPath, options.repository), ...options.env },
  })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    summary: existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '',
  }
}

export function runReconcile(world, source, docs = cloneDocs(world, `docs-${Math.random()}`)) {
  const checkout = cloneSource(world, source, `checkout-${Math.random()}`)
  return runPublisher(docs, { source: checkout, reconcile: true })
}

export async function waitForFile(file) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (existsSync(file)) return
    await setTimeout(10)
  }
  throw new Error(`timed out waiting for ${file}`)
}

export function startPublisher(docs, options) {
  const summaryPath = join(docs, '..', `run-summary-${Math.random().toString(36).slice(2)}.md`)
  const child = spawn('node', publisherArgs(docs, options), {
    cwd: docs,
    env: publisherEnv(summaryPath, options.repository),
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  return new Promise((resolve) => {
    child.on('close', (status) => resolve({
      status,
      output,
      summary: existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '',
    }))
  })
}

export function readTree(dir, root = ROOT) {
  const tree = {}
  const start = join(dir, root)
  if (!existsSync(start)) return tree

  const walk = (abs, prefix) => {
    for (const name of readdirSync(abs).sort()) {
      const child = join(abs, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (statSync(child).isDirectory()) walk(child, rel)
      else tree[rel] = readFileSync(child, 'utf8')
    }
  }
  walk(start, '')
  return tree
}

export function readJson(dir, relPath) {
  return JSON.parse(readFileSync(join(dir, relPath), 'utf8'))
}

export function readFile(dir, relPath) {
  return readFileSync(join(dir, relPath), 'utf8')
}

export function exists(dir, relPath) {
  return existsSync(join(dir, relPath))
}
