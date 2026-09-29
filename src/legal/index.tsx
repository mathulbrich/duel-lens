// Entry of legal.js, shared by privacy.html and licenses.html: each page names itself in
// <body data-page>.
import { render } from 'preact';
import { LicencesPage, PrivacyPage } from './pages';

const root = document.getElementById('app');
if (root) render(document.body.dataset.page === 'licenses' ? <LicencesPage /> : <PrivacyPage />, root);
