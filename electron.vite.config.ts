import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist-electron',
    lib: {
      entry: 'electron/main.ts',
      formats: ['cjs'],
    },
    rollupOptions: {
      external: ['electron', 'better-sqlite3', 'keytar'],
    },
  },
});

