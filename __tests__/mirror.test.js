import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { chmodSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
  mirrorMeta,
  pushAttempts,
  readFile,
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

const CORE_DOCS = 'site/raw/core/docs'
const BACKSTAGE = 'site/raw/core/docs/backstage'
const DAMAGED_AREA = 'site/raw/r'
// A semver-named folder whose marker never validates as Version metadata: it has no `tag`.
const DAMAGED_MARKER = JSON.stringify({ source: 'acme/source', date: '2026-01-02T03:04:05Z' }, null, 2) + '\n'
const DATE = '2026-01-02T03:04:05Z'
const OWNERSHIP = 'Area "core/docs" belongs to other/producer, but this repo is acme/source. Choose another Area. If this repo was renamed or is taking over the Area, update "source" in that Area\'s .meta.json files in the docs repo.'

const CORE_FILES = {
  'docs/guide.md': '# Guide\n',
  'docs/images/logo.png': image('logo'),
  'docs/sub/deep.md': '# Deep\n',
  'README.md': '# Source\n',
}

let world

beforeEach(() => {
  world = makeDocsRemote()
})

afterEach(() => {
  world.cleanup()
})

function sourceWith(files = CORE_FILES, entries = [mirrorEntry()]) {
  const source = makeSource(world)
  commitSource(source, { ...files, ...entriesFile(entries) }, 'push to main')
  return source
}

const SEEDED_BACKSTAGE = {
  'site/raw/core/docs/backstage/.meta.json': meta({
    source: 'acme/backstage',
    sourceRevision: 'b'.repeat(40),
    sourceBranch: 'main',
    date: DATE,
  }),
  'site/raw/core/docs/backstage/index.md': '# Backstage\n',
}

describe('a push that publishes a mirror entry', () => {
  test('preserves existing mirror files owned by another source repo', () => {
    const metadata = meta({ source: 'other/producer', sourceRevision: 'a'.repeat(40), sourceBranch: 'main', date: DATE })
    seedDocs(world, {
      [`${CORE_DOCS}/.meta.json`]: metadata,
      [`${CORE_DOCS}/other.md`]: '# Other producer\n',
    })
    const source = sourceWith()
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(2)
    expect(run.output).toContain(OWNERSHIP)
    expect(run.output).not.toContain('and Area')
    expect(remoteCommitCount(world)).toBe(before)
    const landed = readRemote(world)
    expect(readFile(landed, `${CORE_DOCS}/other.md`)).toBe('# Other producer\n')
    expect(readFile(landed, `${CORE_DOCS}/.meta.json`)).toBe(metadata)
  })

  test('names the owning repository and the remedy, in the log and in the run summary', () => {
    const metadata = meta({ source: 'other/producer', sourceRevision: 'a'.repeat(40), sourceBranch: 'main', date: DATE })
    seedDocs(world, {
      [`${CORE_DOCS}/.meta.json`]: metadata,
      [`${CORE_DOCS}/other.md`]: '# Other producer\n',
    })
    const source = sourceWith()
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(2)
    expect(run.output).toContain(OWNERSHIP)
    expect(run.summary).toContain(OWNERSHIP)
    expect(remoteCommitCount(world)).toBe(before)
  })

  test.each([
    {
      area: 'core/docs', marker: `${CORE_DOCS}/.meta.json`,
      fields: { source: 'other/producer', sourceRevision: 'a'.repeat(40), sourceBranch: 'main', date: DATE },
      error: 'Choose another Area',
    },
    {
      area: 'core/crds/v1.0.0/reference', marker: 'site/raw/core/crds/v1.0.0/.meta.json',
      fields: { source: 'other/producer', tag: 'v1.0.0', date: DATE },
      error: 'inside a Version folder',
    },
  ])('rechecks mirror ownership after losing a push race in $area', async ({ area, marker, fields, error }) => {
    const source = sourceWith(CORE_FILES, [mirrorEntry({ area })])
    const docs = cloneDocs(world, 'waiting-mirror')
    write(docs, { '.git/hooks/pre-push': `#!/bin/sh\ntouch "${world.base}/owner-ready"\nwhile [ ! -f "${world.base}/owner-resume" ]; do sleep 0.01; done\n` })
    chmodSync(join(docs, '.git/hooks/pre-push'), 0o755)
    const pending = startPublisher(docs, { source })
    const before = remoteCommitCount(world)
    const metadata = meta(fields)
    const victim = `site/raw/${area}/other.md`
    try {
      await waitForFile(join(world.base, 'owner-ready'))
      seedDocs(world, {
        [marker]: metadata,
        [victim]: '# Other producer\n',
      })
    } finally {
      write(world.base, { 'owner-resume': '' })
    }
    const run = await pending

    expect(run.status).toBe(2)
    expect(run.output).toContain(error)
    expect(remoteCommitCount(world)).toBe(before + 1)
    const landed = readRemote(world)
    expect(readFile(landed, victim)).toBe('# Other producer\n')
    expect(readFile(landed, marker)).toBe(metadata)
  }, 15000)

  test('creates the Area with exactly the mirror metadata fields and the source commit timestamp', () => {
    const source = sourceWith()
    execFileSync('git', ['commit', '--amend', '--no-edit', '--date', '2025-12-01T00:00:00Z'], {
      cwd: source,
      env: { ...process.env, GIT_COMMITTER_DATE: '2026-01-02T05:04:05+02:00' },
    })
    const docs = cloneDocs(world)

    const run = runPublisher(docs, { source })

    expect(run.status).toBe(0)
    expect(readTree(readRemote(world), CORE_DOCS)).toEqual({
      'guide.md': '# Guide\n',
      'images/logo.png': image('logo'),
      'sub/deep.md': '# Deep\n',
      '.meta.json': meta({
        source: 'acme/source',
        sourceRevision: git(source, 'rev-parse', 'HEAD'),
        sourceBranch: 'main',
        date: DATE,
      }),
    })
  })

  test('deletes a file the source no longer collects', () => {
    const source = sourceWith()
    expect(runPublisher(cloneDocs(world, 'first'), { source }).status).toBe(0)

    commitSource(source, { 'docs/sub/deep.md': null }, 'remove a doc')
    const run = runPublisher(cloneDocs(world, 'second'), { source })

    expect(run.status).toBe(0)
    expect(exists(readRemote(world), `${CORE_DOCS}/sub/deep.md`)).toBe(false)
    expect(readFile(readRemote(world), `${CORE_DOCS}/guide.md`)).toBe('# Guide\n')
  })

  test('keeps a nested Area that has its own .meta.json, and replaces the rest', () => {
    seedDocs(world, { ...SEEDED_BACKSTAGE, 'site/raw/core/docs/stale.md': '# Stale\n' })
    const source = sourceWith()

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, `${BACKSTAGE}/index.md`)).toBe('# Backstage\n')
    expect(readFile(landed, `${BACKSTAGE}/.meta.json`)).toBe(
      SEEDED_BACKSTAGE[`${BACKSTAGE}/.meta.json`],
    )
    expect(exists(landed, `${CORE_DOCS}/stale.md`)).toBe(false)
    expect(readFile(landed, `${CORE_DOCS}/guide.md`)).toBe('# Guide\n')
  })

  test.each([
    ['core/backstage', false],
    ['core/docs/backstage', false],
    ['core/docs/backstage', true],
  ])('publishes sibling and nested mirrors (Area %s, parent exists: %s)', (area, parentExists) => {
    const source = sourceWith(
      { ...CORE_FILES, 'backstage/catalog.yaml': 'kind: Component\n' },
      [
        mirrorEntry(),
        mirrorEntry({
          area,
          collect: [{ from: 'backstage/*.yaml', to: '.' }],
          paths: ['backstage/*.yaml'],
        }),
      ],
    )
    const areaDir = `site/raw/${area}`
    seedDocs(world, {
      // The Area was published by this repo once; a stale file in it is the publisher's to remove.
      [`${areaDir}/.meta.json`]: meta({ source: 'acme/source', sourceRevision: 'a'.repeat(40), sourceBranch: 'main', date: DATE }),
      [`${areaDir}/stale.md`]: 'STALE\n',
      ...(parentExists ? { [`${CORE_DOCS}/.meta.json`]: mirrorMeta(source) } : {}),
    })
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(before + 1)
    const landed = readRemote(world)
    expect(readFile(landed, `${areaDir}/catalog.yaml`)).toBe('kind: Component\n')
    expect(exists(landed, `${areaDir}/stale.md`)).toBe(false)
    expect(readFile(landed, `${areaDir}/.meta.json`)).toBe(mirrorMeta(source))
    expect(readFile(landed, `${CORE_DOCS}/guide.md`)).toBe('# Guide\n')
    expect(readFile(landed, `${CORE_DOCS}/.meta.json`)).toBe(
      mirrorMeta(source),
    )
  })

  test('publishes a mirror nested in a mirror Area that another source repo owns', () => {
    const source = sourceWith(
      { 'backstage/catalog.yaml': 'kind: Component\n' },
      [mirrorEntry({
        area: 'core/docs/backstage',
        collect: [{ from: 'backstage/*.yaml', to: '.' }],
        paths: ['backstage/*.yaml'],
      })],
    )
    const parent = meta({ source: 'prefapp/other', sourceRevision: 'a'.repeat(40), sourceBranch: 'main', date: DATE })
    seedDocs(world, { [`${CORE_DOCS}/.meta.json`]: parent, [`${CORE_DOCS}/guide.md`]: '# Guide\n' })

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, `${BACKSTAGE}/catalog.yaml`)).toBe('kind: Component\n')
    expect(readFile(landed, `${CORE_DOCS}/.meta.json`)).toBe(parent)
    expect(readFile(landed, `${CORE_DOCS}/guide.md`)).toBe('# Guide\n')
  })

  test('refuses a Mirror Area inside a release Area the docs mark, and writes nothing', () => {
    const source = sourceWith()
    seedDocs(world, {
      'site/raw/core/v1.0.0/.meta.json': meta({ source: 'other/repo', tag: 'v1.0.0', date: DATE }),
      'site/raw/core/v1.0.0/index.yaml': 'v1\n',
      'site/raw/core/versions.json': '[]\n',
    })
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(2)
    expect(run.output).toContain(
      'refusing to publish site/raw/core/docs: it sits inside the release Area site/raw/core, and a Mirror Area cannot sit inside a release Area. Choose another Area.',
    )
    expect(remoteCommitCount(world)).toBe(before)
    expect(exists(readRemote(world), CORE_DOCS)).toBe(false)
  })

  test.each([false, true])('makes no commit for identical content (manual: %s)', (reconcile) => {
    const source = sourceWith()
    expect(runPublisher(cloneDocs(world, 'first'), { source }).status).toBe(0)
    const afterFirst = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world, 'second'), { source, reconcile })

    expect(run.status).toBe(0)
    expect(run.summary).toContain('Nothing to publish')
    expect(remoteCommitCount(world)).toBe(afterFirst)
  })

  test('retries a rejected push, as a release does', () => {
    const source = sourceWith()
    rejectPushes(world, 2)

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(0)
    expect(pushAttempts(world)).toBe(3)
    expect(exists(readRemote(world), `${CORE_DOCS}/.meta.json`)).toBe(true)
  })
  test('copies a mirrored Markdown file unchanged, so each image link reaches its collected file', () => {
    const source = sourceWith({
      'docs/guide.md':
        '![logo](images/logo.png)\n<img src="images/sub/arch.png">\n![gone](images/missing.png)\n',
      'docs/notes.txt': '(images/logo.png)\n',
      'docs/images/logo.png': image('logo'),
      'docs/images/sub/arch.png': image('arch'),
    })

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, `${CORE_DOCS}/guide.md`)).toBe(
      '![logo](images/logo.png)\n<img src="images/sub/arch.png">\n![gone](images/missing.png)\n',
    )
    expect(readFile(landed, `${CORE_DOCS}/notes.txt`)).toBe('(images/logo.png)\n')
    expect(readFile(landed, `${CORE_DOCS}/images/logo.png`)).toBe(image('logo'))
    expect(readFile(landed, `${CORE_DOCS}/images/sub/arch.png`)).toBe(image('arch'))
  })

  test.each([
    ['tools/1.0.0', 'tools', '1.0.0'],
    ['v1.0.0', undefined, 'v1.0.0'],
    ['foo#bar/1.0.0', 'foo#bar', '1.0.0'],
    ['v1.0.0', undefined, 'v1.0.0', 'core/crds/v1.0.0/reference'],
    ['tools/1.0.0', 'tools', '1.0.0', 'core/crds/tools/1.0.0/reference'],
    ['v1.0.0', undefined, 'v1.0.0', 'reference', 'firestartr-pro/firestartr', 'site/raw/core/crds/v1.0.0'],
  ])('refuses a mirror overlapping Version folder %s (name %s, version %s, mirror Area %s), and pushes nothing', (folder, name, version, area = 'core', owner = 'firestartr-pro/firestartr', root = 'site/raw') => {
    const versionDir = `site/raw/core/crds/${folder}`
    const metadata = meta({ source: owner, tag: name ? `tools-v${version}` : version, date: DATE })
    seedDocs(world, {
      [`${versionDir}/.meta.json`]: metadata,
      [`${versionDir}/README.md`]: '# Existing release\n',
      [`${versionDir}/reference/keep.md`]: 'FOREIGN\n',
    })
    const source = sourceWith(CORE_FILES, [mirrorEntry({ area })])
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, root })

    expect(run.status).toBe(2)
    expect(run.output).toContain(`${versionDir}/.meta.json`)
    expect(remoteCommitCount(world)).toBe(before)
    const landed = readRemote(world)
    expect(readFile(landed, `${versionDir}/README.md`)).toBe('# Existing release\n')
    expect(readFile(landed, `${versionDir}/reference/keep.md`)).toBe('FOREIGN\n')
    expect(readFile(landed, `${versionDir}/.meta.json`)).toBe(metadata)
  })

  test('refuses a mirror that collects onto a release Version folder .meta.json, and pushes nothing', () => {
    seedDocs(world, {
      'site/raw/core/docs/demo/1.0.0/.meta.json': meta({
        source: 'firestartr-pro/firestartr',
        tag: 'demo-v1.0.0',
        date: DATE,
      }),
      'site/raw/core/docs/demo/1.0.0/README.md': '# demo\n',
    })
    const source = sourceWith({ ...CORE_FILES, 'docs/demo/1.0.0/.meta.json': '{"doc": true}\n' })
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(2)
    expect(run.output).toContain('site/raw/core/docs/demo/1.0.0/.meta.json')
    expect(remoteCommitCount(world)).toBe(before)
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/core/docs/demo/1.0.0/README.md')).toBe('# demo\n')
    expect(JSON.parse(readFile(landed, 'site/raw/core/docs/demo/1.0.0/.meta.json')).source).toBe(
      'firestartr-pro/firestartr',
    )
  })

  test.each(['manual run', 'mirror publish'])('refuses a damaged Version marker in the Area on a %s, and pushes nothing', (kind) => {
    const source = sourceWith(CORE_FILES, [mirrorEntry({ area: 'r' })])
    seedDocs(world, {
      [`${DAMAGED_AREA}/p/1.0.0/.meta.json`]: DAMAGED_MARKER,
      [`${DAMAGED_AREA}/p/1.0.0/README.md`]: '# Existing release\n',
    })
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), kind === 'manual run' ? { source, reconcile: true } : { source })

    expect(run.status).toBe(2)
    expect(run.output).toContain(`docs_publisher: invalid .meta.json: ${DAMAGED_AREA}/p/1.0.0/.meta.json`)
    expect(remoteCommitCount(world)).toBe(before)
    const landed = readRemote(world)
    expect(readFile(landed, `${DAMAGED_AREA}/p/1.0.0/.meta.json`)).toBe(DAMAGED_MARKER)
    expect(readFile(landed, `${DAMAGED_AREA}/p/1.0.0/README.md`)).toBe('# Existing release\n')
  })

  test('publishes another Mirror Area while a damaged Version marker sits in an Area this push does not touch', () => {
    const source = sourceWith(CORE_FILES, [mirrorEntry()])
    seedDocs(world, {
      [`${DAMAGED_AREA}/.meta.json`]: meta({
        source: 'prefapp/other-repo', sourceRevision: 'c'.repeat(40), sourceBranch: 'main', date: DATE,
      }),
      [`${DAMAGED_AREA}/p/1.0.0/.meta.json`]: DAMAGED_MARKER,
      [`${DAMAGED_AREA}/p/1.0.0/README.md`]: '# Existing release\n',
    })
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'docs/guide.md': '# Updated\n' }, 'update the guide')
    const commits = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, before, after: git(source, 'rev-parse', 'HEAD') })

    expect(run.status).toBe(0)
    expect(remoteCommitCount(world)).toBe(commits + 1)
    const landed = readRemote(world)
    expect(readFile(landed, `${CORE_DOCS}/guide.md`)).toBe('# Updated\n')
    expect(readFile(landed, `${DAMAGED_AREA}/p/1.0.0/.meta.json`)).toBe(DAMAGED_MARKER)
    expect(readFile(landed, `${DAMAGED_AREA}/p/1.0.0/README.md`)).toBe('# Existing release\n')
  })

  test('refuses two mirror entries for one Area, and pushes nothing', () => {
    const source = sourceWith(CORE_FILES, [mirrorEntry(), mirrorEntry()])
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(2)
    expect(run.output).toContain('two mirror entries publish the Area "core/docs"')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test.each([
    ['meta.json', { source: 'generator', version: '1.0.0', date: 'today' }],
    ['draft/meta.json', { source: 'generator', version: 'draft', date: 'today' }],
  ])('republishes ordinary collected %s containing %j', (rel, fields) => {
    const metadata = meta(fields)
    const source = sourceWith({ ...CORE_FILES, [`docs/${rel}`]: metadata })
    expect(runPublisher(cloneDocs(world, 'first'), { source }).status).toBe(0)
    commitSource(source, { 'docs/guide.md': '# Updated\n' }, 'update guide')

    const run = runPublisher(cloneDocs(world, 'second'), { source })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, `${CORE_DOCS}/${rel}`)).toBe(metadata)
    expect(readFile(landed, `${CORE_DOCS}/guide.md`)).toBe('# Updated\n')
  })

  test.each([
    ['meta.json', { source: 'generator', version: 'draft', date: 'today' }],
    ['draft/meta.json', { source: 'generator', version: 'draft', date: 'today' }],
  ])('removes stale collected %s containing %j', (rel, fields) => {
    const metadata = meta(fields)
    const source = sourceWith({ ...CORE_FILES, [`docs/${rel}`]: metadata })
    expect(runPublisher(cloneDocs(world, 'first'), { source }).status).toBe(0)
    commitSource(source, { [`docs/${rel}`]: null }, 'remove ordinary metadata')
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world, 'second'), { source })

    expect(run.status).toBe(0)
    expect(exists(readRemote(world), `${CORE_DOCS}/${rel}`)).toBe(false)
    expect(remoteCommitCount(world)).toBe(before + 1)
  })

  test.each([
    ['meta.json', { area: 'core/docs' }],
    ['meta.json', { source: 'generator', area: 'guide', version: 'draft', date: 'today' }],
    ['meta.json', { source: 'generator', area: 'guide', version: '1.0.0', date: 'today' }],
    ['draft/meta.json', { source: 'generator', area: 'guide', version: 'draft', date: 'today' }],
    ['meta.json', { area: null }],
    ['meta.json', { area: '' }],
    ['meta.json', { area: false }],
    ['1.2.3/meta.json', { doc: true }],
    ['v1.2.3-rc.1/meta.json', { doc: true }],
  ])('accepts ordinary collected %s regardless of its JSON fields', (rel, metadata) => {
    const source = sourceWith({ ...CORE_FILES, [`docs/${rel}`]: meta(metadata) })
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(0)
    expect(readFile(readRemote(world), `${CORE_DOCS}/${rel}`)).toBe(meta(metadata))
    expect(remoteCommitCount(world)).toBe(before + 1)
  })

  test('from a sub-folder, ../images/ and images/ keep the targets they have in the source repo', () => {
    const source = sourceWith({
      'docs/images/logo.png': image('logo'),
      'docs/images/y.png': image('root y'),
      'docs/sub/a.md':
        '![x](../images/y.png) ![n](images/y.png) ![d](./images/logo.png) ![l](../images/logo.png)\n' +
        '![space](<../images/logo dark.png>) ![round](../images/logo(1).png) ![own](<images/logo dark.png>)\n',
      'docs/images/logo dark.png': image('space'),
      'docs/images/logo(1).png': image('round'),
      'docs/sub/images/y.png': image('sub y'),
      'docs/sub/images/logo dark.png': image('sub space'),
    })

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, `${CORE_DOCS}/sub/a.md`)).toBe(
      '![x](../images/y.png) ![n](images/y.png) ![d](./images/logo.png) ![l](../images/logo.png)\n' +
      '![space](<../images/logo dark.png>) ![round](../images/logo(1).png) ![own](<images/logo dark.png>)\n',
    )
    expect(readFile(landed, `${CORE_DOCS}/images/y.png`)).toBe(image('root y'))
    expect(readFile(landed, `${CORE_DOCS}/sub/images/y.png`)).toBe(image('sub y'))
  })

  test('from a sub-folder, a ../images/ inside code and in a real link both stay as written', () => {
    const source = sourceWith({
      'docs/images/y.png': image('root y'),
      'docs/sub/a.md':
        'Write `![x](../images/y.png)` to show it.\n\n' +
        '```md\n![f](../images/y.png)\n```\n\n' +
        '![x](../images/y.png)\n',
    })

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(0)
    expect(readFile(readRemote(world), `${CORE_DOCS}/sub/a.md`)).toBe(
      'Write `![x](../images/y.png)` to show it.\n\n' +
        '```md\n![f](../images/y.png)\n```\n\n' +
        '![x](../images/y.png)\n',
    )
  })

  test('a recursive glob never collects the source repository .git folder', () => {
    const collect = [{ from: '**', to: '.' }]
    const source = sourceWith(CORE_FILES, [mirrorEntry({ collect })])

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(0)
    expect(readTree(readRemote(world), CORE_DOCS)).toEqual({
      '.github/docs_publisher.yaml': readFile(source, '.github/docs_publisher.yaml'),
      '.meta.json': mirrorMeta(source),
      'README.md': '# Source\n',
      'docs/guide.md': '# Guide\n',
      'docs/images/logo.png': image('logo'),
      'docs/sub/deep.md': '# Deep\n',
    })
  })

  test('refuses a collect that names the .git folder, and pushes nothing', () => {
    const source = sourceWith(CORE_FILES, [mirrorEntry({ collect: [{ from: '.git/**', to: '.' }] })])
    const base = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(2)
    expect(run.output).toContain('entry 1 (area "core/docs"): collect from ".git/**" uses ".git", the Git administrative folder')
    expect(remoteCommitCount(world)).toBe(base)
  })

  test('a recursive glob collects a filename that contains a newline', () => {
    const source = sourceWith({ ...CORE_FILES, 'docs/a\nb.md': '# Newline\n' })

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(0)
    expect(readFile(readRemote(world), `${CORE_DOCS}/a\nb.md`)).toBe('# Newline\n')
  })

  test('a collect that matches no files still publishes, as an Area holding only .meta.json', () => {
    const source = sourceWith(CORE_FILES, [mirrorEntry({ collect: [{ from: 'nothing/**', to: '.' }] })])

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(0)
    expect(readTree(readRemote(world), CORE_DOCS)).toEqual({
      '.meta.json': mirrorMeta(source),
    })
  })
})

