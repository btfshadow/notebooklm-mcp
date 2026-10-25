/**
 * NotebookLM MCP - Internationalization (i18n) System
 *
 * Provides localized UI selectors for different NotebookLM language settings.
 * The UI language in NotebookLM follows the user's Google Account language.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../utils/logger.js';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Locale data structure
export interface LocaleData {
  locale: string;
  name: string;
  description: string;
  tabs: {
    sources: string;
    discussion: string;
    studio: string;
  };
  buttons: {
    addSource: string;
    addNote: string;
    newNote: string;
    insert: string;
    add: string;
    upload: string;
    delete: string;
    remove: string;
    confirm: string;
    yes: string;
    cancel: string;
    close: string;
    save: string;
    done: string;
    create: string;
    download: string;
    generate: string;
  };
  sourceTypes: {
    uploadFiles: string;
    website: string;
    link: string;
    url: string;
    pastedText: string;
    drive: string;
    youtube: string;
  };
  placeholders: {
    pasteUrl: string;
    enterUrl: string;
    pasteLinks: string;
  };
  sourceNames: {
    pastedText: string;
  };
  contentTypes: {
    audio: string;
    video: string;
    presentation: string;
    slides: string;
    infographic: string;
    report: string;
    briefing: string;
    dataTable: string;
    table: string;
  };
  contentOptions: {
    videoStyles: Record<string, string>;
    videoFormats: Record<string, string>;
    presentationStyles: Record<string, string>;
    presentationLengths: Record<string, string>;
    infographicFormats: Record<string, string>;
    reportFormats: Record<string, string>;
  };
  dialogs: {
    selectLanguage: string;
    language: string;
  };
  actions: {
    openInSheets: string;
    openInSlides: string;
    deepDive: string;
    audioOverview: string;
    addToSources: string;
    convertToSource: string;
  };
  status: {
    generating: string;
    processing: string;
    ready: string;
  };
  errors: {
    error: string;
    rateLimitReached: string;
  };
}

// Supported locales
export type SupportedLocale = 'fr' | 'en' | 'de' | 'ja' | 'pt_BR';

// Default locale
const DEFAULT_LOCALE: SupportedLocale = 'fr';

// Cache for loaded locales
const localeCache: Map<string, LocaleData> = new Map();

// Current locale
let currentLocale: SupportedLocale = DEFAULT_LOCALE;

/**
 * Get the i18n directory path
 */
function getI18nDir(): string {
  // In compiled code, we're in dist/i18n, source is in src/i18n
  const distPath = path.join(__dirname, '.');
  const srcPath = path.join(__dirname, '..', '..', 'src', 'i18n');

  // Check if JSON files exist in dist (they should be copied during build)
  if (fs.existsSync(path.join(distPath, 'fr.json'))) {
    return distPath;
  }
  // Fallback to src directory (for development)
  if (fs.existsSync(path.join(srcPath, 'fr.json'))) {
    return srcPath;
  }
  // Last resort: check relative to cwd
  const cwdPath = path.join(process.cwd(), 'src', 'i18n');
  if (fs.existsSync(path.join(cwdPath, 'fr.json'))) {
    return cwdPath;
  }

  throw new Error('Could not find i18n locale files');
}

/**
 * Load a locale file
 */
function loadLocale(locale: string): LocaleData {
  // Check cache first
  if (localeCache.has(locale)) {
    return localeCache.get(locale)!;
  }

  const i18nDir = getI18nDir();
  const localePath = path.join(i18nDir, `${locale}.json`);

  if (!fs.existsSync(localePath)) {
    log.warning(`Locale file not found: ${localePath}, falling back to ${DEFAULT_LOCALE}`);
    if (locale !== DEFAULT_LOCALE) {
      return loadLocale(DEFAULT_LOCALE);
    }
    throw new Error(`Default locale file not found: ${localePath}`);
  }

  try {
    const content = fs.readFileSync(localePath, 'utf-8');
    const data = JSON.parse(content) as LocaleData;
    localeCache.set(locale, data);
    log.info(`📖 Loaded locale: ${locale} (${data.name})`);
    return data;
  } catch (error) {
    log.error(`Failed to load locale ${locale}: ${error}`);
    if (locale !== DEFAULT_LOCALE) {
      return loadLocale(DEFAULT_LOCALE);
    }
    throw error;
  }
}

