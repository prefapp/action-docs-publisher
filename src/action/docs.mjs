import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { FatalError, git, tokenEnvironment } from '../publisher/files.mjs'

// The docs repository is cloned beside the source checkout, never inside it: the source checkout is the whole
// workspace, its git status drives the publisher, and a build command runs from it with no token.
export function docsCheckoutPath(runnerTemp) {
  return join(runnerTemp, 'docs-publisher-docs')
}

export function cloneDocsRepository({ docs, repository, branch, token, server }) {
  mkdirSync(join(docs, '..'), { recursive: true })
  const url = `${server}/${repository}.git`
  try {
    execFileSync('git', ['clone', '--quiet', '--branch', branch, '--single-branch', url, docs], {
      env: tokenEnvironment(token),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    // The publisher fetches this branch again before it writes, and refuses with this sentence when it cannot. A
    // branch the clone cannot find is the same refusal, reported the same way, before any work starts.
    const detail = String(error.stderr ?? error.message).trim().split('\n')[0]
    throw new FatalError(`could not fetch the docs branch "${branch}" from origin: ${detail}`)
  }
  return docs
}

// The commit identity of the App's installation, resolved from the token itself: an installation token answers
// `GET /user` as the bot account that token acts for, so the action needs no app slug input.
export function setCommitIdentity(docs, { login, id }) {
  git(docs, ['config', 'user.name', login])
  git(docs, ['config', 'user.email', `${id}+${login}@users.noreply.github.com`])
}

export function removeDocsCheckout(docs) {
  rmSync(docs, { recursive: true, force: true })
}
