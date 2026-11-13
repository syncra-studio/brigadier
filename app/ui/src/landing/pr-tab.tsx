import { Tabs } from "@base-ui/react/tabs";
import { type ReactNode, useState } from "react";

import { Button } from "../components/button";
import { ConfirmDialog } from "../components/confirm-dialog";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/menu";
import { Skeleton } from "../components/skeleton";
import { ArrowUpRight, Check, CheckCircle, ChevronDown, Comment, Commit } from "../icons";
import type { Pr } from "../panel/types";
import { ReviewView } from "../review/view";
import { Sparkles } from "./icons";
import { PrFiles } from "./pr-files";
import { CheckAgain, Checks, Commits, Conversation, MergeBox, type Sends, Side, StateBadge } from "./pr-parts";
import type { MergeStyle, PullRequest } from "./pull-requests";

const TAB = cx(
  "flex cursor-pointer items-center gap-1.5 rounded-control px-2.5 py-1 text-sm text-muted-foreground svg:size-icon-sm",
  "hover:text-foreground focus-visible:focus-ring data-active:bg-fill-subtle data-active:text-foreground",
);
const COUNT = "rounded-capsule bg-muted px-1.5 text-xs text-muted-foreground tabular-nums";
/** The page's column, as GitHub's: wide enough for the side column. */
const COLUMN = "mx-auto w-full max-w-settings px-5";

const Ref = ({ children }: { children: ReactNode }) => <span className="rounded-control bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{children}</span>;

/**
 * A pull request in a main-area tab, GitHub's page [D204]: its title, state and "wants to merge", then Conversation
 * (the description, what happened, and the merge box at its end, beside Reviewers, Assignees and Labels), Commits,
 * Checks and Files changed, the Review tab's own diff of the session's branch, or of any other PR as its host cut it
 * [D231]. Every Send and Fix leaves a chip above the composer and sends nothing [D1019, D1027]. It paints its last read at once and shows the watch's age, with
 * Check again; when a read fails, the last one stays with why [D207, D208, D1009].
 */
