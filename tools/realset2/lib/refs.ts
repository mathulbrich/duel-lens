// Reference images for checking a realset2 label by eye: the official full card image from YGOPRODeck
// (cards_small: 268x391, or cards: 421x614), downloaded once into /private/tmp/ygo-ref (never into the
// repository), and the local cropped artwork (data/artworks) as a fallback.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadCards } from '../../realset/lib/cards';

const ROOT = path.resolve(import.meta.dirname, '../../..');
export const REF_DIR = '/private/tmp/ygo-ref';

const cards = loadCards();
export const cardById = cards.byId;
export const allCards = cards.cards;

/** The card's first image id (its passcode image), which YGOPRODeck names the file by. */
export function imageIdOf(cardId: number): number {
  return cards.byId.get(cardId)?.imageIds?.[0] ?? cardId;
}

/** The local cropped artwork, if any. */
export function artOf(cardId: number): string | null {
  const ids = cards.byId.get(cardId)?.imageIds ?? [cardId];
  for (const id of ids) {
    const p = path.join(ROOT, 'data/artworks', `${id}.jpg`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** The official full card image (downloaded once), or null when it can't be had. */
export async function fullCardOf(cardId: number, size: 'small' | 'large' = 'small', imageId?: number): Promise<string | null> {
  mkdirSync(REF_DIR, { recursive: true });
  const id = imageId ?? imageIdOf(cardId);
  const file = path.join(REF_DIR, `${size === 'small' ? 's' : 'l'}-${id}.jpg`);
  if (existsSync(file)) return file;
  const url = `https://images.ygoprodeck.com/images/${size === 'small' ? 'cards_small' : 'cards'}/${id}.jpg`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return file;
  } catch {
    return null;
  }
}
