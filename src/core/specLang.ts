import type { CardNode, UiSpec } from './spec'

/**
 * specLang — which human language a domino's built screens are written in,
 * decided from the script of their visible text (props are walked as strings;
 * URLs and code barely contribute). Script counting separates the five UI
 * languages cleanly: hangul → ko, kana → ja, han (without kana) → zh,
 * cyrillic → ru, otherwise latin → en.
 */

export type SpecLang = 'ko' | 'en' | 'zh' | 'ja' | 'ru'

interface ScriptCounts {
  hangul: number
  kana: number
  han: number
  cyrillic: number
  latin: number
}

const countScripts = (text: string, counts: ScriptCounts): void => {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff)) counts.hangul++
    else if (c >= 0x3040 && c <= 0x30ff) counts.kana++
    else if (c >= 0x4e00 && c <= 0x9fff) counts.han++
    else if (c >= 0x0400 && c <= 0x04ff) counts.cyrillic++
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) counts.latin++
  }
}

/** Walk every string value in a node's props (objects and arrays included). */
const walkValue = (v: unknown, counts: ScriptCounts): void => {
  if (typeof v === 'string') {
    countScripts(v, counts)
    return
  }
  if (Array.isArray(v)) {
    for (const item of v) walkValue(item, counts)
    return
  }
  if (v && typeof v === 'object') {
    for (const val of Object.values(v as Record<string, unknown>)) walkValue(val, counts)
  }
}

const walkNode = (node: CardNode, counts: ScriptCounts): void => {
  if (node.props) walkValue(node.props, counts)
  if (node.children) for (const child of node.children) walkNode(child, counts)
}

/** The dominant language of every visible string in the spec (null: no text). */
export function detectSpecLanguage(spec: UiSpec): SpecLang | null {
  const counts: ScriptCounts = { hangul: 0, kana: 0, han: 0, cyrillic: 0, latin: 0 }
  for (const page of spec.pages) {
    if (page.name) countScripts(page.name, counts)
    for (const node of page.layout) walkNode(node, counts)
  }
  if (spec.nav) {
    for (const item of spec.nav) {
      countScripts(item.label, counts)
      if (item.badge !== undefined && typeof item.badge !== 'number') {
        countScripts(String(item.badge), counts)
      }
    }
  }
  const meaningful =
    counts.hangul + counts.kana + counts.han + counts.cyrillic + counts.latin
  if (meaningful < 4) return null // fragments like "NEW" or empty pages decide nothing
  if (counts.hangul > 0 && counts.hangul >= counts.han) return 'ko'
  if (counts.kana > 0) return 'ja'
  if (counts.cyrillic > 0 && counts.cyrillic >= counts.latin) return 'ru'
  if (counts.han > 0) return 'zh'
  if (counts.latin > 0) return 'en'
  return null
}
