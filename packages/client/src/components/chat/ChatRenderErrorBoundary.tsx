import { Component, type ErrorInfo, type ReactNode } from 'react';

type ChatRenderErrorBoundaryProps = {
  children: ReactNode;
  resetKey: string;
};

type ChatRenderErrorBoundaryState = {
  error: Error | null;
  resetKey: string;
};

export class ChatRenderErrorBoundary extends Component<
  ChatRenderErrorBoundaryProps,
  ChatRenderErrorBoundaryState
> {
  state: ChatRenderErrorBoundaryState = {
    error: null,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(error: Error): Partial<ChatRenderErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: ChatRenderErrorBoundaryProps,
    state: ChatRenderErrorBoundaryState,
  ): Partial<ChatRenderErrorBoundaryState> | null {
    if (props.resetKey === state.resetKey) return null;
    return { error: null, resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[chat] render failed', error, info.componentStack);
  }

  private retry = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center bg-background p-6" data-weave-chat-render-error role="alert">
        <div className="max-w-md rounded-lg border border-border bg-card p-5 text-sm shadow-sm">
          <div className="font-medium text-foreground">The chat view could not be rendered.</div>
          <div className="mt-2 text-muted-foreground">
            Your conversation is still saved. Try rendering the chat again.
          </div>
          <button
            type="button"
            className="mt-4 rounded-md border border-border bg-background px-3 py-1.5 font-medium text-foreground hover:bg-muted"
            onClick={this.retry}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
