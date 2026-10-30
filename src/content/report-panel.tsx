// "Report" (src/content/popover.tsx): sends this read to the Duel Lens issue tracker on GitHub (shared/report.ts), as a
// public issue the report relay opens, no account needed. It first lists exactly what goes (the picture, the card shown,
// the video at that moment, the comment, the version and browser), and sends only on the user's own click (byUser).
// After that: the issue's number and a link to it, or what went wrong. Firefox needs the user's consent first, given
// in Options (background/report.ts): the panel says so and offers Options.
import { useState } from 'preact/hooks';
import { sendToBackground } from '../shared/messages';
import { t } from '../shared/i18n';
import { REPORT_COMMENT_MAX, reportClock, reportVideo, type ReportCardResponse, type ReportDraft, type ReportError } from '../shared/report';
import { byUser, fromUser } from './trusted';

export interface ReportPanelProps {
  /** The report without its comment (the popover builds it from the read). */
  draft: Omit<ReportDraft, 'comment'>;
  onOpenOptions?(): void;
}

const ERROR_TEXT: Record<ReportError, () => string> = {
  consent: () => t('popover_report_error_consent'),
  'rate-limited': () => t('popover_report_error_rate'),
  'daily-limit': () => t('popover_report_error_daily'),
  paused: () => t('popover_report_error_failed'),
  unavailable: () => t('popover_report_error_failed'),
  invalid: () => t('popover_report_error_failed'),
  network: () => t('popover_report_error_network'),
};

export function ReportPanel({ draft, onOpenOptions }: ReportPanelProps) {
  const [comment, setComment] = useState('');
  const [state, setState] = useState<{ kind: 'editing' | 'sending' } | { kind: 'done'; answer: ReportCardResponse }>({ kind: 'editing' });
  const video = reportVideo(draft.pageUrl, draft.videoTime);

  const send = async () => {
    setState({ kind: 'sending' });
    let answer: ReportCardResponse;
    try {
      answer = await sendToBackground({ type: 'report-card', report: { ...draft, comment: comment.trim().slice(0, REPORT_COMMENT_MAX) } });
      if (!answer || typeof answer.ok !== 'boolean') answer = { ok: false, error: 'unavailable' };
    } catch {
      answer = { ok: false, error: 'unavailable' };
    }
    setState({ kind: 'done', answer });
  };

  if (state.kind === 'done' && state.answer.ok) {
    const { issue } = state.answer;
    return (
      <div class="dv-report" role="status">
        <p class="note">{t('popover_report_sent', String(issue.number))}</p>
        <div class="dv-actions">
          <a
            class="btn"
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              if (!fromUser(e)) e.preventDefault();
            }}
          >
            {t('popover_report_view')}
          </a>
        </div>
      </div>
    );
  }

  const failed = state.kind === 'done' && !state.answer.ok ? state.answer.error : null;
  return (
    <div class="dv-report" role="group" aria-label={t('popover_report_button')}>
      <p class="note">{t('popover_report_lead')}</p>
      <ul class="dv-report-list">
        <li>{t('popover_report_item_picture')}</li>
        <li>{draft.shown ? t('popover_report_item_card', draft.shown.name) : t('popover_report_item_no_match')}</li>
        {draft.userCard ? <li>{t('popover_report_item_user_card', draft.userCard.name)}</li> : null}
        {video ? <li>{video.time !== null ? t('popover_report_item_video', reportClock(video.time), video.url) : t('popover_report_item_page', video.url)}</li> : null}
        <li>{t('popover_report_item_app')}</li>
      </ul>
      <textarea
        class="dv-report-comment"
        value={comment}
        maxLength={REPORT_COMMENT_MAX}
        rows={3}
        aria-label={t('popover_report_comment_label')}
        placeholder={t('popover_report_comment_placeholder')}
        onInput={(e) => setComment((e.target as HTMLTextAreaElement).value)}
        // Typing here is the user's, not the page's: a video page's own keys (YouTube's F, K, M, digits) never see it.
        onKeyDown={(e) => e.stopPropagation()}
        onKeyUp={(e) => e.stopPropagation()}
        onKeyPress={(e) => e.stopPropagation()}
        disabled={state.kind === 'sending'}
      />
      <p class="note">{t('popover_report_public_note')}</p>
      <div class="dv-actions">
        <button type="button" class="btn gold" disabled={state.kind === 'sending'} onClick={byUser(() => void send())}>
          {state.kind === 'sending' ? t('popover_report_sending') : t('popover_report_send')}
        </button>
        {failed === 'consent' && onOpenOptions ? (
          <button type="button" class="btn" onClick={byUser(() => onOpenOptions())}>
            {t('popover_open_options_button')}
          </button>
        ) : null}
      </div>
      {failed ? (
        <p class="note err" role="alert">
          {ERROR_TEXT[failed]()}
        </p>
      ) : null}
    </div>
  );
}
