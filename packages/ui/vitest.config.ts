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
// RemoteControl connection tests exercise lifecycle decisions with mocked
// browser transports. Actual media connectivity still needs live validation.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: false,
  },
});
