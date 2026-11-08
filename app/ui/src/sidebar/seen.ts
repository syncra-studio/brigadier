import { useEffect } from "react";

import { ask } from "../daemon";
import type { SessionRow } from "./words";

/**
 * The open session is read up to the end its row shows, now and each time a later end comes in while
 * it stays open (as the old app did) [D173]. Its row draws no dot meanwhile; if the daemon never
 * records it, the dot is back once you move on.
 */
export function useSeen(open: SessionRow | undefined): void {
  const id = open?.id;
  const finished = open?.finished ?? 0;
  useEffect(() => {
    if (id && finished > 0) ask({ op: "run", args: ["seen", id, String(finished)] });
  }, [id, finished]);
}
