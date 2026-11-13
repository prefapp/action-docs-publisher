import { describe, expect, test } from '@jest/globals'
import { renderedScript } from '../test/harness.mjs'

const { specHash } = await import(renderedScript('entries.mjs'))

describe('the Version folder content specification', () => {
  const entry = { collect: [{ from: 'docs/**', to: '.' }], build: 'npm run docs', packages: 'packages' }

  test.each([
    { collect: [{ from: 'docs/*.md', to: '.' }] },
    { collect: [{ from: 'docs/**', to: 'reference' }] },
    { build: 'npm run api-docs' },
    { build: undefined },
    { packages: 'modules' },
    { packages: undefined },
  ])('changes when content settings change: %j', (change) => {
    expect(specHash({ ...entry, ...change })).not.toBe(specHash(entry))
  })

  test('ignores shared-file settings and tag selection', () => {
    expect(specHash({ ...entry, mainFile: 'schema.json', areaFiles: [{ from: 'README.md', to: 'README.md' }], tagNames: 'tags.json', prereleases: true, area: 'other' })).toBe(specHash(entry))
  })

  test('hashes canonical JSON with sha256 without changing the entry', () => {
    const before = JSON.stringify(entry)
    expect(specHash(entry)).toBe('50436f7e828276c5e48fa07413eee6692d7bd2b25afa3a63f8f81677a1f9f37d')
    expect(specHash({ packages: 'packages', build: 'npm run docs', collect: [{ to: '.', from: 'docs/**' }] })).toBe(specHash(entry))
    expect(JSON.stringify(entry)).toBe(before)
  })
})
