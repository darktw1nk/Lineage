import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          resolve: {
            alias: {
              '@promptengine/core': path.resolve(__dirname, './packages/core/src/index.ts')
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
      '@promptengine/core': path.resolve(__dirname, './packages/core/src/index.ts')
    }
  },
  server: {
    port: 5173
  }
});
