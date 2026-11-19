import { useState } from "react";

import { cx } from "../components/cx";
import { useDaemon } from "../daemon";
import { Globe, Spinner } from "../icons";
import { useAgentHolds } from "./overlay";
import { useBrowserPage } from "./pages";
import { useAgentPause } from "./pause";

/** Who works a tab [D778]: a worker by its name, the session's own agent as Brigadier; null for the user's own. */
export function useDriverName(driver: string | undefined): string | null {
  const { rows } = useDaemon();
  const row = rows?.find((each) => each.id === driver);
  return driver ? (row?.worker ? row.title || "A worker" : "Brigadier") : null;
}

/**
 * The tab bar's mark of an agent's tab: who drives it while it holds the page, Your turn while it waits for the user;
 * nothing between turns. It gives way to the tab's title in a narrow tab.
 */
export function BrowserDriverChip({ tabId, driver }: { tabId: string; driver: string | undefined }) {
  const name = useDriverName(driver);
  const holds = useAgentHolds(tabId);
  const yours = tabId in useAgentPause().paused;
  if (!name || (!holds && !yours)) return null;
  return (
    // Badge's look, but it may shrink (Badge is shrink-0, and cx doesn't merge classes).
    <span data-slot="browser-driver" className={cx("inline-flex h-5 max-w-24 min-w-5 items-center gap-1 overflow-hidden rounded-capsule px-1.5 text-xs font-medium whitespace-nowrap svg:size-icon-xs svg:shrink-0", yours ? "bg-warning-wash text-warning" : "bg-muted text-foreground")}>
      {!yours && <Spinner className="animate-spin" />}
      <span className="truncate">{yours ? "Your turn" : name}</span>
    </span>
  );
}

/** The tab's icon: a spinner, a loaded favicon small inside its ring, then the whole favicon (the old app's FaviconGlyph). */
export function BrowserTabIcon({ tabId }: { tabId: string }) {
  const page = useBrowserPage(tabId);
  const favicon = page?.favicon ?? null;
  const loading = page?.loading ?? false;
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const usable = !!favicon && favicon !== failed && favicon === loaded;
  const phase = loading ? (usable ? "loading-favicon" : "spinner-only") : "settled";
  return (
    <span data-slot="browser-tab-icon" data-phase={phase} aria-hidden="true" aria-busy={loading} className="browser-tab-icon">
      <span className="browser-tab-favicon" data-visible={usable || !loading}>
        {favicon && favicon !== failed ? <img src={favicon} alt="" onLoad={() => setLoaded(favicon)} onError={() => setFailed(favicon)} /> : <Globe />}
      </span>
      {loading && <Spinner data-slot="favicon-spinner" className="browser-tab-spinner" />}
    </span>
  );
}
