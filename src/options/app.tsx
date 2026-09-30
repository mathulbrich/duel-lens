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
import { getSettings, isRevealMode, setSettings } from '../background/settings';
import { LensIcon } from '../content/icons';
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
  { id: 'claude-opus-5', name: 'Claude Opus 5', note: 'recommended' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', note: 'lower cost' },
];
const ANTHROPIC_ORIGIN = 'https://api.anthropic.com/*';

/**
 * The AI check's disclosure, shown above its toggle so it is read before the check can be turned
 * on (the store's prominent-disclosure rule). Word for word the text in store/privacy-practices.md,
 * section 7, so the listing and the product match: change both together (a test compares them).
 */
export const AI_DISCLOSURE =
  'Off by default. When you press "Ask AI" on an unsure match, Duel Lens sends the cropped image of that card and ' +
  'up to five candidate card names to Anthropic (api.anthropic.com) with your API key. Nothing is sent until you ' +
  "press Ask AI. Anthropic's terms and privacy policy apply to those requests, and they are billed to your key.";

/** How often the page asks for progress while the artwork index updates. */
const INDEX_POLL_MS = 2000;

/**
 * "Show card details" (Settings.display.reveal), in the order shown, each with its one line of help. There is
 * no hover-only mode: a click always works (touch, the keyboard, the popover's buttons). The content script
 * gets the choice when scan mode opens (begin-selection, src/background/scan.ts).
 */
export const REVEAL_CHOICES: { value: Settings['display']['reveal']; label: string; help: string }[] = [
  {
    value: 'hover',
    label: 'Hover or click',
    help: 'Resting the pointer on an outlined card shows a quick preview, and a click shows the full details.',
  },
  { value: 'click', label: 'Click', help: "No previews: a card's details show only when you click it." },
];

export function buildTestSetRecords(crops: CropRecord[]): { dataUrl: string; cardId: number }[] {
  return crops.map((c) => ({ dataUrl: c.dataUrl, cardId: c.cardId }));
}

function formatUpdatedAt(ms?: number): string {
  if (!ms) return 'never';
  return new Date(ms).toLocaleString();
}

function modelName(id: string): string {
  return MODEL_CHOICES.find((m) => m.id === id)?.name ?? id;
}

/** "N bundled + M added on this computer" for the self-updating artwork index. `bundled`
 * is null while its count (read from the packaged index's own metadata, not the
 * background) hasn't loaded yet. */
export function formatArtworksIndexed(bundled: number | null, delta: number | undefined): string {
  if (bundled === null) return '—';
  return `${bundled.toLocaleString()} bundled + ${(delta ?? 0).toLocaleString()} added on this computer`;
}

/** A build without remote images: the bundled artworks (plus any an earlier version added here). */
export function formatBundledArtworks(bundled: number | null, delta: number | undefined): string {
  if (bundled === null) return '—';
  const added = delta ? ` + ${delta.toLocaleString()} added earlier on this computer` : '';
  return `${bundled.toLocaleString()} bundled with Duel Lens${added}`;
}

const formatDate = (at: number) => new Date(at).toLocaleDateString(undefined, { dateStyle: 'long' });

/** One of: running (with however much of the count is known), the last completed run's
 * time, or the last run's error - never more than one at once. */
