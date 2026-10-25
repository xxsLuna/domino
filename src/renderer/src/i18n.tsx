import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { MESSAGES, type Lang } from './i18nMessages'

export type { Lang }
import { getStorage } from './platform'

/**
 * i18n — five UI languages (ko / en / zh / ja / ru) with one flat key space.
 * `auto` follows the browser language. The active language lives in a
 * module-level cell so non-React modules (loadDomino errors) can translate
 * too; the provider keeps React updated and persists the choice.
 */

export type LangPref = 'auto' | Lang

const LANG_KEY = 'domino:lang'

/** Native labels for showing a language inside a sentence (any UI language). */
export const LANG_NATIVE: Record<Lang, string> = {
  ko: '한국어',
  en: 'English',
  zh: '中文',
  ja: '日本語',
  ru: 'Русский'
}

/** English names — the language re-translation prompt targets the model. */
export const LANG_ENGLISH: Record<Lang, string> = {
  ko: 'Korean',
  en: 'English',
  zh: 'Chinese (Simplified)',
  ja: 'Japanese',
  ru: 'Russian'
}

export const LANGUAGES: Array<{ id: Lang; label: string }> = [
  { id: 'ko', label: '한국어' },
  { id: 'en', label: 'English' },
  { id: 'zh', label: '中文' },
  { id: 'ja', label: '日本語' },
  { id: 'ru', label: 'Русский' }
]

export function detectLang(): Lang {
  const tags = typeof navigator !== 'undefined' ? (navigator.languages ?? [navigator.language]) : []
  for (const tag of tags) {
    const p = tag.toLowerCase().split('-')[0]
    if (p === 'ko' || p === 'en' || p === 'zh' || p === 'ja' || p === 'ru') return p
  }
  return 'en'
}

let currentLang: Lang = detectLang()

/** Translate a key with `{param}` interpolation; ko → en → key fallbacks. */
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = MESSAGES[currentLang]?.[key] ?? MESSAGES.en?.[key] ?? MESSAGES.ko?.[key] ?? key
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (m, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : m
  )
}

interface I18nValue {
  lang: Lang
  pref: LangPref
  setPref: (pref: LangPref) => void
}

const I18nContext = createContext<I18nValue>({ lang: currentLang, pref: 'auto', setPref: () => {} })

export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [pref, setPrefState] = useState<LangPref>('auto')
  // The browser language can change (OS toggle) — re-derive `auto` live.
  const detected = detectLang()
  const lang: Lang = pref === 'auto' ? detected : pref

  // During render, not in an effect: this pass must already see the new
  // language, or translated children lag one render behind the switch.
  currentLang = lang
  if (typeof document !== 'undefined') document.documentElement.lang = lang

  useEffect(() => {
    void (async () => {
      try {
        const raw = await getStorage().get(LANG_KEY)
        if (raw === 'auto' || (raw && raw in MESSAGES)) setPrefState(raw as LangPref)
      } catch {
        /* storage unavailable — keep auto */
      }
    })()
  }, [])

  const setPref = (next: LangPref): void => {
    setPrefState(next)
    void getStorage()
      .set(LANG_KEY, next)
      .catch(() => {})
  }

  return <I18nContext.Provider value={{ lang, pref, setPref }}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  return useContext(I18nContext)
}

/** For non-React modules that run after boot (error paths). */
export function activeLang(): Lang {
  return currentLang
}
