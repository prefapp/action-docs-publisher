import { FatalError } from '../publisher/files.mjs'
import { matchTag } from '../publisher/entries.mjs'

// A release event names a tag. A tag the publisher cannot read as a release is not an error: the run reports that it
// skipped it, so a repository can publish releases of other kinds from the same branch.
export function releaseMode(tag) {
  if (typeof tag !== 'string' || tag === '') throw new FatalError('release event without a tag')
  const release = matchTag(tag)
  return release === null ? { kind: 'skipped', tag } : { kind: 'release', tag, release }
}

// The mode a run takes from the event. Nothing else decides it: there are no flags and no options file.
export function selectMode({ eventName, payload, sha }) {
  if (eventName === 'release') return releaseMode(payload.release?.tag_name)
  if (eventName === 'workflow_dispatch') return { kind: 'reconcile' }
  if (eventName === 'push') return { kind: 'push', before: payload.before, after: sha }
  if (eventName === 'pull_request') {
    const pullRequest = payload.pull_request
    if (typeof pullRequest?.number !== 'number') throw new FatalError('pull_request event without a pull request')
    return { kind: 'plan', before: pullRequest.base?.sha, after: pullRequest.head?.sha }
  }
  throw new FatalError(`unsupported event: "${eventName}"`)
}
