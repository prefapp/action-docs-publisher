import fs from 'node:fs'
import path from 'node:path'
import { SEMVER_REGEX } from './entries.mjs'
import { FatalError, assertAreaWritable, assertRecordOwners, assertNoSymlinkPath, existingVersionFolders, folderNames, markerRecordAt, markerRecords, lstatOrNull, metaFile, put, readMarkerRecord, writeFile, writeSummary } from './files.mjs'
import { scan } from './prune.mjs'
import { docsRoot } from './root.mjs'

// Ported from the former shared-file rebuilder. Build identifiers do not affect precedence.
function compareSemver(left, right) {
  const parse = (version) => {
    const [core, pre] = version.replace(/^v/, '').split('+')[0].split(/-(.*)/s)
    return { numbers: core.split('.').map(BigInt), pre: pre ?? null }
  }
  const a = parse(left)
  const b = parse(right)
  for (let i = 0; i < 3; i++) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] < b.numbers[i] ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  const aa = a.pre.split('.')
  const bb = b.pre.split('.')
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const x = aa[i]
    const y = bb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      if (BigInt(x) !== BigInt(y)) return BigInt(x) < BigInt(y) ? -1 : 1
    } else if (xn) return -1
    else if (yn) return 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

// Preserve GitHub-compatible path sub-delimiters, as the hub did.
function urlPath(segments) {
  return segments.filter(Boolean).flatMap((segment) => segment.split('/'))
    .map((segment) => encodeURIComponent(segment).replace(/%(2B|2C|3A|3B|3D|40|24|26)/gi, decodeURIComponent)).join('/')
}

// A release Area never holds a Mirror Area: a Mirror marker nested anywhere inside one is a layout the publisher
// refuses, so the planners name the Mirror Area instead of clearing around it or writing into it. The marker rule is
// the unified reader's validated kind, not a guess from a partial marker.
const MIRROR_AREA_RULE = 'and a Mirror Area cannot sit inside a release Area. Choose another Area.'

function mirrorAreaProblem(areaDir, dir) {
  return `refusing to publish ${areaDir}: it holds the Mirror Area ${dir}, ${MIRROR_AREA_RULE}`
}

function nestedAreaProblem(docs, root, { dir, refused, refuser, areaDir, overlap }) {
  if (markerRecordAt(docs, root, dir)?.kind === 'Mirror') return mirrorAreaProblem(areaDir, dir)
  return `refusing to ${refuser} ${refused}: it ${overlap ? 'overlaps' : 'holds'} the nested Area folder ${dir}`
}

function versionFiles(docs, root, dir, areaDir, problems) {
  const files = new Map()
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(docs, dir, rel)).sort()) {
      if (!rel && name === '.meta.json') continue
      const child = path.posix.join(rel, name)
      const abs = path.join(docs, dir, child)
      const stat = lstatOrNull(abs)
      if (stat?.isSymbolicLink()) problems.push(`refusing to publish symlink: ${dir}/${child}`)
      else if (name === '.meta.json') problems.push(nestedAreaProblem(docs, root, {
        dir: path.posix.dirname(`${dir}/${child}`), refused: dir, refuser: 'clear', areaDir,
      }))
      else if (stat?.isDirectory()) walk(child)
      else if (stat?.isFile()) files.set(child, { content: fs.readFileSync(abs) })
    }
  }
  walk('')
  return files
}

function clearProblems(docs, root, rel, areaDir, problems) {
  const stat = lstatOrNull(path.join(docs, rel))
  if (stat?.isSymbolicLink()) problems.push(`refusing to publish symlink: ${rel}`)
  else if (stat?.isDirectory()) {
    if (lstatOrNull(path.join(docs, rel, '.meta.json'))) {
      problems.push(nestedAreaProblem(docs, root, { dir: rel, refused: rel, refuser: 'clear', areaDir }))
    }
    for (const child of fs.readdirSync(path.join(docs, rel))) clearProblems(docs, root, `${rel}/${child}`, areaDir, problems)
  }
}

