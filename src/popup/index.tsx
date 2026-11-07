import { render } from 'preact';
import { liveCheckDeps, setLiveCheck } from '../background/live-check';
import { openPanel } from '../background/panel';
import { getSettings, setSettings } from '../background/settings';
import { t, uiLang } from '../shared/i18n';
import { sendToBackground } from '../shared/messages';
import { PopupApp, type PopupDeps } from './app';
import { serialWrites } from './writes';

document.documentElement.lang = uiLang();
document.title = t('popup_live_check');

// The window the popup belongs to, read now so a click can open the side panel without an await before it.
let windowId: number | undefined;
void chrome.windows.getCurrent().then((w) => (windowId = w.id), () => undefined);

// The switch and the Speed write one field each, through one queue (writes.ts), so neither puts back the other's.
const write = serialWrites();
const checkDeps = {
  ...liveCheckDeps(async () => undefined), // the popup only flips the setting; the background follows it
  saveCheck: (on: boolean) => write(async () => void (await setSettings({ live: { check: on } }))),
};
const deps: PopupDeps = {
  readCheck: async () => (await getSettings()).live.check,
  setCheck: (on) => setLiveCheck(on, checkDeps),
  readSpeed: async () => (await getSettings()).live.effort,
  // Only the speed is written (never the switch read with it), one write after another in the order picked. A running
  // Live takes it on at once: the background passes setting changes on (live.ts settingsChanged).
  setSpeed: (effort) => write(async () => void (await setSettings({ live: { effort } }))),
  scan: async () => {
    await sendToBackground({ type: 'scan-active-tab' });
  },
  openPanel: () => {
    openPanel({ windowId }).then(
      () => window.close(),
      (err) => console.error('Duel Lens: could not open the panel', err),
    );
  },
  openOptions: () => void chrome.runtime.openOptionsPage(),
  close: () => window.close(),
};

const root = document.getElementById('app');
if (root) render(<PopupApp deps={deps} />, root);
