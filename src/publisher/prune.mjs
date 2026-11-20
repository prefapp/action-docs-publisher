import fs from 'node:fs'
import path from 'node:path'
import { SEMVER_REGEX } from './entries.mjs'
import {
  FatalError,
  assertNoSymlinkPath,
  assertNoSymlinkTree,
  clearArea,
  folderNames,
  groupBy,
  hasTreeAt,
  lstatOrNull,
  assertRecordOwners,
  tagExists,
  writeSummary,
} from './files.mjs'
import { discoverAreas } from './discovery.mjs'
import { docsRoot } from './root.mjs'

// Prune makes the docs repo match the desired state: an Area whose entry is gone, or a package whose
// folder is gone from the source repo, is deleted. It only touches folders whose .meta.json names this repo.

// Prune never deletes outside the configured root, whatever discovery found or a plan asks for.
function assertInsideRoot(root, rel) {
  if (!docsRoot(root).containsBelow(rel)) {
    throw new FatalError(`refusing to delete ${rel}: it is not under the docs root "${root}"`)
  }
}

const inside = (rel, dir) => rel === dir || rel.startsWith(`${dir}/`)

// The docs tree the plan publishes, for the planners that run before the prune writes: a folder a removal deletes
// is gone from it, except for a Mirror Area the plan leaves standing, because a nested Area survives the deletion
// of its parent. A deletion planned below such an Area (a nested Mirror Area with no entry) still happens.
function prunedView(removals, { plannedDirs, mirrorAreas }) {
  const depth = (dir) => dir.split('/').length
  const deepest = (dirs) => Math.max(0, ...dirs.map(depth))
  const kept = [...mirrorAreas].filter((dir) => !plannedDirs.has(dir))
  return (rel) => {
    const deletes = removals.filter(({ dir }) => inside(rel, dir)).map(({ dir }) => dir)
    return deletes.length > 0 && deepest(deletes) >= deepest(kept.filter((dir) => inside(rel, dir)))
  }
}

function packageFolderGone(source, entry, name, checked) {
  if (!checked.has(entry)) {
    if (!hasTreeAt(source, 'HEAD', entry.packages)) {
      throw new FatalError(
        `Area "${entry.area}": the packages folder "${entry.packages}" is not in the source checkout, so no package can be told apart from a removed one. To retire the whole Area, remove its entry from docs_publisher.yaml.`,
      )
    }
    checked.add(entry)
  }
  return !hasTreeAt(source, 'HEAD', path.posix.join(entry.packages, name))
}

// A removal deletes a parent whole, so every Version folder under it goes too. Discovery reports the damaged
// markers; an unmarked version-shaped child must also be refused, because no tag can rebuild it.
function missingVersionChildren(docs, dir, plannedDirs) {
  const problems = []
  for (const name of folderNames(path.join(docs, dir))) {
    const child = `${dir}/${name}`
    if (plannedDirs.has(child) || !SEMVER_REGEX.test(name.replace(/^v/, ''))) continue
    const marker = `${child}/.meta.json`
    if (!lstatOrNull(path.join(docs, marker))) problems.push(`Version folder ${child} has no .meta.json`)
  }
  return problems
}

