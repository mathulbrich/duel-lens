import { describe, expect, it } from 'vitest';
import { clock, decodeImage, escapeText, inertTitle, InvalidReport, issueOf, lines, oneLine, parseReport, safeUrl, videoLink } from './report';

const PNG = 'data:image/png;base64,' + btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3));

const valid = () => ({
  v: 1,
  kind: 'wrong-card',
  image: PNG,
  shown: { id: 14558127, name: 'Ash Blossom & Joyous Spring', score: 0.6123, confident: false },
  others: [{ id: 73642296, name: 'Ghost Belle & Haunted Mansion', score: 0.58 }],
  userCard: { id: 59438930, name: 'Ghost Ogre & Snow Rabbit' },
  comment: 'It is Ghost Ogre.\nThe sleeve glare hides the art.',
  video: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3735', time: 3735.6 },
  app: { version: '0.9.4', browser: 'Chrome 141', os: 'Windows', model: 'dinov2-small-duel-v3b' },
});

describe('parseReport', () => {
  it('keeps a valid report, its image decoded and checked, its numbers rounded', () => {
    const r = parseReport(valid());
    expect(r.kind).toBe('wrong-card');
    expect(r.image.type).toBe('image/png');
    expect(r.image.bytes.length).toBe(11);
    expect(r.shown).toEqual({ id: 14558127, name: 'Ash Blossom & Joyous Spring', score: 0.612, confident: false });
    expect(r.video).toEqual({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3735', time: 3735 });
    expect(r.comment).toBe('It is Ghost Ogre.\nThe sleeve glare hides the art.');
  });

  it('refuses what is not a report: another version, an unknown kind, a card shown missing, a bad version number', () => {
    for (const bad of [
      null,
      { ...valid(), v: 2 },
      { ...valid(), kind: 'spam' },
      { ...valid(), shown: null },
      { ...valid(), shown: { id: -1, name: 'x' } },
      { ...valid(), others: [{ id: 1 }] },
      { ...valid(), app: { ...valid().app, version: '<script>' } },
      { ...valid(), video: { url: 'javascript:alert(1)' } },
    ]) {
      expect(() => parseReport(bad), JSON.stringify(bad)?.slice(0, 80)).toThrow(InvalidReport);
    }
    // No card is needed when nothing matched.
    expect(parseReport({ ...valid(), kind: 'no-match', shown: null, others: [], userCard: null }).shown).toBeNull();
  });

  it('cuts every text to its limit, and takes at most 5 other candidates', () => {
    const r = parseReport({ ...valid(), comment: 'x'.repeat(2000), others: Array.from({ length: 9 }, (_, i) => ({ id: i, name: 'n'.repeat(500), score: 0.1 })) });
    expect(r.comment).toHaveLength(500);
    expect(r.others).toHaveLength(5);
    expect(r.others[0].name).toHaveLength(120);
  });
});

describe('decodeImage', () => {
  it('refuses another type, bytes that are not the type named, and an image over 512 KB', () => {
    expect(() => decodeImage('data:image/svg+xml;base64,PHN2Zz4=')).toThrow(/PNG, JPEG or WebP/);
    expect(() => decodeImage('data:image/png;base64,' + btoa('<html>'))).toThrow(/not a PNG/);
    expect(decodeImage('data:image/jpeg;base64,' + btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0))).type).toBe('image/jpeg');
    expect(() => decodeImage('data:image/png;base64,' + 'A'.repeat(800_000))).toThrow(/too large/);
  });
});

