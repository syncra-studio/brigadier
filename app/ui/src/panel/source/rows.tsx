import { Children, createContext, isValidElement, type ReactElement, type ReactNode, use, useEffect, useRef, useState } from "react";

import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../../components/context-menu";
import { cx } from "../../components/cx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/tooltip";
import { Check, ChevronDown, ChevronRight, FileIcon, Spinner } from "../../icons";
import { PullRequestMerged, PullRequestOpen } from "../../landing/icons";
import type { LastRun, Pr, SourceFile } from "../types";
import { ago, baseName, dirName, prWords, runWords, type Tone } from "../words";

/**
 * One row of Source's groups and the card, the old card's 28px row [D1198, D1206]: an icon, the title, an optional
 * second line (`sub`, in `subTone`), and what ends it. `onClick` makes it a button with the row's hover.
 */
export function Line({ icon, end, sub, subTone, onClick, children }: { icon?: ReactNode; end?: ReactNode; sub?: ReactNode; subTone?: string; onClick?: () => void; children: ReactNode }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      {...(onClick && { type: "button" as const, onClick })}
      className={cx(
        "relative isolate flex min-h-7 w-full min-w-0 items-center gap-2 py-0.5 text-start text-label font-prose",
        onClick && "cursor-pointer before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:rounded-control hover:before:bg-muted focus-visible:focus-ring",
      )}
    >
      {icon && <span aria-hidden className="flex min-w-icon-md shrink-0 items-center justify-center text-muted-foreground svg:size-icon-md">{icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{children}</span>
        {sub && <span className={cx("truncate text-xs", subTone ?? "text-muted-foreground")}>{sub}</span>}
      </span>
      {end && <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">{end}</span>}
    </Tag>
  );
}

/** A PR's icon, word and colour: prWords' words, the old card's colours (yellow running, purple merged) [D1198]. */
const PR_TINT: Record<Tone, string> = { quiet: "text-pr-yellow", good: "text-success", warn: "text-pr-yellow", bad: "text-destructive" };
export function PrLine({ pr, onClick }: { pr: Pr; onClick?: () => void }) {
  const { word, tone } = prWords(pr);
  const tint = pr.state === "merged" ? "text-pr-purple" : pr.state === "open" && pr.health === "unknown" ? "text-muted-foreground" : PR_TINT[tone];
  return (
    <Line onClick={onClick} icon={<span className={cx("flex", tint)}>{pr.state === "merged" ? <PullRequestMerged /> : <PullRequestOpen />}</span>} end={<span className={tint}>{word}</span>}>
      <span className="text-muted-foreground">#{pr.number}</span> {pr.title}
    </Line>
  );
}

const RUN_DOT: Record<Tone, string> = { quiet: "bg-muted-foreground", good: "bg-success", warn: "bg-warning", bad: "bg-destructive" };
const RUN_TEXT: Record<Tone, string> = { quiet: "", good: "", warn: "text-warning", bad: "text-destructive" };

/** The agent's last test or build run, as a fact (2.38) [D1188]. */
export function RunLine({ run, nowMs }: { run: LastRun; nowMs: number }) {
  const words = runWords(run);
  return (
    <Line
      icon={<span className={cx("size-1.5 rounded-capsule", RUN_DOT[words.tone])} />}
      sub={<>{ago(run.atMs, nowMs)}<span className={cx(run.changed && "text-warning")}> · {words.since}</span></>}
      end={<span className={RUN_TEXT[words.tone]}>{words.result}</span>}
    >
      <span className="font-mono text-xs">{run.command}</span>
    </Line>
  );
}

/** "+62 −8": lines added and removed, each only when there are some. */
export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      {added > 0 && <span className="text-success">+{added}</span>} {removed > 0 && <span className="text-destructive">−{removed}</span>}
    </span>
  );
}

/** A group's quiet heading: "Changes · 6", and what ends it (Review) [D1201]. */
export function Heading({ title, count, end }: { title: string; count?: number; end?: ReactNode }) {
  return (
    <header className="flex h-7 items-center gap-2 text-label text-muted-foreground">
      <h3 className="min-w-0 flex-1 truncate font-normal">{count === undefined ? title : `${title} · ${count}`}</h3>
      {end}
    </header>
  );
}

/** A heading that folds its rows away ("Merged cleanly" during a merge). */
export function Group({ title, count, defaultOpen = true, children }: { title: string; count: number; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section aria-label={title} className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-7 cursor-pointer items-center gap-1 rounded-control text-start text-label text-muted-foreground hover:text-foreground focus-visible:focus-ring"
      >
        <span>{`${title} · ${count}`}</span>
        {open ? <ChevronDown className="size-icon-xs" /> : <ChevronRight className="size-icon-xs" />}
      </button>
      {open && <FileList>{children}</FileList>}
    </section>
  );
}

export type RowActions = {
  onOpen?: () => void;
  onOpenFile?: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
};

type RowProps = {
  file: SourceFile;
  /** Some of its changes are staged, some not, or both (then it offers Stage and Unstage). */
  staged?: boolean;
  unstaged?: boolean;
  /** Committed since the base, nothing left in the working tree: only Open File. */
  committed?: boolean;
  selected?: boolean;
  locked?: boolean;
  pending?: boolean;
  /** A flagged file's fact, in amber under its name (2.38) [D1188]. */
  fact?: string | null;
  actions?: RowActions;
};

