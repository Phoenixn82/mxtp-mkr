import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * App-wide safety net. A render-time throw (e.g. a persisted project with an
 * unexpected shape, or a bad art item) would otherwise unmount the whole React
 * tree and leave a blank window with no way out. This catches it and offers a
 * reload instead of a white screen.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep a trace in the webview console for diagnostics; never rethrow.
    console.error("MXTP MKR hit an unexpected error:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app-error-boundary" role="alert">
        <div className="app-error-card">
          <h1>Something went wrong</h1>
          <p>
            MXTP MKR hit an unexpected problem and stopped this screen.
            Saved projects and downloaded audio are safe on disk. Unsaved changes on this screen may be lost.
          </p>
          <p className="app-error-detail">{this.state.error.message}</p>
          <div className="app-error-actions">
            <button type="button" onClick={() => window.location.reload()}>
              Reload MXTP MKR
            </button>
          </div>
        </div>
      </div>
    );
  }
}
