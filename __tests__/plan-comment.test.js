import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals'
import { IRRELEVANT_MARKER, PLAN_MARKER } from '../src/publisher/plan.mjs'
import { startApiStub } from '../test/api-stub.mjs'

// `@actions/github` reads `GITHUB_API_URL` when it is imported, so the stub has to be listening first: the module
// under test is imported once the stub's port is known.
const previous = process.env.GITHUB_API_URL
let api
let github

beforeAll(async () => {
  api = await startApiStub()
  process.env.GITHUB_API_URL = api.url
  github = await import('../src/action/github.mjs')
})

afterAll(async () => {
  if (previous === undefined) delete process.env.GITHUB_API_URL
  else process.env.GITHUB_API_URL = previous
  await api.close()
})

beforeEach(() => {
  api.calls.length = 0
  api.comments.length = 0
})

const PLAN = `${PLAN_MARKER}\n### Docs\n\n- Published \`site/raw/features/docs_publisher/1.0.0\`.\n`

describe('the identity the docs commits are authored by', () => {
  test('is the account an installation token acts as, which only GraphQL names', async () => {
    const identity = await github.botIdentity('docs-token')

    expect(identity).toEqual({ login: 'docs-publisher[bot]', id: 12345 })
    expect(api.calls.map((call) => `${call.method} ${decodeURIComponent(call.url)}`)).toEqual([
      'POST /graphql',
      'GET /users/docs-publisher[bot]',
    ])
    expect(api.calls[0].body.query).toContain('viewer')
  })

})
describe('the plan comment of a pull request', () => {
  const comment = (overrides = {}) => ({
    token: 'github-token',
    repository: 'acme/source',
    pullNumber: 7,
    body: PLAN,
    ...overrides,
  })

  test('is created when the pull request has none', async () => {
    expect(await github.upsertPlanComment(comment())).toBe('created')

    expect(api.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /repos/acme/source/issues/7/comments',
      'POST /repos/acme/source/issues/7/comments',
    ])
    expect(api.calls[1].body).toEqual({ body: PLAN })
  })

  test('is replaced in place when an earlier run left one, whatever its author', async () => {
    api.comments.push({ id: 99, body: `${PLAN_MARKER}\nold plan\n` }, { id: 100, body: 'unrelated' })

    expect(await github.upsertPlanComment(comment())).toBe('updated')

    expect(api.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /repos/acme/source/issues/7/comments',
      'PATCH /repos/acme/source/issues/comments/99',
    ])
    expect(api.calls[1].body).toEqual({ body: PLAN })
  })

  test('replaces the comment with the notice that nothing changes, instead of leaving a stale plan', async () => {
    api.comments.push({ id: 99, body: `${PLAN_MARKER}\nold plan\n` })

    expect(await github.upsertPlanComment(comment({ body: `${IRRELEVANT_MARKER}\nNothing to plan.\n` }))).toBe('updated')
    expect(api.calls.at(-1).url).toBe('/repos/acme/source/issues/comments/99')
  })

  test('is not created for a pull request that never published anything', async () => {
    expect(await github.upsertPlanComment(comment({ body: `${IRRELEVANT_MARKER}\nNothing to plan.\n` }))).toBe('skipped')

    expect(api.calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /repos/acme/source/issues/7/comments'])
  })

})
