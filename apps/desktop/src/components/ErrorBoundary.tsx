import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './ui/button';

interface Props {
  children: ReactNode;
  /** Shown above the error, e.g. "the lineage graph". */
  label?: string;
  /** Changing this resets the boundary — pass the selected evaluation id. */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
}

/**
 * Catches a render error instead of letting it unmount the whole app.
 *
 * The renderer had no boundary at all, so any throw inside a component took
 * the entire tree down to a blank window with no way back — and several
 * components dereference node fields without guarding (`node.changeLog[0]`,
 * `evaluation.totals.tokensPrompt`, `node.params.model.model`). A run whose
 * data hits one of those became a poison pill: it appeared in the sidebar and
 * blanked the app on every click, with no UI left to delete it.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Render failed:', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    // Switching to a different evaluation should give the panel a fresh start
    // rather than keeping the previous one's error on screen forever.
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-sm font-medium">
          Could not display {this.props.label ?? 'this panel'}.
        </div>
        <div className="max-w-md text-xs text-muted-foreground break-words">
          {this.state.error.message}
        </div>
        <div className="text-xs text-muted-foreground">
          The rest of the app still works — you can select a different evaluation.
        </div>
        <Button variant="outline" size="sm" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    );
  }
}
