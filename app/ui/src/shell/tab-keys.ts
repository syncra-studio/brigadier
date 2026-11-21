import { useEffect, useState } from "react";

import { allProfiles, switchProfile } from "../browser/profiles";
import { matches } from "../shortcuts";
import { newId } from "../session/store";
import { blocked } from "./titlebar";
import { closeOthers, HOME, openTab, reopenTab, selectNumber, stepTab, tabsOf } from "./tab-store";

/** The old app's tab keys, for the kinds that exist so far. ⌘W comes through the File menu (main.ts), so it isn't here.
 *  On a project's page the row is `peek`'s, the session or draft current there: they act on it and open it, as a click
 *  does; with neither, on the page's own tabs, never the draft's [D849 D859 D875]. */
export function useTabKeys(home: string, archived: boolean, peek?: string, family: readonly string[] = []): void {
  useEffect(() => {
    const owner = peek ?? home;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || blocked()) return;
      const is = (id: string) => matches(event, id);
      let run: (() => void) | undefined;
      // ⌘J and ⌃` open a Terminal tab, on Home, in a chat and in a session [D428]; there is no bottom panel [D360].
      if (is("terminal")) run = () => !archived && openTab(owner, "terminal");
      else if (is("previous-tab") || is("next-tab")) run = () => stepTab(owner, is("previous-tab") ? -1 : 1, family);
      else if (is("close-others")) run = () => closeOthers(owner, tabsOf(owner).active);
      else if (is("reopen")) run = () => reopenTab(owner);
      else if (is("new-tab")) run = () => openTab(owner, "new");
      else if (is("new-note")) run = () => !archived && openTab(owner, "note", newId());
      else if (is("show-tab")) run = () => selectNumber(owner, Number(event.code.slice(-1)), family);
      else if (is("switch-profile") && window.brigadier) {
        const profile = allProfiles()[Number(event.code.slice(-1)) - 1];
        // One from a page comes as a press made here (browser/keys.ts): the page had the keyboard, and keeps it.
        if (profile) run = () => void switchProfile(owner, profile.id, { keyboard: !event.isTrusted });
      }
      if (!run) return;
      event.preventDefault();
      event.stopPropagation();
      const at = window.location.hash;
      run();
      // The draft's page is Home's, already in the page's project [D875]; a Brigade's tab already went to its session [D3108].
      if (peek && window.location.hash === at) window.location.hash = peek.startsWith(HOME) ? "" : `#thread/${encodeURIComponent(peek)}`;
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [home, archived, peek, family]);
}

// shortcut: the wait before the badges show is our own pick; it keeps ⌘T and the like from flashing them.
const HOLD_MS = 250;
/** ⌘ held alone for a moment, for the tabs' ⌘1…⌘9 badges [D48]; any other key, letting go or leaving the window ends it. */
export function useCommandHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    let timer = 0;
    const end = () => {
      clearTimeout(timer);
      setHeld(false);
    };
    const onDown = (event: KeyboardEvent) => {
      end();
      if (event.key === "Meta" && !event.altKey && !event.ctrlKey && !event.shiftKey) timer = window.setTimeout(() => setHeld(true), HOLD_MS);
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", end, true);
    window.addEventListener("blur", end);
    return () => {
      end();
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", end, true);
      window.removeEventListener("blur", end);
    };
  }, []);
  return held;
}
