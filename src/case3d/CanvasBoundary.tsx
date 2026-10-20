import { Component, type ErrorInfo, type ReactNode } from "react";

interface CanvasBoundaryProps {
  /** The 2D stand-in shown when the 3D scene fails (texture load, WebGL context, shader). */
  fallback: ReactNode;
  /** When this changes after a failure (new art, another format), try the 3D scene again. */
  resetKey?: string;
  /** Told when the boundary falls back (true) or retries the 3D scene (false), so callers can hide 3D-only controls. */
  onFailedChange?: (failed: boolean) => void;
  children: ReactNode;
}

/**
 * Keeps a failing react-three-fiber Canvas inside its own panel. R3F rethrows any
 * error from inside the Canvas outward, so without this one bad texture URL would
 * replace the whole app with the top-level ErrorBoundary.
 */
export class CanvasBoundary extends Component<CanvasBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previous: CanvasBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
      this.props.onFailedChange?.(false);
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("3D preview failed; showing the 2D fallback.", error, info.componentStack);
    this.props.onFailedChange?.(true);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function CanvasFallbackNote({ children = "3D preview unavailable" }: { children?: ReactNode }) {
  return <p className="canvas-fallback">{children}</p>;
}
