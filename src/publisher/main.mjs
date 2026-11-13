import { FatalError, assertBranchName, namesGitPath, writeSummary } from './files.mjs'
import { TAG_PATTERN, UNNAMED_TAG_PATTERN, entriesPath, nestedRepoPath, readEntries } from './entries.mjs'
import { publishReconcile } from './reconcile.mjs'
import { publishPushUpdates, pushChangedFiles } from './mirror.mjs'
import { publishRelease } from './release.mjs'
import { planReconcile } from './plan.mjs'
import { planPrune, stalePruneSummary } from './prune.mjs'
import { sourceBranchMoved, syncToBranch } from './push.mjs'

function readDestination({ root, branch }) {
  if (branch === '') throw new FatalError('branch must not be empty')
  if (namesGitPath(root)) throw new FatalError(`root "${root}" uses ".git", the Git administrative folder`)
  const { path: clean, refusal } = nestedRepoPath(root)
  if (refusal === 'escapes') throw new FatalError(`root must not leave the repo: "${root}"`)
  if (refusal) throw new FatalError(`root must be a relative path inside the repo: "${root}"`)
  // `.` is the checkout itself, and accepted as it is spelled. Every other form has to be the normalized folder it names.
  if (clean !== root) {
    throw new FatalError(`root "${root}" must be a normalized folder inside the docs checkout`)
  }
  return { root: clean, branch }
}

// A push whose prune has work runs a reconcile: its deletions, the shared files that list them and the retired tags
// are planned together, and a reconcile publishes nothing unless all of it can be planned. The push decides once,
// before any write. A checkout behind the source branch tip cannot tell which docs are stale, so it prunes nothing
// and runs no reconcile: the next run, which starts from the tip, does.
function publishPush({ args, repository, root }) {
  const entries = readEntries(args.entries, args['source-branch'])
  syncToBranch(args.docs, args.branch)
  const prune = planPrune({ docs: args.docs, source: args.source, root, repository, entries })
  if (!prune.hasWork) return { output: 'push', ...publishPushUpdates({ args, repository, root }) }
  if (sourceBranchMoved(args.source, args['source-branch'])) {
    stalePruneSummary(args['source-branch'])
    return { output: 'push', ...publishPushUpdates({ args, repository, root }) }
  }
  writeSummary('This push needs a prune, so it ran a reconcile.')
  return { output: 'reconcile', ...publishReconcile({ args, repository, root }) }
}

const UNCHANGED = { changed: false, commitSha: null }

// What a run did, for the action's outputs: the mode it ran as, whether it pushed a commit to the docs branch, and
// that commit's SHA. A push reports `reconcile` when it escalates, and `push` when it only publishes updates.
//
// `mode` is picked from the Actions event by the caller: `release` (a published tag), `reconcile` (a manual run),
// `push` (both ends of the push range) or `plan` (a pull request's base and head), plus `skipped` for a release tag
// the publisher cannot read as a release. The publisher itself never looks at the event.
export function publish(args, mode) {
  const target = readDestination(args)
  // The docs branch and the source branch are names git applies, and the source branch also names a folder inside
  // each Area: every mode refuses a name git would, before it builds a path from either.
  assertBranchName(target.branch, 'branch')
  assertBranchName(args['source-branch'] ?? '', 'source-branch')
  // A plan and a push read the range the event carries; every mode that does not have one leaves the args as they are.
  const range = mode.before !== undefined || mode.after !== undefined ? { before: mode.before, after: mode.after } : {}
  const run = { ...args, ...target, ...range }
  const root = run.root
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(run['docs-repository'])) throw new FatalError('docs-repository must be org/repo')
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new FatalError('GITHUB_REPOSITORY is not set')
  if (mode.kind === 'skipped') {
    writeSummary(`Skipped \`${mode.tag}\`: it is not a \`${TAG_PATTERN}\` or \`${UNNAMED_TAG_PATTERN}\` release tag.`)
    return { output: 'skipped', ...UNCHANGED }
  }
  if (mode.kind === 'plan') return { output: 'plan', ...planReconcile({ args: run, repository, root }) }
  if (mode.kind === 'reconcile') return { output: 'reconcile', ...publishReconcile({ args: run, repository, root }) }
  if (mode.kind === 'release') {
    return { output: 'release', ...publishRelease({ args: { ...run, tag: mode.tag }, release: mode.release, repository, root }) }
  }
  if (mode.kind !== 'push') throw new FatalError(`unknown run mode: ${mode.kind}`)
  if (run.before !== undefined || run.after !== undefined) {
    const changed = pushChangedFiles(run.source, run.before, run.after)
    if (changed === null || changed.includes(entriesPath(run.source, run.entries))) {
      return { output: 'reconcile', ...publishReconcile({ args: run, repository, root }) }
    }
  }
  return publishPush({ args: run, repository, root })
}
