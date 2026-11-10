import { DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, MenuRow } from "../../components/menu";
import { Check, PullRequestOpen, Publish, Sparkles } from "../../icons";
import type { MergeStyle, Step } from "../types";
import type { PrWay } from "./create-pr";
import { plural } from "../words";

/** What a pick in the action button's menu asks for; until it's wired, each is a no-op. */
export type ActionPick =
  | "commit" | "amend" | "commitPush" | "commitSync" | "commitMerge" | "commitPr"
  | "createPr" | "pushBranch" | "openPrPage" | "catchUp" | "catchUpMerge" | "catchUpRebase" | "catchUpAgent"
  | "continue" | "abortCatchUp" | "mergeLocally" | "forcePush" | "fixChecks" | "fixComments" | "fixConflicts" | "fixAll";

/** Each step's menu: every other way on from here [D1008, D1015, D1028]. Landed has none. */
export function hasActionMenu(step: Step): boolean {
  return step.kind !== "landed";
}

/**
 * The arrow menu beside the action button: Commit's combos, Merge's style and the PR way, Catch up's ways, or a
 * folder's old CommitActionsMenu. Resolve with agent leaves a chip above the composer and sends nothing [D1044].
 * `rejected`: a push was just turned away, so Force Push is offered [D1034]. `prWay`: Create PR through the host's
 * CLI, else its PR page, else Push branch alone [D1030].
 */
export function ActionMenu({ step, mergeStyle = "merge", rejected = false, prWay = "cli", onMergeStyle, onPick, held }: {
  step: Step;
  prWay?: PrWay;
  mergeStyle?: MergeStyle;
  rejected?: boolean;
  onMergeStyle?: (style: MergeStyle) => void;
  onPick?: (pick: ActionPick) => void;
  held?: HTMLElement;
}) {
  const pick = (what: ActionPick) => () => onPick?.(what);
  const createPr = (title: string) =>
    prWay === "page" ? (
      <DropdownMenuItem onClick={pick("openPrPage")}><MenuRow icon={<PullRequestOpen />} title="Open PR page ↗" /></DropdownMenuItem>
    ) : (
      prWay !== "none" && <DropdownMenuItem disabled={prWay === "loading"} onClick={pick("createPr")}><MenuRow icon={<PullRequestOpen />} title={title} /></DropdownMenuItem>
    );
  const place = held && { container: held, collisionAvoidance: { side: "none", align: "none" } as const };
  const force = rejected && (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={pick("forcePush")}>Force Push (with lease)…</DropdownMenuItem>
    </>
  );
  // The pick's check leads its row, as the old mock drew it.
  const styleItem = (value: MergeStyle, title: string) => (
    <DropdownMenuRadioItem value={value} indicator={<span />}>
      <MenuRow icon={mergeStyle === value ? <Check /> : null} title={title} />
    </DropdownMenuRadioItem>
  );
  const styles = (pr: boolean) => (
    <DropdownMenuRadioGroup value={mergeStyle} onValueChange={(value: MergeStyle) => onMergeStyle?.(value)}>
      {styleItem("merge", "Merge commit")}
      {styleItem("squash", pr ? "Squash" : "Squash into one commit")}
      {pr && styleItem("rebase", "Rebase")}
    </DropdownMenuRadioGroup>
  );
  let items;
  switch (step.kind) {
    case "commit":
      items = (
        <>
          <DropdownMenuItem onClick={pick("commit")}>Commit</DropdownMenuItem>
          <DropdownMenuItem onClick={pick("amend")}>Commit (Amend)</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={pick("commitMerge")}>Commit &amp; Merge into {step.base}</DropdownMenuItem>
          <DropdownMenuItem onClick={pick("commitPush")}>Commit &amp; Push</DropdownMenuItem>
          <DropdownMenuItem onClick={pick("commitPr")}>Commit &amp; Create PR…</DropdownMenuItem>
        </>
      );
      break;
    case "merge":
      items = (
        <>
          <DropdownMenuLabel>Merge as</DropdownMenuLabel>
          {styles(false)}
          <DropdownMenuSeparator />
          {prWay !== "page" && createPr("Create PR…")}
          <DropdownMenuItem onClick={pick("pushBranch")}><MenuRow icon={<Publish />} title="Push branch" /></DropdownMenuItem>
          {prWay === "page" && createPr("Create PR…")}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={pick("catchUp")}>Catch up with {step.base}</DropdownMenuItem>
        </>
      );
      break;
    case "catchUp":
      items = (
        <>
          <DropdownMenuItem onClick={pick("catchUpMerge")}>Catch up by merging {step.base}</DropdownMenuItem>
          <DropdownMenuItem onClick={pick("catchUpRebase")}>Catch up by rebasing onto {step.base}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={pick("catchUpAgent")}><MenuRow icon={<Sparkles />} title="Catch up, then resolve with agent" /></DropdownMenuItem>
          {prWay !== "none" && (
            <>
              <DropdownMenuSeparator />
              {createPr("Create PR anyway…")}
            </>
          )}
        </>
      );
      break;
    case "continue":
      // The button resolves with the agent while conflicts are left; Continue waits here until none are [D1093].
      items = (
        <>
          {step.left > 0 && (
            <>
              <DropdownMenuItem disabled>Continue · {plural(step.left, "conflict")} left</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onClick={pick("abortCatchUp")}>Abort catching up</DropdownMenuItem>
        </>
      );
      break;
    case "mergePr":
      items = (
        <>
          <DropdownMenuLabel>Merge #{step.pr} as</DropdownMenuLabel>
          {styles(true)}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={pick("mergeLocally")}>Merge into {step.base} locally</DropdownMenuItem>
        </>
      );
      break;
    case "fixPr":
      // Each only leaves a chip above the composer [D1019, D1076].
      items = (
        <>
          <DropdownMenuLabel>Fix with agent</DropdownMenuLabel>
          <DropdownMenuItem onClick={pick("fixChecks")}><MenuRow icon={<Sparkles />} title="Failing checks" /></DropdownMenuItem>
          <DropdownMenuItem onClick={pick("fixComments")}><MenuRow icon={<Sparkles />} title="Comments" /></DropdownMenuItem>
          <DropdownMenuItem onClick={pick("fixConflicts")}><MenuRow icon={<Sparkles />} title="Conflicts" /></DropdownMenuItem>
          <DropdownMenuItem onClick={pick("fixAll")}><MenuRow icon={<Sparkles />} title="Everything" /></DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={pick("mergeLocally")}>Merge into {step.base} locally</DropdownMenuItem>
        </>
      );
      break;
    case "pushPr":
      items = <DropdownMenuItem onClick={pick("mergeLocally")}>Merge into {step.base} locally</DropdownMenuItem>;
      break;
    case "landed":
      return null;
    default:
      // The user's own folder: the old CommitActionsMenu [D1045].
      items = (
        <>
          <DropdownMenuItem onClick={pick("commit")}>Commit</DropdownMenuItem>
          <DropdownMenuItem onClick={pick("amend")}>Commit (Amend)</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={pick("commitPush")}>Commit &amp; Push</DropdownMenuItem>
          <DropdownMenuItem onClick={pick("commitSync")}>Commit &amp; Sync</DropdownMenuItem>
        </>
      );
  }
  return (
    <DropdownMenuContent align="end" className="w-72" {...place}>
      {items}
      {force}
    </DropdownMenuContent>
  );
}
