import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";

import { Button } from "../components/button";
import { copyWithToast } from "../components/copy-button";
import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/menu";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { Textarea } from "../components/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { ArrowUpRight, ChevronDown, Compare, DotsHorizontal, FileDocument, Link, Sidebar, Spinner } from "../icons";
import { Pin } from "../icons/sidebar";
import { pinned, type PrRow, togglePin } from "../pull-requests/route";
import { GitHub } from "./icons";
import type { ChangesLook } from "./pr-files";
import type { PullRequest } from "./pull-requests";

/** 3100 as 3.1K, a compact count. */
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** A button's reason why not as its tooltip while it can't be pressed. */
export function Why({ why, children }: { why: string | null; children: ReactElement }) {
  if (!why) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex" />}>{children}</TooltipTrigger>
      <TooltipContent>{why}</TooltipContent>
    </Tooltip>
  );
}

/** The PR as the page's rows keep it, for Pin. */
const rowOf = (pr: PullRequest): PrRow => ({ ref: pr.ref!, number: pr.number, title: pr.title, url: pr.url, state: pr.state === "draft" ? "open" : pr.state, draft: pr.state === "draft", author: pr.openedBy, createdAtMs: pr.openedAtMs });

const INSTRUCTIONS = "pullRequests.reviewInstructions";

