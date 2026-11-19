import type { Chip } from "../components/composer/draft";
import { showToast } from "../components/toast";
import { HOME_DRAFT } from "../session/draft";
import { putBack } from "../session/side";
import { driveTab, selectTab, tabsOf, ungroupTabs, userTab } from "../shell/tab-store";
import { browserPage } from "./pages";
import { handBack, isPaused } from "./pause";
import { takenBack } from "./agent";

/**
 * Tabs passing between the user and the session's agent [D775 D777]. The user gives a tab of theirs to the session's
 * own agent (Brigadier), from the tab's menu, its chip in the composer or by dragging it there; the agent may then act
 * in it as in its own, with the user's sign-ins, by the session's ask level, never in a password field (D518). Take
 * back makes it the user's again at once.
 */

const tabOf = (owner: string, id: string) => tabsOf(owner).tabs.find((tab) => tab.id === id && tab.kind === "browser");

/**
 * Gives tab `id` of session `owner` to that session's agent: only a web page that is the user's or already the
 * agent's; a worker's stays the worker's. False when it can't be given.
 */
export function giveTab(owner: string, id: string): boolean {
  const tab = tabOf(owner, id);
  const url = browserPage(id)?.url || tab?.target || "";
  // Home has no agent yet to give it to.
  if (owner === HOME_DRAFT || !tab || !/^https?:/i.test(url) || (tab.driver && tab.driver !== owner)) return false;
  if (tab.driver !== owner) driveTab(owner, id, url, owner);
  return true;
}

/** "Give to Brigadier": the tab is given, and its chip goes into the composer for the user to say what to do there. */
export function giveTabToChat(owner: string, id: string): void {
  if (!giveTab(owner, id)) return void showToast("Only a web page can be given.", { tone: "error" });
  const url = browserPage(id)?.url || tabOf(owner, id)?.target || "";
  putBack(owner, "", true, { parts: [tabChip(id, url), " "], attachmentIds: [] });
  selectTab(owner, "chat");
}

/** A tab's chip in the composer: its address, as the `@` menu names it (mention.rs). */
export function tabChip(id: string, url: string): Chip {
  const shown = url.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "").slice(0, 80);
  return { kind: "mention", id, type: "tab", label: shown };
}

/** Each tab a sent message's chips name goes to the session's agent, as the menu's Give does. */
export function giveChipTabs(owner: string, parts: readonly (string | Chip)[]): void {
  for (const part of parts) if (typeof part !== "string" && part.kind === "mention" && part.type === "tab") giveTab(owner, part.id);
}

/** Take back: the tab is the user's now, whoever drove it; what the agent had under way there ends. */
export function takeBackTab(owner: string, id: string): void {
  const tab = tabOf(owner, id);
  if (!tab?.driver) return;
  userTab(owner, id);
  takenBack(id);
  if (isPaused(id)) handBack(id);
}

/** Ungroup, from the group label's menu: all of `driver`'s tabs are the user's now, as Take back on each [D901]. */
export function ungroup(owner: string, driver: string): void {
  const held = tabsOf(owner).tabs.filter((tab) => tab.driver === driver);
  ungroupTabs(owner, driver);
  for (const tab of held) {
    takenBack(tab.id);
    if (isPaused(tab.id)) handBack(tab.id);
  }
}
