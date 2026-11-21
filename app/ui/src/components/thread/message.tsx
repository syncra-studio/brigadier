import { type ReactNode, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Item } from "../../thread/item";

import { ArrowDown, ChevronRightAlt, Trash, Undo } from "../../icons";
import type { RewindOffer } from "./rewind";
import { useKept } from "../../thread/kept";
import { Markdown } from "../../thread/markdown";
import { copiedReply } from "../../thread/reply-cards";
import { type Attachment, AttachmentsContext, ChipNumbers } from "../composer/attachments";
import { ChipContext, ComposerChip, type OpenKind } from "../composer/chip";
import type { Chip, Draft } from "../composer/draft";
import { numbersOf } from "../composer/field";
import { CopyButton } from "../copy-button";
import { cx } from "../cx";
import { ErrorLine } from "../error-line";
import { TooltipIconButton } from "../icon-button";
import { openChip } from "../../session/commands";
import { urlOf } from "../../session/files";
import { useSettings } from "../../settings/api";
import { SaveAsNote } from "../../note/save";

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const monthDay = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const fullDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

/** When a message was sent: "3:09 PM", "Yesterday 3:09 PM", "Mon 3:09 PM", "Mon, Mar 3 at 3:09 PM", "Mar 3, 2025 at 3:09 PM". */
export function sentAt(ms: number, now = Date.now()): string {
  const at = new Date(ms);
  const day = new Date(now);
  // Midnight `back` calendar days ago: a day across a clock change isn't 24 hours.
  const midnight = (back: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate() - back).getTime();
  const clock = time.format(at);
  if (ms >= midnight(0)) return clock;
  if (ms >= midnight(1)) return `Yesterday ${clock}`;
  if (ms >= midnight(6)) return `${weekday.format(at)} ${clock}`;
  if (at.getFullYear() === new Date(now).getFullYear()) return `${monthDay.format(at)} at ${clock}`;
  return `${fullDate.format(at)} at ${clock}`;
}

/** "Today 3:36 PM", else as the bubble's time says it: centred above a message, as the old app's time separator. */
function TimeSeparator({ at }: { at: number }) {
  const today = new Date(at).toDateString() === new Date().toDateString();
  return <p className="self-stretch pt-2 pb-4 text-center text-sm text-muted-foreground">{today ? `Today ${sentAt(at)}` : sentAt(at)}</p>;
}

/** A gap before a user's message that a time separator marks (the old app's). */
const SEPARATOR_GAP_MS = 60 * 60 * 1000;

/** The user's messages with their date above: the first, and one sent more than an hour after the message before it. */
export function datedMessages(items: readonly Item[]): ReadonlySet<string> {
  const dated = new Set<string>();
  let previous: Extract<Item, { kind: "message" }> | undefined;
  for (const item of items) {
    if (item.kind !== "message") continue;
    if (item.role === "user" && item.origin !== "system" && datedAfter(previous, item.sentAt)) dated.add(item.id);
    previous = item;
  }
  return dated;
}

/** Whether a user's message sent at `at` after `previous` (the last message, if any) has its date above it: a chat's first has none [D83]. */
export function datedAfter(previous: { sentAt?: number } | undefined, at: number | undefined): boolean {
  return previous !== undefined && at !== undefined && previous.sentAt !== undefined && at - previous.sentAt > SEPARATOR_GAP_MS;
}

/**
 * The user's message, on the right, its Markdown with every line break kept. Hovered or focused, its time
 * and a copy button show under it; past 20 lines it folds with "Show more". `dated` puts when it was sent above it, centred. A message on its
 * way looks sent at once [D449]; one whose delivery can't be proven yet is `unconfirmed` and says so in place of
 * its time [D300]. One that failed keeps its actions in view, with Discard, and says why on an ErrorLine with Try
 * again. `dimmed` greys it (a message the turn hasn't reached).
 */
