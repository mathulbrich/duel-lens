// Pure message router: every ToBackground message is handled here, against an
// injected `deps` object, so the whole thing is testable without a real chrome.*
// runtime. index.ts wires the real chrome.runtime.onMessage listener to this.
import { displayCandidates, displayImageId, isAltArtwork } from '../shared/alt-artwork';
import { t } from '../shared/i18n';
import { getModel } from '../shared/models';
import { getConsent, grantConsent } from './consent';
import { ANTHROPIC_ORIGIN } from '../shared/hosts';
import type {
  AskAiResponse,
  GetCardsResponse,
  GetImageResponse,
  OkResponse,
  RecognizeResponse,
  ResponseFor,
  StatusResponse,
  ToBackground,
} from '../shared/messages';
import { matchName } from '../shared/names';
import { CARD_BACK_ID, type CardRecord, type CropPayload, type HistoryEntry, type RecognitionResult, type Settings } from '../shared/types';
import { BOARD_KEY, BOARD_PANEL_CLOSED, validBoard, type StoredBoard } from '../content/board';
import { buildAnthropicClient, identifyWithAi, testAi, type AnthropicLike } from './ai';
import * as cardStoreModule from './card-store';
import type { CropRecord } from './card-store';
import * as historyModule from './history';
import { localizeCards } from './card-text';
import { getImageDataUrl, type ImageSize } from './image-cache';
import { getIndexDeltaCount, getIndexUpdateStatus, runIndexUpdate, type IndexUpdateStatus } from './index-update';
import { recognizeViaOffscreen } from './offscreen-client';
import { getSettings } from './settings';
import { makeThumbnail } from './thumbnail';

export interface RouterDeps {
  cardStore: {
    getCards: (ids: number[]) => Promise<Record<number, CardRecord>>;
    getAllNames: () => Promise<{ id: number; name: string }[]>;
    getMeta: () => Promise<{ dbVersion?: string; updatedAt?: string; cardCount: number }>;
    refreshIfChanged: () => Promise<'updated' | 'unchanged' | 'failed'>;
    ensureSeeded: (loadBundled: () => Promise<{ dbVersion: string; updatedAt: string; cards: CardRecord[] }>) => Promise<void>;
  };
  imageCache: {
    getImageDataUrl: (imageId: number, size: ImageSize) => Promise<string | null>;
  };
  /**
   * The cards in the chosen card text language (card-text.ts localizeCards): only what recognize and get-cards
   * send for display goes through it; ask-ai and the AI answer's name match read the card store's English.
   */
  cardText: {
    localize: (cards: Record<number, CardRecord>, lang: Settings['display']['cardLanguage']) => Promise<Record<number, CardRecord>>;
  };
  history: {
    addEntry: (entry: HistoryEntry) => Promise<void>;
    updateEntry: (id: string, patch: Partial<HistoryEntry>) => Promise<HistoryEntry | undefined>;
    setCurrent: (id: string) => Promise<void>;
    /** Keeps a small picture of the scan with its entry (the crop build, `--no-remote-images`; the side panel shows it). */
    setThumb: (id: string, dataUrl: string) => Promise<void>;
  };
  offscreen: {
    recognize: (crop: CropPayload) => Promise<RecognitionResult>;
  };
  indexUpdate: {
    /** Downloads and embeds artwork for cards the live index doesn't cover yet ("Update now"). */
    run: () => Promise<void>;
    getStatus: () => Promise<IndexUpdateStatus>;
    getDeltaCount: (modelId: string) => Promise<number>;
  };
  ai: {
    identify: typeof identifyWithAi;
    test: typeof testAi;
  };
  settings: {
    get: () => Promise<Settings>;
  };
  crops: {
    save: (record: CropRecord) => Promise<void>;
    relabel: (entryId: string, cardId: number) => Promise<void>;
  };
  sidePanel: {
    open: (opts: { windowId?: number; tabId?: number }) => Promise<void>;
  };
  /** "Read the whole board": the last board, kept for the side panel (chrome.storage.session, BOARD_KEY). */
  board: {
    save: (board: StoredBoard) => Promise<void>;
  };
  openOptionsPage: () => Promise<void>;
  anthropicClient: (apiKey: string) => AnthropicLike;
  /** Whether the user granted the optional api.anthropic.com permission (their consent to the AI check). */
  permissions: { hasAnthropic: () => Promise<boolean> };
  /** The first-run consent (consent.ts): when the user agreed, and recording it. */
  consent: { get: () => Promise<number | undefined>; grant: () => Promise<void> };
  /**
   * Whether this build uses YGOPRODeck's images (__DUEL_LENS_REMOTE_IMAGES__): the official card
   * pictures, and new cards' artwork for the self-updating index. On in every build, the store build
   * included (decision D2). Off in the crop build (`--no-remote-images`): get-image answers null
   * without a request, no artwork is downloaded, and each scan's history entry keeps a small copy of
   * the user's own crop instead (legal-audit.md B2; decisions D2 and D3).
   */
  remoteImages: boolean;
  /** A small JPEG of a crop (thumbnail.ts), kept with its history entry when remoteImages is off. */
  thumbnail: (dataUrl: string) => Promise<string>;
  now: () => number;
  newId: () => string;
}