describe('which entries a run publishes', () => {
  test('a release tag publishes no mirror, and a push publishes no release', () => {
    const source = makeSource(world)
    releaseCommit(
      source,
      {
        ...featureFiles('docs_publisher'),
        ...CORE_FILES,
        ...entriesFile([releaseEntry(), mirrorEntry()]),
      },
      'docs_publisher-v1.0.0',
      DATE,
    )

    const release = runPublisher(cloneDocs(world, 'release'), { source, tag: 'docs_publisher-v1.0.0' })
    expect(release.status).toBe(0)
    const afterRelease = readRemote(world)
    expect(exists(afterRelease, 'site/raw/features/docs_publisher/1.0.0/.meta.json')).toBe(true)
    expect(exists(afterRelease, CORE_DOCS)).toBe(false)

    const push = runPublisher(cloneDocs(world, 'push'), { source })
    expect(push.status).toBe(0)
    const afterPush = readRemote(world)
    expect(exists(afterPush, `${CORE_DOCS}/.meta.json`)).toBe(true)
    expect(exists(afterPush, 'site/raw/features/docs_publisher/1.0.0/.meta.json')).toBe(true)
  })
})

describe('a mirror that cannot be published safely', () => {
  test.each([undefined, null, '', 42, [], {}])('refuses malformed sourceBranch %j and names the metadata file', (sourceBranch) => {
    const source = sourceWith()
    seedDocs(world, {
      [`${CORE_DOCS}/.meta.json`]: meta({
        source: 'acme/source', sourceRevision: git(source, 'rev-parse', 'HEAD'), sourceBranch, date: DATE,
      }),
      [`${CORE_DOCS}/guide.md`]: '# Published\n',
    })
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(2)
    expect(run.output).toContain(`docs_publisher: invalid .meta.json: ${CORE_DOCS}/.meta.json`)
    expect(remoteCommitCount(world)).toBe(before)
    expect(readFile(readRemote(world), `${CORE_DOCS}/guide.md`)).toBe('# Published\n')
  })

  test.each([
    undefined, null, '', 42, 'not-a-date', '2026-01-02',
    '2026-01-02T03:04:05.000Z', '2026-01-02T05:04:05+02:00', '2026-02-30T03:04:05Z',
  ])('refuses malformed date %j and names the metadata file', (date) => {
    const source = sourceWith()
    seedDocs(world, {
      [`${CORE_DOCS}/.meta.json`]: meta({
        source: 'acme/source', sourceRevision: git(source, 'rev-parse', 'HEAD'), sourceBranch: 'main', date,
      }),
      [`${CORE_DOCS}/guide.md`]: '# Published\n',
    })
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(2)
    expect(run.output).toContain(`docs_publisher: invalid .meta.json: ${CORE_DOCS}/.meta.json`)
    expect(remoteCommitCount(world)).toBe(before)
    expect(readFile(readRemote(world), `${CORE_DOCS}/guide.md`)).toBe('# Published\n')
  })

  test('refuses two rules that publish a file and a folder at one path, and pushes nothing', () => {
    const source = sourceWith(CORE_FILES, [mirrorEntry({ collect: [
      { from: 'README.md', to: 'x' },
      { from: 'docs/guide.md', to: 'x/y' },
    ] })])
    const base = remoteCommitCount(world)
    const docs = cloneDocs(world)

    const run = runPublisher(docs, { source })

    expect(run.status).toBe(2)
    expect(run.output).toContain(
      'Area "core/docs": collect "README.md" to "x" writes the file x, but collect "docs/guide.md" to "x/y" writes x/y inside it',
    )
    expect(remoteCommitCount(world)).toBe(base)
    expect(readTree(docs)).toEqual({})
  })

  test('refuses a collect that writes into a nested Area, and pushes nothing', () => {
    seedDocs(world, SEEDED_BACKSTAGE)
    const source = sourceWith({ ...CORE_FILES, 'docs/backstage/x.md': '# X\n' })
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(2)
    expect(run.output).toContain('core/docs/backstage')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('refuses a symlinked .meta.json in the Area instead of reading it, and pushes nothing', () => {
    const seed = cloneDocs(world, 'seed-meta-link')
    write(world.base, { 'outside/meta.json': '{"doc": true}\n' })
    mkdirSync(join(seed, CORE_DOCS), { recursive: true })
    symlinkSync(join(world.base, 'outside/meta.json'), join(seed, CORE_DOCS, '.meta.json'))
    git(seed, 'add', '-A')
    git(seed, 'commit', '--no-verify', '-m', 'legacy link')
    git(seed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
    const source = sourceWith()
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(2)
    expect(run.output).toContain(`refusing to write through symlink: ${CORE_DOCS}/.meta.json`)
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('preserves published pages when a recursive glob would traverse a directory symlink', () => {
    const source = sourceWith({ 'docs/reference/guide.md': '# Published\n' }, [mirrorEntry({
      collect: [{ from: 'docs/**/*.md', to: '.' }],
    })])
    expect(runPublisher(cloneDocs(world, 'initial-pages'), { source }).status).toBe(0)
    const before = remoteCommitCount(world)
    rmSync(join(source, 'docs/reference'), { recursive: true })
    write(source, { 'pages/guide.md': '# Linked\n' })
    symlinkSync('../pages', join(source, 'docs/reference'))
    commitSource(source, {}, 'replace a collected directory with a link')

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(2)
    expect(run.output).toContain('refusing to publish symlink: docs/reference')
    expect(remoteCommitCount(world)).toBe(before)
    expect(readFile(readRemote(world), `${CORE_DOCS}/reference/guide.md`)).toBe('# Published\n')
  })

  test('leaves a nonmatching directory symlink outside the glob traversal alone', () => {
    const source = sourceWith({ 'docs/package/reference/guide.md': '# Guide\n' }, [mirrorEntry({
      collect: [{ from: 'docs/*/reference/**/*.md', to: '.' }],
    })])
    symlinkSync('reference', join(source, 'docs/package/unrelated'))
    commitSource(source, {}, 'a link outside the collect traversal')

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(0)
    expect(readFile(readRemote(world), `${CORE_DOCS}/package/reference/guide.md`)).toBe('# Guide\n')
  })

  test('refuses a collected symlink, and pushes nothing', () => {
    const source = sourceWith()
    symlinkSync('guide.md', join(source, 'docs/link.md'))
    git(source, 'add', '-A')
    git(source, 'commit', '--no-verify', '-m', 'add a symlink')
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(2)
    expect(run.output).toContain('refusing to publish symlink: docs/link.md')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test.each([
    { from: 'missing/../linked/leak.md', to: 'leak.md' },
    { from: 'linked/leak.md', to: 'leak.md' },
    { from: 'linked/**', to: '.' },
  ])('refuses collect from $from through a symlinked folder, and pushes nothing', (rule) => {
    const source = sourceWith(CORE_FILES, [mirrorEntry({ collect: [rule] })])
    write(world.base, { 'outside/leak.md': 'OUTSIDE SOURCE\n' })
    symlinkSync(join(world.base, 'outside'), join(source, 'linked'))
    git(source, 'add', '-A')
    git(source, 'commit', '--no-verify', '-m', 'a symlinked folder')
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source })

    expect(run.status).toBe(2)
    expect(run.output).toContain(`refusing to publish symlink: ${rule.from}`)
    expect(remoteCommitCount(world)).toBe(before)
  })
})

describe('matching the push against paths', () => {
  function pushSource(beforeFiles, afterFiles, entries = [mirrorEntry()]) {
    const source = makeSource(world)
    commitSource(source, { ...beforeFiles, ...entriesFile(entries) }, 'before')
    const before = git(source, 'rev-parse', 'HEAD')
    seedDocs(world, Object.fromEntries(entries.map((entry) => [
      `site/raw/${entry.area}/.meta.json`,
      mirrorMeta(source),
    ])))
    commitSource(source, afterFiles, 'after')
    const after = git(source, 'rev-parse', 'HEAD')
    return { source, before, after }
  }

  test('uses collect sources as default watch paths on a push', () => {
    const { source, before, after } = pushSource(
      { 'docs/index.md': '# v1\n' },
      { 'docs/index.md': '# v2\n' },
      [mirrorEntry({ paths: undefined })],
    )
    const run = runPublisher(cloneDocs(world), { source, before, after })
    expect(run.status).toBe(0)
    expect(readFile(readRemote(world), `${CORE_DOCS}/index.md`)).toBe('# v2\n')
  })

  test('skips the entry before its build when no changed file matches its paths', () => {
    const entry = mirrorEntry({ build: 'exit 7', collect: [{ from: 'docs/**', to: '.' }] })
    const { source, before, after } = pushSource(
      { 'docs/index.md': '# Core\n', 'README.md': '# v1\n' },
      { 'README.md': '# v2\n' },
      [entry],
    )
    const commits = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, before, after })

    expect(run.status).toBe(0)
    expect(run.summary).toContain('Skipped mirror `core/docs`')
    expect(run.summary).toContain('No mirror entry matches this push.')
    expect(remoteCommitCount(world)).toBe(commits)
  })

  test.each(['ancestor', 'newer', 'unrelated'])('republishes unchanged paths after a branch switch when the published revision is %s', (relation) => {
    const source = sourceWith({ 'docs/index.md': '# Same docs\n' })
    const base = git(source, 'rev-parse', 'HEAD')
    if (relation !== 'ancestor') commitSource(source, { 'README.md': '# Main\n' }, 'advance main')
    expect(runPublisher(cloneDocs(world, 'main-docs'), { source }).status).toBe(0)
    const commits = remoteCommitCount(world)
    git(source, 'checkout', '-b', 'develop', base)
    if (relation !== 'newer') commitSource(source, { 'README.md': '# Develop\n' }, 'develop only changes README')
    const after = git(source, 'rev-parse', 'HEAD')

    const run = runPublisher(cloneDocs(world, 'develop-docs'), {
      source, sourceBranch: 'develop', before: base, after,
    })

    expect(run.status).toBe(0)
    expect(run.output).not.toContain('Skipped mirror')
    expect(remoteCommitCount(world)).toBe(commits + 1)
    const landed = readRemote(world)
    expect(readFile(landed, `${CORE_DOCS}/index.md`)).toBe('# Same docs\n')
    expect(JSON.parse(readFile(landed, `${CORE_DOCS}/.meta.json`))).toMatchObject({
      sourceBranch: 'develop', sourceRevision: after,
    })
  })

  test('publishes docs from a replaced pending push when the surviving push only changes README', () => {
    const source = sourceWith({ 'docs/index.md': '# v1\n' })
    expect(runPublisher(cloneDocs(world, 'first'), { source }).status).toBe(0)
    commitSource(source, { 'docs/index.md': '# v2\n' }, 'queued docs push')
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'README.md': '# unrelated\n' }, 'surviving push')
    const after = git(source, 'rev-parse', 'HEAD')

    const run = runPublisher(cloneDocs(world, 'survivor'), { source, before, after })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, `${CORE_DOCS}/index.md`)).toBe('# v2\n')
    expect(JSON.parse(readFile(landed, `${CORE_DOCS}/.meta.json`)).sourceRevision).toBe(after)
  })

  test('removes a mirrored file moved outside its paths', () => {
    const source = sourceWith({ 'docs/guide.md': '# Guide\n' })
    expect(runPublisher(cloneDocs(world, 'first'), { source }).status).toBe(0)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'docs/guide.md': null, 'archive/guide.md': '# Guide\n' }, 'move the guide')
    const after = git(source, 'rev-parse', 'HEAD')

    const run = runPublisher(cloneDocs(world, 'second'), { source, before, after })

    expect(run.status).toBe(0)
    expect(exists(readRemote(world), `${CORE_DOCS}/guide.md`)).toBe(false)
  })

  test.each(['docs/**', './docs/**'])('publishes a non-ASCII filename after the first publication with %s watch paths', (pattern) => {
    const source = sourceWith({ 'docs/guía.md': '# v1\n' }, [mirrorEntry({
      paths: [pattern],
      collect: [{ from: pattern, to: '.' }],
    })])
    expect(runPublisher(cloneDocs(world, 'first'), { source }).status).toBe(0)
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'docs/guía.md': '# v2\n' }, 'update the guide')
    const after = git(source, 'rev-parse', 'HEAD')

    const run = runPublisher(cloneDocs(world, 'second'), { source, before, after })

    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readFile(landed, `${CORE_DOCS}/guía.md`)).toBe('# v2\n')
    expect(JSON.parse(readFile(landed, `${CORE_DOCS}/.meta.json`)).sourceRevision).toBe(after)
  })

  test('publishes the entries the push touches and skips the rest', () => {
    const backstage = mirrorEntry({
      area: 'core/docs/backstage',
      collect: [{ from: 'backstage/**', to: '.' }],
      paths: ['backstage/**'],
    })
    const { source, before, after } = pushSource(
      { 'docs/index.md': '# Core\n', 'backstage/index.md': '# Backstage\n' },
      { 'docs/index.md': '# Core v2\n' },
      [mirrorEntry(), backstage],
    )

    const run = runPublisher(cloneDocs(world), { source, before, after })

    expect(run.status).toBe(0)
    expect(run.summary).toContain('Skipped mirror `core/docs/backstage`')
    expect(readFile(readRemote(world), `${CORE_DOCS}/index.md`)).toBe('# Core v2\n')
  })

  test.each(['0'.repeat(40), 'f'.repeat(40)])('reconciles every mirror when event before is unknown: %s', (before) => {
    const { source, after } = pushSource({ 'docs/index.md': '# v1\n' }, { 'README.md': '# v2\n' })
    const commits = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, before, after })

    expect(run.status).toBe(0)
    expect(run.summary).toContain('Mirrored core/docs to `main`.')
    expect(run.summary).not.toContain('Skipped mirror')
    expect(remoteCommitCount(world)).toBe(commits + 1)
    const landed = readRemote(world)
    expect(readFile(landed, `${CORE_DOCS}/index.md`)).toBe('# v1\n')
    expect(JSON.parse(readFile(landed, `${CORE_DOCS}/.meta.json`)).sourceRevision).toBe(after)
  })

  test('runs every mirror when the push adds an entry to the entries file', () => {
    const backstage = mirrorEntry({
      area: 'core/backstage',
      collect: [{ from: 'backstage/**', to: '.' }],
      paths: ['backstage/**'],
    })
    const source = makeSource(world)
    commitSource(
      source,
      {
        'docs/index.md': '# Core\n',
        'backstage/index.md': '# Backstage\n',
        ...entriesFile([mirrorEntry()]),
      },
      'before',
    )
    const before = git(source, 'rev-parse', 'HEAD')
    commitSource(source, { 'README.md': '# v2\n', ...entriesFile([mirrorEntry(), backstage]) }, 'after')
    const after = git(source, 'rev-parse', 'HEAD')

    const run = runPublisher(cloneDocs(world), { source, before, after })

    expect(run.status).toBe(0)
    expect(readFile(readRemote(world), `${CORE_DOCS}/index.md`)).toBe('# Core\n')
    expect(readFile(readRemote(world), 'site/raw/core/backstage/index.md')).toBe('# Backstage\n')
  })
})

