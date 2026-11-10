import { openTab } from "../shell/tab-store";

/** What card rows, sidebar chips and thread rows open [D1013, D1022]. */

/** A file's diff in `owner`'s Review tab, or every file's with no path [D1032, D1038]. */
export const openReview = (owner: string, path?: string) => openTab(owner, "review", path);

/** `owner`'s Pull requests tab on PR `number` [D1017, D1113]. */
export const openPr = (owner: string, number: number) => openTab(owner, "pr", String(number));
