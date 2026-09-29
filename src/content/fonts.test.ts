import { describe, expect, it, vi } from 'vitest';
import { loadFonts, type FontDeps } from './fonts';
import { CSS } from './styles';

function fakeDeps(opts: { failFetch?: string; failLoad?: string } = {}) {
  const added: { family: string; source: unknown; descriptors?: FontFaceDescriptors }[] = [];
  class FakeFontFace {
    constructor(
      public family: string,
      public source: unknown,
      public descriptors?: FontFaceDescriptors,
    ) {}
    async load() {
      if (opts.failLoad && this.family.includes(opts.failLoad)) throw new Error('bad font data');
      return this;
    }
  }
  const deps: FontDeps = {
    getURL: vi.fn((p: string) => `chrome-extension://abc/${p}`),
    fetch: vi.fn(async (url: string) => {
      if (opts.failFetch && url.includes(opts.failFetch)) throw new TypeError('Failed to fetch');
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    }),
    FontFace: FakeFontFace as unknown as FontDeps['FontFace'],
    fonts: { add: (f: unknown) => void added.push(f as (typeof added)[number]) },
  };
  return { deps, added };
}

describe('loadFonts', () => {
  it('loads each bundled face from the extension as an ArrayBuffer (no url(), so page CSP cannot block it)', async () => {
    const { deps, added } = fakeDeps();
    await loadFonts(deps);
    expect(deps.getURL).toHaveBeenCalledWith('fonts/archivo-latin-var.woff2');
    expect(added.map((f) => [f.family, f.descriptors?.style ?? 'normal'])).toEqual([
      ['Duel Lens Archivo', 'normal'],
      ['Duel Lens Spectral SC', 'normal'],
      ['Duel Lens Source Serif 4', 'normal'],
      ['Duel Lens Source Serif 4', 'italic'],
      ['Duel Lens JetBrains Mono', 'normal'],
    ]);
    expect(added.every((f) => f.source instanceof ArrayBuffer)).toBe(true);
  });

  it('skips a face that fails to fetch or decode, and never throws', async () => {
    const { deps, added } = fakeDeps({ failFetch: 'spectral', failLoad: 'Mono' });
    await expect(loadFonts(deps)).resolves.toBeUndefined();
    expect(added.map((f) => f.family)).toEqual(['Duel Lens Archivo', 'Duel Lens Source Serif 4', 'Duel Lens Source Serif 4']);
  });

  it('does nothing where the FontFace API is missing', async () => {
    const { deps } = fakeDeps();
    await expect(loadFonts({ ...deps, fonts: undefined })).resolves.toBeUndefined();
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('uses the same family names as the stylesheet’s font stacks', async () => {
    const { deps, added } = fakeDeps();
    await loadFonts(deps);
    for (const family of new Set(added.map((f) => f.family))) expect(CSS).toContain(`"${family}"`);
  });
});
