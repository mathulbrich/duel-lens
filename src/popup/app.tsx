// The toolbar icon's popup (spec D-L14): "Scan this page", the Live check switch and its Speed (three dots: the
// setting live.effort, LIVE_EFFORT_ORDER), "Cards found" (the side panel) and Options. The switch is the setting live.check; turning it on asks for every site in the click's own gesture
// (live-check.ts setLiveCheck), and the background makes the browser follow the setting.
import { useEffect, useRef, useState } from 'preact/hooks';
import { t, type MessageKey } from '../shared/i18n';
import { LIVE_EFFORT_ORDER, type LiveEffort } from '../shared/live';
import type { LiveCheckResult } from '../background/live-check';
import { PAGE_CSS } from '../welcome/theme';

export interface PopupDeps {
  /** The switch's state now (the setting). */
  readCheck: () => Promise<boolean>;
  /** The switch flipped by the click (setLiveCheck): asks for every site first when turning on. */
  setCheck: (on: boolean) => Promise<LiveCheckResult>;
  /** Live's Speed now, and the one picked (the setting live.effort). */
  readSpeed: () => Promise<LiveEffort>;
  setSpeed: (speed: LiveEffort) => Promise<void>;
  scan: () => Promise<void>;
  /** Opens the side panel (Firefox: the sidebar), in the click's gesture. */
  openPanel: () => void;
  openOptions: () => void;
  close: () => void;
}

/** Each Speed's name and its one line of help, as Options shows them. */
const SPEEDS: Record<LiveEffort, { label: MessageKey; help: MessageKey }> = {
  light: { label: 'options_live_effort_light', help: 'options_live_effort_light_hint' },
  balanced: { label: 'options_live_effort_balanced', help: 'options_live_effort_balanced_hint' },
  best: { label: 'options_live_effort_best', help: 'options_live_effort_best_hint' },
};

export function PopupApp({ deps }: { deps: PopupDeps }) {
  const [check, setCheck] = useState<boolean | null>(null);
  const [speed, setSpeed] = useState<LiveEffort | null>(null);
  const [note, setNote] = useState('');
  /** The speed last saved, and which pick is the latest: only the latest one's failure shows, going back to the saved. */
  const saved = useRef<LiveEffort | null>(null);
  const picks = useRef(0);
  useEffect(() => {
    deps.readCheck().then(setCheck, () => setCheck(false));
    deps.readSpeed().then(
      (s) => {
        saved.current = s;
        setSpeed(s);
      },
      () => setSpeed('balanced'),
    );
  }, [deps]);

  const pick = (next: LiveEffort) => {
    const mine = ++picks.current;
    setSpeed(next);
    void deps.setSpeed(next).then(
      () => void (saved.current = next),
      () => {
        if (mine !== picks.current) return; // a later pick stands
        setSpeed(saved.current);
        setNote(t('popup_live_failed'));
      },
    );
  };

  const flip = () => {
    if (check === null) return;
    const want = !check;
    setNote('');
    // No await before setCheck: turning on asks the browser for every site, which needs this click's gesture.
    void deps.setCheck(want).then(
      (r) => {
        setCheck(r.on);
        if (r.reason === 'no-permission') setNote(t('popup_live_no_permission'));
        if (r.reason === 'no-consent') setNote(t('popup_live_no_consent'));
      },
      () => setNote(t('popup_live_failed')),
    );
  };

  return (
    <main class="pp">
      <style>{PAGE_CSS + POPUP_CSS}</style>
      <header class="pp-head">Duel Lens</header>
      <button
        type="button"
        class="pp-scan"
        onClick={() =>
          void deps.scan().finally(() => deps.close())
        }
      >
        {t('popup_scan')}
      </button>
      <div class="pp-row">
        <div class="pp-label">
          <span id="pp-check">{t('popup_live_check')}</span>
          <span class="pp-hint">{t('popup_live_check_hint')}</span>
        </div>
        <button type="button" role="switch" class="pp-switch" aria-checked={check === true} aria-labelledby="pp-check" disabled={check === null} onClick={flip} />
      </div>
      <div class="pp-speed" role="radiogroup" aria-labelledby="pp-speed">
        <span id="pp-speed" class="pp-speed-title">
          {t('popup_speed')}
        </span>
        <div class="pp-dots">
          {LIVE_EFFORT_ORDER.map((e) => (
            <label class="pp-dot" key={e}>
              <input type="radio" name="pp-speed" value={e} checked={speed === e} disabled={speed === null} onChange={() => pick(e)} />
              <span class="pp-dot-mark" aria-hidden="true" />
              {t(SPEEDS[e].label)}
            </label>
          ))}
        </div>
        <span class="pp-hint">{speed ? t(SPEEDS[speed].help) : ''}</span>
      </div>
      {note ? (
        <p class="pp-note" role="status">
          {note}
        </p>
      ) : null}
      <nav class="pp-links">
        <button type="button" class="pp-link" onClick={() => deps.openPanel()}>
          {t('popup_cards_found')}
        </button>
        <button
          type="button"
          class="pp-link"
          onClick={() => {
            deps.openOptions();
            deps.close();
          }}
        >
          {t('popup_options')}
        </button>
      </nav>
    </main>
  );
}

