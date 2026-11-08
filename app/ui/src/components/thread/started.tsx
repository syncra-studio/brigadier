import { Button } from "../button";
import { ErrorLine } from "../error-line";
import { LabeledDivider } from "../labeled-divider";

/** The new session's live status, from its row's mark [D204]. */
export type StartedStatus = "working" | "needs" | "done" | "failed";
const STATUS: Record<StartedStatus, string> = { working: "Working", needs: "Needs you", done: "Done", failed: "Failed" };

/**
 * The line a session gets when a message from it starts another session [D204, D206]: "Starting a new session" while
 * on its way; then "Started a new session from {base} · {title} · {status} · Open", the status live; or "Couldn't
 * start the session · {error}" with Put back, which gives the message back to the composer. A deleted session
 * (`status` undefined once started) keeps its title only.
 */
export function StartedLine({
  title,
  base,
  status,
  starting = false,
  error,
  onOpen,
  onPutBack,
}: {
  title: string;
  base?: string | null;
  status?: StartedStatus;
  starting?: boolean;
  error?: string | null;
  onOpen?: () => void;
  onPutBack?: () => void;
}) {
  if (error) {
    return (
      <ErrorLine
        size="sm"
        error={`Couldn’t start the session · ${error}`}
        actions={
          onPutBack && (
            <Button variant="link-blue" size={null} onClick={onPutBack}>
              Put back
            </Button>
          )
        }
      />
    );
  }
  const words = starting ? "Starting a new session" : base ? `Started a new session from ${base}` : "Started a new session";
  return (
    <LabeledDivider role="status">
      {/* One run of words, so a wrapped line never starts at a dot. */}
      <span className="min-w-0 text-center wrap-break-word">
        <span className={starting ? "shimmer" : undefined}>{title ? `${words} · ${title}` : words}</span>
        {status && (
          <>
            {" · "}
            <span className={status === "working" ? "shimmer" : undefined}>{STATUS[status]}</span>
          </>
        )}
        {status && onOpen && (
          <>
            {" · "}
            <Button variant="link-blue" size={null} onClick={onOpen}>
              Open
            </Button>
          </>
        )}
      </span>
    </LabeledDivider>
  );
}
