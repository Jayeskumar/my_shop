/**
 * i18n (ARCHITECTURE.md §16): i18next + react-i18next, Tamil first.
 *
 *  - Resources are every JSON file under src/locales/{ta,en}/<namespace>.json, bundled eagerly
 *    (no network round-trip, works offline). One namespace per module; `common` is the default.
 *  - Default language 'ta', fallback 'en'. The choice is saved in localStorage (`kadai.lang`)
 *    and mirrored to <html lang> (fonts/hyphenation/screen readers) and to zod's error locale.
 *  - Keys are type-checked against the English files (src/lib/i18n-resources.ts), so a missing
 *    key is a compile error. Use `t('ns:key')` or `useTranslation('ns')`.
 */
import i18next, { type i18n as I18n } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { configureValidationLocale } from './validation'
import { storage } from './storage'

export const LANGUAGES = ['ta', 'en'] as const
export type Language = (typeof LANGUAGES)[number]
export const DEFAULT_LANGUAGE: Language = 'ta'
export const FALLBACK_LANGUAGE: Language = 'en'
const STORAGE_KEY = 'lang'

export function isLanguage(value: unknown): value is Language {
  return value === 'ta' || value === 'en'
}

type Bundle = Record<string, unknown>
const files = import.meta.glob<Bundle>('../locales/*/*.json', { eager: true, import: 'default' })

/** { ta: { common: {...}, auth: {...} }, en: {...} } built from the locale files. */
function buildResources(): Record<Language, Record<string, Bundle>> {
  const resources: Record<Language, Record<string, Bundle>> = { ta: {}, en: {} }
  for (const [path, bundle] of Object.entries(files)) {
    const match = /\/locales\/([a-z]{2})\/([a-z_]+)\.json$/.exec(path)
    if (!match) continue
    const [, lng, ns] = match
    if (isLanguage(lng) && ns) resources[lng][ns] = bundle
  }
  return resources
}

export const resources = buildResources()
export const NAMESPACES = Object.keys(resources.en).sort()

/** Language saved on this device, or null when the user never chose one. */
export function getSavedLanguage(): Language | null {
  return storage.get<Language | null>(STORAGE_KEY, null, (v): v is Language | null => isLanguage(v))
}

function applyDocumentLanguage(lng: Language): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = lng
}

let initialized = false

/** Initialises i18next synchronously (resources are bundled). Safe to call more than once. */
export function initI18n(language?: Language): I18n {
  const lng = language ?? getSavedLanguage() ?? DEFAULT_LANGUAGE
  if (!initialized) {
    initialized = true
    void i18next.use(initReactI18next).init({
      resources,
      lng,
      fallbackLng: FALLBACK_LANGUAGE,
      supportedLngs: [...LANGUAGES],
      ns: NAMESPACES,
      defaultNS: 'common',
      fallbackNS: 'common',
      interpolation: { escapeValue: false },
      returnNull: false,
      initAsync: false,
      react: { useSuspense: false },
      showSupportNotice: false,
    })
    i18next.on('languageChanged', (next) => {
      if (isLanguage(next)) {
        applyDocumentLanguage(next)
        configureValidationLocale(next)
      }
    })
  } else if (i18next.language !== lng) {
    void i18next.changeLanguage(lng)
  }
  applyDocumentLanguage(lng)
  configureValidationLocale(lng)
  return i18next
}

/** Current UI language. */
export function getLanguage(): Language {
  const lng = i18next.resolvedLanguage ?? i18next.language
  return isLanguage(lng) ? lng : DEFAULT_LANGUAGE
}

/**
 * Switches the UI language. `persist: false` applies it without remembering the choice (e.g.
 * adopting a user's preferred_locale on sign-in when the device has no saved choice).
 */
export async function setLanguage(lng: Language, options: { persist?: boolean } = {}): Promise<void> {
  if (options.persist !== false) storage.set(STORAGE_KEY, lng)
  await i18next.changeLanguage(lng)
}

export { i18next as i18n }
