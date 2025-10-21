import Store from 'electron-store';

// Single shared store instance for the entire application
export const store = new Store({
  encryptionKey: 'prompt-evolution-secure-key',
});

