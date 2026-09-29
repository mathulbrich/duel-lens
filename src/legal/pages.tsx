// The privacy policy (privacy.html) and the licences (licenses.html), bundled in the extension so they
// need no hosting (legal-audit.md B3 and B4). The policy is policy.ts, for this build's options. The
// licences page shows the files build.mjs copies into the package: THIRD_PARTY_NOTICES.md, and the
// project's LICENSE (Apache-2.0, decision D1).
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { LensIcon } from '../content/icons';
import { DISCLAIMER, LICENCES_PAGE, OPTIONS_PAGE, PRIVACY_PAGE, WELCOME_PAGE, manifestVersion } from '../welcome/links';
import { Markdown } from '../welcome/markdown';
import { PAGE_CSS } from '../welcome/theme';
import { privacyPolicy } from './policy';

function DocPage({ title, children }: { title: string; children: ComponentChildren }) {
  const version = manifestVersion();
  return (
    <div class="doc-page">
      <style>{PAGE_CSS + DOC_CSS}</style>
      <header class="doc-top">
        <a class="brand" href={WELCOME_PAGE}>
          <LensIcon />
          Duel Lens
        </a>
        <h1>{title}</h1>
      </header>
      <main class="doc">{children}</main>
      <footer class="doc-foot">
        <p>{DISCLAIMER}</p>
        <p class="foot-links">
          <a href={WELCOME_PAGE}>Welcome guide</a>
          <a href={OPTIONS_PAGE}>Options</a>
          <a href={PRIVACY_PAGE}>Privacy policy</a>
          <a href={LICENCES_PAGE}>Licences</a>
          {version ? <span>Version {version}</span> : null}
        </p>
      </footer>
    </div>
  );
}

/** privacy.html: the privacy policy, as it applies to this build (policy.ts picks the variant for its flags). */
export function PrivacyPage() {
  return (
    <DocPage title="Privacy policy">
      <Markdown source={privacyPolicy()} />
    </DocPage>
  );
}

type Loaded = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; notices: string; licence: string | null };

/** A file packaged with the extension, or null when it isn't there. */
async function packaged(file: string): Promise<string | null> {
  const res = await fetch(file);
  return res.ok ? res.text() : null;
}

/** licenses.html: Duel Lens's own licence (when the package has one), then the third-party notices. */
export function LicencesPage() {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  useEffect(() => {
    Promise.all([packaged('THIRD_PARTY_NOTICES.md'), packaged('LICENSE').catch(() => null)]).then(
      ([notices, licence]) => setLoaded(notices === null ? { state: 'failed' } : { state: 'ready', notices, licence }),
      () => setLoaded({ state: 'failed' }),
    );
  }, []);
  return (
    <DocPage title="Licences">
      {loaded.state === 'loading' ? <p class="hint">Loading…</p> : null}
      {loaded.state === 'failed' ? <p class="hint">Duel Lens couldn't load the notices. Reload this page to try again.</p> : null}
      {loaded.state === 'ready' ? (
        <>
          {loaded.licence !== null ? (
            <section class="licence">
              <h2>Duel Lens's licence</h2>
              <pre>{loaded.licence}</pre>
            </section>
          ) : null}
          <Markdown source={loaded.notices.replace(/^# Third-party notices\s*\n/, '## Third-party notices\n')} />
        </>
      ) : null}
    </DocPage>
  );
}

const DOC_CSS = /* css */ `
.doc-page { max-width: 860px; margin: 0 auto; padding: 22px 28px 48px; }
.doc-top { display: grid; gap: 8px; margin: 10px 0 18px; }
.doc-top h1 { font-family: var(--f-name); font-weight: 700; font-size: 36px; line-height: 1.1; }
.doc { display: grid; gap: 12px; font-size: 15px; }
.doc h2 { font-size: 22px; font-weight: 720; font-stretch: 90%; line-height: 1.25; margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--line); scroll-margin-top: 12px; }
.doc > h2:first-child, .licence + h2 { border-top: 0; margin-top: 0; padding-top: 0; }
.doc h3 { font-size: 17px; font-weight: 700; margin-top: 10px; scroll-margin-top: 12px; }
.doc h4 { font-size: 15px; font-weight: 700; margin-top: 6px; }
.doc p, .doc li { max-width: 70em; overflow-wrap: anywhere; }
.doc ul, .doc ol { margin: 0; padding-left: 22px; display: grid; gap: 4px; }
.doc li > ul, .doc li > ol { margin-top: 4px; }
.doc code { font-family: var(--f-mono); font-size: .88em; padding: .05em .3em; border-radius: 4px; background: var(--surface-2); }
.doc pre, .licence pre { margin: 0; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); font-family: var(--f-mono); font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.doc pre code { padding: 0; background: none; font-size: inherit; }
.doc blockquote { margin: 0; padding: 8px 14px; border-left: 3px solid var(--gold); background: var(--surface); }
.doc hr { border: 0; border-top: 1px solid var(--line); margin: 8px 0; }
.md-table { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
.md-table table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
.md-table th, .md-table td { text-align: left; vertical-align: top; padding: 7px 10px; border-bottom: 1px solid var(--line); }
.md-table tr:last-child td { border-bottom: 0; }
.md-table th { font-weight: 700; background: var(--surface-2); }
.licence { display: grid; gap: 10px; margin-bottom: 8px; }
.licence h2 { font-size: 22px; font-weight: 720; font-stretch: 90%; }
.doc-foot { display: grid; gap: 6px; margin-top: 36px; padding-top: 20px; border-top: 1px solid var(--line); font-size: 13px; color: var(--ink-2); }
.foot-links { display: flex; flex-wrap: wrap; gap: 6px 18px; }
@media (max-width: 560px) { .doc-page { padding: 18px 16px 36px; } .doc-top h1 { font-size: 30px; } }
`;
