
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { FatalError, GLOB_CHARS, namesGitPath } from './files.mjs'

// Only settings that shape Version folder content belong in this hash.
export function specHash({ collect, build, packages }) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    }
    return value
  }
  return createHash('sha256').update(JSON.stringify(canonical({ collect, build, packages }))).digest('hex')
}

export const TAG_PATTERN = '<name>-v<semver>'
export const UNNAMED_TAG_PATTERN = 'v<semver>'

const NAME = '[A-Za-z0-9][A-Za-z0-9_-]*'
const NUMERIC_IDENTIFIER = '0|[1-9]\\d*'
const PRERELEASE_IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)'
const BUILD_IDENTIFIER = '[0-9A-Za-z-]+'
const SEMVER =
  `(?:${NUMERIC_IDENTIFIER})\\.(?:${NUMERIC_IDENTIFIER})\\.(?:${NUMERIC_IDENTIFIER})` +
  `(?:-(?<prerelease>${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?` +
  `(?:\\+${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*)?`
const TAG_REGEX = new RegExp(`^(?<name>${NAME})-v(?<version>${SEMVER})$`)
const UNNAMED_TAG_REGEX = new RegExp(`^(?<version>v${SEMVER})$`)
const NAME_REGEX = new RegExp(`^${NAME}$`)
export const SEMVER_REGEX = new RegExp(`^${SEMVER}$`)

export function matchTag(tag) {
  const named = TAG_REGEX.exec(tag)
  if (named) {
    const { name, version, prerelease } = named.groups
    if (isReservedName(name)) throw new FatalError(`tag "${tag}" names "${name}", a name the publisher reserves`)
    return { name, version, prerelease: prerelease !== undefined }
  }
  const unnamed = UNNAMED_TAG_REGEX.exec(tag)
  if (unnamed) {
    const { version, prerelease } = unnamed.groups
    return { name: null, version, prerelease: prerelease !== undefined }
  }
  return null
}

const SHARED_KEYS = ['area', 'mode', 'collect', 'build']
const RELEASE_ONLY_KEYS = ['packages', 'prereleases', 'areaFiles', 'mainFile', 'tagNames', 'publishSourceBranch']
const MIRROR_ONLY_KEYS = ['paths']
const ENTRY_KEYS = new Set([...SHARED_KEYS, ...RELEASE_ONLY_KEYS, ...MIRROR_ONLY_KEYS])

export function nestedRepoPath(value) {
  if (typeof value !== 'string' || value === '' || path.posix.isAbsolute(value) || value.includes('\\')) {
    return { refusal: 'malformed' }
  }
  const clean = path.posix.normalize(value).replace(/\/+$/, '')
  if (clean === '..' || clean.startsWith('../')) return { refusal: 'escapes' }
  return { path: clean }
}

// The entries file as the source repo's git names it: a push range and a plan's changed files are repo-relative, while
// the action holds the absolute path it resolved against the workspace.
export function entriesPath(source, entries) {
  return path.relative(source, entries).split(path.sep).join('/')
}

function validateNoGitPath(value, label, fail) {
  if (namesGitPath(value)) fail(`${label} uses ".git", the Git administrative folder`)
}

function validateRelativeSubPath(value, label, fail) {
  if (nestedRepoPath(value).refusal) {
    const hint =
      typeof value !== 'string' ? ' (quote the value in docs_publisher.yaml so YAML reads it as a string)' : ''
    fail(`${label} must be a relative path inside the repo: ${JSON.stringify(value) ?? String(value)}${hint}`)
  }
}

// The rules an Area path obeys. A Branch Version marker names the release Area its folder was published into, so the
// entries file's `area` and a marker's `area` are read the same way: a normalized relative path inside the repo, with
// no escaping segment and a last segment that is neither reserved nor a Git folder. Returns the problem, or null.
export function areaProblem(value) {
  const { refusal } = nestedRepoPath(value)
  if (refusal) return refusal
  if (value.endsWith('/') || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    return 'not-normalized'
  }
  if (isReservedName(value.split('/').at(-1))) return 'reserved'
  if (namesGitPath(value)) return 'git'
  return null
}

