
import fs from 'node:fs'
import path from 'node:path'
import { entriesPath, readEntries } from './entries.mjs'
import {
  assertAreaWritable,
  FatalError,
  readAreaFiles,
  assertAreaPlacement,
  assertCollectable,
  assertBranchReplaceable,
  assertNoFileFolderConflicts,
  assertNoNestedWrites,
  assertNoSymlinkPath,
  assertRecordOwners,
  assertMarkerOwner,
  clearArea,
  collectFiles,
  commitDate,
  git,
  gitStatus,
  isAncestor,
  keptAreaFiles,
  keptAreaFilesSummary,
  areaFileProblemsSummary,
  lstatOrNull,
  matchesGlob,
  metaFile,
  put,
  markerRecordAt,
  readMarkerRecord,
  runBuild,
  writeFile,
  writeSummary,
} from './files.mjs'
import { classifyStagedEffects, publishWithRetry, sourceBranchMoved, syncToBranch } from './push.mjs'
import { planBranchVersions, touchedPackages } from './release.mjs'
import { scan } from './prune.mjs'
import { planSharedArea, snapshotAreaState, writeSharedArea } from './shared.mjs'

export function pushChangedFiles(source, before, after) {
  if (!before || !isAncestor(source, before, after)) return null
  const result = gitStatus(source, ['diff', '--no-renames', '--name-only', '-z', `${before}..${after}`])
  if (result.status !== 0) return null
  return result.stdout.split('\0').filter(Boolean)
}

function matchesPush(entry, changed) {
  return entry.paths.some((pattern) => changed.some((file) => matchesGlob(path.posix.normalize(pattern), file)))
}

function planMirrors({ source, root, repository, entries, sourceRevision, sourceBranch }) {
  const date = commitDate(source, sourceRevision)
  return entries.map((entry) => {
    runBuild(entry, source, 'the source checkout')
    const areaDir = path.posix.join(root, entry.area)
    const files = new Map()
    const rules = new Map()
    put(files, `${areaDir}/.meta.json`, metaFile({ source: repository, sourceRevision, sourceBranch, date }))
    rules.set(`${areaDir}/.meta.json`, 'the publisher')
    for (const rule of entry.collect) {
      for (const file of collectFiles(source, rule)) {
        const rel = path.posix.join(areaDir, file.to)
        const from = path.relative(source, file.from)
        assertCollectable(rel, from)
        put(files, rel, { content: file.content })
        rules.set(rel, `collect "${rule.from}" to "${rule.to}"`)
      }
    }
    assertNoFileFolderConflicts(entry.area, areaDir, rules)
    return { area: entry.area, areaDir, files }
  })
}

function findVersionMetadata(docs, root, area) {
  const walk = (dirRel) => {
    for (const name of fs.readdirSync(path.join(docs, dirRel)).sort()) {
      const rel = `${dirRel}/${name}`
      const stat = lstatOrNull(path.join(docs, rel))
      if (!stat) continue
      if (stat.isDirectory()) {
        const marker = `${rel}/.meta.json`
        if (lstatOrNull(path.join(docs, marker))?.isFile()) {
          if (markerRecordAt(docs, root, rel).kind === 'Version') return marker
          continue
        }
        const found = walk(rel)
        if (found) return found
      } else if (name === '.meta.json') {
        if (stat.isSymbolicLink()) throw new FatalError(`refusing to publish symlink: ${rel}`)
        if (markerRecordAt(docs, root, dirRel)?.kind === 'Version') return rel
      }
    }
    return null
  }
  return lstatOrNull(path.join(docs, area.areaDir))?.isDirectory() ? walk(area.areaDir) : null
}

