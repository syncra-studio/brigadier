import { useState } from "react";

import { Button } from "../components/button";
import { copyWithToast } from "../components/copy-button";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/menu";
import { Segmented } from "../components/segmented";
import { Skeleton } from "../components/skeleton";
import { showToast } from "../components/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { ArrowUpRight, ChevronDown, DotsHorizontal, Link } from "../icons";
import { SettingsSlider } from "../icons/sidebar";
import type { Pr } from "../panel/types";
import { PullRequestClosed, PullRequestDraft, PullRequestOpen, Sparkles } from "./icons";
import { prAct } from "./pr-act";
import { MergeDialog, SubmitReviewDialog } from "./pr-dialogs";
import { type ChangesLook, PrFiles } from "./pr-files";
import { CheckAgain, type Sends } from "./pr-parts";
import { Summary } from "./pr-summary";
import type { PrComment, PullRequest } from "./pull-requests";

/** PRs whose tab opens on Changes: the summary card's Code changes [D167]. shortcut: a tab already open stays where it is. */
export const codeFirst = new Set<string>();

/** Why Merge can't be pressed now; null when it can [D164]. */
export function mergeBlocked(pr: PullRequest): string | null {
  if (pr.state === "closed") return "Reopen this pull request before merging";
  if (pr.state === "draft") return "Mark this pull request ready for review before merging";
  if (pr.blockers?.conflicts || pr.mergeState === "dirty") return "Resolve merge conflicts before merging";
  if (pr.checks.some((check) => check.state === "failed")) return "Fix failing checks before merging";
  if (pr.checks.some((check) => check.state === "running")) return "Wait for checks to finish before merging";
  if (pr.mergeState === "blocked") return "This pull request can’t be merged yet";
  if (!pr.mergeState || pr.mergeState === "unknown") return "GitHub is still checking whether this can be merged";
  return null;
}