// The entries file's own `area`, whose rules a Branch Version marker's `area` is read with too.
function validateArea(value, fail) {
  const problem = areaProblem(value)
  if (problem === null) return
  if (problem === 'malformed' || problem === 'escapes') validateRelativeSubPath(value, 'area', fail)
  if (problem === 'not-normalized') fail(`area "${value}" must be a normalized Area path`)
  if (problem === 'reserved') fail(`area "${value}" uses a name the publisher reserves`)
  fail(`area "${value}" uses ".git", the Git administrative folder`)
}

function validateRuleList(list, listName, fail, area) {
  if (!Array.isArray(list)) fail(`${listName} must be a list`)
  for (const rule of list) {
    const keys = Object.keys(rule ?? {})
    if (keys.length !== 2 || !keys.includes('from') || !keys.includes('to')) {
      fail(`${listName} rule must have only from and to`)
    }
    validateRelativeSubPath(rule.from, `${listName} from`, fail)
    validateNoGitPath(rule.from, `${listName} from "${rule.from}"`, fail)
    validateRelativeSubPath(rule.to, `${listName} to`, fail)
    validateNoGitPath(rule.to, `${listName} to "${rule.to}"`, fail)
    if (GLOB_CHARS.test(rule.to)) fail(`${listName} to must not contain a glob`)
    const folderTo = path.posix.normalize(rule.to) === '.' || rule.to.endsWith('/')
    if (!GLOB_CHARS.test(rule.from) && folderTo) {
      fail(
        `${listName} rule from "${rule.from}" to "${rule.to}" in area "${area}": ` +
          "a file's `to` is its destination file path, not a folder",
      )
    }
  }
}

function validatePaths(list, fail) {
  if (!Array.isArray(list) || list.length === 0) fail('a mirror entry needs a non-empty paths list')
  if (list.some((item) => typeof item !== 'string' || item === '')) {
    const hint = list.some((item) => typeof item !== 'string')
      ? ' (quote the value in docs_publisher.yaml so YAML reads it as a string)'
      : ''
    fail(`paths must be a list of non-empty strings${hint}`)
  }
}

const SHARED_FILE_NAMES = new Set(['index.json', 'versions.json', '.meta.json'])

function isReservedName(name) {
  return SHARED_FILE_NAMES.has(name) || name === 'latest' || SEMVER_REGEX.test(name.replace(/^v/, ''))
}

function validateAreaFileNames(list, fail, area, unnamed) {
  for (const rule of list) {
    if (rule.to.includes('/') || rule.to === '.') {
      fail(`areaFiles to "${rule.to}" in area "${area}" must be a single file name at the top of the Area`)
    }
    if (GLOB_CHARS.test(rule.from)) fail(`areaFiles from "${rule.from}" in area "${area}" must be one file, not a glob`)
    if (SHARED_FILE_NAMES.has(rule.to)) fail(`areaFiles to "${rule.to}" in area "${area}" is one of the publisher's shared files`)
    if (unnamed && rule.to === 'latest') fail(`areaFiles to "${rule.to}" in area "${area}" is the Latest folder the publisher writes`)
  }
}

function validateCollectNames(list, fail, area, mirror) {
  for (const rule of list) {
    const to = path.posix.normalize(rule.to).replace(/\/+$/, '')
    if (path.posix.basename(to) === '.meta.json') {
      fail(`collect to "${rule.to}" in area "${area}": .meta.json marks ${mirror ? 'an Area' : 'a Version folder'}, which the publisher writes`)
    }
  }
}

