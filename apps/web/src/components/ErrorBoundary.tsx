import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface State {
  error: Error | null;
}

/** Catches render errors so one broken page doesn't blank the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('UI error', error, info.componentStack);
  }

  override componentDidUpdate(prev: { resetKey?: string }): void {
    // Navigating elsewhere clears the error.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        className="glass mx-auto mt-16 max-w-md space-y-4 rounded-2xl p-8 text-center"
      >
        <AlertTriangle className="mx-auto size-8 text-warning" />
        <h2 className="text-lg font-semibold">Something went wrong on this page</h2>
        <p className="break-words font-mono text-xs text-muted">{this.state.error.message}</p>
        <Button variant="primary" onClick={() => this.setState({ error: null })}>
          <RotateCcw /> Try again
        </Button>
      </div>
    );
  }
}
