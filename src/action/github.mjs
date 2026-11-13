import { getOctokit } from '@actions/github'
import { IRRELEVANT_MARKER, PLAN_MARKER } from '../publisher/plan.mjs'

// The account the docs token acts as. An App installation token cannot read `GET /user` — GitHub refuses it for an
// integration — but GraphQL's `viewer` names it, as `<slug>[bot]`; the users route then gives the numeric id the
// noreply commit address needs. A personal token answers the same two routes with its own login.
export async function botIdentity(token) {
  const octokit = getOctokit(token)
  const { viewer } = await octokit.graphql('query { viewer { login } }')
  const { data } = await octokit.rest.users.getByUsername({ username: viewer.login })
  return { login: data.login, id: data.id }
}

// One comment per pull request. A plan that says nothing changed replaces the one before it; with no comment to
// replace it is not posted at all, so a pull request that never published anything never gains a comment.
export async function upsertPlanComment({ token, repository, pullNumber, body }) {
  const [owner, repo] = repository.split('/')
  const octokit = getOctokit(token)
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  })
  const existing = comments.find((comment) => typeof comment.body === 'string' && comment.body.startsWith(PLAN_MARKER))
  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body })
    return 'updated'
  }
  if (body.includes(IRRELEVANT_MARKER)) return 'skipped'
  await octokit.rest.issues.createComment({ owner, repo, issue_number: pullNumber, body })
  return 'created'
}
