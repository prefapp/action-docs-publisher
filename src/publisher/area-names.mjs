// The names the publisher writes at the top of an Area. Entry validation reserves them and the rebuild generates
// them, so both read one set. This module imports nothing: `entries.mjs` and `files.mjs` import each other, and a
// second copy of the set is how the two drifted apart.

// The Skipped tags file the publisher keeps at the top of a Release Area.
export const SKIPPED_TAGS_FILE = '.skipped-tags.json'

// The names a rebuild generates at the top of an Area. Every other file there is an Area file of the entry. The
// Skipped tags file is one of them: the publisher owns it, and a run that cannot rewrite it leaves it alone.
export const GENERATED_AREA_NAMES = new Set(['index.json', 'versions.json', '.meta.json', SKIPPED_TAGS_FILE])
