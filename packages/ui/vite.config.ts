import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';
import { libInjectCss } from 'vite-plugin-lib-inject-css';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), libInjectCss(), dts({ include: ['src'] })],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'app-store-relay/index': resolve(__dirname, 'src/app-store-relay/index.ts'),
        'app-store-relay/react': resolve(__dirname, 'src/app-store-relay/react.ts'),
        'device-build/index': resolve(__dirname, 'src/device-build/index.ts'),
        'device-build/react': resolve(__dirname, 'src/device-build/react.ts'),
        'device-install/index': resolve(__dirname, 'src/device-install/index.ts'),
        'device-install/react': resolve(__dirname, 'src/device-install/react.ts'),
        'play-publish/index': resolve(__dirname, 'src/play-publish/index.ts'),
        'play-publish/react': resolve(__dirname, 'src/play-publish/react.ts'),
      },
      name: 'LimrunUI',
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => `${entryName}.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react/jsx-runtime': 'jsxRuntime',
        },
      },
    },
  },
});