export function planMirrorWrites({ args, repository, mirrors, releaseFiles = new Map() }) {
  const docs = args.docs
  // A mirror publishes what the checkout holds, whatever revision the Area was last published from.
  const writable = mirrors
  for (const area of writable) assertMarkerOwner(markerRecordAt(docs, args.root, area.areaDir), area.area, repository)
  const plannedFiles = new Map(releaseFiles)
  for (const area of writable) {
    for (const [rel, file] of area.files) put(plannedFiles, rel, file)
  }
  for (const area of writable) assertAreaPlacement(docs, area.areaDir, args.root, 'mirror', plannedFiles)
  assertNoNestedWrites(docs, writable, args.root)
  // A release Area holds one Version folder per release, so a Mirror Area cannot sit inside one. A release Area in
  // the docs is the Area a Version folder sits in, whatever repo owns it, and this repo's entries may not name it; a
  // Branch Version folder is the same evidence when the Area holds no Version folder yet, and its marker names the
  // Area, so the layout never has to be guessed.
  const scanned = scan(docs, args.root)
  const releaseAreas = [...new Set(scanned.records.filter((record) => record.dir !== record.areaDir).map((record) => record.areaDir))]
  for (const area of writable) {
    const plannedVersion = [...releaseFiles].find(([rel, file]) =>
      rel.startsWith(`${area.areaDir}/`) && rel.endsWith('/.meta.json') && readMarkerRecord(file.content, rel, args.root).kind === 'Version',
    )
    const versionMetadata = findVersionMetadata(docs, args.root, area) ?? plannedVersion?.[0]
    if (versionMetadata) {
      throw new FatalError(
        `"${area.area}" overlaps a release Version folder at ${versionMetadata}; a mirror Area must not contain a release Area or sit inside a Version folder`,
      )
    }
    // A Branch Version folder is a release Area's evidence too, and the marker names the Area. A Mirror Area that is
    // the release Area, or holds it, would clear the folder and the Area around it: it stops here, before the clear.
    const branchArea = scanned.branches.find((branch) =>
      branch.areaDir === area.areaDir || branch.areaDir.startsWith(`${area.areaDir}/`))
    if (branchArea !== undefined) {
      assertMarkerOwner(branchArea, area.area, repository)
      throw new FatalError(
        `refusing to publish ${area.areaDir}: it sits inside the release Area ${branchArea.areaDir}, and a Mirror Area cannot sit inside a release Area. Choose another Area.`,
      )
    }
    const releaseArea = releaseAreas.find((dir) => area.areaDir.startsWith(`${dir}/`))
    if (releaseArea !== undefined) {
      throw new FatalError(
        `refusing to publish ${area.areaDir}: it sits inside the release Area ${releaseArea}, and a Mirror Area cannot sit inside a release Area. Choose another Area.`,
      )
    }
    // A mirror replaces its Area as a whole, so a folder with no marker anywhere in it is refused rather than cleared.
    // A plan placeholder names the paths its collect rules would write, so plan and run refuse the same folders; a plan
    // that could not expand the rules (`destinations: null`) leaves the question to the run instead of guessing.
    if (area.destinations === null) continue
    const planned = new Set([...plannedFiles.keys(), ...(area.destinations ?? [])])
    assertAreaWritable(docs, area.areaDir, planned, [area.areaDir])
  }
  return writable
}

export function writeMirrors(docs, mirrors) {
  const plannedDirs = new Set(mirrors.map((area) => area.areaDir))
  for (const area of mirrors) clearArea(docs, area.areaDir, plannedDirs)
  for (const area of mirrors) {
    for (const [rel, file] of area.files) writeFile(docs, rel, file)
  }
  return mirrors.flatMap((area) => [...area.files.keys()])
}

export function prepareMirrors({ args, repository, root }) {
  const entries = readEntries(args.entries, args['source-branch'])
  const mirrors = entries.filter((entry) => entry.mode === 'mirror')
  if (mirrors.length === 0) {
    writeSummary(entries.length === 0
      ? 'No mirror entries to publish. Add entries to `.github/docs_publisher.yaml`.'
      : 'No mirror entries; nothing to mirror.')
    return { mirrors: [], sourceRevision: null }
  }
  syncToBranch(args.docs, args.branch)
  const sourceRevision = git(args.source, ['rev-parse', 'HEAD'])
  const entriesRel = entriesPath(args.source, args.entries)
  const isPush = args.before !== undefined || args.after !== undefined
  const matched = mirrors.filter((entry) => {
    const previous = markerRecordAt(args.docs, root, path.posix.join(root, entry.area))
    assertMarkerOwner(previous, entry.area, repository)
    const touched = isPush && previous?.sourceBranch === args['source-branch']
      ? pushChangedFiles(args.source, previous.sourceRevision, sourceRevision) : null
    return touched === null || touched.includes(entriesRel) || matchesPush(entry, touched)
  })
  for (const entry of mirrors) {
    if (!matched.includes(entry)) {
      writeSummary(`Skipped mirror \`${entry.area}\`: no changed file matches its paths.`)
    }
  }
  if (matched.length === 0) {
    writeSummary('No mirror entry matches this push.')
    return { mirrors: [], sourceRevision }
  }

  return { mirrors: planMirrors({ source: args.source, root, repository, entries: matched, sourceRevision, sourceBranch: args['source-branch'] }), sourceRevision }
}

