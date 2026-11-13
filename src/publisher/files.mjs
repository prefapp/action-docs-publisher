
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { SEMVER_REGEX, areaProblem, matchTag } from './entries.mjs'

export class FatalError extends Error {}

// A tag whose content does not fit the entry's settings: `build` fails or `collect` finds nothing.
// A release publish fails on it; the manual run skips the tag and reports it.
export class TagContentError extends FatalError {}

export const GLOB_CHARS = /[*?]/

export const GIT_DIR = '.git'

// Git keeps the repository's own object store and config here, including credentials.
export const namesGitPath = (rel) => rel.split('/').includes(GIT_DIR)

export const lstatOrNull = (target) => {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }
}

export function git(cwd, args, input) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    throw new FatalError(`git ${args[0]} failed: ${String(error.stderr).trim()}`)
  }
}

export function gitStatus(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' })
}

// The token of each checkout's remote, by checkout path. No checkout keeps credentials in its git config, and no
// token is in the environment: a build command runs code from the source repo, at old tags too, and must find none.
const credentials = new Map()

const TOKEN_FILE_VARIABLES = ['DOCS_PUBLISHER_SOURCE_TOKEN_FILE', 'DOCS_PUBLISHER_DOCS_TOKEN_FILE']

// The workflow hands each token over in a file. Reading it deletes it, so the token lives only in this process.
export function takeCredential(cwd, file) {
  if (!file) return
  const token = fs.readFileSync(file, 'utf8').trim()
  fs.rmSync(file)
  if (token) credentials.set(path.resolve(cwd), token)
}

// A git command that talks to the checkout's remote. The token goes to that one command, as the header
// actions/checkout would have stored in the git config.
export function gitRemote(cwd, args) {
  const token = credentials.get(path.resolve(cwd))
  if (!token) return gitStatus(cwd, args)
  const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${server}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    },
  })
}

function buildEnvironment() {
  const env = { ...process.env }
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', ...TOKEN_FILE_VARIABLES]) delete env[name]
  return env
}

// The paths git tracks, out of `paths`. A path the docs branch never had, such as an ignored leftover of a rebuilt
// Area, has nothing to stage or restore, and git fails on a pathspec that matches no file.
export function trackedPaths(docs, paths) {
  if (paths.length === 0) return []
  const result = gitStatus(docs, ['--literal-pathspecs', 'ls-files', '-z', '--', ...paths])
  if (result.status !== 0) throw new FatalError(`git ls-files failed: ${result.stderr.trim()}`)
  const tracked = result.stdout.split('\0').filter(Boolean)
  return paths.filter((rel) => tracked.some((file) => file === rel || file.startsWith(`${rel}/`)))
}

export function isAncestor(source, before, after) {
  return gitStatus(source, ['merge-base', '--is-ancestor', before, after]).status === 0
}

export function withTagWorktree(source, tag, run) {
  const temporary = fs.mkdtempSync(path.join(tmpdir(), 'docs-publisher-tag-'))
  const checkout = path.join(temporary, 'source')
  try {
    git(source, ['worktree', 'add', '--quiet', '--detach', checkout, `refs/tags/${tag}`])
    return run(checkout)
  } finally {
    if (lstatOrNull(checkout)) git(source, ['worktree', 'remove', '--force', checkout])
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

const patternRegExp = (pattern) => {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        source += '(?:[\\s\\S]*/)?'
        i += 2
      } else {
        source += '[\\s\\S]*'
        i += 1
      }
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

export function matchesGlob(pattern, value) {
  return patternRegExp(pattern).test(value)
}

function staticPrefix(pattern) {
  const segments = pattern.split('/')
  const index = segments.findIndex((segment) => GLOB_CHARS.test(segment))
  return index === -1 ? pattern : segments.slice(0, index).join('/')
}

export function assertNoSymlinkAncestors(base, rel, label = rel) {
  let current = base
  for (const part of path.posix.normalize(rel).split('/').filter(Boolean)) {
    current = path.join(current, part)
    const stat = lstatOrNull(current)
    if (!stat) return
    if (stat.isSymbolicLink()) throw new FatalError(`refusing to publish symlink: ${label}`)
  }
}

function expandPattern(base, pattern) {
  const matcher = patternRegExp(pattern)
  const parts = pattern.split('/')
  const traversed = parts.slice(0, -1).map((_, index) => patternRegExp(parts.slice(0, index + 1).join('/')))
  const prefix = staticPrefix(pattern)
  // A glob never reaches into the .git folder: publishing it turns the Area into an embedded repository.
  if (namesGitPath(prefix)) return []
  assertNoSymlinkAncestors(base, prefix, pattern)
  const found = []
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === GIT_DIR) continue
      const abs = path.join(dir, name)
      const childRel = rel ? `${rel}/${name}` : name
      const stat = fs.lstatSync(abs)
      if (stat.isSymbolicLink() && (matcher.test(childRel) || traversed.some((part) => part.test(childRel)))) {
        throw new FatalError(`refusing to publish symlink: ${childRel}`)
      }
      if (stat.isDirectory()) {
        walk(abs, childRel)
      } else if (matcher.test(childRel) && stat.isFile()) {
        found.push(childRel)
      }
    }
  }
  const start = prefix ? path.join(base, prefix) : base
  if (lstatOrNull(start)?.isDirectory()) walk(start, prefix)
  return found
}

