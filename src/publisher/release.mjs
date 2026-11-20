
import fs from 'node:fs'
import path from 'node:path'
import { folderForTagName, nestedRepoPath, readEntries, readTagNames, specHash } from './entries.mjs'
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
import { readSkippedTags, skippedTagsFile, skippedTagsPath } from './skipped.mjs'
import { scan } from './prune.mjs'
import { planSharedArea, snapshotAreaState, writeSharedArea } from './shared.mjs'

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

export function planVersion({ source, root, entry, release, repository, date, tag, sourceRevision }) {
  const versionDir = path.posix.join(root, entry.area, ...(release.name ? [release.name] : []), release.version)
  const files = collectPackage({
    source, entry, name: release.name, dir: versionDir,
    marker: { source: repository, tag, sourceRevision, date, specHash: specHash(entry) },
  })
  return { versionDir, name: release.name, version: release.version, files }
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

// The tag a Release published leaves the Area's Skipped tags file: the docs hold its Version now. Returns the path
// the attempt changed, or null when the file never named it.
function clearSkippedTag(docs, areaDir, tag, repository) {
  const tags = readSkippedTags(docs, areaDir)
  if (!tags?.has(tag)) return null
  tags.delete(tag)
  const rel = skippedTagsPath(areaDir)
  if (tags.size === 0) fs.rmSync(path.join(docs, rel), { force: true })
  else writeFile(docs, rel, skippedTagsFile({ source: repository, tags }))
  return rel
}

export function publishRelease({ args, release, repository, root }) {
  const sourceRevision = tagCommit(args.source, args.tag)
  if (sourceRevision === null) throw new FatalError(`tag ${args.tag} not found in ${args.source}`)
  const date = tagDate(args.source, args.tag)
  return withTagWorktree(args.source, args.tag, (tagSource) => publishAtTag(
    { args, release, repository, root, date, tagSource, sourceRevision },
  ))
}

// The Version folder a tag publishes into this entry's Area, whether or not the tag holds the package folder.
function tagVersionDir(root, entry, name, version) {
  return path.posix.join(root, entry.area, ...(name ? [name] : []), version)
}

// A Version folder the docs hold for a tag whose package folder the tag itself no longer carries. A marker that names
// this run's commit is the tag's own bytes, so the Version stays as it is whatever the entry names today. A marker
// built from another commit, or a legacy marker that names none, is a Version the tag can no longer produce, and the
// run stops over it. Only this tag's Version counts: another tag's folder is not this run's to keep.
function missingTagVersions({ docs, root, repository, tag, sourceRevision, missing }) {
  const kept = []
  const moved = []
  for (const area of missing) {
    const marker = publishedMarker(docs, root, area.dir, repository)
    if (marker?.tag !== tag) continue
    if (marker.sourceRevision === sourceRevision) kept.push(area)
    else moved.push(area)
  }
  return { kept, moved }
}

// A Version the tag can no longer produce has nothing in the tag that could replace it, so the Release stops over the
// bytes the docs hold instead of reporting a skip.
function movedTagProblems(tag, moved) {
  return [...new Set(moved.map(({ entry, name, dir }) =>
    `refusing to publish \`${tag}\` over \`${dir}\`: the tag points at a commit without the \`${entry.packages}/${name}\` folder, and the docs hold its Version. Its bytes are kept.`))]
}

// The Area state a Release reads before it decides anything: the Skipped tags file it takes the tag out of, in every
// Area the tag could publish into. A damaged one fails the run here, whatever the run would do with the Area, so a
// reported skip or a dropped prerelease never hides it.
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

// The marker of a Version folder this repo published, or null when the folder is not ours. A release-triggered
// publish rewrites a Version only when its tag now points at another commit: the bytes readers already link to stay
// as they are for an unchanged tag, and a Version another tag published is never rewritten.
function publishedMarker(docs, root, versionDir, repository) {
  const metadata = markerRecordAt(docs, root, versionDir)
  return metadata?.source === repository ? metadata : null
}

function publishAtTag({ args, release, repository, root, date, tagSource, sourceRevision }) {
  const candidates = readEntries(args.entries, args['source-branch']).filter(
    (entry) => entry.mode === 'release' && (entry.packages !== undefined) === Boolean(release.name),
  )
  const folders = new Map(candidates.map((entry) => [entry, release.name
    ? folderForTagName(readTagNames(args.source, entry), release.name) : null]))
  const releases = candidates.filter((entry) => {
    if (!release.name) return true
    const rel = path.posix.join(entry.packages, folders.get(entry))
    assertNoSymlinkAncestors(tagSource, rel)
    return lstatOrNull(path.join(tagSource, rel))?.isDirectory() === true
  })
  // The Areas whose package folder the tag does not hold. Their Version folders, if the docs hold this tag's, stay as
  // they are; a moved or legacy one stops the run instead. Which Areas keep theirs is read per attempt, from the docs
  // branch that attempt fetched.
  const missing = candidates.filter((entry) => !releases.includes(entry)).map((entry) => ({
    entry, name: folders.get(entry), dir: tagVersionDir(root, entry, folders.get(entry), release.version),
  }))
  const keptMissing = new Set()
  const reportMissing = () => {
    for (const { entry, name, dir } of missing) {
      writeSummary(keptMissing.has(dir)
        ? `Already published \`${args.tag}\` in area \`${entry.area}\`: kept \`${dir}\` as it is.`
        : `Skipped \`${args.tag}\` for area \`${entry.area}\`: no \`${entry.packages}/${name}\` folder at the tag.`)
    }
  }
  // Every path of a Release reads the same state: the Skipped tags files of every candidate Area, and the Version
  // folders the tag's own package folder cannot replace. It runs after the attempt's docs sync, so an Area another run
  // just published is read as it is now.
  const readReleaseState = () => {
    keptMissing.clear()
    const problems = releaseStateProblems({ docs: args.docs, root, entries: candidates })
    if (missing.length > 0) {
      const { kept, moved } = missingTagVersions({ docs: args.docs, root, repository, tag: args.tag, sourceRevision, missing })
      for (const { dir } of kept) keptMissing.add(dir)
      problems.push(...movedTagProblems(args.tag, moved))
    }
    if (problems.length > 0) throw new FatalError([...new Set(problems)].join('\n'))
  }
  if (releases.length === 0) {
    // A tag that moved off its package folder leaves the Version the docs already hold with nothing to rebuild it
    // from, so the run stops instead of reporting a skip over bytes it cannot replace.
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
    // The Areas this run publishes no Version into still hold the state a Release answers for: a moved published tag
    // is a failure even when the filter above leaves nothing to publish.
    syncToBranch(args.docs, args.branch)
    readReleaseState()
    reportMissing()
    writeSummary(`Skipped \`${args.tag}\`: a prerelease is published only by an entry with \`prereleases: true\`.`)
    return { changed: false, commitSha: null }
  }
  const areas = published.map((entry) => {
    const name = folders.get(entry)
    const areaDir = path.posix.join(root, entry.area)
    return {
      entry,
      areaDir,
      versionDir: tagVersionDir(root, entry, name, release.version),
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
      // The docs record the commit a Version was built from, so the run has to publish that same commit: a clone that
      // holds an older tag than origin would otherwise roll a newer publish back. Origin is asked on every attempt,
      // because the tag can move while the run waits to push.
      const onOrigin = originTagRevision(args.source, args.tag)
      // A tag origin no longer names has no authoritative commit to publish from: the run's own ref may be older than
      // the one that published the docs, so publishing from it could roll them back.
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
      try { assertRecordOwners(scan(args.docs, root).records, areas.map((area) => area.areaDir), root, repository) } catch (error) {
        if (!(error instanceof FatalError)) throw error
        problems.push(error.message)
      }
      // A Skipped tags file this repo's own Reconcile wrote has to be readable before the Release takes it away, and a
      // moved published tag has to stop the run, whatever this attempt decides about the Version folders.
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
            source: tagSource, root, entry: area.entry,
            release: { ...release, name: folders.get(area.entry) }, repository, date, tag: args.tag, sourceRevision,
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
      // A Release never records a skip. It clears the tag it just published, so a later Reconcile does not check
      // what the docs already hold, and leaves the file gone when it held nothing else.
      const cleared = plans.map(({ area }) => clearSkippedTag(args.docs, area.areaDir, args.tag, repository))
      return [
        ...plans.flatMap(({ version }) => [...version.files.keys()]),
        ...plans.flatMap(({ plan }) => writeSharedArea(args.docs, plan)),
        ...cleared.filter(Boolean),
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
