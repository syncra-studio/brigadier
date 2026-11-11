import type { ReactNode } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, MenuRow } from "../components/menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { ArrowRotateCw, ArrowUp, ChevronDown, Commit, Spinner } from "../icons";
import { PullRequestMerged, PullRequestOpen, Sparkles } from "../landing/icons";

/** The control's acts: the menu's rows, Merge into main last [D1277, D1286]. */
export type GitAct = "commit" | "push" | "createPr" | "sync" | "catchUp" | "merge";
/** Why a row can't run, as Rust says it. */
export type GitWhy =
  | "clean" | "commitFirst" | "pushFirst" | "pushed" | "synced" | "unpublished" | "prOpen" | "inPrTab" | "moved"
  | "upToDate" | "conflicts" | "landed" | "prMerged" | "noBase" | "noCommits" | "remoteBase" | "baseBusy" | "shared" | "noRemote" | "behind" | "noHost";
/**
 * Rust's step for the card's control (2.48): the next step, null when there's nothing to do (a grey Commit, D1287);
 * each row's reason when it can't run; and the facts the words need. `resolve`: catching up or syncing would conflict,
 * with the operation and ref the agent's chip asks for [D1290].
 */
export type GitStep = {
  next: GitAct | "resolve" | null;
  off: Partial<Record<GitAct, GitWhy>>;
  base: string | null;
  branch: string | null;
  ahead: number;
  behind: number;
  moved: number;
  files: number;
  pr: number | null;
  sharedWith?: string | null;
  resolve: { op: "merge" | "pull"; ref: string; files: string[] } | null;
  /** Merged into the base on this machine, while it holds. */
  landedAtMs: number | null;
};

const ROWS: GitAct[] = ["commit", "push", "createPr", "sync", "catchUp"];

/** Each act's label and icon; Sync counts what it pulls and pushes, as VS Code's [D1286]. */
function face(act: GitAct | "resolve", step: GitStep): { label: string; icon: ReactNode } {
  switch (act) {
    case "commit":
      return { label: "Commit", icon: <Commit /> };
    case "push":
      return { label: "Push", icon: <ArrowUp /> };
    case "createPr":
      return { label: "Create PR", icon: <PullRequestOpen /> };
    case "sync":
      return { label: step.behind || step.ahead ? `Sync ${[step.behind && `↓${step.behind}`, step.ahead && `↑${step.ahead}`].filter(Boolean).join(" ")}` : "Sync", icon: <ArrowRotateCw /> };
    case "catchUp":
      return { label: `Catch up with ${step.base ?? "main"}`, icon: <ArrowRotateCw /> };
    case "merge":
      return { label: `Merge into ${step.base ?? "main"}`, icon: <PullRequestMerged /> };
    case "resolve":
      return { label: "Resolve with agent", icon: <Sparkles /> };
  }
}

/** Why a row can't run, in words; Rust sends only the reason [D65, D1286]. */
export function whyWords(why: GitWhy, step: GitStep): string {
  const base = step.base ?? "main";
  switch (why) {
    case "clean":
      return "Nothing to commit";
    case "commitFirst":
      return "Commit first";
    case "pushFirst":
      return "Push first";
    case "pushed":
      return "Nothing to push";
    case "synced":
      return "Nothing to sync";
    case "unpublished":
      return "Push first";
    case "prOpen":
      return `PR #${step.pr ?? ""} is open`;
    case "inPrTab":
      return "Merge the PR in the PR tab";
    case "moved":
      return `${base} moved: catch up first`;
    case "upToDate":
      return `Up to date with ${base}`;
    case "conflicts":
      return "It would conflict: resolve with the agent";
    case "landed":
      return `Already in ${base}`;
    case "prMerged":
      return "Its PR is merged · nothing new";
    case "noBase":
      return "No branch to land into here";
    case "noCommits":
      return `No commits beyond ${base}`;
    case "remoteBase":
      return `${base} is a remote branch · open a PR instead`;
    case "baseBusy":
      return `Can't merge into ${base} yet`;
    case "shared":
      return `Landing stays with ${step.sharedWith ?? "the other session"}`;
    case "noRemote":
      return "No remote to push to";
    case "behind":
      return "Sync first";
    case "noHost":
      return "No host to open a PR on";
  }
}

/**
 * The card's git control, in its title row (w97's direction A) [D1278, D1285]: the label is the next step only and a
 * click does that one thing; with nothing to do it rests on a grey Commit [D1287]. The arrow always holds the same
 * rows, each grey with its reason when it can't run [D1277, D1286]. `off`: why the whole control can't run now (the
 * agent works, git can't be read, the daemon is away) [D30, D1208]; `running`: the act under way, with the kit's
 * spinner [D1143].
 */
export function GitControl({ step, off, running, onRun }: { step: GitStep; off: string | null; running: GitAct | "resolve" | null; onRun: (act: GitAct | "resolve") => void }) {
  const next = step.next ?? "commit";
  const { label, icon } = face(running ?? next, step);
  const why = off ?? (step.next === null ? (step.off.commit ? whyWords(step.off.commit, step) : null) : null);
  const box = "h-control-xs text-xs svg:size-icon-xs";
  // The old one button's primary look whenever it can run; grey only when it can't [D1306].
  const variant = why === null ? "default" : "secondary";
  const main = (
    <Button size={null} variant={variant} disabled={why !== null || running !== null} onClick={() => onRun(next)} className={cx("inline-flex min-w-0 items-center justify-center gap-1 rounded-s-capsule px-2.5 font-medium whitespace-nowrap", box)}>
      {running ? <Spinner className="animate-spin motion-reduce:animate-none" /> : icon}
      <span>{label}</span>
    </Button>
  );
  const row = (act: GitAct) => {
    const rowWhy = step.off[act];
    return (
      <DropdownMenuItem key={act} disabled={rowWhy !== undefined} onClick={() => onRun(act)}>
        <MenuRow icon={face(act, step).icon} title={face(act, step).label} {...(rowWhy !== undefined && { detail: whyWords(rowWhy, step), twoLine: true })} />
      </DropdownMenuItem>
    );
  };
  return (
    <div className="flex shrink-0">
      {why ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex" />}>{main}</TooltipTrigger>
          <TooltipContent>{why}</TooltipContent>
        </Tooltip>
      ) : (
        main
      )}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          disabled={off !== null || running !== null}
          render={<Button size={null} variant={variant} aria-label="Commit, push, create PR, sync, catch up or merge" className={cx("inline-flex items-center rounded-e-capsule border-s border-split-edge px-1.5", box)} />}
        >
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          {ROWS.map(row)}
          <DropdownMenuSeparator />
          {row("merge")}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
