// Stylesheet for the overlay's shadow root. Visual language from the design study:
// a dark overlay, a gold accent, a foil gradient on the top edge and serif card text.
// Font families are namespaced ("Duel Lens …") so the page's own @font-face rules
// can't collide with ours; see fonts.ts.

export const CSS = /* css */ `
:host { all: initial; }
.dl {
  --ov-bg: rgba(21,19,28,.97);
  --ov-solid: #17151E;
  --ov-ink: #F4F1F9;
  --ov-ink-2: #B8B2C7;
  --ov-line: rgba(255,255,255,.13);
  --ov-gold: #E7B955;
  --warn: #F0A35E;
  --warn-ink: #F7C08A;
  --foil: linear-gradient(100deg,#ffd1f4,#c3e4ff 22%,#c8ffe0 42%,#fff0b8 62%,#ffc9c9 80%,#ffd1f4);
  --f-ui: "Duel Lens Archivo", "Archivo", "Helvetica Neue", Arial, sans-serif;
  --f-name: "Duel Lens Spectral SC", "Spectral SC", "Spectral", Georgia, serif;
  --f-text: "Duel Lens Source Serif 4", "Source Serif 4", "Source Serif Pro", Georgia, serif;
  --f-mono: "Duel Lens JetBrains Mono", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  position: fixed; inset: 0; pointer-events: none;
  font-family: var(--f-ui); font-size: 13.5px; line-height: 1.45; font-weight: 400;
  color: var(--ov-ink); text-align: left; direction: ltr; letter-spacing: normal;
  -webkit-font-smoothing: antialiased; color-scheme: dark;
}
.dl *, .dl *::before, .dl *::after { box-sizing: border-box; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
kbd { font-family: var(--f-mono); font-size: 11px; padding: 1px 5px; border-radius: 4px; border: 1px solid var(--ov-line); border-bottom-width: 2px; background: rgba(255,255,255,.08); color: var(--ov-ink); }

/* ---------- frozen frame and selection ---------- */
.layer { position: fixed; inset: 0; overflow: hidden; pointer-events: auto; cursor: crosshair; user-select: none; -webkit-user-select: none; touch-action: none; }
/* the frozen frame and the popover take focus themselves (for screen readers), with no ring around them */
.layer:focus, .pop:focus { outline: none; }
.layer.busy { cursor: progress; }
.shot { position: absolute; left: 0; top: 0; width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; display: block; pointer-events: none; -webkit-user-drag: none; }
.dim { position: absolute; inset: 0; background: rgba(4,10,12,.5); pointer-events: none; }
/* the same dim with a hole for each outlined card: the cards to click stay bright */
.spotlight { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.spotlight .shade { fill: rgba(4,10,12,.5); }
.sel { position: absolute; border: 1.5px solid var(--ov-gold); border-radius: 3px; pointer-events: none; }
.sel.drawing, .sel.scanning { box-shadow: 0 0 0 200vmax rgba(4,10,12,.5); background: rgba(231,185,85,.06); }
.sel.scanning::after { content: ""; position: absolute; inset: 0; background: linear-gradient(100deg,transparent 30%,rgba(255,214,244,.55) 42%,rgba(195,228,255,.6) 50%,rgba(200,255,224,.55) 58%,transparent 70%); background-size: 260% 100%; animation: dl-sweep .8s linear infinite; mix-blend-mode: screen; }
.sel.done { box-shadow: 0 0 0 1px rgba(0,0,0,.35), 0 0 12px rgba(231,185,85,.35); }
@keyframes dl-sweep { from { background-position: 130% 0; } to { background-position: -130% 0; } }
.sel-label { position: absolute; left: -1.5px; bottom: calc(100% + 6px); width: max-content; max-width: max(100% + 3px, 92px); background: var(--ov-bg); color: var(--ov-ink); font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,.35); }
.sel.lb .sel-label { bottom: auto; top: calc(100% + 6px); }
.hint { position: absolute; left: 50%; top: 14px; transform: translateX(-50%); margin: 0; display: flex; align-items: center; gap: 8px; white-space: nowrap; background: var(--ov-bg); color: var(--ov-ink); font-size: 13px; font-weight: 550; padding: 7px 12px 7px 10px; border-radius: 10px; border: 1px solid var(--ov-line); box-shadow: 0 8px 24px rgba(0,0,0,.4); pointer-events: none; }
.hint svg { width: 16px; height: 16px; color: var(--ov-gold); flex: none; }
.hint.low { top: auto; bottom: 14px; }
.hint.finding svg { animation: dl-pulse 1.2s ease-in-out infinite; }
/* the first corner of a box made with two clicks */
.corner { position: absolute; width: 11px; height: 11px; margin: -5.5px 0 0 -5.5px; border-radius: 50%; border: 2px solid var(--ov-gold); background: rgba(231,185,85,.35); box-shadow: 0 0 0 1.5px rgba(0,0,0,.6); pointer-events: none; }
@keyframes dl-pulse { 50% { opacity: .3; } }

/* detected cards (click to scan): each outline a bright gold line over a dark one, so it shows on any
   mat; the card under the pointer or in keyboard focus is lit like a drawn box, turned with the card */
.cards { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; animation: dl-in .2s ease-out; }
.cards rect { fill: none; stroke: #FFD46B; stroke-width: 2; outline: none; }
.cards rect.under { stroke: rgba(0,0,0,.65); stroke-width: 4; }
.cards rect:focus-visible { stroke-width: 3.5; }
.layer.on-card { cursor: pointer; }
.sel.hover { border-width: 2px; background: rgba(231,185,85,.08); box-shadow: 0 0 14px rgba(231,185,85,.5), 0 0 0 200vmax rgba(4,10,12,.5); }
.sel-anchor { position: absolute; pointer-events: none; }
.sel-anchor.lb .sel-label { bottom: auto; top: calc(100% + 6px); }
@keyframes dl-in { from { opacity: 0; } }

/* ---------- popover ---------- */
.ov { position: relative; background: var(--ov-bg); color: var(--ov-ink); border: 1px solid var(--ov-line); border-radius: 12px; box-shadow: 0 22px 60px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.3); font-size: 13.5px; line-height: 1.45; }
.ov::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 3px; border-radius: 12px 12px 0 0; background: var(--foil); background-size: 200% 100%; animation: dl-foil 7s linear infinite; z-index: 1; }
@keyframes dl-foil { to { background-position: 200% 0; } }
.pop { position: fixed; left: 0; top: 0; width: min(372px, calc(100vw - 20px)); max-height: calc(100vh - 16px); display: flex; flex-direction: column; pointer-events: auto; }
.pop.measuring { visibility: hidden; }
.pop::after { content: ""; position: absolute; width: 12px; height: 12px; background: var(--ov-solid); border: 1px solid var(--ov-line); transform: rotate(45deg); }
.pop[data-side=right]::after { left: -7px; top: calc(var(--arrow, 40px) - 6px); border-top: 0; border-right: 0; }
.pop[data-side=left]::after { right: -7px; top: calc(var(--arrow, 40px) - 6px); border-bottom: 0; border-left: 0; }
.pop[data-side=below]::after { top: -7px; left: calc(var(--arrow, 40px) - 6px); border-bottom: 0; border-right: 0; }
.pop[data-side=above]::after { bottom: -7px; left: calc(var(--arrow, 40px) - 6px); border-top: 0; border-left: 0; }
.pop-scroll { padding: 12px 14px 14px; overflow: auto; overscroll-behavior: contain; min-height: 0; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.25) transparent; }
.ov-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.brand { display: inline-flex; align-items: center; gap: 7px; font-stretch: 75%; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; font-size: 11px; color: var(--ov-ink-2); }
.brand svg { width: 16px; height: 16px; color: var(--ov-gold); }
.chip { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,.08); color: var(--ov-ink-2); text-transform: none; letter-spacing: 0; font-stretch: 100%; }
.x { appearance: none; border: 0; background: transparent; color: var(--ov-ink-2); width: 28px; height: 28px; border-radius: 7px; font: inherit; font-size: 19px; line-height: 1; cursor: pointer; flex: none; padding: 0; }
.x:hover { background: rgba(255,255,255,.09); color: var(--ov-ink); }
.x:focus-visible, .btn:focus-visible, .alt:focus-visible, .dv-card button:focus-visible { outline: 2px solid var(--ov-gold); outline-offset: 1px; }

/* ---------- card view ---------- */
.dv { display: grid; gap: 10px 14px; grid-template-columns: 76px minmax(0,1fr); grid-template-areas: "card head" "text text" "meta meta"; }
.dv.no-img { grid-template-columns: minmax(0,1fr); grid-template-areas: "head" "text" "meta"; }
.dv-card { grid-area: card; }
.dv-card img, .skel-card { display: block; width: 76px; aspect-ratio: 59/86; height: auto; border-radius: 4px; box-shadow: 0 3px 10px rgba(0,0,0,.45); background: rgba(255,255,255,.06); object-fit: cover; }
/* the user's own crop (builds without remote images): all of it, however the box was drawn */
.dv-card.crop img { object-fit: contain; background: rgba(0,0,0,.35); }
.dv-head { grid-area: head; min-width: 0; }
.dv-name { font-family: var(--f-name); font-weight: 700; font-size: 19px; line-height: 1.15; margin: 0 0 4px; color: var(--ov-ink); overflow-wrap: anywhere; }
.dv-type { margin: 0 0 8px; font-stretch: 80%; font-weight: 650; font-size: 11.5px; letter-spacing: .07em; text-transform: uppercase; color: var(--ov-ink-2); }
.dv-facts { display: flex; flex-wrap: wrap; gap: 5px; }
.fact { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,.08); font-size: 11.5px; font-weight: 620; white-space: nowrap; color: var(--ov-ink); }
.fact.mono { font-family: var(--f-mono); font-size: 11px; }
/* The TCG banlist status, highlighted like the Genesys chip, in its usual colours (red, orange, yellow). */
.fact.ban { gap: 6px; font-weight: 750; }
.fact.ban::before { content: ''; width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--ban); box-shadow: 0 0 6px var(--ban); }
.fact.forbidden { --ban: #FF5A5A; background: linear-gradient(135deg, rgba(255,80,80,.30), rgba(190,30,60,.28)); color: #FFD6D2; box-shadow: inset 0 0 0 1px rgba(255,120,110,.65), 0 0 10px rgba(255,80,80,.25); }
.fact.limited { --ban: #FF9D3C; background: linear-gradient(135deg, rgba(255,150,50,.30), rgba(215,95,20,.26)); color: #FFE2C4; box-shadow: inset 0 0 0 1px rgba(255,170,90,.65), 0 0 10px rgba(255,150,60,.22); }
.fact.semi { --ban: #FFD84D; background: linear-gradient(135deg, rgba(255,215,70,.26), rgba(200,160,30,.24)); color: #FFF2C6; box-shadow: inset 0 0 0 1px rgba(255,222,110,.6), 0 0 10px rgba(255,215,80,.2); }
/* Genesys points: highlighted on purpose (the user's ask), in a colour no banlist tone uses. */
.fact.genesys { gap: 6px; background: linear-gradient(135deg, rgba(56,200,230,.30), rgba(132,96,255,.30)); color: #D9F6FF; font-weight: 750; box-shadow: inset 0 0 0 1px rgba(110,215,255,.6), 0 0 10px rgba(80,190,255,.25); }
.fact.genesys::before { content: ''; width: 6px; height: 6px; flex: none; border-radius: 1px; transform: rotate(45deg); background: #6FE3F7; box-shadow: 0 0 6px rgba(111,227,247,.9); }
.adot { width: 9px; height: 9px; border-radius: 50%; background: var(--attr, #999); box-shadow: 0 0 0 1.5px rgba(255,255,255,.35); }
.dv-text { grid-area: text; font-family: var(--f-text); font-size: 14px; line-height: 1.5; background: rgba(255,255,255,.045); border: 1px solid var(--ov-line); border-radius: 8px; padding: 10px 12px; max-height: 176px; overflow: auto; overscroll-behavior: contain; color: var(--ov-ink); scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.25) transparent; }
.dv-text p { margin: 0 0 6px; }
.dv-text p:last-child { margin: 0; }
.dv-text.flavor p, .dv-text .flavor p { font-style: italic; }
.dv-sec + .dv-sec { margin-top: 9px; padding-top: 8px; border-top: 1px solid var(--ov-line); }
.dv-sec h4 { margin: 0 0 4px; font-family: var(--f-ui); font-stretch: 80%; font-weight: 700; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--ov-ink-2); }
.dv-meta { grid-area: meta; margin: 0; font-family: var(--f-mono); font-size: 11px; color: var(--ov-ink-2); overflow-wrap: anywhere; }
.dv-foot { display: grid; gap: 10px; border-top: 1px solid var(--ov-line); padding-top: 10px; margin-top: 10px; }
.dv-match { display: flex; align-items: center; gap: 6px 10px; flex-wrap: wrap; font-size: 12px; color: var(--ov-ink-2); }
.dv-match b { color: var(--ov-ink); font-weight: 650; }
.meter { width: 64px; height: 5px; border-radius: 3px; background: rgba(255,255,255,.13); overflow: hidden; flex: none; }
.meter i { display: block; height: 100%; background: var(--ov-gold); }
.dv-match.low .meter i { background: var(--warn); }
.dv-match.low b { color: var(--warn-ink); }
.unsure { display: grid; gap: 8px; margin-bottom: 12px; padding: 10px 11px; border-radius: 9px; background: rgba(240,163,94,.08); border: 1px solid rgba(240,163,94,.3); }
.unsure .dv-alts > span { color: var(--ov-ink); font-weight: 600; }
.dv-alts { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
.dv-alts > span { flex-basis: 100%; font-size: 11.5px; color: var(--ov-ink-2); }
.alt { appearance: none; display: inline-flex; align-items: center; gap: 7px; max-width: 100%; min-width: 0; padding: 3px 9px 3px 3px; border-radius: 8px; border: 1px solid var(--ov-line); background: rgba(255,255,255,.04); color: var(--ov-ink); font: inherit; font-size: 12px; cursor: pointer; text-align: left; }
.alt:hover { border-color: rgba(231,185,85,.65); }
.alt[aria-pressed=true] { border-color: var(--ov-gold); background: rgba(231,185,85,.12); }
.alt img, .alt .thumb { width: 22px; aspect-ratio: 59/86; height: auto; flex: none; border-radius: 2px; background: rgba(255,255,255,.1); display: block; }
.alt em { font-style: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alt b { font-family: var(--f-mono); font-size: 11px; color: var(--ov-ink-2); font-weight: 600; flex: none; }
.dv-actions { display: flex; flex-wrap: wrap; gap: 6px; }
/* Three actions on one row in the 372 px popover: "YGOPRODeck ↗" is longer than the old "Yugipedia ↗". */
.dv-actions .btn { padding-inline: 9px; }
.btn { appearance: none; display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border-radius: 8px; border: 1px solid var(--ov-line); background: rgba(255,255,255,.07); color: var(--ov-ink); font: inherit; font-size: 12.5px; font-weight: 620; line-height: 1.2; cursor: pointer; text-decoration: none; white-space: nowrap; }
.btn:hover { background: rgba(255,255,255,.13); }
.btn:disabled { opacity: .65; cursor: default; }
.btn.gold { background: var(--ov-gold); color: #20170a; border-color: transparent; }
.btn.gold:hover { background: #f1c96c; }
.btn kbd { font-size: 10px; padding: 0 4px; margin-left: 1px; color: var(--ov-ink-2); border-bottom-width: 1px; }
.btn.gold kbd { color: #20170a; border-color: rgba(32,23,10,.35); background: rgba(255,255,255,.25); }
.note { font-size: 12px; color: var(--ov-ink-2); margin: 0; }
.note.tip::before { content: "Tip: "; font-weight: 650; color: var(--warn-ink); }
.note.err { color: #FFB8B0; }
.note.low { color: var(--ov-ink); font-weight: 600; }
.dv-msg { margin: 2px 0 4px; display: grid; gap: 6px; }
.dv-msg p { margin: 0; }
.dv-msg .lead { font-size: 15px; font-weight: 620; line-height: 1.35; color: var(--ov-ink); }

/* skeleton while matching */
.skel { display: grid; grid-template-columns: 76px minmax(0,1fr); gap: 12px 14px; }
.skel-lines { display: grid; gap: 8px; align-content: start; padding-top: 2px; }
.skel i, .skel-card { display: block; border-radius: 4px; background: linear-gradient(100deg, rgba(255,255,255,.07) 30%, rgba(255,255,255,.16) 50%, rgba(255,255,255,.07) 70%); background-size: 260% 100%; animation: dl-sweep 1.4s linear infinite; }
.skel i { height: 10px; }
.skel i:first-child { height: 16px; width: 80%; }

/* ---------- toast ---------- */
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); max-width: calc(100vw - 24px); width: max-content; text-align: center; background: var(--ov-bg); color: var(--ov-ink); padding: 8px 14px; border-radius: 12px; border: 1px solid var(--ov-line); font-size: 13px; font-weight: 550; box-shadow: 0 8px 24px rgba(0,0,0,.4); pointer-events: none; }

@media (prefers-reduced-motion: reduce) {
  .ov::before, .skel i, .skel-card { animation: none; }
  .sel.scanning::after { animation: none; background-position: 50% 0; opacity: .6; }
  .cards, .hint.finding svg { animation: none; }
}
`;
