// The stylesheet is a plain string (no CSS tooling in this test run), so these tests
// assert on the declaration text for specific selectors rather than measuring layout.
import { describe, expect, it } from 'vitest';
import { CSS } from './styles';

/** The declaration block for an exact selector, e.g. rule('.alt') -> "appearance: none; ...". */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = CSS.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`no rule found for "${selector}" in styles.ts`);
  return m[1];
}

describe('alternative-match chip: never wider than the popover', () => {
  it('lets the .alt chip shrink below its content, capped at the popover width', () => {
    const alt = rule('.alt');
    expect(alt).toMatch(/max-width:\s*100%/);
    expect(alt).toMatch(/min-width:\s*0\b/);
  });

  it('truncates the .alt name with an ellipsis instead of wrapping or overflowing', () => {
    const name = rule('.alt em');
    expect(name).toMatch(/overflow:\s*hidden/);
    expect(name).toMatch(/text-overflow:\s*ellipsis/);
    expect(name).toMatch(/white-space:\s*nowrap/);
  });

  it('keeps the .alt score badge from shrinking or being cut off', () => {
    const score = rule('.alt b');
    expect(score).toMatch(/flex:\s*none/);
  });

  it('lets the .dv-alts row itself shrink, so an unbreakable chip cannot balloon the popover', () => {
    // Without this, .dv-alts (a grid item of .dv-foot/.unsure) grows to fit an unbreakable
    // chip's content width instead of the popover's, and .alt's own min-width: 0 never gets
    // the chance to apply — confirmed with a real headless-Chrome render (test/demo-out).
    const dvAlts = rule('.dv-alts');
    expect(dvAlts).toMatch(/min-width:\s*0\b/);
  });
});

describe('click to scan: outlines on the frozen frame', () => {
  it('shows a pointer over a detected card (the layer marks itself on-card)', () => {
    expect(rule('.layer.on-card')).toMatch(/cursor:\s*pointer/);
  });

  it('never lets the outlines catch the pointer, so a drag can start anywhere', () => {
    expect(rule('.cards')).toMatch(/pointer-events:\s*none/);
  });
});

describe('the bar (UX-1)', () => {
  it('can sit at the bottom of the frame instead of the top', () => {
    expect(rule('.bar.low')).toMatch(/bottom:\s*\d+px/);
    expect(rule('.bar.low')).toMatch(/top:\s*auto/);
  });

  it('takes the pointer (its ✕), unlike the rest of the overlay above the frame', () => {
    expect(rule('.bar')).toMatch(/pointer-events:\s*auto/);
  });

  it('gives its ✕ a target of 24 px or more each way (WCAG 2.5.8)', () => {
    const [w, h] = [/width:\s*(\d+)px/, /height:\s*(\d+)px/].map((re) => Number(rule('.bar .x').match(re)?.[1]));
    expect(Math.min(w, h)).toBeGreaterThanOrEqual(24);
  });
});

describe('the hover preview (UX-2)', () => {
  it('takes the pointer, so it can be moved onto (WCAG 1.4.13, hoverable)', () => {
    expect(rule('.pv')).toMatch(/pointer-events:\s*auto/);
  });

  it('stays hidden until it is placed', () => {
    expect(rule('.pv.measuring')).toMatch(/visibility:\s*hidden/);
  });
});

describe('focus (a11y review B1, B2)', () => {
  it('draws no ring around the dialogs that take focus themselves (the frozen frame, the popover)', () => {
    expect(rule('.layer:focus, .pop:focus')).toMatch(/outline:\s*none/);
  });

  it('bumps a focused outline (p2), on top of lighting it', () => {
    expect(rule('.cards rect:focus-visible')).toMatch(/stroke-width:\s*[3-9]/);
  });
});

describe('outlines you can see (live check M1)', () => {
  it('draws a bright 2 px line over a dark 4 px one', () => {
    const line = rule('.cards rect');
    expect(line).toMatch(/stroke:\s*#FFD46B/i);
    expect(line).toMatch(/stroke-width:\s*2\b/);
    expect(line).toMatch(/fill:\s*none/);
    const under = rule('.cards rect.under');
    expect(under).toMatch(/stroke:\s*rgba\(0,\s*0,\s*0,\s*\.65\)/);
    expect(under).toMatch(/stroke-width:\s*4\b/);
  });

  it('dims the frame with the spotlight as much as the plain dim, and never takes the pointer', () => {
    expect(rule('.spotlight')).toMatch(/pointer-events:\s*none/);
    expect(rule('.spotlight .shade')).toMatch(/fill:\s*rgba\(4,\s*10,\s*12,\s*\.5\)/);
    expect(rule('.dim')).toMatch(/background:\s*rgba\(4,\s*10,\s*12,\s*\.5\)/);
  });
});

describe('two clicks (a11y review M1)', () => {
  it('marks the first corner without taking the pointer', () => {
    expect(rule('.corner')).toMatch(/pointer-events:\s*none/);
  });
});
