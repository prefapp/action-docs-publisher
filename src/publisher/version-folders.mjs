import path from 'node:path'
import { isReservedName, nestedRepoPath, readTagNames } from './entries.mjs'
import { FatalError } from './files.mjs'

// Version folder targeting: which package a release tag names in one entry, where that package's folder sits in the
// source checkout, and where the tag's Version folder goes in the docs repo. Reconcile discovery, the Release run's
// missing-folder path and the Version build planner ask here instead of assembling the destination themselves, so one
// layout rule decides every destination. Nothing here decides whether a tag is published: an entry's eligibility and
// the revision policy of the Run mode that asks stay with that Run mode.
//
// The entry's tagNames config is read once, when the Area's targeting is built, and every tag of that Area asks the
// same mapping.
export function versionTargeting({ source, root, entry }) {
  const names = readTagNames(source, entry)
  // The package folder of an entry without `packages` is the checkout itself, and it publishes one unnamed Version.
  const packagesDir = entry.packages === undefined ? null : nestedRepoPath(entry.packages).path

  return {
    // Where the tag publishes: the package it names, the package folder the tag has to hold, and its Version folder. A
    // tag with a name goes to an entry with `packages`, and an unnamed tag to one without: which tags an entry takes is
    // eligibility, and the caller decides it before asking.
    forTag({ name, version }) {
      const folder = name === null ? null : folderForTagName(names, name)
      return {
        name: folder,
        version,
        folder: folder === null ? null : path.posix.join(packagesDir, folder),
        versionDir: path.posix.join(root, entry.area, ...(folder === null ? [] : [folder]), version),
      }
    },

    // The tag a published Version folder was built from: the reverse of the layout above, from the same config, so a
    // folder read back from the docs repo names the tag that would republish it.
    tagFor(name, version) {
      if (!name) return version
      return `${names?.get(name) ?? name}-v${version}`
    },
  }
}

// The package folder a tag name resolves to: the folder the config maps it to, else the tag name itself, which is the
// folder name of a package release-please names after itself.
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
