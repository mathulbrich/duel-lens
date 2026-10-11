// Options page, in sections: how to use (with a link to the welcome page), the keyboard shortcuts
// Chrome has now, how card details show in scan mode ("Show card details"), the opt-in AI check
// (needs the optional api.anthropic.com host permission), the card data and the self-updating
// artwork index, About, and (developer builds only) the debug test-set export. Settings and crops
// are read/written directly (chrome.storage and IndexedDB are
// shared across extension pages); get-status/test-ai/refresh-cards/update-index go through the
// background via sendToBackground, since only it can answer those. The look and the shared pieces
// (shortcuts, the card database's status, links) come from src/welcome, which the welcome page uses.
import type { ComponentChildren } from 'preact';
import { Fragment } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { supportsRefusalFallback } from '../background/ai';
import { getAllCrops, type CropRecord } from '../background/card-store';
import { getPackMeta, PackError, setCardLanguage, type LanguageProgress, type PackMeta } from '../background/card-text';
import { getSettings, isBanlistMode, isRevealMode, setSettings } from '../background/settings';
import { LensIcon } from '../content/icons';
import { CARD_LANGUAGES, CARD_TEXT_COPY, cardLanguageInfo, isCardLanguage } from '../shared/card-languages';
import { formatDate, formatNumber, t, uiLang } from '../shared/i18n';
import { tRich, withKeys } from '../shared/i18n-rich';
import { sendToBackground, type StatusResponse } from '../shared/messages';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';
import { ACCURACY, legalNotice } from '../welcome/copy';
import {
  ANTHROPIC_KEYS_URL,
  ANTHROPIC_PRICING_URL,
  CONSENT_PAGE,
  DISCLAIMER,
  ExternalLink,
  LICENCES_PAGE,
  PRIVACY_PAGE,
  WELCOME_PAGE,
  YGOPRODECK_URL,
  manifestVersion,
} from '../welcome/links';
import { Keys, commandLabel, openShortcutsPage, shortcutOf, useShortcuts, type Command, type ShortcutsState } from '../welcome/shortcuts';
import { CardDbStatus, cardDbState } from '../welcome/status';
import { PAGE_CSS } from '../welcome/theme';

// claude-haiku-4-5 is deliberately not offered: it takes budget_tokens instead of
// adaptive thinking and errors on `output_config.effort`, so every request ai.ts
// builds would fail on it (review Important 2).
const MODEL_CHOICES = [
  { id: 'claude-opus-5', name: 'Claude Opus 5', note: t('options_ai_model_note_recommended') },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', note: t('options_ai_model_note_lower_cost') },
];
const ANTHROPIC_ORIGIN = 'https://api.anthropic.com/*';

/**
 * The AI check's disclosure, shown above its toggle so it is read before the check can be turned
 * on (the store's prominent-disclosure rule). Word for word the text in store/privacy-practices.md,
 * section 7, so the listing and the product match: change both together (a test compares them).
 */
export const AI_DISCLOSURE = t('options_ai_disclosure');

/** How often the page asks for progress while the artwork index updates. */
const INDEX_POLL_MS = 2000;

/**
 * "Show card details" (Settings.display.reveal), in the order shown, each with its one line of help. There is
 * no hover-only mode: a click always works (touch, the keyboard, the popover's buttons). The content script
 * gets the choice when scan mode opens (begin-selection, src/background/scan.ts).
 */
export const REVEAL_CHOICES: { value: Settings['display']['reveal']; label: string; help: string }[] = [
  { value: 'hover', label: t('options_reveal_hover'), help: t('options_reveal_hover_help') },
  { value: 'click', label: t('options_reveal_click_label'), help: t('options_reveal_click_help') },
];

/**
 * "Banlist" (Settings.display.banlist): which list the card chip shows. The content script gets the
 * choice when scan mode opens (begin-selection, src/background/scan.ts); the side panel reads it itself.
 */
