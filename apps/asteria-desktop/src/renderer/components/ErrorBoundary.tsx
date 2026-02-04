import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
  error?: Error;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[renderer] Unhandled error", error, info);
  }

  private handleReload = (): void => {
    globalThis.location.reload();
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="error-boundary" role="alert">
        <div className="error-boundary-card">
          <h1>Something went wrong</h1>
          <p>The app hit an unexpected error. Reload to continue.</p>
          <div className="error-boundary-actions">
            <button className="btn btn-primary" onClick={this.handleReload}>
              Reload
            </button>
          </div>
          {this.state.error?.message ? (
            <pre className="error-boundary-details">{this.state.error.message}</pre>
          ) : null}
        </div>
      </div>
    );
  }
}
