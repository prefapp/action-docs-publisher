
import fs from 'node:fs'
import path from 'node:path'
import { nestedRepoPath, readEntries, specHash } from './entries.mjs'
import {
  FatalError,
  TagContentError,
  readAreaFiles,
  assertCollectable,
  assertNoFileFolderConflicts,
  assertRecordOwners,
  assertNoSymlinkAncestors,
  assertNoSymlinkPath,
  collectFiles,
  commitDate,
  folderNames,
  git,
  gitStatus,
  isAncestor,
  keptAreaFiles,
  keptAreaFilesSummary,
  lstatOrNull,
  metaFile,
  put,
  runBuild,
  staleAreaFilesSummary,
  tagDate,
  tagCommit,
  markerRecordAt,
  withTagWorktree,
  writeFile,
  writeSummary,
} from './files.mjs'
import { publishWithRetry, originTagRevision, sourceBranchMoved, syncToBranch } from './push.mjs'
import { applySkippedTagsChange, planTagClear, readSkippedTags } from './skipped.mjs'
import { discoverAreas } from './discovery.mjs'
import { planSharedArea, snapshotAreaState, writeSharedArea } from './shared.mjs'
import { versionTargeting } from './version-folders.mjs'

// One package folder's collected content, keyed under `dir`. A Version folder and a Branch Version folder hold the
// same build output and differ only in their marker.
function collectPackage({ source, entry, name, dir, marker }) {
  const pkgDir = name ? path.join(source, entry.packages, name) : source
  if (name) assertNoSymlinkAncestors(source, path.posix.join(entry.packages, name))
  if (name && !lstatOrNull(pkgDir)?.isDirectory()) {
    throw new TagContentError(`package folder not found: ${entry.packages}/${name}`)
  }
  runBuild(entry, pkgDir, name ? `${entry.packages}/${name}` : 'the source checkout')

  const files = new Map()
  const rules = new Map()
  put(files, `${dir}/.meta.json`, metaFile(marker))
  rules.set(`${dir}/.meta.json`, 'the publisher')
  for (const rule of entry.collect) {
    for (const file of collectFiles(pkgDir, rule)) {
      const rel = path.posix.join(dir, file.to)
      assertCollectable(rel, path.relative(source, file.from), dir)
      put(files, rel, { content: file.content })
      rules.set(rel, `collect "${rule.from}" to "${rule.to}"`)
    }
  }
  assertNoFileFolderConflicts(entry.area, dir, rules)
  if (files.size === 1) throw new TagContentError('collect matched no files')
  return files
}

export function planVersion({ source, entry, target, repository, date, tag, sourceRevision }) {
  const files = collectPackage({
    source, entry, name: target.name, dir: target.versionDir,
    marker: { source: repository, tag, sourceRevision, date, specHash: specHash(entry) },
  })
  return { versionDir: target.versionDir, name: target.name, version: target.version, files }
}

// The folder a Branch Version is published into: the Area, the package name when the entry has packages, and the
// branch. The folder is removed and rewritten whole, so it has to sit inside its Area whatever the branch spells.
function branchVersionDir(root, entry, name, branch) {
  const areaDir = path.posix.join(root, entry.area)
  const dir = path.posix.join(areaDir, ...(name ? [name] : []), branch)
  if (!dir.startsWith(`${areaDir}/`)) {
    throw new FatalError(
      `refusing to publish the Branch Version folder of the Area "${entry.area}" outside it: "${branch}" leaves the Area`,
    )
  }
  return dir
}

// The Branch Version folder: the same content, built from the source branch tip, in the folder named after the
// branch, with a marker that names the release Area and the branch and holds no tag.
export function planBranchVersion({ source, root, entry, name, repository, branch, revision, date }) {
  const dir = branchVersionDir(root, entry, name, branch)
  const files = collectPackage({
    source, entry, name, dir,
    marker: { source: repository, area: entry.area, branch, sourceRevision: revision, date },
  })
  return { dir, name, files }
}

// The Branch Version folders one entry publishes: none unless it asks for them, and with `packages`, one per package
// folder, or only the packages `names` lists.
export function planBranchVersions({ source, root, entry, repository, branch, revision, names }) {
  if (entry.publishSourceBranch !== true) return []
  const packagesDir = entry.packages === undefined ? undefined : nestedRepoPath(entry.packages).path
  const wanted = names ?? (packagesDir === undefined ? [null] : folderNames(path.join(source, packagesDir)))
  if (wanted.length === 0) return []
  const date = commitDate(source, revision)
  return wanted.map((name) => planBranchVersion({ source, root, entry, name, repository, branch, revision, date }))
}

