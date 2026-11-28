import { type ReactNode, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Item } from "../../thread/item";

import { ArrowDown, ChevronRightAlt, EditPencil, Trash } from "../../icons";
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
import { datedAfter, datedMessages, datedWords, sentAt } from "../../../../shared/words";
import { failedWords } from "../../../../shared/session/composer";
export { datedAfter, datedMessages, sentAt };


/** "Today 3:36 PM", else as the bubble's time says it: centred above a message, in the rows' grey [D106]. */
function TimeSeparator({ at }: { at: number }) {
  return <p className="self-stretch pb-3 text-center text-sm leading-5.25 text-row-foreground">{datedWords(at)}</p>;
}


/**
 * The user's message, on the right, its Markdown with every line break kept, in a bubble [D85]. Hovered or
 * focused, its time, Copy and Edit (our rewind) show under it [D86]; past 20 lines it folds with "Show more". `dated` puts when it was sent above it, centred. A message on its
 * way looks sent at once [D449]; one whose delivery can't be proven yet is `unconfirmed` and says so in place of
 * its time [D300]. One that failed keeps its actions in view, with Discard, and says why on an ErrorLine with Try
 * again. `dimmed` greys it (a message the turn hasn't reached).
 */
export function UserBubble({
  keep,
  text,
  time,
  failed,
  signIn,
  maybe = false,
  onRetry,
  onDiscard,
  rewind,
  unconfirmed = false,
  dimmed = false,
  dated = false,
  older = true,
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
  /** It failed for want of a signed-in account: Sign in goes to Providers [C36]. */
  signIn?: boolean;
  /** It may have gone, though it can't be shown to have (PROPOSED). */
  maybe?: boolean;
  onRetry?: () => void;
  onDiscard?: () => void;
  /** Going back to this message, where it's offered [D384]. */
  rewind?: RewindOffer;
  /** Sent, but its delivery can't be proven until reconnected. */
  unconfirmed?: boolean;
  dimmed?: boolean;
  /** Its date and time above it (`datedMessages`). */
  dated?: boolean;
  /** Its actions only on hover; else in view, as a failed one's. */
  older?: boolean;
  /** Its files, above the bubble. */
  files?: ReactNode;
  /** The session (or Home's draft) its files are kept in. */
  owner?: string;
  /** The draft it was sent from: its mentions, images and pastes drawn as the composer's chips, in place [D2107]. */
  parts?: Draft["parts"];
}) {
  // An attachment its surroundings already hold keeps that look.
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
  // Stacked: the agent's full column, the bubble kept so it stands apart; files and actions stay left [D914, D915].
  const stacked = useSettings().value?.message_layout === "stacked";
  const side = stacked ? "items-start" : "items-end";
  return (
    <div className={cx("group/user flex flex-col gap-y-1", side)}>
      {dated && time !== undefined && <TimeSeparator at={time} />}
      <div className={cx("flex min-w-0 flex-col gap-y-1", stacked ? "w-full" : "max-w-7/10", side)}>
        {files}
        {/* A message of only files (a paste, an image) has no bubble under them. */}
        {(text.trim() !== "" || chips || !files) && (
        <div className={cx("flex max-w-full min-w-0 flex-col rounded-thread bg-bubble px-4 py-2.5 text-chat text-chat-foreground", stacked && "self-stretch", dimmed && "opacity-row-disabled")}>
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
        {/* Hover-only, its space kept so nothing shifts; a failed or unconfirmed message's stay in view. 26 squares 2 apart,
            4 under the bubble and 4 over the next row's gap, so the next row sits 46 under it [D84]. */}
        <div
          className={cx(
            "mb-1 flex items-center gap-0.5 text-muted-foreground",
            older && !failed && !unconfirmed && "opacity-0 transition-opacity group-focus-within/user:opacity-100 group-hover/user:opacity-100",
          )}
        >
          {unconfirmed ? (
            <span role="status" className="pe-1.5 text-xs">
              Not confirmed yet · checked once reconnected
            </span>
          ) : (
            time !== undefined && <span className="pe-1.5 text-xs tabular-nums">{sentAt(time)}</span>
          )}
          <CopyButton text={text} tooltip="Copy message" copiedDuration={1500} size="icon-answer" />
          {/* Editing goes back to this message, its words in the composer again: our rewind [D86]. */}
          {rewind && (
            <TooltipIconButton tooltip={rewind.blocked ?? "Edit message"} size="icon-answer" disabled={rewind.blocked !== undefined} onClick={rewind.open}>
              <EditPencil />
            </TooltipIconButton>
          )}
          {failed && onDiscard && (
            <TooltipIconButton tooltip="Discard message" size="icon-answer" onClick={onDiscard}>
              <Trash />
            </TooltipIconButton>
          )}
        </div>
        {!unconfirmed && (
          <ErrorLine
            size="sm"
            wrap
            error={failed && failedWords(maybe, failed)}
            className={side === "items-end" ? "text-end" : undefined}
            actions={
              <>
                {failed && signIn && (
                  <a href="#settings/providers" className="rounded-control text-link hover:text-link-hover focus-visible:focus-ring">
                    Sign in
                  </a>
                )}
                {onRetry && (
                  <button type="button" onClick={onRetry} className="cursor-pointer rounded-control text-link hover:text-link-hover focus-visible:focus-ring">
                    Try again
                  </button>
                )}
              </>
            }
          />
        )}
      </div>
    </div>
  );
}

/**
 * The agent's message: `children` is the rendered reply, in the thread's text [D87]. Under a turn's `final` answer
 * its actions. Commentary between the turn's steps, a steer's too, has none.
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
      <div data-chat className="text-chat wrap-break-word text-chat-foreground">{children}</div>
      {final && <AnswerMarks text={text} time={time} fork={fork} older={older} />}
    </div>
  );
}

/** A finished answer's actions: copy, save as a note, then fork where offered [D1069], and its time [D102]. */
export function AnswerMarks({ text, time, fork, older = false }: { text: string; time?: number; fork?: ReactNode; older?: boolean }) {
  return (
    // Only the latest answer keeps them in view; an older one's show on hover or focus [D82].
    <div className={cx("group/answer -ms-1 flex items-center gap-0.5 text-faint-foreground", older && "opacity-0 group-focus-within/answer:opacity-100 group-hover/answer:opacity-100")}>
      <CopyButton text={copiedReply(text)} tooltip="Copy response" size="icon-answer" />
      <SaveAsNote text={text} />
      {fork}
      {time !== undefined && (
        <span className="ps-1.5 text-xs tabular-nums">{sentAt(time)}</span>
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

