import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { pathToFileURL } from 'node:url'
import {
  ROOT,
  commitSource,
  makeDocsRemote,
  makeSource,
  releaseEntry,
  renderedScript,
  unnamedReleaseEntry,
} from '../test/harness.mjs'

const { versionTargeting } = await import(pathToFileURL(renderedScript('version-folders.mjs')).href)

let world

beforeEach(() => {
  world = makeDocsRemote()
})

afterEach(() => {
  world.cleanup()
})

// The targeting module reads the entry's tagNames config from the source checkout, so every test asks a real one.
function sourceWith(files = {}) {
  const source = makeSource(world)
  commitSource(source, { 'README.md': '# Source\n', ...files }, 'source')
  return source
}

describe('a named entry', () => {
  test('publishes a tag into its package folder inside the Area', () => {
    const target = versionTargeting({ source: sourceWith(), root: ROOT, entry: releaseEntry() })
      .forTag({ name: 'alpha', version: '1.0.0' })

    expect(target).toEqual({
      name: 'alpha',
      version: '1.0.0',
      folder: 'packages/alpha',
      versionDir: 'site/raw/features/alpha/1.0.0',
    })
  })

  test('keeps the destination inside the root when the root is the checkout', () => {
    const target = versionTargeting({ source: sourceWith(), root: '.', entry: releaseEntry() })
      .forTag({ name: 'alpha', version: '2.0.0' })

    expect(target.versionDir).toBe('features/alpha/2.0.0')
  })
})

describe('a named entry whose tagNames config maps tag names', () => {
  const config = JSON.stringify({ packages: { 'packages/alpha': { component: 'component' } } })

  function targetFor(name, files = { 'tags.json': config }) {
    const entry = releaseEntry({ tagNames: 'tags.json' })
    return versionTargeting({ source: sourceWith(files), root: ROOT, entry }).forTag({ name, version: '1.0.0' })
  }

  test('publishes the tag into the package folder the config maps it to', () => {
    expect(targetFor('component')).toEqual({
      name: 'alpha',
      version: '1.0.0',
      folder: 'packages/alpha',
      versionDir: 'site/raw/features/alpha/1.0.0',
    })
  })

  test('falls back to the tag name for a tag the config does not list', () => {
    expect(targetFor('beta')).toEqual({
      name: 'beta',
      version: '1.0.0',
      folder: 'packages/beta',
      versionDir: 'site/raw/features/beta/1.0.0',
    })
  })

  // Reconcile refuses two tags that resolve to one Version folder, so the fallback has to be the same destination.
  test('resolves a mapped tag and the tag named after its folder to one Version folder', () => {
    const entry = releaseEntry({ tagNames: 'tags.json' })
    const targeting = versionTargeting({ source: sourceWith({ 'tags.json': config }), root: ROOT, entry })

    expect(targeting.forTag({ name: 'component', version: '1.0.0' }).versionDir)
      .toBe(targeting.forTag({ name: 'alpha', version: '1.0.0' }).versionDir)
  })

  test('refuses a mapping onto a name the publisher reserves', () => {
    const reserved = JSON.stringify({ packages: { 'packages/latest': { component: 'component' } } })

    expect(() => targetFor('component', { 'tags.json': reserved })).toThrow(
      'tag component "component" resolves to "latest", a name the publisher reserves',
    )
  })
})

describe('the tag a published Version folder was built from', () => {
  test('names the tag the entry maps its package folder from', () => {
    const entry = releaseEntry({ tagNames: 'tags.json' })
    const source = sourceWith({ 'tags.json': JSON.stringify({ packages: { 'packages/alpha': { component: 'component' } } }) })

    expect(versionTargeting({ source, root: ROOT, entry }).tagFor('alpha', '1.0.0')).toBe('component-v1.0.0')
  })

  test('names the tag of a package the config does not list', () => {
    const entry = releaseEntry({ tagNames: 'tags.json' })
    const source = sourceWith({ 'tags.json': JSON.stringify({ packages: {} }) })

    expect(versionTargeting({ source, root: ROOT, entry }).tagFor('beta', '1.0.0')).toBe('beta-v1.0.0')
  })

  test('names the unnamed tag of an entry without packages', () => {
    const source = sourceWith()

    expect(versionTargeting({ source, root: ROOT, entry: unnamedReleaseEntry() }).tagFor(null, 'v1.2.0')).toBe('v1.2.0')
  })
})

describe('an unnamed entry', () => {
  test('publishes a tag directly into the Area, with no package folder', () => {
    const target = versionTargeting({ source: sourceWith(), root: ROOT, entry: unnamedReleaseEntry() })
      .forTag({ name: null, version: 'v1.2.0' })

    expect(target).toEqual({
      name: null,
      version: 'v1.2.0',
      folder: null,
      versionDir: 'site/raw/core/crds/v1.2.0',
    })
  })
})
