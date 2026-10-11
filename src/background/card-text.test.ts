import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type CardRecord } from '../shared/types';
import {
  MIN_PACK_CARDS,
  PackError,
  downloadPack,
  getPackMeta,
  getTexts,
  installPack,
  localizeCard,
  localizeCards,
  parsePack,
  refreshCardText,
  setCardLanguage,
  type CardText,
} from './card-text';
import { getSettings, setSettings } from './settings';

function fakeStorageArea() {
  let data: Record<string, unknown> = {};
  return {
    get: vi.fn(async (key: string) => ({ [key]: data[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      data = { ...data, ...items };
    }),
  };
}

beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  vi.stubGlobal('chrome', { storage: { local: fakeStorageArea() } });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const pot: CardRecord = { id: 55144522, name: 'Pot of Greed', type: 'Spell Card', frameType: 'spell', desc: 'Draw 2 cards.', race: 'Normal', imageIds: [55144522] };
const hole: CardRecord = { id: 53129443, name: 'Dark Hole', type: 'Spell Card', frameType: 'spell', desc: 'Destroy all monsters on the field.', imageIds: [53129443] };
const pend: CardRecord = {
  id: 28406301,
  name: 'D/D Gryphon',
  type: 'Pendulum Effect Monster',
  frameType: 'effect_pendulum',
  desc: '[ Pendulum Effect ]\nP.\n\n[ Monster Effect ]\nM.',
  pendDesc: 'P.',
  monsterDesc: 'M.',
  imageIds: [28406301],
};

/** A YGOPRODeck card in a language answer: the fields the pack keeps, and some it drops. */
const apiCard = (id: number, name: string, desc: string, more: Record<string, unknown> = {}) => ({
  id,
  name,
  type: 'Spell Card',
  frameType: 'spell',
  desc,
  race: 'Normal',
  name_en: 'ignored',
  card_images: [{ id, image_url: 'https://images.ygoprodeck.com/x.jpg' }],
  card_prices: [{ tcgplayer_price: '1.00' }],
  ...more,
});

/** A whole answer: the given cards, padded with filler cards up to the size a real pack has. */
function answer(cards: Record<string, unknown>[], filler = MIN_PACK_CARDS) {
  const pad = Array.from({ length: Math.max(0, filler - cards.length) }, (_, i) => apiCard(1_000_000 + i, `Carte ${i}`, 'Texte.'));
  return { data: [...cards, ...pad] };
}

const frenchAnswer = () =>
  answer([
    apiCard(pot.id, 'Pot de Cupidité', 'Piochez 2 cartes.\r\n'),
    apiCard(pend.id, 'Griffon D/D', '[ Effet Pendule ]\nP fr.\n\n[ Effet de Monstre ]\nM fr.', { pend_desc: 'P fr.', monster_desc: 'M fr.' }),
  ]);

const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });

/** A fetch for checkDBVer.php and cardinfo.php?language=…, counting the pack downloads. */
function fakeFetch({ version = '147.23', pack = frenchAnswer() as unknown, packFails = false }: { version?: string; pack?: unknown; packFails?: boolean } = {}) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('checkDBVer')) return json([{ database_version: version }]);
    if (url.includes('language=')) {
      if (packFails) throw new TypeError('Failed to fetch');
      return json(pack);
    }
    return new Response('not found', { status: 404 });
  });
  return { fn: fn as unknown as typeof fetch, calls, packDownloads: () => calls.filter((u) => u.includes('language=')).length };
}

describe('parsePack', () => {
  it('keeps only each card’s id, name and text (Pendulum parts when given apart), with line ends made \\n', () => {
    const texts = parsePack(frenchAnswer());
    expect(texts).toHaveLength(MIN_PACK_CARDS);
    expect(texts[0]).toEqual({ id: pot.id, name: 'Pot de Cupidité', desc: 'Piochez 2 cartes.' });
    expect(texts[1]).toEqual({
      id: pend.id,
      name: 'Griffon D/D',
      desc: '[ Effet Pendule ]\nP fr.\n\n[ Effet de Monstre ]\nM fr.',
      pendDesc: 'P fr.',
      monsterDesc: 'M fr.',
    });
  });

  it('leaves out an entry without a usable id, name or text, and a repeated id keeps its first entry', () => {
    const texts = parsePack(
      answer([
        apiCard(pot.id, 'Pot de Cupidité', 'Piochez 2 cartes.'),
        apiCard(pot.id, 'Doublon', 'Non.'),
        apiCard(-5, 'Négatif', 'Non.'),
        apiCard(1.5, 'Décimal', 'Non.'),
        { ...apiCard(7, 'Sans texte', ''), desc: '   ' },
        { ...apiCard(8, '', 'Sans nom') },
        { id: '9', name: 'Chaîne', desc: 'Non.' },
        null as unknown as Record<string, unknown>,
      ], MIN_PACK_CARDS + 7),
    );
    expect(texts.filter((t) => t.id === pot.id)).toEqual([{ id: pot.id, name: 'Pot de Cupidité', desc: 'Piochez 2 cartes.' }]);
    expect(texts.some((t) => [-5, 1.5, 7, 8, 9].includes(t.id as number))).toBe(false);
  });

  it('refuses an answer with no card list, or too short a one (a broken or changed answer, not a pack)', () => {
    for (const bad of [null, 'x', {}, { data: 'x' }, { error: 'No valid language set.' }]) {
      expect(() => parsePack(bad)).toThrow(PackError);
    }
    expect(() => parsePack({ data: [apiCard(pot.id, 'Pot de Cupidité', 'Piochez 2 cartes.')] })).toThrow(/only 1 cards/);
  });
});