export function UserBubble({
  keep,
  text,
  time,
  failed,
  onRetry,
  onDiscard,
  rewind,
  unconfirmed = false,
  dimmed = false,
  dated = false,
  files,
  owner,
  parts,
}: {
  /** Keeps its fold while it scrolls out of view. */
  keep: string;
  text: string;
  /** When it was sent (ms). */
  time?: number;
  /** Why it wasn't sent. */
  failed?: string;
  onRetry?: () => void;
  onDiscard?: () => void;
  /** Going back to this message, where it's offered [D384]. */
  rewind?: RewindOffer;
  /** Sent, but its delivery can't be proven until reconnected. */
  unconfirmed?: boolean;
  dimmed?: boolean;
  /** Its date and time above it (`datedMessages`). */
  dated?: boolean;
  /** Its files, above the bubble. */
  files?: ReactNode;
  /** The session (or Home's draft) its files are kept in. */
  owner?: string;
  /** The draft it was sent from: its mentions, images and pastes drawn as the composer's chips, in place [D2107]. */
  parts?: Draft["parts"];
}) {
  // An attachment its surroundings already hold (the gallery's sample picture) keeps that look.
  const known = useContext(AttachmentsContext);
  const chips = useMemo(() => {
    if (!owner || !parts?.some((part) => typeof part !== "string")) return null;
    const list: Chip[] = [];
    const markdown = parts.map((part) => (typeof part === "string" ? part : `[@](chip:${list.push(part) - 1})`)).join("");
    const files = list.flatMap((chip): [string, Attachment][] => ("attachmentId" in chip ? [[chip.attachmentId, known.get(chip.attachmentId) ?? { id: chip.attachmentId, name: "", mime: "", state: "ready", url: urlOf(owner, chip.attachmentId) }]] : []));
    // shortcut: a sent /command chip opens nothing (its `/` list isn't kept with the message), until the message keeps its command's file.
    const open = { onOpen: (kind: OpenKind, id: string, name?: string) => openChip(owner, kind, id, undefined, undefined, name), commands: new Map() };
    return { markdown, numbers: numbersOf(parts), files: new Map(files), open, chip: (n: number) => list[n] && <ComposerChip chip={list[n]} /> };
  }, [owner, parts, known]);
  const [more, setMore] = useKept(`${keep}:more`);
  const box = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    // The cut is 20 lines down, or the end of a code block crossing it, so no block is cut through.
    const measure = () => {
      delete element.dataset.cut;
      if (more) return setClipped(false);
      const cut = element.clientHeight;
      const top = element.getBoundingClientRect().top;
      let end = cut;
      for (const block of element.querySelectorAll("[data-look]")) {
        const edge = block.getBoundingClientRect();
        if (edge.top - top < cut && edge.bottom - top > cut) end = Math.max(end, Math.ceil(edge.bottom - top));
      }
      if (end > cut) element.dataset.cut = String(end);
      setClipped(element.scrollHeight > end + 1);
    };
    measure();
    // Its content grows under a fixed cut (a code block laid out late): watched as well.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [more]);
  // Stacked: one left-aligned column with the agent's text, the bubble kept so it stands apart [D914, D915].
  const side = useSettings().value?.message_layout === "stacked" ? "items-start" : "items-end";
  return (
    <div className={cx("group/user flex flex-col gap-y-1", side)}>
      {dated && time !== undefined && <TimeSeparator at={time} />}
      <div className={cx("flex max-w-7/10 min-w-0 flex-col gap-y-1", side)}>
        {files}
        {/* A message of only files (a paste, an image) has no bubble under them. */}
        {(text.trim() !== "" || chips || !files) && (
        <div className={cx("flex max-w-full min-w-0 flex-col rounded-thread bg-bubble px-3.5 py-2.25 text-foreground shadow-composer", dimmed && "opacity-row-disabled")}>
          <div ref={box} data-bubble className={cx(!more && "user-message-cut")}>
            {chips ? (
              <AttachmentsContext value={chips.files}>
                <ChipNumbers value={chips.numbers}>
                  <ChipContext value={chips.open}>
                    <Markdown text={chips.markdown} keep={keep} chip={chips.chip} />
                  </ChipContext>
                </ChipNumbers>
              </AttachmentsContext>
            ) : (
              <Markdown text={text} keep={keep} />
            )}
          </div>
          {(clipped || more) && (
            <button
              type="button"
              aria-expanded={more}
              data-kept={`${keep}:more`}
              onClick={() => setMore(!more)}
              className="flex cursor-pointer items-center gap-0.5 self-start rounded-control pt-1 text-xs text-muted-foreground hover:text-foreground focus-visible:focus-ring"
            >
              {more ? "Show less" : "Show more"}
              <ChevronRightAlt className={cx("size-icon-xs transition-transform", more ? "-rotate-90" : "rotate-90")} />
            </button>
          )}
        </div>
        )}
        {/* Hover-only, its space kept so nothing shifts; a failed or unconfirmed message's stay in view. */}
        <div
          className={cx(
            "-mt-1 flex items-center gap-1 text-muted-foreground",
            !failed && !unconfirmed && "opacity-0 transition-opacity group-focus-within/user:opacity-100 group-hover/user:opacity-100",
          )}
        >
          {unconfirmed ? (
            <span role="status" className="pe-1 text-xs">
              Not confirmed yet · checked once reconnected
            </span>
          ) : (
            time !== undefined && <span className="pe-1 text-xs tabular-nums">{sentAt(time)}</span>
          )}
          <CopyButton text={text} tooltip="Copy message" copiedDuration={1500} />
          {rewind && (
            <TooltipIconButton tooltip={rewind.blocked ?? "Rewind to here"} disabled={rewind.blocked !== undefined} onClick={rewind.open}>
              <Undo />
            </TooltipIconButton>
          )}
          {failed && onDiscard && (
            <TooltipIconButton tooltip="Discard message" onClick={onDiscard}>
              <Trash />
            </TooltipIconButton>
          )}
        </div>
        {!unconfirmed && (
          <ErrorLine
            size="sm"
            error={failed && `Not sent · ${failed}`}
            className={side === "items-end" ? "justify-end" : undefined}
            actions={
              onRetry ? (
                <button type="button" onClick={onRetry} className="cursor-pointer rounded-control text-link hover:text-link-hover focus-visible:focus-ring">
                  Try again
                </button>
              ) : null
            }
          />
        )}
      </div>
    </div>
  );
}