function placementProblems(docs, root, areaDir, versions) {
  const problems = []
  const read = (dir) => {
    try { return markerRecordAt(docs, root, dir) } catch (error) {
      if (!(error instanceof FatalError)) throw error
      problems.push(error.message)
      return null
    }
  }
  const records = scan(docs, root).records
  const scope = docsRoot(root)
  const labels = { Version: 'Version folder', Branch: 'Branch Version folder', Mirror: 'mirror Area' }
  for (let dir = areaDir; scope.contains(dir); dir = path.posix.dirname(dir)) {
    const record = read(dir)
    if (record) problems.push(`refusing to publish ${areaDir}: it sits inside a ${labels[record.kind]} at ${dir}`)
    if (dir !== areaDir && records.some((record) => record.areaDir === dir && record.dir !== dir)) {
      problems.push(`refusing to publish ${areaDir}: it sits inside a release Area at ${dir}`)
    }
  }
  for (const version of versions) {
    const parent = path.posix.dirname(version.versionDir)
    if (parent !== areaDir && read(parent)) problems.push(`refusing to publish ${version.versionDir}: it sits inside a mirror Area at ${parent}`)
  }
  // A Mirror Area never sits inside a release Area. The scan skips a Version folder's inside, which `versionFiles`
  // covers: a marker there is refused with the same message.
  for (const mirror of scan(docs, root).mirrors) {
    if (mirror.dir.startsWith(`${areaDir}/`)) problems.push(mirrorAreaProblem(areaDir, mirror.dir))
  }
  return problems
}