type Picked = { path: string; row: HTMLElement };

const PickMenu = createContext<(picked: Picked) => void>(() => {});

/**
 * A list of FileRows and their right-click menu: one menu for the list, filled by the row it opened on. A menu per row
 * made a long list slow to mount, so the panel stuttered while sliding open [D1156]. The menu reads that row's props
 * as they are now, so a lock or a move shows in it at once, and it closes if the row goes.
 * `held`: the gallery holds the first row's menu open there.
 */
export function FileList({ held, children }: { held?: HTMLElement; children: ReactNode }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const row = picked && Children.toArray(children).find((child): child is ReactElement<RowProps> => isValidElement<RowProps>(child) && child.props.file?.path === picked?.path);
  // Its row went (the file's no longer changed): the menu's done, and won't come back with the file.
  if (picked && !row) {
    setPicked(null);
    setOpen(false);
  }
  // Held open in the gallery there's no right-click: the first row is right-clicked for it, and its menu hangs from it.
  useEffect(() => {
    if (held) list.current?.querySelector("button")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  }, [held]);
  return (
    <PickMenu value={setPicked}>
      <ContextMenu open={(open || held !== undefined) && !!row} onOpenChange={setOpen}>
        <ContextMenuTrigger render={<ul ref={list} className="flex flex-col" />}>{children}</ContextMenuTrigger>
        <ContextMenuContent
          finalFocus={() => {
            // Back to its row, unless the click that closed it went to another control.
            const at = picked?.row.ownerDocument.activeElement;
            return !at || at === document.body || at.closest('[data-slot="context-menu-content"]') ? (picked?.row ?? true) : false;
          }}
          {...(held && picked && { container: held, anchor: picked.row, side: "bottom", align: "start", collisionAvoidance: { side: "none", align: "none" } as const })}
        >
          {row && <MenuItems {...row.props} />}
        </ContextMenuContent>
      </ContextMenu>
    </PickMenu>
  );
}

/** Open File, Stage or Unstage, and Discard: what a row's right-click offers. */
function MenuItems({ file, staged = false, unstaged = !staged, committed = false, locked = false, pending = false, actions = {} }: RowProps) {
  const off = locked || pending;
  return (
    <>
      {file.status !== "deleted" && <ContextMenuItem onClick={actions.onOpenFile}>Open File</ContextMenuItem>}
      {!committed && (
        <>
          {unstaged && (
            <ContextMenuItem disabled={off} onClick={actions.onStage}>
              Stage
            </ContextMenuItem>
          )}
          {staged && (
            <ContextMenuItem disabled={off} onClick={actions.onUnstage}>
              Unstage
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem disabled={off} onClick={actions.onDiscard}>
            Discard Changes…
          </ContextMenuItem>
        </>
      )}
    </>
  );
}

/**
 * A changed file, one quiet row [D1098, D1103, D1110]: its icon, name and counts, its folder as the tooltip, a ✓ when
 * staged, a warning when conflicted. A click opens its diff (a conflicted one its conflict tab); a right-click opens
 * its FileList's menu. `pending`: moved at once, waiting for Rust's answer [D30].
 */
export function FileRow({ file, staged = false, committed = false, selected = false, pending = false, fact = null, actions = {} }: RowProps) {
  const conflicted = file.status === "conflicted";
  const folder = dirName(file.path);
  const pick = use(PickMenu);
  return (
    <li>
      <button
        type="button"
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : folder || undefined}
        aria-current={selected || undefined}
        aria-busy={pending || undefined}
        onClick={actions.onOpen}
        onContextMenu={(event) => {
          // A deleted file that's committed has nothing to offer: no menu.
          if (committed && file.status === "deleted") return event.stopPropagation();
          pick({ path: file.path, row: event.currentTarget });
        }}
        className={cx(
          "relative isolate flex min-h-7 w-full cursor-pointer items-center gap-2 py-0.5 text-start text-label font-prose before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:rounded-control hover:before:bg-muted focus-visible:focus-ring",
          selected && "before:bg-muted",
        )}
      >
        <span aria-hidden className="flex min-w-icon-md shrink-0 items-center justify-center">
          <FileIcon name={baseName(file.path)} size="sm" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cx("truncate", file.status === "deleted" && "line-through")}>{baseName(file.path)}</span>
          {fact && <span className="truncate text-xs text-warning">{fact}</span>}
        </span>
        {staged && (
          <Tooltip>
            <TooltipTrigger render={<span className="flex shrink-0 text-muted-foreground svg:size-icon-xs" />}>
              <Check />
            </TooltipTrigger>
            <TooltipContent>Staged</TooltipContent>
          </Tooltip>
        )}
        {pending ? (
          <Spinner className="size-icon-xs shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
        ) : conflicted ? (
          <span className="shrink-0 text-xs text-warning">Conflict</span>
        ) : (
          <Counts added={file.added} removed={file.removed} />
        )}
      </button>
    </li>
  );
}
