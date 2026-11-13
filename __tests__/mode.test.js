import { describe, expect, test } from '@jest/globals'
import { releaseMode, selectMode } from '../src/action/mode.mjs'

const TAG = 'docs_publisher-v1.0.0'
const PULL_REQUEST = {
  number: 7,
  base: { sha: 'base-sha' },
  head: { sha: 'head-sha' },
}

describe('the mode a run takes from its event', () => {
  test('a published release runs the release of its tag', () => {
    const mode = selectMode({ eventName: 'release', payload: { release: { tag_name: TAG } } })

    expect(mode).toMatchObject({ kind: 'release', tag: TAG, release: { name: 'docs_publisher', version: '1.0.0' } })
  })

  test('a release tag the publisher cannot read is skipped, and says which tag', () => {
    expect(selectMode({ eventName: 'release', payload: { release: { tag_name: 'not-a-release' } } })).toEqual({
      kind: 'skipped',
      tag: 'not-a-release',
    })
  })

  test('a manual run reconciles the docs repo', () => {
    expect(selectMode({ eventName: 'workflow_dispatch', payload: {} })).toEqual({ kind: 'reconcile' })
  })

  test('a push runs the range it carries, from the event and the commit the runner checked out', () => {
    expect(selectMode({ eventName: 'push', payload: { before: 'before-sha' }, sha: 'after-sha' })).toEqual({
      kind: 'push',
      before: 'before-sha',
      after: 'after-sha',
    })
  })

  test('a pull request plans between its base and its head, and never publishes', () => {
    expect(selectMode({ eventName: 'pull_request', payload: { pull_request: PULL_REQUEST }, sha: 'head-sha' })).toEqual({
      kind: 'plan',
      before: 'base-sha',
      after: 'head-sha',
    })
  })

  test('an event with no mode fails, so a workflow that adds one is told instead of publishing blind', () => {
    expect(() => selectMode({ eventName: 'schedule', payload: {} })).toThrow('unsupported event: "schedule"')
  })

  test('a release event without a tag fails rather than skipping an unnamed tag', () => {
    expect(() => selectMode({ eventName: 'release', payload: {} })).toThrow('release event without a tag')
  })

  test('a pull request event without a pull request fails rather than planning an empty range', () => {
    expect(() => selectMode({ eventName: 'pull_request', payload: {} })).toThrow(
      'pull_request event without a pull request',
    )
  })
})

describe('a release tag as a mode', () => {
  test('carries the release the tag names, parsed once', () => {
    expect(releaseMode(TAG)).toMatchObject({ kind: 'release', tag: TAG })
    expect(releaseMode(TAG).release.version).toBe('1.0.0')
  })

  test('an unnamed tag is a release too, named by its own version', () => {
    expect(releaseMode('v1.2.0')).toMatchObject({ kind: 'release', tag: 'v1.2.0' })
  })

  test('a tag that is neither form is skipped', () => {
    expect(releaseMode('latest')).toEqual({ kind: 'skipped', tag: 'latest' })
  })
})
