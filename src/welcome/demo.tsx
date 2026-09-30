// The welcome page's illustration of a scan: a paused duel with scan mode's bar on top (it stays open
// until the user leaves), the gold outline of the card the pointer clicked, and the popover beside it,
// numbered like the three steps. Drawn in CSS: no image files, sharp at any size, and the popover stays
// dark like the real one in both themes. The card is made up: no real card's name, text or art appears.
// Everything is sized in em from the stage's width, so the whole scene scales as one.
import { LensIcon } from '../content/icons';
import { Keys } from './shortcuts';

export function Demo({ shortcut }: { shortcut: string | null }) {
  return (
    <figure class="demo">
      <div class="demo-stage" aria-hidden="true">
        <div class="demo-in">
          <div class="demo-keys">
            <span class="callout">1</span>
            {shortcut ? (
              <>
                Press <Keys shortcut={shortcut} />
              </>
            ) : shortcut === '' ? (
              <>
                Click <LensIcon /> in the toolbar
              </>
            ) : (
              'Press the shortcut'
            )}
          </div>

          <div class="demo-video">
            <i class="zone z1" />
            <i class="zone z2" />
            <i class="dc dc-back set" />
            <DemoCard class="target" />
            <i class="demo-sel" />
            <svg class="demo-cursor" viewBox="0 0 14 21">
              <path d="M1 1v16.5l4.2-4 2.9 6.6 2.6-1.1-2.8-6.5h5.8z" />
            </svg>
            {/* scan mode's bar (src/content): it stays open until Esc or its ✕ */}
            <div class="demo-scanbar">
              <LensIcon />
              <span>Duel Lens · 1 card · Esc to exit</span>
              <span class="demo-scanbar-x">✕</span>
            </div>
            <div class="demo-bar">
              <i class="pause" />
              <i class="track">
                <i />
              </i>
              <span>12:48 / 31:05</span>
            </div>
          </div>
          <span class="callout n2">2</span>

          <div class="dp-wrap">
            <div class="dp">
              <div class="dp-top">
                <span class="dp-brand">
                  <LensIcon />
                  Duel Lens
                </span>
                <span class="dp-x">×</span>
              </div>
              <div class="dp-head">
                <DemoCard />
                <div>
                  <p class="dp-name">Gilded Lens Wyvern</p>
                  <p class="dp-type">[Dragon / Effect]</p>
                  <div class="dp-facts">
                    <span class="dp-fact">
                      <i class="dp-adot" />
                      LIGHT
                    </span>
                    <span class="dp-fact">Level 7</span>
                    <span class="dp-fact mono">ATK 2500 / DEF 2100</span>
                  </div>
                </div>
              </div>
              <p class="dp-text">
                Once per turn, when a card appears on your screen: you can read its name, type and full text.
              </p>
              <div class="dp-foot">
                <div class="dp-match">
                  <span class="dp-meter">
                    <i />
                  </span>
                  <span>
                    <b>94% match</b> · card outline · 1080p video
                  </span>
                </div>
                <div class="dp-actions">
                  <span class="dp-btn">Keep in side panel</span>
                  <span class="dp-btn">Copy text</span>
                  <span class="dp-btn">YGOPRODeck ↗</span>
                </div>
              </div>
            </div>
          </div>
          <span class="callout n3">3</span>
        </div>
      </div>
      <figcaption>
        What a scan looks like: the picture freezes, you click a card, and its details appear beside it. Duel Lens
        stays open for the next card until you press Esc. (The card in this picture is made up.)
      </figcaption>
    </figure>
  );
}

/** A made-up effect monster: frame, name bar, attribute, level stars, artwork and text box. */
function DemoCard({ class: cls }: { class?: string }) {
  return (
    <i class={`dc dc-wyvern${cls ? ` ${cls}` : ''}`}>
      <i class="dc-name" />
      <i class="dc-attr" />
      <i class="dc-stars" />
      <i class="dc-art" />
      <i class="dc-text" />
    </i>
  );
}

