#!/usr/bin/env node

// Test driver: the argument shape the publisher used to take from its workflow, mapped onto the mode the action
// picks from the event. Production has no command line: `src/index.mjs` builds the same args object from the
// action inputs and the Actions context, and calls the same `publish`, so the suite exercises the code the action
// runs with the options each case needs.
import { FatalError, appendSummary, setCredential } from '../src/publisher/files.mjs'
import { publish } from '../src/publisher/main.mjs'
import { releaseMode } from '../src/action/mode.mjs'

const REQUIRED_OPTIONS = ['source', 'docs', 'entries', 'root', 'branch', 'source-branch', 'docs-repository']

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--reconcile' || flag === '--plan') {
      options[flag.slice(2)] = true
      continue
    }
    if (!flag?.startsWith('--') || argv[i + 1] === undefined) {
      throw new FatalError(`expected --option value pairs, got "${flag}"`)
    }
    options[flag.slice(2)] = argv[i + 1]
    i++
  }
  for (const name of REQUIRED_OPTIONS) {
    if (options[name] === undefined) throw new FatalError(`missing --${name}`)
  }
  return options
}

function selectMode(options) {
  if (options.plan) {
    if (options.tag !== undefined || options.reconcile) throw new FatalError('--plan runs without --tag or --reconcile')
    for (const name of ['plan-file', 'before', 'after']) {
      if (!options[name]) throw new FatalError(`missing --${name} for --plan`)
    }
    return { kind: 'plan', before: options.before, after: options.after }
  }
  if (options.reconcile) {
    if (options.tag !== undefined) throw new FatalError('--reconcile runs without --tag')
    return { kind: 'reconcile' }
  }
  if (options.tag !== undefined) return releaseMode(options.tag)
  return { kind: 'push', before: options.before, after: options.after }
}

try {
  const options = parseArgs(process.argv.slice(2))
  setCredential(options.source, options['source-token'])
  setCredential(options.docs, options['docs-token'])
  publish(
    {
      source: options.source,
      docs: options.docs,
      entries: options.entries,
      root: options.root,
      branch: options.branch,
      'source-branch': options['source-branch'],
      'docs-repository': options['docs-repository'],
      'plan-file': options['plan-file'],
    },
    selectMode(options),
  )
  process.exitCode = 0
} catch (error) {
  if (error instanceof FatalError) {
    console.error(`docs_publisher: ${error.message}`)
    appendSummary(error.message)
  } else console.error(error)
  process.exitCode = 2
}
