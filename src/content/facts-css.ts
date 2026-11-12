// The card's facts (card-view.tsx CardFacts), drawn as the card draws them: shared by the overlay's stylesheet
// (styles.ts) and the side panel's (sidepanel/app.tsx). Each sets its own tokens: the ink is --ov-ink / --ov-ink-2 in
// the overlay and --ink / --ink-2 in the side panel, and both set --f-ui and --f-mono.
// The attribute icon's character is drawn in the bundled Noto Sans JP subset (fonts.ts, welcome/theme.ts), so it shows
// on a computer without a Japanese font; the system's Japanese fonts follow it in the stack.
export const FACTS_CSS = /* css */ `
.dv-facts { display: grid; gap: 6px; }
.facts-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.fact { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 650; line-height: 1.35; white-space: nowrap; color: var(--ov-ink, var(--ink)); }
.fact.mono { font-family: var(--f-mono); font-size: 11.5px; font-weight: 500; }
.fact.attr { gap: 6px; font-size: 11.5px; font-weight: 750; letter-spacing: .06em; font-stretch: 85%; }
.attr-icon { width: 18px; height: 18px; flex: none; display: inline-grid; place-items: center; border-radius: 50%; background: var(--attr, #999); box-shadow: inset 0 0 0 1.5px rgba(255,255,255,.55), 0 0 0 1px rgba(0,0,0,.45); font-style: normal; }
.attr-icon::before { content: attr(data-k); font-family: "Duel Lens Noto Sans JP", "Hiragino Sans", "Yu Gothic", "Noto Sans CJK JP", "Noto Sans JP", sans-serif; font-weight: 700; font-size: 11px; line-height: 1; letter-spacing: 0; color: #fff; text-shadow: 0 1px 1.5px rgba(0,0,0,.6); }
.fact.level { gap: 3px; color: #FFD46B; font-family: var(--f-mono); font-size: 12px; font-weight: 700; }
.fact.level .star { width: 14px; height: 14px; fill: currentColor; }
.fact.rank { color: var(--ov-ink, var(--ink)); }
.fact.rank .star { fill: #1B1922; stroke: #FFD46B; stroke-width: 1.4; }
.fact.link { gap: 6px; color: #7FC4FF; font-family: var(--f-mono); font-size: 11.5px; font-weight: 700; }
.link-icon { display: inline-flex; }
.link-grid { width: 15px; height: 15px; }
.link-grid .on { fill: #4AA8FF; }
.link-grid .off { fill: rgba(255,255,255,.14); }
.link-grid .mid { fill: rgba(255,255,255,.05); }
/* What decides whether the card can be played: its banlist status, with the mark players know, and its Genesys
   points. The only colour among the facts. */
.facts-row.legal { gap: 4px 14px; }
.fact .mark { width: 18px; height: 18px; flex: none; }
.fact.ban { gap: 6px; font-weight: 750; }
.fact.ban small { font-size: 9.5px; font-weight: 700; letter-spacing: .08em; font-stretch: 80%; color: var(--ov-ink-2, var(--ink-2)); }
.fact.forbidden { color: #FFB4AE; }
.fact.forbidden .mark-disc { fill: #E5484D; }
.fact.limited { color: #FFCC9E; }
.fact.limited .mark-disc { fill: #F07A2E; }
.fact.semi { color: #FFE9A3; }
.fact.semi .mark-disc { fill: #F2C744; }
.mark-num { stroke: #fff; }
.fact.semi .mark-num { stroke: #2A1E05; }
/* The banlist frame around a card's picture (card-view.tsx BanFrame): a ring inside the picture's edge and a band of
   marks over its bottom (the stats line, too small to read in a thumbnail; the bigger picture shows it whole). Sized
   to the picture's width, so a 64 px thumbnail and the side panel's whole-width picture both read. */
.ban-frame { position: relative; display: block; container-type: inline-size; --ban: #F07A2E; --ban-ink: #fff; }
.ban-frame.forbidden { --ban: #E5484D; }
.ban-frame.semi { --ban: #F2C744; --ban-ink: #2A1E05; }
.ban-frame::after { content: ""; position: absolute; inset: 0; border: clamp(2px, 1.4cqw, 4px) solid var(--ban); border-radius: clamp(4px, 2cqw, 6px); pointer-events: none; }
.ban-band { position: absolute; left: 0; right: 0; bottom: 0; height: clamp(12px, 8cqw, 26px); display: flex; align-items: center; justify-content: center; gap: clamp(2px, 1.2cqw, 5px); background: var(--ban); border-radius: 0 0 clamp(4px, 2cqw, 6px) clamp(4px, 2cqw, 6px); pointer-events: none; }
.band-card { height: 72%; width: auto; }
.band-card-body { fill: var(--ban-ink); }
.band-card-art { fill: var(--ban); opacity: .55; }
.band-ban { height: 86%; width: auto; }
.ban-frame.forbidden .band-ban circle, .ban-frame.forbidden .band-ban path { stroke: var(--ban-ink); }
.fact.genesys { gap: 6px; color: #CFF3FF; font-weight: 750; }
.gen-hex { fill: #3BB4E8; }
/* The card view's bottom line: its numbers under small labels (passcode, archetype, price), and its pages apart, at
   the right. The price's sources and date are in its tooltip and said to screen readers. */
.dv-meta { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 8px 16px; margin: 0; }
.dv-ids { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; min-width: 0; }
.dv-ids > div { display: grid; gap: 1px; min-width: 0; }
.dv-ids dt { font-size: 9.5px; font-weight: 700; line-height: 1.2; letter-spacing: .1em; font-stretch: 80%; text-transform: uppercase; color: var(--ov-ink-2, var(--ink-2)); }
.dv-ids dd { margin: 0; font-family: var(--f-mono); font-size: 11px; line-height: 1.35; color: var(--ov-ink, var(--ink)); overflow-wrap: anywhere; }
.dv-prices { cursor: help; }
.dv-links { display: flex; flex-wrap: wrap; gap: 2px 12px; margin: 0; font-size: 11.5px; font-weight: 600; line-height: 1.35; }
.dv-links a { color: var(--ov-gold, var(--gold)); text-decoration: none; white-space: nowrap; }
.dv-links a:hover { text-decoration: underline; text-underline-offset: .18em; }
`;