/**
 * Set the current locale
 */
export function setLocale(locale: SupportedLocale): void {
  currentLocale = locale;
  loadLocale(locale); // Pre-load the locale
  log.info(`🌐 Locale set to: ${locale}`);
}

/**
 * Get the current locale
 */
export function getLocale(): SupportedLocale {
  return currentLocale;
}

/**
 * Get the current locale data
 */
export function getLocaleData(): LocaleData {
  return loadLocale(currentLocale);
}

/**
 * Get all supported locales
 */
export function getSupportedLocales(): SupportedLocale[] {
  return ['fr', 'en', 'de', 'ja', 'pt_BR'];
}

/**
 * Check if a locale is supported
 */
export function isLocaleSupported(locale: string): locale is SupportedLocale {
  return getSupportedLocales().includes(locale as SupportedLocale);
}

/**
 * Helper class for generating bilingual selectors
 * This allows selecting elements that might be in any supported language
 */
export class SelectorBuilder {
  private selectors: string[] = [];

  /**
   * Add a button selector with text from all locales
   */
  buttonWithText(textKey: keyof LocaleData['buttons']): this {
    for (const locale of getSupportedLocales()) {
      const data = loadLocale(locale);
      const text = data.buttons[textKey];
      this.selectors.push(`button:has-text("${text}")`);
    }
    return this;
  }

  /**
   * Add a tab selector with text from all locales
   */
  tabWithText(textKey: keyof LocaleData['tabs']): this {
    for (const locale of getSupportedLocales()) {
      const data = loadLocale(locale);
      const text = data.tabs[textKey];
      this.selectors.push(`div.mdc-tab:has-text("${text}")`);
      this.selectors.push(`.mat-mdc-tab:has-text("${text}")`);
      this.selectors.push(`[role="tab"]:has-text("${text}")`);
    }
    return this;
  }

  /**
   * Add a generic text selector from all locales
   */
  hasText(category: keyof LocaleData, key: string): this {
    for (const locale of getSupportedLocales()) {
      const data = loadLocale(locale);
      const categoryData = data[category] as Record<string, string>;
      if (categoryData && categoryData[key]) {
        this.selectors.push(`:has-text("${categoryData[key]}")`);
      }
    }
    return this;
  }

  /**
   * Add a custom selector
   */
  custom(selector: string): this {
    this.selectors.push(selector);
    return this;
  }

  /**
   * Build and return the selectors array
   */
  build(): string[] {
    return [...new Set(this.selectors)]; // Remove duplicates
  }

  /**
   * Build a combined selector (any match)
   */
  buildCombined(): string {
    return this.build().join(', ');
  }
}

/**
 * Create a new selector builder
 */
export function selectors(): SelectorBuilder {
  return new SelectorBuilder();
}

/**
 * Get text in current locale
 */
export function t(category: keyof LocaleData, key: string): string {
  const data = getLocaleData();
  const categoryData = data[category] as Record<string, unknown>;
  if (categoryData && typeof categoryData[key] === 'string') {
    return categoryData[key] as string;
  }
  log.warning(`Translation not found: ${category}.${key}`);
  return key;
}

/**
 * Get text in all locales (for selector building)
 */
export function tAll(category: keyof LocaleData, key: string): string[] {
  const results: string[] = [];
  for (const locale of getSupportedLocales()) {
    const data = loadLocale(locale);
    const categoryData = data[category] as Record<string, unknown>;
    if (categoryData && typeof categoryData[key] === 'string') {
      results.push(categoryData[key] as string);
    }
  }
  return [...new Set(results)]; // Remove duplicates (e.g., "Sources" is same in FR and EN)
}

// Initialize with default locale
loadLocale(DEFAULT_LOCALE);

export default {
  setLocale,
  getLocale,
  getLocaleData,
  getSupportedLocales,
  isLocaleSupported,
  selectors,
  t,
  tAll,
};
