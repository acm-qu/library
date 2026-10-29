// English ships first; a new locale is one more JSON file here plus an entry in LOCALES. Messages use ICU
// syntax (plurals, select), and layouts use logical properties, so RTL locales need no CSS changes.
import i18n from 'i18next';
import ICU from 'i18next-icu';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

export const LOCALES = [{ code: 'en', name: 'English', dir: 'ltr' }] as const;
export type Locale = (typeof LOCALES)[number]['code'];

const STORAGE_KEY = 'acm.locale';
function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LOCALES.some((l) => l.code === saved)) return saved as Locale;
  } catch {
    /* storage unavailable */
  }
  return 'en';
}

export function applyLocale(code: Locale) {
  const l = LOCALES.find((x) => x.code === code) ?? LOCALES[0];
  document.documentElement.lang = l.code;
  document.documentElement.dir = l.dir;
  try {
    localStorage.setItem(STORAGE_KEY, l.code);
  } catch {
    /* ignore */
  }
  return i18n.changeLanguage(l.code);
}

void i18n
  .use(ICU)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    lng: initialLocale(),
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    returnNull: false,
  });
applyLocale(initialLocale());

export default i18n;
