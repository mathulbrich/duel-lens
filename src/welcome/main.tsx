import { render } from 'preact';
import { t, uiLang } from '../shared/i18n';
import { Welcome } from './app';

// The page in the interface's language (src/shared/i18n.ts): its lang, and its tab's title.
document.documentElement.lang = uiLang();
document.title = t('welcome_eyebrow');

const root = document.getElementById('app');
if (root) render(<Welcome />, root);
