import type { DominoFile } from './types'

/**
 * Line-level helpers shared by the parser and by tools that rewrite a
 * .domino text in place (the "export with the app" embed). Both must agree
 * on what a section header is, or a rewrite could cut a section the parser
 * reads — or keep one it drops.
 */

// A header may carry a trailing comment: `[api] ; endpoints`. Without this the
// guide section never ends and swallows the rest of the file as prose.
export const SECTION_HEADER = /^\s*\[[A-Za-z0-9_-]+\]\s*(?:[;#].*)?$/

/** The (lowercased) section a line opens, or null when it is not a header. */
export function sectionHeader(raw: string): string | null {
  if (!SECTION_HEADER.test(raw)) return null
  return /\[([A-Za-z0-9_-]+)\]/.exec(raw)![1].toLowerCase()
}

/** Full-line comments (# or ;) are stripped; inline `;` only outside quotes. */
export function stripComment(line: string): string {
  if (/^\s*[#;]/.test(line)) return ''
  let inQuote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuote) {
      if (c === inQuote) inQuote = null
    } else if (c === '"' || c === "'") {
      inQuote = c
    } else if (c === ';') {
      return line.slice(0, i)
    }
  }
  return line
}

/**
 * Remove every `[name]` section — its header and all lines up to the next
 * header — and keep everything else byte-for-byte. Header detection follows
 * the parser, so `[name]` mentioned inside [guide] prose (not on a line of
 * its own) never cuts the file, and sections after it survive.
 */
export function stripSection(source: string, name: string): string {
  const target = name.toLowerCase()
  const kept: string[] = []
  let current: string | null = null
  for (const raw of source.split(/\r?\n/)) {
    const header = sectionHeader(raw)
    if (header !== null) current = header
    if (current === target) continue
    kept.push(raw)
  }
  return kept.join('\n').trimEnd()
}

/**
 * The definition with its [screens] embed replaced by `screens` (appended as
 * the last section). A previous embed is dropped wherever it sat, so
 * re-exporting never duplicates it and never loses the sections after it.
 * `comments` become `; …` lines under the header. `screens.def` — the
 * fingerprint of the definition the screens were built against — is written
 * first, so an importer can tell an embed that no longer fits the file.
 */
export function withScreensSection(
  source: string,
  screens: NonNullable<DominoFile['screens']>,
  comments: string[] = []
): string {
  const stripped = stripSection(source, 'screens')
  const embed = [
    '[screens]',
    ...comments.map((c) => `; ${c.replace(/\r?\n/g, ' ')}`),
    ...(screens.def ? [`def = ${screens.def}`] : []),
    `spec = ${JSON.stringify(screens.spec)}`,
    ...(screens.graph && screens.graph.length > 0
      ? [`graph = ${JSON.stringify(screens.graph)}`]
      : [])
  ].join('\n')
  return stripped ? `${stripped}\n\n${embed}\n` : `${embed}\n`
}
