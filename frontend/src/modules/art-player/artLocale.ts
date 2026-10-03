import type Artplayer from 'artplayer'
import type { Locale } from '@/i18n'

/** Refresh native player labels without replacing the instance or its media. */
export function updateArtLocale(art: Artplayer, locale: Locale): void {
  const chinese = art.i18n.languages['zh-cn'] ?? {}
  const labels = new Map<string, string>()
  for (const [key, value] of Object.entries(chinese)) {
    labels.set(key, key)
    if (typeof value === 'string') labels.set(value, key)
  }
  art.option.lang = locale === 'zh' ? 'zh-cn' : 'en'
  art.i18n.init()
  // Native tooltips were created during construction. Custom React controls
  // translate themselves; only exact built-in labels are updated here.
  for (const root of [art.template.$bottom, art.template.$state]) {
    root
      .querySelectorAll<HTMLElement>('[data-title], [title], [aria-label]')
      .forEach((element) => {
        for (const attribute of ['data-title', 'title', 'aria-label']) {
          const current = element.getAttribute(attribute)
          const key = current === null ? undefined : labels.get(current)
          if (key) element.setAttribute(attribute, art.i18n.get(key))
        }
      })
  }
}
