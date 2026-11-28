import { useSyncExternalStore } from "react";

import { uncertainState } from "../../../shared/session/uncertain";

export { flagOf, type Going, UNCONFIRMED, went } from "../../../shared/session/uncertain";

/** This Mac's messages on their way (app/shared/session/uncertain.ts), under the key they've always had. */
export const uncertain = uncertainState("brigadier.uncertain.");
export const { keepGoing, keptOf, forget, markGoing, goingOf, heldChips, fromBook, pruneUncertain, tellDrops } = uncertain;
export const useGoingOf = (session: string) => useSyncExternalStore(uncertain.subscribe, () => goingOf(session));
