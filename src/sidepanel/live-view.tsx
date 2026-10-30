// The side panel's Live view: what Live has seen in the playing video (the background keeps the LiveLog in
// chrome.storage.session; src/shared/live.ts). A status line, the Stop / Start button, and one row per card,
// newest first: its picture, its name (opens the card in the panel), "seen N×" when it came back, and the time
// it first appeared as a gold button that jumps the video back there (also after Live stopped, while the tab is still on that page). app.tsx owns the data and the messages.
import type { JSX } from 'preact';
import { displayImageId } from '../shared/alt-artwork';
import { formatNumber, t, type MessageKey } from '../shared/i18n';
import type { LiveLog } from '../shared/live';
import type { CardRecord } from '../shared/types';
import { formatVideoTime } from './app';

/** Whether Live is still reading the video (a stopped log only stays for its list). */
function running(log: LiveLog | null): log is LiveLog {
  return log !== null && log.status !== 'stopped';
}

/** The status line: what Live is doing, or why it stopped. Empty before any Live session. */
export function liveStatusText(log: LiveLog | null): string {
  if (!log) return '';
  switch (log.status) {
    case 'watching':
      // intervalMs is the pace Live may go at, so this is the most it reads a second.
      return log.intervalMs ? t('sidepanel_live_status_watching', formatNumber(Math.round(10000 / log.intervalMs) / 10)) : t('sidepanel_live_status_starting');
    case 'slow':
      return t('sidepanel_live_status_slow', Math.round((log.intervalMs ?? 1000) / 1000));
    case 'paused':
      return t('sidepanel_live_status_paused');
    case 'stopped':
      return log.stopReason === 'left'
        ? t('sidepanel_live_status_left')
        : log.stopReason === 'blocked'
          ? t('sidepanel_live_status_blocked')
          : t('sidepanel_live_status_stopped');
    case 'blocked':
      return t('sidepanel_live_status_blocked');
    default:
      return t('sidepanel_live_status_starting');
  }
}

export function LiveView(props: {
  log: LiveLog | null;
  cards: Record<number, CardRecord>;
  images: Record<number, string>;
  /** A message key to show under the button, after the background refused to start Live. */
  hint: string | null;
  /** Whether the card's record is known not to exist (or could not be read): the row then says so instead of "Loading…". */
  isUnknown(cardId: number): boolean;
  onOpen(cardId: number): void;
  onSeek(videoTime: number): void;
  onStart(): void;
  onStop(): void;
}): JSX.Element {
  const { log, cards, images, hint } = props;
  const on = running(log);
  const entries = log?.entries ?? [];
  const voting = on ? log.voting : 0;
  const status = liveStatusText(log);
  // The tab left the logged page: its times point at another video, so they seek nothing.
  const timesOff = log?.status === 'stopped' && log.stopReason === 'left';
  return (
    <section class="live" aria-labelledby="live-heading">
      <div class="history-header">
        <h2 id="live-heading">{t('sidepanel_live_heading')}</h2>
        <button type="button" onClick={on ? props.onStop : props.onStart}>
          {on ? t('sidepanel_live_stop_button') : log ? t('sidepanel_live_restart_button') : t('sidepanel_live_start_button')}
        </button>
      </div>
      {status ? (
        <p class="live-status" aria-live="polite">
          {status}
        </p>
      ) : null}
      {voting > 0 ? <p class="live-checking">{voting === 1 ? t('sidepanel_live_checking_one') : t('sidepanel_live_checking_other', voting)}</p> : null}
      {hint ? <p class="live-hint">{t(hint as MessageKey)}</p> : null}
      {entries.length === 0 ? (
        <p class="empty">{on ? t('sidepanel_live_empty_running') : t('sidepanel_live_empty_idle')}</p>
      ) : (
        <ul class="live-list">
          {entries.map((e) => {
            const card = cards[e.cardId];
            const thumb = images[displayImageId(e.imageId, card)];
            const time = formatVideoTime(e.firstVideoTime);
            return (
              <li key={e.cardId}>
                <button type="button" class="live-item" onClick={() => props.onOpen(e.cardId)}>
                  {thumb ? <img src={thumb} alt="" /> : <span class="ph" aria-hidden="true" />}
                  <span class="name" lang={card ? (card.translated?.lang ?? 'en') : undefined}>
                    {card?.name ?? (props.isUnknown(e.cardId) ? t('sidepanel_unknown_card') : t('sidepanel_loading'))}
                  </span>
                </button>
                {e.appearances > 1 ? <span class="seen">{t('sidepanel_live_seen_count', e.appearances)}</span> : null}
                <button type="button" class="live-time" aria-label={t('sidepanel_live_jump_label', time)} disabled={timesOff} onClick={() => props.onSeek(e.firstVideoTime)}>
                  {time}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p class="live-foot">{t('sidepanel_live_foot')}</p>
    </section>
  );
}
