// Handles the offscreen document's half of the self-updating artwork index
// (ToOffscreenIndex messages from the background - see src/shared/messages.ts): which
// artwork ids neither the bundled index nor the local delta covers yet, and embedding new
// artwork crops the background downloads into that local delta.
//
// Each message loads only what it needs (loaders.ts): index-missing reads the bundled index's
// metadata and the delta, never a model; embed-artworks loads the embedding model alone. Kept
// free of chrome.* so it's testable in isolation; handler.ts wires it to the engine's queue.
import { quantizeInt8, type IndexMeta } from '../shared/index-format';
import type { OffscreenEmbedArtworksResponse, OffscreenIndexMissingResponse, ToOffscreenIndex } from '../shared/messages';
import type { RGBAImage } from '../shared/preprocess';
import { appendDelta as appendDeltaDefault, loadDelta as loadDeltaDefault, type DeltaEntry } from './delta-index';
import { isPlaceholderArt } from './placeholder-art';



export interface EmbedArtworkItem {
  imageId: number;
  cardId: number;
  /** PNG/JPEG data URL of the full art crop, exactly like a scan's CropPayload.dataUrl. */
  dataUrl: string;
}

/** What embed-artworks loads before its first item. */
export interface Embedding {
  /**
   * Embeds images with the current model (L2-normalised vectors, in order); called with exactly
   * one image per call. The caller runs it on the engine's work queue.
   */
  embed(images: RGBAImage[]): Promise<Float32Array[]>;
  /**
   * The card back's vector in the same space: an artwork this close to it is YGOPRODeck's
   * placeholder (placeholder-art.ts) and is not indexed. Null: no check.
   */
  cardBack: Float32Array | null;
}

export interface IndexUpdaterDeps {
  /** The model currently in use; every response and delta entry is tagged with this id. */
  modelId: string;
  /** index-missing: the bundled index's metadata (the artworks it covers). */
  loadIndexMeta(): Promise<Pick<IndexMeta, 'entries'>>;
  /** embed-artworks: loads the embedding model, once, before the first item; rejects when it can't. */
  loadEmbedding(): Promise<Embedding>;
  /** Decodes a data URL into RGBA pixels, the same way a scan's crop is decoded. */
  decode(dataUrl: string): Promise<RGBAImage>;
  /** This model's local delta entries. Defaults to delta-index's loadDelta. */
  loadDelta?: (modelId: string) => Promise<DeltaEntry[]>;
  /** Persists newly-embedded vectors. Defaults to delta-index's appendDelta. */
  appendDelta?: (modelId: string, entries: DeltaEntry[]) => Promise<void>;
  /** The entries just persisted, so that an engine already loaded searches them at once. */
  onAdded?: (entries: DeltaEntry[]) => void;
}

export interface IndexUpdater {
  /** Rejects when what the message needs can't be loaded (the caller answers with an error). */
  handle(msg: ToOffscreenIndex): Promise<OffscreenIndexMissingResponse | OffscreenEmbedArtworksResponse>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type EmbedOutcome =
  | { kind: 'embedded'; entry: DeltaEntry }
  | { kind: 'placeholder'; imageId: number }
  | { kind: 'failed'; imageId: number; error: string };

export function createIndexUpdater(deps: IndexUpdaterDeps): IndexUpdater {
  const loadDelta = deps.loadDelta ?? loadDeltaDefault;
  const persist = deps.appendDelta ?? appendDeltaDefault;

  async function indexMissing(imageIds: number[]): Promise<OffscreenIndexMissingResponse> {
    const [meta, delta] = await Promise.all([deps.loadIndexMeta(), loadDelta(deps.modelId)]);
    const known = new Set([...meta.entries.map((e) => e.imageId), ...delta.map((e) => e.imageId)]);
    return { modelId: deps.modelId, missing: imageIds.filter((id) => !known.has(id)) };
  }

  /** Decodes and embeds one artwork; never throws, so one bad item can't stop the batch. */
  async function embedOne(item: EmbedArtworkItem, embedding: Embedding): Promise<EmbedOutcome> {
    try {
      const img = await deps.decode(item.dataUrl);
      const [vector] = await embedding.embed([img]);
      if (!vector) throw new Error('the embedder returned no vector for this artwork');
      if (embedding.cardBack && isPlaceholderArt(vector, embedding.cardBack)) return { kind: 'placeholder', imageId: item.imageId };
      return { kind: 'embedded', entry: { modelId: deps.modelId, imageId: item.imageId, cardId: item.cardId, vector: quantizeInt8(vector) } };
    } catch (e) {
      return { kind: 'failed', imageId: item.imageId, error: message(e) };
    }
  }

  async function embedArtworks(items: EmbedArtworkItem[]): Promise<OffscreenEmbedArtworksResponse> {
    const embedding = await deps.loadEmbedding();
    const entries: DeltaEntry[] = [];
    const failed: { imageId: number; error: string }[] = [];
    const placeholders: number[] = [];
    // One image at a time, not a single batched embed() call: the model's embedder may have
    // maxBatch 1 (dynamically-quantised int8 graphs), and going item by item means each embed
    // is its own turn on the engine's shared work queue - a scan queued mid-chunk gets to run
    // between two artworks instead of waiting for the whole chunk.
    for (const item of items) {
      const outcome = await embedOne(item, embedding);
      if (outcome.kind === 'embedded') entries.push(outcome.entry);
      else if (outcome.kind === 'placeholder') placeholders.push(outcome.imageId);
      else failed.push({ imageId: outcome.imageId, error: outcome.error });
    }
    if (entries.length > 0) {
      await persist(deps.modelId, entries);
      try {
        deps.onAdded?.(entries);
      } catch (e) {
        // They are persisted: the engine's next load merges them from the delta.
        console.warn('[DuelLens] could not add new artworks to the live index; the next load will', e);
      }
    }
    return { modelId: deps.modelId, added: entries.length, failed, ...(placeholders.length > 0 ? { placeholders } : {}) };
  }

  return {
    handle(msg: ToOffscreenIndex) {
      if (msg.type === 'index-missing') return indexMissing(msg.imageIds);
      return embedArtworks(msg.items);
    },
  };
}
