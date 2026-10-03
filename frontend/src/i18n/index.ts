import { create } from 'zustand'
import { componentsZh } from './components.zh'
import { coreZh } from './core.zh'
import { modulesZh } from './modules.zh'
import { pagesZh } from './pages.zh'
import {
  normalizeLocale,
  translateMessage,
  type Locale,
  type TranslationParams,
} from './translation'

export type { Locale, TranslationParams } from './translation'
export const LOCALE_STORAGE_KEY = 'tongmu-locale'

function initialLocale(): Locale {
  try {
    return normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY))
  } catch {
    return 'zh'
  }
}

export const useLocaleStore = create<{
  locale: Locale
  setLocale: (locale: Locale) => void
}>((set) => ({
  locale: initialLocale(),
  setLocale: (locale) => {
    const next = normalizeLocale(locale)
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next)
    } catch {
      // Language switching remains available when browser storage is blocked.
    }
    set({ locale: next })
  },
}))

const zh: Record<string, string> = {
  ...coreZh,
  ...modulesZh,
  ...pagesZh,
  // Shared navigation and control terminology stays consistent across pages.
  ...componentsZh,
}

export function getLocale(): Locale {
  return useLocaleStore.getState().locale
}

export function canonicalProductMessage(message: string): string {
  return translateMessage('en', message, zh)
}

/** Translate product copy only. User content and protocol values stay intact. */
export function t(source: string, params?: TranslationParams): string {
  return translateMessage(getLocale(), source, zh, params)
}

export function useTranslation() {
  const locale = useLocaleStore((state) => state.locale)
  const setLocale = useLocaleStore((state) => state.setLocale)
  return { t, locale, setLocale }
}