/** The AI check's answer when the user hasn't granted (or has revoked) the api.anthropic.com permission. */
const NO_AI_PERMISSION = t('bg_no_ai_permission');

/** update-index's answer in a build without remote images (the Options page doesn't offer it there). */
const NO_ARTWORK_DOWNLOADS = t('bg_no_artwork_downloads');

const defaultDeps: RouterDeps = {
  cardStore: {
    getCards: cardStoreModule.getCards,
    getAllNames: cardStoreModule.getAllNames,
    getMeta: cardStoreModule.getMeta,
    refreshIfChanged: () => cardStoreModule.refreshIfChanged(),
    ensureSeeded: cardStoreModule.ensureSeeded,
  },
  // In the crop build (`--no-remote-images`), the image cache and the artwork downloads are referenced
  // only here, behind the flag, so esbuild leaves them, and YGOPRODeck's image host, out of background.js.
  imageCache: { getImageDataUrl: __DUEL_LENS_REMOTE_IMAGES__ ? getImageDataUrl : async () => null },
  cardText: { localize: localizeCards },
  history: {
    addEntry: historyModule.addEntry,
    updateEntry: historyModule.updateEntry,
    setCurrent: historyModule.setCurrent,
    setThumb: historyModule.setThumb,
  },
  offscreen: { recognize: recognizeViaOffscreen },
  indexUpdate: {
    run: __DUEL_LENS_REMOTE_IMAGES__ ? () => runIndexUpdate() : async () => {},
    getStatus: getIndexUpdateStatus,
    getDeltaCount: getIndexDeltaCount,
  },
  ai: { identify: identifyWithAi, test: testAi },
  settings: { get: getSettings },
  crops: { save: cardStoreModule.saveCrop, relabel: cardStoreModule.relabelCrop },
  sidePanel: { open: (opts) => chrome.sidePanel.open(opts as chrome.sidePanel.OpenOptions) },
  board: { save: (board) => chrome.storage.session.set({ [BOARD_KEY]: board }) },
  openOptionsPage: () => chrome.runtime.openOptionsPage(),
  anthropicClient: buildAnthropicClient,
  permissions: { hasAnthropic: () => chrome.permissions.contains({ origins: [ANTHROPIC_ORIGIN] }) },
  consent: { get: getConsent, grant: () => grantConsent() },
  remoteImages: __DUEL_LENS_REMOTE_IMAGES__,
  thumbnail: (dataUrl) => makeThumbnail(dataUrl),
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
};

/**
 * The crop build (`--no-remote-images`): keeps a small copy of the scan's crop with its history entry,
 * for the side panel, in the background of the answer (a failure only loses the picture).
 */
