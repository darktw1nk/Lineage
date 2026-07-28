import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@promptengine/core': path.resolve(__dirname, '../../packages/core/src/index.ts'),
    },
  },
  test: {
    name: 'desktop',
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
  },
});
