import { openTab } from "../shell/tab-store";

/** What card rows, sidebar chips and thread rows open [D1013, D1022]. */

/** A file's diff in `owner`'s Review tab, or every file's with no path [D1032, D1038]. */
export const openReview = (owner: string, path?: string) => openTab(owner, "review", path);

type PrAt = { number: number; repo?: string | null };

/** `owner`'s Pull requests tab on a PR [D1017, D1113]: its number, `owner/name#n` for another repository's [D213]. */
export const openPr = (owner: string, pr: PrAt) => openTab(owner, "pr", pr.repo ? `${pr.repo}#${pr.number}` : String(pr.number));

/** `owner`'s Background history: everything that ran in its background [D200]. */
export const openBackgroundHistory = (owner: string) => openTab(owner, "background");