export function planPrune({ docs, source, root, repository, entries }) {
  const { claims, damaged } = discoverAreas(docs, root)
  const versions = claims.filter((claim) => claim.kind === 'Version')
  const branches = claims.filter((claim) => claim.kind === 'Branch')
  const mirrors = claims.filter((claim) => claim.kind === 'Mirror')
  const skipped = claims.filter((claim) => claim.kind === 'Skipped')
  const ownedDirs = new Set(claims.filter((claim) => claim.source === repository).map((claim) => claim.dir))
  const mirrorAreas = new Map(entries.filter((entry) => entry.mode === 'mirror').map((entry) => [path.posix.join(root, entry.area), entry]))
  const releaseAreas = new Map(entries.filter((entry) => entry.mode === 'release').map((entry) => [path.posix.join(root, entry.area), entry]))
  const removals = []
  const files = []
  const problems = []
  const warnings = []
  const checked = new Set()
  const removedVersions = new Set()
  // `mode` is the mode of the Area being removed; an entry for the same Area in the other mode is a mode change.
  const areaRemoval = (areaDir, mode) => {
    const other = mode === 'mirror' ? releaseAreas : mirrorAreas
    return other.has(areaDir)
      ? { kind: 'mode-change', reason: `its entry is now in ${mode === 'mirror' ? 'release' : 'mirror'} mode` }
      : { kind: 'area-gone', reason: 'its entry is gone from docs_publisher.yaml' }
  }
  // The publisher owns every file at the top of a release Area; other folders are not its. An Area is retired once,
  // whatever proves its ownership: Version folders or Branch Version folders.
  const retiredAreas = new Set()
  const retireTopFiles = (areaDir) => {
    retiredAreas.add(areaDir)
    for (const child of fs.readdirSync(path.join(docs, areaDir), { withFileTypes: true })) {
      if (child.isFile()) files.push({ rel: `${areaDir}/${child.name}`, areaDir })
    }
  }

  for (const mirror of mirrors) {
    if (!ownedDirs.has(mirror.dir)) continue
    if (!mirrorAreas.has(mirror.dir)) removals.push({ dir: mirror.dir, areaDir: mirror.areaDir, ...areaRemoval(mirror.dir, 'mirror') })
  }

  const byArea = groupBy(versions, (version) => version.areaDir)
  for (const [areaDir, inArea] of [...byArea].sort(([a], [b]) => a.localeCompare(b))) {
    if (!inArea.some((version) => ownedDirs.has(version.dir))) continue
    const entry = releaseAreas.get(areaDir)
    const retire = (group) => {
      for (const version of group) {
        removedVersions.add(version.dir)
        if (!tagExists(source, version.tag)) warnings.push({
          dir: version.dir,
          message: `Warning: pruned \`${version.dir}\` has no tag \`${version.tag}\` in the source repo, so only the docs repo's git history can restore it.`,
        })
      }
    }
    if (!entry) {
      retire(inArea)
      const removal = areaRemoval(areaDir, 'release')
      // Named layout: one folder per package. Unnamed layout: the Version folders and the latest copy.
      const named = inArea.some((version) => version.packageDir)
      const dirs = named ? [...new Set(inArea.map((version) => version.packageDir).filter(Boolean))] : [...inArea.map((version) => version.dir), `${areaDir}/latest`]
      for (const dir of dirs) removals.push({ dir, areaDir, ...removal })
      retireTopFiles(areaDir)
      continue
    }
    if (entry.packages === undefined) continue
    const byPackage = groupBy(inArea.filter((version) => version.packageDir), (version) => version.packageDir)
    for (const [packageDir, group] of byPackage) {
      if (!packageFolderGone(source, entry, path.posix.basename(packageDir), checked)) continue
      retire(group)
      removals.push({ dir: packageDir, areaDir, kind: 'package-gone', reason: `\`${entry.packages}/${path.posix.basename(packageDir)}\` is gone from the source repo` })
    }
  }
  // A Branch Version folder follows its release entry: it goes with the Area or package folder it was published
  // into, and when its entry stops publishing the source branch.
  for (const branch of branches) {
    if (!ownedDirs.has(branch.dir)) continue
    const { areaDir, name } = branch
    const entry = releaseAreas.get(areaDir)
    // The entry stops asking for the folder, so it goes whatever the state of its package folder: the flag retires it
    // before the package folders are looked at.
    if (entry?.publishSourceBranch !== true) {
      removals.push({ dir: branch.dir, areaDir, ...(entry
        ? { kind: 'branch-off', reason: 'its entry no longer publishes the source branch' }
        : areaRemoval(areaDir, 'release')) })
      // With no entry, the branch markers are the only proof of ownership the Area has, so its top-level files go
      // with the folder. Left behind, they would keep the Area from being switched to mirror mode.
      if (!entry && !retiredAreas.has(areaDir)) retireTopFiles(areaDir)
      continue
    }
    if (name !== null && entry.packages !== undefined && packageFolderGone(source, entry, name, checked)) {
      removals.push({ dir: branch.dir, areaDir, kind: 'package-gone', reason: `\`${entry.packages}/${name}\` is gone from the source repo` })
    }
  }
  for (const record of skipped) {
    const { areaDir } = record
    if (releaseAreas.has(areaDir) || retiredAreas.has(areaDir) || !ownedDirs.has(areaDir)) continue
    if (removals.some((removal) => removal.dir === areaDir)) continue
    if (folderNames(path.join(docs, areaDir)).length > 0) {
      retireTopFiles(areaDir)
      continue
    }
    removals.push({ dir: areaDir, areaDir, ...areaRemoval(areaDir, 'release') })
  }
  const plannedDirs = new Set([...removals.map((removal) => removal.dir), ...removedVersions])
  const isPruned = prunedView(removals, { plannedDirs, mirrorAreas: mirrors.map((mirror) => mirror.areaDir) })
  const affectedAreas = [
    ...[...removals, ...files].map((change) => change.areaDir),
    ...claims.filter((claim) => isPruned(claim.areaDir)).map((claim) => claim.areaDir),
  ]
  assertRecordOwners(claims, affectedAreas, root, repository)
  const removed = (damagedClaim) => isPruned(damagedClaim.dir) ||
    (damagedClaim.rel !== undefined && files.some((file) => file.rel === damagedClaim.rel))
  for (const damagedClaim of damaged) {
    if (removed(damagedClaim)) problems.push(damagedClaim.message)
  }
  for (const { dir } of removals) problems.push(...missingVersionChildren(docs, dir, plannedDirs))
  if (problems.length > 0) throw new FatalError([...new Set(problems)].join('\n'))
  for (const { dir } of removals) assertInsideRoot(root, dir)
  for (const { rel } of files) assertInsideRoot(root, rel)
  // A removal clears its whole tree, so the preflight walks every one of them here, before any decision to delete:
  // a symlink anywhere in a tree the run would clear stops it with nothing deleted.
  for (const { dir } of removals) assertNoSymlinkTree(docs, dir)
  return {
    removals,
    files,
    warnings,
    plannedDirs,
    isPruned,
    hasWork: removals.length > 0 || files.length > 0,
  }
}

