import { useEffect } from "react";

import { allProfiles, switchProfile } from "../browser/profiles";
import { matches } from "../shortcuts";
import { blocked } from "./titlebar";
import { closeOthers, openTab, reopenTab, selectNumber, stepTab, tabsOf } from "./tab-store";

/** The old app's tab keys, for the kinds that exist so far. ⌘W comes through the File menu (main.ts), so it isn't here.
 *  On a project's page the row is `peek`'s, the session current there: they act on it and open it, as a click does,
 *  never on the project's draft behind the page [D849 D859]. */
export function useTabKeys(home: string, archived: boolean, peek?: string): void {
  useEffect(() => {
    const owner = peek ?? home;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || blocked()) return;
      const is = (id: string) => matches(event, id);
      let run: (() => void) | undefined;
      // ⌘J and ⌃` open a Terminal tab, on Home, in a chat and in a session [D428]; there is no bottom panel [D360].
      if (is("terminal")) run = () => !archived && openTab(owner, "terminal");
      else if (is("previous-tab") || is("next-tab")) run = () => stepTab(owner, is("previous-tab") ? -1 : 1);
      else if (is("close-others")) run = () => closeOthers(owner, tabsOf(owner).active);
      else if (is("reopen")) run = () => reopenTab(owner);
      else if (is("new-tab")) run = () => openTab(owner, "new");
      else if (is("show-tab")) run = () => selectNumber(owner, Number(event.code.slice(-1)));
      else if (is("switch-profile") && window.brigadier) {
        const profile = allProfiles()[Number(event.code.slice(-1)) - 1];
        // One from a page comes as a press made here (browser/keys.ts): the page had the keyboard, and keeps it.
        if (profile) run = () => void switchProfile(owner, profile.id, { keyboard: !event.isTrusted });
      }
      if (!run) return;
      event.preventDefault();
      event.stopPropagation();
      run();
      if (peek) window.location.hash = `#thread/${encodeURIComponent(peek)}`;
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [home, archived, peek]);
}
