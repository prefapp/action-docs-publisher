import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { chmodSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { cloneDocs, cloneSource, commitSource, entriesFile, exists, featureFiles, git, makeDocsRemote, makeSource, packageFiles, readFile, readJson, readRemote, readTree, releaseCommit, releaseEntry, remoteCommitCount, runPublisher, startPublisher, waitForFile, write } from '../test/harness.mjs'

const TAG = 'alpha-v1.0.0'
const DATE = '2026-01-02T03:04:05Z'
let world
beforeEach(() => { world = makeDocsRemote() })
afterEach(() => { world.cleanup() })
function sourceWith(entry = releaseEntry(), tag = TAG, files = {}) {
  const source = makeSource(world)
  releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([entry]), ...files }, tag, DATE)
  return source
}

describe('release selection and collection', () => {
  test.each([false, true])('publishes prereleases only when enabled: %s', (prereleases) => {
    const source = sourceWith(releaseEntry({ prereleases }), 'alpha-v1.1.0-rc.1')
    const before = remoteCommitCount(world)
    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.1.0-rc.1' })
    expect(run.status).toBe(0)
    expect(exists(readRemote(world), 'site/raw/features/alpha/1.1.0-rc.1/.meta.json')).toBe(prereleases)
    expect(remoteCommitCount(world)).toBe(before + Number(prereleases))
  })

  test.each(['alpha-v1', 'unrelated'])('skips non-release tag %s', (tag) => {
    const source = sourceWith(releaseEntry(), tag)
    const before = remoteCommitCount(world)
    const run = runPublisher(cloneDocs(world), { source, tag })
    expect(run.status).toBe(0)
    expect(run.summary).toContain('not a `<name>-v<semver>` or `v<semver>` release tag')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('skips tags with no matching package folder', () => {
    const source = sourceWith(releaseEntry(), 'ghost-v1.0.0')
    const before = remoteCommitCount(world)
    const run = runPublisher(cloneDocs(world), { source, tag: 'ghost-v1.0.0' })
    expect(run.status).toBe(0)
    expect(run.summary).toContain('Skipped `ghost-v1.0.0` for area `features`: no `packages/ghost` folder at the tag.')
    expect(run.summary).not.toContain('no release entry publishes it')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('says that no entry publishes a tag only when no entry could', () => {
    const source = sourceWith(releaseEntry(), 'v1.0.0')
    const before = remoteCommitCount(world)
    const run = runPublisher(cloneDocs(world), { source, tag: 'v1.0.0' })
    expect(run.status).toBe(0)
    expect(run.summary).toContain('Skipped `v1.0.0`: no release entry publishes it.')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('keeps a published Version byte for byte when its tag moves, and commits nothing', () => {
    const source = sourceWith()
    expect(runPublisher(cloneDocs(world, 'docs-first'), { source, tag: TAG }).status).toBe(0)
    commitSource(source, { 'packages/alpha/templates/docs/intro.md': '# RETAGGED\n' }, 'move the tag')
    git(source, 'tag', '--force', TAG)
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world, 'docs-second'), { source, tag: TAG })

    expect(run.status).toBe(0)
    expect(run.summary).toContain(
      `Already published \`${TAG}\` in area \`features\`: kept \`site/raw/features/alpha/1.0.0\` as it is.`,
    )
    expect(remoteCommitCount(world)).toBe(before)
    expect(readFile(readRemote(world), 'site/raw/features/alpha/1.0.0/intro.md')).toBe('# alpha\n')
  })

  test('does not rewrite a Version another clone published, even from a stale clone', () => {
    const source = sourceWith()
    const stale = cloneDocs(world, 'docs-stale')
    expect(runPublisher(cloneDocs(world, 'docs-first'), { source, tag: TAG }).status).toBe(0)
    commitSource(source, { 'packages/alpha/templates/docs/intro.md': '# RETAGGED\n' }, 'move the tag')
    git(source, 'tag', '--force', TAG)
    const before = remoteCommitCount(world)

    const run = runPublisher(stale, { source, tag: TAG })

    expect(run.status).toBe(0)
    expect(run.summary).toContain(
      `Already published \`${TAG}\` in area \`features\`: kept \`site/raw/features/alpha/1.0.0\` as it is.`,
    )
    expect(remoteCommitCount(world)).toBe(before)
    expect(readFile(readRemote(world), 'site/raw/features/alpha/1.0.0/intro.md')).toBe('# alpha\n')
    expect(git(stale, 'status', '--porcelain')).toBe('')
  })

  test('keeps a Version that appears between push attempts, without rewriting it', async () => {
    const source = sourceWith()
    const staleSource = cloneSource(world, source, 'source-stale')
    commitSource(source, { 'packages/alpha/templates/docs/intro.md': '# RETAGGED\n' }, 'move the tag')
    git(source, 'tag', '--force', TAG)

    const docs = cloneDocs(world, 'docs-race')
    const ready = join(world.base, 'publish-ready')
    const resume = join(world.base, 'publish-resume')
    write(docs, { '.git/hooks/pre-push': `#!/bin/sh\ntouch "${ready}"\nwhile [ ! -f "${resume}" ]; do sleep 0.01; done\n` })
    chmodSync(join(docs, '.git/hooks/pre-push'), 0o755)
    const before = remoteCommitCount(world)
    const pending = startPublisher(docs, { source, tag: TAG })
    let winner
    try {
      await waitForFile(ready)
      winner = runPublisher(cloneDocs(world, 'docs-winner'), { source: staleSource, tag: TAG })
    } finally {
      write(world.base, { 'publish-resume': '' })
    }
    const run = await pending

    expect(winner.status).toBe(0)
    expect(run.status).toBe(0)
    expect(run.output).toContain('Push to "main" rejected (attempt 1 of 5), syncing and retrying')
    expect(run.output).toContain(`Already published \`${TAG}\` in area \`features\``)
    expect(remoteCommitCount(world)).toBe(before + 1)
    expect(readFile(readRemote(world), 'site/raw/features/alpha/1.0.0/intro.md')).toBe('# alpha\n')
  }, 20000)

  test('keeps newer Area files when another release publishes them while the push is rejected', async () => {
    const source = sourceWith(releaseEntry(), TAG, { 'README.md': '# v1 readme\n' })
    const docs = cloneDocs(world, 'docs-older')
    const ready = join(world.base, 'release-ready')
    const resume = join(world.base, 'release-resume')
    write(docs, { '.git/hooks/pre-push': `#!/bin/sh\ntouch "${ready}"\nwhile [ ! -f "${resume}" ]; do sleep 0.01; done\n` })
    chmodSync(join(docs, '.git/hooks/pre-push'), 0o755)
    const pending = startPublisher(docs, { source, tag: TAG })
    let winner
    try {
      await waitForFile(ready)
      commitSource(source, { 'README.md': '# v2 readme\n' }, 'newer area files')
      releaseCommit(source, { 'packages/alpha/templates/docs/intro.md': '# v2\n' }, 'alpha-v2.0.0', '2026-02-02T03:04:05Z')
      winner = runPublisher(cloneDocs(world, 'docs-newer'), { source, tag: 'alpha-v2.0.0' })
    } finally {
      write(world.base, { 'release-resume': '' })
    }
    const run = await pending

    expect(winner.status).toBe(0)
    expect(run.status).toBe(0)
    expect(run.output).toContain('Push to "main" rejected (attempt 1 of 5), syncing and retrying')
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/features/README.md')).toBe('# v2 readme\n')
    expect(exists(landed, 'site/raw/features/alpha/1.0.0/.meta.json')).toBe(true)
    expect(exists(landed, 'site/raw/features/alpha/2.0.0/.meta.json')).toBe(true)
    expect(run.summary).toContain(
      "Kept the Area files of `site/raw/features`: the Area's shared files changed since this release started.",
    )
  }, 20000)

  test('keeps the Area files a push rebuilt while a release waited to retry', async () => {
    const source = sourceWith(releaseEntry(), TAG, { 'README.md': '# v1 readme\n' })
    expect(runPublisher(cloneDocs(world, 'area-seed'), { source, tag: TAG }).status).toBe(0)
    releaseCommit(source, { 'packages/alpha/templates/docs/intro.md': '# v2\n' }, 'alpha-v2.0.0', '2026-02-02T03:04:05Z')
    const releaseCheckout = cloneSource(world, source, 'release-checkout')
    const docs = cloneDocs(world, 'docs-release')
    const ready = join(world.base, 'area-release-ready')
    const resume = join(world.base, 'area-release-resume')
    write(docs, { '.git/hooks/pre-push': `#!/bin/sh\ntouch "${ready}"\nwhile [ ! -f "${resume}" ]; do sleep 0.01; done\n` })
    chmodSync(join(docs, '.git/hooks/pre-push'), 0o755)
    const before = git(source, 'rev-parse', 'HEAD')
    const pending = startPublisher(docs, { source: releaseCheckout, tag: 'alpha-v2.0.0' })
    let pushed
    try {
      await waitForFile(ready)
      commitSource(source, { 'README.md': '# v2 readme\n' }, 'newer area files')
      pushed = runPublisher(cloneDocs(world, 'docs-push'), { source, before, after: git(source, 'rev-parse', 'HEAD') })
    } finally {
      write(world.base, { 'area-release-resume': '' })
    }
    const run = await pending

    expect(pushed.status).toBe(0)
    expect(run.status).toBe(0)
    expect(run.output).toContain('Push to "main" rejected (attempt 1 of 5), syncing and retrying')
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/features/README.md')).toBe('# v2 readme\n')
    expect(exists(landed, 'site/raw/features/alpha/2.0.0/.meta.json')).toBe(true)
    expect(run.summary).toContain(
      "Kept the Area files of `site/raw/features`: the Area's shared files changed since this release started.",
    )
  }, 20000)

  test('keeps a Version folder whose spec drifted, and leaves its republish to a reconcile', () => {
    const source = makeSource(world)
    const extra = (collect) => releaseEntry({ area: 'extra', mainFile: 'intro.md', collect })
    const narrowed = [{ from: 'templates/docs/*.md', to: '.' }]
    const widened = [...narrowed, { from: 'CHANGELOG.md', to: 'CHANGELOG.md' }]
    releaseCommit(source, {
      ...featureFiles('alpha'),
      ...entriesFile([releaseEntry({ area: 'features' }), extra(narrowed)]),
    }, TAG, DATE)
    expect(runPublisher(cloneDocs(world, 'docs-first'), { source, tag: TAG }).status).toBe(0)
    commitSource(source, {
      'packages/alpha/templates/docs/intro.md': '# RETAGGED\n',
      ...entriesFile([releaseEntry({ area: 'features' }), extra(widened)]),
    }, 'move the tag and drift one spec')
    git(source, 'tag', '--force', TAG)
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world, 'docs-second'), { source, tag: TAG })

    expect(run.status).toBe(0)
    expect(run.summary).toContain(`Already published \`${TAG}\` in area \`features\`: kept \`site/raw/features/alpha/1.0.0\` as it is.`)
    expect(run.summary).toContain(`Already published \`${TAG}\` in area \`extra\`: kept \`site/raw/extra/alpha/1.0.0\` as it is.`)
    expect(run.summary).not.toContain('Published')
    expect(remoteCommitCount(world)).toBe(before)
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/features/alpha/1.0.0/intro.md')).toBe('# alpha\n')
    expect(readFile(landed, 'site/raw/extra/alpha/1.0.0/intro.md')).toBe('# alpha\n')
    expect(exists(landed, 'site/raw/extra/alpha/1.0.0/CHANGELOG.md')).toBe(false)

    const reconciled = runPublisher(cloneDocs(world, 'docs-third'), {
      source: cloneSource(world, source, 'reconcile-source'), reconcile: true,
    })

    expect(reconciled.status).toBe(0)
    expect(reconciled.summary).toContain('- Republished `site/raw/extra/alpha/1.0.0`: spec changed.')
    const republished = readRemote(world)
    expect(readFile(republished, 'site/raw/extra/alpha/1.0.0/intro.md')).toBe('# RETAGGED\n')
    expect(readFile(republished, 'site/raw/extra/alpha/1.0.0/CHANGELOG.md')).toBe('# Changelog\n')
    expect(readFile(republished, 'site/raw/features/alpha/1.0.0/intro.md')).toBe('# alpha\n')
  })

  test('refuses a tag that resolves to a Version folder another tag published', () => {
    const source = makeSource(world)
    const config = '{"packages":{"packages/alpha":{"component":"a"}}}'
    releaseCommit(source, {
      ...featureFiles('alpha'), 'tags.json': config, ...entriesFile([releaseEntry({ tagNames: 'tags.json' })]),
    }, 'a-v1.0.0', DATE)
    expect(runPublisher(cloneDocs(world, 'docs-mapped'), { source, tag: 'a-v1.0.0' }).status).toBe(0)
    commitSource(source, { 'packages/alpha/templates/docs/intro.md': '# REPLACEMENT\n' }, 'another tag for the same folder')
    git(source, 'tag', 'alpha-v1.0.0')
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world, 'docs-fallback'), { source, tag: 'alpha-v1.0.0' })

    expect(run.status).toBe(2)
    expect(run.output).toContain(
      'refusing to publish `alpha-v1.0.0` over `a-v1.0.0` in `site/raw/features/alpha/1.0.0`: a Version folder keeps the tag that published it',
    )
    expect(remoteCommitCount(world)).toBe(before)
    const landed = readRemote(world)
    expect(readFile(landed, 'site/raw/features/alpha/1.0.0/intro.md')).toBe('# alpha\n')
    expect(readJson(landed, 'site/raw/features/alpha/1.0.0/.meta.json').tag).toBe('a-v1.0.0')
  })

  test('fails a missing tag without committing', () => {
    const source = sourceWith()
    const before = remoteCommitCount(world)
    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v9.9.9' })
    expect(run.status).toBe(2)
    expect(run.output).toContain('tag alpha-v9.9.9 not found')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test.each(['templates/docs/evil.md', 'templates/docs/images'])('refuses collected symlink %s', (rel) => {
    const source = sourceWith()
    if (rel.endsWith('images')) git(source, 'rm', '-r', `packages/alpha/${rel}`)
    symlinkSync('../../CHANGELOG.md', join(source, 'packages/alpha', rel))
    git(source, 'add', '-A'); git(source, 'commit', '-m', 'symlink'); git(source, 'tag', 'alpha-v1.0.1')
    const before = remoteCommitCount(world)
    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.1' })
    expect(run.status).toBe(2)
    expect(run.output).toContain('refusing to publish symlink')
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('refuses two collect rules that publish a file and a folder at one path', () => {
    const source = sourceWith(releaseEntry({
      collect: [{ from: 'schema.json', to: 'x' }, { from: 'schema.json', to: 'x/y' }],
      mainFile: 'x',
    }))
    const before = remoteCommitCount(world)
    const docs = cloneDocs(world)

    const run = runPublisher(docs, { source, tag: TAG })

    expect(run.status).toBe(2)
    expect(run.output).toContain(
      'Area "features": collect "schema.json" to "x" writes the file x, but collect "schema.json" to "x/y" writes x/y inside it',
    )
    expect(remoteCommitCount(world)).toBe(before)
    expect(readTree(docs)).toEqual({})
  })

  test('refuses a package directory reached through a symlink', () => {
    const source = sourceWith()
    git(source, 'mv', 'packages', 'pkgs'); symlinkSync('pkgs', join(source, 'packages'))
    git(source, 'add', '-A'); git(source, 'commit', '-m', 'symlink'); git(source, 'tag', 'alpha-v1.0.1')
    const run = runPublisher(cloneDocs(world), { source, tag: 'alpha-v1.0.1' })
    expect(run.status).toBe(2)
    expect(run.output).toContain('refusing to publish symlink: packages/alpha')
  })

  test('a failed build leaves source branch, untracked files and worktree registrations unchanged', () => {
    const source = sourceWith(releaseEntry({ build: 'echo generated > output; exit 1' }))
    const trees = git(source, 'worktree', 'list', '--porcelain')
    const before = remoteCommitCount(world)
    const run = runPublisher(cloneDocs(world), { source, tag: TAG })
    expect(run.status).toBe(2)
    expect(run.output).toContain('build failed in packages/alpha')
    expect(git(source, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(git(source, 'status', '--porcelain')).toBe('')
    expect(git(source, 'worktree', 'list', '--porcelain')).toBe(trees)
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('the matching entry alone publishes when entries have different package roots', () => {
    const source = makeSource(world)
    releaseCommit(source, { ...featureFiles('alpha'), ...entriesFile([releaseEntry({ area: 'features' }), releaseEntry({ area: 'beta', packages: 'beta' })]) }, TAG, DATE)
    const run = runPublisher(cloneDocs(world), { source, tag: TAG })
    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(exists(landed, 'site/raw/features/alpha/1.0.0/.meta.json')).toBe(true)
    expect(exists(landed, 'site/raw/beta')).toBe(false)
    expect(run.summary).toContain('no `beta/alpha` folder at the tag')
  })
})

describe('release-please tagNames', () => {
  test.each(['release-please-config.json', 'custom/rp.json'])('maps package-name tags using %s', (tagNames) => {
    const source = sourceWith(releaseEntry({ tagNames }), 'component-v1.0.0', { [tagNames]: JSON.stringify({ packages: { 'packages/alpha': { 'package-name': 'component' } } }) })
    const run = runPublisher(cloneDocs(world), { source, tag: 'component-v1.0.0' })
    expect(run.status).toBe(0)
    const landed = readRemote(world)
    expect(readJson(landed, 'site/raw/features/alpha/1.0.0/.meta.json').tag).toBe('component-v1.0.0')
    expect(readFile(landed, 'site/raw/features/alpha/1.0.0/intro.md')).toBe('# alpha\n')
  })

  test('prefers component over package-name', () => {
    const source = sourceWith(releaseEntry({ tagNames: 'tags.json' }), 'component-v1.0.0', { 'tags.json': '{"packages":{"packages/alpha":{"component":"component","package-name":"wrong"}}}' })
    const run = runPublisher(cloneDocs(world), { source, tag: 'component-v1.0.0' })
    expect(run.status).toBe(0)
    expect(readJson(readRemote(world), 'site/raw/features/alpha/1.0.0/.meta.json').tag).toBe('component-v1.0.0')
  })

  test('fails, naming the component and every conflicting folder, when two packages map to one tag name', () => {
    const source = sourceWith(releaseEntry({ tagNames: 'tags.json' }), 'component-v1.0.0', {
      ...packageFiles('beta'),
      'tags.json': '{"packages":{"packages/alpha":{"component":"component"},"packages/beta":{"component":"component"}}}',
    })
    const before = remoteCommitCount(world)

    const run = runPublisher(cloneDocs(world), { source, tag: 'component-v1.0.0' })

    expect(run.status).toBe(2)
    expect(run.output).toContain(
      'release-please config tags.json: component "component" maps to more than one package folder: packages/alpha, packages/beta',
    )
    expect(exists(readRemote(world), 'site/raw/features/alpha/1.0.0')).toBe(false)
    expect(remoteCommitCount(world)).toBe(before)
  })

  test('fails, and commits nothing, when the tagNames config is not valid JSON', () => {
    const source = sourceWith(releaseEntry({ tagNames: 'tags.json' }), 'component-v1.0.0', { 'tags.json': '{"packages":' })
    const before = remoteCommitCount(world)
    const run = runPublisher(cloneDocs(world), { source, tag: 'component-v1.0.0' })
    expect(run.status).toBe(2)
    expect(run.output).toContain('release-please config file is not valid JSON: tags.json')
    expect(remoteCommitCount(world)).toBe(before)
  })
})
