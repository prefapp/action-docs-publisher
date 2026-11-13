
import fs from 'node:fs'
import path from 'node:path'
import {
  folderForTagName,
  matchTag,
  readEntries,
  readTagNames,
  tagForVersionFolder,
  specHash,
} from './entries.mjs'
import {
  FatalError,
  assertAreaWritable,
  readAreaFiles,
  assertAreaPlacement,
  assertBranchReplaceable,
  assertNoNestedWrites,
  assertNoSymlinkPath,
  existingVersionFolders,
  git,
  gitRemote,
  gitStatus,
  groupBy,
  hasTreeAt,
  isAncestor,
  lstatOrNull,
  put,
  tagDate,
  tagExists,
  TagContentError,
  markerRecordAt,
  writeFile,
  writeSummary,
} from './files.mjs'
import { planSharedArea, snapshotAreaState, writeSharedArea } from './shared.mjs'
import { planBranchVersions, planVersion } from './release.mjs'
import { classifyStagedEffects, publishWithRetry, sourceBranchMoved, syncToBranch } from './push.mjs'
import { NO_PRUNE, applyPrune, planPrune, pruneSummary, stalePruneSummary } from './prune.mjs'
import { mirrorSummary, planMirrorWrites, prepareMirrors, writeMirrors } from './mirror.mjs'
import { docsRoot } from './root.mjs'

function readReconcileArea(source, docs, root, entry, prune) {
  const areaDir = path.posix.join(root, entry.area)
  const tagNames = readTagNames(source, entry)
  const tags = git(source, ['tag', '--list']).split('\n').filter(Boolean)
  const packages = []
  for (const tag of tags) {
    const release = matchTag(tag)
    if (!release || (entry.packages !== undefined) !== Boolean(release.name)) continue
    const name = release.name ? folderForTagName(tagNames, release.name) : null
    // A package whose folder is gone from source_branch is retired: its tags are not republished and prune deletes its docs.
    let note = null
    if (name) {
      const folder = path.posix.join(entry.packages, name)
      if (!hasTreeAt(source, 'HEAD', folder)) note = 'retired'
      else if (!hasTreeAt(source, `refs/tags/${tag}`, folder)) note = 'no folder'
    }
    packages.push({
      name,
      version: release.version,
      prerelease: release.prerelease,
      tag,
      versionDir: path.posix.join(areaDir, ...(name ? [name] : []), release.version),
      files: null,
      note,
    })
  }
  return {
    entry,
    areaDir,
    packages,
    areaFiles: readAreaFiles(source, areaDir, entry),
    state: snapshotAreaState(docs, root, areaDir, entry, prune.isPruned),
  }
}

function cleanSource(source) {
  git(source, ['reset', '--quiet', '--hard', 'HEAD'])
  git(source, ['clean', '-fdqx'])
}

// The tags a reconcile can never publish are named without a checkout.
function noteUnpublishable(source, area, pkg) {
  if (pkg.note) return
  if (!tagExists(source, pkg.tag)) pkg.note = 'missing tag'
  else if (pkg.prerelease && !area.entry.prereleases) pkg.note = 'prerelease'
}

function readFromTag(source, root, area, pkg, repository) {
  cleanSource(source)
  git(source, ['checkout', '--quiet', '--detach', `refs/tags/${pkg.tag}`])
  try {
    pkg.files = planVersion({
      source,
      root,
      entry: area.entry,
      release: { name: pkg.name, version: pkg.version },
      repository,
      tag: pkg.tag,
      date: tagDate(source, pkg.tag),
    }).files
  } catch (error) {
    // An old tag whose content does not fit today's settings is skipped and reported; the rest still publish.
    if (!(error instanceof TagContentError)) throw error
    pkg.note = 'content'
    pkg.reason = error.message
  }
}

