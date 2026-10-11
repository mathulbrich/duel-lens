// The legal and privacy wording on Duel Lens's own pages (welcome, Options, side panel), word for
// word from the legal workstream's docs/release/disclaimers.md: copy.test.ts fails when they drift
// apart, so change both together.
//
// The crop build (`--no-remote-images`: __DUEL_LENS_REMOTE_IMAGES__ off) shows the user's own
// crop instead of YGOPRODeck's card images and downloads no artwork. There, the texts change only
// where the doc says to for a text-only build ("Card data and images" becomes "Card data": its §3.3
// and §8), and disclose the small picture each scan keeps for the side panel (thumbnail.ts).
//
// Links are written [like this](url), as in the doc; <Rich> renders them (markdown.tsx). The words come from
// chrome.i18n (src/shared/i18n.ts; English: extension/_locales/en/messages.json), and the links are put back on
// them here (linked()): the translators see plain sentences.
import { t } from '../shared/i18n';

export const YGOPRODECK_LINK = '[YGOPRODeck](https://ygoprodeck.com/)';

/** `text` with the first `word` in it made a [word](url) link (as is when a translation doesn't use the word). */
export function linked(text: string, word: string, url: string): string {
  const at = text.indexOf(word);
  return at < 0 ? text : `${text.slice(0, at)}[${word}](${url})${text.slice(at + word.length)}`;
}

const withYgoprodeck = (text: string) => linked(text, 'YGOPRODeck', 'https://ygoprodeck.com/');

/** §1: the short disclaimer, on every page. */
export const DISCLAIMER = t('common_disclaimer');

/** §2: the full legal notice (Options → About, the welcome page's footer). */
export function legalNotice(remoteImages: boolean): string {
  return t('common_legal_notice', remoteImages ? t('common_legal_notice_data_images') : t('common_legal_notice_data_only'));
}

/** §4 and §8: the credit in the welcome and Options footers. */
export function attribution(remoteImages: boolean): string {
  return withYgoprodeck(t('common_attribution', remoteImages ? t('common_data_label_images') : t('common_data_label_only')));
}

/** §8: the side panel's footer. */
export function sidePanelCredit(remoteImages: boolean): string {
  return withYgoprodeck(
    t('common_sidepanel_credit', remoteImages ? t('common_data_label_images') : t('common_data_label_only'), t('common_sidepanel_credit_tail')),
  );
}

/** §6: the accuracy notice (Options → About). */
export const ACCURACY = t('common_accuracy_notice');

/**
 * One point of a list: `lead` shown in bold, then `rest` (which starts with its own space or comma). A translation
 * may put the lead inside its sentence: the words before it are `before`.
 */
export interface Point {
  before?: string;
  lead: string;
  rest: string;
}

/** The point as the doc writes it. */
export const pointText = (p: Point) => (p.before ?? '') + p.lead + p.rest;

/** The lead's stand-in while a whole-sentence message is looked up (a private-use character). */
const LEAD = '\uE000';

/** A point that is one sentence with its bold lead in it ($lead$, its own key): the sentence split around the lead. */
function sentencePoint(lead: string, sentence: (lead: string) => string): Point {
  const [before, ...after] = sentence(LEAD).split(LEAD);
  return { ...(before ? { before } : {}), lead, rest: after.join(lead) };
}

/** §4a: the first-run consent the Chrome Web Store requires before the first scan. */
export const CONSENT = {
  heading: t('welcome_consent_heading'),
  /** When a scan brought the user here before they agreed (welcome.html#consent). */
  headingAfterScan: t('welcome_consent_heading_after_scan'),
  intro: t('welcome_consent_intro'),
  agree: t('welcome_consent_agree_button'),
  notNow: t('welcome_consent_not_now_button'),
  privacy: t('common_link_privacy_policy'),
} as const;


export function consentPoints(remoteImages: boolean): Point[] {
  return [
    { lead: t('welcome_consent_point1_lead'), rest: ` ${t('welcome_consent_point1_rest')}` },
    // The crop build's history also keeps a small picture of each scan.
    { lead: t('welcome_consent_point2_lead'), rest: ` ${remoteImages ? t('welcome_consent_point2_rest') : t('welcome_consent_point2_rest_crop')}` },
    remoteImages
      ? { lead: t('welcome_consent_point3_remote_lead'), rest: ` ${t('welcome_consent_point3_remote_rest')}` }
      : { lead: t('welcome_consent_point3_bundled_lead'), rest: ` ${t('welcome_consent_point3_bundled_rest')}` },
    { lead: t('welcome_consent_point4_lead'), rest: ` ${t('welcome_consent_point4_rest')}` },
  ];
}

/** §4, "On this computer" (the welcome page). */
export function onThisComputer(remoteImages: boolean): Point[] {
  return [
    { lead: t('welcome_local_point1_lead'), rest: ` ${t('welcome_local_point1_rest')}` },
    sentencePoint(t('welcome_local_point2_lead'), (lead) => (remoteImages ? t('welcome_local_point2', lead) : t('welcome_local_point2_crop', lead))),
  ];
}

/** §4, "Online" (the welcome page). "Options" links to the Options page there. */
export function online(remoteImages: boolean): Point[] {
  return [
    remoteImages
      ? sentencePoint(t('welcome_online_point1_remote_lead'), (lead) => withYgoprodeck(t('welcome_online_point1_remote', lead)))
      : sentencePoint(t('welcome_online_point1_bundled_lead'), (lead) => withYgoprodeck(t('welcome_online_point1_bundled', lead))),
    sentencePoint(t('welcome_online_point2_lead'), (lead) => t('welcome_online_point2', lead, `[${t('common_options_label')}](options.html)`)),
    { lead: t('welcome_online_point3_lead'), rest: ` ${t('welcome_online_point3_rest')}` },
  ];
}
