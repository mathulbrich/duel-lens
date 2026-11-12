// @vitest-environment happy-dom
// Regression pins for Live's pile fix: a listed card the pointer comes back to is checked while its spot keeps moving
// (checkDue in controller.ts). The fix went through seven versions and three review rounds, and each scenario here is
// one the reviews ran on 0.10.2 and on the fix's versions. The ID in the comment above a test (R1, P4, L5, E1...) is
// the scenario's name in those reviews.
// - Most tests pin 0.10.2's own value: the fix must not change what 0.10.2 does there.
// - The fix's designed differences are pinned at their size now (V0, L1, L4 paused, P6, E1's pulls, E3's early listing).
// - The trade-offs the fix accepted have an upper bound, so that they cannot get worse (P5, P7 on a 1 s computer, E3).
// The rigs are in test-rigs.ts: rig() is controller.test.ts's step rig, sim() an event-driven page whose engine takes
// time for each detection and read while frames keep coming.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveController } from './controller';
import { ASH, OTHER, IN_ZONE_20, card, flush, normOf, nothing, recognized, rig, sim, urlOf, type Rig, type Sim } from './test-rigs';

const OPTS = { effort: 'balanced', showLabel: true } as const;
let rigs: Rig[] = [];
let sims: Sim[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('https://example.com/watch?v=a');
});
afterEach(() => {
  for (const x of [...rigs, ...sims]) x.live.stop('user');
  rigs = [];
  sims = [];
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function makeRig(): Rig {
  const r = rig(createLiveController);
  rigs.push(r);
  return r;
}
function makeSim(): Sim {
  const s = sim(createLiveController);
  sims.push(s);
  return s;
}
const nameOf = (id?: number) => (id === ASH.id ? 'ASH' : id === OTHER.id ? 'OTHER' : id === undefined ? '-' : String(id));

// The step rig's helpers.
/** The controller's clock to `t` (the pointer's moves are stamped with it). */
const clockTo = (r: Rig, t: number) => (r.clock.t = Math.max(r.clock.t, t));
/** One frame at `t` ms, the controller's clock kept with it (a page's clocks move together). */
async function at(r: Rig, t: number) {
  clockTo(r, t);
  await r.tick(t, 10 + t / 1000);
}
/** `ms` of a paused video: the controller's clock and the timers move together, in 10 ms steps. */
async function wait(r: Rig, ms: number) {
  for (let d = 0; d < ms; d += 10) {
    r.clock.t += 10;
    vi.advanceTimersByTime(10);
    await flush();
  }
}
/** Moves one region of the scene (alternating bright and dark): call it with the sample's number. */
const wiggle = (r: Rig, zone: number, n: number) => (r.scene[zone] = n % 2 ? 0 : 150);
const onCard = (r: Rig) => r.live.pointer((720 / 1280) * 960, (450 / 720) * 540); // IN_ZONE_20's middle
const offCard = (r: Rig) => r.live.pointer(5, 5); // a spot of the picture with no card
const handMoves = new WeakMap<Rig, number>();
/** The hand beside the pile moves on every gate sample (it never settles). */
function hand(r: Rig) {
  const n = handMoves.get(r) ?? 0;
  handMoves.set(r, n + 1);
  r.scene[20] = n % 2 ? 0 : 150;
}
/** Listed ASH (0, 500); a card is put on it while the pointer is elsewhere (700), a hand keeps moving beside it (it
 *  never settles: the scene changes on every frame, frames every 250 ms, each one a gate sample); the pointer comes to
 *  rest on it at 750, so its check is due on the 1000 frame; frames go on until `until`. */
async function pile(r: Rig, until: number, next?: () => ReturnType<typeof recognized>) {
  await r.live.start(OPTS);
  await at(r, 0);
  await at(r, 500);
  expect(r.views.at(-1)!.cards[0]).toMatchObject({ state: 'promoted', cardId: ASH.id });
  if (next) r.reads.next = next;
  hand(r);
  await at(r, 700);
  clockTo(r, 750);
  onCard(r);
  for (let t = 1000; t <= until; t += 250) {
    hand(r);
    await at(r, t);
  }
}
/** Frames every 250 ms from `from` to `to`, the hand moving, the pointer wherever it is. */
async function frames(r: Rig, from: number, to: number) {
  for (let t = from; t <= to; t += 250) {
    hand(r);
    await at(r, t);
  }
}
/** A pass over the card: on it 50 ms before the frame at T (under HOVER.gapMs), off it 50 ms after. */
async function pass(r: Rig, T: number) {
  clockTo(r, T - 50);
  onCard(r);
  hand(r);
  await at(r, T);
  clockTo(r, T + 50);
  offCard(r);
}

// The sim's helpers.
const A = IN_ZONE_20; // the pile: 100 x 140, region 20
const B = card(240, 85, 110, 154); // a card still being read, region 1
const aUrl = urlOf(A);
const bUrl = urlOf(B);
/** Region `zone` of the scene flips at every gate sample (200 ms): a hand that keeps moving there. */
const flip = (s: Sim, zone: number, t: number) => void (s.scene[zone] = Math.floor(t / 200) % 2 ? 0 : 150);
/** When the engine started each read of the card whose crop is `url`, from `from` on. */
const readsOf = (s: Sim, url: string, from = 0) => s.engine.log.filter((j) => j.kind === 'read' && j.crop === url && j.start >= from).map((j) => j.start);
const sentSince = (s: Sim, type: string, from: number) => s.sent.filter((m) => m.type === type && m.at >= from);
/** The engine's time spent working between `from` and `to`. */
const busyIn = (s: Sim, from: number, to: number) => s.engine.log.reduce((sum, j) => sum + Math.max(0, Math.min(j.end, to) - Math.max(j.start, from)), 0);
/** The engine's jobs from `from` on, as `kind@start-end`. */
const jobsSince = (s: Sim, from: number) => s.engine.log.filter((j) => j.start >= from).map((j) => `${j.kind}@${j.start}-${j.end}`);
/** Watches for the first sighting of OTHER: pass `each` to run(); `after(t)` is how long after `t` it came, and fails
 *  the test when it never came. */
function listedOther(s: Sim) {
  let at: number | null = null;
  return {
    each: (t: number) => {
      if (at === null && s.sightings().some((x) => x.cardId === OTHER.id)) at = t;
    },
    after(from: number): number {
      expect(at, 'OTHER was never listed').not.toBeNull();
      return at! - from;
    },
  };
}
/** When the engine started its first read of the card whose crop is `url` from `from` on; fails the test when there
 *  was none. */
function firstRead(s: Sim, url: string, from: number): number {
  const t = readsOf(s, url, from)[0];
  expect(t, 'that card was never read').toBeDefined();
  return t!;
}
/** A listed (ASH) and B still being read; from 600 ms hands keep moving over both (neither settles); then a slow
 *  computer (1 s detections and reads). Returns the hands, to keep them moving. */
async function table(s: Sim, aAnswer: () => ReturnType<typeof recognized>) {
  s.boxes.current = [A, B];
  // A is listed by 1000 ms; a frame grabbed after that shows the card `aAnswer` names there.
  s.reads.next = (url, at) => (url === aUrl ? (at > 1000 ? aAnswer() : recognized(ASH)) : recognized(OTHER, false));
  await s.live.start({ effort: 'balanced', showLabel: true });
  const hands = (t: number) => {
    if (t >= 600) flip(s, 20, t);
    if (t >= 600) flip(s, 1, t);
  };
  await s.run(1000, hands);
  expect(s.views.at(-1)!.cards.find((c) => c.state === 'promoted')).toMatchObject({ cardId: ASH.id });
  s.engine.detectMs = 1000;
  s.engine.readMs = 1000;
  return hands;
}
/** A card put on the listed pile as the pointer comes to it: a hand covers the pile from 3000 to 5000 (its reads
 *  empty) and the pointer comes to it at 4800; from 5000 the new card lies still. Returns when OTHER was listed. */
async function handWithdraws(detectMs: number, readMs: number) {
  const s = makeSim();
  s.boxes.current = [A];
  s.reads.next = (_url, at) => (at > 3000 && at <= 5000 ? nothing() : recognized(at > 5000 ? OTHER : ASH)); // what that frame shows
  await s.live.start({ effort: 'balanced', showLabel: true });
  await s.run(1500);
  s.engine.detectMs = detectMs;
  s.engine.readMs = readMs;
  s.live.pointer(900, 100); // elsewhere on the picture (an empty spot)
  await s.run(3000); // then the hand comes over the pile and puts a card there
  await s.run(4800, (t) => flip(s, 20, t));
  s.pointAt(A); // the user points at the pile as the hand withdraws
  await s.run(5000, (t) => flip(s, 20, t)); // the hand is gone at 5000: the new card lies still
  const listed = listedOther(s);
  await s.run(45_000, listed.each);
  return { s, listedMs: listed.after(5000) };
}
/** E1's page: Light, 300 ms costs. The pile (A) is listed and moving (a card put on it reads OTHER), and the pointer
 *  rests on it from 6000; B is quiet and still being read at the rate's pace. */
async function rateWhileChecked() {
  const s = makeSim();
  s.boxes.current = [A, B];
  let jit = 0;
  // A is listed by 4100 ms; a card is put on it then.
  s.reads.next = (url, at) => (url === aUrl ? recognized(at > 4100 ? OTHER : ASH) : recognized(OTHER, false, 0.6 + (jit++ % 7) * 0.01));
  await s.live.start({ effort: 'light', showLabel: true });
  await s.run(4100);
  s.engine.detectMs = 300;
  s.engine.readMs = 300;
  const each = (t: number) => {
    if (t >= 4200) flip(s, 20, t);
  };
  await s.run(6000, each);
  s.pointAt(A);
  await s.run(20_000, each);
  return {
    pileReads: readsOf(s, aUrl, 4100),
    bReads: readsOf(s, bUrl, 4100),
    searches: sentSince(s, 'live-detect', 4100).map((m) => m.at),
    statuses: [...new Set(s.progress().map((p) => p.status))],
    intervals: [...new Set(s.progress().map((p) => p.intervalMs))],
  };
}
/** E3's page: Balanced, 300 ms costs. A card is put on the listed pile at 1500 and a hand keeps moving beside it; the
 *  pointer rests on it from 3000; at 8000 the hand goes and the spot settles. */
async function checkedThenSettled() {
  const s = makeSim();
  s.boxes.current = [A];
  s.reads.next = (_url, at) => recognized(at > 1500 ? OTHER : ASH);
  await s.live.start({ effort: 'balanced', showLabel: true });
  await s.run(1500);
  s.engine.detectMs = 300;
  s.engine.readMs = 300;
  await s.run(3000, (t) => flip(s, 20, t)); // the card put there; the hand keeps moving beside it
  s.pointAt(A);
  await s.run(8000, (t) => flip(s, 20, t));
  const whileMoving = { shown: s.views.at(-1)!.cards[0], sightings: s.sightings().map((x) => nameOf(x.cardId)) };
  await s.run(20_000); // the hand goes: the spot settles
  return { whileMoving, sightings: s.sightings().map((x) => nameOf(x.cardId)), pileReads: readsOf(s, aUrl, 1500), shown: s.views.at(-1)!.cards[0] };
}
/** The pile (A) listed and its own card still there, a hand moving beside it from 4200; another hand moves in an
 *  empty part of the picture (region 5) from 4200 to 6400, then holds still: that region settles at 6800. The
 *  pointer comes to rest on the pile at 6000, so its check is due at 6250. 300 ms costs. */
async function settleAfterCheck(effort: 'light' | 'balanced') {
  const s = makeSim();
  s.boxes.current = [A];
  s.reads.next = () => recognized(ASH);
  await s.live.start({ effort, showLabel: true });
  await s.run(4100);
  s.engine.detectMs = 300;
  s.engine.readMs = 300;
  const each = (t: number) => {
    if (t >= 4200) flip(s, 20, t);
    if (t >= 4200 && t <= 6400) flip(s, 5, t);
  };
  await s.run(6000, each);
  s.pointAt(A);
  await s.run(12_000, each);
  return { pileReads: readsOf(s, aUrl, 4100), searches: sentSince(s, 'live-detect', 4100).map((m) => m.at) };
}

describe('a listed card the pointer rests on is left alone as in 0.10.2 (the pile fix\'s first version read these again)', () => {
  // R1
  it('a pointer resting on a listed card while a hand keeps moving over it reads it no more, for a minute: 0.10.2\'s value', async () => {
    const r = makeRig();
    await r.live.start(OPTS);
    await at(r, 0);
    await at(r, 500); // listed as ASH (two sure reads)
    const listedReads = r.count('recognize');
    onCard(r); // the pointer comes to rest here, nothing moved yet, and never moves again
    const every10s: number[] = [];
    for (let i = 1; i <= 300; i++) {
      wiggle(r, 20, i); // the hand moves over it all along, 60 s of frames every 200 ms
      await at(r, 500 + i * 200);
      if (i % 50 === 0) every10s.push(r.count('recognize') - listedReads);
    }
    expect(every10s).toEqual([0, 0, 0, 0, 0, 0]);
    expect(r.views.at(-1)!.cards[0]).toMatchObject({ state: 'promoted', cardId: ASH.id });
    expect(r.sightings().map((x) => nameOf(x.cardId))).toEqual(['ASH']);
  });

  // R2
  it('the pointed card on a spot that never stops moving, every read empty, stops at 12 reads (VOTE.readLimit times 3, e2d3cb5): 0.10.2\'s value', async () => {
    const r = makeRig();
    r.reads.next = nothing; // something covers it
    await r.live.start(OPTS);
    onCard(r);
    await at(r, 0);
    const every10s: number[] = [];
    for (let i = 1; i <= 300; i++) {
      wiggle(r, 20, i);
      await at(r, i * 200);
      if (i % 50 === 0) every10s.push(r.count('recognize'));
    }
    expect(every10s).toEqual([12, 12, 12, 12, 12, 12]);
  });

  // R3
  it('a "Not sure" card under a resting pointer, a hand moving over it, is not read again in 30 s: 0.10.2\'s value', async () => {
    const r = makeRig();
    r.reads.next = () => recognized(ASH, false, 0.7); // two equal unsure reads end its vote (3f86e9e)
    await r.live.start(OPTS);
    await at(r, 0);
    await at(r, 500);
    expect(r.count('recognize')).toBe(2);
    onCard(r);
    for (let i = 1; i <= 150; i++) {
      wiggle(r, 20, i);
      await at(r, 500 + i * 200);
    }
    expect(r.count('recognize')).toBe(2);
    expect(r.views.at(-1)!.cards[0]).toMatchObject({ state: 'voting', cardId: ASH.id, unsure: true, score: 0.7 });
  });

  // R4. Passes shorter than HOVER.gapMs, the controller's clock and the timers moving together. Resting long enough
  // on the same still frame checks it once: that is V0, a designed difference.
  it('a paused video whose card was moving at the pause: ten passes of 100 ms over the listed card read nothing: 0.10.2\'s value', async () => {
    const r = makeRig();
    await r.live.start(OPTS);
    await at(r, 0);
    await at(r, 500);
    wiggle(r, 20, 1); // a hand over it at the moment of the pause
    await at(r, 700);
    r.state.paused = true;
    r.video.dispatchEvent(new Event('pause'));
    await wait(r, 3000); // the still frame's own reads are over
    const perPass: number[] = [];
    for (let i = 0; i < 10; i++) {
      const b = r.count('recognize');
      onCard(r);
      await wait(r, 100); // under HOVER.gapMs: passing over checks nothing
      offCard(r);
      await wait(r, 700);
      perPass.push(r.count('recognize') - b);
    }
    expect(perPass).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(r.views.at(-1)!.cards[0]).toMatchObject({ state: 'promoted', cardId: ASH.id });
  });

  // R5
  it('a card put back after its spot was given up on is listed again, a new sighting, with the pointer on it: 0.10.2\'s value', async () => {
    const r = makeRig();
    await r.live.start(OPTS);
    await at(r, 0);
    await at(r, 500); // ASH listed
    r.reads.next = nothing; // the card is taken off: nothing there
    r.scene[20] = 200; // its zone moves for a sample, then holds still until it settles
    for (const t of [1000, 1200, 1400, 2500, 3000, 3500, 4000, 4500]) await at(r, t);
    expect(r.views.at(-1)!.cards).toEqual([]); // given up on
    r.reads.next = () => recognized(ASH); // ASH is put back, a hand moving beside it
    onCard(r);
    for (let i = 1; i <= 25; i++) {
      wiggle(r, 20, i);
      await at(r, 5000 + i * 200);
    }
    for (const t of [10_200, 10_400, 10_600, 11_000, 11_500, 12_000, 13_000]) await at(r, t); // the hand goes; it settles
    expect(r.sightings().map((x) => nameOf(x.cardId))).toEqual(['ASH', 'ASH']);
    expect(r.views.at(-1)!.cards[0]).toMatchObject({ state: 'promoted', cardId: ASH.id });
  });
});

describe('shipped behaviours that no test pinned before the fix\'s last review, as 0.10.2', () => {
  // Item 5 (after R3): the "Not sure" card's zones moved while the pointer was elsewhere, the case a check is for.
  it('an unchanged "Not sure" card the pointer comes back to while its spot still moves is not read again (3f86e9e): 0.10.2\'s value', async () => {
    const r = makeRig();
    r.reads.next = () => recognized(ASH, false, 0.7);
    await r.live.start(OPTS);
    await at(r, 0);
    await at(r, 500); // "Not sure": its vote is over
    for (let i = 1; i <= 10; i++) {
      wiggle(r, 20, i); // a hand moves over it, the pointer elsewhere
      await at(r, 500 + i * 200);
    }
    onCard(r); // the pointer comes to rest on it while the hand keeps moving
    for (let i = 11; i <= 110; i++) {
      wiggle(r, 20, i);
      await at(r, 500 + i * 200);
    }
    expect(r.count('recognize')).toBe(2);
    expect(r.views.at(-1)!.cards[0]).toMatchObject({ state: 'voting', cardId: ASH.id, unsure: true });
  });

  // Item 6 (after R5): readAgainWhereMoved clears prevCardId for a track given up on.
  it('a card read back after its spot was given up on is a new sighting, the pointer away: 0.10.2\'s value', async () => {
    const r = makeRig();
    await r.live.start(OPTS);
    await at(r, 0);
    await at(r, 500);
    r.reads.next = nothing;
    r.scene[20] = 200;
    for (const t of [1000, 1200, 1400, 2500, 3000, 3500, 4000, 4500]) await at(r, t);
    expect(r.views.at(-1)!.cards).toEqual([]);
    r.reads.next = () => recognized(ASH);
    r.scene[20] = 50; // put back: its zone moves, then settles
    for (const t of [5000, 5200, 5400, 6000, 7000]) await at(r, t);
    expect(r.sightings().map((x) => nameOf(x.cardId))).toEqual(['ASH', 'ASH']);
  });

  // Item 3: the analyze message's skip list holds the cards in sight that a read wouldn't count for.
  it('the pointer on a listed card that wants no check (nothing moved there): the search skips it with the other listed card, as 0.10.2 does', async () => {
    const r = makeRig();
    const C = card(200, 150);
    r.boxes.current = [IN_ZONE_20, C];
    await r.live.start(OPTS);
    await at(r, 0);
    await at(r, 500);
    expect(r.views.at(-1)!.cards.map((c) => c.state)).toEqual(['promoted', 'promoted']);
    onCard(r);
    for (let t = 750; t <= 10_250; t += 250) await at(r, t); // the 10 s refresh searches the picture
    const searches = r.sent.filter((m) => m.type === 'live-detect');
    expect(searches).toHaveLength(2);
    const skip = searches[1].skip as { x: number; y: number; w: number; h: number }[];
    expect(skip).toHaveLength(2);
    for (const [i, b] of [IN_ZONE_20, C].entries()) {
      for (const k of ['x', 'y', 'w', 'h'] as const) expect(skip[i][k]).toBeCloseTo(normOf(b)[k], 6);
    }
    expect(r.count('recognize')).toBe(4); // the refresh read neither
  });

  it('the pointer resting on a listed card whose spot starts moving only after it came: still skipped, as 0.10.2 does', async () => {
    const r = makeRig();
    const C = card(200, 150);
    r.boxes.current = [IN_ZONE_20, C];
    await r.live.start(OPTS);
    await at(r, 0);
    await at(r, 500);
    onCard(r);
    for (let t = 750, i = 1; t <= 10_250; t += 250, i++) {
      wiggle(r, 20, i); // a hand starts moving over it once the pointer rests there
      await at(r, t);
    }
    const searches = r.sent.filter((m) => m.type === 'live-detect');
    expect(searches).toHaveLength(2);
    expect(searches[1].skip as unknown[]).toHaveLength(2);
    expect(r.count('recognize')).toBe(4);
  });
});

describe('a slow computer\'s engine time and the pointer\'s pull, as 0.10.2 (earlier versions of the fix spent more)', () => {
  // P1
  for (const [name, effort, detectMs, readMs, busyMs, share, intervalMs] of [
    ['a mid computer at Light', 'light', 200, 400, 2400, 2, 2000],
    ['a low-end computer at Light (about 5 s a detection and 4.8 s a read, b1e5520)', 'light', 5000, 4800, 60_000, 50, 8000],
  ] as const) {
    it(`${name}: two minutes of the pointer idle on a listed card beside a moving hand cost only the 10 s refresh searches, 0.10.2's values`, async () => {
      const s = makeSim();
      s.boxes.current = [A];
      s.reads.next = () => recognized(ASH);
      await s.live.start({ effort, showLabel: true });
      await s.run(4500); // listed, at no cost
      expect(s.views.at(-1)!.cards[0]).toMatchObject({ state: 'promoted', cardId: ASH.id });
      s.engine.detectMs = detectMs;
      s.engine.readMs = readMs;
      s.pointAt(A); // and the pointer never moves again
      const busy0 = s.engine.busyMs;
      const reads0 = sentSince(s, 'recognize', 0).length;
      await s.run(124_500, (t) => flip(s, 20, t)); // two minutes of a hand moving over and beside it
      expect(sentSince(s, 'recognize', 0).length - reads0).toBe(0);
      expect(sentSince(s, 'live-detect', 4500)).toHaveLength(12);
      expect(s.engine.busyMs - busy0).toBe(busyMs);
      expect(Math.round((busyIn(s, 24_500, 124_500) / 100_000) * 100)).toBe(share); // after HOVER.activeMs: the pointer idle
      expect(s.progress().at(-1)?.intervalMs).toBe(intervalMs);
    });
  }

  // P2
  it('the pointer passing over a listed card near a moving hand on its way to a card being read: that card is read 50 ms after arrival (4f9df00), 0.10.2\'s value', async () => {
    const s = makeSim();
    s.boxes.current = [A, B];
    s.reads.next = (url) => (url === aUrl ? recognized(ASH) : recognized(OTHER, false));
    await s.live.start({ effort: 'balanced', showLabel: true });
    const hands = (t: number) => {
      if (t >= 600) flip(s, 20, t); // a hand beside the listed card
      if (t >= 600) flip(s, 1, t); // and one over the card being read
    };
    await s.run(1000, hands);
    expect(s.views.at(-1)!.cards.find((c) => c.state === 'promoted')?.cardId).toBe(ASH.id);
    s.engine.detectMs = 1000;
    s.engine.readMs = 1000;
    await s.run(2000, hands);
    s.pointAt(A); // passing over the listed card ...
    await s.run(2100, hands);
    s.pointAt(B); // ... to the one still being read, where it rests
    await s.run(6000, hands);
    expect(firstRead(s, bUrl, 2000) - 2100).toBe(50);
    expect(readsOf(s, aUrl, 2000)).toEqual([]);
  });

  // P3; item 4 of the last review (the status and interval while the pointer rests near moving hands)
  it('the side panel stays "watching" with a 2 s interval while the pointer rests on a listed card beside a moving hand: 0.10.2\'s values', async () => {
    const s = makeSim();
    s.boxes.current = [A];
    s.reads.next = () => recognized(ASH);
    await s.live.start({ effort: 'light', showLabel: true });
    await s.run(4500);
    s.engine.detectMs = 200;
    s.engine.readMs = 500;
    s.pointAt(A);
    const from = s.progress().length;
    await s.run(64_500, (t) => flip(s, 20, t));
    const later = s.progress().slice(from);
    expect([...new Set(later.map((p) => p.status))]).toEqual(['watching']);
    expect([...new Set(later.map((p) => p.intervalMs))]).toEqual([2000]);
    expect(later).toHaveLength(6);
  });

  // P3 with a check; item 4
  it('the same when the pile changed while the pointer was elsewhere, so that it is checked: still "watching" with a 2 s interval, as 0.10.2', async () => {
    const s = makeSim();
    s.boxes.current = [A];
    s.reads.next = (_url, at) => (at > 4500 ? recognized(OTHER, false) : recognized(ASH)); // then something else, not read sure
    await s.live.start({ effort: 'light', showLabel: true });
    await s.run(4500);
    s.engine.detectMs = 200;
    s.engine.readMs = 500;
    await s.run(6000, (t) => flip(s, 20, t)); // the hand moves there, the pointer elsewhere
    s.pointAt(A);
    const from = s.progress().length;
    await s.run(64_500, (t) => flip(s, 20, t));
    const later = s.progress().slice(from);
    expect([...new Set(later.map((p) => p.status))]).toEqual(['watching']);
    expect([...new Set(later.map((p) => p.intervalMs))]).toEqual([2000]);
  });

  // P4
  for (const [detectMs, readMs, listedMs, jobs] of [
    [1000, 1000, 3400, 'detect@5400-6400 read@6400-7400 read@7400-8400 detect@15400-16400 detect@25400-26400 detect@35400-36400'],
    [5000, 4800, 15_000, 'detect@5400-10400 read@10400-15200 read@15200-20000 detect@23200-28200 detect@33200-38200'],
  ] as const) {
    it(`a card put on a listed one under the resting pointer, a hand over it 2 s (${detectMs} ms detections, ${readMs} ms reads): listed ${listedMs} ms after the hand leaves, 0.10.2's value and engine`, async () => {
      const s = makeSim();
      s.boxes.current = [A];
      s.reads.next = (_url, at) => (at > 3000 && at <= 5000 ? nothing() : recognized(at > 5000 ? OTHER : ASH)); // what that frame shows
      await s.live.start({ effort: 'balanced', showLabel: true });
      await s.run(1500);
      s.engine.detectMs = detectMs;
      s.engine.readMs = readMs;
      s.pointAt(A);
      await s.run(3000); // then the hand over it
      await s.run(5000, (t) => flip(s, 20, t)); // the hand leaves; another card lies there
      const left = s.clock.t;
      const listed = listedOther(s);
      await s.run(43_000, listed.each);
      expect(listed.after(left)).toBe(listedMs);
      expect(readsOf(s, aUrl, left)).toHaveLength(2);
      expect(jobsSince(s, 2900).join(' ')).toBe(jobs);
      expect(s.views.at(-1)!.cards[0]).toMatchObject({ state: 'promoted', cardId: OTHER.id });
    });
  }

  // P7 at the low-end profile
  it('the pointer comes to the pile as the hand that put a new card there withdraws, on a low-end computer (5 s detections, 4.8 s reads): listed 20950 ms after, 0.10.2\'s value and engine', async () => {
    const { s, listedMs } = await handWithdraws(5000, 4800);
    expect(listedMs).toBe(20_950);
    expect(jobsSince(s, 4700).slice(0, 6).join(' ')).toBe('read@6550-11350 detect@11350-16350 read@16350-21150 read@21150-25950 detect@29150-34150 detect@39150-44150');
  });
});

describe('the rate keeps its own cycles while the pile is checked, as 0.10.2 (item 1 of the last review)', () => {
  // E1
  it('Light, a mid computer: the card being read keeps its rate read at 6 s and the searches keep 10 s and 20 s', async () => {
    const res = await rateWhileChecked();
    expect(res.bReads).toEqual([6000]);
    expect(res.searches).toEqual([10_000, 20_000]);
    expect(res.statuses).toEqual(['watching']);
    // The rate's 2 s; a check's pull reports its own wait (2.4 s here), as a 0.10.2 pulled read does.
    expect(res.intervals).toContain(2000);
    expect(res.intervals.every((ms) => ms === 2000 || ms === 2400)).toBe(true);
    expect(res.pileReads.length).toBeLessThanOrEqual(3); // HOVER.checksPerVisit: its reads all name a card
  });

  // E1, the due time: a check with nothing else to read runs as a pull (asPull), so it never moves dueAt.
  for (const effort of ['light', 'balanced'] as const) {
    it(`${effort}: a spot that settles right after the pile's check is searched at once (6800 ms), as in 0.10.2`, async () => {
      const res = await settleAfterCheck(effort);
      expect(res.searches).toEqual([6800]);
      expect(res.pileReads.length).toBeLessThanOrEqual(1); // the check, read sure as its own card
    });
  }
});

describe('the pile\'s re-read, as 0.10.2', () => {
  // L4 (finding A of the second review)
  it('the pointer leaves while its check is read (a slow read) and the check read another card sure: a one-frame pass 29 s later reads nothing, 0.10.2\'s values', async () => {
    const r = makeRig();
    let k = 0;
    const next = () => {
      if (k++ === 0) offCard(r); // the pointer moves off while its check is read
      return recognized(OTHER);
    };
    await pile(r, 1000, next); // the check at 1000, the pointer gone before its answer
    const afterCheck = r.count('recognize');
    await frames(r, 1250, 30_000); // 29 s, the pointer elsewhere, the pile never settles
    const away = r.count('recognize') - afterCheck;
    const b = r.count('recognize');
    await pass(r, 30_250);
    expect(away).toBe(0);
    expect(r.count('recognize') - b).toBe(0);
    expect(r.sightings().map((x) => nameOf(x.cardId))).toEqual(['ASH']);
  });

  // L4b (finding A, through the detection path)
  it('the same through a refresh search that carries the check, the pointer gone before its answer: a pass 10 s later reads nothing, 0.10.2\'s values', async () => {
    const r = makeRig();
    await r.live.start(OPTS);
    await at(r, 0);
    await at(r, 500); // listed ASH; the last search at 0
    hand(r);
    await at(r, 700); // a card put on it, the pointer elsewhere
    await frames(r, 950, 9700);
    r.reads.next = () => recognized(OTHER);
    let release!: () => void;
    r.detect.hold = new Promise<void>((resolve) => (release = resolve));
    clockTo(r, 9750);
    onCard(r); // comes to rest on it
    hand(r);
    await at(r, 10_000); // its check is due, and 10 s since the last search: the refresh carries it (held)
    const searches = r.count('live-detect');
    clockTo(r, 10_100);
    offCard(r); // gone before the answer
    r.detect.hold = null;
    release();
    await flush();
    const b = r.count('recognize');
    await frames(r, 10_250, 19_750); // the pointer away; the pile never settles
    const away = r.count('recognize') - b;
    const c = r.count('recognize');
    await pass(r, 20_250);
    expect(searches).toBe(2);
    expect(away).toBe(0);
    expect(r.count('recognize') - c).toBe(0);
    expect(r.views.at(-1)!.cards[0]).toMatchObject({ cardId: ASH.id });
    expect(r.sightings().map((x) => nameOf(x.cardId))).toEqual(['ASH']);
  });

  // L5 (finding C of the second review)
  it('the spot settles just as the pointer\'s check is due: the re-read lists the new card in two reads, and the card just listed is not checked again, 0.10.2\'s values', async () => {
    const r = makeRig();
    await r.live.start(OPTS);
    await at(r, 0);
    await at(r, 500); // listed ASH
    r.reads.next = () => recognized(OTHER); // a new card was put there
    r.scene[20] = 200; // ... by a hand, while the pointer was elsewhere: one sample of motion
    await at(r, 700);
    clockTo(r, 800);
    onCard(r); // the pointer comes to rest on it
    const marks: number[] = [];
    for (let t = 900; t <= 6000; t += 200) {
      await at(r, t); // the spot holds still: settled at 1100, as the check comes due
      marks.push(r.count('recognize'));
    }
    expect(r.count('recognize') - 2).toBe(2);
    expect([marks[1], marks[3], marks[10], marks.at(-1)]).toEqual([3, 4, 4, 4]);
    expect(r.sightings().map((x) => nameOf(x.cardId))).toEqual(['ASH', 'OTHER']);
  });

  // The third review's finding (v6): a check the pointer left and came back during charged the new visit's reads, so
  // the re-vote after the settle waited for the cost pacing between its two reads.
  it('a check the pointer left and came back during (700 ms reads): once the spot settles, the re-vote\'s two reads come back to back and list the new card 1400 ms after the search, 0.10.2\'s pace', async () => {
    const s = makeSim();
    s.boxes.current = [A];
    s.reads.next = (_url, at) => recognized(at >= 1200 ? OTHER : ASH); // a card put on it at 1200
    await s.live.start({ effort: 'balanced', showLabel: true });
    await s.run(1100); // listed ASH
    expect(s.views.at(-1)!.cards[0]).toMatchObject({ state: 'promoted', cardId: ASH.id });
    s.engine.detectMs = 700;
    s.engine.readMs = 700;
    await s.run(1200, (t) => void (t === 1200 && (s.scene[20] = 200))); // one sample of motion: it settles at 1600
    s.pointAt(A); // comes to rest on it: in the fix, its check is read at 1450-2150
    await s.run(1800);
    s.live.pointer(5, 5); // the pointer leaves while the check is read...
    s.pointAt(A); // ...and comes back before its answer: a new visit
    await s.run(10_000);
    const search = s.engine.log.find((j) => j.kind === 'detect' && j.start >= 1200)!; // the one the settle asks for
    const reread = readsOf(s, aUrl, search.end);
    const listed = s.sent.find((m) => m.type === 'live-progress' && (m.progress as { sightings: { cardId: number }[] }).sightings.some((x) => x.cardId === OTHER.id));
    expect(listed, 'OTHER was never listed').toBeDefined();
    // 0.10.2 searches at 1600 (no check) and reads at 2300 and 3000: listed at 3700. The fix's check holds the engine
    // until 2150, so it searches at 2150 and reads at 2850 and 3550: listed at 4250, at the same pace after the search.
    expect(reread.slice(0, 2)).toEqual([search.end, search.end + 700]);
    expect(listed!.at - search.end).toBe(1400);
  });

  // E2 (the quiet guard: checkDue is false while the pile's zones are quiet)
  for (const [effort, cost, listedMs] of [
    ['light', 300, 1300],
    ['balanced', 1000, 3400],
  ] as const) {
    it(`${effort}, ${cost} ms costs: the pointer reaches a pile that settled a moment ago, before the search the settle asks for: no check, listed ${listedMs} ms after the spot went still in two reads, 0.10.2's values`, async () => {
      const s = makeSim();
      s.boxes.current = [A];
      s.reads.next = (_url, at) => recognized(at > 4100 ? OTHER : ASH);
      await s.live.start({ effort, showLabel: true });
      await s.run(4100);
      s.engine.detectMs = cost;
      s.engine.readMs = cost;
      await s.run(5000, (t) => flip(s, 20, t)); // a card put on the pile, the pointer elsewhere
      await s.run(5450); // still now: settled at 5400
      s.pointAt(A);
      const listed = listedOther(s);
      await s.run(30_000, listed.each);
      expect(listed.after(5000)).toBe(listedMs);
      expect(readsOf(s, aUrl, 4100)).toHaveLength(2);
    });
  }
});

describe('a paused video: the pointer brings the still frame\'s next cycle forward (1836a19), as 0.10.2', () => {
  // E4. At the pause the pile (A) has one sure read, its spot moving, and B one unsure read: both are still being read.
  // The pointer rests on A for a moment, then moves to B.
  for (const [restMs, waitsMs] of [
    [100, 900],
    [400, 600],
  ] as const) {
    it(`resting ${restMs} ms on one card still being read, then on another: that one is read ${waitsMs} ms after the pointer reaches it, 0.10.2's value`, async () => {
      const s = makeSim();
      s.boxes.current = [A, B];
      s.reads.next = (url) => (url === aUrl ? recognized(ASH) : recognized(OTHER, false));
      await s.live.start({ effort: 'light', showLabel: true });
      await s.run(500); // the detection and its 2 reads
      s.engine.detectMs = 1000;
      s.engine.readMs = 1000;
      await s.run(4600, (t) => flip(s, 20, t)); // A's spot moving: its second read waits
      expect(s.views.at(-1)!.cards.map((c) => c.state)).toEqual(['voting', 'voting']);
      s.state.paused = true;
      s.video.dispatchEvent(new Event('pause'));
      await s.run(12_000); // the still frame: searched, B read at the rate's pace
      const t0 = s.clock.t;
      s.pointAt(A);
      await s.run(t0 + restMs);
      s.pointAt(B);
      await s.run(t0 + 15_000);
      expect(readsOf(s, aUrl, t0)).toEqual([12_000]); // the still frame's cycle that was due
      expect(firstRead(s, bUrl, t0) - (t0 + restMs)).toBe(waitsMs);
    });
  }
});

describe('the gate\'s phase decides the re-read where a moving pile goes quiet for a moment, in the fix as in 0.10.2', () => {
  // From the real-video A/B runs (YCS Dortmund 2022, the pile at 1:27): the pile is quiet for only 200-700 ms near a
  // search, and whether a gate sample lands in that window decides readAgainWhereMoved's re-read, in 0.10.2 as in the
  // fix. Here the gate samples every 200 ms, at whole multiples of 200 ms, and a search takes 300 ms.
  /** Listed ASH; from 4200 a hand moves beside the pile and a card is put on it (OTHER); the hand holds still from
   *  6000 until `still` (the zones settle at the 6400 sample, and a search starts then), then moves again. */
  async function quietWindow(still: number, pointer: 'away' | 'resting') {
    const s = makeSim();
    s.boxes.current = [A];
    s.reads.next = (_url, at) => recognized(at > 4100 ? OTHER : ASH);
    await s.live.start({ effort: 'light', showLabel: true });
    await s.run(4100);
    expect(s.views.at(-1)!.cards[0]).toMatchObject({ state: 'promoted', cardId: ASH.id });
    s.engine.detectMs = 300;
    s.engine.readMs = 300;
    if (pointer === 'resting') s.pointAt(A); // on the pile since before the card was put there: no check is due
    await s.run(9500, (t) => {
      if (t >= 4200 && (t <= 6000 || t >= still)) flip(s, 20, t);
    });
    return { searches: sentSince(s, 'live-detect', 4100).map((m) => m.at), pileReads: readsOf(s, aUrl, 4100), shown: s.views.at(-1)!.cards[0], sightings: s.sightings().map((x) => nameOf(x.cardId)) };
  }

  for (const pointer of ['away', 'resting'] as const) {
    it(`one quiet sample (6400), moving again by the search's end (6600), the pointer ${pointer}: no re-read, the old name stays`, async () => {
      const res = await quietWindow(6600, pointer);
      expect(res.searches).toEqual([6400]);
      expect(res.pileReads).toEqual([]);
      expect(res.shown).toMatchObject({ state: 'promoted', cardId: ASH.id });
      expect(res.sightings).toEqual(['ASH']);
    });
  }

  it('two quiet samples (6400, 6600) spanning the search, the pointer away: the pile is read again once and votes afresh, its box dashed with the new name', async () => {
    const res = await quietWindow(6800, 'away');
    expect(res.searches).toEqual([6400]);
    expect(res.pileReads).toEqual([6700]);
    expect(res.shown).toMatchObject({ state: 'voting', cardId: OTHER.id });
    expect(res.sightings).toEqual(['ASH']);
  });

  it('two quiet samples spanning the search, the pointer resting on the pile: read again, and its pull lists the new card', async () => {
    const res = await quietWindow(6800, 'resting');
    expect(res.searches).toEqual([6400]);
    expect(res.pileReads).toEqual([6700, 7000]);
    expect(res.shown).toMatchObject({ state: 'promoted', cardId: OTHER.id });
    expect(res.sightings).toEqual(['ASH', 'OTHER']);
  });
});

describe('the pointer\'s pull with the check: accepted trade-offs, bounded so they cannot get worse', () => {
  // P5 (accepted B); item 2 of the last review: "a card the pointer comes to is read at once" (4f9df00)
  it('resting 400 ms on a listed card near a moving hand on the way to a card being read (1 s reads): that card waits no more than 900 ms', async () => {
    const s = makeSim();
    const hands = await table(s, () => recognized(ASH));
    await s.run(2000, hands);
    s.pointAt(A); // resting on the listed card: its preview shows at once
    await s.run(2400, hands);
    s.pointAt(B); // then on to the card still being read
    await s.run(8000, hands);
    // 0.10.2 reads it 50 ms after arrival. The fix checks the listed card once (2250-3250 ms), and the card being read
    // comes when that read ends: 850 ms. One frame of this page (50 ms) is allowed on top: a read starts only on a
    // frame or as the engine frees up, so a check that shifts by one frame is still the same trade-off.
    expect(firstRead(s, bUrl, 2000) - 2400).toBeLessThanOrEqual(900);
    expect(readsOf(s, aUrl, 2000).filter((t) => t < 2400 + 900).length).toBeLessThanOrEqual(1); // the check: one read at most
  });

  // P7 (accepted D)
  it('the pointer comes to the pile as the hand that put a new card there withdraws (1 s detections and reads): listed no later than 4050 ms after', async () => {
    const { listedMs } = await handWithdraws(1000, 1000);
    // 0.10.2 lists it after 3400 ms; the fix's check of the old name comes first: 4050 ms, accepted.
    expect(listedMs).toBeLessThanOrEqual(4050);
  });

  // E3
  it('checks list the new card while the hand moves beside it, then the spot settles: listed once, with at most 4 reads of the pile', async () => {
    const res = await checkedThenSettled();
    // 0.10.2 reads the pile twice, at the settle. The fix's checks list OTHER while the hand moves (pinned with the
    // designed differences), and the settle's re-read reads it again: one more loading blink in the box, accepted, but
    // no second entry in the list.
    expect(res.sightings).toEqual(['ASH', 'OTHER']);
    expect(res.pileReads.length).toBeLessThanOrEqual(4);
    expect(res.shown).toMatchObject({ state: 'promoted', cardId: OTHER.id });
  });
});

describe('the check\'s designed differences from 0.10.2, at their size now', () => {
  // E3, while the hand still moves
  it('a card put on the pile while a hand keeps moving beside it: the checks list it before the spot ever settles (0.10.2: only at the settle)', async () => {
    const res = await checkedThenSettled();
    expect(res.whileMoving.shown).toMatchObject({ state: 'promoted', cardId: OTHER.id });
    expect(res.whileMoving.sightings).toEqual(['ASH', 'OTHER']);
  });

  // V0: R4's still frame, resting 400 ms on each visit (more than HOVER.gapMs). 0.10.2 reads nothing on any visit.
  it('a pile changed before the pause: of ten visits on the still frame, the first checks it once and the others read nothing (0.10.2: none)', async () => {
    const r = makeRig();
    await r.live.start(OPTS);
    await at(r, 0);
    await at(r, 500);
    hand(r);
    await at(r, 700);
    r.state.paused = true;
    r.video.dispatchEvent(new Event('pause'));
    await wait(r, 3000);
    const perVisit: number[] = [];
    for (let v = 0; v < 10; v++) {
      const b = r.count('recognize');
      onCard(r);
      await wait(r, 400);
      offCard(r);
      await wait(r, 400);
      perVisit.push(r.count('recognize') - b);
    }
    expect(perVisit).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  // L1
  it('a visit ends with checks that did not settle (another card sure, then nothing): 8 reads in the visit (HOVER.checkReads: empty reads of new frames are no tries), none on ten later passes (0.10.2: none at all)', async () => {
    const r = makeRig();
    let k = 0;
    await pile(r, 4000, () => (k++ === 0 ? recognized(OTHER) : nothing())); // its check and seven confirming checks, all empty
    clockTo(r, 4050);
    offCard(r);
    const inVisit = r.count('recognize') - 2;
    const perPass: number[] = [];
    for (let p = 0; p < 10; p++) {
      const b = r.count('recognize');
      await frames(r, 4250 + p * 1000, 4750 + p * 1000);
      await pass(r, 5000 + p * 1000);
      perPass.push(r.count('recognize') - b);
    }
    expect(inVisit).toBe(8);
    expect(perPass).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(r.views.at(-1)!.cards[0]).toMatchObject({ state: 'promoted', cardId: ASH.id });
  });

  // L4, paused
  it('a check whose answer came after the pointer left, then a pause: the still frame is read once on the first visit, then never (0.10.2: never)', async () => {
    const r = makeRig();
    let k = 0;
    const next = () => {
      if (k++ === 0) {
        offCard(r); // the pointer moves off while its check is read
        return recognized(OTHER);
      }
      return nothing(); // the same still frame, a hand over it: nothing, every time
    };
    await pile(r, 1000, next);
    await frames(r, 1250, 1500);
    r.state.currentTime = 10 + 1500 / 1000; // the pause stops on the last frame shown (the rig's frames carry 10 + t/1000)
    r.state.paused = true;
    r.video.dispatchEvent(new Event('pause'));
    await wait(r, 3000);
    const perVisit: number[] = [];
    for (let v = 0; v < 5; v++) {
      const b = r.count('recognize');
      onCard(r);
      await wait(r, 1500);
      offCard(r);
      await wait(r, 400);
      perVisit.push(r.count('recognize') - b);
    }
    expect(perVisit).toEqual([1, 0, 0, 0, 0]);
  });

  // P6
  it('slow computer: the pointer moves on during the 1 s check of a pile that now holds another card, then passes over it five times: one extra read, and no rename', async () => {
    const s = makeSim();
    const hands = await table(s, () => recognized(OTHER)); // another card lies on the pile now
    await s.run(2000, hands);
    s.pointAt(A); // rests on the pile: its check comes 250 ms later, a 1 s read
    await s.run(2500, hands);
    s.live.pointerGone(); // moves on during the read (off the picture)
    await s.run(11_900, hands);
    const passes: [number, number][] = [];
    for (const T of [12_000, 15_000, 22_500, 25_500, 32_500]) { // clear of the 10 s refresh searches
      await s.run(T - 50, hands);
      s.pointAt(A); // passing over the pile ...
      await s.run(T + 50, hands); // ... one frame
      s.pointAt(B); // ... to the card still being read
      await s.run(T + 1500, hands);
      s.live.pointerGone();
      await s.run(T + 2900, hands);
      const a = s.engine.log.find((x) => x.kind === 'read' && x.crop === aUrl && x.start >= T - 50 && x.start < T + 2900);
      const b = s.engine.log.find((x) => x.kind === 'read' && x.crop === bUrl && x.start >= T + 50 && x.start < T + 2900);
      passes.push([a ? a.start - T : -1, b ? b.start - (T + 50) : -1]);
    }
    const jobs = s.engine.log.filter((x) => x.start >= 1900 && x.start < 40_000).map((x) => `${x.kind}${x.crop === aUrl ? ':A' : x.crop === bUrl ? ':B' : ''}@${x.start}`);
    // 0.10.2's engine, with the one check (read:A@2250) in front: the passes read nothing of the pile, and the card
    // being read waits as long as in 0.10.2.
    expect(jobs.join(' ')).toBe('read:A@2250 detect@10000 read:B@11000 read:B@12100 detect@20000 detect@30000');
    expect(passes).toEqual([[-1, 50], [-1, -1], [-1, -1], [-1, -1], [-1, -1]]);
    expect(s.sightings().map((x) => nameOf(x.cardId))).toEqual(['ASH']);
    expect(s.views.at(-1)!.cards.find((c) => c.trackId === 1)?.cardId).toBe(ASH.id);
  });

  // E1
  it('Light, a mid computer: the moving pile under the resting pointer is checked twice, as pulls right after the rate\'s own read (6300, 6600 ms)', async () => {
    const res = await rateWhileChecked();
    expect(res.pileReads).toEqual([6300, 6600]);
  });

  // E1, the due time
  it('the pile under the resting pointer is checked 250 ms after the pointer came to rest (6250 ms), before the settle elsewhere', async () => {
    const res = await settleAfterCheck('light');
    expect(res.pileReads).toEqual([6250]);
  });

  // Item 3, the designed counterpart: a check that is due goes with the search.
  it('the pointer on a listed card whose check is due: the search reads it, and skips only the other listed card', async () => {
    const r = makeRig();
    const C = card(200, 150);
    r.boxes.current = [IN_ZONE_20, C];
    await r.live.start(OPTS);
    await at(r, 0);
    await at(r, 500);
    wiggle(r, 20, 1); // a card put on it, the pointer elsewhere
    await at(r, 9700);
    clockTo(r, 9800);
    onCard(r); // comes to rest on it while the hand keeps moving
    wiggle(r, 20, 2);
    await at(r, 10_100); // 10 s since the last search: the refresh carries the check
    const skip = r.sent.filter((m) => m.type === 'live-detect').at(-1)!.skip as { x: number; y: number; w: number; h: number }[];
    expect(skip).toHaveLength(1);
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(skip[0][k]).toBeCloseTo(normOf(C)[k], 6);
    expect(r.count('recognize')).toBe(5); // the check, read with the search
  });
});

describe('a check that restarts on a third card needs that card read twice', () => {
  // Codex's v11 finding: the motion of a read is judged when it comes back, so a read of a frame grabbed while the hand
  // moved can come back after the spot settled, keep its score and count as one clear read. A check that restarts on
  // it (a third card after another one sure) must not take that card's name on it alone.
  it('another card sure while the hand moves, then a third card read once as the spot settles: the pile keeps its name', async () => {
    const s = makeSim();
    s.boxes.current = [A];
    const THIRD = { id: 55555, imageId: 55555 };
    let third = 0;
    let stopAt = Infinity;
    s.reads.next = (_url, at) => {
      if (at <= 4100) return recognized(ASH);
      if (at <= 6400) return recognized(OTHER, true, 0.95); // a card put on it, read sure while the hand moves
      return third++ === 0 ? recognized(THIRD, true, 0.95) : nothing(); // one read of a third card, then nothing
    };
    await s.live.start({ effort: 'balanced', showLabel: true });
    await s.run(4100);
    s.engine.readMs = 800;
    const each = (t: number) => {
      if (t >= 4200 && t < stopAt) flip(s, 20, t);
    };
    await s.run(6000, each);
    s.pointAt(A);
    await s.run(20_000, (t) => {
      // The hand stops just after the check that reads the third card was grabbed: its answer comes after the settle.
      if (stopAt === Infinity && readsOf(s, aUrl, 6000).length >= 2) stopAt = t;
      each(t);
    });
    expect(third).toBeGreaterThanOrEqual(1);
    expect(s.sightings().map((x) => x.cardId)).not.toContain(THIRD.id);
  });
});
