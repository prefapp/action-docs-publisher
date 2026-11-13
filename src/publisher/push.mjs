
import path from 'node:path'
import { FatalError, git, gitRemote, gitStatus, lstatOrNull, trackedPaths } from './files.mjs'

const MAX_PUSH_ATTEMPTS = 5

const BACKOFF_STEP_MS = Number(process.env.DOCS_PUBLISHER_BACKOFF_STEP_MS ?? 5000)

export function syncToBranch(docs, branch) {
  const fetch = gitRemote(docs, ['fetch', '--quiet', 'origin', branch])
  if (fetch.status !== 0) {
    throw new FatalError(`could not fetch the docs branch "${branch}" from origin: ${fetch.stderr.trim()}`)
  }
  git(docs, ['reset', '--quiet', '--hard', 'FETCH_HEAD'])
  git(docs, ['clean', '-fdq'])
}

// A run may outlive the source commit it started from, and it cannot tell which docs are stale from a checkout
// that is behind the branch tip. It never prunes then; the next run, which starts from the new tip, does.
// A checkout with no origin remote, or without that branch, has no tip to compare with.
export function sourceBranchMoved(source, branch) {
  const remotes = gitStatus(source, ['remote'])
  if (remotes.status !== 0 || !remotes.stdout.split('\n').map((name) => name.trim()).includes('origin')) return false
  const fetch = gitRemote(source, ['fetch', '--quiet', '--force', '--tags', 'origin'])
  if (fetch.status !== 0) {
    throw new FatalError(`could not fetch the source branch "${branch}" from origin: ${fetch.stderr.trim()}`)
  }
  const tip = gitStatus(source, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
  if (tip.status !== 0) return false
  return tip.stdout.trim() !== git(source, ['rev-parse', 'HEAD'])
}

// A rebuild or a prune can delete a path git never tracked, so only the paths git knows about are staged.
function stageablePaths(docs, paths) {
  const present = []
  const missing = []
  for (const rel of paths) (lstatOrNull(path.join(docs, rel)) ? present : missing).push(rel)
  return [...present, ...trackedPaths(docs, missing)]
}

// One staged-effects classifier supplies both subjects and summaries. Paths belong to the Area that planned them;
// a nested Area's change does not count as a change of its parent, and prune effects retain their Area ownership.
// A rename would report only its destination, hiding the Area it left, so renames are listed as a delete and an add.
export function classifyStagedEffects(docs, { mirrors = [], releases = [], prune = { removals: [], files: [] } }) {
  const staged = gitStatus(docs, ['diff', '--staged', '--name-only', '--no-renames', '-z']).stdout.split('\0').filter(Boolean)
  const inside = (rel, dir) => rel === dir || rel.startsWith(`${dir}/`)
  const changes = [...prune.removals, ...prune.files]
  const areaDirs = [...mirrors, ...releases, ...changes].map((item) => item.areaDir)
  const affected = (paths, areaDir) => staged.some((rel) =>
    paths.some((dir) => inside(rel, dir)) && !areaDirs.some((dir) => dir?.startsWith(`${areaDir}/`) && inside(rel, dir)))
  const removals = prune.removals.filter((item) => affected([item.dir], item.areaDir))
  const files = prune.files.filter((item) => affected([item.rel], item.areaDir))
  return {
    mirrors: mirrors.filter((item) => affected([item.areaDir], item.areaDir)),
    releases: releases.filter((item) => affected([
      ...item.paths, ...changes.filter((change) => change.areaDir === item.areaDir).map((change) => change.dir ?? change.rel),
    ], item.areaDir)),
    prune: { ...prune, removals, files, warnings: prune.warnings?.filter((warning) => staged.some((rel) => inside(rel, warning.dir))) },
  }
}

export function publishWithRetry({ docs, branch, areaDirs, message, write }) {
  let rejection = ''
  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const delay = attempt * BACKOFF_STEP_MS + Math.floor(Math.random() * BACKOFF_STEP_MS)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
    }
    syncToBranch(docs, branch)

    const outputPaths = stageablePaths(docs, write())
    if (outputPaths.length > 0) {
      git(docs, ['--literal-pathspecs', 'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], `${outputPaths.join('\0')}\0`)
    }
    const staged = areaDirs.filter((areaDir) => lstatOrNull(path.join(docs, areaDir)) !== null)
    for (const areaDir of staged) git(docs, ['add', '-A', '--', `:(literal)${areaDir}`])
    if (gitStatus(docs, ['diff', '--staged', '--quiet']).status === 0) return false
    // A caller that cannot name the work until it has planned it passes a function: only what it changed is named.
    git(docs, ['commit', '--quiet', '-m', typeof message === 'function' ? message() : message])

    const push = gitRemote(docs, ['push', 'origin', `HEAD:refs/heads/${branch}`])
    if (push.status === 0) return true
    rejection = push.stderr.trim()
    // The retry is otherwise invisible: say that the docs branch moved and why, so a slow run can be explained.
    const reason = rejection.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? 'no reason given'
    console.warn(`Push to "${branch}" rejected (attempt ${attempt} of ${MAX_PUSH_ATTEMPTS})${attempt < MAX_PUSH_ATTEMPTS ? ', syncing and retrying' : ''}: ${reason}`)
  }
  throw new FatalError(`push failed after ${MAX_PUSH_ATTEMPTS} attempts: ${rejection}`)
}
