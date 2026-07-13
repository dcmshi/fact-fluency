import { useTranslation } from 'react-i18next';
import { LANGUAGES } from '../i18n';

/** Compact language picker — device-level (persisted to localStorage by the
 *  detector). Small enough to sit in a page header. */
export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  return (
    <select
      className="lang-switcher"
      aria-label={t('common.language')}
      value={i18n.resolvedLanguage ?? 'en'}
      onChange={(e) => void i18n.changeLanguage(e.target.value)}
    >
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  );
}