/**
 * The agent's message: `children` is the rendered reply. Under a turn's `final` answer its actions stay in
 * view: copy, and the time only on hover or focus. Commentary between the turn's steps, a steer's too, has none.
 */
export function AssistantMessage({
  text,
  final,
  time,
  fork,
  older,
  children,
}: {
  text: string;
  final: boolean;
  time?: number;
  fork?: ReactNode;
  /** Not the thread's latest answer: its actions only on hover. */
  older?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="group/answer flex flex-col gap-1.5">
      <div className="leading-relaxed wrap-break-word text-foreground">{children}</div>
      {final && <AnswerMarks text={text} time={time} fork={fork} older={older} />}
    </div>
  );
}

/** A finished answer's actions: copy, save as a note, then fork where offered [D1069], the time only on hover or focus [D297]. */
export function AnswerMarks({ text, time, fork, older = false }: { text: string; time?: number; fork?: ReactNode; older?: boolean }) {
  return (
    // Only the latest answer keeps them in view; an older one's show on hover or focus [D82].
    <div className={cx("group/answer -ms-1 flex items-center gap-0.5 text-faint-foreground", older && "opacity-0 group-focus-within/answer:opacity-100 group-hover/answer:opacity-100")}>
      <CopyButton text={copiedReply(text)} tooltip="Copy response" size="icon-answer" />
      <SaveAsNote text={text} />
      {fork}
      {time !== undefined && (
        <span className="ps-1 text-xs tabular-nums opacity-0 group-focus-within/answer:opacity-100 group-hover/answer:opacity-100">{sentAt(time)}</span>
      )}
    </div>
  );
}

/** The live "Thinking" line while the agent thinks: the thought's newest heading if there is one. */
export function ThinkingLine({ heading }: { heading?: string | null }) {
  const words = heading || "Thinking";
  return (
    <p key={words} className="w-fit max-w-full truncate text-sm leading-5.25 shimmer">
      {words}
    </p>
  );
}

/**
 * The jump-to-latest button's face: an arrow, or three dots in a wave while the reply streams below it, the arrow again on hover
 * or focus (the old app's). Its button is `group/jump`.
 */
export function JumpSign({ running }: { running: boolean }) {
  if (!running) return <ArrowDown className="size-icon-md" />;
  return (
    <>
      <span aria-hidden className="flex items-center justify-center gap-1 group-hover/jump:hidden group-focus-visible/jump:hidden">
        <span className="size-1 rounded-full bg-shell-foreground wave-dot" />
        <span className="size-1 rounded-full bg-shell-foreground wave-dot" />
        <span className="size-1 rounded-full bg-shell-foreground wave-dot" />
      </span>
      <ArrowDown className="hidden size-icon-md group-hover/jump:block group-focus-visible/jump:block" />
    </>
  );
}