export function planSharedArea({ docs, root, entry, repository, branch, sourceBranch, docsRepository, versions = [], areaFiles = new Map() }) {
  const areaDir = path.posix.join(root, entry.area)
  const groups = new Map()
  const add = (name, version, dir, metadata, files) => {
    if (!groups.has(name)) groups.set(name, new Map())
    groups.get(name).set(version, { version, dir, metadata, files })
  }
  const problems = []
  const records = markerRecords(docs, root, areaDir, (_dir, error) => problems.push(error.message))
  try { assertRecordOwners(records, [areaDir], root, repository) } catch (error) {
    if (!(error instanceof FatalError)) throw error
    problems.push(error.message)
  }
  problems.push(...placementProblems(docs, root, areaDir, versions))
  for (const child of lstatOrNull(path.join(docs, areaDir))?.isDirectory() ? fs.readdirSync(path.join(docs, areaDir)) : []) {
    if (lstatOrNull(path.join(docs, areaDir, child))?.isSymbolicLink()) problems.push(`refusing to publish symlink: ${areaDir}/${child}`)
  }
  // A run plans after its prune, so a package folder the prune deletes is already gone from the Area's plan.
  const packageNames = entry.packages === undefined ? [null] : folderNames(path.join(docs, areaDir))
  for (const name of packageNames) {
    const parent = path.posix.join(areaDir, ...(name ? [name] : []))
    if (name && lstatOrNull(path.join(docs, parent, '.meta.json'))) continue
    for (const child of lstatOrNull(path.join(docs, parent))?.isDirectory() ? fs.readdirSync(path.join(docs, parent)) : []) {
      if (lstatOrNull(path.join(docs, parent, child))?.isSymbolicLink()) problems.push(`refusing to publish symlink: ${parent}/${child}`)
    }
    const children = folderNames(path.join(docs, parent))
    for (const version of children) {
      const dir = `${parent}/${version}`
      const marker = path.join(docs, dir, '.meta.json')
      const stat = lstatOrNull(marker)
      const semver = SEMVER_REGEX.test(version.replace(/^v/, ''))
      if (!stat) {
        if (semver) problems.push(`Version folder ${dir} has no .meta.json`)
        continue
      }
      if (!semver) continue
      if (stat?.isSymbolicLink()) {
        problems.push(`refusing to publish symlink: ${dir}/.meta.json`)
        continue
      }
      let metadata
      try { metadata = markerRecordAt(docs, root, dir) } catch (error) {
        if (!(error instanceof FatalError)) throw error
        problems.push(error.message)
        continue
      }
      const content = versionFiles(docs, root, dir, areaDir, problems)
      add(name, version, dir, metadata, content)
    }
    const present = lstatOrNull(path.join(docs, parent))?.isDirectory() ? fs.readdirSync(path.join(docs, parent)) : []
    const hasShared = present.includes('versions.json') || (name
      ? present.some((file) => lstatOrNull(path.join(docs, parent, file))?.isFile() && (file === entry.mainFile || path.posix.extname(file).toLowerCase() === '.md'))
      : present.includes('latest'))
    if (!children.some((child) => SEMVER_REGEX.test(child.replace(/^v/, ''))) && hasShared) {
      problems.push(`half-deleted package: ${parent} has shared files or a latest copy but no Version folders`)
    }
  }
  for (const version of versions) {
    const metadata = readMarkerRecord(version.files.get(`${version.versionDir}/.meta.json`).content, `${version.versionDir}/.meta.json`, root)
    const files = new Map([...version.files].filter(([rel]) => rel !== `${version.versionDir}/.meta.json`)
      .map(([rel, file]) => [rel.slice(version.versionDir.length + 1), file]))
    if (!files.has(entry.mainFile)) {
      problems.push(`mainFile "${entry.mainFile}" is missing from new Version folder ${version.versionDir}`)
    }
    add(version.name, version.version, version.versionDir, metadata, files)
  }
  const files = new Map(areaFiles)
  const removals = []
  const rows = []
  const warnings = []
  // `name` is null for an unnamed release entry; join() would reject it, and the URL has no such segment.
  const url = (...segments) => `https://raw.githubusercontent.com/${docsRepository}/${branch}/${urlPath([
    path.posix.join(root, ...segments.filter(Boolean)),
  ])}`
  for (const [name, group] of [...groups].sort(([a], [b]) => (a ?? '').localeCompare(b ?? ''))) {
    const sorted = [...group.values()].sort((a, b) => compareSemver(b.version, a.version) || a.version.localeCompare(b.version))
    const parent = path.posix.join(areaDir, ...(name ? [name] : []))
    for (const item of sorted) {
      if (!item.files.has(entry.mainFile)) warnings.push(
        `Warning: mainFile "${entry.mainFile}" is missing from older Version folder ${item.dir}`,
      )
    }
    put(files, `${parent}/versions.json`, metaFile(sorted.map((item) => ({
      version: item.version, date: item.metadata.date, url: url(entry.area, name, item.version, entry.mainFile),
    }))))
    const latest = sorted.find((item) => !SEMVER_REGEX.exec(item.version.replace(/^v/, '')).groups.prerelease)
    if (name) {
      for (const child of lstatOrNull(path.join(docs, parent))?.isDirectory() ? fs.readdirSync(path.join(docs, parent)) : []) {
        // The Branch Version folder of both branches stays: it holds content, not a version of this list.
        if (group.has(child) || child === 'versions.json' || child === sourceBranch) continue
        removals.push(`${parent}/${child}`)
      }
    } else {
      removals.push(`${parent}/latest`)
    }
    if (!latest) continue
    const target = name ? parent : `${parent}/latest`
    for (const [rel, file] of latest.files) put(files, `${target}/${rel}`, file)
    if (name) rows.push({ name, version: latest.version, files: [...latest.files.keys()]
      .filter((rel) => path.posix.extname(rel).toLowerCase() === '.md')
      .sort((a, b) => a === 'README.md' ? -1 : b === 'README.md' ? 1 : a.localeCompare(b))
      .map((rel) => ({ name: rel, url: url(entry.area, name, rel) })) })
  }
  if (entry.packages !== undefined) put(files, `${areaDir}/index.json`, metaFile({ [entry.area.split('/').at(-1)]: rows }))
  for (const name of lstatOrNull(path.join(docs, areaDir))?.isDirectory() ? fs.readdirSync(path.join(docs, areaDir)) : []) {
    const rel = `${areaDir}/${name}`
    if (!lstatOrNull(path.join(docs, rel))?.isDirectory() && !files.has(rel)) removals.push(rel)
  }
  try { assertAreaWritable(docs, areaDir, files, removals) } catch (error) {
    if (!(error instanceof FatalError)) throw error
    problems.push(error.message)
  }
  for (const rel of removals) clearProblems(docs, root, rel, areaDir, problems)
  for (const rel of files.keys()) {
    try { assertNoSymlinkPath(docs, rel) } catch (error) { problems.push(error.message) }
    const stat = lstatOrNull(path.join(docs, rel))
    if (stat?.isDirectory() && !removals.some((dir) => rel === dir || rel.startsWith(`${dir}/`))) problems.push(`not a file: ${rel}`)
    for (let parent = path.posix.dirname(rel); parent.startsWith(`${areaDir}/`); parent = path.posix.dirname(parent)) {
      const marker = `${parent}/.meta.json`
      if (lstatOrNull(path.join(docs, marker))) {
        problems.push(nestedAreaProblem(docs, root, { dir: parent, refused: rel, refuser: 'write', areaDir, overlap: true }))
      }
      const parentStat = lstatOrNull(path.join(docs, parent))
      if (parentStat && !parentStat.isDirectory() && !removals.includes(parent)) problems.push(`not a folder: ${parent}`)
    }
  }
  if (problems.length) throw new FatalError([...new Set(problems)].join('\n'))
  return { files, removals, warnings }
}

