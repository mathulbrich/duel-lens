import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  // Unit tests see the E2E-only hooks (src/build-flags.d.ts). Vitest defines these as writable
  // globals, so a test can vi.stubGlobal('__DUEL_LENS_REMOTE_IMAGES__', false) for the store mode.
  define: { __DUEL_LENS_E2E__: 'true', __DUEL_LENS_DEV__: 'true', __DUEL_LENS_REMOTE_IMAGES__: 'true', __DUEL_LENS_DETECTOR__: 'true', __DUEL_LENS_FIREFOX__: 'false', __DUEL_LENS_OPERA__: 'false' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tools/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // English strings in every test, from extension/_locales/en/messages.json (src/shared/i18n.ts).
    setupFiles: ['test/setup-i18n.ts'],
    // UI tests opt in per file with: // @vitest-environment happy-dom
    // A click a test lets through on a real link (popover.test.tsx's "the user's own click") would make
    // happy-dom load the page, a real request to ygoprodeck.com: tests never navigate.
    environmentOptions: {
      happyDOM: {
        settings: {
          navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true },
        },
      },
    },
    testTimeout: 20000,
  },
});
