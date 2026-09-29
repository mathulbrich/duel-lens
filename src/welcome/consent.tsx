// The first-run consent on the welcome page: the Chrome Web Store requires a prominent disclosure and
// the user's own "Agree" before Duel Lens first handles their data (legal-audit.md B4; the text is
// docs/release/disclaimers.md §4a, in copy.ts). Until then the shortcut opens this step
// (welcome.html#consent, src/background/scan.ts) instead of scanning.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { getConsent } from '../background/consent';
import { sendToBackground } from '../shared/messages';
import { CONSENT, consentPoints } from './copy';
import { PRIVACY_PAGE } from './links';
import { Rich } from './markdown';
import { Keys } from './shortcuts';

/** The consent step of welcome.html. */
export const CONSENT_ID = 'consent';

export type ConsentState =
  | { kind: 'checking' }
  | { kind: 'needed' }
  | { kind: 'saving' }
  | { kind: 'failed'; message: string }
  /** `justNow`: agreed on this visit of the page (it then says what to do next). */
  | { kind: 'agreed'; at: number; justNow: boolean };

/** The consent as stored (chrome.storage.local, which this extension page may read), and agreeing to it. */
export function useConsent(): { state: ConsentState; agree(): void } {
  const [state, setState] = useState<ConsentState>({ kind: 'checking' });
  useEffect(() => {
    getConsent().then(
      (at) => setState((s) => (s.kind === 'checking' ? (at === undefined ? { kind: 'needed' } : { kind: 'agreed', at, justNow: false }) : s)),
      () => setState((s) => (s.kind === 'checking' ? { kind: 'needed' } : s)),
    );
  }, []);
  const agree = useCallback(() => {
    setState({ kind: 'saving' });
    sendToBackground({ type: 'grant-consent' }).then(
      (res) =>
        setState(
          res?.ok ? { kind: 'agreed', at: Date.now(), justNow: true } : { kind: 'failed', message: res?.error || 'Duel Lens did not answer' },
        ),
      () => setState({ kind: 'failed', message: 'Duel Lens could not be reached. Reload this page' }),
    );
  }, []);
  return { state, agree };
}

/** Whether the page was opened at the consent step (a scan before agreeing), following later jumps. */
function useAskedByScan(): boolean {
  const [asked, setAsked] = useState(() => location.hash === `#${CONSENT_ID}`);
  useEffect(() => {
    const onHash = () => setAsked(location.hash === `#${CONSENT_ID}`);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return asked;
}

/** "Not now": close this tab (a page may only close a tab it opened itself, so ask Chrome). */
function closePage() {
  chrome.tabs
    .getCurrent()
    .then((tab) => (tab?.id !== undefined ? chrome.tabs.remove(tab.id) : window.close()))
    .catch(() => window.close());
}

const formatDate = (at: number) => new Date(at).toLocaleDateString(undefined, { dateStyle: 'long' });

export function ConsentStep({ state, onAgree, scan, remoteImages }: { state: ConsentState; onAgree(): void; scan: string | null; remoteImages: boolean }) {
  const asked = useAskedByScan();
  const ref = useRef<HTMLElement>(null);
  const agreed = state.kind === 'agreed';

  // Opened by a scan before agreeing: bring the step into view and focus, so it's the first thing read.
  useEffect(() => {
    if (!asked || state.kind === 'checking') return;
    ref.current?.scrollIntoView?.({ block: 'start' });
    ref.current?.focus({ preventScroll: true });
  }, [asked, state.kind === 'checking']);

  const heading = agreed && !state.justNow ? 'What Duel Lens handles' : asked && !agreed ? CONSENT.headingAfterScan : CONSENT.heading;
  return (
    <section id={CONSENT_ID} ref={ref} tabIndex={-1} class={`consent${asked && !agreed ? ' asked' : ''}${agreed ? ' agreed' : ''}`} aria-labelledby="consent-title">
      <h2 id="consent-title">{heading}</h2>
      <p class="consent-intro">{CONSENT.intro}</p>
      <ul class="consent-points">
        {consentPoints(remoteImages).map((p) => (
          <li key={p.lead}>
            <b>{p.lead}</b>
            <Rich text={p.rest} />
          </li>
        ))}
      </ul>
      {state.kind === 'agreed' ? (
        <p class="consent-done" role="status">
          {state.justNow ? (
            scan ? (
              <>
                You're all set: press <Keys shortcut={scan} /> on a video.
              </>
            ) : (
              "You're all set: click the Duel Lens icon on a video."
            )
          ) : (
            `You agreed on ${formatDate(state.at)}.`
          )}
        </p>
      ) : state.kind === 'checking' ? null : (
        <>
          <div class="consent-actions">
            <button type="button" class="btn gold" onClick={onAgree} disabled={state.kind === 'saving'}>
              {CONSENT.agree}
            </button>
            <button type="button" class="btn" onClick={closePage}>
              {CONSENT.notNow}
            </button>
          </div>
          {state.kind === 'failed' ? (
            <p class="consent-error" role="alert">
              Couldn't save your answer ({state.message}). Try again.
            </p>
          ) : null}
          <p class="hint">
            <a href={PRIVACY_PAGE} target="_blank" rel="noopener">
              {CONSENT.privacy}
            </a>
          </p>
        </>
      )}
    </section>
  );
}

export const CONSENT_CSS = /* css */ `
.consent { display: grid; gap: 14px; margin: 0 0 44px; padding: 26px 28px 24px; background: var(--surface); border: 1px solid var(--line); border-top: 3px solid var(--gold); border-radius: 14px; box-shadow: var(--shadow); scroll-margin-top: 16px; }
.consent:focus { outline: none; }
.consent:focus-visible, .consent.asked { box-shadow: 0 0 0 3px color-mix(in srgb, var(--gold) 45%, transparent), var(--shadow); }
.consent > h2 { font-weight: 720; font-stretch: 88%; font-size: 24px; line-height: 1.2; }
.consent-intro { font-weight: 600; }
.consent-points { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px; }
.consent-points li { position: relative; padding-left: 18px; color: var(--ink-2); font-size: 14.5px; max-width: 62em; }
.consent-points li::before { content: ""; position: absolute; left: 2px; top: .62em; width: 6px; height: 6px; border-radius: 50%; background: var(--gold); }
.consent-points li b { color: var(--ink); font-weight: 650; }
.consent-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 4px; }
.consent-done { font-size: 17px; font-weight: 600; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.consent.agreed .consent-done { color: var(--ok); }
.consent-done kbd.combo { color: var(--ink); }
.consent-error { color: var(--err); font-size: 14px; }
@media (max-width: 560px) { .consent { padding: 20px 18px; } }
`;
