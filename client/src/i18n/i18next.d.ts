import 'i18next';
import type { en } from './en';

// Type t() keys against the English resource, so callers get autocomplete and a
// missing/typo'd key is a compile error.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
  }
}
