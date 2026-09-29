import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  // Unit tests see the E2E-only hooks (src/build-flags.d.ts). Vitest defines these as writable
  // globals, so a test can vi.stubGlobal('__DUEL_LENS_REMOTE_IMAGES__', false) for the store mode.
  define: { __DUEL_LENS_E2E__: 'true', __DUEL_LENS_DEV__: 'true', __DUEL_LENS_REMOTE_IMAGES__: 'true', __DUEL_LENS_DETECTOR__: 'true' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tools/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // UI tests opt in per file with: // @vitest-environment happy-dom
    testTimeout: 20000,
  },
});