// Checking out a tag, building it and collecting its files is the expensive part of a reconcile, and the build runs
// the tag's own code. So only the tags this run publishes are read: a Version folder the docs already hold with the
// current specHash costs one marker read. A retry reads only what the first attempt did not.
function readTags(source, root, pending, repository) {
  const unread = pending.filter(({ pkg }) => !pkg.files && !pkg.note)
  if (unread.length === 0) return
  const start = gitStatus(source, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim()
    || git(source, ['rev-parse', 'HEAD'])
  try {
    for (const { area, pkg } of unread) readFromTag(source, root, area, pkg, repository)
  } finally {
    cleanSource(source)
    git(source, ['checkout', '--quiet', '--force', start, '--'])
  }
}

// The packages whose Version folder this run writes: the ones the docs do not hold, and the ones published from an
// older spec. The rest are reported here as kept or stale.
function versionsToWrite(docs, area, { source, repository, root, sourceMoved, report }) {
  const pending = []
  for (const pkg of area.packages) {
    assertNoSymlinkPath(docs, pkg.versionDir)
    const existing = lstatOrNull(path.join(docs, pkg.versionDir))
    let metadata
    try { metadata = markerRecordAt(docs, root, pkg.versionDir) } catch (error) {
      if (!(error instanceof FatalError)) throw error
      continue // Shared planning aggregates every refused marker before any write.
    }
    if (metadata?.source === repository) {
      // One Version folder holds one tag's bytes: only the tag that published it may republish it.
      if (metadata.tag !== pkg.tag) {
        throw new FatalError(`refusing to republish \`${pkg.versionDir}\` from \`${pkg.tag}\`: it holds the Version of \`${metadata.tag}\``)
      }
      if (!tagExists(source, metadata.tag)) continue
      if (metadata.specHash === specHash(area.entry)) {
        report.kept.push(pkg.versionDir)
        continue
      }
      // A run whose checkout is behind the source branch tip reads an older entry than the one that published
      // this Version, so it cannot tell which spec is newer: it keeps the bytes the docs already hold.
      if (sourceMoved) {
        report.specStale.push(pkg.versionDir)
        continue
      }
    } else if (existing) continue // Unmigrated or invalid folders are rejected by the shared-file guards.
    pending.push({ area, pkg, existing })
  }
  return pending
}

function areaHasUnmergedRelease(source, docs, area) {
  const tags = readTagNames(source, area.entry)
  return existingVersionFolders(docs, area.areaDir, area.entry).some(({ name, version }) => {
    const tag = tagForVersionFolder(tags, name, version)
    return tagExists(source, tag) && !isAncestor(source, `refs/tags/${tag}`, 'HEAD')
  })
}

const list = (dirs) => dirs.map((dir) => `\`${dir}\``).join(', ')

function reconcileSummary({ names, docsBranch, sourceBranch, changed, report }) {
  const lines = names ? [
    changed
      ? `Reconciled \`${names}\` to \`${docsBranch}\`.`
      : `Nothing to reconcile: the docs repo already holds \`${names}\`.`,
  ] : []
  if (report.published.length > 0) lines.push(`- Published ${list(report.published)}.`)
  if (report.republished.length > 0) lines.push(`- Republished ${list(report.republished)}: spec changed.`)
  if (report.branches.some((branch) => branch.changed)) {
    lines.push(`- Published the Branch Version folders ${list(report.branches.filter((branch) => branch.changed).map((branch) => branch.dir))}.`)
  }
  if (report.kept.length > 0) {
    lines.push(`- Kept ${list(report.kept)}: specHash matches the current entry.`)
  }
  if (report.untagged.length > 0) {
    lines.push(`- Kept ${list(report.untagged)}: no matching tag in this repo to republish ${report.untagged.length === 1 ? 'it' : 'them'} from.`)
  }
  return [...lines, ...skippedReconcileLines({ sourceBranch, ...report })].join('\n')
}

// `sourceBranch` names where the entries and tags are read from: a retirement is decided there, not in the docs repo.
export function skippedReconcileLines({ sourceBranch, areaFilesSkipped, skipped, specStale = [], branchStale = [] }) {
  const lines = areaFilesSkipped.map(({ dir, reason }) => `- Skipped Area files for \`${dir}\`: ${reason}.`)
  if (specStale.length > 0) {
    lines.push(`- Skipped ${list(specStale)}: the source branch \`${sourceBranch}\` moved past the checkout, so this run cannot tell whether a newer spec is already published.`)
  }
  if (branchStale.length > 0) {
    lines.push(`- Skipped ${list(branchStale)}: the source branch \`${sourceBranch}\` moved past the checkout, so this run cannot tell whether a newer build is already published.`)
  }
  const retired = skipped.filter((pkg) => pkg.note === 'retired').map((pkg) => pkg.tag)
  const noFolder = skipped.filter((pkg) => pkg.note === 'no folder').map((pkg) => pkg.tag)
  if (retired.length > 0) lines.push(`- Skipped ${list(retired)}: the package folder is gone from \`${sourceBranch}\`, so the package is retired.`)
  if (noFolder.length > 0) lines.push(`- Skipped ${list(noFolder)}: the package folder does not exist at that tag.`)
  const missing = skipped.filter((pkg) => pkg.note === 'missing tag').map((pkg) => pkg.tag)
  const prereleases = skipped.filter((pkg) => pkg.note === 'prerelease').map((pkg) => pkg.tag)
  if (missing.length > 0) lines.push(`- Skipped ${list(missing)}: no such tag.`)
  if (prereleases.length > 0) {
    lines.push(`- Skipped ${list(prereleases)}: a prerelease, and the entry does not publish prereleases.`)
  }
  const unfit = groupBy(skipped.filter((pkg) => pkg.note === 'content'), (pkg) => pkg.reason)
  for (const [reason, packages] of unfit) {
    lines.push(`- Skipped ${list(packages.map((pkg) => pkg.tag))}: its content does not fit the entry (${reason}).`)
  }
  return lines
}

export function planReconcileWrites(docs, areas, { source, repository, root, sourceBranch, sourceMoved = false }) {
  const report = { published: [], republished: [], branches: [], kept: [], untagged: [], skipped: [], areaFilesSkipped: [], specStale: [], branchStale: [] }
  const writes = new Map()
  const written = []
  const revision = areas.some((area) => area.entry.publishSourceBranch === true) ? git(source, ['rev-parse', 'HEAD']) : null
  const pending = new Map(areas.map((area) => [area, versionsToWrite(docs, area, { source, repository, root, sourceMoved, report })]))
  readTags(source, root, [...pending.values()].flat(), repository)
  for (const area of areas) {
    const files = new Map()
    const versions = []
    written.push({ area: area.entry.area, areaDir: area.areaDir, files, versions })
    for (const { pkg, existing } of pending.get(area)) {
      if (!pkg.files) {
        report.skipped.push(pkg)
        continue
      }
      for (const [rel, file] of pkg.files) put(files, rel, file)
      versions.push(pkg)
      if (existing) report.republished.push(pkg.versionDir)
      else report.published.push(pkg.versionDir)
    }
    // Hand-written metadata for a version with no tag: kept as it is, since nothing can republish it.
    for (const folder of existingVersionFolders(docs, area.areaDir, area.entry)) {
      let owner
      try { owner = markerRecordAt(docs, root, folder.dir) } catch (error) {
        if (!(error instanceof FatalError)) throw error
        continue // Shared planning reports the refusal with the other Area problems.
      }
      if (owner?.source === repository && !tagExists(source, owner.tag)) report.untagged.push(folder.dir)
    }
    // The Branch Version folder holds the source branch tip's build output: every reconcile publishes it, so a
    // folder that was deleted comes back. A checkout behind the branch tip plans none, like the specs above.
    if (area.entry.publishSourceBranch === true) {
      for (const branch of planBranchVersions({
        source, root, entry: area.entry, repository, branch: sourceBranch, revision, names: undefined,
      })) {
        if (sourceMoved) {
          report.branchStale.push(branch.dir)
          continue
        }
        // The folder is replaced whole below, so its path and its owners are checked here, before any removal. A
        // folder with no marker of its own is hand-made, and the replacement would delete its files.
        assertBranchReplaceable(docs, root, branch.dir, area.entry.area, repository)
        assertAreaWritable(docs, branch.dir, new Set(), [branch.dir])
        // Only a folder whose marker moves is a change: the build output of one branch tip is one folder.
        const marker = `${branch.dir}/.meta.json`
        const existing = lstatOrNull(path.join(docs, marker))?.isFile() ? fs.readFileSync(path.join(docs, marker), 'utf8') : null
        for (const [rel, file] of branch.files) put(files, rel, file)
        report.branches.push({ dir: branch.dir, existed: existing !== null, changed: existing !== branch.files.get(marker).content })
      }
    }
    let skipReason
    if (area.areaFiles.size > 0) {
      if (snapshotAreaState(docs, root, area.areaDir, area.entry) !== area.state) {
        skipReason = "the Area's shared files changed since Reconcile started"
      } else if (areaHasUnmergedRelease(source, docs, area)) {
        skipReason = "a published version's tag is not an ancestor of the manual checkout"
      }
    }
    if (skipReason) {
      report.areaFilesSkipped.push({ dir: area.areaDir, reason: skipReason })
      for (const rel of area.areaFiles.keys()) {
        assertNoSymlinkPath(docs, rel)
        if (lstatOrNull(path.join(docs, rel))?.isFile()) put(files, rel, { content: fs.readFileSync(path.join(docs, rel)) })
      }
    } else {
      for (const [rel, file] of area.areaFiles) put(files, rel, file)
    }
    for (const [rel, file] of files) put(writes, rel, file)
  }
  assertNoNestedWrites(docs, written, root)
  for (const rel of writes.keys()) assertNoSymlinkPath(docs, rel)
  return { areas: written, files: writes, report }
}

// Plan mode checks placement per Area, so placement and shared-file problems stay in Area order.
export function planReconcileSharedAreas({ args, repository, root, areas, reconcile, checkPlacement }) {
  const shared = []
  const problems = []
  for (const [index, area] of areas.entries()) {
    try {
      checkPlacement?.(area)
      shared.push(planSharedArea({
        docs: args.docs, root, entry: area.entry, repository, branch: args.branch,
        sourceBranch: args['source-branch'],
        docsRepository: args['docs-repository'], versions: reconcile.areas[index].versions,
        areaFiles: new Map([...reconcile.files].filter(([rel]) => path.posix.dirname(rel) === area.areaDir)),
      }))
    } catch (error) {
      if (!(error instanceof FatalError)) throw error
      problems.push(error.message)
    }
  }
  return { shared, problems }
}

// Two tags can resolve to one Version folder through the tagNames fallback or the unnamed layout, and one folder
// holds one tag's bytes. Which tag would win depends on tag order, so the run stops instead of picking one.
function rejectMergedVersionFolders(areas) {
  const claimed = new Map()
  for (const area of areas) {
    for (const pkg of area.packages) {
      const other = claimed.get(pkg.versionDir)
      if (other !== undefined) {
        throw new FatalError(`two tags publish one Version folder \`${pkg.versionDir}\`: \`${other}\` and \`${pkg.tag}\``)
      }
      claimed.set(pkg.versionDir, pkg.tag)
    }
  }
}

export function prepareReconcile({ args, repository, root, prune }) {
  const entries = readEntries(args.entries, args['source-branch']).filter((entry) => entry.mode === 'release')
  if (entries.length === 0) {
    writeSummary('No release entries to reconcile. Add entries to `.github/docs_publisher.yaml`.')
    return []
  }

  const fetch = gitRemote(args.source, ['fetch', '--quiet', '--force', '--tags', 'origin'])
  if (fetch.status !== 0) throw new FatalError(`git fetch failed: ${fetch.stderr.trim()}`)
  const areas = entries.map((entry) => readReconcileArea(args.source, args.docs, root, entry, prune))
  rejectMergedVersionFolders(areas)
  for (const area of areas) {
    for (const pkg of area.packages) noteUnpublishable(args.source, area, pkg)
  }

  return areas
}

export function publishReconcile({ args, repository, root }) {
  const scope = docsRoot(root)
  const entries = readEntries(args.entries, args['source-branch'])
  syncToBranch(args.docs, args.branch)
  const pruneArgs = { docs: args.docs, source: args.source, root, repository, entries }
  const initial = planPrune(pruneArgs)
  const areas = prepareReconcile({ args, repository, root, prune: initial })
  const { mirrors } = prepareMirrors({
    args: { ...args, before: undefined, after: undefined }, repository, root,
  })
  if (areas.length === 0 && mirrors.length === 0 && !initial.hasWork) return { changed: false, commitSha: null }
  let report
  let prune = initial
  let sourceMoved = false
  // The mirrors the commit changed: the run publishes every matching mirror, but only a staged write is a publish.
  let committed
  let releaseEffects = []
  const names = areas.map((area) => area.entry.area).join(' ')
  const { changed, commitSha } = publishWithRetry({
    docs: args.docs,
    branch: args.branch,
    areaDirs: [...areas, ...mirrors].map((area) => area.areaDir),
    message: () => {
      committed = classifyStagedEffects(args.docs, { mirrors, releases: releaseEffects, prune })
      const changedNames = [...committed.releases, ...committed.mirrors].map((area) => area.area)
      return changedNames.length > 0
        ? `docs: reconcile ${changedNames.join(' ')}`
        : `docs: prune ${committed.prune.removals.map(({ dir }) => scope.relative(dir)).join(' ')}`
    },
    write: () => {
      // Prune only from a source checkout that is still the branch tip: a retry after the branch moved would
      // otherwise delete docs that a newer push brought back. For the same reason the run publishes no spec an
      // older entry planned.
      sourceMoved = sourceBranchMoved(args.source, args['source-branch'])
      // Prune first, so that Areas freed by it (a retired package, a mode change) can be written again below.
      prune = sourceMoved ? NO_PRUNE : planPrune(pruneArgs)
      // A Branch Version marker names its release Area, so it can prove the Area belongs to another repo: the run
      // stops here, before the prune deletes anything and before it writes into any Area.
      const pruned = applyPrune(args.docs, prune, root)
      const reconcile = planReconcileWrites(args.docs, areas, {
        source: args.source, repository, root, sourceBranch: args['source-branch'], sourceMoved,
      })
      const writable = planMirrorWrites({ args, repository, mirrors, releaseFiles: reconcile.files })
      const writes = [...reconcile.areas, ...writable]
      assertNoNestedWrites(args.docs, writes, root)
      const files = new Map(reconcile.files)
      for (const area of writable) {
        for (const [rel, file] of area.files) put(files, rel, file)
      }
      for (const area of reconcile.areas) assertAreaPlacement(args.docs, area.areaDir, root, 'release', files)
      const { shared, problems } = planReconcileSharedAreas({ args, repository, root, areas, reconcile })
      if (problems.length) throw new FatalError([...new Set(problems)].join('\n'))
      report = reconcile.report
      releaseEffects = reconcile.areas.map((area, index) => ({
        area: area.area, areaDir: area.areaDir,
        // A replaced folder can lose a file and gain none, so the folder itself counts as the Area's path.
        paths: [
          ...area.files.keys(), ...shared[index].files.keys(), ...shared[index].removals,
          ...[...reconcile.report.republished, ...reconcile.report.branches.map((branch) => branch.dir)]
            .filter((dir) => dir.startsWith(`${area.areaDir}/`)),
        ],
      }))
      writeMirrors(args.docs, writable)
      for (const dir of reconcile.report.republished) fs.rmSync(path.join(args.docs, dir), { recursive: true, force: true })
      // A Branch Version folder holds one build output: replacing it whole is what removes a file it no longer has.
      for (const branch of reconcile.report.branches) fs.rmSync(path.join(args.docs, branch.dir), { recursive: true, force: true })
      for (const [rel, file] of reconcile.files) writeFile(args.docs, rel, file)
      return [...files.keys(), ...shared.flatMap((plan) => writeSharedArea(args.docs, plan)), ...pruned]
    },
  })
  pruneSummary(changed ? committed.prune : prune, args.branch, changed)
  if (sourceMoved) stalePruneSummary(args['source-branch'])
  if (areas.length > 0) writeSummary(
    reconcileSummary({
      names: changed ? committed.releases.map((area) => area.area).join(' ') : names,
      docsBranch: args.branch,
      sourceBranch: args['source-branch'],
      changed,
      report,
    }),
  )
  mirrorSummary(changed ? committed.mirrors : mirrors, args.branch, changed)
  return { changed, commitSha }
}
