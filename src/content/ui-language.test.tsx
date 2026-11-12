// @vitest-environment happy-dom
// The words the page's script builds once (its messages, the box's states, the Link arrows' names) are read when they
// are shown, not when the script loads: the interface language's words arrive from the background a moment after the
// script starts (index.ts, live-check-state), and again when Options changes it (ui-language).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { setUiMessages } from '../shared/i18n';
import { CARD_TEXT_COPY } from '../shared/card-languages';
import { mergeCatalogs } from '../shared/ui-language';
import { MESSAGES } from './app';
import { boardPanelClosed } from './board';
import { CardView } from './card-view';
import { COPY } from './popover';
import { PREVIEW_COPY } from './preview';
import { TALKER } from './test-fixtures';

const localesDir = path.resolve(__dirname, '../../extension/_locales');
const read = (l: string) => JSON.parse(readFileSync(path.join(localesDir, l, 'messages.json'), 'utf8'));
const de = read('de') as Record<string, { message: string }>;

afterEach(() => {
  cleanup();
  setUiMessages(null);
});

describe('the page script’s words follow the interface language after it loaded', () => {
  it('speaks German once the words arrive, and English again when they go', () => {
    expect(COPY.scanning).toBe('Matching artwork…');
    setUiMessages({ locale: 'de', messages: mergeCatalogs(read('de'), read('en')) });
    expect(COPY.scanning).toBe(de.content_matching_artwork.message);
    expect(COPY.nothing).toBe(de.popover_no_match.message);
    expect(MESSAGES.disconnected).toBe(de.content_disconnected.message);
    expect(PREVIEW_COPY.none).toBe(de.preview_no_match.message);
    expect(CARD_TEXT_COPY.englishName).toBe(de.card_view_english_name_label.message);
    expect(boardPanelClosed()).toBe(de.bg_board_panel_closed.message);
    const { container } = render(<CardView card={TALKER} imageDataUrl={null} />);
    expect(container.querySelector('.link-icon')?.getAttribute('aria-label')).toContain(de.card_arrow_top.message);
    setUiMessages(null);
    expect(COPY.scanning).toBe('Matching artwork…');
  });
});
