export type Locale = 'zh' | 'en'
export type TranslationParams = Record<string, string | number>

const reverseCatalogs = new WeakMap<
  Record<string, string>,
  {
    exact: Map<string, string>
    templates: {
      source: string
      pattern: RegExp
      names: string[]
      prefix: string
    }[]
  }
>()

function reverseCatalog(dictionary: Record<string, string>) {
  const cached = reverseCatalogs.get(dictionary)
  if (cached) return cached
  const exact = new Map<string, string>()
  const templates: {
    source: string
    pattern: RegExp
    names: string[]
    prefix: string
  }[] = []
  for (const [source, translated] of Object.entries(dictionary)) {
    if (!exact.has(translated)) exact.set(translated, source)
    for (const templateText of [translated, source]) {
      const names: string[] = []
      const segments = templateText.split(/(\{[a-zA-Z][a-zA-Z0-9_]*\})/g)
      const pattern = segments
        .map((segment) => {
          if (/^\{[a-zA-Z][a-zA-Z0-9_]*\}$/.test(segment)) {
            names.push(segment.slice(1, -1))
            return '([\\s\\S]*?)'
          }
          return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        })
        .join('')
      if (names.length)
        templates.push({
          source,
          pattern: new RegExp(`^${pattern}$`),
          names,
          prefix: segments[0],
        })
    }
  }
  const catalog = { exact, templates }
  reverseCatalogs.set(dictionary, catalog)
  return catalog
}

export function normalizeLocale(value: unknown): Locale {
  return value === 'en' ? 'en' : 'zh'
}

export function translateMessage(
  locale: Locale,
  source: string,
  dictionary: Record<string, string>,
  params?: TranslationParams
): string {
  let canonical = source
  let values = params
  // Existing product errors can be stored in state before the user changes
  // language. Normalize known copy; never translate parameter/user content.
  if (!Object.prototype.hasOwnProperty.call(dictionary, source)) {
    const reverse = reverseCatalog(dictionary)
    canonical = reverse.exact.get(source) ?? source
    if (canonical === source) {
      for (const template of reverse.templates) {
        if (template.prefix && !source.startsWith(template.prefix)) continue
        const match = template.pattern.exec(source)
        if (!match) continue
        canonical = template.source
        values = Object.fromEntries(
          template.names.map((name, index) => [name, match[index + 1]])
        )
        break
      }
    }
  }
  const text =
    locale === 'zh' ? (dictionary[canonical] ?? canonical) : canonical
  return text.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (token, name: string) =>
    values && Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : token
  )
}
