import { ErrorLine } from "../../components/error-line";
import { cx } from "../../components/cx";
import { TooltipIconButton } from "../../components/icon-button";
import { Sparkles, Spinner } from "../../icons";

/**
 * The message box (the old CommitBox's): left blank, a message is written at commit; ✨ writes one now. During a
 * merge it holds git's message, during a rebase the stopped commit's, kept as it is. With nothing to commit it's
 * one line and off. A write that failed says so under it, and nothing was committed [D1029].
 */
export function CommitBox({ message, onMessage, branch, rebaseMessage = null, writing = false, busy = false, canWrite, idle, failed = false, onWrite, onCommit }: {
  message: string;
  onMessage: (message: string) => void;
  branch: string | null;
  /** A rebase stopped on this commit: its message, which the box shows and doesn't edit. */
  rebaseMessage?: string | null;
  /** ✨ is writing a message. */
  writing?: boolean;
  /** A commit or a write is under way. */
  busy?: boolean;
  canWrite: boolean;
  /** Nothing to commit. */
  idle: boolean;
  failed?: boolean;
  onWrite?: () => void;
  onCommit?: () => void;
}) {
  const placeholder = `Message (⌘⏎ to commit on "${branch ?? "…"}")`;
  const off = idle && !busy;
  const empty = !(rebaseMessage ?? message);
  const oneLine = off && empty;
  return (
    <div className="flex flex-col gap-1.5">
      <div className={cx("flex items-start rounded-control border focus-within:border-ring", off ? "border-divider" : "border-border")}>
        {/* An empty box is as tall as its placeholder: WebKit sizes it to one line. */}
        <div className="grid min-w-0 flex-1">
          <span
            aria-hidden
            className={cx(
              "col-start-1 row-start-1 max-h-40 overflow-hidden px-2 py-1.5 text-sm",
              oneLine ? "pointer-events-none truncate text-muted-foreground" : "invisible break-words whitespace-pre-wrap",
            )}
          >
            {empty ? placeholder : ""}
          </span>
          <textarea
            rows={1}
            value={rebaseMessage ?? message}
            disabled={busy || rebaseMessage !== null || off}
            aria-label="Commit message"
            placeholder={oneLine ? "" : placeholder}
            onChange={(event) => onMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.metaKey) {
                event.preventDefault();
                onCommit?.();
              }
            }}
            className={cx(
              "col-start-1 row-start-1 max-h-40 w-full min-w-0 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground",
              oneLine ? "h-full overflow-hidden" : "field-sizing-content",
            )}
          />
        </div>
        <TooltipIconButton tooltip="Generate Commit Message" size="icon-xs" className="m-1" disabled={busy || !canWrite} onClick={onWrite}>
          {writing ? <Spinner className="animate-spin motion-reduce:animate-none" /> : <Sparkles />}
        </TooltipIconButton>
      </div>
      {failed && <ErrorLine error="Couldn't write a message. Type one." className="px-1" />}
    </div>
  );
}