/** Review ▾: review instructions kept for every review started here, then Start review asks the review chat. */
function ReviewButton({ onStart }: { onStart: (instructions: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => localStorage.getItem(INSTRUCTIONS) ?? "");
  return (
    <Popover open={open} onOpenChange={(next) => (setOpen(next), next && setText(localStorage.getItem(INSTRUCTIONS) ?? ""))}>
      <PopoverTrigger render={<Button size="sm" variant="outline" className="app-no-drag" />}>
        Review
        <ChevronDown className="opacity-70" />
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">Review instructions</h2>
          <p className="text-sm text-muted-foreground">Added to reviews you start in Pull Requests, across all repositories</p>
        </div>
        <Textarea aria-label="Review instructions" rows={4} value={text} placeholder="For example: I care most about the data model…" onChange={(event) => setText(event.target.value)} />
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            className="flex-1"
            onClick={() => {
              localStorage.setItem(INSTRUCTIONS, text.trim());
              setOpen(false);
              onStart(text.trim());
            }}
          >
            Start review
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const VERDICT = { approved: "Approved", changes: "Requested changes", commented: "Commented" } as const;

/**
 * A pull request's toolbar [D240]: Summary | Changes +a −d as one pill and a spinner while it reads; then
 * Changes' options, Pin, Copy URL and Open in GitHub, Review ▾, Approve (white while it's yours to give) and Merge ▾, and
 * on Changes the file tree's toggle. No refresh button: ⌘R reads it again. The PR's state changes are its pill's (Summary).
 */
export function PrToolbar({
  pr,
  tab,
  onTab,
  checking,
  onCheck,
  look,
  onLook,
  busy,
  blocked,
  onReview,
  onApprove,
  onMerge,
  act,
}: {
  pr: PullRequest | undefined;
  tab: "summary" | "code";
  onTab: (tab: "summary" | "code") => void;
  checking: boolean;
  onCheck: () => void;
  look: ChangesLook;
  onLook: (look: ChangesLook) => void;
  busy: boolean;
  blocked: string | null;
  onReview: (instructions: string) => void;
  onApprove: () => void;
  onMerge: () => void;
  act: (verb: "ready" | "automerge", ...rest: string[]) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  // ⌘R reads it again while it's the one in front.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "r" || !bar.current || bar.current.closest("[inert]")) return;
      event.preventDefault();
      onCheck();
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onCheck]);
  const pins = pinned.use();
  const live = pr && (pr.state === "open" || pr.state === "draft");
  const writable = Boolean(pr?.ref);
  const pending = pr?.pending?.count ?? 0;
  const mine = pr?.reviewers.find((each) => each.login === pr.viewer && each.state !== "requested");
  const tabButton = (value: "summary" | "code", icon: ReactNode, label: ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === value}
      onClick={() => onTab(value)}
      className={cx("flex h-7 cursor-pointer items-center gap-1.5 rounded-capsule px-2.5 text-sm focus-visible:focus-ring svg:size-icon-sm", tab === value ? "bg-fill-hover text-foreground" : "text-muted-foreground hover:text-foreground")}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <div ref={bar} role="toolbar" aria-label="Pull request actions" data-slot="pr-toolbar" className="flex h-tab-bar shrink-0 items-center gap-1.5 border-b border-border pe-2 ps-2">
      <div role="tablist" aria-label="Pull request content" className="app-no-drag flex items-center rounded-capsule bg-fill-subtle p-0.5">
        {tabButton("summary", <FileDocument />, "Summary")}
        {tabButton(
          "code",
          <Compare />,
          <>
            Changes
            {pr && (
              <span className="flex gap-1 font-mono text-xs tracking-tight tabular-nums">
                <span className="text-success">+{compact.format(pr.additions)}</span>
                <span className="text-destructive">−{compact.format(pr.deletions)}</span>
              </span>
            )}
          </>,
        )}
      </div>
      {checking && <Spinner aria-label="Refreshing" className="ms-1 size-icon-sm text-muted-foreground motion-safe:animate-spin" />}
      <span className="flex-1" />
      {pr && (
        <div className="app-no-drag flex items-center gap-2">
          {tab === "code" && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger render={<TooltipIconButton tooltip="Changes options" look="toolbar" />}>
                <DotsHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup value={look.split ? "split" : "unified"} onValueChange={(value: string) => onLook({ ...look, split: value === "split" })}>
                  <DropdownMenuRadioItem value="unified">Unified diff</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="split">Split diff</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem checked={look.generated} onCheckedChange={(generated: boolean) => onLook({ ...look, generated })}>
                  Generated files
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <div className="flex items-center">
            {writable && (
              <TooltipIconButton tooltip={pins.some((each) => each.ref === pr.ref) ? "Unpin from sidebar" : "Pin to sidebar"} look="toolbar" pressed={pins.some((each) => each.ref === pr.ref)} onClick={() => togglePin(rowOf(pr))}>
                <Pin />
              </TooltipIconButton>
            )}
            <TooltipIconButton tooltip="Copy URL" look="toolbar" onClick={() => copyWithToast(pr.url, "link")}>
              <Link />
            </TooltipIconButton>
            <TooltipIconButton tooltip={`Open in ${pr.host}`} look="toolbar" onClick={() => window.open(pr.url)}>
              {pr.host === "GitHub" ? <GitHub /> : <ArrowUpRight />}
            </TooltipIconButton>
          </div>
          {writable && live && (
            <>
              <ReviewButton onStart={onReview} />
              <Why why={pr.authored && !pending ? "Add a pending comment to submit a review of your own pull request" : null}>
                <Button size="sm" variant={pr.authored || mine ? "outline" : "default"} disabled={pr.authored && !pending} onClick={onApprove}>
                  {mine && !pending ? VERDICT[mine.state as keyof typeof VERDICT] : pending ? `Approve · ${pending}` : "Approve"}
                  <ChevronDown className="opacity-70" />
                </Button>
              </Why>
              {pr.state === "draft" ? (
                <Button size="sm" variant={pr.authored ? "default" : "outline"} disabled={busy} onClick={() => act("ready")}>
                  Mark ready
                </Button>
              ) : (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger render={<Button size="sm" variant={pr.authored && !blocked ? "default" : "outline"} disabled={busy} />}>
                    {busy ? "Merging…" : "Merge"}
                    <ChevronDown className="opacity-70" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem disabled={Boolean(blocked)} onClick={onMerge}>
                      <span className="flex flex-col">
                        Merge
                        {blocked && <span className="text-xs text-muted-foreground">{blocked}</span>}
                      </span>
                    </DropdownMenuItem>
                    {pr.autoMerge ? <DropdownMenuItem onClick={() => act("automerge", "off")}>Disable auto-merge</DropdownMenuItem> : <DropdownMenuItem onClick={() => act("automerge", "on", "squash")}>Enable auto-merge</DropdownMenuItem>}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          )}
          {tab === "code" && (
            <TooltipIconButton tooltip={look.tree ? "Hide file tree" : "Show file tree"} look="toolbar" pressed={look.tree} onClick={() => onLook({ ...look, tree: !look.tree })}>
              <Sidebar className="-scale-x-100" />
            </TooltipIconButton>
          )}
        </div>
      )}
    </div>
  );
}
