import { DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "../../components/menu";
import type { SourceState } from "../types";

/** What More Actions asks the panel to do; until it's wired, each is a no-op. */
export type MoreActions = Partial<
  Record<
    | "pull" | "push" | "fetch" | "checkout" | "commit" | "amend" | "abortMerge" | "abortRebase" | "stageAll" | "unstageAll" | "discardAll"
    | "merge" | "rebase" | "createBranch" | "createFrom" | "renameBranch" | "deleteBranch" | "publish" | "stash" | "stashUntracked"
    | "applyStash" | "popStash" | "dropStash" | "askStageAll" | "gitOutput",
    () => void
  >
>;

export type Submenu = "Commit" | "Changes" | "Branch" | "Stash";

/**
 * The Source panel's More Actions menu: the old one with its second Pull, Push and Fetch removed [D1037]. A session
 * works on its own branch: it checks out, makes and renames none [D1021]; the user's own folder does.
 */
export function MoreMenu({ state, actions = {}, stageAll = "ask", held, openSub }: {
  state: SourceState | null;
  actions?: MoreActions;
  /** What Commit does with nothing staged, as last answered; only a remembered answer has a way back here. */
  stageAll?: "ask" | "always" | "never";
  held?: HTMLElement;
  /** The gallery's submenu, held open. */
  openSub?: Submenu;
}) {
  const folder = state?.checkout === "folder";
  const resolving = state?.merging != null || state?.rebasing != null;
  const hasChanges = (state?.changes.length ?? 0) > 0;
  const hasStaged = (state?.staged.length ?? 0) > 0;
  const sub = (name: Submenu) => (held ? { open: openSub === name } : {});
  const place = held && { container: held, collisionAvoidance: { side: "none", align: "none" } as const };
  return (
    <DropdownMenuContent align="end" {...place}>
      <DropdownMenuItem onClick={actions.pull}>Pull</DropdownMenuItem>
      <DropdownMenuItem onClick={actions.push}>Push</DropdownMenuItem>
      {folder && <DropdownMenuItem onClick={actions.checkout}>Checkout to…</DropdownMenuItem>}
      <DropdownMenuItem onClick={actions.fetch}>Fetch</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuSub {...sub("Commit")}>
        <DropdownMenuSubTrigger>Commit</DropdownMenuSubTrigger>
        <DropdownMenuSubContent {...place}>
          <DropdownMenuItem onClick={actions.commit}>Commit</DropdownMenuItem>
          <DropdownMenuItem disabled={resolving} onClick={actions.amend}>
            Commit (Amend)
          </DropdownMenuItem>
          {state?.merging && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={actions.abortMerge}>Abort Merge</DropdownMenuItem>
            </>
          )}
          {state?.rebasing && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={actions.abortRebase}>Abort Rebase</DropdownMenuItem>
            </>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub {...sub("Changes")}>
        <DropdownMenuSubTrigger>Changes</DropdownMenuSubTrigger>
        <DropdownMenuSubContent {...place}>
          <DropdownMenuItem disabled={!hasChanges} onClick={actions.stageAll}>
            Stage All Changes
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasStaged} onClick={actions.unstageAll}>
            Unstage All Changes
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasChanges} onClick={actions.discardAll}>
            Discard All Changes
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub {...sub("Branch")}>
        <DropdownMenuSubTrigger>Branch</DropdownMenuSubTrigger>
        <DropdownMenuSubContent {...place}>
          <DropdownMenuItem disabled={resolving} onClick={actions.merge}>
            Merge…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={resolving || !state?.branch} onClick={actions.rebase}>
            Rebase Branch…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {folder && (
            <>
              <DropdownMenuItem onClick={actions.createBranch}>Create Branch…</DropdownMenuItem>
              <DropdownMenuItem onClick={actions.createFrom}>Create Branch From…</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!state?.branch} onClick={actions.renameBranch}>
                Rename Branch…
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem onClick={actions.deleteBranch}>Delete Branch…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!state?.branch || !!state.upstream} onClick={actions.publish}>
            Publish Branch
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub {...sub("Stash")}>
        <DropdownMenuSubTrigger>Stash</DropdownMenuSubTrigger>
        <DropdownMenuSubContent {...place}>
          <DropdownMenuItem disabled={resolving} onClick={actions.stash}>
            Stash
          </DropdownMenuItem>
          <DropdownMenuItem disabled={resolving} onClick={actions.stashUntracked}>
            Stash (Include Untracked)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={resolving} onClick={actions.applyStash}>
            Apply Latest Stash
          </DropdownMenuItem>
          <DropdownMenuItem disabled={resolving} onClick={actions.popStash}>
            Pop Latest Stash
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={actions.dropStash}>Drop Stash…</DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      {/* The way back from "Always" or "Never" in Commit's question; only then is there one. */}
      {stageAll !== "ask" && <DropdownMenuItem onClick={actions.askStageAll}>Ask Before Staging All on Commit</DropdownMenuItem>}
      <DropdownMenuItem onClick={actions.gitOutput}>Show Git Output</DropdownMenuItem>
    </DropdownMenuContent>
  );
}
