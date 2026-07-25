import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The `@limrun/ui` file: install ships its own react in node_modules; force
  // a single copy so hooks see the right dispatcher.
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
});
