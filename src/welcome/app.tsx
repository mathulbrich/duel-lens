// The welcome page, opened once on install (the service worker's onInstalled): the first-run consent
// (consent.tsx), how to scan in three steps with the shortcut Chrome actually has (with the default
// "Show card details": a hover previews, a click reads, and scan mode stays open until the user
// leaves), an illustration, tips, what stays on the computer and what goes online, and whether the
// card database is ready.
// The legal and privacy wording is the legal workstream's (copy.ts), for this build's image source.
import type { ComponentChildren } from 'preact';
import { LensIcon } from '../content/icons';
import { t } from '../shared/i18n';
import { tRich, tRichKeys, withKeys } from '../shared/i18n-rich';
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
          <a href={OPTIONS_PAGE}>{t('common_options_label')}</a>
        </nav>
      </header>

      <main>
        <section class="hero" aria-labelledby="wl-title">
          <div class="hero-text">
            <p class="eyebrow">{t('welcome_eyebrow')}</p>
            <h1 id="wl-title">{t('welcome_hero_title')}</h1>
            <p class="lede">{noWrapYugioh(t('welcome_hero_lede'))}</p>
            <Start scan={scan} isDefault={shortcuts.status === 'fallback'} />
            {needsConsent ? (
              <p class="hint consent-first">
                {tRich('welcome_consent_first', <a href={`#${CONSENT_ID}`}>{t('welcome_consent_first_link')}</a>)}
              </p>
            ) : null}
            <CardDbStatus state={db.state} onRetry={db.retry} />
          </div>
          <Demo shortcut={scan} />
        </section>

        <ConsentStep state={consent.state} onAgree={consent.agree} scan={scan} remoteImages={remoteImages} />

        <section class="block" aria-labelledby="wl-how">
          <h2 id="wl-how">{t('welcome_how_to_use_heading')}</h2>
          <ol class="steps" aria-label={t('welcome_three_steps_label')}>
            <Step
              n={1}
              title={
                scan
                  ? tRich('common_press_shortcut', <Keys shortcut={scan} />)
                  : scan === ''
                    ? t('welcome_step1_click_icon')
                    : t('common_press_the_shortcut_label')
              }
            >
              <p>{t('welcome_step1_body')}</p>
              <p class="hint">
                {scan === '' ? tRich('welcome_step1_hint_set', <ShortcutsPageLink />) : tRich('welcome_step1_hint_change', <ShortcutsPageLink />)}
              </p>
            </Step>
            <Step n={2} title={t('welcome_step2_title')}>
              <p>{t('welcome_step2_body')}</p>
              <p class="hint">
                {tRich('welcome_step2_hint', <a href={`${OPTIONS_PAGE}#card-details`}>{t('common_options_label')}</a>)}
              </p>
            </Step>
            <Step n={3} title={t('welcome_step3_title')}>
              <p>{t('welcome_step3_body1')}</p>
              <p>{t('welcome_step3_body2')}</p>
              <p>{withKeys(t('welcome_step3_body3'))}</p>
              <p class="hint">
                {panel
                  ? tRichKeys('welcome_step3_hint_with_panel', <Keys shortcut={panel} />)
                  : withKeys(t('welcome_step3_hint_no_panel'))}
              </p>
            </Step>
          </ol>
        </section>

        <section class="block" aria-labelledby="wl-tips">
          <h2 id="wl-tips">{t('welcome_tips_heading')}</h2>
          <ul class="tips">
            <Tip icon={<PauseIcon />} title={t('welcome_tip1_title')}>
              {t('welcome_tip1_body')}
            </Tip>
            <Tip icon={<QualityIcon />} title={t('welcome_tip2_title')}>
              {t('welcome_tip2_body')}
            </Tip>
            <Tip icon={<FrameIcon />} title={t('welcome_tip3_title')}>
              {t('welcome_tip3_body')}
            </Tip>
            <Tip icon={<KeyIcon />} title={t('welcome_tip4_title')}>
              {withKeys(t('welcome_tip4_body'))}
            </Tip>
            <Tip icon={<BlockIcon />} title={t('welcome_tip5_title')}>
              {t('welcome_tip5_body')}
            </Tip>
          </ul>
        </section>

        <section class="block" aria-labelledby="wl-privacy">
          <h2 id="wl-privacy">{t('welcome_privacy_heading')}</h2>
          <div class="privacy">
            <section class="pv" aria-labelledby="pv-local">
              <h3 id="pv-local">{t('welcome_privacy_local_heading')}</h3>
              <Points points={onThisComputer(remoteImages)} />
            </section>
            <section class="pv" aria-labelledby="pv-online">
              <h3 id="pv-online">{t('welcome_privacy_online_heading')}</h3>
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
          <a href={OPTIONS_PAGE}>{t('common_options_label')}</a>
          <a href={PRIVACY_PAGE} target="_blank" rel="noopener">
            {t('common_link_privacy_policy')}
          </a>
          <a href={LICENCES_PAGE} target="_blank" rel="noopener">
            {t('common_link_licences')}
          </a>
          {version ? <span>{t('common_version_label', version)}</span> : null}
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
          {p.before ? <Rich text={p.before} /> : null}
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
        <p class="start-line">{t('welcome_no_shortcut_set')}</p>
        <div class="start-actions">
          <button type="button" class="btn gold" onClick={() => openShortcutsPage()}>
            {t('welcome_set_shortcut_button')}
          </button>
          <span class="hint">{t('welcome_or_click_icon_hint')}</span>
        </div>
      </div>
    );
  }
  return (
    <div class="start">
      <p class="start-line">
        {tRich('welcome_press_to_scan', <Keys shortcut={scan} />)}
        {isDefault ? <span class="hint"> {t('welcome_default_shortcut_hint')}</span> : null}
      </p>
    </div>
  );
}

/** "Yu-Gi-Oh!" kept on one line wherever a sentence names it. */
function noWrapYugioh(text: string): ComponentChildren {
  return text.split(/(Yu-Gi-Oh!)/).map((s, i) => (i % 2 ? <span class="nowrap" key={i}>{s}</span> : s));
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
.hero h1 { font-family: var(--f-name); font-weight: 700; font-size: clamp(34px, 4vw, 48px); line-height: 1.06; letter-spacing: -.005em; text-wrap: balance; word-break: auto-phrase; }
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
