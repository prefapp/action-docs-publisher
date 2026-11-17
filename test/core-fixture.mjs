import { image, entriesFile, mirrorEntry, unnamedReleaseEntry } from './harness.mjs'

export const CRD_A = 'kind: CustomResourceDefinition\nname: a\n'
export const CRD_B = 'kind: CustomResourceDefinition\nname: b\n'
export const CRDS_INDEX = `${CRD_A}${CRD_B}`
export const CONCATENATE = 'cat crds/*.yaml > index.yaml'
export const CLAIMS_BUILD = 'sh scripts/claims-schema.sh'
export const CLAIMS_SCHEMA = '{"claims":[]}\n'

// The current index lives in the release Area, under the folder named after the source branch it was built from.
export const CORE_CRDS = unnamedReleaseEntry({ build: CONCATENATE, publishSourceBranch: true })
export const CORE_DOCS = mirrorEntry({
  area: 'core/docs',
  build: CLAIMS_BUILD,
  collect: [{ from: 'docs/**', to: '.' }],
  paths: ['docs/**'],
})

export function coreFiles() {
  return {
    'crds/a.yaml': CRD_A,
    'crds/b.yaml': CRD_B,
    'docs/index.md': '# Core\n\n![logo](images/logo.png)\n',
    'docs/images/logo.png': image('core-logo'),
    'scripts/claims-schema.sh': `mkdir -p docs/generated\nprintf '%s\\n' '${CLAIMS_SCHEMA.trim()}' > docs/generated/claims-schema.json\n`,
    ...entriesFile([CORE_CRDS, CORE_DOCS]),
  }
}
