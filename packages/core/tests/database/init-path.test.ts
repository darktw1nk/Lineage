import { describe, it, expect } from 'vitest';
import { initializeDatabase } from '../../src/database/init.js';

describe('initializeDatabase', () => {
  it('rejects an empty database path instead of falling back to Electron', async () => {
    await expect(initializeDatabase('')).rejects.toThrow(/requires a database file path/);
  });
});
