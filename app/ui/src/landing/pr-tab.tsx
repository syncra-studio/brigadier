import { Tabs } from "@base-ui/react/tabs";
import { type SetStateAction, useCallback, useState } from "react";

import { Button } from "../components/button";
import { ConfirmDialog } from "../components/confirm-dialog";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/menu";
import { Skeleton } from "../components/skeleton";
import { ArrowUpRight, Branch, Check, ChevronDown, Folder } from "../icons";
import type { Pr } from "../panel/types";
import { PullRequestOpen, Sparkles } from "./icons";
import { type Draft, drafts, PrFiles, SubmitReview } from "./pr-files";
import { Avatar, CheckAgain, type Sends, StateIcon } from "./pr-parts";
import { useHost } from "./host";
import { Summary } from "./pr-summary";
import type { MergeStyle, PullRequest } from "./pull-requests";

const TAB = cx(
  "relative flex h-9 cursor-pointer items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:focus-ring",
  "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full data-active:text-foreground data-active:after:bg-foreground",
);
const COLUMN = "w-full px-5";

const NO_DRAFT: Draft = { comments: [], body: "" };

/**
 * A pull request in a main-area tab [D204, D609, D613]: its title, state and number, Open on the host and
 * Check again; who, which repository and which branches on one line, each opening its page, all of it selectable
 * [D656]; then Summary (labels, reviewers, checks, the description and review comments) and Code, the PR's diff as
 * its host has it [D231, D262], kept as it was between switches. Beside the tabs, its one action: Fix with agent when
 * checks failed or changes were asked, a draft's too, else Merge while it's open; then Submit review and Review on the
 * host. Every Send and Fix leaves a chip above the composer and sends nothing [D1019, D1027]. It paints its last read
 * at once; when a read fails, the last one stays with why [D207, D208, D1009].
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
  // Check again reads Code again too, when it's open [D231].
  const [tick, setTick] = useState(0);
  const check = () => {
    onCheck();
    setTick((n) => n + 1);
  };
  // The review being written, Code's line comments and Submit review's words, kept while the app runs.
  const key = `${useHost(owner)} ${target}`;
  const [draft, setDraftState] = useState<Draft>(() => drafts.get(key) ?? NO_DRAFT);
  const setDraft = useCallback(
    (next: SetStateAction<Draft>) =>
      setDraftState((now) => {
        const draft = typeof next === "function" ? next(now) : next;
        drafts.set(key, draft);
        return draft;
      }),
    [key],
  );
  // The commit Code's lines were read at.
  const [read, setRead] = useState<string | null>(null);
  // Code is drawn once first opened, then kept laid out under Summary, so going back to it is only a repaint [D656].
  const [tab, setTab] = useState("summary");
  const [coded, setCoded] = useState(false);
  const again = <CheckAgain busy={checking} offline={sends.offline} onClick={check} />;
  if (!pr) {
    return (
      <div data-slot="pr-tab" className="min-h-0 flex-1 overflow-y-auto">
        <div className={cx(COLUMN, "flex flex-col gap-4 py-5")}>
          <div className="flex min-h-control-sm items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate font-display text-xl font-medium">{row ? row.title : <Skeleton className="h-5 w-2/3" />}</h2>
            {again}
          </div>
          {error ? (
            <ErrorLine error={error} />
          ) : (
            <div aria-label="Loading pull request" className="flex flex-col gap-3">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}
        </div>
      </div>
    );
  }
  const fix = (pr.state === "open" || pr.state === "draft") && pr.blockers !== null && (pr.blockers.failedChecks > 0 || pr.blockers.changesBy.length > 0);
  const fixAdded = sends.added.has("fix");
  // Merge only on Rust's word, while the read is current and the daemon is here.
  const canMerge = pr.merge.allowed && !sends.offline && !pr.problem && !error;
  const repo = pr.repo ?? target.split("#")[0];
  const links = pr.links;
  return (
    <div data-slot="pr-tab" className="flex min-h-0 flex-1 flex-col">
      <Tabs.Root
        value={tab}
        onValueChange={(next: string) => {
          setTab(next);
          if (next === "code") setCoded(true);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <header className={cx(COLUMN, "flex flex-col gap-2.5 pt-4")}>
          <div className="flex items-start gap-2">
            <h2 className="min-w-0 flex-1 select-text font-display text-xl leading-snug font-medium tracking-tight break-words">{pr.title}</h2>
            <span className="flex h-control-sm shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <StateIcon state={pr.state} />#{pr.number}
            </span>
            <TooltipIconButton tooltip={`Open on ${pr.host}`} size="icon-md" onClick={() => sends.onOpen("pr")}>
              <ArrowUpRight />
            </TooltipIconButton>
            {again}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground select-text">
            <span className="flex items-center gap-1.5 text-foreground">
              <Avatar login={pr.openedBy} at={pr.checkedAtMs} />
              <Link href={links?.author}>{pr.openedBy}</Link>
            </span>
            {repo && (
              <span className="flex items-center gap-1.5">
                <Folder className="size-icon-sm" />
                <Link href={links?.repo}>{repo}</Link>
              </span>
            )}
            <span className="flex min-w-0 items-center gap-1.5">
              <Branch className="size-icon-sm shrink-0" />
              <span className="min-w-0 break-all">
                <Link href={links?.branch}>{pr.branch}</Link> → {pr.base}
              </span>
            </span>
          </div>
          {/* Why the last read or merge didn't go: what shows is the last one that did [D1009, D1264]. */}
          <ErrorLine error={error ?? pr.problem ?? refused} />
          <div className="flex items-center gap-4 border-b border-divider">
            <Tabs.List className="flex flex-1 gap-4">
              <Tabs.Tab value="summary" className={TAB}>
                Summary
              </Tabs.Tab>
              <Tabs.Tab value="code" className={TAB}>
                Code <span className="text-xs text-muted-foreground tabular-nums">{pr.files}</span>
              </Tabs.Tab>
            </Tabs.List>
            <span className="flex items-center gap-1 pb-1">
              {fix ? (
                <Button size="sm" disabled={fixAdded || sends.offline} onClick={() => sends.onSend({ kind: "fix" })}>
                  {fixAdded ? <Check /> : <Sparkles />}
                  {fixAdded ? "Added" : "Fix with agent"}
                </Button>
              ) : (
                pr.state === "open" && <MergeButton pr={pr} enabled={canMerge} merging={merging} onMerge={onMerge} />
              )}
              <SubmitReview
                owner={owner}
                target={target}
                pr={pr}
                head={read ?? (draft.comments.length ? null : pr.head)}
                draft={draft}
                onDraft={setDraft}
                onReviewed={check}
              />
              <TooltipIconButton tooltip={`Review on ${pr.host}`} size="icon-md" onClick={() => sends.onOpen({ url: `${pr.url}/files` })}>
                <PullRequestOpen />
              </TooltipIconButton>
            </span>
          </div>
        </header>
        <div className="relative min-h-0 flex-1">
          <Tabs.Panel value="summary" className="absolute inset-0 overflow-y-auto">
            <div className={cx(COLUMN, "py-4")}>
              <Summary pr={pr} sends={sends} />
            </div>
          </Tabs.Panel>
          {coded && (
            <div role="tabpanel" aria-label="Code" inert={tab !== "code"} className={cx("absolute inset-0 flex flex-col", tab !== "code" && "invisible")}>
              <PrFiles owner={owner} target={target} pr={pr} tick={tick} draft={draft} onDraft={setDraft} onHead={setRead} onOpen={() => sends.onOpen("pr")} />
            </div>
          )}
        </div>
      </Tabs.Root>
    </div>
  );
}

/** A header word that opens its page on the host, as every link does (Settings › Browser) [D656]; plain without one. */
const Link = ({ href, children }: { href?: string | null; children: string }) =>
  href ? (
    <a href={href} draggable={false} className="hover:text-foreground hover:underline">
      {children}
    </a>
  ) : (
    children
  );

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
  // A skipped check doesn't stand in the way, as on the host.
  const passed = pr.checks.filter((check) => check.state === "passed" || check.state === "skipped").length;
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
