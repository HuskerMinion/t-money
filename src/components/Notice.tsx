// The one notice strip: an info line, or a refusal.
//
// > "the warning should probably be a light red to highlight the message
// >  about the void being refused"
//
// Refusals from the backend (on far rows, on deletes) were shown in
// the register's cream info bar, or written to a status line behind the
// dialog that caused them, or not shown at all. Every one of those read as
// the button doing nothing. This is the shape they share now: `error` is the
// shared error box with a ⚠ and role="alert"; `info` is the cream strip it
// always was, role="status". `boxed` is for inside a dialog or a form.
import type { ReactNode } from "react";

interface Props {
  tone?: "info" | "error";
  children: ReactNode;
  /** Inside a dialog or form: rounded, padded, not edge to edge. */
  boxed?: boolean;
  /** Buttons after the text (the register's "Remember"). */
  actions?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}

export default function Notice({ tone = "info", children, boxed = false, actions, onDismiss, className = "" }: Props) {
  const error = tone === "error";
  return (
    <div
      className={`tm-notice${error ? " tm-notice-error" : ""}${boxed ? " tm-notice-boxed" : ""} ${className}`.trim()}
      role={error ? "alert" : "status"}
    >
      {error && (
        <span className="tm-notice-icon" aria-hidden="true">
          ⚠
        </span>
      )}
      <span className="tm-notice-text">{children}</span>
      {actions}
      {onDismiss && (
        <button type="button" className="aero-btn !py-0 !px-2 text-[11px]" onClick={onDismiss} aria-label="Dismiss">
          ✕
        </button>
      )}
    </div>
  );
}
