import { realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { FatalError, assertBranchName } from '../publisher/files.mjs'

// The inputs the action declares in `action.yml`, read once. A branch or path input that is left empty takes the
// same default `action.yml` documents, so a workflow that omits it publishes from and to `main` and reads the
// entries file the feature installs.
const DEFAULTS = { 'docs-branch': 'main', 'source-branch': 'main', 'entries-file': '.github/docs_publisher.yaml' }

export const REQUIRED_INPUTS = ['docs-repository', 'docs-root-folder', 'docs-token', 'github-token']

// `getInput` is the runner's own reader: it matches the `INPUT_<NAME>` variables the runner sets from the workflow.
export function readInputs(getInput) {
  const read = (name) => {
    const value = getInput(name, { required: REQUIRED_INPUTS.includes(name) }).trim()
    return value === '' && DEFAULTS[name] !== undefined ? DEFAULTS[name] : value
  }
  const inputs = {
    docsRepository: read('docs-repository'),
    root: read('docs-root-folder'),
    branch: read('docs-branch'),
    sourceBranch: read('source-branch'),
    entriesFile: read('entries-file'),
    docsToken: read('docs-token'),
    githubToken: read('github-token'),
  }
  // Both name a git branch, and `source-branch` also names a folder inside each Area: a name git refuses is refused
  // here, before the docs repo is cloned and before any path is built from it.
  assertBranchName(inputs.branch, 'docs-branch')
  assertBranchName(inputs.sourceBranch, 'source-branch')
  return inputs
}

// The entries file is the source repo's own file, so the input is a path inside the checkout the workflow made. An
// absolute path, or one that climbs out of the workspace, is refused before anything is cloned or built.
export function resolveEntriesFile(workspace, entriesFile) {
  const refusal = `entries-file must be a relative path inside the source checkout: "${entriesFile}"`
  if (isAbsolute(entriesFile)) throw new FatalError(refusal)
  const root = resolve(workspace)
  const full = resolve(root, entriesFile)
  if (!full.startsWith(`${root}${sep}`)) throw new FatalError(refusal)
  // The lexical check cannot see a symlink: a path inside the checkout can still point outside it, so the file's real
  // path is confined too. A file that is not there is not a confinement problem: the read reports it as it always has.
  const real = realpathOrNull(full)
  const realRoot = realpathOrNull(root)
  if (real !== null && realRoot !== null && real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) {
    throw new FatalError(refusal)
  }
  return full
}

function realpathOrNull(target) {
  try {
    return realpathSync(target)
  } catch {
    return null
  }
}
