// End-to-end check of Live on a pile: a card put on a listed card shows its own name when the pointer comes back to it.
// The video is YCS Dortmund 2022, the final (YouTube 9B1H2QIEwSg). In it, Terraforming lies in the spell zone at 1:13,
// Tearlaments Havnis is put on it at 1:24 and Mudora the Sword Oracle at 1:30. The pile sits beside a hand that keeps
// moving, so its zones seldom go quiet, and 0.10.2 kept showing the card that lay there before. The pointer takes a
// viewer's path:
// - on the pile while Terraforming lies there;
// - on the field spell while Havnis is put on the pile;
// - back on the pile;
// - on the field spell while Mudora is put on it;
// - back on the pile again.
// Run: npm run e2e:live-pile [-- --effort light|balanced] [--no-build]
// Exit 0: passed. Exit 1: an assertion failed. Exit 2: void, because YouTube never played, stalled, or showed an ad or a
// bot check, or a visit began before the run could look at it. Run it again later.
// Asserts:
// - the pile shows Terraforming on the first visit;
// - on the last visit the pile shows Mudora the Sword Oracle before the visit ends;
// - the pile never shows a card other than those three;
// - once a newer card showed on the pile, an older one never shows there again.
// Reported only, not asserted: whether the second visit (1:27-1:30) shows Havnis. The pile is quiet there for only
// 200-700 ms, so whether the gate's samples (every 200 ms) catch it is chance. On the real video, 0.10.2 showed Havnis
// there in 6 of 7 runs and the pile fix in 2 of 7, both through the same unchanged re-read.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer, { type WebWorker } from 'puppeteer';
import { grantConsent, langArgs, settleInstall } from './harness';

const root = path.resolve(import.meta.dirname, '../..');
const dist = process.env.DUEL_LENS_E2E_DIST ? path.resolve(root, process.env.DUEL_LENS_E2E_DIST) : path.join(root, 'dist-e2e');
const argv = process.argv.slice(2);
const effortAt = argv.indexOf('--effort');
const effort = effortAt >= 0 ? argv[effortAt + 1] : 'light';
const outFile = path.join(root, `test/e2e/out/live-pile-${effort}.json`);
const VIDEO = 'https://www.youtube.com/watch?v=9B1H2QIEwSg&t=62';
const TERRAFORMING = 'Terraforming';
const HAVNIS = 'Tearlaments Havnis';
const MUDORA = 'Mudora the Sword Oracle';
const ORDER = [TERRAFORMING, HAVNIS, MUDORA];
/** Where the pointer rests, in the picture's fractions (a 1920x1080 frame). */
const PILE = { fx: 1283 / 1920, fy: 630 / 1080, name: 'pile' };
const SPELL = { fx: 617 / 1920, fy: 648 / 1080, name: 'field spell' };
const WARM = { fx: 0.5, fy: 0.3, name: 'warm' };
/** The pointer's path, by video time (s): each step lasts until `until`. */
const PATH = [
  { until: 68, at: WARM },
  { until: 77, at: PILE, visit: 'first' },
  { until: 87, at: SPELL },
  { until: 90, at: PILE, visit: 'second' },
  { until: 93, at: SPELL },
  { until: 97, at: PILE, visit: 'last' },
] as const;
/** Exit code of a run YouTube spoiled. */
const VOID = 2;
/** A visit whose first look came later than this after its start was not exercised (a slow start): the run is void. */
const LATE_S = 2;

class Void extends Error {}

if (!argv.includes('--no-build')) execFileSync('node', ['build.mjs', '--e2e', '--out', path.relative(root, dist)], { cwd: root, stdio: 'inherit' });
const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [dist], defaultViewport: { width: 1500, height: 1000 }, args: ['--window-size=1500,1000', '--no-first-run', '--autoplay-policy=no-user-gesture-required', ...langArgs()] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report: Record<string, unknown> = { effort, video: VIDEO };
/** What the pile showed on each visit, in order: [video time, name]. */
const seen: Record<string, [number, string][]> = { first: [], second: [], last: [] };
const failures: string[] = [];
let voided: string | null = null;
let worker: WebWorker;

