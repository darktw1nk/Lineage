/**
 * Logger that captures console logs and broadcasts them to renderer via IPC
 */

import { BrowserWindow } from 'electron';

export interface LogEntry {
  timestamp: number;
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  args: any[];
}

const logBuffer: LogEntry[] = [];
const MAX_BUFFER_SIZE = 1000; // Keep last 1000 logs

// Store original console methods
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

function captureLog(level: LogEntry['level'], args: any[]) {
  const entry: LogEntry = {
    timestamp: Date.now(),
    level,
    message: args.map(arg => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return String(arg);
      }
    }).join(' '),
    args,
  };

  // Add to buffer
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER_SIZE) {
    logBuffer.shift();
  }

  // Broadcast to all windows
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send('log:entry', entry);
    }
  }
}

export function initLogger() {
  // Intercept console methods
  console.log = (...args: any[]) => {
    originalConsole.log(...args);
    captureLog('log', args);
  };

  console.info = (...args: any[]) => {
    originalConsole.info(...args);
    captureLog('info', args);
  };

  console.warn = (...args: any[]) => {
    originalConsole.warn(...args);
    captureLog('warn', args);
  };

  console.error = (...args: any[]) => {
    originalConsole.error(...args);
    captureLog('error', args);
  };
}

export function getLogBuffer(): LogEntry[] {
  return [...logBuffer];
}