export function collectFiles(base, rule) {
  if (!GLOB_CHARS.test(rule.from)) {
    assertNoSymlinkAncestors(base, rule.from)
    const abs = path.join(base, rule.from)
    const stat = lstatOrNull(abs)
    if (!stat) throw new TagContentError(`not found: ${rule.from}`)
    if (!stat.isFile()) throw new TagContentError(`not a file: ${rule.from}`)
    return [{ from: abs, to: rule.to, content: fs.readFileSync(abs) }]
  }
  const prefix = staticPrefix(rule.from)
  return expandPattern(base, rule.from).map((match) => {
    const from = path.join(base, match)
    return {
      from,
      to: path.posix.join(rule.to, prefix ? match.slice(prefix.length + 1) : match),
      content: fs.readFileSync(from),
    }
  })
}

export function put(map, key, file) {
  if (map.has(key)) throw new FatalError(`two files publish to ${key}`)
  map.set(key, file)
}

// A planned file that is also a folder of another planned file: writing the deeper one fails after local writes.
// `planned` maps a path to the rule that writes it; `base` is the prefix the message leaves out.
export function assertNoFileFolderConflicts(area, base, planned) {
  const relative = (rel) => (rel === base ? '.' : rel.slice(base.length + 1))
  for (const [rel, rule] of planned) {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/')
      const owner = planned.get(ancestor)
      if (owner === undefined) continue
      throw new FatalError(
        `Area "${area}": ${owner} writes the file ${relative(ancestor)}, but ${rule} writes ${relative(rel)} inside it`,
      )
    }
  }
}

export function groupBy(items, keyFor) {
  const groups = new Map()
  for (const item of items) {
    const key = keyFor(item)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  return groups
}

export function assertCollectable(rel, from, versionDir) {
  if (path.posix.basename(rel) === '.meta.json') {
    throw new FatalError(
      `collect from "${from}" would publish ${rel}: .meta.json marks ${versionDir === undefined ? 'an Area' : 'a Version folder'}, which the publisher writes`,
    )
  }
  if (
    versionDir !== undefined &&
    SEMVER_REGEX.test(rel.slice(versionDir.length + 1).split('/')[0].replace(/^v/, ''))
  ) {
    throw new FatalError(`collect from "${from}" would publish ${rel}: a version-shaped top-level filename is reserved for Version folders`)
  }
}

export function folderNames(dir) {
  const stat = lstatOrNull(dir)
  if (!stat || !stat.isDirectory()) return []
  return fs.readdirSync(dir).filter((name) => lstatOrNull(path.join(dir, name))?.isDirectory())
}

export const metaFile = (fields) => ({ content: JSON.stringify(fields, null, 2) + '\n' })

export function readAreaFiles(source, areaDir, entry) {
  const files = new Map()
  for (const rule of entry.areaFiles) {
    for (const file of collectFiles(source, rule)) {
      put(files, path.posix.join(areaDir, file.to), { content: file.content })
    }
  }
  return files
}

export function runBuild(entry, cwd, where) {
  if (entry.build === undefined) return
  const result = spawnSync('sh', ['-c', entry.build], { cwd, env: buildEnvironment(), stdio: ['ignore', 'inherit', 'inherit'] })
  if (result.status === 0) return
  throw new TagContentError(`build failed in ${where} (exit ${result.status ?? result.signal})`)
}

export function assertNoSymlinkPath(base, rel) {
  let current = base
  for (const part of rel.split('/')) {
    current = path.join(current, part)
    const stat = lstatOrNull(current)
    if (!stat) return
    if (stat.isSymbolicLink()) throw new FatalError(`refusing to write through symlink: ${rel}`)
  }
}

// A deletion clears a whole tree, so every symlink in it is refused before the first file goes: the link may point
// outside the docs checkout, and a prune never reaches through one.
export function assertNoSymlinkTree(docs, rel) {
  const abs = path.join(docs, rel)
  const stat = lstatOrNull(abs)
  if (!stat) return
  if (stat.isSymbolicLink()) throw new FatalError(`refusing to write through symlink: ${rel}`)
  if (!stat.isDirectory()) return
  for (const name of fs.readdirSync(abs).sort()) assertNoSymlinkTree(docs, `${rel}/${name}`)
}

export function writeFile(docs, rel, file) {
  assertNoSymlinkPath(docs, rel)
  const target = path.join(docs, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, file.content)
}

// Only the run summary file: the log keeps its own copy of every line it reports.
export function appendSummary(text) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (file) fs.appendFileSync(file, `${text}\n`)
}

