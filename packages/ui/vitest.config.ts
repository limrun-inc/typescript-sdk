import { defineConfig } from 'vitest/config';

// Vitest config for @limrun/ui unit tests.
//
// We use jsdom as the default environment because the runtime code uses
// browser globals (window.setTimeout, window.requestAnimationFrame, etc.).
// Pure modules can opt back into the node env per-file via:
//
//   // @vitest-environment node
//
// at the top of the test file.
//
// RemoteControl compatibility tests use the real core with fake browser media
// and signaling. Live device checks still validate negotiation and playback.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: false,
  },
});
