import { useEffect, useState } from "react";

import { ask, useDaemon } from "../daemon";

import { HOME_DRAFT } from "../session/draft";
import { putBack } from "../session/side";
import { liveReviewChat, openPrPage, type PrRow } from "./route";

export const ASK = "Review this pull request.";

/** The row menu's Review [D161 D174]: the PR's review chat with the ask in its composer, nothing sent. */
export function openReview(row: PrRow): void {
  putBack(liveReviewChat(row.ref) ?? HOME_DRAFT, ASK, false);
  openPrPage(row);
}

/** The project of the PR's repository, by its remote: undefined while asked, null when none [D198]. */
export function useReviewProject(ref?: string): string | null | undefined {
  const { daemon } = useDaemon();
  const repo = ref?.split("#")[0]!.split("/").slice(1).join("/");
  const [found, setFound] = useState<{ repo: string; id: string | null }>();
  useEffect(() => {
    if (!daemon || !repo) return;
    ask({ op: "run", args: ["host", "@", "project", repo] }, (reply) => reply.error !== "disconnected" && setFound({ repo, id: reply.ok ? ((reply.project as string | null) ?? null) : null }));
  }, [daemon, repo]);
  return found && found.repo === repo ? found.id : undefined;
}
