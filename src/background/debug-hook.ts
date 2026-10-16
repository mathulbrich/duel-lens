// E2E-only: installed by index.ts only in E2E builds (see src/build-flags.d.ts), so a store build
// ships none of it. Puppeteer drives the extension's real service worker but cannot press an
// OS-level keyboard shortcut, so the end-to-end test needs another way to trigger exactly what
// `scan-card` does. It needs no extra manifest permission (the E2E build grants <all_urls>
// itself). Not part of the message protocol: it's a direct function call against the worker's
// global scope, reached through a CDP binding in the test.
//
// Firefox (build.mjs --target firefox --e2e): WebDriver BiDi can't reach the event page, so the test's
// board relays calls through a content script (e2e-bridge.ts) as 'e2e-debug' messages, answered here by
// name; a few more functions exist for test/e2e/firefox.ts (firefoxHooks below).
import { grantConsent } from './consent';
import { runIndexUpdate } from './index-update';
import { warmupOffscreen } from './offscreen-client';
import { openPanel } from './panel';
import { startScan } from './scan';

type Hook = Record<string, (...args: unknown[]) => unknown>;

/** When this event page started: a new value after Firefox suspended it and an event woke it again. */
const bootedAt = Date.now();

export function installDebugHook(): void {
  if (__DUEL_LENS_FIREFOX__) installFirefoxBridge();
  (globalThis as { duelLensDebug?: unknown }).duelLensDebug = {
    ...(__DUEL_LENS_FIREFOX__ ? firefoxHooks() : {}),
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

/** Answers the board's bridge (e2e-bridge.ts): { fn, args } calls duelLensDebug[fn](...args). */
function installFirefoxBridge(): void {
  chrome.runtime.onMessage.addListener((msg: { type?: string; fn?: string; args?: unknown[] }, sender, sendResponse) => {
    if (msg?.type !== 'e2e-debug' || sender.id !== chrome.runtime.id) return false;
    const hook = (globalThis as unknown as { duelLensDebug: Hook }).duelLensDebug;
    // startScan() with no tab: the board's own tab (the bridge's sender), as the shortcut would scan it.
    const args = msg.fn === 'startScan' && !msg.args?.length ? [sender.tab?.id] : (msg.args ?? []);
    Promise.resolve()
      .then(() => {
        const fn = hook[msg.fn ?? ''];
        if (typeof fn !== 'function') throw new Error(`no debug hook "${msg.fn}"`);
        return fn(...args);
      })
      .then(
        (value) => sendResponse({ ok: true, value }),
        (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) }),
      );
    return true;
  });
}

/** What test/e2e/firefox.ts asks the event page beyond the Chrome test's hooks. */
function firefoxHooks(): Hook {
  const browserNs = () => (globalThis as unknown as { browser: { sidebarAction: { isOpen(o: object): Promise<boolean> } } }).browser;
  return {
    warmup: () => warmupOffscreen(),
    /** When this event page started (bootedAt): it changes when Firefox suspended it in between. */
    bootedAt: () => bootedAt,
    /** The engine's requests so far in this event page (offscreen-client.ts, E2E builds): type, time, timings. */
    engineLog: () => (globalThis as { __duelLensEngineLog?: unknown[] }).__duelLensEngineLog ?? [],
    openPanel: () => openPanel({}),
    sidebarIsOpen: () => browserNs().sidebarAction.isOpen({}),
    panelContexts: async () => (await chrome.runtime.getContexts({})).map((x) => `${x.contextType} ${x.documentUrl ?? ''}`),
    /** What the event page can use: isolation (WASM threads), WebGPU and its adapter. */
    async environment(): Promise<unknown> {
      const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      return {
        crossOriginIsolated: globalThis.crossOriginIsolated === true,
        sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
        gpu: !!gpu,
        adapter: gpu ? !!(await gpu.requestAdapter().catch(() => null)) : false,
        setAccessLevel: typeof chrome.storage.local.setAccessLevel === 'function',
        href: location.href,
      };
    },
    /**
     * A self-updating-index run as long as a real one, on the board's own images (`imageUrl(i)`): `n`
     * artworks the index lacks, downloaded at the real rate and embedded in the real chunks by the
     * in-page engine. Started and left to run: no message keeps the event page awake meanwhile, as for a
     * run an alarm started. Its progress is kept in storage.session (soakProgress) under this page's
     * bootedAt, so the test sees whether the page was suspended mid-run.
     */
    soakIndexUpdate(n: unknown, urlBase: unknown): string {
      const count = Number(n);
      const base = String(urlBase);
      const ids = Array.from({ length: count }, (_, i) => ({ imageId: 990_000_000 + i, cardId: 990_000_000 + i }));
      const progress = (p: Record<string, unknown>) => chrome.storage.session.set({ e2eSoak: { bootedAt, at: Date.now(), ...p } });
      let fetched = 0;
      void progress({ state: 'running', fetched })
        .then(() =>
          runIndexUpdate({
            getAllImageIds: async () => ids,
            indexMissing: async (imageIds) => ({ missing: imageIds }),
            embedArtworks: async (items) => {
              const res = await (await import('./offscreen-client')).embedArtworks(items);
              await progress({ state: 'running', fetched, embedded: items.length });
              return res;
            },
            fetchFn: async (_url) => {
              fetched++;
              return fetch(`${base}${fetched % 8}`);
            },
            now: () => Date.now(),
            storage: { get: (key) => chrome.storage.session.get(key), set: (items) => chrome.storage.session.set(items) },
          }),
        )
        .then(
          () => progress({ state: 'done', fetched }),
          (e: unknown) => progress({ state: 'failed', fetched, error: String(e) }),
        );
      return 'started';
    },
    soakProgress: async () => (await chrome.storage.session.get('e2eSoak')).e2eSoak ?? null,
    /**
     * SECURE-STORE's question: does the side panel in a private window see the event page's IndexedDB
     * (duel-lens-private), or a separate one? Opens sidepanel.html in a private window, and lists the keys
     * each extension page (this event page included) sees in that database.
     */
    async privateWindowProbe(): Promise<unknown> {
      const allowed = await chrome.extension.isAllowedIncognitoAccess();
      if (!allowed) return { allowed };
      const keys = (w: Window) =>
        new Promise<string[] | string>((resolve) => {
          const open = w.indexedDB.open('duel-lens-private');
          open.onupgradeneeded = () => open.transaction?.abort(); // never create it
          open.onerror = () => resolve(`not there (${open.error?.name})`);
          open.onsuccess = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains('kv')) return resolve('no kv store');
            const all = db.transaction('kv').objectStore('kv').getAllKeys();
            all.onsuccess = () => {
              resolve(all.result.map(String));
              db.close();
            };
          };
        });
      const win = await chrome.windows.create({ incognito: true, url: chrome.runtime.getURL('sidepanel.html') });
      await new Promise((r) => setTimeout(r, 2500));
      const views = chrome.extension.getViews({}) as Window[];
      const pages = [];
      for (const v of views) {
        const incognito = (v as unknown as { chrome: typeof chrome }).chrome?.extension?.inIncognitoContext;
        pages.push({ url: v.location.href.replace(/^moz-extension:\/\/[^/]+/, ''), incognito, keys: await keys(v) });
      }
      if (win?.id !== undefined) await chrome.windows.remove(win.id);
      return { allowed, pages };
    },
  };
}