// The packages the changed paths sit in: an Area without `packages` holds every file, so any change names it, and a
// named layout names only the packages one of the paths sits in. A changed list the checkout could not read names none.
function touchedPackages({ source, entry, changed }) {
  if (changed === null) return []
  if (entry.packages === undefined) return [null]
  const packagesDir = nestedRepoPath(entry.packages).path
  const prefix = packagesDir === '.' ? '' : `${packagesDir}/`
  const names = changed.filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length).split('/')[0])
  return [...new Set(names)].filter((name) => name !== '' && lstatOrNull(path.join(source, packagesDir, name))?.isDirectory())
}

// The packages a push rebuilds its Branch Version folder for. The event range names only what that push changed, and a
// superseded push leaves its own package unpublished, so the folder's marker decides: it names the commit the build
// came from, and the paths that changed since then say whether the folder is stale. A folder built from a commit this
// checkout does not hold is older only when the checkout is the branch tip, and newer otherwise.
export function rebuildPackages({ source, docs, root, entry, branch, changed, tip }) {
  const head = git(source, ['rev-parse', 'HEAD'])
  const touched = new Set(touchedPackages({ source, entry, changed }))
  const diffs = new Map()
  const changedSince = (revision) => {
    if (!diffs.has(revision)) {
      const result = gitStatus(source, ['diff', '--no-renames', '--name-only', '-z', `${revision}..${head}`])
      diffs.set(revision, result.status === 0 ? result.stdout.split('\0').filter(Boolean) : null)
    }
    return diffs.get(revision)
  }
  const candidates = entry.packages === undefined
    ? [null]
    : folderNames(path.join(source, nestedRepoPath(entry.packages).path))
  return candidates.filter((name) => {
    let record
    try {
      record = markerRecordAt(docs, root, branchVersionDir(root, entry, name, branch))
    } catch (error) {
      // The folder's path or its marker is a symlink the reader refuses, and that refusal belongs to the guards that
      // run before anything is removed, outside this Area's containment. This read decides staleness alone, so the
      // folder is planned as one this repo never published and those guards get to refuse it.
      if (!(error instanceof FatalError)) throw error
      return tip && touched.has(name)
    }
    // A folder this repo never published holds the build of the package the push touched, and nothing else. Only a
    // checkout at the branch tip may create one: behind it, a newer run may have retired the folder already.
    if (record === null) return tip && touched.has(name)
    const revision = record.sourceRevision
    if (revision === head) return false
    if (isAncestor(source, revision, head)) {
      return touchedPackages({ source, entry, changed: changedSince(revision) }).includes(name)
    }
    // The folder holds a commit this checkout is behind, or a commit it shares no history with. Only a checkout at
    // the branch tip is authoritative for the second, so a rewrite of the source history still refreshes the folder.
    return tip && !isAncestor(source, head, revision)
  })
}

export function publishRelease({ args, release, repository, root }) {
  const sourceRevision = tagCommit(args.source, args.tag)
  if (sourceRevision === null) throw new FatalError(`tag ${args.tag} not found in ${args.source}`)
  const date = tagDate(args.source, args.tag)
  return withTagWorktree(args.source, args.tag, (tagSource) => publishAtTag(
    { args, release, repository, root, date, tagSource, sourceRevision },
  ))
}

function missingTagVersions({ docs, root, repository, tag, sourceRevision, missing }) {
  const kept = []
  const moved = []
  for (const area of missing) {
    const marker = publishedMarker(docs, root, area.versionDir, repository)
    if (marker?.tag !== tag) continue
    if (marker.sourceRevision === sourceRevision) kept.push(area)
    else moved.push(area)
  }
  return { kept, moved }
}

function movedTagProblems(tag, moved) {
  return [...new Set(moved.map(({ entry, name, versionDir }) =>
    `refusing to publish \`${tag}\` over \`${versionDir}\`: the tag points at a commit without the \`${entry.packages}/${name}\` folder, and the docs hold its Version. Its bytes are kept.`))]
}