async function findWorker(): Promise<WebWorker> {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
  return (await sw.worker())!;
}
/** A debug hook of the E2E build; the service worker may have restarted, so it is found again once. */
async function call(fn: string): Promise<unknown> {
  for (let i = 0; i < 2; i++) {
    try {
      return await worker.evaluate((f) => (globalThis as unknown as { duelLensDebug: Record<string, () => unknown> }).duelLensDebug[f](), fn);
    } catch {
      worker = await findWorker();
    }
  }
  return null;
}

try {
  const page = await browser.newPage();
  worker = await findWorker();
  await settleInstall(browser, page);
  await grantConsent(worker);
  await worker.evaluate(async (e) => {
    const { settings } = await chrome.storage.local.get('settings');
    const s = (settings ?? {}) as { live?: object };
    await chrome.storage.local.set({ settings: { ...s, live: { ...s.live, effort: e, showLabel: true, check: true } } });
  }, effort);
  await sleep(2000);
  await page.goto(VIDEO, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  if (await page.evaluate(`location.hostname.startsWith('consent.') || /Before you continue/i.test(document.body.innerText)`)) {
    await page.evaluate(`[...document.querySelectorAll('button')].find((b) => /^\\s*Reject all\\s*$/i.test(b.innerText))?.click()`);
    await sleep(5000);
  }
  type State = { t: number; paused: boolean; ad: boolean; rect: { x: number; y: number; w: number; h: number } } | null;
  const state = () => page.evaluate(`(() => { const v = document.querySelector('video.html5-main-video'); const p = document.getElementById('movie_player'); if (!v || !p) return null; const r = v.getBoundingClientRect(); return { t: v.currentTime, paused: v.paused, ad: p.classList.contains('ad-showing'), rect: { x: r.x, y: r.y, w: r.width, h: r.height } }; })()`) as Promise<State>;
  for (let i = 0; i < 90; i++) {
    const st = await state();
    if (st && !st.ad && !st.paused && st.t > 0) break;
    if (/not a bot|Sign in to confirm/i.test(String(await page.evaluate('document.body.innerText')))) throw new Void('YouTube asked for a bot check');
    await page.evaluate(`document.querySelector('video.html5-main-video')?.play()`).catch(() => undefined);
    await sleep(1000);
  }
  let st = await state();
  if (!st || st.ad || st.paused) throw new Void('the video never played without an ad');
  // Setup took a while with the video playing: start the path from 62 s again, at 720p, the quality a viewer picks in
  // the player's settings (headless YouTube may otherwise play the seek's first seconds at 144p, unreadable).
  await page.evaluate(`(() => { const p = document.getElementById('movie_player'); try { p.setPlaybackQualityRange('hd720', 'hd720'); } catch (e) {} try { p.setPlaybackQuality('hd720'); } catch (e) {} })()`);
  await page.evaluate(`document.getElementById('movie_player').seekTo(62, true)`);
  await sleep(1500);
  const t0 = (await state())?.t ?? -1;
  if (t0 < 61 || t0 > 66) throw new Void(`the seek to 62 s did not take (the video is at ${t0.toFixed(1)} s)`);
  report.quality = await page.evaluate(`document.getElementById('movie_player').getPlaybackQuality()`);
  const at = (fx: number, fy: number) => ({ x: st!.rect.x + fx * st!.rect.w, y: st!.rect.y + fy * st!.rect.h });
  let lastT = -1;
  let stuckSince = Date.now();
  let wiggle = 0;
  const wallEnd = Date.now() + 240_000;
  const firstLook: Record<string, number> = {};
  /** The name the last poll saw on the pile, not yet recorded: a name counts once two polls in a row show it, so a
   *  box still showing the card the pointer just left (its hide waits 150 ms) is not taken for the pile's. */
  let pending = null as { visit: string; name: string } | null;
  while (Date.now() < wallEnd) {
    st = await state();
    if (!st) throw new Void('the video went away');
    if (st.ad) throw new Void('an ad played in the middle of the run');
    if (st.t !== lastT) {
      lastT = st.t;
      stuckSince = Date.now();
    } else if (Date.now() - stuckSince > 8000) throw new Void(`the video stalled at ${st.t.toFixed(1)} s`);
    const step = PATH.find((s) => st!.t < s.until);
    if (!step) break;
    const p = at(step.at.fx, step.at.fy);
    wiggle = (wiggle + 1) % 4;
    await page.mouse.move(p.x + (wiggle % 2) * 2, p.y + (wiggle >> 1) * 2, { steps: 2 }); // a resting hand trembles
    if ('visit' in step) {
      const start = PATH[PATH.indexOf(step) - 1].until;
      firstLook[step.visit] ??= st.t;
      if (firstLook[step.visit] - start > LATE_S) throw new Void(`the ${step.visit} visit was first looked at ${firstLook[step.visit].toFixed(1)} s, ${LATE_S} s or more after it began`);
      // The name the pile's box shows. One reply carries the outlines and the box's state and name (both from the
      // pointed card's box), so they are read together: the outline under the pointer, its box showing a name.
      const outlines = ((await call('liveOutlines')) as { rect: { x: number; y: number; w: number; h: number }; name?: string; shows?: string }[] | null) ?? [];
      const under = outlines.filter((o) => p.x >= o.rect.x && p.x <= o.rect.x + o.rect.w && p.y >= o.rect.y && p.y <= o.rect.y + o.rect.h).sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h)[0];
      const name = under && under.shows && under.shows !== 'reading' ? under.name : undefined;
      const list = seen[step.visit];
      if (name && pending?.visit === step.visit && pending.name === name && list.at(-1)?.[1] !== name) list.push([Math.round(st.t * 10) / 10, name]);
      pending = name ? { visit: step.visit, name } : null;
    }
    await sleep(300);
  }
  if (Date.now() >= wallEnd) throw new Void('the run took more than 4 minutes');
  const missed = Object.keys(seen).filter((v) => firstLook[v] === undefined);
  if (missed.length) throw new Void(`the run never looked at the ${missed.join(' and ')} visit`);
  report.liveLog = await call('liveLog');
  report.trail = await call('liveTrail');
  // The first visit read at a tiny size (YouTube served 144p after the seek, whatever the quality asked): void, not a
  // failure; no card can be read there.
  const firstFrames = ((report.trail as { at: number; kind: string; frame?: string }[] | null) ?? []).filter((e) => e.kind === 'detect' && e.at >= 62 && e.at < 77 && e.frame);
  const widest = Math.max(0, ...firstFrames.map((e) => Number(e.frame!.split('x')[0])));
  if (firstFrames.length && widest < 640) throw new Void(`YouTube played the first visit at ${firstFrames[0].frame} (no card readable there)`);
} catch (e) {
  if (e instanceof Void) voided = e.message;
  else failures.push(`the run broke: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
} finally {
  await browser.close();
}

report.seen = seen;
if (!voided && failures.length === 0) {
  const all = [...seen.first, ...seen.second, ...seen.last];
  if (!seen.first.some(([, n]) => n === TERRAFORMING)) failures.push(`the first visit never showed ${TERRAFORMING} (it showed ${JSON.stringify(seen.first)})`);
  if (seen.last.at(-1)?.[1] !== MUDORA) failures.push(`the last visit did not end on ${MUDORA} (it showed ${JSON.stringify(seen.last)})`);
  const others = all.filter(([, n]) => !ORDER.includes(n));
  if (others.length) failures.push(`the pile showed a card that never lay there: ${JSON.stringify(others)}`);
  let newest = -1;
  for (const [t, n] of all) {
    const i = ORDER.indexOf(n);
    if (i < 0) continue;
    if (i < newest) failures.push(`at ${t} s the pile showed ${n} again after ${ORDER[newest]}`);
    newest = Math.max(newest, i);
  }
  report.havnisOnSecondVisit = seen.second.some(([, n]) => n === HAVNIS);
}
report.failures = failures;
report.voided = voided;
mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`pile, ${effort}: first ${JSON.stringify(seen.first)} | second ${JSON.stringify(seen.second)} | last ${JSON.stringify(seen.last)}`);
if (voided) {
  console.log(`\nLive pile E2E VOID: ${voided}. Run it again later.`);
  process.exitCode = VOID;
} else {
  console.log(`Havnis on the second visit (chance, reported only): ${report.havnisOnSecondVisit ? 'yes' : 'no'}`);
  console.log(failures.length ? `\nLive pile E2E FAILED (${failures.length}):\n- ${failures.join('\n- ')}` : '\nLive pile E2E passed');
  process.exitCode = failures.length ? 1 : 0;
}