export const BANLIST_CHOICES: { value: Settings['display']['banlist']; label: string; help: string }[] = [
  { value: 'tcg', label: t('options_banlist_tcg_label'), help: t('options_banlist_tcg_help') },
  { value: 'ocg', label: t('options_banlist_ocg_label'), help: t('options_banlist_ocg_help') },
];

export function buildTestSetRecords(crops: CropRecord[]): { dataUrl: string; cardId: number }[] {
  return crops.map((c) => ({ dataUrl: c.dataUrl, cardId: c.cardId }));
}

function formatUpdatedAt(ms?: number): string {
  if (!ms) return t('options_never');
  return new Date(ms).toLocaleString(uiLang());
}

function modelName(id: string): string {
  return MODEL_CHOICES.find((m) => m.id === id)?.name ?? id;
}

/** "N bundled + M added on this computer" for the self-updating artwork index. `bundled`
 * is null while its count (read from the packaged index's own metadata, not the
 * background) hasn't loaded yet. */
export function formatArtworksIndexed(bundled: number | null, delta: number | undefined): string {
  if (bundled === null) return '—';
  return t('options_artworks_indexed_count', formatNumber(bundled), formatNumber(delta ?? 0));
}

/** A build without remote images: the bundled artworks (plus any an earlier version added here). */
export function formatBundledArtworks(bundled: number | null, delta: number | undefined): string {
  if (bundled === null) return '—';
  const added = delta ? t('options_bundled_artworks_extra', formatNumber(delta)) : '';
  return t('options_bundled_artworks_count', formatNumber(bundled), added);
}

/** One of: running (with however much of the count is known), the last completed run's
 * time, or the last run's error - never more than one at once. */
export function formatIndexUpdateState(update?: StatusResponse['indexUpdate']): string {
  if (update?.state === 'running') {
    if (update.pending === undefined) return t('options_updating_ellipsis');
    return update.pending === 1
      ? t('options_updating_artworks_left_one', formatNumber(update.pending))
      : t('options_updating_artworks_left_other', formatNumber(update.pending));
  }
  if (update?.state === 'failed') return update.error ?? t('options_last_update_failed');
  return t('options_index_status_last_updated', formatUpdatedAt(update?.lastRun));
}

