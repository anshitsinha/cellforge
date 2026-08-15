/**
 * The locale setting: how numbers, dates and formulas look and are typed
 * (1.234,56 in Germany, 12,34,567 in India...). Stored in this browser only.
 *
 * Call startLocale() once at startup, before the first paint: it reads the
 * saved choice and makes it the app-wide locale that formatValue and
 * parseTyped use (en-US when nothing is saved).
 */
// TODO(lead): import from "@cellforge/core" once core's index.ts exports ./locale
import { getLocale, LOCALES, localeById, setLocale, type Locale, type LocaleId } from "@cellforge/core";

const KEY = "cellforge.locale";

/** The locales offered in settings, in menu order. */
export const LOCALE_CHOICES: readonly { id: LocaleId; name: string; sample: string }[] = (Object.values(LOCALES) as Locale[]).map((l) => ({
  id: l.id,
  name: l.name,
  sample: sampleOf(l),
}));

/** "1,234.56 · 3/14/2024" in the locale's own style, for the menu. */
function sampleOf(l: Locale): string {
  const n = l.grouping === "indian" ? "12,34,567.89" : `1${l.group}234${l.group}567${l.decimal}89`;
  const date = l.dateOrder === "mdy" ? "3/14/2024" : l.dateFormat.includes(".") ? "14.03.2024" : "14/03/2024";
  return `${n} · ${date}`;
}

/** localStorage, or null where it's blocked (private mode, sandboxed frames, tests). */
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The saved locale id, if any. */
export function savedLocaleId(): string | null {
  try {
    return storage()?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

/** The locale to start with: the saved one, else the browser's language, else en-US. */
export function initialLocale(saved = savedLocaleId(), browser: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language]): Locale {
  if (saved) return localeById(saved);
  for (const lang of browser) {
    const l = localeById(lang);
    // only take a browser language we actually have (localeById falls back to en-US)
    if (l.id.toLowerCase() === lang.toLowerCase() || l.id.split("-")[0] === lang.toLowerCase().split(/[-_]/)[0]) return l;
  }
  return localeById("en-US");
}

/**
 * Make the saved locale the app-wide one. Returns it. With nothing saved it
 * stays en-US, unless `followBrowser` asks to use the browser's language.
 */
export function startLocale(followBrowser = false): Locale {
  return setLocale(initialLocale(savedLocaleId(), followBrowser && typeof navigator !== "undefined" ? (navigator.languages ?? [navigator.language]) : []));
}

/** The locale in use. */
export function currentLocale(): Locale {
  return getLocale();
}

/** Switch locale and remember it. The caller repaints the grid (grid.invalidate()). */
export function chooseLocale(id: LocaleId | string): Locale {
  const l = setLocale(id);
  try {
    storage()?.setItem(KEY, l.id);
  } catch {
    // storage full or blocked: it still applies until the page reloads
  }
  return l;
}
