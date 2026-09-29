// The legal and privacy wording on Duel Lens's pages must stay the legal workstream's, word for word
// (docs/release/disclaimers.md), as the AI disclosure does with the store kit (options/app.test.tsx).
// The crop build (`--no-remote-images`) changes only what the doc itself says to change for a
// text-only build (its §3.3 and §8: "Card data and images" becomes "Card data"), plus the small
// picture each scan keeps for the side panel.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCURACY,
  CONSENT,
  DISCLAIMER,
  sidePanelCredit,
  attribution,
  consentPoints,
  legalNotice,
  onThisComputer,
  online,
  pointText,
  type Point,
} from './copy';

/** Whitespace collapsed and links reduced to their words ("[YGOPRODeck](https://…)" → "YGOPRODeck"). */
const plain = (s: string) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
const doc = plain(readFileSync(path.join(process.cwd(), 'docs/release/disclaimers.md'), 'utf8'));

const everything = (remote: boolean): string[] => [
  legalNotice(remote),
  attribution(remote),
  sidePanelCredit(remote),
  ...[...consentPoints(remote), ...onThisComputer(remote), ...online(remote)].map(pointText),
];

describe('with remote images: the texts of docs/release/disclaimers.md, word for word', () => {
  it('§1: the short disclaimer', () => {
    expect(doc).toContain(plain(DISCLAIMER));
    expect(DISCLAIMER).toMatch(/not affiliated with or endorsed by Konami/);
  });

  it('§2: the full legal notice', () => {
    expect(doc).toContain(plain(legalNotice(true)));
  });

  it('§4a: the first-run consent', () => {
    for (const text of [CONSENT.heading, CONSENT.headingAfterScan, CONSENT.intro, CONSENT.agree, CONSENT.notNow, CONSENT.privacy]) {
      expect(doc).toContain(plain(text));
    }
    const points = consentPoints(true);
    expect(points.map((p) => p.lead)).toEqual(['Screenshots.', 'History.', 'Card data and pictures.', 'AI check (off).']);
    for (const p of points) expect(doc).toContain(plain(pointText(p)));
  });

  it('§4: what stays on this computer and what goes online', () => {
    for (const p of [...onThisComputer(true), ...online(true)]) expect(doc).toContain(plain(pointText(p)));
    expect(online(true)).toHaveLength(3);
  });

  it('§4 and §8: the footer credit, and the side panel’s', () => {
    expect(doc).toContain(plain(attribution(true)));
    expect(doc).toContain(plain(sidePanelCredit(true)));
  });

  it('§6: the accuracy notice', () => {
    expect(doc).toContain(plain(ACCURACY));
  });
});

describe('without remote images (the crop build, --no-remote-images)', () => {
  const crop = everything(false).map(plain);

  it('never says card pictures, images or artwork come from YGOPRODeck', () => {
    for (const text of crop) {
      for (const sentence of text.split(/(?<=\.)\s/)) {
        if (/YGOPRODeck/.test(sentence)) expect(sentence).not.toMatch(/\b(images?|pictures?|artwork)\b/i);
      }
    }
  });

  it('says "Card data" where the doc says "Card data and images" (its §8 rule for a text-only build)', () => {
    expect(plain(attribution(false))).toBe('Card data from YGOPRODeck.');
    expect(plain(sidePanelCredit(false))).toBe(plain(sidePanelCredit(true)).replace('Card data and images:', 'Card data:'));
    expect(plain(legalNotice(false))).toBe(
      plain(legalNotice(true)).replace('Card data and card images come from', 'Card data comes from'),
    );
  });

  it('discloses the small picture of each scan kept with the history, in the consent and on the page', () => {
    const history = (points: Point[]) => points.map(pointText).find((t) => /last 300 scans/.test(t)) ?? '';
    expect(history(consentPoints(false))).toMatch(/a small picture of what you selected/);
    expect(history(onThisComputer(false))).toMatch(/a small picture of what you selected/);
    expect(history(consentPoints(true))).not.toMatch(/picture/);
  });

  it('keeps every other text as the doc has it', () => {
    const remote = everything(true);
    const same = everything(false).filter((t, i) => t === remote[i]);
    expect(same.length).toBeGreaterThan(4);
    for (const text of same) expect(doc).toContain(plain(text));
  });
});
