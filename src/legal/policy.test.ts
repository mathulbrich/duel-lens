// The in-extension privacy policy (privacy.html) must say what docs/release/privacy-policy.md says,
// with only the changes that doc's Appendix C lists for this build: fails when they drift apart.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_CACHED_IMAGES } from '../background/image-cache';
import { privacyPolicy } from './policy';

/** The policy of a build with these flags (src/build-flags.d.ts). */
function policyFor({ remoteImages, dev }: { remoteImages: boolean; dev: boolean }): string {
  vi.stubGlobal('__DUEL_LENS_REMOTE_IMAGES__', remoteImages);
  vi.stubGlobal('__DUEL_LENS_DEV__', dev);
  return privacyPolicy();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const raw = readFileSync(path.join(process.cwd(), 'docs/release/privacy-policy.md'), 'utf8');

/** The policy itself: after the draft box, before the appendices (which the doc says to delete). */
function docBody(text: string): string {
  const start = text.indexOf('**Effective date:**');
  const end = text.indexOf('\n---\n\n## Appendix A');
  return text.slice(start, end === -1 ? undefined : end).trim();
}
const doc = docBody(raw);

/** Appendix D, the text to host: its markdown block, as the reprint command printed it (final review M3). */
function appendixD(text: string): string {
  const heading = text.indexOf('\n## Appendix D');
  expect(heading, 'the doc has no Appendix D').toBeGreaterThan(-1);
  const open = '```markdown\n';
  const start = text.indexOf(open, heading);
  expect(start, 'Appendix D has no ```markdown block').toBeGreaterThan(-1);
  const end = text.indexOf('\n```', start + open.length);
  expect(end, "Appendix D's markdown block isn't closed").toBeGreaterThan(-1);
  return text.slice(start + open.length, end + 1); // its last line's newline included, as privacyPolicy() ends
}

/** `text` with `find` replaced, unless the doc already says `replace` (its owner applied the change). */
function change(text: string, find: string, replace: string): string {
  if (text.includes(replace)) return text;
  expect(text, `the doc no longer has: ${find}`).toContain(find);
  return text.replace(find, replace);
}

// Appendix C, "The first-run consent step ships": its two additions, word for word.
const CONSENT = 'Before your first scan, Duel Lens shows what it handles and asks you to agree. It takes no screenshot and records no history until you do.';
const AGREEMENT = '| **Your agreement** | The date you agreed to this data handling | Until you uninstall | Uninstall |';

describe('privacyPolicy', () => {
  it("with remote images and the developer options: the doc's words, plus the consent step, without db.ygoprodeck.com access", () => {
    let expected = change(doc, 'Chrome calls this permission "activeTab".\n', `Chrome calls this permission "activeTab".\n\n${CONSENT}\n`);
    expected = change(expected, 'creates a file only when you click it. |\n', `creates a file only when you click it. |\n${AGREEMENT}\n`);
    expected = change(
      expected,
      "| Access to `db.ygoprodeck.com` and `images.ygoprodeck.com` | To download card data, card pictures and new cards' artwork (section 3.1) |",
      "| Access to `images.ygoprodeck.com` | To download card pictures and new cards' artwork (section 3.1) |",
    );
    expect(policyFor({ remoteImages: true, dev: true }).trim()).toBe(expected);
  });

  describe('in the crop build (--no-remote-images), without the developer options', () => {
    const crop = () => policyFor({ remoteImages: false, dev: false });

    it('mentions no card images or artwork from YGOPRODeck, and no images.ygoprodeck.com', () => {
      expect(crop()).not.toContain('images.ygoprodeck.com');
      expect(crop()).not.toMatch(/\*\*Card images\*\*|New cards' artwork|card pictures and/);
      expect(crop()).toContain('- **Card data comes from YGOPRODeck.**'); // Appendix C, text-only
      expect(crop()).toContain('### 3.1 YGOPRODeck: card data (always)');
    });

    it('has the consent step, and discloses the small picture each scan keeps', () => {
      expect(crop()).toContain(CONSENT);
      expect(crop()).toContain(AGREEMENT);
      expect(crop()).toContain('and a small picture (160 pixels) of what you selected |');
      expect(crop()).toContain('The cut-out image is also shown in the pop-up, in place of a picture of the card.'); // Appendix C
    });

    it('has no "Save crops" (Appendix C, D8) and asks for no website access', () => {
      expect(crop()).not.toMatch(/Save crops|debug setting described|Export test set/);
      expect(crop()).not.toMatch(/\| Access to `/);
      expect(crop()).toContain('| Optional access to `api.anthropic.com` |');
    });

    it("keeps every other line as the doc has it", () => {
      const own = [
        '- **Card data comes from YGOPRODeck.**',
        '- **Your data stays in your browser.** Your scan history (with a small picture',
        CONSENT,
        "They aren't saved, except for a small copy of the cut-out image",
        '| **Scan history** |',
        AGREEMENT,
        '### 3.1 YGOPRODeck: card data (always)',
        'It makes one kind of request:',
        'It downloads no card images and no artwork.',
        'and **the address of each file requested**. See',
        '| storage, unlimitedStorage |',
        "Duel Lens doesn't ask to access any website",
      ];
      const lines = crop().split('\n').filter((l) => l.trim() && !own.some((o) => l.includes(o)));
      for (const line of lines) expect(doc, line).toContain(line);
    });
  });

  // Every request the weekly check makes to db.ygoprodeck.com (card-store.ts, refreshIfChanged).
  it('lists the Genesys points with the card list, in every build', () => {
    const cardData = [
      '  - If it has, it downloads the updated card list.',
      '  - With the card list, it downloads the list of Genesys points: how many points each card costs in the Genesys format.',
    ].join('\n');
    for (const remoteImages of [true, false]) {
      for (const dev of [true, false]) expect(policyFor({ remoteImages, dev })).toContain(`${cardData}\n`);
    }
  });

  it('keeps "Save crops" in the crop build (--no-remote-images) with the developer options, and card images with remote images', () => {
    expect(policyFor({ remoteImages: false, dev: true })).toContain('**Saved crops**');
    expect(policyFor({ remoteImages: true, dev: false })).toContain('**Card images**');
    expect(policyFor({ remoteImages: true, dev: false })).not.toContain('**Saved crops**');
  });

  // Final review M4: the card image cache is capped (image-cache.ts, security review I3), oldest out first.
  it('says the card pictures kept are the latest MAX_CACHED_IMAGES, as the image cache keeps them', () => {
    const n = MAX_CACHED_IMAGES.toLocaleString('en-US'); // 1,500
    const policy = policyFor({ remoteImages: true, dev: false });
    expect(policy).toContain(
      `| **Card images** | Pictures of the cards Duel Lens has shown you, downloaded from YGOPRODeck | The latest ${n} pictures. Older ones are removed automatically. | Uninstall |`,
    );
    expect(policy).toContain(`  - It keeps the latest ${n} pictures, so it doesn't download them again.\n`);
    expect(policy).not.toMatch(/\*\*Card images\*\*.*Until you uninstall/);
  });

  // Final review M3: the doc says to host Appendix D word for word, and the store build (remote images on,
  // developer options off: `npm run release`) shows privacy.html from policy.ts. The two must be one text.
  it("has Appendix D, the text to host, word for word as the store build's privacy.html shows it", () => {
    expect(appendixD(raw)).toBe(policyFor({ remoteImages: true, dev: false }));
  });
});