describe('localizeCard: the per-card fallback', () => {
  it('swaps in the name and text, keeps every other field, and keeps the English name for the subtitle', () => {
    const t: CardText = { id: pot.id, name: 'Pot de Cupidité', desc: 'Piochez 2 cartes.' };
    expect(localizeCard(pot, t, 'fr')).toEqual({ ...pot, name: 'Pot de Cupidité', desc: 'Piochez 2 cartes.', translated: { lang: 'fr', nameEn: 'Pot of Greed' } });
  });

  it('returns the English card itself when the pack has no text for it', () => {
    expect(localizeCard(hole, undefined, 'fr')).toBe(hole);
  });

  it('gives a Pendulum card its translated parts, or, without them, its translated whole text (never English parts)', () => {
    const withParts = localizeCard(pend, { id: pend.id, name: 'Griffon D/D', desc: 'tout', pendDesc: 'P fr.', monsterDesc: 'M fr.' }, 'fr');
    expect([withParts.pendDesc, withParts.monsterDesc, withParts.desc]).toEqual(['P fr.', 'M fr.', 'tout']);
    const whole = localizeCard(pend, { id: pend.id, name: 'Griffon D/D', desc: 'tout' }, 'fr');
    expect(whole).not.toHaveProperty('pendDesc');
    expect(whole).not.toHaveProperty('monsterDesc');
    expect(whole.desc).toBe('tout');
  });
});

describe('localizeCards (a stored pack)', () => {
  it('translates the cards the pack has, leaves the others English, and does nothing for English', async () => {
    await installPack('fr', parsePack(frenchAnswer()), '147.23');
    const cards = { [pot.id]: pot, [hole.id]: hole };
    const out = await localizeCards(cards, 'fr');
    expect(out[pot.id].name).toBe('Pot de Cupidité');
    expect(out[pot.id].translated).toEqual({ lang: 'fr', nameEn: 'Pot of Greed' });
    expect(out[hole.id]).toBe(hole);
    expect(await localizeCards(cards, 'en')).toBe(cards);
  });

  it("uses no other language's pack: another language than the stored one stays English", async () => {
    await installPack('fr', parsePack(frenchAnswer()), '147.23');
    const cards = { [pot.id]: pot };
    expect(await localizeCards(cards, 'de')).toBe(cards);
    expect((await getTexts('de', [pot.id])).size).toBe(0);
  });

  it('finds a card the pack names by another of its artworks (Dark Magician: 46986414 there, 46986420 here)', async () => {
    const dm: CardRecord = { id: 46986420, name: 'Dark Magician', type: 'Normal Monster', frameType: 'normal', desc: 'The ultimate wizard.', imageIds: [46986420, 46986414] };
    await installPack('fr', parsePack(answer([apiCard(46986414, 'Magicien Sombre', 'Le magicien ultime.')])), '147.23');
    const out = await localizeCards({ [dm.id]: dm }, 'fr');
    expect(out[dm.id]).toMatchObject({ id: dm.id, name: 'Magicien Sombre', desc: 'Le magicien ultime.', translated: { lang: 'fr', nameEn: 'Dark Magician' } });
  });

  it('stays English with no pack at all', async () => {
    const cards = { [pot.id]: pot };
    expect(await localizeCards(cards, 'ja')).toBe(cards);
  });
});

describe('downloadPack', () => {
  it('asks YGOPRODeck for the language and reports the bytes received', async () => {
    const f = fakeFetch();
    const progress: number[] = [];
    const texts = await downloadPack('fr', { fetchFn: f.fn, onProgress: (b) => progress.push(b) });
    expect(f.calls).toEqual(['https://db.ygoprodeck.com/api/v7/cardinfo.php?language=fr']);
    expect(texts).toHaveLength(MIN_PACK_CARDS);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(new TextEncoder().encode(JSON.stringify(frenchAnswer())).byteLength);
  });

  it("says 'offline' when the request can't be made, and 'bad-answer' for an error status, non-JSON, or no pack", async () => {
    await expect(downloadPack('fr', { fetchFn: fakeFetch({ packFails: true }).fn })).rejects.toMatchObject({ kind: 'offline' });
    const status = vi.fn(async () => json({ error: 'No valid language set.' }, { status: 400 })) as unknown as typeof fetch;
    await expect(downloadPack('fr', { fetchFn: status })).rejects.toMatchObject({ kind: 'bad-answer', message: 'HTTP 400' });
    const html = vi.fn(async () => new Response('<html>Cloudflare</html>')) as unknown as typeof fetch;
    await expect(downloadPack('fr', { fetchFn: html })).rejects.toMatchObject({ kind: 'bad-answer' });
    await expect(downloadPack('fr', { fetchFn: fakeFetch({ pack: { data: [] } }).fn })).rejects.toMatchObject({ kind: 'bad-answer' });
  });
});

