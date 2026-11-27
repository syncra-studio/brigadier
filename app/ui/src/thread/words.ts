// The one clock for every live time on screen; the words rows say are app/shared/words.ts [D58].
import { useSyncExternalStore } from "react";

export { connectorName, duration, groupWords, hhmm, ORDER, workWords } from "../../../shared/words";

let second = Date.now();
const ticking = new Set<() => void>();
let timer = 0;
function subscribe(listener: () => void) {
  ticking.add(listener);
  if (ticking.size === 1) {
    second = Date.now();
    timer = window.setInterval(() => {
      second = Date.now();
      for (const each of ticking) each();
    }, 1000);
  }
  return () => {
    ticking.delete(listener);
    if (ticking.size === 0) window.clearInterval(timer);
  };
}
const still = () => () => {};
const read = () => second;

/** The time, to the second; it ticks only while `live`, on one timer shared by every live time. */
export function useSecond(live: boolean): number {
  return useSyncExternalStore(live ? subscribe : still, read);
}
