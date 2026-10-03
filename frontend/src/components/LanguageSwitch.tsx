import { Languages } from 'lucide-react'
import { useTranslation } from '@/i18n'

export function LanguageSwitch() {
  const { t, locale, setLocale } = useTranslation()
  return (
    <button
      type="button"
      className="tongmu-language-switch"
      aria-label="Language / 语言"
      title={t('Switch language')}
      onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
    >
      <Languages size={16} aria-hidden="true" />
      <span lang="zh-CN" className={locale === 'zh' ? 'is-selected' : ''}>
        中
      </span>
      <span className="tongmu-language-switch__divider" aria-hidden="true">
        /
      </span>
      <span lang="en" className={locale === 'en' ? 'is-selected' : ''}>
        EN
      </span>
    </button>
  )
}
