import { render } from 'preact';
import { ensureFonts } from '../content/fonts';
import { App } from './app';

// The popover's bundled fonts, for the card's details (app.tsx); until they load, or if they can't,
// the CSS font stacks fall back to system fonts.
void ensureFonts();

const root = document.getElementById('app');
if (root) render(<App />, root);
