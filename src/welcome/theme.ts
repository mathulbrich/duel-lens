// The look of Duel Lens's own pages (the welcome page and Options), from the popover's visual
// language (src/content/styles.ts): a gold accent, the foil edge, Archivo for the interface,
// Spectral SC for names, Source Serif 4 for card text and JetBrains Mono for keys. Unlike the
// always-dark popover, the pages follow the system's light or dark theme.
//
// Extension pages can load the bundled fonts (extension/fonts, SIL OFL 1.1) with plain url()s,
// resolved against the page's own URL; the content script can't, under a site's CSP (fonts.ts).

const FONTS = /* css */ `
@font-face { font-family: "Duel Lens Archivo"; src: url("fonts/archivo-latin-var.woff2") format("woff2"); font-weight: 100 900; font-stretch: 62% 125%; font-display: swap; }
@font-face { font-family: "Duel Lens Spectral SC"; src: url("fonts/spectral-sc-latin-700.woff2") format("woff2"); font-weight: 700; font-display: swap; }
@font-face { font-family: "Duel Lens Source Serif 4"; src: url("fonts/source-serif-4-latin-var.woff2") format("woff2"); font-weight: 400 600; font-display: swap; }
@font-face { font-family: "Duel Lens Source Serif 4"; src: url("fonts/source-serif-4-latin-var-italic.woff2") format("woff2"); font-weight: 400 600; font-style: italic; font-display: swap; }
@font-face { font-family: "Duel Lens JetBrains Mono"; src: url("fonts/jetbrains-mono-latin-var.woff2") format("woff2"); font-weight: 400 600; font-display: swap; }
`;

export const PAGE_CSS =
  FONTS +
  /* css */ `
:root {
  color-scheme: light dark;
  --bg: #F6F4EF;
  --surface: #FFFFFF;
  --surface-2: #EFECE4;
  --ink: #1C1924;
  --ink-2: #595369;
  --line: rgba(28,25,36,.12);
  --line-strong: rgba(28,25,36,.24);
  /* gold as text and icons: darker on a light page, for contrast */
  --accent: #875E0B;
  /* gold as a fill (buttons, step numbers) with its dark ink */
  --gold: #E7B955;
  --gold-hover: #F1C96C;
  --gold-ink: #20170A;
  --ok: #2E7D46;
  --err: #B42318;
  --err-bg: rgba(180,35,24,.07);
  --shadow: 0 1px 2px rgba(28,25,36,.05), 0 10px 30px rgba(28,25,36,.07);
  --foil: linear-gradient(100deg,#ffd1f4,#c3e4ff 22%,#c8ffe0 42%,#fff0b8 62%,#ffc9c9 80%,#ffd1f4);
  --f-ui: "Duel Lens Archivo", "Archivo", "Helvetica Neue", Arial, sans-serif;
  --f-name: "Duel Lens Spectral SC", "Spectral SC", "Spectral", Georgia, serif;
  --f-text: "Duel Lens Source Serif 4", "Source Serif 4", "Source Serif Pro", Georgia, serif;
  --f-mono: "Duel Lens JetBrains Mono", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15131C;
    --surface: #1D1A26;
    --surface-2: #252231;
    --ink: #F4F1F9;
    --ink-2: #B8B2C7;
    --line: rgba(255,255,255,.1);
    --line-strong: rgba(255,255,255,.2);
    --accent: #E7B955;
    --ok: #7BD389;
    --err: #FFB0A6;
    --err-bg: rgba(255,120,110,.1);
    --shadow: 0 1px 2px rgba(0,0,0,.3), 0 12px 32px rgba(0,0,0,.28);
  }
}
html { background: var(--bg); }
body {
  margin: 0; min-height: 100vh; background: var(--bg); color: var(--ink);
  font-family: var(--f-ui); font-size: 15px; line-height: 1.55; font-weight: 400;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
/* the popover's foil edge, as the page's top edge */
body::before { content: ""; position: fixed; z-index: 10; left: 0; right: 0; top: 0; height: 3px; background: var(--foil); pointer-events: none; }
*, *::before, *::after { box-sizing: border-box; }
h1, h2, h3, p, ul, ol, dl, dd, figure { margin: 0; }
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: .18em; }
a:hover { text-decoration-thickness: 2px; }
/* the accent, not the gold fill: the ring needs 3:1 against a light page too */
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.hint { font-size: 13.5px; color: var(--ink-2); font-weight: 400; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

.brand { display: inline-flex; align-items: center; gap: 8px; font-stretch: 75%; font-weight: 700; text-transform: uppercase; letter-spacing: .12em; font-size: 12.5px; color: var(--ink-2); text-decoration: none; }
.brand svg { width: 22px; height: 22px; color: var(--accent); }
.eyebrow { font-stretch: 75%; font-weight: 700; text-transform: uppercase; letter-spacing: .14em; font-size: 12px; color: var(--accent); }

kbd { display: inline-block; font-family: var(--f-mono); font-size: .86em; font-weight: 500; line-height: 1.2; padding: .22em .5em .18em; border-radius: 6px; border: 1px solid var(--line-strong); border-bottom-width: 2px; background: var(--surface); color: var(--ink); white-space: nowrap; }
kbd.combo { display: inline-flex; align-items: center; flex-wrap: wrap; gap: .3em; padding: 0; border: 0; border-radius: 0; background: none; font: inherit; line-height: inherit; white-space: normal; }
kbd.combo .plus { color: var(--ink-2); font-size: .85em; }

.btn { appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 36px; padding: 7px 14px; border-radius: 9px; border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); font: inherit; font-size: 14px; font-weight: 620; line-height: 1.2; cursor: pointer; text-decoration: none; white-space: nowrap; }
.btn:hover { background: var(--surface-2); }
.btn:disabled { opacity: .55; cursor: default; }
.btn:disabled:hover { background: var(--surface); }
.btn.gold { background: var(--gold); border-color: transparent; color: var(--gold-ink); }
.btn.gold:hover { background: var(--gold-hover); }
.btn.small { min-height: 28px; padding: 4px 10px; font-size: 13px; border-radius: 8px; }

/* the card database's state (status.tsx) */
.status { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; padding: 7px 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); font-size: 14px; line-height: 1.4; }
.status .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--ink-2); }
.status.loading .dot { animation: dl-pulse 1.2s ease-in-out infinite; }
.status.ready .dot { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent); }
.status.failed { border-color: color-mix(in srgb, var(--err) 40%, transparent); background: var(--err-bg); }
.status.failed .dot { background: var(--err); }
@keyframes dl-pulse { 50% { opacity: .25; } }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;
