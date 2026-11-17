import type { ReactNode } from "react";

import { CopyButton } from "../components/copy-button";
import { cx } from "../components/cx";
import { Chat, ChevronDown, ChevronUp } from "../icons";
import { useFindSearching } from "./find-text";
import { useKept } from "./kept";

/**
 * A reply's card [D477]: a fenced `brigadier-message` block holds JSON that Brigadier draws as its own card. JSON that
 * doesn't parse or doesn't fit draws nothing here, so the fence stays a code block. Questions go to the question card
 * through the agent's question tool, never a reply card [D484].
 */
type Message = { to: string; state?: string; text: string; quote?: { from: string; text: string } };

const said = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const maybe = (value: unknown) => value === undefined || typeof value === "string";
const isMessage = (m: Record<string, any> | undefined): m is Message =>
  !!m && said(m.to) && said(m.text) && maybe(m.state) && (m.quote === undefined || (said(m.quote?.from) && said(m.quote?.text)));

/**
 * A reply as Copy response gives it: each message card's JSON turned back into its words, a `text` fence titled
 * where it goes [D520]. JSON that isn't a card stays as written.
 */
export function copiedReply(text: string): string {
  return text.replace(/^([ \t]*)```brigadier-message[^\n]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/gm, (fence, pad: string, json: string) => {
    let spec: Record<string, any> | undefined;
    try {
      spec = JSON.parse(json);
    } catch {
      return fence;
    }
    if (!isMessage(spec)) return fence;
    return [`\`\`\`text ${spec.to}`, ...spec.text.split("\n"), "```"].map((line) => pad + line).join("\n");
  });
}

/** A card's frame while its JSON still arrives, so the JSON never shows raw; null when the fence isn't a card's [D520]. */
export function replyCardFrame(language: string): ReactNode {
  if (language !== "brigadier-message") return null;
  return (
    <div className={FRAME}>
      <div className="flex h-control-md items-center ps-4 text-xs text-muted-foreground">
        <Chat className="size-icon-sm" />
      </div>
    </div>
  );
}

/** The card a fence draws, or null when it isn't one; `keep` keeps it open. */
export function replyCard(language: string, json: string, keep: string): ReactNode {
  if (language !== "brigadier-message") return null;
  let spec: Record<string, any> | undefined;
  try {
    spec = JSON.parse(json);
  } catch {
    return null;
  }
  return isMessage(spec) ? <MessageCard {...spec} keep={keep} /> : null;
}

/** The frame a reply's words for a person sit in: quiet, large corners, the reply's own font [D520]. */
const FRAME = "my-3 rounded-alert border border-border bg-code-surface first:mt-0 last:mb-0";

/** A draft's first lines as one line, its markdown marks dropped, for its folded row. */
const peek = (text: string) =>
  text
    .split("\n", 8)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d{1,9}[.)]|#{1,6}|>)\s+/, "").replace(/\*\*|__|~~|`|\[([^\]]*)\]\([^)]*\)/g, "$1").trim())
    .filter(Boolean)
    .join(" · ");

/**
 * A draft folded to one row, so long ones don't flood the thread [D563, D564]: its kind and title, its first line,
 * Copy, a chevron; a click opens it in place. While find searches, its words are drawn cut to nothing, so find finds
 * them and opens it (find-hits.ts reads the row's `data-kept` button).
 */
export function Draft({ keep, icon, title, text, live = false, children }: { keep: string; icon?: ReactNode; title: ReactNode; text: string; live?: boolean; children: ReactNode }) {
  const [open, setOpen] = useKept(keep);
  const searched = useFindSearching();
  return (
    <div data-look="draft" className={cx("relative", FRAME)}>
      <button
        type="button"
        aria-expanded={open}
        data-kept={keep}
        onClick={() => setOpen(!open)}
        className="flex h-control-md w-full cursor-pointer items-center gap-1.5 rounded-alert ps-4 pe-2 text-start text-xs text-muted-foreground focus-visible:focus-ring"
      >
        {icon}
        <span className="max-w-1/2 shrink-0 truncate font-medium text-foreground">{title}</span>
        {!open && <span className="ms-1 min-w-0 truncate">{peek(text)}</span>}
        {/* Copy's place, which sits over the row: a button can't hold one. */}
        <span className="ms-auto w-6 shrink-0" />
        {open ? <ChevronUp className="size-icon-sm shrink-0" /> : <ChevronDown className="size-icon-sm shrink-0" />}
      </button>
      {!live && (
        <div className="absolute end-7 top-0 flex h-control-md items-center">
          <CopyButton text={text} tooltip="Copy" copiedTooltip="Copied" size="icon-xs" />
        </div>
      )}
      {(open || searched) && (
        <div data-find-clip={!open || undefined} className={cx(!open && "h-0 overflow-hidden")}>
          {children}
        </div>
      )}
    </div>
  );
}

/** Words for a person to paste (a `text` fence): its title, copy beside it, the words as written [D520]. */
export function WritingCard({ title, text, keep, live = false }: { title: string; text: string; keep: string; live?: boolean }) {
  return (
    <Draft keep={keep} title={title} text={text} live={live}>
      <div className="px-4 pb-4 leading-relaxed break-words whitespace-pre-wrap">{text}</div>
    </Draft>
  );
}

/** A message for someone else: where it goes, their words it answers, and copy for the message alone. */
function MessageCard({ to, text, quote, keep }: Message & { keep: string }) {
  return (
    <Draft keep={keep} icon={<Chat className="size-icon-sm shrink-0" />} title={to} text={text}>
      {quote && (
        <div className="mx-4 mb-2 border-s-2 border-quote-edge ps-3 text-sm text-muted-foreground">
          <div className="text-xs font-medium">{quote.from} wrote</div>
          <div className="whitespace-pre-wrap">{quote.text}</div>
        </div>
      )}
      <div className="px-4 pb-4 leading-relaxed break-words whitespace-pre-wrap">{text}</div>
    </Draft>
  );
}
