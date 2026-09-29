// Shared constants for tools/realset/** and tools/eval-real.ts. A side-effect-free module so it
// can be imported anywhere without pulling in eval-real.ts's top-level run.

/** The teacher labels' accept gate (provenance, lib/types.ts): a teacher pseudo-label was trustworthy at
 * teacherRatio >= 5 (0 wrong answers above it in 64 runs); below it, still recorded, but uncertain. */
export const RATIO_GATE = 5;

/** The duel productions the real frames come from, told apart by the frame name's prefix. */
export const PRODUCTIONS = [
  'YCS Paris 2026',
  'WC 2026',
  'WCQ Stuttgart 2026',
  'TSC locals',
  'Houston regional',
  'YCS Columbus',
  'Deck-profile close-up',
  'DarkLaw locals',
] as const;
export type Production = (typeof PRODUCTIONS)[number];

/** A real frame's production, from its file-name prefix (data/debug/frames/native-<prefix>-…). */
const PREFIXES: [string, Production][] = [
  ['native-wcq-', 'WCQ Stuttgart 2026'], // the WCQ Stuttgart 2026 recap (UnitedGosus)
  ['native-wc-', 'WC 2026'], // the World Championship 2026 stream, Day 2
  ['native-tsc-', 'TSC locals'], // Team Solemn Circus locals
  ['native-hgg720-', 'Houston regional'], // the same regional at 720p
  ['native-hgg-', 'Houston regional'], // Houston Game Guys regional
  ['native-ycsc-', 'YCS Columbus'], // YCS Columbus, Day 2
  ['native-dp-', 'Deck-profile close-up'], // a hand-held deck-profile close-up (keystone)
  ['native-dlaw-', 'DarkLaw locals'], // DarkLaw locals, filmed at an angle
];

/** Anything without a known prefix is the YCS Paris 2026 streams (Genesys and main). */
export function productionOf(frame: string): Production {
  for (const [prefix, production] of PREFIXES) if (frame.startsWith(prefix)) return production;
  return 'YCS Paris 2026';
}
