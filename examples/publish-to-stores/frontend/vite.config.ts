import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Keep the linked package and app on one React copy so hooks see the
  // right dispatcher.
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
});