function keepThumbnail(deps: RouterDeps, entryId: string, dataUrl: string): void {
  deps
    .thumbnail(dataUrl)
    .then((thumb) => deps.history.setThumb(entryId, thumb))
    .catch((err) => console.error('Duel Lens: could not keep a picture of this scan for the side panel', err));
}

// Lazily seeds the card store before the first card read of the worker's lifetime,
// memoising the in-flight attempt so concurrent reads share one seed instead of racing
// (mirrors offscreen-client's ensureOffscreen). The memo clears once the attempt settles
// (success or failure), so a failed first seed (quota, IDB error) - previously only
// attempted in runtime.onInstalled - self-heals on the very next card read (review
// Important 1 / ledger M8), at the cost of a cheap IndexedDB count() per later read.
let seeding: Promise<void> | null = null;
function ensureSeededOnce(deps: RouterDeps): Promise<void> {
  seeding ??= deps.cardStore.ensureSeeded(cardStoreModule.loadBundledCards).finally(() => {
    seeding = null;
  });
  return seeding;
}

const SHOW_PANEL_GESTURE_ERROR = t('bg_show_panel_gesture_error');
/** Below this, an AI-identified name is treated as "not in the local database" rather
 * than risking a confidently-wrong card (spec: never show a confident wrong match). An
 * exact normalised match scores 1, so it always clears this on its own. */
const MIN_MATCH_SCORE = 0.85;

/** Runs `fn`; on a thrown/rejected error, logs it and returns `fallback` instead of
 * propagating - so one failed side effect (a storage write, a stale read) can't turn
 * an otherwise-successful response into the wrong shape for its message type. */
async function safely<T>(fn: () => Promise<T>, fallback: T, context: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(`Duel Lens: ${context} failed`, err);
    return fallback;
  }
}

/**
 * `cards` as the popover, the hover preview and the side panel show them: in the card text language (Options), each
 * card the language pack lacks in English. Any failure (no pack, a storage error) shows them all in English.
 */
function inCardLanguage(deps: RouterDeps, cards: Record<number, CardRecord>, settings: Settings | undefined): Promise<Record<number, CardRecord>> {
  const lang = settings?.display?.cardLanguage ?? 'en';
  if (lang === 'en') return Promise.resolve(cards);
  return safely(() => deps.cardText.localize(cards, lang), cards, 'show the cards in the card text language');
}

/**
 * Handles one ToBackground message and returns its response. Only the background
 * service worker ever calls this; other extension pages ignore ToBackground messages.
 */