export function mirrorSummary(mirrors, branch, changed) {
  if (mirrors.length === 0) return
  const areas = mirrors.map((area) => area.area).join(' ')
  writeSummary(changed
    ? `Mirrored ${areas} to \`${branch}\`.`
    : `Nothing to publish: the docs repo already holds the mirror entries (${areas}).`)
}

// A checkout behind the source branch tip leaves the Area files unpublished: it cannot tell which of them a newer
// run already replaced.
function staleAreaFilesSummary(areaDir, sourceBranch) {
  writeSummary(`Skipped the Area files of \`${areaDir}\`: the source branch \`${sourceBranch}\` moved past the checkout, so this run cannot tell whether newer ones are already published.`)
}

// One release Area's rebuild: its freshness snapshot, its plan for the Area's shared files, and the Branch Version
// folders its entry publishes. A push contains a failure here to that Area, so the rest of the run still publishes.
function planRebuild({ args, repository, root, source, sourceRevision }) {
  const { entry } = source
  const areaFiles = readAreaFiles(args.source, source.areaDir, entry)
  const fresh = areaIsFresh(args.docs, root, source)
  return {
    fresh,
    // The branch tip moved, so the folder holds the build output of the packages this push touched.
    branches: entry.publishSourceBranch === true ? planBranchVersions({
      source: args.source, root, entry, repository, branch: args['source-branch'], revision: sourceRevision,
      names: touchedPackages({ source: args.source, entry, changed: source.changed }),
    }) : [],
    plan: entry.areaFiles.length === 0 ? null : planSharedArea({
      docs: args.docs, root, entry, repository, branch: args.branch, sourceBranch: args['source-branch'],
      docsRepository: args['docs-repository'],
      areaFiles: fresh ? areaFiles : keptAreaFiles(args.docs, areaFiles),
    }),
  }
}

// The first attempt records each rebuilt Area's state, so a retry can tell that another run published newer Area
// files, or newer shared files, under it.
function areaIsFresh(docs, root, source) {
  const state = snapshotAreaState(docs, root, source.areaDir, source.entry)
  source.state ??= state
  return state === source.state
}

// Everything one attempt writes, computed from the docs branch tip before anything is written. A part the push
// cannot plan is dropped here instead of being undone after a write.
function planPushAttempt({ args, repository, root, mirrors, sourceRevision, areaFileSources }) {
  // Rebuild only from a source checkout that is still the branch tip: a retry after it moved would otherwise
  // publish docs that a newer push already replaced. The next run, which starts from the tip, rebuilds them.
  const stale = sourceBranchMoved(args.source, args['source-branch'])
  const problems = new Map()
  const staleAreaFiles = new Set()
  const shared = []
  if (!stale) {
    for (const source of areaFileSources) {
      try {
        const { fresh, plan, branches } = planRebuild({ args, repository, root, source, sourceRevision })
        if (!fresh) staleAreaFiles.add(source.areaDir)
        shared.push({ area: source.entry.area, areaDir: source.areaDir, plan, branches })
      } catch (error) {
        // One Area the push cannot rebuild keeps its docs: the run names the problem and publishes the rest.
        if (!(error instanceof FatalError)) throw error
        problems.set(source.areaDir, error.message.split('\n')[0])
      }
    }
  }
  const writable = planMirrorWrites({ args, repository, mirrors })
  // A Branch Version marker names its release Area, so one can prove the Area belongs to another repo. Nothing this
  // attempt writes into such an Area is planned, and the check sits outside the per-Area containment: a push cannot
  // publish the rest and leave the refusal in a summary.
  assertRecordOwners(scan(args.docs, root).records, areaFileSources.map((source) => source.areaDir), root, repository)
  // A Branch Version folder is replaced whole once the plan is written, so the run checks it while planning, outside the
  // per-Area containment: a symlinked parent folder would otherwise be emptied before the write guard refused it, and a
  // folder another repo owns would be replaced. A folder with no marker of its own is hand-made too, and the replacement
  // would delete its files: the same guard the Area gets covers it.
  for (const { area, branches } of shared) {
    for (const branch of branches) {
      assertBranchReplaceable(args.docs, root, branch.dir, area, repository)
      assertAreaWritable(args.docs, branch.dir, new Set(), [branch.dir])
    }
  }
  return {
    shared,
    writable,
    problems,
    staleAreaFiles,
    skippedAreaFiles: stale
      ? areaFileSources.map((source) => source.areaDir)
      : [],
  }
}

