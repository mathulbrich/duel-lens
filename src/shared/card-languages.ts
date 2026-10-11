// The languages card names and text can show in ("Card text language" in Options), where each one's
// language pack comes from, and every UI string of the feature (CARD_TEXT_COPY, from chrome.i18n:
// src/shared/i18n.ts). English is bundled; the others download on demand.
//
// Sources, checked 2026-10-09 (textlang-report.md):
// - YGOPRODeck's cardinfo.php?language=<code>, the host of the weekly English refresh, answers fr, de, it, pt
//   (documented) and ja, ko (served the same way, not in its documented list). CORS `*`, so no host
//   permission; ~2.5–2.9 MB on the wire (brotli), 17.7–24.6 MB of JSON, 10,887–11,769 cards, ~1.3 s.
//   Spot-checked against Konami's own text (db.ygoresources.com) for Blue-Eyes White Dragon: identical.
// - Not offered: Spanish (YGOPRODeck answers 400) and Simplified Chinese (not in YGOPRODeck either). Their only
//   source, db.ygoresources.com, has per-card files only and asks API users not to download the whole database
//   ("Please don't query the entire database", /about/api).
import { formatDate, formatNumber, t, uiLang } from './i18n';
import type { CardLanguage } from './types';

export interface CardLanguageInfo {
  code: CardLanguage;
  /** The language's own name, as the Options select shows it. */
  ownName: string;
  /** Its English name (the privacy policy; the fallback for languageName). */
  englishName: string;
  /** The pack's download, in MB on the wire (compressed), measured 2026-10-09. 0 for bundled English. */
  downloadMb: number;
  /** The answer's JSON once decompressed, in MB: what the download's progress counts to (no Content-Length is sent). */
  jsonMb: number;
}

export const CARD_LANGUAGES: readonly CardLanguageInfo[] = [
  { code: 'en', ownName: 'English', englishName: 'English', downloadMb: 0, jsonMb: 0 },
  { code: 'fr', ownName: 'Français', englishName: 'French', downloadMb: 2.7, jsonMb: 18.7 },
  { code: 'de', ownName: 'Deutsch', englishName: 'German', downloadMb: 2.7, jsonMb: 19.0 },
  { code: 'it', ownName: 'Italiano', englishName: 'Italian', downloadMb: 2.6, jsonMb: 18.1 },
  { code: 'pt', ownName: 'Português', englishName: 'Portuguese', downloadMb: 2.5, jsonMb: 17.7 },
  { code: 'ja', ownName: '日本語', englishName: 'Japanese', downloadMb: 2.9, jsonMb: 24.6 },
  { code: 'ko', ownName: '한국어', englishName: 'Korean', downloadMb: 2.8, jsonMb: 22.4 },
];

/** Whether `value` is a card text language this version knows (Settings.display.cardLanguage). */
export function isCardLanguage(value: unknown): value is CardLanguage {
  return CARD_LANGUAGES.some((l) => l.code === value);
}

export function cardLanguageInfo(code: CardLanguage): CardLanguageInfo {
  return CARD_LANGUAGES.find((l) => l.code === code) ?? CARD_LANGUAGES[0];
}

/** The language's name in the interface's language ("French" in English, "Französisch" in German). */
export function languageName(l: CardLanguageInfo): string {
  try {
    return new Intl.DisplayNames([uiLang()], { type: 'language' }).of(l.code) ?? l.englishName;
  } catch {
    return l.englishName;
  }
}

/** The pack's source: YGOPRODeck's full card list in that language (the same host as the English refresh). */
export function cardLanguageUrl(code: Exclude<CardLanguage, 'en'>): string {
  return `https://db.ygoprodeck.com/api/v7/cardinfo.php?language=${code}`;
}

/** Every string the feature shows, in the interface's language; a language is named in it too (languageName). */
export const CARD_TEXT_COPY = {
  title: t('options_card_language_title'),
  intro: t('options_card_language_intro'),
  selectLabel: t('options_card_language_select_label'),
  /** The select's option: "Français (French), about 2.7 MB download". */
  option: (l: CardLanguageInfo) =>
    l.code === 'en'
      ? t('options_card_language_option_builtin')
      : t('options_card_language_option', l.ownName, languageName(l), l.downloadMb.toLocaleString(uiLang(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })),
  downloading: (l: CardLanguageInfo, percent: number) => t('options_card_language_downloading', languageName(l), Math.round(percent)),
  saving: (l: CardLanguageInfo) => t('options_card_language_saving', languageName(l)),
  ready: (l: CardLanguageInfo, cards: number, at: number) => t('options_card_language_ready', l.ownName, formatNumber(cards), formatDate(at)),
  english: t('options_card_language_english_builtin'),
  missing: (l: CardLanguageInfo) => t('options_card_language_missing', languageName(l)),
  retry: t('options_card_language_retry_button'),
  progressLabel: t('options_card_language_progress_label'),
  failed: (l: CardLanguageInfo, why: string) => t('options_card_language_failed', languageName(l), why),
  offline: t('options_card_language_reason_offline'),
  badAnswer: t('options_card_language_reason_bad_answer'),
  aiNote: t('options_card_language_ai_note'),
  /** The card view's subtitle, for screen readers: "English name: Dark Magician". */
  englishName: t('card_view_english_name_label'),
} as const;