function releaseStateProblems({ docs, root, entries }) {
  const problems = []
  for (const entry of entries) {
    try { readSkippedTags(docs, path.posix.join(root, entry.area)) } catch (error) {
      if (!(error instanceof FatalError)) throw error
      problems.push(error.message)
    }
  }
  return problems
}

function publishedMarker(docs, root, versionDir, repository) {
  const metadata = markerRecordAt(docs, root, versionDir)
  return metadata?.source === repository ? metadata : null
}

function publishAtTag({ args, release, repository, root, date, tagSource, sourceRevision }) {
  const candidates = readEntries(args.entries, args['source-branch']).filter(
    (entry) => entry.mode === 'release' && (entry.packages !== undefined) === Boolean(release.name),
  )
  const targets = new Map(candidates.map((entry) => [
    entry, versionTargeting({ source: args.source, root, entry }).forTag(release),
  ]))
  const releases = candidates.filter((entry) => {
    if (!release.name) return true
    const { folder } = targets.get(entry)
    assertNoSymlinkAncestors(tagSource, folder)
    return lstatOrNull(path.join(tagSource, folder))?.isDirectory() === true
  })
  const missing = candidates.filter((entry) => !releases.includes(entry)).map((entry) => ({
    entry, ...targets.get(entry),
  }))
  const keptMissing = new Set()
  const reportMissing = () => {
    for (const { entry, name, versionDir } of missing) {
      writeSummary(keptMissing.has(versionDir)
        ? `Already published \`${args.tag}\` in area \`${entry.area}\`: kept \`${versionDir}\` as it is.`
        : `Skipped \`${args.tag}\` for area \`${entry.area}\`: no \`${entry.packages}/${name}\` folder at the tag.`)
    }
  }
  const readReleaseState = () => {
    keptMissing.clear()
    const problems = releaseStateProblems({ docs: args.docs, root, entries: candidates })
    if (missing.length > 0) {
      const { kept, moved } = missingTagVersions({ docs: args.docs, root, repository, tag: args.tag, sourceRevision, missing })
      for (const { versionDir } of kept) keptMissing.add(versionDir)
      problems.push(...movedTagProblems(args.tag, moved))
    }
    if (problems.length > 0) throw new FatalError([...new Set(problems)].join('\n'))
  }
  if (releases.length === 0) {
    if (missing.length > 0) {
      syncToBranch(args.docs, args.branch)
      readReleaseState()
    }
    reportMissing()
    // With candidates, the per-area lines above already say why; the generic hint is only for "no entry at all".
    if (candidates.length === 0) writeSummary(`Skipped \`${args.tag}\`: no release entry publishes it. Add entries to \`.github/docs_publisher.yaml\`.`)
    return { changed: false, commitSha: null }
  }
  const published = releases.filter((entry) => entry.prereleases || !release.prerelease)
  if (published.length === 0) {
    syncToBranch(args.docs, args.branch)
    readReleaseState()
    reportMissing()
    writeSummary(`Skipped \`${args.tag}\`: a prerelease is published only by an entry with \`prereleases: true\`.`)
    return { changed: false, commitSha: null }
  }
  const areas = published.map((entry) => {
    const areaDir = path.posix.join(root, entry.area)
    return {
      entry,
      areaDir,
      ...targets.get(entry),
      areaFiles: readAreaFiles(args.source, areaDir, entry),
      state: null,
    }
  })
  const staleAreaFiles = new Set()
  const movedAreaFiles = new Set()
  // Which Areas this tag is already published in is decided against the docs branch as each attempt fetches
  // it, so a stale checkout or a rejected push cannot rewrite a Version another run already wrote.
  const kept = new Set()
  const { changed, commitSha } = publishWithRetry({
    docs: args.docs, branch: args.branch,
    areaDirs: areas.map((area) => area.areaDir),
    message: `docs: publish ${release.name ? `${release.name} ${release.version}` : release.version}`,
    write: () => {
      const problems = []
      const plans = []
      kept.clear()
      staleAreaFiles.clear()
      movedAreaFiles.clear()
      // One fetch per attempt, made only once a published Area's Area files need the answer.
      let moved
      const sourceMoved = () => (moved ??= sourceBranchMoved(args.source, args['source-branch']))
      const onOrigin = originTagRevision(args.source, args.tag)
      if (onOrigin === null) {
        throw new FatalError(
          `refusing to publish \`${args.tag}\`: origin holds no such tag, so this run cannot tell which commit published the docs. Publish the tag again from the commit it names.`,
        )
      }
      if (onOrigin !== sourceRevision) {
        throw new FatalError(
          `refusing to publish \`${args.tag}\`: origin names ${onOrigin}, but this run built ${sourceRevision}. A newer publish may already hold the docs; publish the tag again from the commit it names.`,
        )
      }
      // A Branch Version marker names its release Area, so it can prove the Area belongs to another repo: a release
      // stops here, before it writes a Version folder or an Area file.
      try { assertRecordOwners(discoverAreas(args.docs, root).claims, areas.map((area) => area.areaDir), root, repository) } catch (error) {
        if (!(error instanceof FatalError)) throw error
        problems.push(error.message)
      }
      try { readReleaseState() } catch (error) {
        if (!(error instanceof FatalError)) throw error
        problems.push(error.message)
      }
      for (const area of areas) {
        // The freshness reference is the docs state the first attempt sees, right after it synced the branch.
        area.state ??= snapshotAreaState(args.docs, root, area.areaDir, area.entry)
        const marker = publishedMarker(args.docs, root, area.versionDir, repository)
        if (marker?.tag === args.tag && marker.sourceRevision === sourceRevision) {
          kept.add(area)
          continue
        }
        if (marker && marker.tag !== args.tag) {
          problems.push(`refusing to publish \`${args.tag}\` over \`${marker.tag}\` in \`${area.versionDir}\`: a Version folder keeps the tag that published it`)
          continue
        }
        try {
          assertNoSymlinkPath(args.docs, area.versionDir)
          const version = planVersion({
            source: tagSource, entry: area.entry, target: area, repository, date, tag: args.tag, sourceRevision,
          })
          const fresh = snapshotAreaState(args.docs, root, area.areaDir, area.entry) === area.state
          // A newer push can publish the Area files before this attempt's first snapshot, and the snapshot then
          // calls the Area fresh: a checkout behind the branch tip keeps the files the docs branch holds instead,
          // whether or not its own entry still names any.
          if (!fresh) staleAreaFiles.add(area)
          else if (sourceMoved()) movedAreaFiles.add(area)
          plans.push({
            area,
            version,
            plan: planSharedArea({
              docs: args.docs, root, entry: area.entry, repository, branch: args.branch,
              docsRepository: args['docs-repository'], versions: [version],
              areaFiles: fresh && !moved ? area.areaFiles : keptAreaFiles(args.docs, area.areaDir, area.entry),
            }),
          })
        } catch (error) {
          if (!(error instanceof FatalError)) throw error
          problems.push(error.message)
        }
      }
      if (problems.length) throw new FatalError([...new Set(problems)].join('\n'))
      for (const { version } of plans) {
        fs.rmSync(path.join(args.docs, version.versionDir), { recursive: true, force: true })
        for (const [rel, file] of version.files) writeFile(args.docs, rel, file)
      }
      const cleared = plans
        .map(({ area }) => planTagClear({ docs: args.docs, areaDir: area.areaDir, tag: args.tag, repository }))
        .filter(Boolean)
      for (const change of cleared) applySkippedTagsChange(args.docs, change)
      return [
        ...plans.flatMap(({ version }) => [...version.files.keys()]),
        ...plans.flatMap(({ plan }) => writeSharedArea(args.docs, plan)),
        ...cleared.map(({ rel }) => rel),
      ]
    },
  })
  for (const area of areas) {
    if (kept.has(area)) writeSummary(`Already published \`${args.tag}\` in area \`${area.entry.area}\`: kept \`${area.versionDir}\` as it is.`)
  }
  for (const area of staleAreaFiles) keptAreaFilesSummary(area.areaDir, 'this release')
  for (const area of movedAreaFiles) staleAreaFilesSummary(area.areaDir, args['source-branch'])
  reportMissing()
  if (kept.size === areas.length) return { changed, commitSha }
  writeSummary(changed
    ? `Published \`${args.tag}\` to \`${args.branch}\` under \`${areas.find((area) => !kept.has(area)).versionDir}\`.`
    : `Nothing to publish for \`${args.tag}\`: the docs repo already holds it.`)
  return { changed, commitSha }
}
