// E2E builds for Firefox only (build.mjs --target firefox --e2e): a content script on the test's local
// board (http://127.0.0.1/*) that relays window.postMessage calls to the event page's debug hook
// (debug-hook.ts). WebDriver BiDi in Firefox can neither open moz-extension:// pages nor evaluate in
// the event page, so test/e2e/firefox.ts reaches the background this way. Never in a store build:
// tools/release.mjs refuses a build whose bundles hold the debug hook, and one with access to every site.
window.addEventListener('message', (e) => {
  const d = e.data as { duelLensE2e?: string; id?: number; fn?: string; args?: unknown[] } | null;
  if (e.source !== window || d?.duelLensE2e !== 'call') return;
  chrome.runtime.sendMessage({ type: 'e2e-debug', fn: d.fn, args: d.args ?? [] }).then(
    (value) => window.postMessage({ duelLensE2e: 'reply', id: d.id, value }, '*'),
    (err: unknown) => window.postMessage({ duelLensE2e: 'reply', id: d.id, error: String(err) }, '*'),
  );
});