// Writes the plan: the mirrors first, then the shared files planned around them. Each rebuilt Area keeps the paths
// its own plan staged, so the commit names only the Areas whose shared files changed.
function applyPushPlan(docs, attempt) {
  const mirrors = writeMirrors(docs, attempt.writable)
  attempt.shared = attempt.shared.map((item) => ({ ...item, written: writeRebuild(docs, item) }))
  return [...mirrors, ...attempt.shared.flatMap((item) => item.written)]
}

// A rebuilt Area's writes: its shared files, then its Branch Version folders. A branch folder holds one build
// output, so it is replaced whole: a file the new build no longer produces leaves with it.
function writeRebuild(docs, { plan, branches }) {
  const written = plan === null ? [] : writeSharedArea(docs, plan)
  for (const branch of branches) {
    fs.rmSync(path.join(docs, branch.dir), { recursive: true, force: true })
    for (const [rel, file] of branch.files) writeFile(docs, rel, file)
    written.push(branch.dir)
  }
  return written
}

function pushSubject({ mirrors, releases }) {
  return `docs: ${[
    mirrors.length > 0 ? `mirror ${mirrors.map((area) => area.area).join(' ')}` : null,
    releases.length > 0 ? `rebuild ${releases.map((item) => item.area).join(' ')}` : null,
  ].filter(Boolean).join(' ')}`
}

// A push publishes the mirrors and rebuilds the Area files it can. It never prunes: `main` runs a reconcile for a
// push whose prune has work.
export function publishPushUpdates({ args, repository, root }) {
  const entries = readEntries(args.entries, args['source-branch'])
  syncToBranch(args.docs, args.branch)
  const { mirrors } = prepareMirrors({ args, repository, root })
  // `prepareMirrors` names no revision when it publishes no mirror: a Branch Version folder names the same one.
  const sourceRevision = git(args.source, ['rev-parse', 'HEAD'])
  const touched = pushChangedFiles(args.source, args.before, args.after)
  // Every push replans the shared files of each release Area with Area files: the push range cannot show a change
  // a superseded push left unpublished, so the docs branch is the baseline, and a plan that lands the same bytes
  // writes nothing. A push never republishes a Version, and a run without a push range rebuilds nothing.
  const areaFileSources = touched === null ? [] : entries
    .filter((entry) => entry.mode === 'release' && (entry.areaFiles.length > 0 || entry.publishSourceBranch === true))
    .map((entry) => ({ entry, areaDir: path.posix.join(root, entry.area), changed: touched, state: null }))
  if (mirrors.length === 0 && areaFileSources.length === 0) return { changed: false, commitSha: null }
  let attempt
  const { changed, commitSha } = publishWithRetry({
    docs: args.docs,
    branch: args.branch,
    areaDirs: mirrors.map((area) => area.areaDir),
    message: () => {
      attempt.committed = classifyStagedEffects(args.docs, {
        mirrors: attempt.writable,
        releases: attempt.shared.map((item) => ({ ...item, paths: item.written })),
      })
      return pushSubject(attempt.committed)
    },
    write: () => {
      attempt = planPushAttempt({ args, repository, root, mirrors, sourceRevision, areaFileSources })
      return applyPushPlan(args.docs, attempt)
    },
  })
  const { problems, staleAreaFiles, skippedAreaFiles } = attempt
  for (const areaDir of skippedAreaFiles) staleAreaFilesSummary(areaDir, args['source-branch'])
  for (const areaDir of staleAreaFiles) keptAreaFilesSummary(areaDir, 'this push')
  for (const [areaDir, problem] of problems) areaFileProblemsSummary(areaDir, problem)
  mirrorSummary(changed ? attempt.committed.mirrors : attempt.writable, args.branch, changed)
  return { changed, commitSha }
}
