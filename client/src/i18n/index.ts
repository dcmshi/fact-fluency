/**
 * i18n setup (react-i18next). Resources are bundled inline (no async backend →
 * no Suspense needed). Language is detected from localStorage then the browser,
 * and persisted to localStorage so the choice sticks. Supported: English,
 * Spanish, French and Chinese; unknown locales fall back to English.
 */
import i18n from 'i18next';
import type { TFunction } from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { en } from './en';
import { es } from './es';
import { fr } from './fr';
import { zh } from './zh';

/** The languages offered in the switcher. */
export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'zh', label: '中文' },
] as const;

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      es: { translation: es },
      fr: { translation: fr },
      zh: { translation: zh },
    },
    fallbackLng: 'en',
    supportedLngs: ['en', 'es', 'fr', 'zh'],
    nonExplicitSupportedLngs: true, // es-MX → es, fr-CA → fr, zh-CN → zh
    interpolation: { escapeValue: false }, // React already escapes
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'ff_lang',
      caches: ['localStorage'],
    },
  });

// Keep <html lang> in sync with the active language — screen readers announce in
// the right language, and CSS `hyphens: auto` needs it to break words correctly.
const syncHtmlLang = (lng: string) => {
  document.documentElement.lang = lng.split('-')[0];
};
syncHtmlLang(i18n.resolvedLanguage ?? 'en');
i18n.on('languageChanged', syncHtmlLang);

/**
 * Translate a key computed at runtime from a server id (fact set, grade band,
 * reward) or a server-emitted LocalizedText, where the key isn't a compile-time
 * literal. Deliberately steps outside t()'s static key checking and falls back
 * to `fallback` if the key isn't in the dictionary — so a newly added server id
 * degrades to the server's English label rather than a raw key. `params` are
 * interpolated (e.g. a strategy hint's operands).
 */
export function tLabel(
  t: TFunction,
  key: string,
  fallback: string,
  params?: Record<string, string | number>,
): string {
  const loose = t as unknown as (k: string, o: Record<string, unknown>) => string;
  return loose(key, { defaultValue: fallback, ...params });
}

export default i18n;
