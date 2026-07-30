import { useEffect, useState, useRef } from 'react';
import { X, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import type { LogEntry } from '../window';

/** Matches the main-process log buffer cap in electron/logger.ts. */
const MAX_LOG_LINES = 1000;

interface LogsPanelProps {
  onClose: () => void;
}

export function LogsPanel({ onClose }: LogsPanelProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Load initial buffer
    window.electronAPI.logs.getBuffer().then(setLogs);

    // Subscribe to new logs
    const unsubscribe = window.electronAPI.logs.subscribe((entry: LogEntry) => {
      // Cap the buffer. This was unbounded while the MAIN-process buffer is
      // capped at 1000 (electron/logger.ts), so a long run pushed tens of
      // thousands of entries through an array copy per line — O(n^2) — and
      // rendered one DOM node for each.
      setLogs((prev) => (prev.length >= MAX_LOG_LINES
        ? [...prev.slice(prev.length - MAX_LOG_LINES + 1), entry]
        : [...prev, entry]));
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (autoScroll) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const clearLogs = () => {
    setLogs([]);
  };

  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp);
    const time = date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const ms = date.getMilliseconds().toString().padStart(3, '0');
    return `${time}.${ms}`;
  };

  const getLevelColor = (level: LogEntry['level']) => {
    switch (level) {
      case 'error':
        return 'text-red-500';
      case 'warn':
        return 'text-yellow-500';
      case 'info':
        return 'text-blue-500';
      default:
        return 'text-muted-foreground';
    }
  };

  const getLevelBg = (level: LogEntry['level']) => {
    switch (level) {
      case 'error':
        return 'bg-red-500/10 border-red-500/20';
      case 'warn':
        return 'bg-yellow-500/10 border-yellow-500/20';
      case 'info':
        return 'bg-blue-500/10 border-blue-500/20';
      default:
        return 'bg-muted/50 border-muted';
    }
  };

  return (
    <div className="flex h-64 flex-col border-t bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b p-2 px-4">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Backend Logs</h3>
          <span className="text-xs text-muted-foreground">({logs.length})</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="cursor-pointer"
            />
            Auto-scroll
          </label>
          <Button variant="ghost" size="sm" onClick={clearLogs} title="Clear logs">
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Logs Content */}
      <div className="flex-1 overflow-y-auto p-2 font-mono text-xs">
        {logs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            No logs yet...
          </div>
        ) : (
          <div className="space-y-1">
            {logs.map((log, idx) => (
              <div
                key={idx}
                className={`flex gap-2 rounded border p-2 ${getLevelBg(log.level)}`}
              >
                <span className="text-muted-foreground opacity-60 whitespace-nowrap">
                  {formatTimestamp(log.timestamp)}
                </span>
                <span className={`font-semibold uppercase whitespace-nowrap ${getLevelColor(log.level)}`}>
                  {log.level}
                </span>
                <span className="whitespace-pre-wrap break-all flex-1">{log.message}</span>
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>
    </div>
  );
}

