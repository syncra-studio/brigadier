import { Tabs } from "@base-ui/react/tabs";
import { useState } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { Skeleton } from "../components/skeleton";
import { ArrowUpRight, Branch, Folder } from "../icons";
import type { Pr } from "../panel/types";
import { PrFiles } from "./pr-files";
import { Avatar, CheckAgain, type Sends, StateIcon } from "./pr-parts";
import { Summary } from "./pr-summary";
import type { PullRequest } from "./pull-requests";

const TAB = cx(
  "relative flex h-9 cursor-pointer items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:focus-ring",
  "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full data-active:text-foreground data-active:after:bg-foreground",
);
const COLUMN = "w-full px-5";

/**
 * A pull request in a main-area tab [D204, D609, D613]: its title, state and number, Open on the host and
 * Check again; who, which repository and which branches on one line, each opening its page, all of it selectable
 * [D656]; then Summary (labels, reviewers, checks, the description and review comments) and Code, the PR's diff as
 * its host has it [D231, D262], kept as it was between switches. Beside the tabs, its one action, the Start
 * workspace: Bring to agent, which opens a session on the PR's branch with the PR waiting in its composer [D673,
 * D674, D675]; merging and reviewing are on the host or through the agent. It paints its last read at once; when a
 * read fails, the last one stays with why [D207, D208, D1009].
 */
export function PrTab({
  owner,
  target,
  pr,
  row,
  error,
  checking,
  bringing = null,
  failed = null,
  sends,
  onCheck,
  onBring,
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
  /** Bring to agent under way: what it's doing, as its button says. */
  bringing?: string | null;
  /** Why the last Bring to agent didn't go, said under the header. */
  failed?: string | null;
  sends: Sends;
  onCheck: () => void;
  onBring: () => void;
}) {
  // Check again reads Code again too, when it's open [D231].
  const [tick, setTick] = useState(0);
  const check = () => {
    onCheck();
    setTick((n) => n + 1);
  };
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
          {/* Why the last read or Bring to agent didn't go: what shows is the last read that did [D1009]. */}
          <ErrorLine error={failed ?? error ?? pr.problem} />
          <div className="flex items-center gap-4 border-b border-divider">
            <Tabs.List className="flex flex-1 gap-4">
              <Tabs.Tab value="summary" className={TAB}>
                Summary
              </Tabs.Tab>
              <Tabs.Tab value="code" className={TAB}>
                Code <span className="text-xs text-muted-foreground tabular-nums">{pr.files}</span>
              </Tabs.Tab>
            </Tabs.List>
            <span className="flex items-center pb-1">
              <Button size="sm" disabled={bringing !== null || sends.offline} onClick={onBring}>
                {bringing ?? "Bring to agent"}
              </Button>
            </span>
          </div>
        </header>
        <div className="relative min-h-0 flex-1">
          <Tabs.Panel value="summary" className="absolute inset-0 overflow-y-auto">
            <div className={cx(COLUMN, "py-4")}>
              <Summary pr={pr} sends={sends} />
            </div>
          </Tabs.Panel>
          <Tabs.Panel
            value="code"
            keepMounted
            inert={tab !== "code"}
            // Invisible, not `hidden`: display none would lay every diff out again on each return.
            render={(props) => <div {...props} hidden={false} />}
            className={(state) => cx("absolute inset-0 flex flex-col", state.hidden && "invisible")}
          >
            {coded && <PrFiles owner={owner} target={target} pr={pr} tick={tick} onOpen={() => sends.onOpen("pr")} />}
          </Tabs.Panel>
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
