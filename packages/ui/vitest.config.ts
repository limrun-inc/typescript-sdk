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
// The actual <RemoteControl> component is intentionally NOT under unit
// test here — its WebRTC plumbing is integration-tested via the demo +
// staging instance. These tests cover the smaller, pure-logic modules:
// `core/ax-tree.ts` and `core/ax-fetcher.ts`.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: false,
  },
});
