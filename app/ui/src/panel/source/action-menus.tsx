import { DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, MenuRow } from "../../components/menu";
import { Check, PullRequestOpen, Publish, Sparkles } from "../../icons";
import type { MergeStyle, Step } from "../types";
import type { PrWay } from "./create-pr";
import { plural } from "../words";

/** What a pick in the action button's menu asks for. */
export type ActionPick =
  | "commit" | "amend" | "commitPush" | "commitSync" | "commitMerge" | "commitPr"
  | "createPr" | "pushBranch" | "openPrPage" | "catchUp" | "catchUpMerge" | "catchUpRebase" | "catchUpAgent"
  | "continue" | "abortCatchUp" | "mergeLocally" | "forcePush" | "fixChecks" | "fixComments" | "fixConflicts" | "fixAll"
  | "editMessage" | "pullOnly" | "pushOnly";

/** Each step's menu: every other way on from here [D1008, D1015, D1028]. Landed and a bare Publish have none but Commit only. */
export function hasActionMenu(step: Step, uncommitted = 0): boolean {
  return uncommitted > 0 || (step.kind !== "landed" && step.kind !== "publish" && step.kind !== "folderCommit");
}

/**
 * The arrow menu beside the action button: Commit's combos, Merge's style and the PR way, Catch up's ways, or a
 * folder's old CommitActionsMenu. Resolve with agent leaves a chip above the composer and sends nothing [D1044].
 * `rejected`: a push was just turned away, so Force Push is offered [D1034]. `prWay`: Create PR through the host's
 * CLI, else its PR page, else Push branch alone [D1030].
 */
export function ActionMenu({ step, mergeStyle = "merge", rejected = false, prWay = "cli", can, onMergeStyle, onPick, held, uncommitted = 0 }: {
  step: Step;
  /** The button commits these first; Commit only and Edit message… end the menu [D1191, D1203]. */
  uncommitted?: number;
  /** Whether a pick works here; every one does without it (the gallery). */
  can?: (pick: ActionPick) => boolean;
  prWay?: PrWay;
  mergeStyle?: MergeStyle;
  rejected?: boolean;
  onMergeStyle?: (style: MergeStyle) => void;
  onPick?: (pick: ActionPick) => void;
  held?: HTMLElement;
}) {
  // A pick that isn't wired yet is off, never clickable and inert [D1143].
  const item = (what: ActionPick, off = false) => ({ onClick: () => onPick?.(what), disabled: off || (can ? !can(what) : false) });
  const createPr = (title: string) =>
    prWay === "page" ? (
      <DropdownMenuItem {...item("openPrPage")}><MenuRow icon={<PullRequestOpen />} title="Open PR page ↗" /></DropdownMenuItem>
    ) : (
      prWay !== "none" && <DropdownMenuItem {...item("createPr", prWay === "loading")}><MenuRow icon={<PullRequestOpen />} title={title} /></DropdownMenuItem>
    );
  const place = held && { container: held, collisionAvoidance: { side: "none", align: "none" } as const };
  const force = rejected && (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem {...item("forcePush")}>Force Push (with lease)…</DropdownMenuItem>
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
    case "merge":
      items = (
        <>
          <DropdownMenuLabel>Merge as</DropdownMenuLabel>
          {styles(false)}
          <DropdownMenuSeparator />
          {prWay !== "page" && createPr("Create PR…")}
          <DropdownMenuItem {...item("pushBranch")}><MenuRow icon={<Publish />} title="Push branch" /></DropdownMenuItem>
          {prWay === "page" && createPr("Create PR…")}
          <DropdownMenuSeparator />
          <DropdownMenuItem {...item("catchUp")}>Catch up with {step.base}</DropdownMenuItem>
        </>
      );
      break;
    case "catchUp":
      items = (
        <>
          <DropdownMenuItem {...item("catchUpMerge")}>Catch up by merging {step.base}</DropdownMenuItem>
          <DropdownMenuItem {...item("catchUpRebase")}>Catch up by rebasing onto {step.base}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem {...item("catchUpAgent")}><MenuRow icon={<Sparkles />} title="Catch up, then resolve with agent" /></DropdownMenuItem>
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
          <DropdownMenuItem {...item("abortCatchUp")}>Abort catching up</DropdownMenuItem>
        </>
      );
      break;
    case "mergePr":
      items = (
        <>
          <DropdownMenuLabel>Merge #{step.pr} as</DropdownMenuLabel>
          {styles(true)}
          <DropdownMenuSeparator />
          <DropdownMenuItem {...item("mergeLocally")}>Merge into {step.base} locally</DropdownMenuItem>
        </>
      );
      break;
    case "fixPr":
      // Each only leaves a chip above the composer [D1019, D1076].
      items = (
        <>
          <DropdownMenuLabel>Fix with agent</DropdownMenuLabel>
          <DropdownMenuItem {...item("fixChecks")}><MenuRow icon={<Sparkles />} title="Failing checks" /></DropdownMenuItem>
          <DropdownMenuItem {...item("fixComments")}><MenuRow icon={<Sparkles />} title="Comments" /></DropdownMenuItem>
          <DropdownMenuItem {...item("fixConflicts")}><MenuRow icon={<Sparkles />} title="Conflicts" /></DropdownMenuItem>
          <DropdownMenuItem {...item("fixAll")}><MenuRow icon={<Sparkles />} title="Everything" /></DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem {...item("mergeLocally")}>Merge into {step.base} locally</DropdownMenuItem>
        </>
      );
      break;
    case "pushPr":
      items = <DropdownMenuItem {...item("mergeLocally")}>Merge into {step.base} locally</DropdownMenuItem>;
      break;
    case "sync":
      // Your own folder: pull or push alone, for the rare manual case [D1205].
      items = (
        <>
          <DropdownMenuItem {...item("pullOnly")}>Pull only</DropdownMenuItem>
          <DropdownMenuItem {...item("pushOnly")}>Push only</DropdownMenuItem>
        </>
      );
      break;
    default:
      items = null;
  }
  return (
    <DropdownMenuContent align="end" className="w-72" {...place}>
      {items}
      {force}
      {uncommitted > 0 && (
        <>
          {(items || force) && <DropdownMenuSeparator />}
          <DropdownMenuItem {...item("commit")}>Commit only · {plural(uncommitted, "file")}</DropdownMenuItem>
          <DropdownMenuItem {...item("editMessage")}>Edit message…</DropdownMenuItem>
        </>
      )}
    </DropdownMenuContent>
  );
}
