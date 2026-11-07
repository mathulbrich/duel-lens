import { render } from 'preact';
import { liveCheckDeps, setLiveCheck } from '../background/live-check';
import { openPanel } from '../background/panel';
import { getSettings } from '../background/settings';
import { t, uiLang } from '../shared/i18n';
import { sendToBackground } from '../shared/messages';
import { PopupApp, type PopupDeps } from './app';

document.documentElement.lang = uiLang();
document.title = t('popup_live_check');

// The window the popup belongs to, read now so a click can open the side panel without an await before it.
let windowId: number | undefined;
void chrome.windows.getCurrent().then((w) => (windowId = w.id), () => undefined);

const checkDeps = liveCheckDeps(async () => undefined); // the popup only flips the setting; the background follows it
const deps: PopupDeps = {
  readCheck: async () => (await getSettings()).live.check,
  setCheck: (on) => setLiveCheck(on, checkDeps),
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
