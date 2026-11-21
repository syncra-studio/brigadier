import { liveReviewChat, pastedRef, prPageOf } from "../pull-requests/route";
import { getSettings } from "../settings/api";
import { HOME, openTab } from "../shell/tab-store";

/**
 * Where a web link opens: in a Browser tab of the session in front, or in the user's default browser, as Settings ›
 * Browser's two rows say (the old linkRouting and links). ⌘-click (Ctrl-click elsewhere) opens it in the other place
 * [D507]. Every link of the app comes here: answers, cards, notes and a terminal's links.
 */

const MAC = window.brigadier?.platform === "darwin";

/** Hosts a local development server answers on: loopback addresses and `*.localhost`. */
export function localUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

/** The click asked for the other place: ⌘ on a Mac, Ctrl elsewhere. */
export const swapped = (event: { metaKey: boolean; ctrlKey: boolean }): boolean => (MAC ? event.metaKey : event.ctrlKey);

/** What's in front to hold a Browser tab: the open session, or Home, whose tabs (Pull requests…) are its own [D656]. */
function sessionInFront(): string | null {
  const { hash } = window.location;
  if (hash.startsWith("#thread/")) return decodeURIComponent(hash.slice("#thread/".length));
  // A PR open on the Pull Requests page shows its review chat once there is one, else the review draft (Home's), as it
  // does for an archived one [D162].
  const pr = prPageOf(hash);
  if (pr) return liveReviewChat(pr) ?? HOME;
  return hash.startsWith("#settings") ? null : HOME;
}

/**
 * Opens web link `url` where Settings › Browser says, or in the other place with `swap`. A tab needs that row's
 * Brigadier's browser and a session or Home in front to hold it (`session`: the one it belongs to); anything else goes to the
 * default browser.
 */
export function openLink(url: string, { swap = false, session }: { swap?: boolean; session?: string } = {}): void {
  if (!/^https?:\/\//i.test(url)) return;
  const settings = getSettings();
  const chosen = localUrl(url) ? (settings?.local_links_in ?? "brigadier") : (settings?.web_links_in ?? "system");
  const target = swap ? (chosen === "brigadier" ? "system" : "brigadier") : chosen;
  const owner = session ?? sessionInFront();
  if (target === "brigadier" && owner) openTab(owner, "browser", url);
  else window.brigadier?.openLink(url);
}

/** A click on a web link anywhere in the app goes through `openLink`, unless what drew the link handled it. */
export function installLinks(): void {
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    // A link being edited (a note's) is the editor's: a click puts the caret there.
    if (event.defaultPrevented || event.button !== 0 || !link || link.isContentEditable || !/^https?:\/\//i.test(link.href)) return;
    event.preventDefault();
    // A PR's link opens its tab in the session in front; ⌘-click its page [D162].
    const pr = !swapped(event) && pastedRef(link.href);
    const owner = sessionInFront();
    if (pr && owner) return void openTab(owner, "pr", pr);
    openLink(link.href, { swap: swapped(event) });
  });
}
