// Links and small print shared by Duel Lens's own pages (welcome, Options, privacy, licences).
import type { ComponentChildren } from 'preact';

/**
 * Shown on every Duel Lens page. The reviewed release wording lives in docs/release/disclaimers.md
 * (copy.ts has all of it; copy.test.ts keeps them in step).
 */
export { DISCLAIMER } from './copy';

export const YGOPRODECK_URL = 'https://ygoprodeck.com/';
/** Where to create an Anthropic API key (the Claude Console). */
export const ANTHROPIC_KEYS_URL = 'https://platform.claude.com/settings/keys';
export const ANTHROPIC_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';

/** The extension's own pages, relative so they resolve from any page of the extension. */
export const OPTIONS_PAGE = 'options.html';
export const WELCOME_PAGE = 'welcome.html';
/** The welcome page's first-run consent step (src/welcome/consent.tsx). */
export const CONSENT_PAGE = 'welcome.html#consent';
/**
 * The privacy policy and the licences, bundled in the extension (src/legal), so they need no
 * hosting. The store listing still needs the policy at a public URL (legal-audit.md, decision D5).
 */
export const PRIVACY_PAGE = 'privacy.html';
export const LICENCES_PAGE = 'licenses.html';

/** A link to another site, opened in a new tab. */
export function ExternalLink({ href, children }: { href: string; children: ComponentChildren }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** The extension's version from its manifest, or null where there is none to read. */
export function manifestVersion(): string | null {
  try {
    return chrome.runtime.getManifest?.().version ?? null;
  } catch {
    return null;
  }
}