export function formatIndexUpdateState(update?: StatusResponse['indexUpdate']): string {
  if (update?.state === 'running') {
    return update.pending !== undefined
      ? `Updating: ${update.pending} artwork${update.pending === 1 ? '' : 's'} left…`
      : 'Updating…';
  }
  if (update?.state === 'failed') return update.error ?? 'The last update failed.';
  return `Last updated: ${formatUpdatedAt(update?.lastRun)}`;
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
        setAiMessage('Permission for api.anthropic.com was denied, so the AI check stays off.');
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

  async function onTest() {
    setTestMessage({ text: 'Testing…' });
    try {
      const res = await sendToBackground({ type: 'test-ai' });
      setTestMessage(
        res.ok ? { text: 'It works: Claude answered using your key.' } : { text: res.error ?? 'Unknown error.', error: true },
      );
    } catch {
      setTestMessage({ text: "The test couldn't run. Reload this page and try again.", error: true });
    }
  }

  async function onCheckForUpdates() {
    setUpdateMessage('Checking…');
    try {
      const res = await sendToBackground({ type: 'refresh-cards' });
      setUpdateMessage(res.ok ? 'Up to date.' : (res.error ?? 'Could not check for updates.'));
    } catch {
      setUpdateMessage('Could not check for updates.');
    }
    await refreshStatus();
  }

  async function onUpdateIndex() {
    setIndexUpdateMessage(null);
    try {
      const res = await sendToBackground({ type: 'update-index' });
      if (!res.ok) setIndexUpdateMessage(res.error ?? 'Could not start the update.');
    } catch {
      setIndexUpdateMessage('Could not start the update.');
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
        <h1>Options</h1>
      </header>

      <main>
        <Section id="how-to-use" title="How to use">
          <p>
            {scan ? (
              <>
                Press <Keys shortcut={scan} /> on a video or any web page
              </>
            ) : scan === '' ? (
              'Click the Duel Lens icon in the toolbar on a video or any web page'
            ) : (
              'Press the scan shortcut on a video or any web page'
            )}
            . The picture freezes and the cards Duel Lens finds get a gold outline:{' '}
            {settings.display.reveal === 'hover'
              ? 'rest the pointer on one for a quick preview, and click it for the full details'
              : 'click one for its details'}
            . For any other card, or just its artwork, drag a box around it.
          </p>
          <p>
            Duel Lens stays open, so you can read one card after another. <kbd>Esc</kbd> closes a card, and{' '}
            <kbd>Esc</kbd> again or ✕ leaves. <kbd>Space</kbd> or <kbd>K</kbd> resumes the video.
          </p>
          <p>
            <a class="btn" href={WELCOME_PAGE}>
              Open the welcome guide
            </a>
          </p>
        </Section>

        <Section id="shortcuts" title="Keyboard shortcuts">
          <ShortcutList state={shortcuts} />
          <div class="row-actions">
            <button type="button" class="btn" onClick={() => openShortcutsPage()}>
              Change shortcuts
            </button>
            <p class="hint">
              Opens Chrome's page for extension shortcuts. "Not set" means there is none: maybe another extension took
              the keys first, so pick free ones there.
            </p>
          </div>
          <p class="hint">
            On the frozen picture: <kbd>Tab</kbd> moves between the outlined cards, <kbd>Enter</kbd> reads one, and{' '}
            <kbd>Esc</kbd> leaves. <kbd>Space</kbd> or <kbd>K</kbd> resumes the video, as on YouTube.
          </p>
          <p class="hint">
            In the card view: <kbd>Esc</kbd> closes it, <kbd>←</kbd> <kbd>→</kbd> show other matches,{' '}
            <kbd>C</kbd> copies the text, <kbd>S</kbd> keeps the card in the side panel.
          </p>
        </Section>

        <Section id="card-details" title="Show card details">
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
                  {c.value === DEFAULT_SETTINGS.display.reveal ? <span class="hint">(default)</span> : null}
                </label>
                <p class="hint" id={`reveal-${c.value}-help`}>
                  {c.help}
                </p>
              </div>
            ))}
          </div>
        </Section>

        <Section id="ai-check" title="AI check">
          <p>When Duel Lens isn't sure about a card, you can ask Claude, Anthropic's AI, for a second opinion.</p>
          <p class="disclosure">{AI_DISCLOSURE}</p>
          <ul class="facts">
            <li>
              <b>Cost:</b> usually about 1–2 US cents per check with Claude Opus 5, and less than half that with Claude
              Sonnet 5 (<ExternalLink href={ANTHROPIC_PRICING_URL}>Anthropic's prices</ExternalLink>).
            </li>
            <li>
              <b>Your key</b> stays in this browser and is sent only to Anthropic.
            </li>
          </ul>
          <label class="check">
            <input type="checkbox" checked={settings.ai.enabled} onChange={onToggleAi} />
            Offer to ask Claude when a match is unsure
          </label>
          {aiMessage && (
            <p class="message error" role="alert">
              {aiMessage}
            </p>
          )}
          <div class="field">
            <label for="ai-key">Anthropic API key</label>
            <input
              id="ai-key"
              type="password"
              value={settings.ai.apiKey}
              onInput={onApiKeyInput}
              placeholder="sk-ant-..."
              autocomplete="off"
              spellcheck={false}
            />
            <p class="hint">
              <ExternalLink href={ANTHROPIC_KEYS_URL}>Get an API key</ExternalLink> in the Claude Console.
            </p>
          </div>
          <div class="field">
            <label for="ai-model">Model</label>
            <select id="ai-model" value={settings.ai.model} onChange={onModelChange}>
              {MODEL_CHOICES.map((m) => (
                <option key={m.id} value={m.id}>
                  {`${m.name} (${m.note})`}
                </option>
              ))}
            </select>
            {supportsRefusalFallback(settings.ai.model) && (
              <p class="hint">
                If {modelName(settings.ai.model)} declines to answer a check, Anthropic retries it on another Claude model
                (a refusal fallback).
              </p>
            )}
          </div>
          <div class="row-actions">
            <button type="button" class="btn" onClick={onTest}>
              Test
            </button>
            {testMessage ? (
              <p class={`message${testMessage.error ? ' error' : ''}`} role="status">
                {testMessage.text}
              </p>
            ) : (
              <p class="hint">Sends a tiny request with your key to check that it works (usually a fraction of a cent).</p>
            )}
          </div>
        </Section>

        <Section id="data" title="Data">
          <CardDbStatus state={cardDbState(status, statusFailed)} onRetry={onRetryStatus} />
          <div class="sub">
            <h3>Card database</h3>
            <p class="hint">
              The name, type and text of every card, from <ExternalLink href={YGOPRODECK_URL}>YGOPRODeck</ExternalLink>.
              Duel Lens checks it for new cards once a week.
            </p>
            <dl class="kv">
              <dt>Database version</dt>
              <dd>{status?.dbVersion ?? '—'}</dd>
              <dt>Last updated</dt>
              <dd>{formatUpdatedAt(status?.cardsUpdatedAt)}</dd>
              <dt>Cards loaded</dt>
              <dd>{(status?.cardCount ?? 0).toLocaleString()}</dd>
            </dl>
            <div class="row-actions">
              <button type="button" class="btn" onClick={onCheckForUpdates}>
                Check for updates now
              </button>
              {updateMessage && (
                <p class="message" role="status">
                  {updateMessage}
                </p>
              )}
            </div>
          </div>
          <div class="sub">
            <h3>Artwork index</h3>
            {remoteImages ? (
              <>
                <p class="hint">
                  What Duel Lens matches your box against. For cards newer than this version of Duel Lens, it downloads
                  their artwork from YGOPRODeck and adds it to the index on this computer: by itself when new cards appear,
                  or right away with Update now.
                </p>
                <dl class="kv">
                  <dt>Artworks indexed</dt>
                  <dd>{formatArtworksIndexed(bundledArtworkCount, status?.indexDeltaCount)}</dd>
                  <dt>Status</dt>
                  <dd>{formatIndexUpdateState(status?.indexUpdate)}</dd>
                </dl>
                <div class="row-actions">
                  <button type="button" class="btn" onClick={onUpdateIndex} disabled={indexRunning}>
                    {indexRunning ? 'Updating…' : 'Update now'}
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
                <p class="hint">
                  What Duel Lens matches your box against. It comes with Duel Lens, which doesn't download artwork: new
                  cards come with its updates, so a card released after this version may not be recognised until then.
                </p>
                <dl class="kv">
                  <dt>Artworks indexed</dt>
                  <dd>{formatBundledArtworks(bundledArtworkCount, status?.indexDeltaCount)}</dd>
                </dl>
              </>
            )}
          </div>
        </Section>

        {__DUEL_LENS_DEV__ ? <DebugSection saveCrops={settings.debug.saveCrops} onSettings={setSettingsState} /> : null}

        <Section id="about" title="About">
          <p class="about-name">
            <span>Duel Lens</span>
            {version ? <span class="hint">Version {version}</span> : null}
          </p>
          <p>
            Duel Lens recognises cards on this computer, with its own models.{' '}
            {remoteImages ? 'Card data and images come from' : 'Card data comes from'}{' '}
            <ExternalLink href={YGOPRODECK_URL}>YGOPRODeck</ExternalLink>.
          </p>
          {status ? (
            status.consentedAt !== undefined ? (
              <p>
                You agreed on {formatDate(status.consentedAt)}. <a href={CONSENT_PAGE}>What you agreed to</a>
              </p>
            ) : (
              <p>
                You haven't agreed yet: Duel Lens asks before its first scan, and scans stay off until you do.{' '}
                <a href={CONSENT_PAGE}>Review and agree</a>
              </p>
            )
          ) : null}
          <p class="disclaimer">{DISCLAIMER}</p>
          <p class="hint">{ACCURACY}</p>
          <details class="legal">
            <summary>Legal notice</summary>
            <p class="hint">{legalNotice(remoteImages)}</p>
          </details>
          <p class="links">
            <a href={WELCOME_PAGE}>Welcome guide</a>
            <a href={PRIVACY_PAGE} target="_blank" rel="noopener">
              Privacy policy
            </a>
            <a href={LICENCES_PAGE} target="_blank" rel="noopener">
              Licences
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
    setExportMessage(`Exported ${records.length} crop${records.length === 1 ? '' : 's'}.`);
  }

  return (
    <Section id="debug" title="Debug">
      <p class="hint">
        For building a test set: keeps a copy of each box you scan (the last 300) on this computer, with the card it
        turned out to be, so you can export them. Nothing is sent anywhere. Only in developer builds.
      </p>
      <label class="check">
        <input type="checkbox" checked={saveCrops} onChange={onSaveCropsChange} />
        Save crops for a test set
      </label>
      <div class="row-actions">
        <button type="button" class="btn" onClick={onExportTestSet}>
          Export test set (JSON)
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
  if (state.status === 'loading') return <p class="hint">Reading the shortcuts…</p>;
  const commands = state.commands
    .filter((c) => c.name !== '_execute_action' || c.shortcut)
    .sort((a, b) => rank(a) - rank(b));
  return (
    <dl class="kv shortcuts">
      {commands.map((c) => (
        <Fragment key={c.name}>
          <dt>{commandLabel(c)}</dt>
          <dd>
            {c.shortcut ? <Keys shortcut={c.shortcut} /> : <span class="not-set">Not set</span>}
            {state.status === 'fallback' && c.shortcut ? <span class="hint"> (default)</span> : null}
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
