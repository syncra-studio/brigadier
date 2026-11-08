import { useEffect, useRef } from "react";

import { isHeld, release, seen } from "./actions";
import type { SessionRow } from "./words";

/**
 * The open session is read up to the end its row shows: on opening it, which also undoes Mark as unread,
 * and each time a later end comes in while it stays open (as the old app did) [D173, D185]. Marked
 * unread while open, it stays unread until you leave. Its row draws no dot meanwhile.
 */
export function useSeen(open: SessionRow | undefined): void {
  const id = open?.id;
  const finished = open?.finished ?? 0;
  const visit = useRef<string | undefined>(undefined);
  useEffect(() => {
    const fresh = visit.current !== id;
    if (fresh && visit.current) release(visit.current);
    visit.current = id;
    if (id && (fresh || !isHeld(id))) seen(id, finished);
  }, [id, finished]);
}
