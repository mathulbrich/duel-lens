import { describe, expect, it } from 'vitest';
import { matchName, normalizeName, type NameIndexEntry } from './names';

describe('normalizeName', () => {
  it('normalises "&" and "and" to the same key', () => {
    expect(normalizeName('Ash Blossom & Joyous Spring')).toBe(normalizeName('ash blossom and joyous spring'));
  });

  it('ignores case and punctuation', () => {
    expect(normalizeName('Dark Magician')).toBe(normalizeName('  DARK   magician!! '));
  });
});

/** Slow-but-obviously-correct reference Levenshtein score, for cross-checking that
 * matchName's returned scores are exact (not the pruning upper-bound approximation),
 * independent of matchName's own (optimized) implementation. */
function referenceScore(query: string, name: string): number {
  const a = normalizeName(query);
  const b = normalizeName(name);
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  const dist = dp[a.length][b.length];
  const maxLen = Math.max(1, a.length);
  return dist === 0 ? 1 : Math.max(0, 1 - dist / Math.max(maxLen, b.length));
}

describe('matchName', () => {
  const index: NameIndexEntry[] = [
    { id: 1, name: 'Pot of Greed' },
    { id: 2, name: 'Pot of Desires' },
    { id: 3, name: 'Pot of Duality' },
    { id: 4, name: 'Dark Hole' },
  ];

  it('returns Pot of Greed first for a typo', () => {
    const matches = matchName('Pot of Greedd', index);
    expect(matches[0].name).toBe('Pot of Greed');
  });

  it('ranks an exact match over a similar-but-different name', () => {
    const withDecoy: NameIndexEntry[] = [...index, { id: 5, name: 'Pot of Greeed' }];
    const matches = matchName('Pot of Greed', withDecoy);
    expect(matches[0]).toMatchObject({ id: 1, name: 'Pot of Greed' });
    expect(matches[0].score).toBe(1);
  });

  it('returns at most k results', () => {
    const matches = matchName('Pot of Greed', index, 2);
    expect(matches).toHaveLength(2);
  });

  // Review Minor 5: matchName used to return every entry, with pruned ones keeping
  // their upper-bound estimate as `score` - honest only at [0]. Now it returns just
  // the top k, and every one of those k always went through the real Levenshtein DP
  // (an entry the pruning skips is, by construction, never inserted into the result),
  // so its score is exact even when pruning was genuinely exercised (n well over k).
  it('returns exact (not upper-bound-approximated) scores for every entry in the top k', () => {
    const bigIndex: NameIndexEntry[] = [
      { id: 1, name: 'Pot of Greed' },
      { id: 2, name: 'Pot of Greeed' },
      { id: 3, name: 'Pot of Greedd' },
      { id: 4, name: 'Pot of Desires' },
      { id: 5, name: 'Pot of Duality' },
      { id: 6, name: 'A Very Different and Much Longer Card Name Entirely' },
      { id: 7, name: 'Dark Hole' },
      { id: 8, name: 'Raigeki' },
    ];
    const query = 'Pot of Greed';
    const matches = matchName(query, bigIndex, 3);

    expect(matches).toHaveLength(3);
    for (const m of matches) {
      expect(m.score).toBeCloseTo(referenceScore(query, m.name), 10);
    }
    // and the set really is the true top 3, per the independent reference scorer.
    const trueOrder = bigIndex
      .map((e) => ({ id: e.id, score: referenceScore(query, e.name) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((e) => e.id);
    expect(matches.map((m) => m.id).sort()).toEqual([...trueOrder].sort());
  });

  describe('performance over a realistic 15k-name index', () => {
    // A small, fixed word list combined deterministically (mulberry32, a fixed seed)
    // into ~15k names of varied length (mostly 5-40 chars, like real card names) -
    // not the uniform-length filler the old test used, which (review Minor 5) let
    // nearly everything get pruned by length alone and never actually ran the DP.
    const WORDS = [
      'ancient', 'armor', 'blade', 'blue', 'bronze', 'castle', 'chaos', 'crimson', 'crystal', 'dark',
      'dragon', 'eclipse', 'ember', 'eternal', 'fire', 'forest', 'frost', 'gate', 'giant', 'golden',
      'guardian', 'hollow', 'hunter', 'iron', 'jade', 'king', 'knight', 'light', 'lotus', 'magic',
      'mirror', 'moon', 'mystic', 'night', 'oracle', 'phoenix', 'queen', 'rune', 'sacred', 'sage',
      'shadow', 'silver', 'sky', 'soul', 'spirit', 'star', 'storm', 'sword', 'temple', 'thunder',
      'tower', 'twilight', 'void', 'warrior', 'wind', 'winter', 'wolf', 'wyrm', 'zealot', 'abyss',
    ];

    function mulberry32(seed: number): () => number {
      let a = seed;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function generateNames(count: number, seed: number): string[] {
      const rand = mulberry32(seed);
      const names: string[] = [];
      for (let i = 0; i < count; i++) {
        const wordCount = 1 + Math.floor(rand() * 4); // 1-4 words: short and long names both
        const words: string[] = [];
        for (let w = 0; w < wordCount; w++) {
          const word = WORDS[Math.floor(rand() * WORDS.length)];
          words.push(word[0].toUpperCase() + word.slice(1));
        }
        names.push(words.join(' '));
      }
      return names;
    }

    it('matches in under 250ms (median of 5 runs) over 15k realistic, varied-length names', () => {
      const big: NameIndexEntry[] = generateNames(15000, 42).map((name, i) => ({ id: i, name }));
      big[9123] = { id: 9123, name: 'Ash Blossom & Joyous Spring' };

      const timings: number[] = [];
      let matches: ReturnType<typeof matchName> = [];
      for (let run = 0; run < 5; run++) {
        const start = performance.now();
        matches = matchName('ash blosom and joyus spring', big);
        timings.push(performance.now() - start);
      }
      timings.sort((a, b) => a - b);
      const median = timings[Math.floor(timings.length / 2)];

      expect(matches[0].id).toBe(9123);
      // Typical median ≈ 20 ms; the budget is loose on purpose, so the test catches algorithmic regressions (e.g. losing the pruning) without flaking under parallel CPU load.
      expect(median).toBeLessThan(250);
    });
  });
});
