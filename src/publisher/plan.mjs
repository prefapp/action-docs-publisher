import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { entriesChanged, entriesPath, readEntries } from './entries.mjs'
import {
  FatalError,
  TagContentError,
  assertAreaPlacement,
  assertNoNestedWrites,
  assertNoSymlinkPath,
  collectFiles,
  commitDate,
  git,
  lstatOrNull,
  metaFile,
  put,
  tagExists,
  writeSummary,
} from './files.mjs'
import { planReconcileSharedAreas, planReconcileWrites, prepareReconcile, skippedReconcileLines } from './reconcile.mjs'
import { applyPrune, planPrune, scan } from './prune.mjs'
import { planMirrorWrites } from './mirror.mjs'
import { docsRoot } from './root.mjs'

// The plan's first line, and the notice that there is nothing to plan: the action finds the comment it wrote
// earlier by the marker, and posts no comment at all for a notice with nothing to replace.
export const PLAN_MARKER = '<!-- docs-publisher-plan -->'
export const IRRELEVANT_MARKER = '<!-- docs-publisher-plan-irrelevant -->'
const MARKER = PLAN_MARKER
const IRRELEVANT = IRRELEVANT_MARKER

// A PR that no longer touches docs still gets a plan file, so the workflow can update the sticky
// comment it posted earlier. The flag keeps the workflow from creating a comment for a never-relevant PR.
function writeIrrelevantPlan(file) {
  fs.writeFileSync(file, `${MARKER}\n${IRRELEVANT}\n## Docs publisher plan\n\nThis pull request no longer changes docs publishing.\n`)
}

function planRemovals({ args, prune, observed, add }) {
  const changedAreas = new Set()
  const branchDirs = new Set(observed.branches.map((branch) => branch.dir))
  for (const { dir, kind, reason, areaDir: branchArea } of prune.removals) {
    // A Branch Version folder names its Area in the plan (it holds no Version folder to find one in).
    const areaDir = branchArea
    if (!areaDir) continue
    if (kind === 'area-gone' || kind === 'mode-change') {
      if (changedAreas.has(areaDir)) continue
      changedAreas.add(areaDir)
      add(areaDir, `- ${kind === 'mode-change' ? 'Replace' : 'Delete'} Area: ${reason}.`)
    } else if (branchDirs.has(dir)) {
      add(areaDir, `- Delete Branch Version folder \`${dir.slice(areaDir.length + 1)}\`: ${reason}.`)
    } else {
      for (const version of observed.versions.filter((version) => version.dir.startsWith(`${dir}/`) || version.dir === dir)) {
        add(areaDir, `- Delete version \`${version.dir.slice(areaDir.length + 1)}\`: ${reason}.`)
      }
    }
  }
  for (const version of observed.versions) {
    if (prune.isPruned(version.dir) && !tagExists(args.source, version.tag)) {
      add(version.areaDir, `- Warning: deleting version \`${version.dir.slice(version.areaDir.length + 1)}\`: no tag exists to rebuild it from.`)
    }
  }
  return changedAreas
}

// The paths the mirror's collect rules would write, which the hand-made Area guard must see as planned: the plan
// writes no bytes, but it must agree with the run about whether the folder is refused. A build's files cannot be named
// here, because a build does not run in plan mode, so a build-backed Area's destinations stay unknown and the plan
// makes no refusal claim for it. A rule that cannot be expanded at all leaves them unknown in the same way.
function mirrorDestinations({ args, areaDir, entry }) {
  if (entry.build !== undefined) return null
  const destinations = new Set([`${areaDir}/.meta.json`])
  for (const rule of entry.collect) {
    try {
      for (const file of collectFiles(args.source, rule)) destinations.add(path.posix.join(areaDir, file.to))
    } catch (error) {
      if (error instanceof TagContentError) return null
      throw error
    }
  }
  return destinations
}

// Metadata-only placeholders let the existing placement guards see Mirror Areas without running their builds.
// They carry no collected content and are never written, even to the snapshot.
function mirrorPlaceholders({ args, repository, root, entries, sourceRevision, changedAreas, add }) {
  return entries.filter((entry) => entry.mode === 'mirror').map((entry) => {
    const areaDir = path.posix.join(root, entry.area)
    if (!changedAreas.has(areaDir) && !lstatOrNull(path.join(args.docs, areaDir))) add(areaDir, '- Add Mirror Area.')
    return {
      area: entry.area,
      areaDir,
      destinations: mirrorDestinations({ args, areaDir, entry }),
      files: new Map([[`${areaDir}/.meta.json`, metaFile({
        source: repository, sourceRevision, sourceBranch: args['source-branch'], date: commitDate(args.source, sourceRevision),
      })]]),
    }
  })
}

