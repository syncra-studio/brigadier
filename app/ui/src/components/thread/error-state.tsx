import { Component, type ErrorInfo, type ReactNode, useState } from "react";

import { ChevronRight } from "../../icons";
import { CopyButton } from "../copy-button";
import { cx } from "../cx";
import { ErrorLine } from "../error-line";

/**
 * Something that failed, said calmly as the old app did: one red line, Try again where it can be tried again, and
 * Details › opening the error's own words with Copy (D87, D490). It wraps rather than cutting the words.
 */
export function ErrorState({ summary, details, onRetry, action }: { summary: string; details?: string | null; onRetry?: () => void; action?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const text = details?.trim() ?? "";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2.5 text-sm leading-5.25">
        <ErrorLine size="sm" error={summary} />
        {onRetry && <ErrorAction onClick={onRetry}>Try again</ErrorAction>}
        {action}
        {text && (
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex cursor-pointer items-center gap-1 rounded-control text-muted-foreground hover:text-foreground focus-visible:focus-ring">
            Details
            <ChevronRight className={cx("size-icon-xs chevron-motion", open && "rotate-90")} />
          </button>
        )}
      </div>
      {text && open && (
        <div className="flex items-start gap-1">
          <pre className="max-h-60 min-w-0 flex-1 overflow-y-auto font-mono text-xs whitespace-pre-wrap wrap-anywhere text-live-text-quiet">{text}</pre>
          <CopyButton text={text} tooltip="Copy error" />
        </div>
      )}
    </div>
  );
}

/** A link-blue action on an error's line. */
export function ErrorAction({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="cursor-pointer rounded-control text-link hover:text-link-hover focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-disabled">
      {children}
    </button>
  );
}

/**
 * What it wraps, or the error line in its place when drawing it throws: the rest stays. Try again only draws it
 * afresh, it never reruns anything (D490).
 */
export class DrawBoundary extends Component<{ summary: string; className?: string; children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Couldn't draw", error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={this.props.className}>
        <ErrorState summary={this.props.summary} details={error.stack ?? error.message} onRetry={() => this.setState({ error: null })} />
      </div>
    );
  }
}
