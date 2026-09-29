// Who may send what (security review M2 and L3): the sender classification and the background's
// per-message allowlist, both pure.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKGROUND_SENDERS, backgroundAccepts, senderKind, type ToBackground } from './messages';

const SELF = { id: 'duellensid', baseUrl: 'chrome-extension://duellensid/' };
const page = (file: string) => `chrome-extension://duellensid/${file}`;
const TAB = { id: 7, windowId: 1 } as chrome.tabs.Tab;

describe('senderKind', () => {
  it("classifies Duel Lens's own pages and service worker by URL, with or without a tab", () => {
    expect(senderKind({ id: SELF.id, url: page('background.js') }, SELF)).toBe('extension-page');
    expect(senderKind({ id: SELF.id, url: page('sidepanel.html') }, SELF)).toBe('extension-page');
    // The options and welcome pages opened in a tab DO have sender.tab: the URL decides, not the tab.
    expect(senderKind({ id: SELF.id, url: page('options.html'), tab: TAB }, SELF)).toBe('extension-page');
    expect(senderKind({ id: SELF.id, url: page('welcome.html#consent'), tab: TAB }, SELF)).toBe('extension-page');
  });

  it('classifies anything else from our id as a content script (a web page)', () => {
    expect(senderKind({ id: SELF.id, url: 'https://www.youtube.com/watch?v=abc', tab: TAB }, SELF)).toBe('content-script');
    // No URL at all: the least trusted kind that still has our id.
    expect(senderKind({ id: SELF.id }, SELF)).toBe('content-script');
    // Another extension's page, even one whose id starts with ours, is not under our base URL.
    expect(senderKind({ id: SELF.id, url: 'chrome-extension://duellensidX/options.html' }, SELF)).toBe('content-script');
    // A page whose URL merely contains our base URL.
    expect(senderKind({ id: SELF.id, url: `https://evil.example/?${page('options.html')}` }, SELF)).toBe('content-script');
  });

  it('classifies other extensions, and senders without an id, as foreign', () => {
    expect(senderKind({ id: 'otherextension', url: 'chrome-extension://otherextension/bg.js' }, SELF)).toBe('foreign');
    expect(senderKind({ id: 'otherextension', url: page('options.html') }, SELF)).toBe('foreign');
    expect(senderKind({ url: page('options.html') }, SELF)).toBe('foreign');
    expect(senderKind({}, SELF)).toBe('foreign');
    expect(senderKind(undefined, SELF)).toBe('foreign');
  });

  it('never trusts a sender when it does not know its own identity', () => {
    expect(senderKind({ url: page('options.html') }, { id: '', baseUrl: SELF.baseUrl })).toBe('foreign');
    expect(senderKind({ id: SELF.id, url: page('options.html') }, { id: SELF.id, baseUrl: '' })).toBe('content-script');
  });

  it('accepts a base URL given without its trailing slash', () => {
    const noSlash = { id: SELF.id, baseUrl: 'chrome-extension://duellensid' };
    expect(senderKind({ id: SELF.id, url: page('options.html') }, noSlash)).toBe('extension-page');
    expect(senderKind({ id: SELF.id, url: 'chrome-extension://duellensidX/options.html' }, noSlash)).toBe('content-script');
  });
});

describe('BACKGROUND_SENDERS', () => {
  it('lets content scripts send only what the in-page overlay needs', () => {
    const fromContent = Object.entries(BACKGROUND_SENDERS)
      .filter(([, who]) => who === 'content-scripts-too')
      .map(([type]) => type)
      .sort();
    expect(fromContent).toEqual(['ask-ai', 'correct', 'get-cards', 'get-image', 'open-options', 'recognize', 'show-in-panel']);
  });

  it("keeps settings, consent, status, card updates, the index and the AI test for Duel Lens's own pages", () => {
    const pagesOnly = Object.entries(BACKGROUND_SENDERS)
      .filter(([, who]) => who === 'extension-pages-only')
      .map(([type]) => type)
      .sort();
    expect(pagesOnly).toEqual(['get-status', 'grant-consent', 'refresh-cards', 'test-ai', 'update-index']);
  });

  // The table is typed Record<ToBackground['type'], …>: a new message type does not compile until it
  // picks a side. This pins the runtime side of the same contract: what src/content actually sends.
  it('allows every message the content script sends (src/content, excluding tests)', () => {
    const dir = path.resolve(import.meta.dirname, '../content');
    const sources = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .map((f) => readFileSync(path.join(dir, f), 'utf8'));
    const calls = sources.flatMap((s) => s.match(/sendToBackground\s*\(|runtime\.sendMessage\s*\(/g) ?? []);
    const sent = [
      ...new Set(sources.flatMap((s) => [...s.matchAll(/(?:sendToBackground|runtime\.sendMessage)\s*\(\s*\{\s*type:\s*'([a-z-]+)'/g)].map((m) => m[1]))),
    ];
    // Every call names its type in a literal this test can read (a call with a variable needs a look).
    expect(sent.length).toBeGreaterThan(0);
    expect(calls.length).toBe(
      sources.reduce((n, s) => n + [...s.matchAll(/(?:sendToBackground|runtime\.sendMessage)\s*\(\s*\{\s*type:\s*'[a-z-]+'/g)].length, 0),
    );
    for (const type of sent) {
      expect.soft(BACKGROUND_SENDERS[type as ToBackground['type']], `content script sends "${type}"`).toBe('content-scripts-too');
    }
  });
});

describe('backgroundAccepts', () => {
  it('takes every message type from Duel Lens\'s own pages', () => {
    for (const type of Object.keys(BACKGROUND_SENDERS)) expect(backgroundAccepts(type, 'extension-page')).toBe(true);
  });

  it('takes only the overlay\'s messages from a content script', () => {
    expect(backgroundAccepts('recognize', 'content-script')).toBe(true);
    expect(backgroundAccepts('ask-ai', 'content-script')).toBe(true);
    expect(backgroundAccepts('grant-consent', 'content-script')).toBe(false);
    expect(backgroundAccepts('get-status', 'content-script')).toBe(false);
    expect(backgroundAccepts('test-ai', 'content-script')).toBe(false);
    // Unknown types and prototype keys are refused too.
    for (const type of ['self-destruct', 'constructor', 'toString', '__proto__', undefined, 42]) {
      expect(backgroundAccepts(type, 'content-script')).toBe(false);
    }
  });

  it('takes nothing from another extension', () => {
    for (const type of Object.keys(BACKGROUND_SENDERS)) expect(backgroundAccepts(type, 'foreign')).toBe(false);
  });
});