export function App({ pollMs = INDEX_POLL_MS }: { pollMs?: number } = {}) {
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [bundledArtworkCount, setBundledArtworkCount] = useState<number | null>(null);
  const [indexUpdateMessage, setIndexUpdateMessage] = useState<string | null>(null);
  const shortcuts = useShortcuts();
  // "Card text language": the stored pack, and the language being downloaded with its progress (none when idle).
  const [pack, setPack] = useState<PackMeta | undefined>(undefined);
  const [langJob, setLangJob] = useState<{ lang: Settings['display']['cardLanguage']; progress?: LanguageProgress } | null>(null);
  const [langError, setLangError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await sendToBackground({ type: 'get-status' });
      if (!next) throw new Error('get-status had no answer');
      setStatus(next);
      setStatusFailed(false);
    } catch {
      setStatusFailed(true);
    }
  }, []);

  useEffect(() => {
    getSettings().then(setSettingsState);
    void refreshStatus();
    getPackMeta()
      .then(setPack)
      .catch(() => setPack(undefined));
  }, [refreshStatus]);

  // The bundled index's own size: a static number baked into the packaged index's
  // metadata (extension/data/index-<model>.meta.json), so it's read directly rather than
  // added to get-status (which only the background could answer for a *live* value).
  useEffect(() => {
    const modelId = status?.modelId;
    if (!modelId) return;
    let cancelled = false;
    fetch(chrome.runtime.getURL(`data/index-${modelId}.meta.json`))
      .then((res) => res.json())
      .then((meta: { count?: number }) => {
        if (!cancelled && typeof meta.count === 'number') setBundledArtworkCount(meta.count);
      })
      .catch(() => {
        if (!cancelled) setBundledArtworkCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [status?.modelId]);

  // "Update now" only starts the run (router.ts): while it runs, ask for its progress again
  // every pollMs, until get-status says it has finished or failed.
  const indexRunning = status?.indexUpdate?.state === 'running';
  useEffect(() => {
    if (!indexRunning) return;
    const timer = setTimeout(() => void refreshStatus(), pollMs);
    return () => clearTimeout(timer);
  }, [status, indexRunning, pollMs, refreshStatus]);

  async function onToggleAi(ev: Event) {
    const nextEnabled = (ev.target as HTMLInputElement).checked;
    if (nextEnabled) {
      const granted = await chrome.permissions.request({ origins: [ANTHROPIC_ORIGIN] });
      if (!granted) {
        setAiMessage(t('options_ai_permission_denied'));
        return;
      }
    }
    setAiMessage(null);
    setSettingsState(await setSettings({ ai: { ...settings.ai, enabled: nextEnabled } }));
    // Off: api.anthropic.com goes back too, since the grant is the user's consent to the AI check (final
    // review M12). The key stays (clearing its field deletes it): turning the check on again asks only for
    // the permission.
    if (!nextEnabled) {
      await chrome.permissions
        .remove({ origins: [ANTHROPIC_ORIGIN] })
        .catch((err) => console.warn('Duel Lens: could not remove the api.anthropic.com permission', err));
    }
  }

  // onInput (not onChange, which in plain Preact means the native "change" event -
  // fired on blur, not on keystroke): the key should save as the user types it.
  async function onApiKeyInput(ev: Event) {
    const apiKey = (ev.target as HTMLInputElement).value;
    setSettingsState(await setSettings({ ai: { ...settings.ai, apiKey } }));
  }

  async function onModelChange(ev: Event) {
    const model = (ev.target as HTMLSelectElement).value;
    setSettingsState(await setSettings({ ai: { ...settings.ai, model } }));
  }

  async function onRevealChange(ev: Event) {
    const reveal = (ev.target as HTMLInputElement).value;
    if (!isRevealMode(reveal)) return;
    setSettingsState(await setSettings({ display: { ...settings.display, reveal } }));
  }

  // Another language downloads its pack first (card-text.ts setCardLanguage); the setting changes only once it is
  // stored, so a failed download (offline, a bad answer) leaves the cards in the language they were in.
  async function onCardLanguageChange(ev: Event) {
    await pickCardLanguage((ev.target as HTMLSelectElement).value);
  }

  async function pickCardLanguage(lang: string) {
    if (!isCardLanguage(lang) || langJob) return;
    setLangError(null);
    setLangJob({ lang });
    try {
      const meta = await setCardLanguage(lang, { onProgress: (progress) => setLangJob({ lang, progress }) });
      setPack(meta);
    } catch (err) {
      console.warn('Duel Lens: the card text download failed', err);
      const why = err instanceof PackError && err.kind === 'bad-answer' ? CARD_TEXT_COPY.badAnswer : CARD_TEXT_COPY.offline;
      setLangError(CARD_TEXT_COPY.failed(cardLanguageInfo(lang), why));
    } finally {
      setSettingsState(await getSettings());
      setLangJob(null);
    }
  }

  async function onBanlistChange(ev: Event) {
    const banlist = (ev.target as HTMLInputElement).value;
    if (!isBanlistMode(banlist)) return;
    setSettingsState(await setSettings({ display: { ...settings.display, banlist } }));
  }

  async function onTest() {
    setTestMessage({ text: t('options_testing_ellipsis') });
    try {
      const res = await sendToBackground({ type: 'test-ai' });
      setTestMessage(
        res.ok ? { text: t('options_test_success') } : { text: res.error ?? t('options_test_unknown_error'), error: true },
      );
    } catch {
      setTestMessage({ text: t('options_test_could_not_run'), error: true });
    }
  }

  async function onCheckForUpdates() {
    setUpdateMessage(t('options_checking_ellipsis'));
    try {
      const res = await sendToBackground({ type: 'refresh-cards' });
      setUpdateMessage(res.ok ? t('options_check_updates_success') : (res.error ?? t('options_check_updates_failed')));
    } catch {
      setUpdateMessage(t('options_check_updates_failed'));
    }
    await refreshStatus();
  }

  async function onUpdateIndex() {
    setIndexUpdateMessage(null);
    try {
      const res = await sendToBackground({ type: 'update-index' });
      if (!res.ok) setIndexUpdateMessage(res.error ?? t('options_update_start_failed'));
    } catch {
      setIndexUpdateMessage(t('options_update_start_failed'));
    }
    await refreshStatus();
  }

  function onRetryStatus() {
    setStatus(null);
    setStatusFailed(false);
    void refreshStatus();
  }

  const scan = shortcutOf(shortcuts, 'scan-card');
  const version = manifestVersion();
  // The crop build (`--no-remote-images`) shows the user's own crop and downloads no artwork (__DUEL_LENS_REMOTE_IMAGES__).
  const remoteImages = __DUEL_LENS_REMOTE_IMAGES__;

  return (
    <div class="options">
      <style>{PAGE_CSS + OPTIONS_CSS}</style>
      <header class="op-top">
        <span class="brand">
          <LensIcon />
          Duel Lens
        </span>
        <h1>{t('options_page_title')}</h1>
      </header>

      <main>
        <Section id="how-to-use" title={t('options_section_how_to_use')}>
          <p>
            {scan
              ? tRich('options_how_press_shortcut', <Keys shortcut={scan} />)
              : scan === ''
                ? t('options_how_click_icon')
                : t('options_how_press_fallback')}{' '}
            {t(
              'options_how_body',
              settings.display.reveal === 'hover' ? t('options_how_reveal_hover_phrase') : t('options_how_reveal_click_phrase'),
            )}
          </p>
          <p>{withKeys(t('options_intro_stays_open'))}</p>
          <p>
            <a class="btn" href={WELCOME_PAGE}>
              {t('options_open_welcome_guide')}
            </a>
          </p>
        </Section>

        <Section id="shortcuts" title={t('options_section_shortcuts')}>
          <ShortcutList state={shortcuts} />
          <div class="row-actions">
            <button type="button" class="btn" onClick={() => openShortcutsPage()}>
              {t('options_change_shortcuts_button')}
            </button>
            <p class="hint">{t('options_shortcuts_hint')}</p>
          </div>
          <p class="hint">{withKeys(t('options_shortcuts_frozen_picture_hint'))}</p>
          <p class="hint">{withKeys(t('options_shortcuts_card_view_hint'))}</p>
        </Section>

        <Section id="card-details" title={t('options_section_show_card_details')}>
          <div class="choices" role="radiogroup" aria-labelledby="card-details-title">
            {REVEAL_CHOICES.map((c) => (
              <div class="choice" key={c.value}>
                <label class="check">
                  <input
                    type="radio"
                    name="reveal"
                    value={c.value}
                    checked={settings.display.reveal === c.value}
                    onChange={onRevealChange}
                    aria-describedby={`reveal-${c.value}-help`}
                  />
                  {c.label}
                  {c.value === DEFAULT_SETTINGS.display.reveal ? <span class="hint">{t('options_default_suffix')}</span> : null}
                </label>
                <p class="hint" id={`reveal-${c.value}-help`}>
                  {c.help}
                </p>
              </div>
            ))}
          </div>
        </Section>

        <Section id="banlist" title={t('options_section_banlist')}>
          <div class="choices" role="radiogroup" aria-labelledby="banlist-title">
            {BANLIST_CHOICES.map((c) => (
              <div class="choice" key={c.value}>
                <label class="check">
                  <input
                    type="radio"
                    name="banlist"
                    value={c.value}
                    checked={settings.display.banlist === c.value}
                    onChange={onBanlistChange}
                    aria-describedby={`banlist-${c.value}-help`}
                  />
                  {c.label}
                  {c.value === DEFAULT_SETTINGS.display.banlist ? <span class="hint">{t('options_default_suffix')}</span> : null}
                </label>
                <p class="hint" id={`banlist-${c.value}-help`}>
                  {c.help}
                </p>
              </div>
            ))}
          </div>
        </Section>

        <Section id="card-language" title={CARD_TEXT_COPY.title}>
          <p>{CARD_TEXT_COPY.intro}</p>
          <div class="field">
            <label for="card-language-select">{CARD_TEXT_COPY.selectLabel}</label>
            <select
              id="card-language-select"
              value={langJob?.lang ?? settings.display.cardLanguage}
              disabled={langJob !== null}
              onChange={onCardLanguageChange}
              aria-describedby="card-language-state"
            >
              {CARD_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code} lang={l.code}>
                  {CARD_TEXT_COPY.option(l)}
                </option>
              ))}
            </select>
          </div>
          <CardLanguageState
            lang={settings.display.cardLanguage}
            pack={pack}
            job={langJob}
            error={langError}
            onRetry={() => void pickCardLanguage(settings.display.cardLanguage)}
          />
          <p class="hint">{CARD_TEXT_COPY.aiNote}</p>
        </Section>

        <Section id="ai-check" title={t('options_section_ai_check')}>
          <p>{t('options_ai_intro')}</p>
          <p class="disclosure">{AI_DISCLOSURE}</p>
          <ul class="facts">
            <li>
              <b>{t('options_ai_cost_label')}</b>{' '}
              {tRich('options_ai_cost_text', <ExternalLink href={ANTHROPIC_PRICING_URL}>{t('options_ai_cost_link_text')}</ExternalLink>)}
            </li>
            <li>
              {tRich('options_ai_key_fact', <b>{t('options_ai_key_label')}</b>)}
            </li>
          </ul>
          <label class="check">
            <input type="checkbox" checked={settings.ai.enabled} onChange={onToggleAi} />
            {t('options_ai_offer_checkbox')}
          </label>
          {aiMessage && (
            <p class="message error" role="alert">
              {aiMessage}
            </p>
          )}
          <div class="field">
            <label for="ai-key">{t('options_ai_key_field_label')}</label>
            <input
              id="ai-key"
              type="password"
              value={settings.ai.apiKey}
              onInput={onApiKeyInput}
              placeholder={t('options_ai_key_placeholder')}
              autocomplete="off"
              spellcheck={false}
            />
            <p class="hint">
              {tRich('options_ai_get_key', <ExternalLink href={ANTHROPIC_KEYS_URL}>{t('options_ai_get_key_link')}</ExternalLink>)}
            </p>
          </div>
          <div class="field">
            <label for="ai-model">{t('options_ai_model_field_label')}</label>
            <select id="ai-model" value={settings.ai.model} onChange={onModelChange}>
              {MODEL_CHOICES.map((m) => (
                <option key={m.id} value={m.id}>
                  {`${m.name} (${m.note})`}
                </option>
              ))}
            </select>
            {supportsRefusalFallback(settings.ai.model) && (
              <p class="hint">{t('options_ai_refusal_fallback_hint', modelName(settings.ai.model))}</p>
            )}
          </div>
          <div class="row-actions">
            <button type="button" class="btn" onClick={onTest}>
              {t('options_test_button')}
            </button>
            {testMessage ? (
              <p class={`message${testMessage.error ? ' error' : ''}`} role="status">
                {testMessage.text}
              </p>
            ) : (
              <p class="hint">{t('options_test_hint')}</p>
            )}
          </div>
        </Section>

        <Section id="data" title={t('options_section_data')}>
          <CardDbStatus state={cardDbState(status, statusFailed)} onRetry={onRetryStatus} />
          <div class="sub">
            <h3>{t('options_data_card_db_heading')}</h3>
            <p class="hint">{tRich('options_card_db_hint', <ExternalLink href={YGOPRODECK_URL}>YGOPRODeck</ExternalLink>)}</p>
            <dl class="kv">
              <dt>{t('options_label_db_version')}</dt>
              <dd>{status?.dbVersion ?? '—'}</dd>
              <dt>{t('options_label_last_updated')}</dt>
              <dd>{formatUpdatedAt(status?.cardsUpdatedAt)}</dd>
              <dt>{t('options_label_cards_loaded')}</dt>
              <dd>{formatNumber(status?.cardCount ?? 0)}</dd>
            </dl>
            <div class="row-actions">
              <button type="button" class="btn" onClick={onCheckForUpdates}>
                {t('options_check_updates_button')}
              </button>
              {updateMessage && (
                <p class="message" role="status">
                  {updateMessage}
                </p>
              )}
            </div>
          </div>
          <div class="sub">
            <h3>{t('options_artwork_index_heading')}</h3>
            {remoteImages ? (
              <>
                <p class="hint">{t('options_artwork_index_hint_remote')}</p>
                <dl class="kv">
                  <dt>{t('options_label_artworks_indexed')}</dt>
                  <dd>{formatArtworksIndexed(bundledArtworkCount, status?.indexDeltaCount)}</dd>
                  <dt>{t('options_label_status')}</dt>
                  <dd>{formatIndexUpdateState(status?.indexUpdate)}</dd>
                </dl>
                <div class="row-actions">
                  <button type="button" class="btn" onClick={onUpdateIndex} disabled={indexRunning}>
                    {indexRunning ? t('options_updating_ellipsis') : t('options_update_now_button')}
                  </button>
                  {indexUpdateMessage && (
                    <p class="message error" role="alert">
                      {indexUpdateMessage}
                    </p>
                  )}
                </div>
              </>
            ) : (
              <>
                <p class="hint">{t('options_artwork_index_hint_bundled')}</p>
                <dl class="kv">
                  <dt>{t('options_label_artworks_indexed')}</dt>
                  <dd>{formatBundledArtworks(bundledArtworkCount, status?.indexDeltaCount)}</dd>
                </dl>
              </>
            )}
          </div>
        </Section>

        {__DUEL_LENS_DEV__ ? <DebugSection saveCrops={settings.debug.saveCrops} onSettings={setSettingsState} /> : null}

        <Section id="about" title={t('options_section_about')}>
          <p class="about-name">
            <span>Duel Lens</span>
            {version ? <span class="hint">{t('common_version_label', version)}</span> : null}
          </p>
          <p>
            {t('options_about_intro')}{' '}
            {tRich(
              remoteImages ? 'options_about_data_images_source' : 'options_about_data_source',
              <ExternalLink href={YGOPRODECK_URL}>YGOPRODeck</ExternalLink>,
            )}
          </p>
          {status ? (
            status.consentedAt !== undefined ? (
              <p>
                {t('common_agreed_on_date', formatDate(status.consentedAt, { dateStyle: 'long' }))}{' '}
                <a href={CONSENT_PAGE}>{t('options_about_agreed_link')}</a>
              </p>
            ) : (
              <p>
                {t('options_about_not_agreed')} <a href={CONSENT_PAGE}>{t('options_about_review_agree_link')}</a>
              </p>
            )
          ) : null}
          <p class="disclaimer">{DISCLAIMER}</p>
          <p class="hint">{ACCURACY}</p>
          <details class="legal">
            <summary>{t('options_legal_notice_summary')}</summary>
            <p class="hint">{legalNotice(remoteImages)}</p>
          </details>
          <p class="links">
            <a href={WELCOME_PAGE}>{t('options_link_welcome_guide')}</a>
            <a href={PRIVACY_PAGE} target="_blank" rel="noopener">
              {t('common_link_privacy_policy')}
            </a>
            <a href={LICENCES_PAGE} target="_blank" rel="noopener">
              {t('common_link_licences')}
            </a>
          </p>
        </Section>
      </main>
    </div>
  );
}

