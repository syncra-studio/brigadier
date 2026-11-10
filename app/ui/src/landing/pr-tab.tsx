import { Tabs } from "@base-ui/react/tabs";
import { useState } from "react";

import { Button } from "../components/button";
import { ConfirmDialog } from "../components/confirm-dialog";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/menu";
import { ArrowUpRight, Check, ChevronDown } from "../icons";
import { Sparkles } from "./icons";
import { Checks, Comments, History, Overview, PrIcon, type Sends } from "./pr-parts";
import { ago, prLook, TONES } from "./pr-words";
import type { MergeStyle, PullRequest } from "./pull-requests";

export type PrView = "overview" | "checks" | "comments" | "timeline";

const TAB = cx(
  "flex cursor-pointer items-center gap-1.5 rounded-control px-2.5 py-1 text-sm text-muted-foreground",
  "hover:text-foreground focus-visible:focus-ring data-active:bg-fill-subtle data-active:text-foreground",
);

/**
 * A pull request in a main-area tab [D1017, D1032]: its header with Fix with agent, Merge and Open on the host, then
 * Overview, Checks with log tails, Comments and Timeline. Every Send and Fix leaves a chip above the composer and
 * sends nothing [D1019, D1027]. When the watch can't read it, the last known state stays with its age and why [D1009].
 */
export function PrTab({
  pr,
  error,
  view,
  merging = false,
  mergeError,
  sends,
  onMerge,
}: {
  /** undefined while it loads. */
  pr: PullRequest | undefined;
  error?: string;
  /** The sub-tab it opens on. */
  view?: PrView;
  /** A merge on its way to the host. */
  merging?: boolean;
  mergeError?: string;
  sends: Sends;
  onMerge: (style: MergeStyle) => void;
}) {
  if (!pr) {
    return (
      <div data-slot="pr-tab" className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
        {error ? <ErrorLine size="sm" error={error} /> : sends.offline ? "Reconnecting…" : "Loading pull request…"}
      </div>
    );
  }
  const look = prLook(pr);
  const failed = pr.checks.filter((check) => check.state === "failed").length;
  const fix = pr.state === "open" && pr.blockers !== null && (pr.blockers.failedChecks > 0 || pr.blockers.changesBy.length > 0);
  const fixAdded = sends.added.has("fix");
  // Merge only on Rust's word, while the watch is current and the daemon is here.
  const canMerge = pr.merge.allowed && !sends.offline && !pr.problem;
  return (
    <div data-slot="pr-tab" className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-reading flex-col gap-5 p-5">
        <header className="flex flex-col gap-2">
          {/* As tall as its buttons, so the header holds still when they go (merged, closed). */}
          <div className="flex min-h-control-sm items-center gap-2">
            <PrIcon state={pr.state} tone={look.tone} />
            <h2 className="min-w-0 flex-1 truncate font-display text-base font-medium">
              <span className="text-muted-foreground">#{pr.number}</span> {pr.title}
            </h2>
            {fix && (
              <Button size="sm" disabled={fixAdded || sends.offline} onClick={() => sends.onSend({ kind: "fix" })}>
                {fixAdded ? <Check /> : <Sparkles />}
                {fixAdded ? "Added" : "Fix with agent"}
              </Button>
            )}
            {(pr.state === "open" || pr.state === "draft") && <MergeButton pr={pr} enabled={canMerge} merging={merging} onMerge={onMerge} />}
            <TooltipIconButton tooltip={`Open on ${pr.host}`} onClick={() => sends.onOpen("pr")}>
              <ArrowUpRight />
            </TooltipIconButton>
          </div>
          <p className="text-sm text-muted-foreground">
            <span className={pr.problem ? "text-muted-foreground" : TONES[look.tone]}>{look.word}</span>
            {pr.problem && pr.checkedAtMs !== null && ` · ${ago(pr.checkedAtMs, sends.now)}`} · <span className="text-foreground">{pr.branch}</span> into{" "}
            <span className="text-foreground">{pr.base}</span> · opened by {pr.openedBy} {ago(pr.openedAtMs, sends.now)}
            {sends.offline ? " · Reconnecting…" : !pr.problem && pr.checkedAtMs !== null && ` · checked ${ago(pr.checkedAtMs, sends.now)}`}
          </p>
          <ErrorLine error={pr.problem} />
          <ErrorLine error={mergeError && `Couldn't merge #${pr.number}: ${mergeError}`} />
        </header>
        <Tabs.Root defaultValue={view ?? "overview"} className="flex flex-col gap-5">
          <Tabs.List className="flex gap-1 border-b border-border pb-2">
            <Tabs.Tab value="overview" className={TAB}>
              Overview
            </Tabs.Tab>
            <Tabs.Tab value="checks" className={TAB}>
              Checks
              {failed > 0 && <span className="text-xs text-destructive">{failed} failed</span>}
            </Tabs.Tab>
            <Tabs.Tab value="comments" className={TAB}>
              Comments
              {pr.comments.length > 0 && <span className="text-xs text-muted-foreground">{pr.comments.length}</span>}
            </Tabs.Tab>
            <Tabs.Tab value="timeline" className={TAB}>
              Timeline
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="overview" className="flex flex-col gap-5">
            <Overview pr={pr} sends={sends} />
          </Tabs.Panel>
          <Tabs.Panel value="checks">
            <Checks pr={pr} sends={sends} />
          </Tabs.Panel>
          <Tabs.Panel value="comments">
            <Comments pr={pr} sends={sends} />
          </Tabs.Panel>
          <Tabs.Panel value="timeline">
            <History pr={pr} sends={sends} />
          </Tabs.Panel>
        </Tabs.Root>
      </div>
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
function MergeButton({ pr, enabled, merging, onMerge }: { pr: PullRequest; enabled: boolean; merging: boolean; onMerge: (style: MergeStyle) => void }) {
  const [asking, setAsking] = useState<MergeStyle | null>(null);
  const [style, setStyle] = useState<MergeStyle>(pr.merge.default);
  const ask = (next: MergeStyle) => {
    setStyle(next);
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
          onMerge(style);
        }}
      />
    </div>
  );
}
