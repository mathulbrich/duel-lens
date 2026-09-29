// Loads extension/data/cards.json for the real-set tools, with a lookup by id, and the repository root.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CardRecord } from '../../../src/shared/types';

export const ROOT = path.resolve(import.meta.dirname, '../../..');

export interface CardsData {
  cards: CardRecord[];
  byId: Map<number, CardRecord>;
}

export function loadCards(): CardsData {
  const data = JSON.parse(readFileSync(path.join(ROOT, 'extension/data/cards.json'), 'utf8')) as {
    cards: CardRecord[];
  };
  return {
    cards: data.cards,
    byId: new Map(data.cards.map((c) => [c.id, c])),
  };
}
