// The welcome page, opened once on install (the service worker's onInstalled): the first-run consent
// (consent.tsx), how to scan in three steps with the shortcut Chrome actually has, an illustration,
// tips, what stays on the computer and what goes online, and whether the card database is ready.
// The legal and privacy wording is the legal workstream's (copy.ts), for this build's image source.
import type { ComponentChildren } from 'preact';
import { LensIcon } from '../content/icons';
import { CONSENT_CSS, CONSENT_ID, ConsentStep, useConsent } from './consent';
import { attribution, legalNotice, onThisComputer, online, type Point } from './copy';
import { DEMO_CSS, Demo } from './demo';
import { DISCLAIMER, LICENCES_PAGE, OPTIONS_PAGE, PRIVACY_PAGE, manifestVersion } from './links';
import { Rich } from './markdown';
import { Keys, ShortcutsPageLink, openShortcutsPage, shortcutOf, useShortcuts } from './shortcuts';
import { CardDbStatus, useCardDb } from './status';
import { PAGE_CSS } from './theme';

export function Welcome() {
  const shortcuts = useShortcuts();
  const db = useCardDb();
  const consent = useConsent();
  const scan = shortcutOf(shortcuts, 'scan-card');
  const panel = shortcutOf(shortcuts, 'open-panel');
  const version = manifestVersion();
  const remoteImages = __DUEL_LENS_REMOTE_IMAGES__;
  const needsConsent = consent.state.kind === 'needed' || consent.state.kind === 'saving' || consent.state.kind === 'failed';

  return (
    <div class="wl">
      <style>{PAGE_CSS + DEMO_CSS + CONSENT_CSS + WELCOME_CSS}</style>
      <header class="wl-top">
        <span class="brand">
          <LensIcon />
          Duel Lens
        </span>
        <nav aria-label="Duel Lens">
          <a href={OPTIONS_PAGE}>Options</a>
        </nav>
      </header>

      <main>
        <section class="hero" aria-labelledby="wl-title">
          <div class="hero-text">
            <p class="eyebrow">Welcome to Duel Lens</p>
            <h1 id="wl-title">Read any card in a duel video</h1>
            <p class="lede">
              A card reader for the <span class="nowrap">Yu-Gi-Oh!</span> TRADING CARD GAME. Pause a duel on YouTube, or
              open any page with cards on it. Box a card, and its name, type and full text appear right beside it.
            </p>
            <Start scan={scan} isDefault={shortcuts.status === 'fallback'} />
            {needsConsent ? (
              <p class="hint consent-first">
                First, <a href={`#${CONSENT_ID}`}>agree to how Duel Lens handles your data</a>: it asks before its first
                scan.
              </p>
            ) : null}
            <CardDbStatus state={db.state} onRetry={db.retry} />
          </div>
          <Demo shortcut={scan} />
        </section>

        <ConsentStep state={consent.state} onAgree={consent.agree} scan={scan} remoteImages={remoteImages} />

        <section class="block" aria-labelledby="wl-how">
          <h2 id="wl-how">How to use it</h2>
          <ol class="steps" aria-label="Three steps">
            <Step
              n={1}
              title={
                scan ? (
                  <>
                    Press <Keys shortcut={scan} />
                  </>
                ) : scan === '' ? (
                  'Click the Duel Lens icon'
                ) : (
                  'Press the shortcut'
                )
              }
            >
              <p>On a YouTube video or any web page. The picture freezes, so you can take your time.</p>
              <p class="hint">
                {scan === '' ? 'Or set a shortcut at ' : 'Change it at '}
                <ShortcutsPageLink />
              </p>
            </Step>
            <Step n={2} title="Pick the card">
              <p>
                Click a card with a gold outline. For a card without one, or just its artwork, drag a box around it.
              </p>
            </Step>
            <Step n={3} title="Read it">
              <p>
                Its name, type and text appear beside the card. If Duel Lens isn't sure, it offers the other likely cards
                to pick from.
              </p>
              <p class="hint">
                Press <kbd>K</kbd> to keep the card in the side panel
                {panel ? (
                  <>
                    {' '}
                    (open it with <Keys shortcut={panel} />)
                  </>
                ) : null}
                . <kbd>Esc</kbd> closes.
              </p>
            </Step>
          </ol>
        </section>

        <section class="block" aria-labelledby="wl-tips">
          <h2 id="wl-tips">Tips for a good match</h2>
          <ul class="tips">
            <Tip icon={<PauseIcon />} title="Pause on a clear frame">
              Pause, or scrub to a moment where the card is sharp and in full view. Motion blur and fades make matching
              harder.
            </Tip>
            <Tip icon={<QualityIcon />} title="Watch in 720p or higher">
              Pick it in the video's quality menu. At 480p and below, small cards are often too blurry to tell apart.
            </Tip>
            <Tip icon={<FrameIcon />} title="Drawing a box? Whole card or just the art">
              Either works. Keep the box snug; a little space around the card is fine.
            </Tip>
            <Tip icon={<KeyIcon />} title="Keys in the card view">
              <kbd>Esc</kbd> closes, <kbd>←</kbd> <kbd>→</kbd> show the other matches, <kbd>C</kbd> copies the card's
              text.
            </Tip>
            <Tip icon={<BlockIcon />} title="Not on Chrome's own pages">
              Chrome doesn't let extensions read pages like this one, other chrome:// pages or the Chrome Web Store.
              Try it on a video.
            </Tip>
          </ul>
        </section>

        <section class="block" aria-labelledby="wl-privacy">
          <h2 id="wl-privacy">What stays on your computer, and what goes online</h2>
          <div class="privacy">
            <section class="pv" aria-labelledby="pv-local">
              <h3 id="pv-local">On this computer</h3>
              <Points points={onThisComputer(remoteImages)} />
            </section>
            <section class="pv" aria-labelledby="pv-online">
              <h3 id="pv-online">Online</h3>
              <Points points={online(remoteImages)} />
            </section>
          </div>
        </section>
      </main>

      <footer class="wl-foot">
        <p class="disclaimer">{DISCLAIMER}</p>
        <p>
          <Rich text={attribution(remoteImages)} />
        </p>
        <p class="foot-links">
          <a href={OPTIONS_PAGE}>Options</a>
          <a href={PRIVACY_PAGE} target="_blank" rel="noopener">
            Privacy policy
          </a>
          <a href={LICENCES_PAGE} target="_blank" rel="noopener">
            Licences
          </a>
          {version ? <span>Version {version}</span> : null}
        </p>
        <p class="legal-notice">{legalNotice(remoteImages)}</p>
      </footer>
    </div>
  );
}

