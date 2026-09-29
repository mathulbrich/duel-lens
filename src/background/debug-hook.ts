// E2E-only: installed by index.ts only in E2E builds (see src/build-flags.d.ts), so a store build
// ships none of it. Puppeteer drives the extension's real service worker but cannot press an
// OS-level keyboard shortcut, so the end-to-end test needs another way to trigger exactly what
// `scan-card` does. It needs no extra manifest permission (the E2E build grants <all_urls>
// itself). Not part of the message protocol: it's a direct function call against the worker's
// global scope, reached through a CDP binding in the test.
import { grantConsent } from './consent';
import { startScan } from './scan';

export function installDebugHook(): void {
  (globalThis as { duelLensDebug?: unknown }).duelLensDebug = {
    async startScan(tabId?: number): Promise<void> {
      const tab =
        tabId !== undefined
          ? await chrome.tabs.get(tabId)
          : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab) throw new Error('Duel Lens debug: no active tab found');
      await startScan(tab);
    },
    /**
     * What the welcome page's "Agree and start" does (router 'grant-consent'): without it, every
     * scan opens the consent step instead (scan.ts), and a test browser starts with none.
     */
    async grantConsent(): Promise<void> {
      await grantConsent();
    },
  };
}
