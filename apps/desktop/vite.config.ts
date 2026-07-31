import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';

// `--mode renderer-only` serves the renderer WITHOUT launching Electron, which
// is what `npm run dev` is documented to do. Without it the plugin starts
// Electron itself, so `npm run electron:dev` (vite + a separate `electron .`)
// launched TWO instances against one database — whole-file sql.js saves mean
// the loser silently erased the winner's runs.
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        onstart(options) {
          if (mode === 'renderer-only') return;
          options.startup();
        },
        vite: {
          resolve: {
            alias: {
              '@lineage/core': path.resolve(__dirname, '../../packages/core/src/index.ts')
            }
          },
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['sql.js']
            }
          }
        }
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              output: {
                format: 'cjs'  // Use CommonJS for preload
              }
            }
          }
        }
      }
    ]),
    renderer()
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@lineage/core': path.resolve(__dirname, '../../packages/core/src/index.ts')
    }
  },
  server: {
    port: 5173
  }
}));
