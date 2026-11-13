import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@actions/core'
import { context } from '@actions/github'
import { FatalError, appendSummary, setCredential } from './publisher/files.mjs'
import { publish } from './publisher/main.mjs'
import { cloneDocsRepository, docsCheckoutPath, removeDocsCheckout, setCommitIdentity } from './action/docs.mjs'
import { botIdentity, upsertPlanComment } from './action/github.mjs'
import { readInputs, resolveEntriesFile } from './action/inputs.mjs'
import { selectMode } from './action/mode.mjs'

function runnerTemp() {
  return process.env.RUNNER_TEMP || tmpdir()
}

function serverUrl() {
  return (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '')
}

// The tokens reach the process as input variables. They are read once, and the variables are gone before anything
// else runs: every child process this action starts — git, and the build commands of the source repo — inherits an
// environment without them.
function takeInputs() {
  const inputs = readInputs(core.getInput)
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('INPUT_')) delete process.env[name]
  }
  return inputs
}

async function main() {
  const inputs = takeInputs()
  const source = process.env.GITHUB_WORKSPACE
  if (!source) throw new FatalError('GITHUB_WORKSPACE is not set')
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new FatalError('GITHUB_REPOSITORY is not set')
  const entries = resolveEntriesFile(source, inputs.entriesFile)

  const mode = selectMode({ eventName: context.eventName, payload: context.payload, sha: context.sha })
  const planFile = join(runnerTemp(), 'docs-publisher-plan.md')
  core.setOutput('run-mode', mode.kind)
  core.setOutput('docs-changed', 'false')

  const docs = docsCheckoutPath(runnerTemp())
  removeDocsCheckout(docs)
  try {
    cloneDocsRepository({ docs, repository: inputs.docsRepository, branch: inputs.branch, token: inputs.docsToken, server: serverUrl() })
    setCommitIdentity(docs, await botIdentity(inputs.docsToken))

    // Each token goes to the git commands of the checkout it belongs to, and to no build command: `files.mjs` strips
    // it from the environment the build inherits.
    setCredential(source, inputs.githubToken)
    setCredential(docs, inputs.docsToken)

    const result = publish(
      {
        source,
        docs,
        entries,
        root: inputs.root,
        branch: inputs.branch,
        'source-branch': inputs.sourceBranch,
        'docs-repository': inputs.docsRepository,
        'plan-file': planFile,
      },
      mode,
    )
    core.setOutput('run-mode', result.output)
    core.setOutput('docs-changed', String(result.changed))
    if (result.changed) core.setOutput('docs-commit-sha', result.commitSha)

    if (result.output === 'plan' && existsSync(planFile)) {
      const outcome = await upsertPlanComment({
        token: inputs.githubToken,
        repository,
        pullNumber: context.payload.pull_request?.number,
        body: readFileSync(planFile, 'utf8'),
      })
      core.info(`Plan comment ${outcome}.`)
    }
  } finally {
    removeDocsCheckout(docs)
  }
}

main().catch((error) => {
  if (error instanceof FatalError) {
    appendSummary(error.message)
    core.setFailed(`docs_publisher: ${error.message}`)
    return
  }
  console.error(error)
  core.setFailed(error instanceof Error ? error.message : String(error))
})
