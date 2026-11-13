#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FatalError, appendSummary, namesGitPath, takeCredential, writeSummary } from './files.mjs'
import { TAG_PATTERN, UNNAMED_TAG_PATTERN, matchTag, nestedRepoPath, readEntries } from './entries.mjs'
import { publishReconcile } from './reconcile.mjs'
import { publishPushUpdates, pushChangedFiles } from './mirror.mjs'
import { publishRelease } from './release.mjs'
import { planReconcile } from './plan.mjs'
import { planPrune, stalePruneSummary } from './prune.mjs'
import { sourceBranchMoved, syncToBranch } from './push.mjs'

const REQUIRED_OPTIONS = ['source', 'docs', 'entries', 'root', 'branch', 'source-branch', 'docs-repository']

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--reconcile' || flag === '--plan') {
      options[flag.slice(2)] = true
      continue
    }
    if (!flag?.startsWith('--') || argv[i + 1] === undefined) {
      throw new FatalError(`expected --option value pairs, got "${flag}"`)
    }
    options[flag.slice(2)] = argv[i + 1]
    i++
  }
  for (const name of REQUIRED_OPTIONS) {
    if (options[name] === undefined) throw new FatalError(`missing --${name}`)
  }
  return options
}

function readDestination({ root, branch }) {
  if (branch === '') throw new FatalError('branch must not be empty')
  if (namesGitPath(root)) throw new FatalError(`root "${root}" uses ".git", the Git administrative folder`)
  const { path: clean, refusal } = nestedRepoPath(root)
  if (refusal === 'escapes') throw new FatalError(`root must not leave the repo: "${root}"`)
  if (refusal) throw new FatalError(`root must be a relative path inside the repo: "${root}"`)
  if (clean !== root || clean === '.') {
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
  if (!prune.hasWork) return publishPushUpdates({ args, repository, root })
  if (sourceBranchMoved(args.source, args['source-branch'])) {
    stalePruneSummary(args['source-branch'])
    return publishPushUpdates({ args, repository, root })
  }
  writeSummary('This push needs a prune, so it ran a reconcile.')
  return publishReconcile({ args, repository, root })
}

async function main(argv) {
  const parsed = parseArgs(argv)
  const args = { ...parsed, ...readDestination(parsed) }
  takeCredential(args.source, process.env.DOCS_PUBLISHER_SOURCE_TOKEN_FILE)
  takeCredential(args.docs, process.env.DOCS_PUBLISHER_DOCS_TOKEN_FILE)
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(args['docs-repository'])) throw new FatalError('docs-repository must be org/repo')
  if (args.plan) {
    if (args.tag !== undefined || args.reconcile) throw new FatalError('--plan runs without --tag or --reconcile')
    for (const name of ['plan-file', 'before', 'after']) {
      if (!args[name]) throw new FatalError(`missing --${name} for --plan`)
    }
  }
  if (args.reconcile && args.tag !== undefined) throw new FatalError('--reconcile runs without --tag')
  const release = args.tag === undefined ? null : matchTag(args.tag)
  if (args.tag !== undefined && !release) {
    writeSummary(`Skipped \`${args.tag}\`: it is not a \`${TAG_PATTERN}\` or \`${UNNAMED_TAG_PATTERN}\` release tag.`)
    return 0
  }
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new FatalError('GITHUB_REPOSITORY is not set')
  const root = args.root

  if (args.plan) return planReconcile({ args, repository, root })
  if (args.reconcile) return publishReconcile({ args, repository, root })
  if (release) return publishRelease({ args, release, repository, root })
  if (args.before !== undefined || args.after !== undefined) {
    const changed = pushChangedFiles(args.source, args.before, args.after)
    if (changed === null || changed.includes('.github/docs_publisher.yaml')) {
      return publishReconcile({ args, repository, root })
    }
  }
  return publishPush({ args, repository, root })
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      if (error instanceof FatalError) {
        console.error(`docs_publisher: ${error.message}`)
        appendSummary(error.message)
      } else console.error(error)
      process.exitCode = 2
    },
  )
}