describe('untrusted text', () => {
  it('oneLine and lines take out control characters and line breaks where one line is meant', () => {
    expect(oneLine('a\nb\u0000c\u2028d   e', 50)).toBe('a b c d e');
    expect(lines('one\r\n\r\n\r\ntwo\u0007', 50)).toBe('one\n\ntwo');
  });

  it('escapeText formats nothing, and mentions, references and links nothing once rendered (escapes gone)', () => {
    const md = escapeText('@octocat see #1 GH-1 octocat/Hello-World#1 [click](https://evil.example) <img src=x> **bold** $x$');
    const rendered = md.replace(/\\(.)/g, '$1'); // what GitHub scans for mentions and references
    expect(rendered).not.toMatch(/@[a-z]|#\d|-\d|\/[\w]|\$/i);
    expect(md).toContain('\\[click\\]');
    expect(md).toContain('\\<img src\\=x\\>');
    expect(md).toContain('\\*\\*bold\\*\\*');
    expect(md).toContain('\uff04x\uff04');
  });

  it('drops invisible and bidirectional characters', () => {
    expect(oneLine('Ash\u202eBlossom\u200b\u2066', 50)).toBe('AshBlossom');
    expect(lines('a\u200fb', 50)).toBe('ab');
  });

  it('inertTitle keeps a title from linking anyone or anything', () => {
    expect(inertTitle('Card @octocat #1 a/b')).toBe('Card @\u200boctocat #\u200b1 a/\u200bb');
  });

  it("videoLink writes a YouTube video as its canonical link, and any other address as code that can't render", () => {
    expect(videoLink('https://youtu.be/dQw4w9WgXcQ?si=tracking', 75)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=75s');
    expect(videoLink('https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=x', null)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    // The security review's payloads: a mention, an image and a hidden link after an address GitHub doesn't autolink.
    const evil = 'https://a.b_c/(@octocat)![](https://t.example/p.png)[x](https://phish.example)|`\\';
    const out = videoLink(safeUrl(evil)!, null);
    expect(out.startsWith('`') && out.endsWith('`')).toBe(true);
    expect(out.slice(1, -1)).not.toMatch(/[`|\\]/);
    expect(videoLink('https://www.youtube.com/watch?v=short', 1)).toBe('`https://www.youtube.com/watch?v=short`');
  });

  it('safeUrl keeps http(s) addresses only, without credentials', () => {
    expect(safeUrl('https://www.youtube.com/watch?v=a')).toBe('https://www.youtube.com/watch?v=a');
    expect(safeUrl('data:text/html,x')).toBeNull();
    expect(safeUrl('https://user:pw@example.com/')).toBeNull();
    expect(safeUrl('https://example.com/' + 'a'.repeat(500))).toBeNull();
  });
});

describe('issueOf', () => {
  it('titles the issue by kind and card, and shows the image, the cards, the video moment and the comment as text', () => {
    const issue = issueOf(parseReport(valid()), 'https://relay.example/img/0123');
    expect(issue.title).toBe('Card report (wrong card): Ash Blossom & Joyous Spring');
    expect(issue.labels).toEqual(['card-report', 'wrong-card']);
    expect(issue.body).toContain('![The crop Duel Lens read](https://relay.example/img/0123)');
    expect(issue.body).toContain('Ghost Ogre \\& Snow Rabbit (59438930)');
    expect(issue.title).not.toMatch(/[@#/][^\u200b]/);
    expect(issue.body).toContain('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3735s (at 1:02:15)');
    expect(issue.body).toContain('> It is Ghost Ogre\\.');
    expect(issue.body).toContain(', not sure |');
  });

  it("a comment can't break out of its quote or the table", () => {
    const issue = issueOf(parseReport({ ...valid(), comment: '| **x** |\n# Title\n</sub>' }), 'https://relay.example/img/1');
    expect(issue.body).toContain('> \\| \\*\\*x\\*\\* \\|');
    expect(issue.body).toContain('> \\#\u200b Title');
    expect(issue.body).toContain('> \\<\\/\u200bsub\\>');
  });

  it('clock writes h:mm:ss, or m:ss under an hour', () => {
    expect(clock(3735)).toBe('1:02:15');
    expect(clock(75)).toBe('1:15');
  });
});
