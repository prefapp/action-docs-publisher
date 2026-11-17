#!/usr/bin/env node

// The action ships one bundle: the runner checks the repository out without installing dependencies, so `dist/`
// holds everything the action needs. `--check` builds again and compares, which is what CI runs: a bundle that does
// not match its sources is a failing check, not a review finding.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUTPUT = join(ROOT, 'dist', 'index.js')

const options = {
  entryPoints: [join(ROOT, 'src', 'index.mjs')],
  outfile: OUTPUT,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  legalComments: 'none',
  logLevel: 'warning',
  // `@actions/github` reaches CommonJS dependencies that require built-ins lazily; in an ES module bundle those
  // `require` calls need a real one, tied to this file.
  banner: {
    js: [
      '// Built from src/ by scripts/build.mjs. Do not edit.',
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
}

if (!process.argv.includes('--check')) {
  await build(options)
  process.exit(0)
}

let bundled
try {
  bundled = await build({ ...options, write: false })
} catch (error) {
  console.error(error.message ?? error)
  process.exit(1)
}
const expected = bundled.outputFiles[0].text
let actual
try {
  actual = readFileSync(OUTPUT, 'utf8')
} catch {
  console.error(`${OUTPUT} is missing: run \`npm run build\` and commit the result.`)
  process.exit(1)
}
if (actual !== expected) {
  console.error('dist/ does not match src/: run `npm run build` and commit the result.')
  process.exit(1)
}
