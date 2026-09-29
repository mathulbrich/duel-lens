// Builds the recognition engine for the offscreen document: loads the embedding model, the
// index (merged with the artworks embedded on this computer since install) and, when one is
// registered, the card detector (the one click to scan uses, which finds the card in every scan's
// crop). Priming (a run of the embedding model, so a scan doesn't pay its first-run cost) is not
// part of the load: the handler runs engine.primeSteps() afterwards as queued jobs that let a
// waiting scan go first.
import type { LoadedIndex } from '../shared/index-format';
import type { EmbeddingModelSpec } from '../shared/models';
import { clearDelta, clearOtherModels, loadDelta, mergeIndex, type DeltaEntry } from './delta-index';
import type { CardDetector } from './detect-cards';
import { elapsedMs } from './elapsed';
import { createEngine, type Embedder, type Engine } from './engine';

/** The local artwork delta (delta-index.ts), injectable for tests. */
export interface DeltaStore {
  load(modelId: string): Promise<DeltaEntry[]>;
  clearOtherModels(keepModelId: string): Promise<void>;
  /** Deletes every entry of one model (a delta that doesn't fit the bundled index). */
  clear(modelId: string): Promise<void>;
}

export interface EngineSources {
  spec: EmbeddingModelSpec;
  createEmbedder: (spec: EmbeddingModelSpec) => Promise<Embedder>;
  loadIndex: (spec: EmbeddingModelSpec) => Promise<LoadedIndex>;
  /**
   * The card detector (detect-cards.ts), the same one click to scan uses: pass the loader the
   * offscreen handler gets, so both share one load (loaders.ts). Optional: when absent or failing,
   * scans match the user's box as drawn.
   */
  loadCardDetector?: () => Promise<CardDetector>;
  /** Default: delta-index.ts's IndexedDB store. */
  delta?: DeltaStore;
}

const indexedDbDelta: DeltaStore = { load: loadDelta, clearOtherModels, clear: clearDelta };

/**
 * The bundled index with the local delta merged in. A delta that doesn't fit it (mergeIndex
 * throws: a vector of another size, a bundled index that isn't int8) must not stop the engine
 * from loading, and must not fail the next load either: the bundled index is searched alone,
 * and this model's delta is cleared (the self-updating index re-embeds those artworks).
 */
function withDelta(bundled: LoadedIndex, entries: DeltaEntry[], delta: DeltaStore, modelId: string): LoadedIndex {
  try {
    return mergeIndex(bundled, entries);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.error(`[DuelLens] the local artwork delta doesn't fit the bundled index (${why}); searching the bundled index alone and clearing the delta`, e);
    void Promise.resolve()
      .then(() => delta.clear(modelId))
      .catch((err: unknown) => console.warn('[DuelLens] could not clear the local artwork delta', err));
    return bundled;
  }
}

/**
 * Load everything the engine needs. The embedding model and the index are required; the card
 * detector and the local delta are not: without the card detector the embedding matcher uses the
 * user's box as drawn, and without the delta the bundled index is searched alone.
 */
export async function loadEngine(src: EngineSources): Promise<Engine> {
  const start = performance.now();
  /** When each part finished loading, in ms since the start (for the "engine ready" log). */
  const parts: Record<string, number> = {};
  const mark = (name: string) => {
    parts[name] = elapsedMs(start);
  };
  const delta = src.delta ?? indexedDbDelta;
  const detectorLoading: Promise<CardDetector | null> = src.loadCardDetector
    ? src.loadCardDetector().then(
        (d) => (mark('detector'), d),
        (e: unknown) => {
          console.warn("[DuelLens] the card detector failed to load; scans match the user's box as drawn", e);
          return null;
        },
      )
    : Promise.resolve(null);

  const embedderLoading = src.createEmbedder(src.spec).then((e) => (mark('embedder'), e));
  const indexLoading = src.loadIndex(src.spec).then((i) => (mark('index'), i));
  // Artworks embedded on this computer (self-updating index). A small IndexedDB read, not on
  // the critical path; if it fails, the bundled index is searched alone.
  const deltaLoading = delta.load(src.spec.id).then(
    (d) => (mark('delta'), d),
    (e: unknown): DeltaEntry[] => {
      console.warn('[DuelLens] the local artwork delta failed to load; searching the bundled index only', e);
      return [];
    },
  );
  // Entries embedded with another model are useless in this one's space (a new default model,
  // an override): free their storage. Fire and forget, once per load.
  void Promise.resolve()
    .then(() => delta.clearOtherModels(src.spec.id))
    .catch((e: unknown) => console.warn("[DuelLens] could not prune another model's local artwork delta", e));

  // The card detector isn't released when the rest fails to load: click to scan shares it.
  const [embedder, bundled] = await Promise.all([embedderLoading, indexLoading]);
  const index: LoadedIndex = withDelta(bundled, await deltaLoading, delta, src.spec.id);
  const detector = await detectorLoading;
  const engine: Engine = createEngine({ embedder, index, spec: src.spec, detector });
  console.debug('[DuelLens] engine ready', {
    model: src.spec.id,
    detector: detector ? 'on' : 'off',
    artworks: index.meta.count,
    loadMs: elapsedMs(start),
    parts,
  });
  return engine;
}
