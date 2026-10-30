// A slow computer for the real-footage E2E (real.ts), from environment variables. test/e2e/low-end/run.sh
// sets them in a container with fewer cores, a CPU quota and less memory; they work on the host too.
// - DUEL_LENS_E2E_CHROME=<path>: run that Chromium instead of Chrome for Testing (Debian's, in the container:
//   Chrome for Testing has no Linux ARM build). Without a sandbox there: the container's root can't have one.
// - DUEL_LENS_E2E_NO_GPU=1: --disable-gpu, so there is no WebGPU adapter and both models run on WASM, as on a
//   computer whose GPU Chrome doesn't use.
// - DUEL_LENS_E2E_COLD_EVERY=N: close the offscreen document before every Nth row, so that row's scan loads
//   the engine again, as the first scan after OFFSCREEN_IDLE_MINUTES idle does (background/offscreen-client.ts).
// Each engine load is read from the offscreen document's "engine ready" log (load time by part), and each
// model's backend from its "runs on" log.
import type { Browser, CDPSession, Protocol, Target } from 'puppeteer';

export interface LowEnd {
  chrome: string | null;
  noGpu: boolean;
  coldEvery: number | null;
}

export function lowEnd(env: NodeJS.ProcessEnv = process.env): LowEnd {
  const every = env.DUEL_LENS_E2E_COLD_EVERY;
  const coldEvery = every ? Number(every) : null;
  if (coldEvery !== null && !(Number.isInteger(coldEvery) && coldEvery > 0)) {
    throw new Error(`DUEL_LENS_E2E_COLD_EVERY must be a positive integer, got "${every}"`);
  }
  return { chrome: env.DUEL_LENS_E2E_CHROME || null, noGpu: env.DUEL_LENS_E2E_NO_GPU === '1', coldEvery };
}

/** puppeteer.launch options for the profile. */
export function lowEndLaunch(p: LowEnd): { executablePath?: string; args: string[] } {
  return {
    ...(p.chrome ? { executablePath: p.chrome } : {}),
    args: [...(p.noGpu ? ['--disable-gpu'] : []), ...(p.chrome ? ['--no-sandbox'] : [])],
  };
}

export interface EngineLoad {
  /** The offscreen document's own clock: load start → engine ready. */
  loadMs: number;
  /** When each part finished, in ms since the load started (load-engine.ts). */
  parts: Record<string, number>;
}

export interface OffscreenWatch {
  loads: EngineLoad[];
  /** "<model> runs on WASM: …" / "… runs on WebGPU (…)" lines, once each. */
  backends: string[];
}

/** Reads the offscreen document's DuelLens logs from now on (the document appears on the first scan). */
export function watchOffscreen(browser: Browser): OffscreenWatch {
  const watch: OffscreenWatch = { loads: [], backends: [] };
  const onConsole = async (cdp: CDPSession, e: Protocol.Runtime.ConsoleAPICalledEvent) => {
    const text = e.args.map((a) => String(a.value ?? a.description ?? '')).join(' ');
    if (!text.includes('DuelLens')) return;
    if (/runs on (WASM|WebGPU)/.test(text) && !watch.backends.includes(text)) watch.backends.push(text);
    const details = e.args[1]?.objectId;
    if (!text.includes('engine ready') || !details) return;
    const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: details, functionDeclaration: 'function () { return JSON.stringify(this); }', returnByValue: true });
    const ready = JSON.parse(String(result.value)) as { loadMs: number; parts: Record<string, number> };
    watch.loads.push({ loadMs: ready.loadMs, parts: ready.parts });
  };
  // The offscreen document appears as an 'other' target whose URL isn't known yet when it is created (run.ts).
  browser.on('targetcreated', (t: Target) => {
    if (t.type() !== 'other' && !t.url().endsWith('/offscreen.html')) return;
    void (async () => {
      const cdp = await t.createCDPSession();
      cdp.on('Runtime.consoleAPICalled', (e) => void onConsole(cdp, e).catch(() => {}));
      await cdp.send('Runtime.enable');
    })().catch(() => {});
  });
  return watch;
}