function recordReleaseChanges({ args, areas, report, add }) {
  for (const area of areas) {
    for (const dir of report.published.filter((dir) => dir.startsWith(`${area.areaDir}/`))) {
      add(area.areaDir, `- Add version \`${dir.slice(area.areaDir.length + 1)}\`.`)
    }
    for (const dir of report.republished.filter((dir) => dir.startsWith(`${area.areaDir}/`))) {
      add(area.areaDir, `- Republish version \`${dir.slice(area.areaDir.length + 1)}\`: specHash changed.`)
    }
    for (const branch of report.branches.filter((branch) => branch.changed && branch.dir.startsWith(`${area.areaDir}/`))) {
      add(area.areaDir, `- ${branch.existed ? 'Refresh' : 'Add'} Branch Version folder \`${branch.dir.slice(area.areaDir.length + 1)}\`.`)
    }
    for (const line of skippedReconcileLines({
      sourceBranch: args['source-branch'],
      areaFilesSkipped: report.areaFilesSkipped.filter(({ dir }) => dir === area.areaDir),
      skipped: report.skipped.filter((pkg) => area.packages.includes(pkg)),
    })) add(area.areaDir, line)
  }
}

// The names a rebuild generates at the top of an Area. Every other file there is an Area file of the entry.
const GENERATED_AREA_NAMES = new Set(['index.json', 'versions.json', 'latest', '.meta.json'])

// What the Area's shared files would gain, lose or overwrite, read off the bytes the rebuild plans for them: the plan
// writes nothing, so it compares them with the docs repo instead of staging them.
function sharedFileChanges({ docs, areaDir, plan }) {
  const areaFiles = []
  const generated = []
  const record = (rel, verb) => {
    const label = path.posix.dirname(rel) === areaDir && !GENERATED_AREA_NAMES.has(path.posix.basename(rel))
      ? 'Area file'
      : 'shared file'
    const line = `- ${verb} ${label} \`${rel.slice(areaDir.length + 1)}\`.`
    if (label === 'Area file') areaFiles.push(line)
    else generated.push(line)
  }
  for (const [rel, file] of plan.files) {
    const absolute = path.join(docs, rel)
    const stat = lstatOrNull(absolute)
    const wanted = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content)
    if (!stat) record(rel, 'Add')
    else if (!stat.isFile() || Buffer.compare(fs.readFileSync(absolute), wanted) !== 0) record(rel, 'Replace')
  }
  const written = new Set(plan.files.keys())
  for (const rel of plan.removals) {
    const absolute = path.join(docs, rel)
    const stat = lstatOrNull(absolute)
    if (!stat || written.has(rel)) continue
    // A rebuild clears the Latest copy through its package folder and writes it back: of a folder that holds one of
    // those writes, only the files it does not write again are gone.
    const rewritten = [...written].some((file) => file.startsWith(`${rel}/`))
    if (!stat.isDirectory() || !rewritten) {
      record(rel, 'Delete')
      continue
    }
    for (const child of fs.readdirSync(absolute, { recursive: true }).sort()) {
      const childRel = path.posix.join(rel, child.split(path.sep).join('/'))
      if (!written.has(childRel) && !lstatOrNull(path.join(docs, childRel)).isDirectory()) record(childRel, 'Delete')
    }
  }
  return { areaFiles, generated }
}

// The Area files an entry lists are always planned: they are content the merge adds or overwrites. The indexes a
// publish regenerates are planned only for an Area with no line of its own, so a Version publish is not restated
// four times by the files that follow it.
function recordSharedChanges({ docs, shared, changes, add }) {
  let planned = false
  for (const { areaDir, ...plan } of shared) {
    const { areaFiles, generated } = sharedFileChanges({ docs, areaDir, plan })
    const lines = changes.has(areaDir) || areaFiles.length > 0 ? areaFiles : generated
    for (const line of lines) add(areaDir, line)
    if (lines.length > 0) planned = true
  }
  return planned
}