export function writeSummary(text) {
  console.log(text)
  appendSummary(text)
}

// The first source repo to publish into an Area owns it, whatever its mode, so every mode names the owner and the
// way out in the same sentence.
export function ownershipProblem(area, owner, repository) {
  return `Area "${area}" belongs to ${owner}, but this repo is ${repository}. Choose another Area. If this repo was renamed or is taking over the Area, update "source" in that Area's .meta.json files in the docs repo.`
}

// One reader for every marker: its body and location together establish the kind, owner and Area. No caller
// trusts partial metadata or guesses a Branch Version folder's Area from its path.
export function readMarkerRecord(bytes, marker, root) {
  const invalid = (outsideRoot = false) => {
    const error = new FatalError(`invalid .meta.json: ${marker}`)
    error.outsideRoot = outsideRoot
    throw error
  }
  let metadata
  try { metadata = JSON.parse(bytes) } catch { invalid() }
  const text = (key) => typeof metadata[key] === 'string' && metadata[key] !== ''
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !text('source') || !text('date')) invalid()
  if (!/^\d{4}-\d{2}-\d{2}T/.test(metadata.date) || !Number.isFinite(Date.parse(metadata.date))) invalid()
  const dir = path.posix.dirname(marker)
  if (!dir.startsWith(`${root}/`)) invalid(true)
  if ('tag' in metadata) {
    if (!text('tag') || (metadata.specHash !== undefined &&
        (typeof metadata.specHash !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.specHash)))) invalid()
    let release
    try { release = matchTag(metadata.tag) } catch { invalid() }
    if (!release || path.posix.basename(dir) !== release.version) invalid()
    const parent = path.posix.dirname(dir)
    const areaDir = release.name ? path.posix.dirname(parent) : parent
    if (!areaDir.startsWith(`${root}/`)) invalid(true)
    return { ...metadata, kind: 'Version', dir, areaDir, name: release.name ? path.posix.basename(parent) : null,
      version: release.version, packageDir: release.name ? parent : null }
  }
  // A version-shaped folder cannot be reclassified as a Mirror when its tag is damaged or missing.
  if (SEMVER_REGEX.test(path.posix.basename(dir).replace(/^v/, ''))) invalid()
  if (!text('sourceRevision') || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(metadata.sourceRevision) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(metadata.date) || isoDate(metadata.date) !== metadata.date) invalid()
  if ('branch' in metadata) {
    if (!text('branch') || areaProblem(metadata.area) !== null) invalid()
    const areaDir = path.posix.join(root, metadata.area)
    const relative = dir.startsWith(`${areaDir}/`) ? dir.slice(areaDir.length + 1) : ''
    const segments = relative.split('/')
    if (!areaDir.startsWith(`${root}/`) || !relative || segments.length > 2 || segments.at(-1) !== metadata.branch) invalid()
    return { ...metadata, kind: 'Branch', dir, areaDir, name: segments.length === 2 ? segments[0] : null }
  }
  if (!text('sourceBranch')) invalid()
  return { ...metadata, kind: 'Mirror', dir, areaDir: dir }
}