// Deletes the planned folders and returns the paths to stage.
export function applyPrune(docs, plan, root) {
  const scope = docsRoot(root)
  const paths = []
  for (const { dir } of plan.removals) {
    assertInsideRoot(root, dir)
    assertNoSymlinkPath(docs, dir)
    if (!lstatOrNull(path.join(docs, dir))?.isDirectory()) continue
    clearArea(docs, dir, plan.plannedDirs)
    if (fs.readdirSync(path.join(docs, dir)).length === 0) fs.rmdirSync(path.join(docs, dir))
    paths.push(dir)
  }
  for (const { rel } of plan.files) {
    assertInsideRoot(root, rel)
    assertNoSymlinkPath(docs, rel)
    fs.rmSync(path.join(docs, rel), { force: true })
    paths.push(rel)
  }
  for (const rel of paths) {
    for (let dir = path.posix.dirname(rel); scope.containsBelow(dir); dir = path.posix.dirname(dir)) {
      if (!lstatOrNull(path.join(docs, dir))?.isDirectory() || fs.readdirSync(path.join(docs, dir)).length > 0) break
      fs.rmdirSync(path.join(docs, dir))
    }
  }
  return paths
}

// A run whose checkout is behind the source branch tip cannot tell which docs are stale, so it deletes nothing.
export const NO_PRUNE = {
  removals: [], files: [], warnings: [], plannedDirs: new Set(),
  isPruned: () => false, hasWork: false,
}

export function stalePruneSummary(sourceBranch) {
  writeSummary(`Skipped prune: the source branch \`${sourceBranch}\` moved past the checkout, so this run cannot tell which docs are stale.`)
}

export function pruneSummary(plan, branch, changed) {
  if (plan.removals.length === 0 && plan.files.length === 0) return
  for (const { message } of plan.warnings) writeSummary(message)
  const reasons = groupBy(plan.removals, (removal) => removal.reason)
  writeSummary(changed ? `Pruned from \`${branch}\`:` : 'Nothing to prune: the docs repo already matches.')
  if (!changed) return
  for (const [reason, removals] of reasons) writeSummary(`- Pruned ${removals.map(({ dir }) => `\`${dir}\``).join(', ')}: ${reason}.`)
}