const POPUP_CSS = /* css */ `
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--f-ui); font-size: 14px; }
.pp { width: 280px; box-sizing: border-box; padding: 14px 16px; display: grid; gap: 12px; }
.pp-head { font-family: var(--f-name); font-weight: 700; font-size: 16px; }
.pp-scan { font: inherit; font-weight: 600; padding: 9px 12px; border: 0; border-radius: 8px; background: var(--gold); color: var(--gold-ink); cursor: pointer; }
.pp-scan:hover { background: var(--gold-hover); }
.pp-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
.pp-label { display: grid; gap: 2px; }
.pp-hint { color: var(--ink-2); font-size: 12px; line-height: 1.35; }
.pp-switch { flex: none; position: relative; width: 38px; height: 22px; border-radius: 11px; border: 1px solid var(--line-strong); background: var(--surface-2); cursor: pointer; padding: 0; }
.pp-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--ink-2); transition: left .15s; }
.pp-switch[aria-checked="true"] { background: var(--gold); border-color: var(--gold); }
.pp-switch[aria-checked="true"]::after { left: 18px; background: var(--gold-ink); }
.pp-switch:disabled { opacity: .5; cursor: default; }
.pp-switch:focus-visible, .pp-scan:focus-visible, .pp-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.pp-note { margin: 0; color: var(--err); font-size: 12px; }
.pp-speed { display: grid; gap: 8px; }
.pp-speed-title { font-weight: 600; font-size: 13px; }
.pp-dots { display: grid; grid-template-columns: repeat(3, 1fr); position: relative; }
.pp-dots::before { content: ""; position: absolute; left: 16.6%; right: 16.6%; top: 7px; height: 2px; background: var(--line-strong); }
.pp-dot { position: relative; display: grid; justify-items: center; gap: 4px; font-size: 12px; color: var(--ink-2); cursor: pointer; }
.pp-dot input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; }
.pp-dot-mark { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--ink-2); background: var(--bg); }
.pp-dot input:checked + .pp-dot-mark { border-color: var(--gold); background: var(--gold); box-shadow: 0 0 0 3px color-mix(in srgb, var(--gold) 30%, transparent); }
.pp-dot:has(input:checked) { color: var(--ink); font-weight: 600; }
.pp-dot input:focus-visible + .pp-dot-mark { outline: 2px solid var(--accent); outline-offset: 2px; }
.pp-dot:has(input:disabled) { cursor: default; opacity: .5; }
.pp-links { display: flex; justify-content: space-between; padding-top: 10px; border-top: 1px solid var(--line); }
.pp-link { font: inherit; font-size: 13px; background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; }
.pp-link:hover { text-decoration: underline; }
`;
