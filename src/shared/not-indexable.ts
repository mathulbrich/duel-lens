// Card entries whose artwork is never embedded, shared by every index Duel Lens has: the bundled one
// (tools/lib/artworks.ts), the self-updating one (background/card-store.ts) and an older install's local delta, which
// the engine merges at every load (offscreen/delta-index.ts mergeIndex).
// - "???" (149694341) stands in for unrevealed cards in tournament deck profiles; its artworks are the card back with a
//   question mark, which would compete with the card-back (face-down) entry.
// - "Teardrop the Rikka Empress" (101403041) is YGOPRODeck's stale prerelease entry of Teardrop the Rikka Sacred Queen
//   (94078362) in database 147.74: the same text and the same artwork (cosine 0.96), so that card's own picture could
//   only read "Not sure" between the two. A 0.10.2 install's weekly update may already have embedded it.
export const NOT_INDEXABLE_CARD_IDS: ReadonlySet<number> = new Set([149694341, 101403041]);