function validateEntry(entry, fail, mirror) {
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(key)) fail(`unknown key "${key}"`)
  }

  if (mirror) {
    for (const key of RELEASE_ONLY_KEYS) {
      if (key in entry) fail(`"${key}" is not allowed on a mirror entry`)
    }
    if (!('paths' in entry) && 'build' in entry) fail('a mirror entry with build needs paths')
    if ('paths' in entry) validatePaths(entry.paths, fail)
  } else {
    for (const key of MIRROR_ONLY_KEYS) {
      if (key in entry) fail(`"${key}" is not allowed on a release entry`)
    }
    const named = entry.packages !== undefined
    if ('prereleases' in entry && typeof entry.prereleases !== 'boolean') {
      const hint =
        typeof entry.prereleases === 'string' ? ' (write true or false without quotes)' : ''
      fail(`prereleases must be true or false${hint}`)
    }
    if ('publishSourceBranch' in entry && typeof entry.publishSourceBranch !== 'boolean') {
      const hint =
        typeof entry.publishSourceBranch === 'string' ? ' (write true or false without quotes)' : ''
      fail(`publishSourceBranch must be true or false${hint}`)
    }
    if (named) validateRelativeSubPath(entry.packages, 'packages', fail)
    validateRuleList(entry.areaFiles ?? [], 'areaFiles', fail, entry.area)
    validateAreaFileNames(entry.areaFiles ?? [], fail, entry.area, !named)
    if ('tagNames' in entry) {
      if (!named) fail('tagNames needs packages')
      validateRelativeSubPath(entry.tagNames, 'tagNames', fail)
    }
    if ('mainFile' in entry) validateRelativeSubPath(entry.mainFile, 'mainFile', fail)
  }

  validateArea(entry.area, fail)
  validateRuleList(entry.collect ?? [], 'collect', fail, entry.area)
  if ((entry.collect ?? []).length === 0) fail('collect must list at least one rule')
  validateCollectNames(entry.collect ?? [], fail, entry.area, mirror)
  if ('build' in entry && (typeof entry.build !== 'string' || entry.build === '')) {
    const hint =
      typeof entry.build !== 'string' ? ' (quote the value in docs_publisher.yaml so YAML reads it as a string)' : ''
    fail(`build must be a non-empty string${hint}`)
  }
}

// A Branch Version folder sits inside the Area under the folder named after source_branch, so the branch name is a
// folder name: one segment, and no name another folder of the Area already uses.
function validateBranchFolder(entry, sourceBranch, fail) {
  if (entry.publishSourceBranch !== true || sourceBranch === undefined) return
  const refuse = (why) => fail(`publishSourceBranch would publish an Area folder named "${sourceBranch}": ${why}`)
  if (sourceBranch === '') refuse('source_branch is empty')
  else if (sourceBranch === '.' || sourceBranch === '..' || nestedRepoPath(sourceBranch).refusal) {
    refuse('a Branch Version folder is one name inside the Area, not a path')
  } else if (sourceBranch.includes('/')) refuse('a branch name cannot contain "/"')
  else if (isReservedName(sourceBranch)) {
    refuse('that name is reserved: a version, `latest`, `versions.json`, `index.json` or `.meta.json`')
  }
}