/** A toolbar button, its reason why not as its tooltip while it can't be pressed. */
function Why({ why, children }: { why: string | null; children: React.ReactElement }) {
  if (!why) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex" />}>{children}</TooltipTrigger>
      <TooltipContent>{why}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A pull request in a tab [D164]: its toolbar (Summary | Changes +a −d, Refresh, then Review, Approve and
 * the Merge split button with auto-merge, and its … menu: Copy link, Open in GitHub, draft or ready, Close or Reopen),
 * then Summary or Changes. It paints its last read at once; when a read fails, the last one stays with why [D1009].
 */
export function PrTab({
  owner,
  target,
  pr,
  row,
  error,
  checking,
  sends,
  onCheck,
  onFix,
  onReview,
  onAddToChat,
}: {
  owner: string;
  /** Its tab's target: `n`, `owner/name#n`, or `host/owner/name#n` [D213]. */
  target: string;
  /** undefined until its first read lands. */
  pr: PullRequest | undefined;
  /** Its row as the watch keeps it: the header before the first read. */
  row: Pr | undefined;
  error?: string;
  /** A read under way. */
  checking: boolean;
  sends: Sends;
  onCheck: () => void;
  onFix: (focus: "checks" | "conflicts" | "comments", check?: string) => void;
  onReview: () => void;
  onAddToChat: (comment: PrComment) => void;
}) {
  // Refresh reads Changes again too, when it's open [D231].
  const [tick, setTick] = useState(0);
  const check = () => {
    onCheck();
    setTick((n) => n + 1);
  };
  // Changes is drawn once first opened, then kept laid out under Summary, so going back to it is only a repaint [D656].
  const [tab, setTab] = useState<"summary" | "code">(() => (codeFirst.delete(target) ? "code" : "summary"));
  const [coded, setCoded] = useState(tab === "code");
  const [merging, setMerging] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [look, setLook] = useState<ChangesLook>({ split: false, tree: true, generated: false });
  const again = <CheckAgain busy={checking} offline={sends.offline} onClick={check} />;
  if (!pr) {
    return (
      <div data-slot="pr-tab" className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-panel-header shrink-0 items-center gap-1 border-b border-border px-2">
          <span className="flex-1" />
          {again}
        </div>
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 pt-8">
          {row ? <h1 className="font-display text-2xl font-medium">{row.title}</h1> : <Skeleton className="h-6 w-2/3" />}
          {error ? (
            <ErrorLine error={error} />
          ) : (
            <div aria-label="Loading pull request details" className="flex flex-col gap-3">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}
        </div>
      </div>
    );
  }
  const act = (verb: "close" | "reopen" | "draft" | "ready" | "automerge", ...rest: string[]) => {
    setBusy(true);
    prAct(verb, pr.ref!, ...rest)
      .catch((cause: Error) => showToast(cause.message || "GitHub could not update this pull request", { tone: "error" }))
      .finally(() => (setBusy(false), sends.onChanged()));
  };
  const live = pr.state === "open" || pr.state === "draft";
  const pending = pr.pending?.count ?? 0;
  const blocked = mergeBlocked(pr);
  const writable = Boolean(pr.ref);
  const tabs = [
    { value: "summary" as const, label: "Summary" },
    {
      value: "code" as const,
      label: (
        <span className="flex items-center gap-1.5">
          Changes
          <span className="text-xs text-success tabular-nums">+{pr.additions}</span>
          <span className="text-xs text-destructive tabular-nums">−{pr.deletions}</span>
        </span>
      ),
    },
  ];
  return (
    <div data-slot="pr-tab" className="flex min-h-0 flex-1 flex-col">
      <div role="toolbar" aria-label="Pull request actions" className="flex h-panel-header shrink-0 items-center gap-1 border-b border-border px-2">
        <Segmented
          label="Pull request content"
          value={tab}
          options={tabs}
          onChange={(next) => {
            setTab(next);
            if (next === "code") setCoded(true);
          }}
        />
        {again}
        {tab === "code" && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger aria-label="Changes options" render={<Button size="icon-md" variant="ghost" />}>
              <SettingsSlider />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup value={look.split ? "split" : "unified"} onValueChange={(value: string) => setLook({ ...look, split: value === "split" })}>
                <DropdownMenuRadioItem value="unified">Unified</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="split">Split</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={look.tree} onCheckedChange={(tree: boolean) => setLook({ ...look, tree })}>
                File tree
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={look.generated} onCheckedChange={(generated: boolean) => setLook({ ...look, generated })}>
                Generated files
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <span className="flex-1" />
        {writable && live && (
          <>
            <Button size="sm" variant="ghost" onClick={onReview}>
              <Sparkles />
              Review
            </Button>
            {(!pr.authored || pending > 0) && (
              <Button size="sm" variant="outline" onClick={() => setReviewing(true)}>
                {pr.authored ? "Submit review" : pending ? `Approve · ${pending}` : "Approve"}
              </Button>
            )}
            <div className="flex items-center gap-px">
              <Why why={blocked}>
                <Button size="sm" className="rounded-e-none" disabled={Boolean(blocked) || busy} onClick={() => setMerging(true)}>
                  Merge
                </Button>
              </Why>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger aria-label="Merge options" render={<Button size="sm" className="rounded-s-none px-1.5" disabled={busy} />}>
                  <ChevronDown />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {pr.autoMerge ? (
                    <DropdownMenuItem onClick={() => act("automerge", "off")}>Disable auto-merge</DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem disabled={pr.state !== "open"} onClick={() => act("automerge", "on", "squash")}>
                      Enable auto-merge
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        )}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger aria-label="More" render={<Button size="icon-md" variant="ghost" />}>
            <DotsHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => copyWithToast(pr.url, "link")}>
              <Link />
              Copy link
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => sends.onOpen("pr")}>
              <ArrowUpRight />
              Open in GitHub
            </DropdownMenuItem>
            {writable && live && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => act(pr.state === "draft" ? "ready" : "draft")}>
                  {pr.state === "draft" ? <PullRequestOpen /> : <PullRequestDraft />}
                  {pr.state === "draft" ? "Mark ready" : "Convert to draft"}
                </DropdownMenuItem>
              </>
            )}
            {writable && pr.state !== "merged" && (
              <DropdownMenuItem variant={live ? "destructive" : "default"} onClick={() => act(live ? "close" : "reopen")}>
                {live ? <PullRequestClosed /> : <PullRequestOpen />}
                {live ? "Close" : "Reopen"}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/* Why the last read didn't go: what shows is the last read that did [D1009]. */}
      <ErrorLine error={error ?? pr.problem} className="px-6 pt-3" />
      <div className="relative min-h-0 flex-1">
        <div hidden={tab !== "summary"} className="absolute inset-0 overflow-y-auto">
          <Summary pr={pr} sends={sends} onFix={onFix} onAddToChat={onAddToChat} />
        </div>
        {/* Invisible, not hidden: display none would lay every diff out again on each return. */}
        <div inert={tab !== "code"} className={cx("absolute inset-0 flex flex-col", tab !== "code" && "invisible")}>
          {coded && <PrFiles owner={owner} target={target} pr={pr} tick={tick} sends={sends} look={look} onOpen={() => sends.onOpen("pr")} onAddToChat={onAddToChat} />}
        </div>
      </div>
      {writable && (
        <>
          <MergeDialog pr={pr} open={merging} onOpenChange={setMerging} onDone={sends.onChanged} />
          <SubmitReviewDialog pr={pr} open={reviewing} onOpenChange={setReviewing} onDone={sends.onChanged} />
        </>
      )}
    </div>
  );
}