export const DEMO_CSS = /* css */ `
.demo { display: grid; gap: 12px; }
.demo figcaption { font-size: 13px; color: var(--ink-2); text-align: center; }
.demo-stage { container-type: inline-size; }
/* the scene is 48em wide: 1em is a 48th of the stage */
.demo-in { position: relative; width: 48em; height: 25.6em; font-size: calc(100cqw / 48); line-height: 1.4; }
.demo-in i { display: block; font-style: normal; }

.callout { position: absolute; z-index: 3; display: grid; place-items: center; width: 1.9em; height: 1.9em; border-radius: 50%; background: var(--gold); color: var(--gold-ink); font-weight: 750; font-size: .95em; line-height: 1; box-shadow: 0 0 0 .2em var(--bg), 0 .25em .7em rgba(0,0,0,.28); }
.callout.n2 { left: 11.3em; top: 15.9em; }
.callout.n3 { left: 44.4em; top: 3.5em; }

.demo-keys { position: absolute; left: 0; top: 0; z-index: 2; display: inline-flex; align-items: center; gap: .6em; padding: .3em .9em .3em .3em; border-radius: 999px; background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow); font-size: .95em; font-weight: 600; white-space: nowrap; }
.demo-keys .callout { position: static; box-shadow: none; }
.demo-keys svg { width: 1.3em; height: 1.3em; color: var(--accent); }

/* the paused video: a duel mat with two cards */
.demo-video { position: absolute; left: 0; top: 3.1em; width: 33em; height: 18.56em; overflow: hidden; border-radius: .8em; background: radial-gradient(ellipse 85% 75% at 45% 42%, #2F6454 0%, #1D4338 55%, #10271F 100%); box-shadow: var(--shadow), 0 0 0 1px var(--line); }
.zone { position: absolute; border: .07em solid rgba(255,255,255,.13); border-radius: .35em; }
.zone.z1 { left: 3.6em; top: 3.4em; width: 6.4em; height: 8.9em; }
.zone.z2 { left: 12.3em; top: 3.4em; width: 7.4em; height: 10em; }
.dc { position: absolute; aspect-ratio: 59 / 86; border-radius: 4% / 2.8%; box-shadow: 0 .15em .5em rgba(0,0,0,.45); }
.dc > i { position: absolute; }
.dc-back { width: 5.2em; background: radial-gradient(ellipse 30% 22% at 50% 50%, #F0C765 0 32%, #A4501D 36% 62%, transparent 66%), linear-gradient(160deg, #6E3616, #3F1A09); border: .07em solid #2A1206; }
.dc-back.set { left: 4.2em; top: 3.95em; transform: rotate(-2deg); }
.dc-wyvern { background: linear-gradient(160deg, #DC9A55 0%, #BA692E 58%, #97511F 100%); border: .06em solid #5A2F12; }
.dc-wyvern.target { left: 13.1em; top: 4.2em; width: 5.8em; transform: rotate(-4deg); }
.dc-name { left: 7%; right: 20%; top: 4.5%; height: 7%; background: linear-gradient(#FBF1DC, #E3CFA4); border-radius: .08em; }
.dc-attr { right: 7.5%; top: 4.2%; width: 10%; aspect-ratio: 1; border-radius: 50%; background: radial-gradient(circle at 35% 35%, #FFF6C8, #E4C04A 60%, #A8841C); }
.dc-stars { right: 9%; top: 13%; width: 60%; height: 4.2%; background: radial-gradient(circle, #F6C842 0 36%, #7A4E0E 40% 46%, transparent 50%) 0 0 / calc(100% / 7) 100% repeat-x; }
.dc-art { left: 12%; right: 12%; top: 19%; aspect-ratio: 1; overflow: hidden; background: radial-gradient(circle at 72% 28%, #FFF1B8 0 10%, transparent 11%), linear-gradient(180deg, #2A2966 0%, #6C4A93 48%, #E79C5A 100%); box-shadow: inset 0 0 0 .05em rgba(40,20,10,.6); }
.dc-art::before { content: ""; position: absolute; inset: 0; background: #2A1C3F; clip-path: polygon(0 100%, 0 80%, 20% 66%, 36% 80%, 58% 60%, 78% 77%, 100% 67%, 100% 100%); }
.dc-art::after { content: ""; position: absolute; inset: 0; background: #1B1330; clip-path: polygon(8% 44%, 30% 36%, 42% 46%, 50% 22%, 58% 46%, 70% 36%, 92% 44%, 66% 56%, 54% 54%, 50% 70%, 46% 54%, 34% 56%); }
.dc-text { left: 7%; right: 7%; bottom: 4.5%; height: 21%; padding: 5% 7%; background: repeating-linear-gradient(to bottom, transparent 0 17%, rgba(80,55,25,.3) 17% 24%) content-box, #F2E6CB; }

/* the gold box, the rest of the frozen frame dimmed around it */
.demo-sel { position: absolute; left: 12.4em; top: 3.62em; width: 6.76em; height: 9.66em; border: .12em solid #E7B955; border-radius: .25em; box-shadow: 0 0 0 1px rgba(0,0,0,.35), 0 0 .9em rgba(231,185,85,.45), 0 0 0 60em rgba(4,10,12,.42); transform-origin: 0 0; }

/* the pointer that clicked the card */
.demo-cursor { position: absolute; left: 16.2em; top: 8.6em; width: 1.05em; height: 1.58em; overflow: visible; filter: drop-shadow(0 .08em .18em rgba(0,0,0,.5)); }
.demo-cursor path { fill: #fff; stroke: #111; stroke-width: 1.1; stroke-linejoin: round; }

/* scan mode's bar, at the top like the real one: small and dark, above the dimmed frame, and centred on
   the part of the frame the popover (from 20.6em) leaves in view */
.demo-scanbar { position: absolute; left: 10.3em; top: .7em; transform: translateX(-50%); display: flex; align-items: center; gap: .55em; padding: .32em .5em .32em .7em; border-radius: 999px; background: rgba(23,21,30,.92); border: 1px solid rgba(255,255,255,.16); color: #F4F1F9; font-size: .74em; font-weight: 600; white-space: nowrap; box-shadow: 0 .3em .9em rgba(0,0,0,.35); }
.demo-scanbar svg { width: 1.25em; height: 1.25em; color: #E7B955; }
.demo-scanbar-x { display: grid; place-items: center; width: 1.6em; height: 1.6em; border-radius: 50%; background: rgba(255,255,255,.1); color: #B8B2C7; font-size: .9em; line-height: 1; }

.demo-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2.3em; display: flex; align-items: center; gap: .8em; padding: 0 1em; background: linear-gradient(transparent, rgba(0,0,0,.55)); color: #fff; font-family: var(--f-mono); font-size: .78em; }
.demo-bar .pause { width: .75em; height: .95em; flex: none; border-left: .26em solid #fff; border-right: .26em solid #fff; }
.demo-bar .track { flex: 1; height: .24em; border-radius: .12em; background: rgba(255,255,255,.3); }
.demo-bar .track i { width: 41%; height: 100%; border-radius: inherit; background: #fff; }

/* the popover: always dark, like the real one (src/content/styles.ts) */
.dp-wrap { position: absolute; left: 20.6em; top: 4.4em; z-index: 2; width: 25em; }
/* --arrow: the box's middle, in the popover's own em (its top is 7.15em above it, at .86em) */
.dp { --arrow: 8.3em; position: relative; font-size: .86em; padding: .95em 1.05em 1.05em; border-radius: .9em; background: #17151E; color: #F4F1F9; border: 1px solid rgba(255,255,255,.13); box-shadow: 0 1.6em 4.4em rgba(0,0,0,.4), 0 .15em .45em rgba(0,0,0,.3); line-height: 1.45; }
.dp::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: .22em; border-radius: .9em .9em 0 0; background: var(--foil); background-size: 200% 100%; animation: dl-foil 7s linear infinite; }
.dp::after { content: ""; position: absolute; left: -.5em; top: calc(var(--arrow) - .45em); width: .9em; height: .9em; background: #17151E; border: 1px solid rgba(255,255,255,.13); border-top: 0; border-right: 0; transform: rotate(45deg); }
@keyframes dl-foil { to { background-position: 200% 0; } }
/* on a dark page the (always dark) popover would melt into the background: lift it a little */
@media (prefers-color-scheme: dark) { .dp { background: #211E2C; border-color: rgba(255,255,255,.2); } .dp::after { background: #211E2C; border-color: rgba(255,255,255,.2); } }
.dp-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: .7em; }
.dp-brand { display: inline-flex; align-items: center; gap: .5em; font-stretch: 75%; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; font-size: .82em; color: #B8B2C7; }
.dp-brand svg { width: 1.45em; height: 1.45em; color: #E7B955; }
.dp-x { color: #B8B2C7; font-size: 1.4em; line-height: 1; }
.dp-head { display: grid; grid-template-columns: 5.6em minmax(0, 1fr); gap: 0 1em; align-items: start; }
.dp-head .dc { position: relative; width: 5.6em; }
.dp-name { font-family: var(--f-name); font-weight: 700; font-size: 1.38em; line-height: 1.15; margin-bottom: .25em; }
.dp-type { font-stretch: 80%; font-weight: 650; font-size: .84em; letter-spacing: .07em; text-transform: uppercase; color: #B8B2C7; margin-bottom: .55em; }
.dp-facts { display: flex; flex-wrap: wrap; gap: .35em; }
.dp-fact { display: inline-flex; align-items: center; gap: .35em; padding: .12em .6em; border-radius: 999px; background: rgba(255,255,255,.08); font-size: .84em; font-weight: 620; white-space: nowrap; }
.dp-fact.mono { font-family: var(--f-mono); font-size: .8em; }
.dp-adot { width: .62em; height: .62em; border-radius: 50%; background: #E4C04A; box-shadow: 0 0 0 .1em rgba(255,255,255,.35); }
.dp-text { margin-top: .75em; font-family: var(--f-text); font-size: 1.02em; line-height: 1.5; background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.13); border-radius: .6em; padding: .55em .85em; }
.dp-foot { margin-top: .75em; padding-top: .75em; border-top: 1px solid rgba(255,255,255,.13); display: grid; gap: .6em; }
.dp-match { display: flex; align-items: center; gap: .7em; font-size: .88em; color: #B8B2C7; }
.dp-match b { color: #F4F1F9; font-weight: 650; }
.dp-meter { width: 4.7em; height: .36em; border-radius: .2em; background: rgba(255,255,255,.13); overflow: hidden; flex: none; }
.dp-meter i { width: 94%; height: 100%; background: #E7B955; }
.dp-actions { display: flex; flex-wrap: wrap; gap: .45em; }
.dp-btn { display: inline-flex; align-items: center; padding: .42em .8em; border-radius: .6em; border: 1px solid rgba(255,255,255,.13); background: rgba(255,255,255,.07); font-size: .92em; font-weight: 620; line-height: 1.2; white-space: nowrap; }

/* played once on load: the shortcut, the box, then the popover (static with reduced motion) */
@keyframes dl-demo-in { from { opacity: 0; transform: translateY(.5em); } }
@keyframes dl-demo-box { from { opacity: 0; transform: scale(.3); } }
.demo-keys { animation: dl-demo-in .4s ease-out .2s both; }
.demo-scanbar { animation: dl-demo-bar .4s ease-out .45s both; }
@keyframes dl-demo-bar { from { opacity: 0; transform: translate(-50%, -.5em); } }
.demo-sel { animation: dl-demo-box .5s cubic-bezier(.2,.7,.3,1) .7s both; }
.demo-cursor { animation: dl-demo-in .35s ease-out .9s both; }
.callout.n2 { animation: dl-demo-in .3s ease-out 1.1s both; }
.dp-wrap { animation: dl-demo-in .45s ease-out 1.4s both; }
.callout.n3 { animation: dl-demo-in .3s ease-out 1.75s both; }
`;
