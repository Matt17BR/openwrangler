import { Component, createRef, type ErrorInfo, type ReactNode } from "react";
import type { WebviewFailurePhase } from "../shared/webviewFailure";
import { vscode } from "./vscodeApi";

interface WebviewErrorBoundaryProps {
  children: ReactNode;
  reload?: () => void;
}

interface WebviewErrorBoundaryState {
  failed: boolean;
  reloadRequested: boolean;
}

const failureSubscribers = new Set<(phase: WebviewFailurePhase) => void>();

export function reportWebviewFailure(phase: WebviewFailurePhase): void {
  for (const subscriber of failureSubscribers) subscriber(phase);
}

export class WebviewErrorBoundary extends Component<WebviewErrorBoundaryProps, WebviewErrorBoundaryState> {
  state: WebviewErrorBoundaryState = { failed: false, reloadRequested: false };

  private readonly reloadButton = createRef<HTMLButtonElement>();
  private diagnosticPublished = false;

  static getDerivedStateFromError(): Partial<WebviewErrorBoundaryState> {
    return { failed: true };
  }

  componentDidMount(): void {
    failureSubscribers.add(this.handleReportedFailure);
  }

  componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    this.publishDiagnostic("react");
    this.focusReloadButton();
  }

  componentWillUnmount(): void {
    failureSubscribers.delete(this.handleReportedFailure);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="webviewErrorSurface" role="alert" aria-labelledby="webview-error-heading">
        <span className="codicon codicon-warning webviewErrorIcon" aria-hidden="true" />
        <h1 id="webview-error-heading">Open Wrangler needs to reload</h1>
        <p>The workbench could not continue. Reload this view to restore it from the current session.</p>
        <button
          ref={this.reloadButton}
          type="button"
          className="webviewErrorReloadButton"
          disabled={this.state.reloadRequested}
          onClick={this.reload}
        >
          {this.state.reloadRequested ? "Reload requested" : "Reload Open Wrangler"}
        </button>
      </main>
    );
  }

  private readonly handleReportedFailure = (phase: WebviewFailurePhase): void => {
    if (this.state.failed) return;
    this.setState({ failed: true, reloadRequested: false }, () => {
      this.publishDiagnostic(phase);
      this.focusReloadButton();
    });
  };

  private readonly reload = (): void => {
    if (this.state.reloadRequested) return;
    this.setState({ reloadRequested: true }, () => {
      if (this.props.reload) this.props.reload();
      else window.location.reload();
    });
  };

  private publishDiagnostic(phase: WebviewFailurePhase): void {
    if (this.diagnosticPublished) return;
    this.diagnosticPublished = true;
    vscode.postMessage({ kind: "webviewFailure", phase });
  }

  private focusReloadButton(): void {
    if (document.hasFocus()) this.reloadButton.current?.focus({ preventScroll: true });
  }
}