export async function handleMessage(
  msg: ToBackground,
  sender: chrome.runtime.MessageSender,
  deps: RouterDeps = defaultDeps,
): Promise<ResponseFor<ToBackground>> {
  switch (msg.type) {
    case 'recognize': {
      // Never let a crashed/unreachable offscreen document reject this whole handler:
      // ToContent/ToBackground callers of 'recognize' expect a RecognizeResponse back,
      // so a failure is reported through RecognitionResult.error (which the popover
      // already knows how to show - spec §6, "Model or index fails to load") rather
      // than an exception that would reach index.ts's generic catch-all with the
      // wrong response shape.
      let result: RecognitionResult;
      try {
        result = await deps.offscreen.recognize(msg.crop);
      } catch (err) {
        result = {
          candidates: [],
          confident: false,
          faceDown: false,
          modelId: getModel().id,
          timings: {},
          error: err instanceof Error ? err.message : t('bg_recognize_failed_unexpected'),
        };
      }
      const cards = await safely(
        async () => {
          await ensureSeededOnce(deps);
          return deps.cardStore.getCards(result.candidates.map((c) => c.cardId));
        },
        {},
        'recognize: load candidate cards',
      );
      // A match on an artwork YGOPRODeck lacks (a synthetic imageId, src/shared/alt-artwork.ts) shows and records the
      // card's own YGOPRODeck image: the popover, its lists, the history entry and the side panel all read these ids.
      result = { ...result, candidates: displayCandidates(result.candidates, cards) };

      // Read once, reused below for both `aiEnabled` and the debug-crop check: the
      // content script uses `aiEnabled` to decide whether to offer "Ask AI" at all,
      // without ever seeing the settings (or the API key) itself. A failed read (or
      // AI simply not being configured) both mean "false", never a thrown error.
      // The optional api.anthropic.com permission counts too: ask-ai refuses without it
      // (the user revoked it, say), so "Ask AI" isn't offered then (final review M12).
      const settings = await safely(() => deps.settings.get(), undefined, 'recognize: read settings');
      const aiEnabled =
        Boolean(settings?.ai.enabled && settings.ai.apiKey) &&
        (await safely(() => deps.permissions.hasAnthropic(), false, 'recognize: check the AI permission'));

      // A hover preview (UX-2) is a peek, `record: false`: the same answer as a click's read, so a click
      // can pin the previewed card from it, but it leaves nothing behind: no history entry (so no
      // `entry`, and nothing a correction could name), no thumbnail, no debug crop. Only an explicit
      // false peeks. Neither kind of read calls the AI here: only the popover's Ask AI does (ask-ai).
      const record = msg.record !== false;

      let entry: HistoryEntry | undefined;
      if (result.candidates.length > 0) {
        const top = result.candidates[0];
        if (top.cardId !== CARD_BACK_ID && !cards[top.cardId]) {
          // The engine matched a card that isn't in the local database: a failed first
          // seed, or a shipped index newer than the stored snapshot (review Important 1).
          // Distinct from "nothing plausible matched" - the popover should point at
          // Options, not report a bad scan - and no history entry is recorded for it.
          // (The card back, a face-down card's answer, has no card record by design.)
          result = { ...result, error: t('bg_card_data_not_loaded') };
        } else if (record) {
          entry = {
            id: deps.newId(),
            cardId: top.cardId,
            imageId: top.imageId,
            score: top.score,
            confident: result.confident,
            at: deps.now(),
            pageUrl: msg.context.pageUrl,
            pageTitle: msg.context.pageTitle,
            source: msg.crop.source,
          };
          if (msg.context.videoTime !== undefined) entry.videoTime = msg.context.videoTime;

          // A failed write here must not discard an otherwise-successful match (review
          // Minor 2): `result`, `cards` and `entry` are already computed above and are
          // still returned below even if persisting any of this fails.
          try {
            await deps.history.addEntry(entry);
            await deps.history.setCurrent(entry.id);
            if (!deps.remoteImages) keepThumbnail(deps, entry.id, msg.crop.dataUrl);
            if (settings?.debug.saveCrops) {
              await deps.crops.save({ dataUrl: msg.crop.dataUrl, cardId: top.cardId, at: entry.at, entryId: entry.id });
            }
          } catch (err) {
            console.error('Duel Lens: failed to record history/debug crop for this scan', err);
          }
        }
      }

      const shown = await inCardLanguage(deps, cards, settings);
      return { result, cards: shown, entry, aiEnabled } satisfies RecognizeResponse;
    }

    case 'get-cards': {
      const cards = await safely(
        async () => {
          await ensureSeededOnce(deps);
          return deps.cardStore.getCards(msg.ids);
        },
        {},
        'get-cards',
      );
      const settings = await safely(() => deps.settings.get(), undefined, 'get-cards: read settings');
      return { cards: await inCardLanguage(deps, cards, settings) } satisfies GetCardsResponse;
    }

    case 'get-image': {
      // The crop build (`--no-remote-images`) shows the user's own crop: no card image is ever fetched (the popover doesn't ask).
      if (!deps.remoteImages) return { dataUrl: null } satisfies GetImageResponse;
      const dataUrl = await safely(() => deps.imageCache.getImageDataUrl(msg.imageId, msg.size), null, 'get-image');
      return { dataUrl } satisfies GetImageResponse;
    }

    case 'correct': {
      try {
        // The popover sends the ids 'recognize' answered with (already YGOPRODeck's); a synthetic one still gets its card's image.
        const imageId = isAltArtwork(msg.imageId)
          ? displayImageId(msg.imageId, (await safely(() => deps.cardStore.getCards([msg.cardId]), {}, 'correct: load the card'))[msg.cardId])
          : msg.imageId;
        await deps.history.updateEntry(msg.entryId, { cardId: msg.cardId, imageId, corrected: true });
        await deps.crops.relabel(msg.entryId, msg.cardId);
        return { ok: true } satisfies OkResponse;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : t('bg_correct_failed') } satisfies OkResponse;
      }
    }

    case 'show-in-panel': {
      // sidePanel.open() only succeeds inside an active user gesture, and any await
      // before the call can consume it - so this is the very first thing attempted,
      // ahead of the (also-awaited) history update. A keyboard-command gesture
      // (open-panel, handled directly in index.ts) survives this; a gesture relayed
      // through a content-script message often doesn't, per Chrome's current
      // behaviour (see the report), hence the fallback hint below.
      try {
        await deps.sidePanel.open({ windowId: sender.tab?.windowId, tabId: sender.tab?.id });
        await safely(() => deps.history.setCurrent(msg.entryId), undefined, 'show-in-panel: setCurrent');
        return { ok: true } satisfies OkResponse;
      } catch {
        await safely(() => deps.history.setCurrent(msg.entryId), undefined, 'show-in-panel: setCurrent');
        return { ok: false, error: SHOW_PANEL_GESTURE_ERROR } satisfies OkResponse;
      }
    }

    case 'ask-ai': {
      try {
        if (!(await deps.permissions.hasAnthropic())) return { error: NO_AI_PERMISSION } satisfies AskAiResponse;
        await ensureSeededOnce(deps);
        const settings = await deps.settings.get();
        const candidateIds = msg.candidates.slice(0, 5).map((c) => c.cardId);
        const candidateCards = await deps.cardStore.getCards(candidateIds);
        const candidateNames = candidateIds.map((id) => candidateCards[id]?.name).filter((n): n is string => Boolean(n));

        const client = deps.anthropicClient(settings.ai.apiKey);
        const identified = await deps.ai.identify(msg.crop, candidateNames, settings, client);
        if ('error' in identified) return { error: identified.error } satisfies AskAiResponse;

        // Never map a name to a card on a weak match (spec: never show a confident
        // wrong card): require an exact normalised match, or matchName's score - which
        // is exactly 1 for an exact match - to clear MIN_MATCH_SCORE.
        const [best] = await deps.cardStore.getAllNames().then((names) => matchName(identified.name, names));
        if (!best || best.score < MIN_MATCH_SCORE) {
          return {
            answer: identified.name,
            confident: identified.confident,
            error: t('bg_ai_no_local_match', identified.name),
          } satisfies AskAiResponse;
        }

        const matchedCards = await deps.cardStore.getCards([best.id]);
        const matchedCard = matchedCards[best.id];
        return {
          cardId: best.id,
          imageId: matchedCard?.imageIds[0],
          answer: identified.name,
          confident: identified.confident,
        } satisfies AskAiResponse;
      } catch (err) {
        return { error: err instanceof Error ? err.message : t('bg_ai_check_failed_unexpected') } satisfies AskAiResponse;
      }
    }

    case 'show-board': {
      // "Read the whole board" (src/content/board.ts): the side panel opens on the board, which is kept
      // (not recorded: a board is a peek) for the panel to show. The key press sends it first, empty and
      // `reading` (the panel says "Reading the board…"), while the user's gesture lets sidePanel.open() work;
      // the final board follows once the cards are read. What the content script sent is checked first
      // (synchronously), then sidePanel.open() comes before any await, as show-in-panel's does. Without a
      // gesture it throws (the final board's, or none left): the board is kept all the same.
      const board = validBoard(msg.board);
      if (!board || (msg.reading !== undefined && (msg.reading !== true || board.length > 0))) {
        return { ok: false, error: t('bg_board_unreadable') } satisfies OkResponse;
      }
      let opened = true;
      try {
        await deps.sidePanel.open({ windowId: sender.tab?.windowId, tabId: sender.tab?.id });
      } catch {
        opened = false;
      }
      // Only cards the card data has (the panel would wait on the others' names for good). Unchecked if it can't
      // be read: the panel then says "Unknown card" for any it doesn't get.
      let known = board;
      if (board.length > 0) {
        const cards = await safely(
          async () => {
            await ensureSeededOnce(deps);
            return deps.cardStore.getCards([...new Set(board.map((c) => c.cardId))]);
          },
          null,
          'show-board: check the card ids',
        );
        if (cards) known = board.filter((c) => cards[c.cardId] !== undefined);
      }
      try {
        await deps.board.save({ cards: known, at: deps.now(), ...(msg.reading ? { reading: true as const } : {}) });
      } catch (err) {
        console.error('Duel Lens: show-board: keeping the board failed', err);
        return { ok: false, error: t('bg_board_keep_failed') } satisfies OkResponse;
      }
      return opened ? ({ ok: true } satisfies OkResponse) : ({ ok: false, error: BOARD_PANEL_CLOSED } satisfies OkResponse);
    }

    case 'open-options': {
      try {
        await deps.openOptionsPage();
        return { ok: true } satisfies OkResponse;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : t('bg_open_options_failed') } satisfies OkResponse;
      }
    }

    case 'test-ai': {
      try {
        if (!(await deps.permissions.hasAnthropic())) return { ok: false, error: NO_AI_PERMISSION } satisfies OkResponse;
        const settings = await deps.settings.get();
        const client = deps.anthropicClient(settings.ai.apiKey);
        return await deps.ai.test(settings, client);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : t('bg_test_failed_unexpected') } satisfies OkResponse;
      }
    }

    case 'refresh-cards': {
      try {
        const status = await deps.cardStore.refreshIfChanged();
        // New cards need their artwork indexed too (final review I2): start it, don't wait for it.
        // The crop build (`--no-remote-images`) downloads no artwork: new cards reach its bundled index with an update.
        if (status === 'updated' && deps.remoteImages) {
          void deps.indexUpdate.run().catch((err) => console.error('Duel Lens: index update failed', err));
        }
        return status === 'failed'
          ? ({ ok: false, error: t('bg_check_updates_failed') } satisfies OkResponse)
          : ({ ok: true } satisfies OkResponse);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : t('bg_check_updates_failed') } satisfies OkResponse;
      }
    }

    case 'update-index': {
      // Fire and forget: the run can take a while (downloading and embedding potentially
      // hundreds of artworks), and the caller (the Options page) only needs to know it
      // started - it polls get-status for progress. runIndexUpdate never throws itself.
      if (!deps.remoteImages) return { ok: false, error: NO_ARTWORK_DOWNLOADS } satisfies OkResponse;
      void deps.indexUpdate.run().catch((err) => console.error('Duel Lens: index update failed', err));
      return { ok: true } satisfies OkResponse;
    }

    case 'grant-consent': {
      try {
        await deps.consent.grant();
        return { ok: true } satisfies OkResponse;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : t('bg_consent_save_failed') } satisfies OkResponse;
      }
    }

    case 'get-status': {
      try {
        await ensureSeededOnce(deps);
        const meta = await deps.cardStore.getMeta();
        const status: StatusResponse = {
          cardCount: meta.cardCount,
          modelId: getModel().id,
        };
        if (meta.dbVersion !== undefined) status.dbVersion = meta.dbVersion;
        if (meta.updatedAt !== undefined) status.cardsUpdatedAt = Date.parse(meta.updatedAt);
        status.indexDeltaCount = await safely(() => deps.indexUpdate.getDeltaCount(status.modelId), 0, 'get-status: index delta count');
        status.indexUpdate = await safely(
          () => deps.indexUpdate.getStatus(),
          { state: 'idle' },
          'get-status: index update status',
        );
        const consentedAt = await safely(() => deps.consent.get(), undefined, 'get-status: consent');
        if (consentedAt !== undefined) status.consentedAt = consentedAt;
        return status;
      } catch {
        return { cardCount: 0, modelId: getModel().id } satisfies StatusResponse;
      }
    }
  }
}
