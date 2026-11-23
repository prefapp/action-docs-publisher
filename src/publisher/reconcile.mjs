
import fs from 'node:fs'
import path from 'node:path'
import { matchTag, readEntries, specHash } from './entries.mjs'
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
  keptAreaFiles,
  lstatOrNull,
  metaFile,
  put,
  tagDate,
  tagCommit,
  tagExists,
  TagContentError,
  markerRecordAt,
  writeFile,
  writeSummary,
} from './files.mjs'
import { planSharedArea, snapshotAreaState, writeSharedArea } from './shared.mjs'
import { planAreaSkips } from './skipped.mjs'
import { planBranchVersions, planVersion } from './release.mjs'
import { versionTargeting } from './version-folders.mjs'
import { classifyStagedEffects, publishWithRetry, sourceBranchMoved, syncToBranch } from './push.mjs'
import { NO_PRUNE, applyPrune, planPrune, pruneSummary, stalePruneSummary } from './prune.mjs'
import { mirrorSummary, planMirrorWrites, prepareMirrors, writeMirrors } from './mirror.mjs'
import { docsRoot } from './root.mjs'

function readReconcileArea(source, docs, root, entry, prune) {
  const areaDir = path.posix.join(root, entry.area)
  const targeting = versionTargeting({ source, root, entry })
  const tags = git(source, ['tag', '--list']).split('\n').filter(Boolean)
  const packages = []
  for (const tag of tags) {
    const release = matchTag(tag)
    if (!release || (entry.packages !== undefined) !== Boolean(release.name)) continue
    const target = targeting.forTag(release)
    // A package whose folder is gone from source_branch is retired: its tags are not republished and prune deletes its docs.
    const note = target.folder !== null && !hasTreeAt(source, 'HEAD', target.folder) ? 'retired' : null
    packages.push({ ...target, prerelease: release.prerelease, tag, files: null, note })
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

function resolveTag(source, area, pkg) {
  const revision = tagCommit(source, pkg.tag)
  if (pkg.note === 'retired') {
    pkg.sourceRevision = revision ?? undefined
    return
  }
  if (revision !== pkg.sourceRevision) {
    if (pkg.sourceRevision !== undefined) {
      pkg.files = null
      pkg.reason = undefined
      if (pkg.note === 'content') pkg.note = undefined
    }
    pkg.sourceRevision = revision ?? undefined
  }
  if (revision === null) {
    pkg.note = 'missing tag'
    return
  }
  if (pkg.folder !== null && !hasTreeAt(source, revision, pkg.folder)) pkg.note = 'no folder'
  else if (pkg.note === 'no folder') pkg.note = undefined
  if (!pkg.note && pkg.prerelease && !area.entry.prereleases) pkg.note = 'prerelease'
}

function readFromTag(source, area, pkg, repository) {
  cleanSource(source)
  // The commit the run resolved, not the tag ref: the ref can move after the resolution, and the marker records the
  // commit the bytes came from.
  git(source, ['checkout', '--quiet', '--detach', pkg.sourceRevision])
  try {
    pkg.files = planVersion({
      source,
      entry: area.entry,
      target: pkg,
      repository,
      tag: pkg.tag,
      sourceRevision: pkg.sourceRevision,
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
// current specHash and tag commit costs one marker read. A retry reads only what the first attempt did not.
function readTags(source, pending, repository) {
  const unread = pending.filter(({ pkg }) => !pkg.files && !pkg.note)
  if (unread.length === 0) return
  const start = gitStatus(source, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim()
    || git(source, ['rev-parse', 'HEAD'])
  try {
    for (const { area, pkg } of unread) readFromTag(source, area, pkg, repository)
  } finally {
    cleanSource(source)
    git(source, ['checkout', '--quiet', '--force', start])
  }
}

// The packages whose Version folder this run writes: the ones the docs do not hold, the ones published from an
// older spec, and the ones whose tag now points at another commit. The rest are reported here as kept or stale; a
// marker from before the publisher recorded the tag's commit has that commit stamped into it in place, with no
// checkout, when its spec and bytes still hold.
function versionsToWrite(docs, area, { source, repository, root, sourceMoved, report }) {
  const pending = []
  const stamps = []
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
      const specChanged = metadata.specHash !== specHash(area.entry)
      const revisionChanged = metadata.sourceRevision !== undefined && metadata.sourceRevision !== pkg.sourceRevision
      if (!specChanged && !revisionChanged) {
        if (metadata.sourceRevision === undefined && !sourceMoved && pkg.sourceRevision !== undefined) {
          const rel = `${pkg.versionDir}/.meta.json`
          const fields = JSON.parse(fs.readFileSync(path.join(docs, rel), 'utf8'))
          stamps.push({ rel, file: metaFile({ ...fields, sourceRevision: pkg.sourceRevision }) })
          report.stamped.push(pkg.versionDir)
        } else {
          report.kept.push(pkg.versionDir)
        }
        continue
      }
      // A run whose checkout is behind the source branch tip reads an older entry and an older tag than the ones
      // that published this Version, so it cannot tell which is newer: it keeps the bytes the docs already hold.
      if (sourceMoved) {
        if (specChanged) report.versionStale.push(pkg.versionDir)
        else report.buildStale.push(pkg.versionDir)
        continue
      }
      pkg.reason = specChanged ? 'spec' : 'moved'
    } else if (existing) continue // Unmigrated or invalid folders are rejected by the shared-file guards.
    pending.push({ area, pkg, existing })
  }
  return { pending, stamps }
}

function areaHasUnmergedRelease(source, docs, root, area) {
  const targeting = versionTargeting({ source, root, entry: area.entry })
  return existingVersionFolders(docs, area.areaDir, area.entry).some(({ name, version }) => {
    const tag = targeting.tagFor(name, version)
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
  if (report.moved.length > 0) lines.push(`- Republished ${list(report.moved)}: its tag points at a different commit.`)
  if (report.branches.some((branch) => branch.changed)) {
    lines.push(`- Published the Branch Version folders ${list(report.branches.filter((branch) => branch.changed).map((branch) => branch.dir))}.`)
  }
  if (report.kept.length > 0) {
    lines.push(`- Kept ${list(report.kept)}: specHash matches the current entry.`)
  }
  if (report.stamped.length > 0) {
    lines.push(`- Recorded the source revision in ${list(report.stamped)}.`)
  }
  if (report.untagged.length > 0) {
    lines.push(`- Kept ${list(report.untagged)}: no matching tag in this repo to republish ${report.untagged.length === 1 ? 'it' : 'them'} from.`)
  }
  return [...lines, ...skippedReconcileLines({ sourceBranch, ...report })].join('\n')
}

function previouslySkippedLine(reused) {
  return `- ${reused.length} previously skipped ${reused.length === 1 ? 'tag' : 'tags'} unchanged.`
}

// `sourceBranch` names where the entries and tags are read from: a retirement is decided there, not in the docs repo.
export function skippedReconcileLines({
  sourceBranch, areaFilesSkipped, skips = [], versionStale = [], buildStale = [], branchStale = [], collapse = false,
}) {
  const reused = skips.filter((skip) => skip.reused)
  const fresh = skips.filter((skip) => !skip.reused)
  const lines = areaFilesSkipped.map(({ dir, reason }) => `- Skipped Area files for \`${dir}\`: ${reason}.`)
  if (versionStale.length > 0) {
    lines.push(`- Skipped ${list(versionStale)}: the source branch \`${sourceBranch}\` moved past the checkout, so this run cannot tell whether a newer spec is already published.`)
  }
  if (buildStale.length > 0) {
    lines.push(`- Skipped ${list(buildStale)}: the source branch \`${sourceBranch}\` moved past the checkout, so this run cannot tell whether a newer build of the tag is already published.`)
  }
  if (branchStale.length > 0) {
    lines.push(`- Skipped ${list(branchStale)}: the source branch \`${sourceBranch}\` moved past the checkout, so this run cannot tell whether a newer build is already published.`)
  }
  if (reused.length > 0) lines.push(previouslySkippedLine(reused))
  const tags = []
  const withSkip = (reason) => fresh.filter((skip) => skip.skip === reason).map(({ tag }) => tag)
  const retired = withSkip('retired')
  const noFolder = withSkip('no folder')
  if (retired.length > 0) tags.push(`- Skipped ${list(retired)}: the package folder is gone from \`${sourceBranch}\`, so the package is retired.`)
  if (noFolder.length > 0) tags.push(`- Skipped ${list(noFolder)}: the package folder does not exist at that tag.`)
  const missing = withSkip('missing tag')
  const prereleases = withSkip('prerelease')
  if (missing.length > 0) tags.push(`- Skipped ${list(missing)}: no such tag.`)
  if (prereleases.length > 0) {
    tags.push(`- Skipped ${list(prereleases)}: a prerelease, and the entry does not publish prereleases.`)
  }
  const unfit = groupBy(fresh.filter((skip) => skip.skip === 'content'), (skip) => skip.detail)
  for (const [detail, skipsOfDetail] of unfit) {
    tags.push(`- Skipped ${list(skipsOfDetail.map(({ tag }) => tag))}: its content does not fit the entry (${detail}).`)
  }
  // A batch of more than ten skipped tags is folded away, with the blank lines the block needs for its inner
  // markdown to render. Real changes are never folded: only these skip lines reach here.
  if (collapse && fresh.length > 10) {
    lines.push(`<details><summary>Skipped ${fresh.length} tags</summary>`, '', ...tags, '', '</details>')
  } else {
    lines.push(...tags)
  }
  return lines
}

export function planReconcileWrites(docs, areas, { source, repository, root, sourceBranch, sourceMoved = false, writeSkippedTags = false }) {
  const report = { published: [], republished: [], moved: [], branches: [], kept: [], stamped: [], untagged: [], skips: [], areaFilesSkipped: [], versionStale: [], buildStale: [], branchStale: [] }
  const writes = new Map()
  const written = []
  const removals = []
  for (const area of areas) {
    for (const pkg of area.packages) resolveTag(source, area, pkg)
  }
  const revision = areas.some((area) => area.entry.publishSourceBranch === true) ? git(source, ['rev-parse', 'HEAD']) : null
  const planned = new Map(areas.map((area) => [area, versionsToWrite(docs, area, { source, repository, root, sourceMoved, report })]))
  for (const area of areas) {
    const plan = planned.get(area)
    plan.skips = planAreaSkips({ docs, areaDir: area.areaDir, entry: area.entry, repository })
    plan.skips.reuse(plan.pending)
  }
  readTags(source, [...planned.values()].flatMap(({ pending }) => pending), repository)
  for (const area of areas) {
    const files = new Map()
    const versions = []
    written.push({ area: area.entry.area, areaDir: area.areaDir, files, versions })
    const { pending, stamps, skips } = planned.get(area)
    for (const { rel, file } of stamps) put(files, rel, file)
    for (const { pkg, existing } of pending) {
      if (!pkg.files) {
        skips.record(pkg)
        continue
      }
      for (const [rel, file] of pkg.files) put(files, rel, file)
      versions.push(pkg)
      if (existing) {
        if (pkg.reason === 'moved') report.moved.push(pkg.versionDir)
        else report.republished.push(pkg.versionDir)
      } else report.published.push(pkg.versionDir)
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
    if (snapshotAreaState(docs, root, area.areaDir, area.entry) !== area.state) {
      skipReason = "the Area's shared files changed since Reconcile started"
    } else if (area.areaFiles.size > 0 && areaHasUnmergedRelease(source, docs, root, area)) {
      skipReason = "a published version's tag is not an ancestor of the manual checkout"
    }
    // A checkout behind the branch tip may read an older entry than the one that published the Area files: it keeps
    // the docs ones, whether or not its own entry names any.
    if (!skipReason && sourceMoved) {
      skipReason = `the source branch \`${sourceBranch}\` moved past the checkout, so this run cannot tell whether newer ones are already published`
    }
    if (skipReason) {
      report.areaFilesSkipped.push({ dir: area.areaDir, reason: skipReason })
      for (const [rel, file] of keptAreaFiles(docs, area.areaDir, area.entry)) put(files, rel, file)
    } else {
      for (const [rel, file] of area.areaFiles) put(files, rel, file)
    }
    if (writeSkippedTags && !skipReason) {
      const change = skips.change()
      if (change?.file) put(files, change.rel, change.file)
      else if (change?.remove) removals.push(change.rel)
    }
    report.skips.push(...skips.outcomes())
    for (const [rel, file] of files) put(writes, rel, file)
  }
  assertNoNestedWrites(docs, written, root)
  for (const rel of writes.keys()) assertNoSymlinkPath(docs, rel)
  return { areas: written, files: writes, removals, report }
}

// Plan mode checks placement per Area, so placement and shared-file problems stay in Area order.
export function planReconcileSharedAreas({ args, repository, root, areas, reconcile, checkPlacement }) {
  const shared = []
  const problems = []
  for (const [index, area] of areas.entries()) {
    try {
      checkPlacement?.(area)
      shared.push({
        areaDir: area.areaDir,
        entry: area.entry,
        ...planSharedArea({
          docs: args.docs, root, entry: area.entry, repository, branch: args.branch,
          docsRepository: args['docs-repository'], versions: reconcile.areas[index].versions,
          areaFiles: new Map([...reconcile.files].filter(([rel]) => path.posix.dirname(rel) === area.areaDir)),
        }),
      })
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

  // `--prune-tags` makes origin the only list: a tag deleted there is gone from this clone too, and this run does not
  // republish from a ref the remote no longer has.
  const fetch = gitRemote(args.source, ['fetch', '--quiet', '--force', '--tags', '--prune', '--prune-tags', 'origin'])
  if (fetch.status !== 0) throw new FatalError(`git fetch failed: ${fetch.stderr.trim()}`)
  const areas = entries.map((entry) => readReconcileArea(args.source, args.docs, root, entry, prune))
  rejectMergedVersionFolders(areas)
  for (const area of areas) {
    for (const pkg of area.packages) resolveTag(args.source, area, pkg)
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
        source: args.source, repository, root, sourceBranch: args['source-branch'], sourceMoved, writeSkippedTags: true,
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
          ...reconcile.removals.filter((rel) => rel.startsWith(`${area.areaDir}/`)),
          ...[...reconcile.report.republished, ...reconcile.report.moved, ...reconcile.report.branches.map((branch) => branch.dir)]
            .filter((dir) => dir.startsWith(`${area.areaDir}/`)),
        ],
      }))
      writeMirrors(args.docs, writable)
      for (const rel of reconcile.removals) fs.rmSync(path.join(args.docs, rel), { force: true })
      for (const dir of [...reconcile.report.republished, ...reconcile.report.moved]) fs.rmSync(path.join(args.docs, dir), { recursive: true, force: true })
      // A Branch Version folder holds one build output: replacing it whole is what removes a file it no longer has.
      for (const branch of reconcile.report.branches) fs.rmSync(path.join(args.docs, branch.dir), { recursive: true, force: true })
      for (const [rel, file] of reconcile.files) writeFile(args.docs, rel, file)
      return [
        ...reconcile.removals, ...files.keys(),
        ...shared.flatMap((plan) => writeSharedArea(args.docs, plan)), ...pruned,
      ]
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