function assemblePlan({ args, repository, root, entries, snapshot, changes }) {
  assertNoSymlinkPath(args.docs, root)
  const observed = scan(args.docs, root)
  const prune = planPrune({ docs: args.docs, source: args.source, root, repository, entries })
  const areas = prepareReconcile({ args, repository, root, prune })
  // A Branch Version marker names its release Area, so it can prove the Area belongs to another repo: the plan says
  // so instead of listing the writes and the deletions it would make there.
  if (lstatOrNull(path.join(args.docs, root))) {
    fs.cpSync(path.join(args.docs, root), path.join(snapshot, root), {
      recursive: true, verbatimSymlinks: true,
      // With a docs root of `.` the plan copies the checkout itself; `.git` is Git's, and the plan never reads it.
      filter: (source) => path.basename(source) !== '.git',
    })
  }
  applyPrune(snapshot, prune, root)
  const reconcile = planReconcileWrites(snapshot, areas, {
    source: args.source, repository, root, sourceBranch: args['source-branch'],
  })
  const add = (areaDir, line) => {
    if (!changes.has(areaDir)) changes.set(areaDir, [])
    changes.get(areaDir).push(line)
  }
  const changedAreas = planRemovals({ args, prune, observed, add })
  const sourceRevision = git(args.source, ['rev-parse', 'HEAD'])
  const mirrors = mirrorPlaceholders({ args, repository, root, entries, sourceRevision, changedAreas, add })
  const writable = planMirrorWrites({ args: { ...args, docs: snapshot }, repository, mirrors, releaseFiles: reconcile.files })
  assertNoNestedWrites(snapshot, [...reconcile.areas, ...writable], root)
  const plannedFiles = new Map(reconcile.files)
  for (const mirror of writable) for (const [rel, file] of mirror.files) put(plannedFiles, rel, file)
  recordReleaseChanges({ args, areas, report: reconcile.report, add })
  const { shared, problems } = planReconcileSharedAreas({
    args: { ...args, docs: snapshot }, repository, root, areas, reconcile,
    checkPlacement: (area) => assertAreaPlacement(snapshot, area.areaDir, root, 'release', plannedFiles),
  })
  if (problems.length) throw new FatalError([...new Set(problems)].join('\n'))
  return recordSharedChanges({ docs: args.docs, shared, changes, add })
    || prune.hasWork || reconcile.report.published.length > 0 || reconcile.report.republished.length > 0
    || reconcile.report.branches.some((branch) => branch.changed)
    || mirrors.some((mirror) => !lstatOrNull(path.join(args.docs, mirror.areaDir)))
}

export function planReconcile({ args, repository, root }) {
  const scope = docsRoot(root)
  let snapshot
  let hasChanges = false
  const changes = new Map()
  const problems = []
  try {
    // The entries file is read here, so a file that is not valid YAML is a planning problem the comment reports,
    // not a failure before plan mode: no other mode reaches the docs repo without a valid file.
    const entries = readEntries(args.entries, args['source-branch'])
    const changed = git(args.source, ['diff', '--no-renames', '--name-only', '-z', `${args.before}...${args.after}`]).split('\0').filter(Boolean)
    const packages = entries.filter((entry) => entry.mode === 'release' && entry.packages !== undefined)
      .map((entry) => path.posix.normalize(entry.packages).replace(/\/$/, ''))
    if (!entriesChanged(args.source, args.entries, changed) && !packages.some((folder) => changed.some((file) => folder === '.' || file.startsWith(`${folder}/`)))) {
      writeSummary('Skipped plan: no changed entries file or release package folder.')
      writeIrrelevantPlan(args['plan-file'])
      return { changed: false, commitSha: null }
    }
    snapshot = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'docs-publisher-plan-'))
    hasChanges = assemblePlan({ args, repository, root, entries, snapshot, changes })
  } catch (error) {
    if (!(error instanceof FatalError)) throw error
    // Git and build errors can contain absolute paths; the comment only names repo-relative paths.
    let message = error.message
    for (const [absolute, relative] of [[snapshot, '.'], [args.entries, entriesPath(args.source, args.entries)], [args.docs, '.'], [args.source, '.']]) {
      if (absolute) message = message.replaceAll(`${absolute}/`, '').replaceAll(absolute, relative)
    }
    problems.push(...message.split('\n').filter(Boolean))
  } finally {
    if (snapshot) fs.rmSync(snapshot, { recursive: true, force: true })
  }
  const lines = [MARKER, '## Docs publisher plan', '', 'Mirror content changes are not listed; mirror builds do not run in plan mode.']
  for (const [areaDir, items] of [...changes].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push('', `### \`${scope.relative(areaDir)}\``, ...items)
  }
  if (!hasChanges && problems.length === 0) lines.push('', 'No changes to add, republish, delete or replace.')
  if (problems.length) lines.push('', 'This change would fail to publish:', ...[...new Set(problems)].map((problem) => `- ${problem}`))
  fs.writeFileSync(args['plan-file'], `${lines.join('\n')}\n`)
  return { changed: false, commitSha: null }
}