/**
 * Developer builds only (`__DUEL_LENS_DEV__`): keep the crops of recent scans for a test set, and
 * export them. A store build leaves this out entirely (the store's privacy disclosures don't cover
 * it), and with it every reference to the saved crops.
 */
function DebugSection({ saveCrops, onSettings }: { saveCrops: boolean; onSettings(next: Settings): void }) {
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  async function onSaveCropsChange(ev: Event) {
    const next = (ev.target as HTMLInputElement).checked;
    onSettings(await setSettings({ debug: { saveCrops: next } }));
  }

  async function onExportTestSet() {
    const crops = await getAllCrops();
    const records = buildTestSetRecords(crops);
    const blob = new Blob([JSON.stringify(records)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'duel-lens-test-set.json';
    a.click();
    URL.revokeObjectURL(url);
    setExportMessage(records.length === 1 ? t('options_debug_exported_count_one', records.length) : t('options_debug_exported_count_other', records.length));
  }

  return (
    <Section id="debug" title={t('options_section_debug')}>
      <p class="hint">{t('options_debug_hint')}</p>
      <label class="check">
        <input type="checkbox" checked={saveCrops} onChange={onSaveCropsChange} />
        {t('options_debug_save_crops_checkbox')}
      </label>
      <div class="row-actions">
        <button type="button" class="btn" onClick={onExportTestSet}>
          {t('options_debug_export_button')}
        </button>
        {exportMessage && (
          <p class="message" role="status">
            {exportMessage}
          </p>
        )}
      </div>
    </Section>
  );
}

/** Under the card text language select: the download's progress, its error, or what is stored. */
function CardLanguageState({
  lang,
  pack,
  job,
  error,
  onRetry,
}: {
  lang: Settings['display']['cardLanguage'];
  pack: PackMeta | undefined;
  job: { lang: Settings['display']['cardLanguage']; progress?: LanguageProgress } | null;
  error: string | null;
  /** Downloads the chosen language's pack again, when it isn't stored (a cleared database, say). */
  onRetry: () => void;
}) {
  if (job && job.lang !== 'en') {
    const info = cardLanguageInfo(job.lang);
    const total = info.jsonMb * 1e6;
    const bytes = job.progress?.stage === 'downloading' ? job.progress.bytes : job.progress?.stage === 'saving' ? total : 0;
    // The answer has no Content-Length: the measured size is 100%, and the bar waits at 99% for a longer answer.
    const percent = Math.min(99, (bytes / total) * 100);
    return (
      <div class="field" id="card-language-state">
        <progress max={100} value={job.progress?.stage === 'saving' ? 100 : percent} aria-label={CARD_TEXT_COPY.progressLabel} />
        <p class="message" role="status">
          {job.progress?.stage === 'saving' ? CARD_TEXT_COPY.saving(info) : CARD_TEXT_COPY.downloading(info, percent)}
        </p>
      </div>
    );
  }
  const info = cardLanguageInfo(lang);
  return (
    <div id="card-language-state">
      {error ? (
        <p class="message error" role="alert">
          {error}
        </p>
      ) : null}
      <p class="message" role="status">
        {lang === 'en' ? CARD_TEXT_COPY.english : pack?.lang === lang ? CARD_TEXT_COPY.ready(info, pack.cards, pack.downloadedAt) : CARD_TEXT_COPY.missing(info)}
      </p>
      {lang !== 'en' && pack?.lang !== lang ? (
        <button type="button" class="btn" onClick={onRetry}>
          {CARD_TEXT_COPY.retry}
        </button>
      ) : null}
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ComponentChildren }) {
  return (
    <section id={id} class="op-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{title}</h2>
      {children}
    </section>
  );
}

/** Scan first, then the side panel, then anything else Chrome lists. */
const COMMAND_ORDER = ['scan-card', 'open-panel'];
const rank = (c: Command) => {
  const i = COMMAND_ORDER.indexOf(c.name);
  return i < 0 ? COMMAND_ORDER.length : i;
};

/** The commands and their current shortcuts. The toolbar icon's own command is listed only once it has one. */
function ShortcutList({ state }: { state: ShortcutsState }) {
  if (state.status === 'loading') return <p class="hint">{t('options_shortcuts_loading')}</p>;
  const commands = state.commands
    .filter((c) => c.name !== '_execute_action' || c.shortcut)
    .sort((a, b) => rank(a) - rank(b));
  return (
    <dl class="kv shortcuts">
      {commands.map((c) => (
        <Fragment key={c.name}>
          <dt>{commandLabel(c)}</dt>
          <dd>
            {c.shortcut ? <Keys shortcut={c.shortcut} /> : <span class="not-set">{t('options_shortcut_not_set')}</span>}
            {state.status === 'fallback' && c.shortcut ? <span class="hint"> {t('options_default_suffix')}</span> : null}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

const OPTIONS_CSS = /* css */ `
.options { max-width: 760px; margin: 0 auto; padding: 28px 28px 56px; }
.op-top { display: grid; gap: 6px; margin: 10px 0 8px; }
.op-top h1 { font-family: var(--f-name); font-weight: 700; font-size: 36px; line-height: 1.1; }
.op-section { display: grid; gap: 14px; margin-top: 16px; padding: 22px 24px 24px; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); scroll-margin-top: 16px; }
.op-section > h2 { font-size: 20px; font-weight: 720; font-stretch: 90%; line-height: 1.25; }
.op-section p { max-width: 62em; }
.op-section .status { justify-self: start; }
.sub { display: grid; gap: 10px; padding-top: 16px; border-top: 1px solid var(--line); }
.sub h3 { font-size: 15px; font-weight: 700; }
.disclosure { padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line); border-left: 3px solid var(--gold); background: var(--bg); font-size: 14px; }
.facts { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; color: var(--ink-2); font-size: 14px; }
.facts li { position: relative; padding-left: 16px; }
.facts li::before { content: ""; position: absolute; left: 1px; top: .6em; width: 6px; height: 6px; border-radius: 50%; background: var(--gold); }
.facts b { color: var(--ink); font-weight: 650; }
.check { display: flex; align-items: center; gap: 10px; font-weight: 620; cursor: pointer; width: fit-content; }
.check input { width: 18px; height: 18px; margin: 0; accent-color: var(--accent); cursor: pointer; }
.choices { display: grid; gap: 12px; }
.choice { display: grid; gap: 2px; }
/* the help lines up with the choice's name, after the 18px radio and the 10px gap */
.choice > .hint { padding-left: 28px; }
.field { display: grid; gap: 6px; justify-items: start; }
.field label { font-size: 13px; font-weight: 650; color: var(--ink-2); }
.field input, .field select { width: min(100%, 420px); font: inherit; font-size: 14px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--bg); color: var(--ink); }
.field input:focus-visible, .field select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.field progress { width: min(100%, 420px); height: 8px; accent-color: var(--accent); }
.row-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.row-actions .hint { flex: 1 1 260px; }
.kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 20px; font-size: 14px; align-items: center; }
.kv dt { color: var(--ink-2); }
.kv dd { margin: 0; overflow-wrap: anywhere; }
.shortcuts kbd.combo { font-size: 14px; }
.not-set { display: inline-block; padding: 1px 8px; border-radius: 6px; border: 1px dashed var(--line-strong); color: var(--ink-2); font-size: 13px; }
.message { font-size: 13.5px; }
.message.error { color: var(--err); }
.about-name { display: flex; align-items: baseline; gap: 10px; font-weight: 700; font-size: 16px; }
.disclaimer { font-weight: 550; }
.links { display: flex; flex-wrap: wrap; gap: 6px 20px; font-size: 14px; }
.legal summary { cursor: pointer; font-size: 14px; font-weight: 620; color: var(--ink-2); width: fit-content; }
.legal p { margin-top: 8px; }
@media (max-width: 560px) {
  .options { padding: 18px 14px 40px; }
  .op-section { padding: 18px 16px 20px; }
  .kv { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .kv dd { margin-bottom: 8px; }
}
`;