export function PrTab({
  owner,
  target,
  pr,
  row,
  error,
  checking,
  merging = false,
  refused = null,
  sends,
  onCheck,
  onMerge,
}: {
  owner: string;
  /** Its tab's target: `n`, or `owner/name#n` for another repository's [D213]. */
  target: string;
  /** undefined until its first read lands. */
  pr: PullRequest | undefined;
  /** Its row as the watch keeps it: the header before the first read. */
  row: Pr | undefined;
  error?: string;
  /** A read under way. */
  checking: boolean;
  /** A merge on its way to the host; its refusal is said above the composer [D1264]. */
  merging?: boolean;
  /** Why the host refused the last merge, said under the header too. */
  refused?: string | null;
  sends: Sends;
  onCheck: () => void;
  /** `head`: the commit its confirm showed, which the merge is pinned to [D1077]. */
  onMerge: (style: MergeStyle, head: string) => void;
}) {
  // Check again reads Files changed again too, when it's open [D231].
  const [tick, setTick] = useState(0);
  const check = () => {
    onCheck();
    setTick((n) => n + 1);
  };
  const again = <CheckAgain at={pr?.checkedAtMs ?? null} busy={checking} offline={sends.offline} onClick={check} />;
  if (!pr) {
    return (
      <div data-slot="pr-tab" className="min-h-0 flex-1 overflow-y-auto">
        <div className={cx(COLUMN, "flex flex-col gap-4 py-5")}>
          <div className="flex min-h-control-sm items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate font-display text-lg font-medium">{row ? row.title : <Skeleton className="h-5 w-2/3" />}</h2>
            {again}
          </div>
          {error ? (
            <ErrorLine error={error} />
          ) : (
            <div aria-label="Loading pull request" className="flex flex-col gap-3">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}
        </div>
      </div>
    );
  }
  const fix = pr.state === "open" && pr.blockers !== null && (pr.blockers.failedChecks > 0 || pr.blockers.changesBy.length > 0);
  const fixAdded = sends.added.has("fix");
  // Merge only on Rust's word, while the read is current and the daemon is here.
  const canMerge = pr.merge.allowed && !sends.offline && !pr.problem && !error;
  const open = pr.state === "open" || pr.state === "draft";
  const hint = pr.state === "draft" ? "A draft can't be merged until it's marked ready for review" : canMerge ? `It lands on ${pr.base}` : "Merging is blocked until what's above is resolved";
  const people = pr.comments.filter((comment) => !comment.bot).length;
  return (
    <div data-slot="pr-tab" className="flex min-h-0 flex-1 flex-col">
      <Tabs.Root defaultValue="conversation" className="flex min-h-0 flex-1 flex-col">
        <div className={cx(COLUMN, "flex flex-col gap-4 pt-5")}>
          <header className="flex flex-col gap-2.5">
            <div className="flex min-h-control-sm items-start gap-2">
              <h2 className="min-w-0 flex-1 font-display text-lg font-medium">
                {pr.title} <span className="font-normal text-muted-foreground">#{pr.number}</span>
              </h2>
              {again}
              {fix && (
                <Button size="sm" disabled={fixAdded || sends.offline} onClick={() => sends.onSend({ kind: "fix" })}>
                  {fixAdded ? <Check /> : <Sparkles />}
                  {fixAdded ? "Added" : "Fix with agent"}
                </Button>
              )}
              <TooltipIconButton tooltip={`Open on ${pr.host}`} onClick={() => sends.onOpen("pr")}>
                <ArrowUpRight />
              </TooltipIconButton>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-muted-foreground">
              <StateBadge state={pr.state} />
              <span>
                <span className="text-foreground">{pr.openedBy}</span> {pr.state === "merged" ? "merged" : "wants to merge"} {pr.commitCount}{" "}
                {pr.commitCount === 1 ? "commit" : "commits"} into <Ref>{pr.base}</Ref> from <Ref>{pr.branch}</Ref>
              </span>
            </div>
            {/* Why the last read or merge didn't go: what shows is the last one that did [D1009, D1264]. */}
            <ErrorLine error={error ?? pr.problem ?? refused} />
          </header>
          <Tabs.List className="flex gap-1 border-b border-border pb-2">
            <Tabs.Tab value="conversation" className={TAB}>
              <Comment />
              Conversation <span className={COUNT}>{people}</span>
            </Tabs.Tab>
            <Tabs.Tab value="commits" className={TAB}>
              <Commit />
              Commits <span className={COUNT}>{pr.commitCount}</span>
            </Tabs.Tab>
            <Tabs.Tab value="checks" className={TAB}>
              <CheckCircle />
              Checks <span className={COUNT}>{pr.checks.length}</span>
            </Tabs.Tab>
            <Tabs.Tab value="files" className={TAB}>
              Files changed <span className={COUNT}>{pr.files}</span>
              <span className="text-xs text-success">+{pr.additions}</span>
              <span className="text-xs text-destructive">−{pr.deletions}</span>
            </Tabs.Tab>
          </Tabs.List>
        </div>
        <Tabs.Panel value="conversation" className="min-h-0 flex-1 overflow-y-auto">
          <div className={cx(COLUMN, "flex gap-8 py-5")}>
            <div className="flex min-w-0 flex-1 flex-col gap-5">
              <Conversation pr={pr} sends={sends} />
              {pr.state !== "closed" && (
                <MergeBox
                  pr={pr}
                  sends={sends}
                  merge={
                    open && (
                      <>
                        <MergeButton pr={pr} enabled={canMerge} merging={merging} onMerge={onMerge} />
                        <span className="text-xs text-muted-foreground">{hint}</span>
                      </>
                    )
                  }
                />
              )}
            </div>
            <div className="w-52 shrink-0">
              <Side pr={pr} />
            </div>
          </div>
        </Tabs.Panel>
        <Tabs.Panel value="commits" className="min-h-0 flex-1 overflow-y-auto">
          <div className={cx(COLUMN, "py-5")}>
            <Commits pr={pr} sends={sends} />
          </div>
        </Tabs.Panel>
        <Tabs.Panel value="checks" className="min-h-0 flex-1 overflow-y-auto">
          <div className={cx(COLUMN, "py-5")}>
            <Checks pr={pr} sends={sends} />
          </div>
        </Tabs.Panel>
        <Tabs.Panel value="files" className="flex min-h-0 flex-1 flex-col">
          {pr.onBranch ? <ReviewView owner={owner} kept="branch" /> : <PrFiles owner={owner} target={target} pr={pr} tick={tick} onOpen={() => sends.onOpen("pr")} />}
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}

const SPLIT = "inline-flex h-control-sm items-center bg-muted text-sm font-medium text-foreground transition-all hover:bg-popover focus-visible:focus-ring disabled:opacity-disabled";

const STYLE_WORDS: Record<MergeStyle, string> = {
  merge: "with a merge commit",
  squash: "squashed into one commit",
  rebase: "rebased onto it, commit by commit",
};

const STYLE_ITEMS: Record<MergeStyle, string> = { merge: "Create a merge commit", squash: "Squash and merge", rebase: "Rebase and merge" };

/**
 * Merge in the repo's default style, with the other styles it allows behind the arrow [D1028]; on only while Rust
 * allows it. Each asks first, saying where the checks stand [D1019]; the ask closes if merging stops being allowed.
 */
function MergeButton({ pr, enabled, merging, onMerge }: { pr: PullRequest; enabled: boolean; merging: boolean; onMerge: (style: MergeStyle, head: string) => void }) {
  const [asking, setAsking] = useState<MergeStyle | null>(null);
  const [style, setStyle] = useState<MergeStyle>(pr.merge.default);
  // The head the confirm shows: a push landing while it's open isn't merged unseen [D1077].
  const [head, setHead] = useState(pr.head);
  const ask = (next: MergeStyle) => {
    setStyle(next);
    setHead(pr.head);
    setAsking(next);
  };
  const passed = pr.checks.filter((check) => check.state === "passed").length;
  return (
    <div className="flex">
      <Button size={null} variant={null} disabled={!enabled || merging} className={cx(SPLIT, "rounded-s-capsule ps-2.5 pe-2")} onClick={() => ask(pr.merge.default)}>
        {merging ? "Merging…" : "Merge"}
      </Button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          disabled={!enabled || merging}
          render={<Button size={null} variant={null} aria-label="Merge options" className={cx(SPLIT, "rounded-e-capsule border-s border-border px-1.5 svg:size-icon-md")} />}
        >
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {pr.merge.styles.map((each) => (
            <DropdownMenuItem key={each} onClick={() => ask(each)}>
              {STYLE_ITEMS[each]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={asking !== null && enabled}
        onOpenChange={(open) => !open && setAsking(null)}
        title={`Merge #${pr.number} into ${pr.base}?`}
        description={`${pr.checks.length === 0 ? "It has no checks" : passed === pr.checks.length ? "All checks passed" : `${passed} of ${pr.checks.length} checks passed`}. It lands on ${pr.base} on ${pr.host} ${STYLE_WORDS[style]}.`}
        confirm="Merge"
        busy={merging}
        disabled={!enabled}
        onConfirm={() => {
          if (!enabled) return;
          setAsking(null);
          onMerge(style, head);
        }}
      />
    </div>
  );
}
