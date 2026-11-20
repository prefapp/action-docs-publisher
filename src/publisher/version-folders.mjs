import path from 'node:path'
import { isReservedName, nestedRepoPath, readTagNames } from './entries.mjs'
import { FatalError } from './files.mjs'

export function versionTargeting({ source, root, entry }) {
  const names = readTagNames(source, entry)
  const packagesDir = entry.packages === undefined ? null : nestedRepoPath(entry.packages).path

  return {
    forTag({ name, version }) {
      const folder = name === null ? null : folderForTagName(names, name)
      return {
        name: folder,
        version,
        folder: folder === null ? null : path.posix.join(packagesDir, folder),
        versionDir: path.posix.join(root, entry.area, ...(folder === null ? [] : [folder]), version),
      }
    },
    tagFor(name, version) {
      if (!name) return version
      return `${names?.get(name) ?? name}-v${version}`
    },
  }
}

function folderForTagName(map, tagName) {
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
