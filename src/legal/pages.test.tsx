// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LicencesPage, PrivacyPage } from './pages';

const NOTICES = readFileSync(path.join(process.cwd(), 'THIRD_PARTY_NOTICES.md'), 'utf8');

beforeEach(() => {
  vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '1.2.3' }) } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PrivacyPage (privacy.html)', () => {
  it('shows the whole policy inside the extension, with the first-run consent', () => {
    render(<PrivacyPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy policy' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: '1. The page you\'re viewing' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: '10. Contact' })).toBeTruthy();
    expect(screen.getByText(/Before your first scan, Duel Lens shows what it handles/)).toBeTruthy();
    expect(document.body.textContent).toContain('images.ygoprodeck.com'); // this test build has remote images
  });

  it('describes the crop build (--no-remote-images) without the developer options: no card images from YGOPRODeck, and no "Save crops"', () => {
    vi.stubGlobal('__DUEL_LENS_REMOTE_IMAGES__', false);
    vi.stubGlobal('__DUEL_LENS_DEV__', false);
    render(<PrivacyPage />);
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('images.ygoprodeck.com');
    expect(text).not.toContain('Save crops');
    expect(text).toContain('Card data comes from YGOPRODeck.');
  });

  it('links to the licences, the welcome guide and Options', () => {
    render(<PrivacyPage />);
    expect(screen.getByRole('link', { name: 'Licences' }).getAttribute('href')).toBe('licenses.html');
    expect(screen.getByRole('link', { name: 'Welcome guide' }).getAttribute('href')).toBe('welcome.html');
  });
});

describe('LicencesPage (licenses.html)', () => {
  function serve(files: Record<string, string>) {
    const fetchMock = vi.fn(async (url: string) =>
      url in files ? new Response(files[url], { status: 200 }) : new Response('not found', { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('shows the third-party notices that ship in the package', async () => {
    const fetchMock = serve({ 'THIRD_PARTY_NOTICES.md': NOTICES });
    render(<LicencesPage />);

    expect(await screen.findByRole('heading', { level: 2, name: '1. Summary' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: '8.1 Apache License 2.0' })).toBeTruthy();
    // The card detector's model ships in every build: its notice is there too.
    expect(screen.getByRole('heading', { level: 3, name: /^2\.2 Card detector/ })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('THIRD_PARTY_NOTICES.md');
    // A package without LICENSE (the release refuses one, but the page mustn't break): no empty section.
    expect(screen.queryByRole('heading', { name: "Duel Lens's licence" })).toBeNull();
  });

  it("shows Duel Lens's own licence first, when the package has one", async () => {
    serve({ 'THIRD_PARTY_NOTICES.md': NOTICES, LICENSE: 'Apache License\nVersion 2.0, January 2004' });
    render(<LicencesPage />);

    expect(await screen.findByRole('heading', { name: "Duel Lens's licence" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.licence pre')?.textContent).toBe('Apache License\nVersion 2.0, January 2004'));
  });

  it('says so when the notices cannot be read', async () => {
    serve({});
    render(<LicencesPage />);

    expect(await screen.findByText(/couldn't load the notices/i)).toBeTruthy();
  });
});
