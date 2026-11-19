import { useState } from "react";

import { useDaemon } from "../daemon";
import { Globe, Spinner } from "../icons";
import { BrigadierMark } from "../onboarding/mark";
import { useAgentHoldsAny } from "./overlay";
import { useBrowserPage } from "./pages";
import { useAgentPause } from "./pause";

/** Who works a tab [D778]: a worker by its name, the session's own agent as Brigadier; null for the user's own. */
export function useDriverName(driver: string | undefined): string | null {
  const { rows } = useDaemon();
  const row = rows?.find((each) => each.id === driver);
  return driver ? (row?.worker ? row.title || "A worker" : "Brigadier") : null;
}

/**
 * The tab bar's group label before an agent's tabs, as Chrome's tab group that Claude in Chrome drives: the group's
 * colour, the mark and who drives (Brigadier or the worker), turning while it holds one of them; one line runs beneath its tabs.
 */
export function BrowserTabGroupLabel({ tabIds, driver }: { tabIds: readonly string[]; driver: string }) {
  const name = useDriverName(driver);
  const holds = useAgentHoldsAny(tabIds);
  return (
    <span aria-hidden data-slot="browser-tab-group" className="browser-tab-group">
      <span>
        {holds ? <Spinner className="animate-spin" /> : <BrigadierMark pixels={12} />}
        <span className="truncate">{name}</span>
      </span>
    </span>
  );
}

/** Your turn, inside the group, on the agent's tab that waits for the user. */
export function BrowserYourTurn({ tabId }: { tabId: string }) {
  if (!(tabId in useAgentPause().paused)) return null;
  return <span data-slot="browser-your-turn" className="shrink-0 text-xs font-medium whitespace-nowrap text-warning">Your turn</span>;
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
