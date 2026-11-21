import { copyWithToast } from "../components/copy-button";
import { cx } from "../components/cx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/menu";
import { RowAction, RowActionsSlot } from "../components/row-action";
import { showToast } from "../components/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { ask } from "../daemon";
import { ArrowUpRight, DotsHorizontal, Link } from "../icons";
import { Pin, Unpin } from "../icons/sidebar";
import { PullRequestClosed, PullRequestDraft, PullRequestOpen, Sparkles } from "../landing/icons";
import { Avatar } from "../landing/pr-parts";
import { openReview } from "./review";
import { openPrPage, pinned, type PrRow, togglePin } from "./route";
import type { View } from "./nav";

/** "5m", "21h", "3d". */
export function age(ms: number, now = Date.now()): string {
  const m = Math.max(0, Math.floor((now - ms) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

/** A row's GitHub write: Rust's `host @ <verb> <ref>`; refused, it says why, and the sections read again either way. */
function write(verb: "draft" | "ready" | "close" | "reopen", row: PrRow, done: () => void): void {
  ask({ op: "run", args: ["host", "@", verb, row.ref] }, (reply) => {
    if (!reply.ok) showToast(String(reply.error), { tone: "error" });
    done();
  });
}

/**
 * A PR in the sidebar [D159 D161 D177]: Detailed, its title on up to two lines over the author's picture, name and
 * age; Compact, the title alone. Hovered, it fills, its full title shows beside it, and its … menu: Pin, Copy link, Open in
 * GitHub, Review, Convert to draft or Mark ready, Close or Reopen; the last two act on GitHub.
 */
export function PrNavRow({ row, view, current, onChanged }: { row: PrRow; view: View; current: boolean; onChanged: () => void }) {
  const isPinned = pinned.use().some((each) => each.ref === row.ref);
  const open = row.state === "open";
  return (
    <li className="group/row relative">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-current={current ? "page" : undefined}
              onClick={() => openPrPage(row)}
              className={cx(
                "flex w-full min-w-0 cursor-pointer flex-col rounded-row px-2 text-start focus-visible:focus-ring",
                "hover:bg-fill group-hover/row:bg-fill group-has-data-popup-open/row:bg-fill page-current:bg-selection",
                view === "detailed" ? "py-1.5" : "min-h-nav-row justify-center",
              )}
            />
          }
        >
          <span className={cx("pe-6 text-sm text-foreground page-current:text-primary", view === "detailed" ? "line-clamp-2 leading-5" : "truncate")}>{row.title}</span>
          {view === "detailed" && (
            <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-faint-foreground">
              <Avatar login={row.author ?? null} size="size-4" />
              <span className="truncate">{row.author ?? "ghost"}</span>
              {row.createdAtMs && <span className="shrink-0">· {age(row.createdAtMs)}</span>}
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent side="right">{row.title}</TooltipContent>
      </Tooltip>
      <RowActionsSlot className={view === "detailed" ? "top-1.5 bottom-auto h-5" : undefined}>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger render={<RowAction aria-label="More" />}>
            <DotsHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => togglePin(row)}>
              {isPinned ? <Unpin /> : <Pin />}
              {isPinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => copyWithToast(row.url, "link")}>
              <Link />
              Copy link
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => window.brigadier?.openLink(row.url)}>
              <ArrowUpRight />
              Open in GitHub
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openReview(row)}>
              <Sparkles />
              Review
            </DropdownMenuItem>
            {open && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => write(row.draft ? "ready" : "draft", row, onChanged)}>
                  {row.draft ? <PullRequestOpen /> : <PullRequestDraft />}
                  {row.draft ? "Mark ready" : "Convert to draft"}
                </DropdownMenuItem>
              </>
            )}
            {row.state !== "merged" && (
              <DropdownMenuItem variant={open ? "destructive" : "default"} onClick={() => write(open ? "close" : "reopen", row, onChanged)}>
                {open ? <PullRequestClosed /> : <PullRequestOpen />}
                {open ? "Close" : "Reopen"}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </RowActionsSlot>
    </li>
  );
}