export function writeSharedArea(docs, plan) {
  const removed = []
  for (const rel of plan.removals) {
    // A removal the docs repo does not hold has nothing to stage, and staging a path that never existed fails.
    if (!lstatOrNull(path.join(docs, rel))) continue
    fs.rmSync(path.join(docs, rel), { recursive: true, force: true })
    removed.push(rel)
  }
  for (const [rel, file] of plan.files) writeFile(docs, rel, file)
  for (const warning of plan.warnings) writeSummary(warning)
  return [...plan.files.keys(), ...removed]
}

// `isPruned` leaves out folders that prune deletes before the state is compared again.
export function snapshotAreaState(docs, root, areaDir, entry, isPruned = () => false) {
  const folders = existingVersionFolders(docs, areaDir, entry)
  for (const folder of folders) {
    if (!isPruned(folder.dir)) assertNoSymlinkPath(docs, `${folder.dir}/.meta.json`)
  }
  const metadata = []
  const records = markerRecords(docs, root, areaDir, (dir, error) => {
    const rel = `${dir}/.meta.json`
    metadata.push([rel, lstatOrNull(path.join(docs, rel))?.isFile() ? fs.readFileSync(path.join(docs, rel), 'utf8') : error.message])
  })
  for (const record of records) {
    if (record.areaDir !== areaDir || isPruned(record.dir)) continue
    const rel = `${record.dir}/.meta.json`
    metadata.push([rel, fs.readFileSync(path.join(docs, rel), 'utf8')])
  }
  // The package folders a rebuild plans: everything under one is the rebuild's, plus the latest copy.
  const owned = new Set(folders.map((folder) => folder.name))
  const shared = []
  for (const rel of rebuiltFiles(docs, areaDir, entry, isPruned, owned)) {
    shared.push([rel, fs.readFileSync(path.join(docs, rel)).toString('base64')])
  }
  return JSON.stringify({ metadata, shared })
}

// Every file of the Area a rebuild may write or delete: its content is part of the freshness snapshot, so a run
// that planned older Area files does not roll back the newer ones another run published. Version folders are
// covered by their metadata, and anything a rebuild leaves alone says nothing about freshness.
function rebuiltFiles(docs, areaDir, entry, isPruned, owned) {
  const files = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(path.join(docs, dir)).sort()) {
      const rel = `${dir}/${name}`
      if (isPruned(rel)) continue
      const stat = lstatOrNull(path.join(docs, rel))
      if (!stat) continue
      if (!stat.isDirectory()) {
        if (stat.isFile()) files.push(rel)
        continue
      }
      if (keptFolder(docs, rel, areaDir, entry, owned)) continue
      walk(rel)
    }
  }
  if (lstatOrNull(path.join(docs, areaDir))?.isDirectory()) walk(areaDir)
  return files
}

// A folder a rebuild leaves exactly as it is: a Version folder, which its metadata covers, a folder at the top of
// the Area that holds no Version folder, and, in an Area without `packages`, every folder but the latest copy.
function keptFolder(docs, rel, areaDir, entry, owned) {
  if (lstatOrNull(path.join(docs, rel, '.meta.json'))) return true
  if (path.posix.dirname(rel) !== areaDir) return false
  return entry.packages === undefined ? rel !== `${areaDir}/latest` : !owned.has(path.posix.basename(rel))
}
