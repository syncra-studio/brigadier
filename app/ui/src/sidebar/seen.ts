import { useEffect } from "react";

import { seen } from "./actions";
import type { SessionRow } from "./words";

/**
 * The open session is read up to the end its row shows: on opening it, and each time a later end comes in
 * while it stays open (as the old app did) [D173]. Its row draws no dot meanwhile. A merge seen open clears its
 * Merged chip too [D1018].
 */
export function useSeen(open: SessionRow | undefined): void {
  const id = open?.id;
  const finished = open?.finished ?? 0;
  const merged = open?.pr?.chip === "merged";
  useEffect(() => {
    if (id) seen(id, finished);
  }, [id, finished, merged]);
}