// Missing markers have no record. Existing markers, including a non-file marker, must validate before use.
export function markerRecordAt(docs, root, dir) {
  const marker = `${dir}/.meta.json`
  assertNoSymlinkPath(docs, marker)
  const stat = lstatOrNull(path.join(docs, marker))
  if (!stat) return null
  if (!stat.isFile()) throw new FatalError(`invalid .meta.json: ${marker}`)
  return readMarkerRecord(fs.readFileSync(path.join(docs, marker), 'utf8'), marker, root)
}

// Every record under a folder, excluding the folder itself. A Version's content has its own nesting guards.
// Prune can defer damaged version-shaped folders it does not affect; the reader still refuses their metadata.
export function markerRecords(docs, root, base = root, onInvalid) {
  const records = []
  const walk = (dir) => {
    for (const name of folderNames(path.join(docs, dir)).sort()) {
      const child = `${dir}/${name}`
      // Discovery never follows a marker symlink; the write and prune tree guards refuse affected links.
      if (lstatOrNull(path.join(docs, child, '.meta.json'))?.isSymbolicLink()) { walk(child); continue }
      let record
      try { record = markerRecordAt(docs, root, child) } catch (error) {
        if (!(error instanceof FatalError) || !onInvalid) throw error
        onInvalid(child, error)
        continue
      }
      if (record) records.push(record)
      if (record?.kind !== 'Version') walk(child)
    }
  }
  if (lstatOrNull(path.join(docs, base))?.isDirectory()) walk(base)
  return records
}

// Every kind of record claims an Area in the same way. The caller supplies all Areas it will change, including
// retired Areas with no surviving entry.
export function assertMarkerOwner(record, area, repository) {
  if (record && record.source !== repository) throw new FatalError(ownershipProblem(area, record.source, repository))
}

export function assertRecordOwners(records, areaDirs, root, repository) {
  const affected = new Set(areaDirs)
  const problems = records.filter((record) => affected.has(record.areaDir) && record.source !== repository)
    .map((record) => ownershipProblem(record.areaDir.slice(root.length + 1), record.source, repository))
  if (problems.length) throw new FatalError([...new Set(problems)].join('\n'))
}

export function assertAreaPlacement(docs, areaDir, root, mode, plannedFiles) {
  assertNoSymlinkPath(docs, areaDir)
  for (let dir = areaDir; dir === root || dir.startsWith(`${root}/`); dir = path.posix.dirname(dir)) {
    const marker = `${dir}/.meta.json`
    const planned = plannedFiles.get(marker)?.content
    const record = planned === undefined ? markerRecordAt(docs, root, dir) : readMarkerRecord(planned, marker, root)
    if (!record) continue
    if (record.kind === 'Version') {
      throw new FatalError(`refusing to publish ${areaDir}: it sits inside a Version folder at ${marker}`)
    }
    // A Branch Version folder is a release Area's folder too, so a Mirror Area never sits inside one.
    if (record.kind === 'Branch') {
      throw new FatalError(`refusing to publish ${areaDir}: it sits inside a Branch Version folder at ${dir}`)
    }
    // A Mirror Area may sit inside any Area, owned by any source repo; a release Area never does.
    if (mode !== 'mirror') {
      throw new FatalError(`refusing to publish ${areaDir}: it sits inside a mirror Area at ${dir}`)
    }
  }
}

// A Branch Version folder is replaced whole, so the run removes it and writes it again: no part of its path may be a
// symlink, and neither may anything inside it, its own marker included, so the removal reaches the docs checkout and
// nothing outside it. The folder and every Area marker a nested folder holds must belong to this repo, the rule a
// Version folder's and a Mirror Area's marker follows, so a run never replaces another repo's docs.
export function assertBranchReplaceable(docs, root, dir, area, repository) {
  assertNoSymlinkPath(docs, dir)
  if (!lstatOrNull(path.join(docs, dir))?.isDirectory()) return
  const problems = []
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(docs, rel)).sort()) {
      const child = `${rel}/${name}`
      const stat = lstatOrNull(path.join(docs, child))
      if (!stat) continue
      // The folder goes with everything in it, so a symlink is refused here, before any removal, like a write through one.
      if (stat.isSymbolicLink()) {
        problems.push(`refusing to publish symlink: ${child}`)
        continue
      }
      if (name === '.meta.json') {
        const record = markerRecordAt(docs, root, rel)
        try { assertMarkerOwner(record, area, repository) } catch (error) { problems.push(error.message) }
      } else if (stat.isDirectory()) walk(child)
    }
  }
  walk(dir)
  if (problems.length > 0) throw new FatalError([...new Set(problems)].join('\n'))
}

