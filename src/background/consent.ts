// The first-run consent the Chrome Web Store requires before the first scan: when the user agreed
// on the welcome page (router 'grant-consent'). Kept in chrome.storage.local, which only extension
// pages and the service worker can read (index.ts restricts it).

const CONSENT_KEY = 'consentedAt';

export async function getConsent(): Promise<number | undefined> {
  const stored = await chrome.storage.local.get(CONSENT_KEY);
  const at = stored[CONSENT_KEY];
  return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
}

export async function grantConsent(now: number = Date.now()): Promise<void> {
  await chrome.storage.local.set({ [CONSENT_KEY]: now });
}
