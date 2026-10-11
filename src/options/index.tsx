import { render } from 'preact';
import { t, uiLang } from '../shared/i18n';
import { App } from './app';

// The page in the interface's language (src/shared/i18n.ts): its lang, and its tab's title.
document.documentElement.lang = uiLang();
document.title = t('options_document_title');

const root = document.getElementById('app');
if (root) render(<App />, root);
