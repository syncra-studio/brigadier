import { useEffect } from "react";

import { HOME_DRAFT } from "../session/draft";
import { putBack } from "../session/side";
import { closeTab, HOME, openTab, tabsOf, useTabsRead } from "../shell/tab-store";
import { openPrPage, type PrRow, reviewChats } from "./route";

const ASK = "Review this pull request.";

/** The row menu's Review [D161 D174]: the PR's review chat with the ask in its composer, nothing sent. */
export function openReview(row: PrRow): void {
  putBack(reviewChats.get()[row.ref] ?? HOME_DRAFT, ASK, false);
  openPrPage(row);
}

/** The review draft's tabs show this PR's, in front, and no other PR's [D162]. */
export function useReviewTab(ref?: string): void {
  const read = useTabsRead(HOME);
  useEffect(() => {
    if (!ref || !read) return;
    for (const tab of tabsOf(HOME).tabs) if (tab.kind === "pr" && tab.target !== ref) closeTab(HOME, tab.id);
    openTab(HOME, "pr", ref);
  }, [ref, read]);
}
