import path from 'node:path'

// The docs root names where one source repo's Areas live: a folder of the docs checkout, such as `site/raw`, or the
// checkout itself, `.`. The two forms answer the same questions differently — with `.`, `path.posix.join('.', area)`
// is the Area's path with no prefix at all — so every guard that asks whether a path is inside the root, and every
// message that names a path relative to it, asks here instead of comparing against `${root}/`.
export function docsRoot(root) {
  const atCheckoutTop = root === '.'
  // The root itself, or a folder inside it. With `.` the root is the checkout, which no Area path ever names.
  const contains = (rel) => (atCheckoutTop
    ? rel !== '' && rel !== '.' && rel !== '..' && !rel.startsWith('../') && !path.posix.isAbsolute(rel)
    : rel === root || rel.startsWith(`${root}/`))
  // A folder inside the root, never the root itself.
  const containsBelow = (rel) => rel !== root && contains(rel)
  // The path as it reads from the root: `crds` under `core`, and the path unchanged when the root is `.`.
  const relative = (rel) => (rel === root ? '' : atCheckoutTop ? rel : rel.slice(root.length + 1))
  return { contains, containsBelow, relative }
}
