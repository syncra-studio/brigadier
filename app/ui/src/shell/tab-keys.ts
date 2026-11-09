import { useEffect } from "react";

import { blocked } from "./titlebar";
import { closeOthers, openTab, reopenTab, selectNumber, stepTab, tabsOf } from "./tab-store";

/** The old app's tab keys, for the kinds that exist so far. ⌘W comes through the File menu (main.ts), so it isn't here. */
export function useTabKeys(owner: string, archived: boolean): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || blocked()) return;
      const mac = /Mac/.test(navigator.platform);
      const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      const { code, altKey: alt, shiftKey: shift } = event;
      const digit = /^Digit([1-9])$/.exec(code);
      let run: (() => void) | undefined;
      if (event.ctrlKey && !event.metaKey && !alt && !shift && code === "Backquote") run = () => !archived && openTab(owner, "terminal");
      else if (event.ctrlKey && !event.metaKey && !alt && code === "Tab") run = () => stepTab(owner, shift ? -1 : 1);
      else if (command && alt && !shift && code === "KeyW") run = () => closeOthers(owner, tabsOf(owner).active);
      else if (command && alt && !shift && (code === "ArrowLeft" || code === "ArrowRight")) run = () => stepTab(owner, code === "ArrowLeft" ? -1 : 1);
      else if (command && !alt && shift && code === "KeyT") run = () => reopenTab(owner);
      else if (command && !alt && shift && (code === "BracketLeft" || code === "BracketRight")) run = () => stepTab(owner, code === "BracketLeft" ? -1 : 1);
      else if (command && !alt && !shift && code === "KeyT") run = () => openTab(owner, "new");
      // Proposed: with no bottom panel [D360], ⌘J opens a Terminal tab.
      else if (command && !alt && !shift && code === "KeyJ") run = () => !archived && openTab(owner, "terminal");
      else if (command && !alt && !shift && digit) run = () => selectNumber(owner, Number(digit[1]));
      if (!run) return;
      event.preventDefault();
      event.stopPropagation();
      run();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [owner, archived]);
}
