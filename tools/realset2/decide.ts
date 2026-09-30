// realset2 decisions: records what a person decided, by eye, for the tiles of a review sheet
// (tools/realset2/sheet.ts), resolved to proposal ids and card ids, in data/realset2/decisions.jsonl
// (append-only; a later line for the same proposal wins).
//
//   npx tsx tools/realset2/decide.ts --map <dir>/sheet.json --sheet sheet-01.jpg --by "reviewer" \
//     "1=1" "2=1 foil" "3=x unsure" "4=2 covered" "5=id:12345 overframe,cut" "6=neg sleeve design text"
//
// Codes per tile: `<n>=<k>` accepts the tile's k-th candidate (1 = the engine's top); `<n>=id:<cardId>`
// a card identified otherwise (by art, name bar or context); `<n>=x <why>` rejects it (not labelled:
// uncertain, not a card, a duplicate); `<n>=neg <design>` keeps it as a non-card box (negatives.json).
// After the answer: optional tags, comma-separated (foil, overframe, covered, cut, small, tilted,
// sideways, digital, normal); the first given becomes the category unless build.ts ranks one higher.
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { cardById } from './lib/refs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'data/realset2');

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

interface Box {
  pid: string;
  top10: { cardId: number; name: string; score: number }[];
}

// --direct: codes name the proposal itself ("<frame>#<i>=id:<cardId> covered"), for boxes decided outside a
// sheet (e.g. from context frames, tools/realset2/ctxsheet.ts).
const direct = process.argv.includes('--direct');
const map = direct ? {} : (JSON.parse(readFileSync(arg('--map')!, 'utf8')) as Record<string, Record<string, string>>);
const sheet = arg('--sheet') ?? '';
const tiles: Record<string, string> = direct ? {} : map[sheet];
if (!tiles) throw new Error(`no sheet ${sheet} in the map`);
const proposalFiles = ['proposals.jsonl', 'proposals-extra.jsonl'];
const boxes = new Map<string, Box>();
for (const f of proposalFiles) {
  let text = '';
  try {
    text = readFileSync(path.join(OUT, f), 'utf8');
  } catch {
    continue;
  }
  for (const line of text.split('\n').filter(Boolean)) for (const b of (JSON.parse(line) as { boxes: Box[] }).boxes) boxes.set(b.pid, b);
}

const TAGS = new Set(['foil', 'overframe', 'covered', 'cut', 'small', 'tilted', 'sideways', 'digital', 'normal', 'rot180', 'glare', 'blur', 'stacked']);
const codes = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--') && all[i - 1] !== '--direct'));
for (const code of codes) {
  const m = (direct ? /^(\S+#\d+)=(\S+)(?:\s+(.*))?$/ : /^(\d+)=(\S+)(?:\s+(.*))?$/).exec(code.trim());
  if (!m) throw new Error(`bad code "${code}"`);
  const [, no, what, rest = ''] = m;
  const pid = direct ? no : tiles[no];
  if (!pid) throw new Error(`no tile ${no} on ${sheet}`);
  const b = boxes.get(pid);
  if (!b) throw new Error(`no proposal ${pid}`);
  const at = new Date().toISOString();
  if (what === 'x') {
    appendFileSync(path.join(OUT, 'decisions.jsonl'), JSON.stringify({ pid, reject: rest || 'rejected', at }) + '\n');
    console.log(`${no} ${pid}: rejected (${rest})`);
    continue;
  }
  if (what === 'neg') {
    appendFileSync(path.join(OUT, 'decisions.jsonl'), JSON.stringify({ pid, negative: rest || 'non-card', at }) + '\n');
    console.log(`${no} ${pid}: negative (${rest})`);
    continue;
  }
  let cardId: number;
  if (what.startsWith('id:')) cardId = Number(what.slice(3));
  else {
    const k = Number(what);
    if (!(k >= 1 && k <= b.top10.length)) throw new Error(`tile ${no}: no candidate ${what}`);
    cardId = b.top10[k - 1].cardId;
  }
  const card = cardById.get(cardId);
  if (!card) throw new Error(`tile ${no}: card ${cardId} is not in cards.json`);
  const words = rest.split(/[\s,]+/).filter(Boolean);
  const tags = words.filter((w) => TAGS.has(w));
  const note = words.filter((w) => !TAGS.has(w)).join(' ');
  appendFileSync(
    path.join(OUT, 'decisions.jsonl'),
    JSON.stringify({ pid, cardId, name: card.name, how: what.startsWith('id:') ? 'identified' : `candidate ${what}`, tags, ...(note ? { note } : {}), verified: true, at }) + '\n',
  );
  console.log(`${no} ${pid}: ${card.name} (${cardId}) ${tags.join(',')}${note ? ` [${note}]` : ''}`);
}