/** A list of points with bold leads (copy.ts). */
function Points({ points }: { points: Point[] }) {
  return (
    <ul>
      {points.map((p) => (
        <li key={p.lead}>
          <b>{p.lead}</b>
          <Rich text={p.rest} />
        </li>
      ))}
    </ul>
  );
}

/** The hero's call to action: the live scan shortcut, or how to get one when none is set. */
function Start({ scan, isDefault }: { scan: string | null; isDefault: boolean }) {
  if (scan === null) return <div class="start" />;
  if (scan === '') {
    return (
      <div class="start">
        <p class="start-line">No shortcut is set for scanning yet.</p>
        <div class="start-actions">
          <button type="button" class="btn gold" onClick={() => openShortcutsPage()}>
            Set a shortcut
          </button>
          <span class="hint">or click the Duel Lens icon in the toolbar (pin it from the puzzle-piece menu).</span>
        </div>
      </div>
    );
  }
  return (
    <div class="start">
      <p class="start-line">
        Press <Keys shortcut={scan} /> to scan a card
        {isDefault ? <span class="hint"> (the default shortcut)</span> : null}
      </p>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: ComponentChildren; children: ComponentChildren }) {
  return (
    <li class="step">
      <span class="step-n" aria-hidden="true">
        {n}
      </span>
      <h3>{title}</h3>
      {children}
    </li>
  );
}

function Tip({ icon, title, children }: { icon: ComponentChildren; title: string; children: ComponentChildren }) {
  return (
    <li class="tip">
      <span class="tip-icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
    </li>
  );
}

