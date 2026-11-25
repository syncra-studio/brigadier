import { view } from "../daemon";
import { pastedRef } from "../pull-requests/route";
import type { ReviewScope } from "../review/types";
import { openTab, setTabScope, tabsOf } from "../shell/tab-store";

/** What card rows, sidebar chips and thread rows open [D1013, D1022]. */

/** A file's diff in `owner`'s Review tab, or every file's with no path [D1032, D1038]; on `scope`, else the one it has. */
export function openReview(owner: string, path?: string, scope?: ReviewScope): void {
  openTab(owner, "review", path);
  const tab = scope && tabsOf(owner).tabs.find((each) => each.kind === "review");
  if (tab) setTabScope(owner, tab.id, scope);
}

type PrAt = { number: number; repo?: string | null; url?: string };

/**
 * What `owner`'s Pull requests tab names a PR by [D1017, D1113]: its number, `owner/name#n` for another repository's
 * [D213]. The full `host/owner/name#n` is read with no checkout, off the session's PR watch, so only in a folder
 * chat, which has none to read through [D494]; null there for a PR with no url to name it by.
 */
export function prTarget(owner: string, pr: PrAt): string | null {
  const project = view.rows?.find((row) => row.id === owner)?.project;
  if (view.projects?.find((each) => each.id === project)?.kind === "folder") return pr.url ? pastedRef(pr.url) : null;
  return pr.repo ? `${pr.repo}#${pr.number}` : String(pr.number);
}

/** `owner`'s Pull requests tab on a PR. */
export function openPr(owner: string, pr: PrAt): void {
  const target = prTarget(owner, pr);
  if (target) openTab(owner, "pr", target);
}

/** `owner`'s Background history: everything that ran in its background [D200]. */
export const openBackgroundHistory = (owner: string) => openTab(owner, "background");