describe('setCardLanguage (Options)', () => {
  it('downloads the pack, stores it with the database version, and only then saves the setting', async () => {
    const f = fakeFetch();
    const stages: string[] = [];
    const meta = await setCardLanguage('fr', { fetchFn: f.fn, onProgress: (p) => stages.push(p.stage) });
    expect(meta).toMatchObject({ lang: 'fr', cards: MIN_PACK_CARDS, dbVersion: '147.23' });
    expect(await getPackMeta()).toEqual(meta);
    expect((await getSettings()).display.cardLanguage).toBe('fr');
    expect(stages[0]).toBe('downloading');
    expect(stages.at(-1)).toBe('saving');
  });

  it('offline: throws, and English stays (no setting change, no pack)', async () => {
    await expect(setCardLanguage('fr', { fetchFn: fakeFetch({ packFails: true }).fn })).rejects.toMatchObject({ kind: 'offline' });
    expect((await getSettings()).display.cardLanguage).toBe('en');
    expect(await getPackMeta()).toBeUndefined();
  });

  it('a bad answer: throws, and the language already in use stays, pack and setting', async () => {
    await setCardLanguage('fr', { fetchFn: fakeFetch().fn });
    await expect(setCardLanguage('de', { fetchFn: fakeFetch({ pack: { data: [apiCard(1, 'x', 'y')] } }).fn })).rejects.toBeInstanceOf(PackError);
    expect((await getSettings()).display.cardLanguage).toBe('fr');
    expect(await getPackMeta()).toMatchObject({ lang: 'fr' });
    expect((await localizeCards({ [pot.id]: pot }, 'fr'))[pot.id].name).toBe('Pot de Cupidité');
  });

  it("doesn't download a pack that is already stored, and English removes it", async () => {
    await setCardLanguage('fr', { fetchFn: fakeFetch().fn });
    const again = fakeFetch();
    await setCardLanguage('fr', { fetchFn: again.fn });
    expect(again.calls).toEqual([]);
    await setCardLanguage('en', { fetchFn: again.fn });
    expect(again.calls).toEqual([]);
    expect((await getSettings()).display.cardLanguage).toBe('en');
    expect(await getPackMeta()).toBeUndefined();
  });
});

describe('refreshCardText (weekly, after the English refresh)', () => {
  it('downloads again only when the database version changed', async () => {
    await setCardLanguage('fr', { fetchFn: fakeFetch({ version: '147.23' }).fn });
    const same = fakeFetch({ version: '147.23' });
    expect(await refreshCardText(same.fn)).toBe('unchanged');
    expect(same.packDownloads()).toBe(0);
    const changed = fakeFetch({ version: '147.24' });
    expect(await refreshCardText(changed.fn)).toBe('updated');
    expect(changed.packDownloads()).toBe(1);
    expect(await getPackMeta()).toMatchObject({ lang: 'fr', dbVersion: '147.24' });
  });

  it('keeps the stored pack when the new download fails', async () => {
    await setCardLanguage('fr', { fetchFn: fakeFetch({ version: '147.23' }).fn });
    expect(await refreshCardText(fakeFetch({ version: '147.24', packFails: true }).fn)).toBe('failed');
    expect(await getPackMeta()).toMatchObject({ lang: 'fr', dbVersion: '147.23' });
  });

  it('downloads a missing pack for the chosen language, and removes a leftover one for English', async () => {
    await setSettings({ display: { cardLanguage: 'ja' } });
    const f = fakeFetch();
    expect(await refreshCardText(f.fn)).toBe('updated');
    expect(f.calls).toContain('https://db.ygoprodeck.com/api/v7/cardinfo.php?language=ja');
    await setSettings({ display: { cardLanguage: 'en' } });
    expect(await refreshCardText(fakeFetch().fn)).toBe('english');
    expect(await getPackMeta()).toBeUndefined();
  });

  it('never throws', async () => {
    vi.stubGlobal('chrome', { storage: { local: { get: vi.fn().mockRejectedValue(new Error('storage gone')) } } });
    expect(await refreshCardText(fakeFetch().fn)).toBe('failed');
  });
});

it('DEFAULT_SETTINGS shows cards in English', () => {
  expect(DEFAULT_SETTINGS.display.cardLanguage).toBe('en');
});
