// Name normalisation and fuzzy matching: reconciles the AI check's free-text card name
// (and OCR, later) against the local card database. Owner: stream D.

export interface NameIndexEntry {
  id: number;
  name: string;
}

export interface NameMatch {
  id: number;
  name: string;
  /** 1 for an exact (normalised) match, decreasing towards 0 for a poor one. */
  score: number;
}

/** Case/punctuation-insensitive key: "&" reads the same as "and". */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function charCodes(s: string): Uint16Array {
  const out = new Uint16Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Iterative Levenshtein edit distance over precomputed char codes (avoids re-running
 * `charCodeAt` on the query for every candidate, and on each candidate for every row).
 * `rowA`/`rowB` are caller-owned scratch buffers (length >= `bCodes.length + 1`), reused
 * across calls so matching a whole name index allocates nothing per candidate.
 */
function levenshteinCodes(aCodes: Uint16Array, bCodes: Uint16Array, m: number, rowA: Uint32Array, rowB: Uint32Array): number {
  const n = aCodes.length;
  let prev = rowA;
  let cur = rowB;
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ca = aCodes[i - 1];
    for (let j = 1; j <= m; j++) {
      const cost = ca === bCodes[j - 1] ? 0 : 1;
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      cur[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[m];
}

const DEFAULT_TOP_K = 10;

/**
 * Best `k` matches for a free-text card name (e.g. the AI check's answer), best first,
 * every one with its exact (DP-computed) score - never the pruning upper-bound
 * approximation described below, even for entries after [0] (review Minor 5: the
 * previous version returned every candidate, and a pruned one kept its upper bound as
 * `score`, so only [0]'s score was trustworthy). An exact match (after normalising)
 * always outranks a similar-but-different name, because its score is exactly 1 and
 * every other score is < 1.
 *
 * Performance: Levenshtein distance is always >= the two strings' length difference,
 * so `1 - lenDiff/M` is a provable upper bound on a candidate's score without running
 * the O(n*m) DP. Once the current top-`k` set is full, any candidate whose upper bound
 * doesn't clear its weakest (kth-best) exact score cannot improve that set, so its
 * exact distance is skipped entirely - it never gets inserted, so its approximate
 * score can never leak into the result. This keeps 15k-name lookups well under the
 * AI-check-button's budget. A cheap pre-pass seeds the top-k set with the single most
 * promising candidate first, so the pruning helps regardless of where the true best
 * happens to sit in the index.
 */
export function matchName(query: string, index: NameIndexEntry[], k: number = DEFAULT_TOP_K): NameMatch[] {
  const nq = normalizeName(query);
  const aCodes = charCodes(nq);
  const maxLen = Math.max(1, nq.length);
  const n = index.length;
  if (n === 0 || k <= 0) return [];

  const normalized: string[] = new Array(n);
  const upperBound: number[] = new Array(n);
  let rowLen = nq.length + 1;
  let seedIdx = -1;
  let seedBound = -Infinity;
  for (let i = 0; i < n; i++) {
    const nn = normalizeName(index[i].name);
    normalized[i] = nn;
    if (nn.length + 1 > rowLen) rowLen = nn.length + 1;
    const lenDiff = Math.abs(nn.length - nq.length);
    const bound = nn === nq ? 1 : Math.max(0, 1 - lenDiff / Math.max(maxLen, nn.length));
    upperBound[i] = bound;
    if (bound > seedBound) {
      seedBound = bound;
      seedIdx = i;
    }
  }

  const rowA = new Uint32Array(rowLen);
  const rowB = new Uint32Array(rowLen);
  const bCodes = new Uint16Array(rowLen);

  const exactScore = (i: number): number => {
    const nn = normalized[i];
    if (nn === nq) return 1;
    for (let c = 0; c < nn.length; c++) bCodes[c] = nn.charCodeAt(c);
    const dist = levenshteinCodes(aCodes, bCodes, nn.length, rowA, rowB);
    return dist === 0 ? 1 : Math.max(0, 1 - dist / Math.max(maxLen, nn.length));
  };

  // The top-k set, sorted best-first. Only ever holds exact scores: an entry that
  // gets pruned below is simply never passed to `insert`.
  const top: NameMatch[] = [];
  const insert = (i: number, score: number): void => {
    if (top.length >= k && score <= top[top.length - 1].score) return;
    let pos = top.length;
    while (pos > 0 && top[pos - 1].score < score) pos--;
    top.splice(pos, 0, { id: index[i].id, name: index[i].name, score });
    if (top.length > k) top.length = k;
  };

  if (seedIdx >= 0) insert(seedIdx, exactScore(seedIdx));
  for (let i = 0; i < n; i++) {
    if (i === seedIdx) continue;
    const worst = top.length >= k ? top[top.length - 1].score : -Infinity;
    if (upperBound[i] <= worst) continue; // provably can't improve the top k; skip the DP entirely
    insert(i, exactScore(i));
  }

  return top;
}