function parseEntry(raw, index, sourceBranch) {
  const area =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.area === 'string'
      ? ` (area "${raw.area}")`
      : ''
  const fail = (message) => {
    throw new FatalError(`entry ${index + 1}${area}: ${message}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('an entry must be a JSON object')
  }
  if (raw.mode !== 'release' && raw.mode !== 'mirror') fail('mode must be release or mirror')
  const mirror = raw.mode === 'mirror'
  validateEntry(raw, fail, mirror)
  if (mirror) {
    raw.paths ??= raw.collect.map((rule) => rule.from)
    return raw
  }
  validateBranchFolder(raw, sourceBranch, fail)
  raw.mainFile ??= 'README.md'
  raw.prereleases ??= false
  raw.areaFiles ??= []
  return raw
}

// A release Area never sits inside another Area, and a Mirror Area never sits inside a release Area; a Mirror Area
// inside another Mirror Area is fine. A layout the placement guards would reject is refused here, before the first
// run writes it as installed state.
function rejectNestedAreas(entries) {
  for (const [index, entry] of entries.entries()) {
    for (const [otherIndex, other] of entries.entries()) {
      if (otherIndex === index || !entry.area.startsWith(`${other.area}/`)) continue
      const named = `entry ${index + 1} (area "${entry.area}")`
      const of = `of entry ${otherIndex + 1}`
      if (entry.mode === 'release') {
        throw new FatalError(`${named}: release Area "${entry.area}" sits inside Area "${other.area}" ${of}`)
      }
      if (other.mode === 'mirror') continue
      throw new FatalError(`${named}: Mirror Area "${entry.area}" sits inside release Area "${other.area}" ${of}`)
    }
  }
}

// One Area holds one entry's docs, so two entries on one Area would overwrite each other in an order nothing
// documents. Refused here, on every trigger, before any run touches the docs repo.
function rejectDuplicateAreas(entries) {
  const claimed = new Map()
  for (const [index, entry] of entries.entries()) {
    const first = claimed.get(entry.area)
    if (first === undefined) {
      claimed.set(entry.area, index)
      continue
    }
    const both = entries[first].mode === 'mirror' && entry.mode === 'mirror'
    throw new FatalError(
      `entry ${index + 1} (area "${entry.area}"): ${both ? 'two mirror entries' : 'two entries'} ` +
        `publish the Area "${entry.area}"`,
    )
  }
}

// The entries file is the source repo's own file, written by hand in YAML. A JSON document is valid YAML, so a
// file that holds one keeps being read.
// `sourceBranch` is the branch the run publishes from, when the caller knows it: a release entry that publishes
// its source branch names a folder after it, so a name that cannot be one is refused here, before anything is built.
export function readEntries(file, sourceBranch) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new FatalError(`entries file not found: ${file}`)
    throw error
  }
  if (text.trim() === '') return []
  let parsed
  try {
    // The base workflow converted the file with `yq`, which resolves YAML merge keys (`<<: *anchor`). The `yaml`
    // package leaves them unmerged in a 1.2 document unless asked, so an entries file written that way keeps working.
    parsed = parseYaml(text, { merge: true })
  } catch (error) {
    throw new FatalError(`entries: not valid YAML: ${String(error.message).split('\n')[0]}`)
  }
  if (!Array.isArray(parsed)) {
    if (parsed === null) return []
    throw new FatalError('entries must be a list')
  }
  const entries = parsed.map((raw, index) => parseEntry(raw, index, sourceBranch))
  rejectNestedAreas(entries)
  rejectDuplicateAreas(entries)
  return entries
}

// The tag name release-please uses for a package folder: its `component`,
// else its `package-name`, else the folder name. Keys under the config's
// `packages` are `<packages>/<folder>`, or `<folder>` when `packages` is the repo root.
// Returns null when there is no config file, so callers fall back to the folder name.
export function readTagNames(source, entry) {
  if (!entry.tagNames) return null
  const file = entry.tagNames
  let text
  try {
    text = fs.readFileSync(path.join(source, file), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  let config
  try {
    config = JSON.parse(text)
  } catch {
    throw new FatalError(`release-please config file is not valid JSON: ${file}`)
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new FatalError(`release-please config file is not a JSON object: ${file}`)
  }
  const packages = config.packages
  // The release-please key prefix of an entry's packages: `<packages>/`, or empty at the repo root.
  const packagesDir = nestedRepoPath(entry.packages).path
  const prefix = packagesDir === '.' ? '' : `${packagesDir}/`
  const map = new Map()
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) return map
  for (const [key, value] of Object.entries(packages)) {
    if (!key.startsWith(prefix)) continue
    const folder = key.slice(prefix.length)
    if (!NAME_REGEX.test(folder)) continue
    let tag = folder
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof value.component === 'string' && value.component !== '') tag = value.component
      else if (typeof value['package-name'] === 'string' && value['package-name'] !== '') {
        tag = value['package-name']
      }
    }
    map.set(folder, tag)
  }
  return rejectDuplicateTagNames(map, prefix, file)
}

// One tag name resolves back to one package folder; a silent first-match would drop the rest.
function rejectDuplicateTagNames(map, prefix, file) {
  const foldersByTag = new Map()
  for (const [folder, tag] of map) foldersByTag.set(tag, [...(foldersByTag.get(tag) ?? []), `${prefix}${folder}`])
  for (const [tag, folders] of foldersByTag) {
    if (folders.length < 2) continue
    throw new FatalError(
      `release-please config ${file}: component "${tag}" maps to more than one package folder: ${folders.join(', ')}`,
    )
  }
  return map
}

export function folderForTagName(map, tagName) {
  if (!map) return tagName
  for (const [folder, tag] of map) {
    if (tag !== tagName) continue
    if (isReservedName(folder)) {
      throw new FatalError(`tag component "${tagName}" resolves to "${folder}", a name the publisher reserves`)
    }
    return folder
  }
  return tagName
}

export function tagForVersionFolder(map, name, version) {
  if (!name) return version
  return `${map?.get(name) ?? name}-v${version}`
}