export function assertNoNestedWrites(docs, areas, root) {
  const plannedDirs = new Set(areas.map((area) => area.areaDir))
  for (const area of areas) {
    const depth = area.areaDir.split('/').length
    for (const rel of area.files.keys()) {
      const parts = rel.split('/')
      for (let i = depth + 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        if (plannedDirs.has(dir)) {
          throw new FatalError(`"${area.area}" would write into the nested Area folder ${dir}`)
        }
        // A Branch Version folder is not a nested Area: the publisher writes it, and the guards check its content.
        if (markerRecordAt(docs, root, dir)?.kind === 'Mirror') {
          throw new FatalError(`"${area.area}" would write into the nested Area folder ${dir}`)
        }
      }
    }
  }
}

export function existingVersionFolders(docs, areaDir, entry) {
  if (entry.packages === undefined) {
    return folderNames(path.join(docs, areaDir))
      .filter((version) => version.startsWith('v') && SEMVER_REGEX.test(version.slice(1)))
      .map((version) => ({ name: null, version, dir: `${areaDir}/${version}` }))
  }
  const folders = []
  for (const name of folderNames(path.join(docs, areaDir))) {
    for (const version of folderNames(path.join(docs, areaDir, name))) {
      if (SEMVER_REGEX.test(version)) folders.push({ name, version, dir: `${areaDir}/${name}/${version}` })
    }
  }
  return folders.sort((a, b) => a.dir.localeCompare(b.dir))
}

// The Area-file bytes the docs repo holds now: what an Area keeps when its Version metadata moved under a run,
// since another run published newer ones and this one must not roll them back.
export function keptAreaFiles(docs, areaFiles) {
  const kept = new Map()
  for (const rel of areaFiles.keys()) {
    assertNoSymlinkPath(docs, rel)
    if (lstatOrNull(path.join(docs, rel))?.isFile()) kept.set(rel, { content: fs.readFileSync(path.join(docs, rel)) })
  }
  return kept
}

export function keptAreaFilesSummary(areaDir, run) {
  writeSummary(`Kept the Area files of \`${areaDir}\`: the Area's shared files changed since ${run} started.`)
}

// A push publishes the rest even when one Area cannot be rebuilt, so it names the problem and leaves the repair to a run.
export function areaFileProblemsSummary(areaDir, problem) {
  writeSummary(`Kept the Area files of \`${areaDir}\`: ${problem}; run a manual run to repair it.`)
}

// Empties an Area folder but keeps nested Areas (folders with a .meta.json) that are not in plannedDirs.
export function clearArea(docs, areaDir, plannedDirs) {
  const walk = (dirRel) => {
    for (const name of fs.readdirSync(path.join(docs, dirRel)).sort()) {
      const rel = `${dirRel}/${name}`
      const abs = path.join(docs, rel)
      if (!lstatOrNull(abs)?.isDirectory()) {
        fs.rmSync(abs)
        continue
      }
      if (!plannedDirs.has(rel) && lstatOrNull(path.join(abs, '.meta.json'))?.isFile()) continue
      walk(rel)
      if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs)
    }
  }
  if (lstatOrNull(path.join(docs, areaDir))?.isDirectory()) walk(areaDir)
}

export function hasTreeAt(source, rev, folder) {
  return gitStatus(source, ['cat-file', '-t', `${rev}:${folder}`]).stdout.trim() === 'tree'
}

export function tagDate(source, tag) {
  const date = git(source, ['for-each-ref', `refs/tags/${tag}`, '--format=%(creatordate:iso-strict)'])
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function isoDate(date) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function commitDate(source, revision) {
  return isoDate(git(source, ['show', '-s', '--format=%cI', revision]))
}

export function tagExists(source, tag) {
  return gitStatus(source, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]).status === 0
}
