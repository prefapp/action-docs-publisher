import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readInputs, resolveEntriesFile } from '../src/action/inputs.mjs'

// The runner's own reader: a required input that is empty fails the run, which is how the action refuses a workflow
// that leaves a token or a destination out.
function reader(values) {
  const calls = []
  const getInput = (name, options) => {
    calls.push({ name, required: options?.required === true })
    const value = values[name] ?? ''
    if (value.trim() === '' && options?.required) throw new Error(`Input required and not supplied: ${name}`)
    return value
  }
  return { getInput, calls }
}

const FULL = {
  'docs-repository': 'firestartr-pro/docs',
  'docs-root-folder': 'site/raw',
  'docs-branch': 'main',
  'source-branch': 'main',
  'entries-file': '.github/docs_publisher.yaml',
  'docs-token': 'docs-token',
  'github-token': 'github-token',
}

describe('action inputs', () => {
  test('reads the seven inputs the workflow passes, and nothing else', () => {
    const { getInput, calls } = reader(FULL)

    expect(readInputs(getInput)).toEqual({
      docsRepository: 'firestartr-pro/docs',
      root: 'site/raw',
      branch: 'main',
      sourceBranch: 'main',
      entriesFile: '.github/docs_publisher.yaml',
      docsToken: 'docs-token',
      githubToken: 'github-token',
    })
    expect(calls.map((call) => call.name).sort()).toEqual(Object.keys(FULL).sort())
  })

  test('trims what the workflow passes, so a padded value is the same destination', () => {
    const { getInput } = reader({ ...FULL, 'docs-repository': ' firestartr-pro/docs ', 'docs-root-folder': ' site/raw ' })

    expect(readInputs(getInput)).toMatchObject({ docsRepository: 'firestartr-pro/docs', root: 'site/raw' })
  })

  test.each(['docs-branch', 'source-branch'])('defaults %s to main when the workflow leaves it empty', (name) => {
    const { getInput } = reader({ ...FULL, [name]: '  ' })

    expect(readInputs(getInput)).toMatchObject({ [name === 'docs-branch' ? 'branch' : 'sourceBranch']: 'main' })
  })

  test('defaults the entries file to the one the feature installs', () => {
    const { getInput } = reader({ ...FULL, 'entries-file': '' })

    expect(readInputs(getInput)).toMatchObject({ entriesFile: '.github/docs_publisher.yaml' })
  })

  test('takes an entries file of the repository\'s own, at the path it names', () => {
    const { getInput } = reader({ ...FULL, 'entries-file': 'docs/publisher.yaml' })

    expect(readInputs(getInput)).toMatchObject({ entriesFile: 'docs/publisher.yaml' })
  })

  test.each(['docs-repository', 'docs-root-folder', 'docs-token', 'github-token'])(
    'refuses a run without %s, before it touches either repository',
    (name) => {
      const { getInput } = reader({ ...FULL, [name]: '' })

      expect(() => readInputs(getInput)).toThrow(`Input required and not supplied: ${name}`)
    },
  )

  test.each([
    ['docs-branch', '..'],
    ['docs-branch', 'a b'],
    ['docs-branch', '-main'],
    ['source-branch', '..'],
    ['source-branch', 'a b'],
  ])('refuses a %s of %p, which is not a git branch name', (name, value) => {
    const { getInput } = reader({ ...FULL, [name]: value })

    expect(() => readInputs(getInput)).toThrow(`${name} "${value}" is not a valid git branch name`)
  })
})

describe('the entries file path', () => {
  const WORKSPACE = '/work/source'

  test('is resolved inside the workspace', () => {
    expect(resolveEntriesFile(WORKSPACE, '.github/docs_publisher.yaml')).toBe('/work/source/.github/docs_publisher.yaml')
    expect(resolveEntriesFile(WORKSPACE, 'docs/nested/publisher.yaml')).toBe('/work/source/docs/nested/publisher.yaml')
  })

  test('refuses a path that climbs out of the workspace', () => {
    expect(() => resolveEntriesFile(WORKSPACE, '../publisher.yaml')).toThrow(
      'entries-file must be a relative path inside the source checkout: "../publisher.yaml"',
    )
    expect(() => resolveEntriesFile(WORKSPACE, 'docs/../../publisher.yaml')).toThrow('entries-file must be a relative')
  })

  test('refuses an absolute path, even one that names a file in the workspace', () => {
    expect(() => resolveEntriesFile(WORKSPACE, '/work/source/.github/docs_publisher.yaml')).toThrow(
      'entries-file must be a relative path inside the source checkout',
    )
  })

  describe('with a file on disk', () => {
    let base

    beforeEach(() => {
      base = mkdtempSync(join(tmpdir(), 'docs-publisher-inputs-'))
    })

    afterEach(() => {
      rmSync(base, { recursive: true, force: true })
    })

    test('accepts a symlink that stays inside the workspace', () => {
      const workspace = join(base, 'source')
      mkdirSync(join(workspace, '.github'), { recursive: true })
      writeFileSync(join(workspace, 'real.yaml'), 'entries: []\n')
      symlinkSync('../real.yaml', join(workspace, '.github', 'docs_publisher.yaml'))

      expect(resolveEntriesFile(workspace, '.github/docs_publisher.yaml')).toBe(
        join(workspace, '.github/docs_publisher.yaml'),
      )
    })

    test('refuses a symlink inside the checkout that points outside it', () => {
      const workspace = join(base, 'source')
      mkdirSync(join(workspace, '.github'), { recursive: true })
      writeFileSync(join(base, 'outside.yaml'), 'entries: []\n')
      symlinkSync(join(base, 'outside.yaml'), join(workspace, '.github', 'docs_publisher.yaml'))

      expect(() => resolveEntriesFile(workspace, '.github/docs_publisher.yaml')).toThrow(
        'entries-file must be a relative path inside the source checkout: ".github/docs_publisher.yaml"',
      )
    })

    test('leaves a missing file to the read that reports it, as before', () => {
      const workspace = join(base, 'source')
      mkdirSync(workspace, { recursive: true })

      expect(resolveEntriesFile(workspace, '.github/docs_publisher.yaml')).toBe(
        join(workspace, '.github/docs_publisher.yaml'),
      )
    })
  })
})
