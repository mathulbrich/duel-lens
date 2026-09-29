import { render } from 'preact';
import { Welcome } from './app';

const root = document.getElementById('app');
if (root) render(<Welcome />, root);
