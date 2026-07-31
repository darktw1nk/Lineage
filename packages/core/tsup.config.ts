import { defineConfig } from 'tsup';

export default defineConfig({
  // `champion` ships as its own entry because the RENDERER needs the
  // champion-selection rule and must not import the engine barrel: that pulls
  // database/init.ts (sql.js, fs, path) and ajv into a browser context, where
  // vite-plugin-electron-renderer polyfills them with `require` — undefined
  // under contextIsolation, so the production window rendered nothing at all.
  entry: ['src/index.ts', 'src/engine/champion.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node20',
  sourcemap: true,
});