describe('a manual run', () => {
  test.each(['build', 'push'])('publishes its checkout over a newer push overlapping the manual mirror %s', async (phase) => {
    const ready = join(world.base, 'manual-ready')
    const resume = join(world.base, 'manual-resume')
    const gate = `touch "${ready}"; while [ ! -f "${resume}" ]; do sleep 0.01; done`
    const source = sourceWith({ 'docs/index.md': '# old\n' }, [mirrorEntry(
      phase === 'build' ? { build: `if [ -f .hold ]; then ${gate}; fi` } : {},
    )])
    const manualSource = cloneSource(world, source, 'manual-source')
    const docs = cloneDocs(world, 'manual-docs')
    if (phase === 'build') {
      write(manualSource, { '.hold': '' })
    } else {
      write(docs, { '.git/hooks/pre-push': `#!/bin/sh\n${gate}\n` })
      chmodSync(join(docs, '.git/hooks/pre-push'), 0o755)
    }
    const pending = startPublisher(docs, { source: manualSource, reconcile: true })
    let push
    try {
      await waitForFile(ready)
      const before = git(source, 'rev-parse', 'HEAD')
      commitSource(source, { 'docs/index.md': '# new\n' }, 'winning push')
      push = runPublisher(cloneDocs(world, 'push-docs'), { source, before, after: git(source, 'rev-parse', 'HEAD') })
    } finally {
      write(world.base, { 'manual-resume': '' })
    }
    const manual = await pending

    expect(push.status).toBe(0)
    expect(manual.status).toBe(0)
    expect(manual.output).not.toContain('Skipped mirror')
    const landed = readRemote(world)
    expect(readFile(landed, `${CORE_DOCS}/index.md`)).toBe('# old\n')
    expect(JSON.parse(readFile(landed, `${CORE_DOCS}/.meta.json`)).sourceRevision).toBe(git(manualSource, 'rev-parse', 'HEAD'))
  }, 15000)

  test('republishes every mirror entry and restores a damaged Area', () => {
    const source = sourceWith()
    seedDocs(world, {
      'site/raw/core/docs/.meta.json': mirrorMeta(source),
      'site/raw/core/docs/guide.md': '# Edited by hand\n',
    })

    const run = runPublisher(cloneDocs(world), { source, reconcile: true })

    expect(run.status).toBe(0)
    expect(run.summary).toContain('Mirrored core/docs')
    expect(readTree(readRemote(world), CORE_DOCS)).toEqual({
      'guide.md': '# Guide\n',
      'images/logo.png': image('logo'),
      'sub/deep.md': '# Deep\n',
      '.meta.json': mirrorMeta(source),
    })
  })
})