function Icon({ children }: { children: ComponentChildren }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      {children}
    </svg>
  );
}
const PauseIcon = () => (
  <Icon>
    <rect x="6.5" y="5" width="3.6" height="14" rx="1" />
    <rect x="13.9" y="5" width="3.6" height="14" rx="1" />
  </Icon>
);
const QualityIcon = () => (
  <Icon>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M7.5 9.5v5M7.5 12h3M10.5 9.5v5M13.5 9.5v5h1.6a2.5 2.5 0 0 0 0-5z" />
  </Icon>
);
const FrameIcon = () => (
  <Icon>
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
    <rect x="9" y="7.5" width="6" height="9" rx="1" />
  </Icon>
);
const KeyIcon = () => (
  <Icon>
    <rect x="3" y="6" width="18" height="12" rx="2.5" />
    <path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" />
  </Icon>
);
const BlockIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M6 6l12 12" />
  </Icon>
);

const WELCOME_CSS = /* css */ `
.wl { max-width: 1140px; margin: 0 auto; padding: 22px 32px 40px; }
.wl-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 6px 0 12px; }
.wl-top nav { display: flex; gap: 20px; font-size: 14px; font-weight: 600; }

.hero { display: grid; grid-template-columns: minmax(0, .92fr) minmax(0, 1.08fr); gap: 56px; align-items: center; padding: 40px 0 64px; }
.hero-text { display: grid; gap: 18px; justify-items: start; align-content: center; }
.hero h1 { font-family: var(--f-name); font-weight: 700; font-size: clamp(34px, 4vw, 48px); line-height: 1.06; letter-spacing: -.005em; text-wrap: balance; }
.nowrap { white-space: nowrap; }
.lede { font-size: 17.5px; line-height: 1.55; color: var(--ink-2); max-width: 32em; }
.start { display: grid; gap: 10px; margin-top: 6px; }
.start:empty { min-height: 40px; }
.start-line { font-size: 18px; font-weight: 550; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.start-line kbd.combo { font-size: 17px; }
.start-line kbd.combo kbd { padding: .3em .6em .26em; }
.start-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; }

.block { padding: 52px 0; border-top: 1px solid var(--line); }
.block > h2 { font-weight: 720; font-stretch: 88%; font-size: 27px; line-height: 1.2; letter-spacing: -.01em; }

.steps { list-style: none; margin-top: 24px; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.step { position: relative; display: grid; gap: 10px; align-content: start; padding: 22px 22px 24px; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); }
.step-n { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: var(--gold); color: var(--gold-ink); font-weight: 750; font-size: 15px; }
.step h3 { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 19px; font-weight: 700; font-stretch: 92%; line-height: 1.3; }
.step h3 kbd.combo { font-size: 15px; }
.step p { color: var(--ink-2); }
.step .hint { margin-top: 2px; }

.tips { list-style: none; margin-top: 24px; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px 32px; }
.tip { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 14px; align-items: start; padding: 10px 0; }
.tip-icon { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 10px; background: var(--surface); border: 1px solid var(--line); color: var(--accent); }
.tip-icon svg { width: 22px; height: 22px; }
.tip h3 { font-size: 16px; font-weight: 700; line-height: 1.35; margin-bottom: 3px; }
.tip p { color: var(--ink-2); font-size: 14.5px; }

.privacy { margin-top: 24px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.pv { padding: 22px 24px; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); }
.pv h3 { font-size: 13px; font-weight: 700; font-stretch: 80%; text-transform: uppercase; letter-spacing: .12em; color: var(--accent); margin-bottom: 12px; }
.pv ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 12px; }
.pv li { position: relative; padding-left: 18px; color: var(--ink-2); font-size: 14.5px; }
.pv li::before { content: ""; position: absolute; left: 2px; top: .62em; width: 6px; height: 6px; border-radius: 50%; background: var(--gold); }
.pv li b { color: var(--ink); font-weight: 650; }

.wl-foot { display: grid; gap: 6px; padding: 28px 0 8px; border-top: 1px solid var(--line); font-size: 13px; color: var(--ink-2); }
.wl-foot .disclaimer { color: var(--ink); font-weight: 550; }
.foot-links { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 6px; }
.wl-foot .legal-notice { margin-top: 8px; font-size: 11.5px; line-height: 1.5; max-width: 80em; }
.consent-first { margin-top: -4px; }

@media (max-width: 900px) {
  .wl { padding: 18px 20px 32px; }
  .hero { grid-template-columns: minmax(0, 1fr); gap: 36px; padding: 24px 0 48px; }
  .steps, .privacy { grid-template-columns: minmax(0, 1fr); }
}
`;
