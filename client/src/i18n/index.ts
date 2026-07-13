/**
 * i18n setup (react-i18next). Resources are bundled inline (no async backend →
 * no Suspense needed). Language is detected from localStorage then the browser,
 * and persisted to localStorage so the choice sticks. Supported: English +
 * Spanish; unknown locales fall back to English.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { en } from './en';
import { es } from './es';

/** The languages offered in the switcher. */
export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
] as const;

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en }, es: { translation: es } },
    fallbackLng: 'en',
    supportedLngs: ['en', 'es'],
    nonExplicitSupportedLngs: true, // es-MX, es-419 … → es
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

export default i18n;
