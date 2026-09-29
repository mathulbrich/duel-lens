// Bundled fonts (extension/fonts, SIL OFL 1.1; see extension/fonts/OFL.txt).
//
// A page's CSP (YouTube's included) may refuse @font-face url()s pointing at the
// extension, so the files are fetched as ArrayBuffers and handed to the FontFace API,
// which involves no URL the page can police. Families are namespaced ("Duel Lens …")
// so they can't collide with the page's own fonts. If anything fails, the CSS font
// stacks fall back to system fonts.

export interface FontDeps {
  getURL(path: string): string;
  fetch(url: string): Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>;
  FontFace: new (family: string, source: ArrayBuffer, descriptors?: FontFaceDescriptors) => { load(): Promise<unknown> };
  fonts: { add(face: never): unknown } | undefined;
}

const FACES: { family: string; file: string; descriptors: FontFaceDescriptors }[] = [
  { family: 'Duel Lens Archivo', file: 'archivo-latin-var.woff2', descriptors: { weight: '100 900', stretch: '62% 125%' } },
  { family: 'Duel Lens Spectral SC', file: 'spectral-sc-latin-700.woff2', descriptors: { weight: '700' } },
  { family: 'Duel Lens Source Serif 4', file: 'source-serif-4-latin-var.woff2', descriptors: { weight: '400 600' } },
  {
    family: 'Duel Lens Source Serif 4',
    file: 'source-serif-4-latin-var-italic.woff2',
    descriptors: { weight: '400 600', style: 'italic' },
  },
  { family: 'Duel Lens JetBrains Mono', file: 'jetbrains-mono-latin-var.woff2', descriptors: { weight: '400 600' } },
];

export async function loadFonts(deps: FontDeps): Promise<void> {
  const { fonts } = deps;
  if (!fonts || typeof deps.FontFace !== 'function') return;
  const loaded = await Promise.all(
    FACES.map(async (f) => {
      try {
        const res = await deps.fetch(deps.getURL(`fonts/${f.file}`));
        if (!res.ok) return null;
        const face = new deps.FontFace(f.family, await res.arrayBuffer(), f.descriptors);
        await face.load();
        return face;
      } catch {
        return null; // this face falls back to the next font in the stack
      }
    }),
  );
  // Add in a stable order once all are decoded.
  for (const face of loaded) if (face) fonts.add(face as never);
}

let once: Promise<void> | undefined;

/** Load the fonts into this page once (later calls reuse the first load). */
export function ensureFonts(): Promise<void> {
  once ??= loadFonts({
    getURL: (p) => chrome.runtime.getURL(p),
    fetch: (u) => fetch(u),
    FontFace: globalThis.FontFace,
    fonts: typeof document !== 'undefined' ? (document.fonts as unknown as FontDeps['fonts']) : undefined,
  }).catch(() => undefined);
  return once;
}
