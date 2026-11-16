import { run } from "../onboarding/api";
import { takeRestored, tabsOf } from "../shell/tab-store";

/*
 * Records the pages each tab shows in its profile's history, kept by Rust (the old app's browserHistory.ts watch).
 * The same address again, a reload or a redirect to itself, is one visit that moves up.
 */

/** What a tab's page last put in the history. `cleared`: its page when that row was removed; a reload of it mustn't bring the row back. */
type Watched = { owner: string; profile: string; id: number | null; url: string; atMs: number; cleared: string | null };
const watched = new Map<string, Watched>();
const steps = new Map<string, Promise<void>>();
const webPage = (url: string) => /^https?:/i.test(url);

/** One step at a time per tab: each needs the row the one before made. */
function queue(tab: string, step: () => Promise<void>): void {
  steps.set(tab, (steps.get(tab) ?? Promise.resolve()).then(step).catch((error: unknown) => console.error("history", error)));
}

export function visited(owner: string, id: string, url: string): void {
  const tab = tabsOf(owner).tabs.find((each) => each.id === id);
  // The tab came back at a page it already had, after a restart, which is no new visit.
  const restored = takeRestored(id);
  queue(id, async () => {
    const guest = watched.get(id) ?? { owner, profile: tab?.profile ?? "", id: null, url: "", atMs: 0, cleared: null };
    watched.set(id, guest);
    const at = ["--tab", id];
    if (!webPage(url)) {
      Object.assign(guest, { id: null, url });
      return;
    }
    if (restored) {
      // It carries on the newest row of that address. With none it is a first visit: a tab Rust opened before the app
      // read its session (`brigadier show`, an agent's) looks restored too.
      const rows = (await run(["browser", owner, "history", "list", "--query", url, "--limit", "20", ...at])).history as { id: number; url: string; atMs: number }[];
      const row = rows.find((each) => each.url === url);
      if (row) return void Object.assign(guest, { id: row.id, url, atMs: row.atMs, cleared: null });
    }
    if (url === guest.cleared) return;
    guest.cleared = null;
    const last = guest.id !== null && guest.url === url ? ["--last", String(guest.id)] : [];
    const atMs = Date.now();
    const reply = await run(["browser", owner, "visit", "record", url, ...last, "--at-ms", String(atMs), ...at, ...(tab?.driver ? ["--agent"] : [])]);
    Object.assign(guest, { id: Number(reply.id), url, atMs });
  });
}

export function titled(id: string, title: string): void {
  queue(id, async () => {
    const guest = watched.get(id);
    if (guest?.id != null && title) await run(["browser", guest.owner, "visit", "title", String(guest.id), title, "--tab", id]);
  });
}

/** The tab's page went: the next one starts afresh, maybe on another profile. */
export const forgetVisits = (id: string) => queue(id, async () => void watched.delete(id));

/** Visits gone from the history (`ids`, or those since `sinceMs`): a tab showing one carries on without its row, and a reload doesn't bring it back. */
export function historyGone(profile: string, ids: number[] | null, sinceMs?: number | null): void {
  for (const guest of watched.values()) {
    if (guest.profile !== profile || guest.id === null) continue;
    if (ids ? !ids.includes(guest.id) : sinceMs != null && guest.atMs < sinceMs) continue;
    Object.assign(guest, { id: null, cleared: guest.url });
  }
}
