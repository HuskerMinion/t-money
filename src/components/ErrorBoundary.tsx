// The app must never present as a blank window.
//
// There was no error boundary anywhere in this app, which means React's
// default applied: one thrown error in one component's render unmounts the
// ENTIRE tree. No menu, no header, no message — a white window and nothing to
// do but close it. That is the worst possible failure mode for a finance app,
// because the user cannot tell a render bug from a lost database, and the one
// piece of information that would explain it (the error) went to a console
// they cannot open.
//
// So: catch it, keep the window, and say what happened. The data is on disk
// and was never in danger — say that too, because it is the first thing
// anyone wonders when an accounts program goes blank.
//
// This is a floor, not a fix. A boundary that hides a real bug behind a tidy
// message is worse than the crash; that is why the error text and the
// component stack are shown rather than summarized, and why Reload is offered
// rather than a "continue anyway" that would leave React in a state nobody
// reasoned about.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the console copy — a dev build's devtools is still the fastest way
    // to a stack — but never rely on it being read.
    console.error("T-Money: a screen failed to render", error, info.componentStack);
    this.setState({ stack: info.componentStack ?? null });
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="tm-crash" role="alert">
        <h1>Something on this screen failed to draw.</h1>
        <p>
          <strong>Your file is not damaged.</strong> This is a display fault — nothing was
          written to your data when it happened. Reloading the window is safe.
        </p>
        <button type="button" className="tm-crash-reload" onClick={() => window.location.reload()}>
          Reload T-Money
        </button>
        <p className="tm-crash-hint">If it happens again, this is the part worth quoting:</p>
        <pre className="tm-crash-detail">
          {error.message || String(error)}
          {stack ? `\n${stack}` : ""}
        </pre>
      </div>
    );
  }
}
