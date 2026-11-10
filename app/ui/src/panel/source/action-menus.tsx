import { DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, MenuRow } from "../../components/menu";
import { Check, PullRequestOpen, Publish, Sparkles } from "../../icons";
import type { MergeStyle, Step } from "../types";

/** What a pick in the action button's menu asks for; until it's wired, each is a no-op. */
export type ActionPick =
  | "commit" | "amend" | "commitPush" | "commitSync" | "commitMerge" | "commitPr"
  | "createPr" | "pushBranch" | "catchUp" | "catchUpMerge" | "catchUpRebase" | "catchUpAgent"
  | "resolveAgent" | "abortCatchUp" | "mergeLocally" | "forcePush";

/** Each step's menu: every other way on from here [D1008, D1015, D1028]. Landed has none. */
export function hasActionMenu(step: Step): boolean {
  return step.kind !== "landed";
}

/**
 * The arrow menu beside the action button: Commit's combos, Merge's style and the PR way, Catch up's ways, or a
 * folder's old CommitActionsMenu. Resolve with agent leaves a chip above the composer and sends nothing [D1044].
 * `rejected`: a push was just turned away, so Force Push is offered [D1034].
 */
export function ActionMenu({ step, mergeStyle = "merge", rejected = false, onMergeStyle, onPick, held }: {
  step: Step;
  mergeStyle?: MergeStyle;
  rejected?: boolean;
  onMergeStyle?: (style: MergeStyle) => void;
  onPick?: (pick: ActionPick) => void;
  held?: HTMLElement;
}) {
  const pick = (what: ActionPick) => () => onPick?.(what);
  const place = held && { container: held, collisionAvoidance: { side: "none", align: "none" } as const };
  const force = rejected && (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={pick("forcePush")}>Force Push (with lease)…</DropdownMenuItem>
    </>
  );
  const styles = (pr: boolean) => (
    <DropdownMenuRadioGroup value={mergeStyle} onValueChange={(value: MergeStyle) => onMergeStyle?.(value)}>
      <DropdownMenuRadioItem value="merge" indicator={<Check />}>Merge commit</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="squash" indicator={<Check />}>{pr ? "Squash" : "Squash into one commit"}</DropdownMenuRadioItem>
      {pr && <DropdownMenuRadioItem value="rebase" indicator={<Check />}>Rebase</DropdownMenuRadioItem>}
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
          <DropdownMenuLabel variant="heading">Merge as</DropdownMenuLabel>
          {styles(false)}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={pick("createPr")}><MenuRow icon={<PullRequestOpen />} title="Create PR…" /></DropdownMenuItem>
          <DropdownMenuItem onClick={pick("pushBranch")}><MenuRow icon={<Publish />} title="Push branch" /></DropdownMenuItem>
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
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={pick("createPr")}><MenuRow icon={<PullRequestOpen />} title="Create PR anyway…" /></DropdownMenuItem>
        </>
      );
      break;
    case "continue":
      items = (
        <>
          <DropdownMenuItem onClick={pick("resolveAgent")}><MenuRow icon={<Sparkles />} title="Resolve with agent" /></DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={pick("abortCatchUp")}>Abort catching up</DropdownMenuItem>
        </>
      );
      break;
    case "mergePr":
      items = (
        <>
          <DropdownMenuLabel variant="heading">Merge #{step.pr} as</DropdownMenuLabel>
          {styles(true)}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={pick("mergeLocally")}>Merge into {step.base} locally</DropdownMenuItem>
        </>
      );
      break;
    case "pushPr":
    case "fixPr":
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
    <DropdownMenuContent align="end" className="w-64" {...place}>
      {items}
      {force}
    </DropdownMenuContent>
  );
}
