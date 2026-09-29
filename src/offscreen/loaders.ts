// What the offscreen document loads, and when: each message loads only what it needs, once.
// - a scan (and warm-up) loads the whole engine: the embedding model, the index and the card
//   detector when one is registered (load-engine.ts);
// - detect-cards (click to scan) loads the card detector alone; the engine's scans share that load;
// - index-missing reads the bundled index's metadata alone (the local delta is read by the
//   updater), no model session, so a daily check doesn't cost that memory;
// - embed-artworks loads the embedding model alone, plus the card back's vector from the
//   bundled index (the placeholder check, placeholder-art.ts).
// The embedding model is loaded once and shared: a scan after an embed-artworks message reuses
// its session instead of creating a second one.
import { decodeIndex, type IndexMeta, type LoadedIndex } from '../shared/index-format';
import type { CardDetector } from './detect-cards';
import type { Embedder, Engine } from './engine';
import { loadEngine, type EngineSources } from './load-engine';
import { cardBackVector } from './placeholder-art';

export interface LoaderSources extends Omit<EngineSources, 'loadIndex'> {
  /** A file packaged with the extension; rejects with a readable error when it is missing. */
  packaged(path: string): Promise<Response>;
}

export interface OffscreenLoaders {
  /** The whole engine, for scans (a new load each call; the handler keeps the one it made). */
  loadEngine(): Promise<Engine>;
  /** The bundled index's metadata: which artworks it covers (no vectors, no model). */
  loadIndexMeta(): Promise<IndexMeta>;
  /** The embedding model alone. */
  loadEmbedder(): Promise<Embedder>;
  /** The card back's vector in the model's space (the bundled index's entry); null without one. */
  loadCardBack(): Promise<Float32Array | null>;
  /**
   * The card detector, when one is registered: loaded once, for click to scan (the offscreen
   * handler's detect-cards) and for every scan's crop (the engine) alike. A failed load is tried
   * again next time.
   */
  loadCardDetector?(): Promise<CardDetector>;
}

/** Remembers a load's promise; a failed load is forgotten, so the next call tries again. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | null = null;
  return () => {
    if (!loading) {
      const attempt = load();
      loading = attempt;
      attempt.catch(() => {
        if (loading === attempt) loading = null;
      });
    }
    return loading;
  };
}

export function createLoaders(src: LoaderSources): OffscreenLoaders {
  const base = `data/index-${src.spec.id}`;
  const loadIndexMeta = once(async () => (await (await src.packaged(`${base}.meta.json`)).json()) as IndexMeta);
  const loadEmbedder = once(() => src.createEmbedder(src.spec));
  const loadCardDetector = src.loadCardDetector && once(src.loadCardDetector);
  const loadIndex = async (): Promise<LoadedIndex> => {
    const [bin, meta] = await Promise.all([src.packaged(`${base}.bin`).then((r) => r.arrayBuffer()), loadIndexMeta()]);
    return decodeIndex(bin, meta);
  };
  return {
    loadEngine: () => loadEngine({ ...src, createEmbedder: () => loadEmbedder(), loadIndex, loadCardDetector }),
    loadIndexMeta,
    loadEmbedder,
    // One vector kept; the rest of the index is dropped once it is read.
    loadCardBack: once(async () => cardBackVector(await loadIndex())),
    ...(loadCardDetector ? { loadCardDetector } : {}),
  };
}
