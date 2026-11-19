import { useLayoutEffect, useRef, useState } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { useDaemon } from "../daemon";
import { shownAddress } from "./address";
import { Globe, Spinner } from "../icons";
import { useAgentHoldsAny } from "./overlay";
import { useBrowserPage } from "./pages";
import { useAgentPause } from "./pause";

/** Who works a tab [D778]: a worker by its name, the session's own agent as Brigadier; null for the user's own. */
export function useDriverName(driver: string | undefined): string | null {
  const { rows } = useDaemon();
  const row = rows?.find((each) => each.id === driver);
  return driver ? (row?.worker ? row.title || "A worker" : "Brigadier") : null;
}

/** A group's tab as its hover card lists it: the page's title, else its address. */
function GroupTabName({ id, target }: { id: string; target?: string }) {
  const page = useBrowserPage(id);
  return <li className="truncate">{page?.title || shownAddress(page?.url || target || "", false)}</li>;
}

/**
 * The tab bar's group label before an agent's tabs, as Chrome's tab group that Claude in Chrome drives: the group's
 * colour and who drives (Brigadier or the worker), after an hourglass while it holds one of them; its words fade out
 * at its end when cut. One line runs beneath its tabs. Clicked, the group folds to its label and opens again; hovered,
 * it names its tabs, as Chrome's [D894 D909].
 */
export function BrowserTabGroupLabel({ tabs, driver, folded, onFold }: { tabs: readonly { id: string; target?: string }[]; driver: string; folded: boolean; onFold: () => void }) {
  const name = useDriverName(driver);
  const holds = useAgentHoldsAny(tabs.map((tab) => tab.id));
  const words = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const at = words.current;
    if (at) setCut(at.scrollWidth > at.clientWidth);
  }, [name, holds]);
  const count = `${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}`;
  return (
    <Tooltip>
      <TooltipTrigger
        delay={250}
        render={<button type="button" data-slot="browser-tab-group" aria-expanded={!folded} aria-label={`${name}'s tab group, ${count}`} onClick={onFold} className="browser-tab-group app-no-drag" />}
      >
        <span>
          <span ref={words} data-cut={cut || undefined} className="min-w-0 overflow-hidden">
            {holds && "⌛ "}
            {name}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="flex-col items-start text-start">
        <span className="font-medium">
          {name} ({count})
        </span>
        <ul className="w-full list-inside list-disc text-muted-foreground">
          {tabs.map((tab) => (
            <GroupTabName key={tab.id} id={tab.id} target={tab.target} />
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

/** Your turn, inside the group, on the agent's tab that waits for the user. */
export function BrowserYourTurn({ tabId }: { tabId: string }) {
  if (!(tabId in useAgentPause().paused)) return null;
  return <span data-slot="browser-your-turn" className="shrink-0 text-xs font-medium whitespace-nowrap text-warning">Your turn</span>;
}

/**
 * The tab's icon: a spinner, a loaded favicon small inside its ring, then the whole favicon (the old app's
 * FaviconGlyph). While an agent holds the tab, its orange cursor instead, as Claude in Chrome's [D894].
 */
export function BrowserTabIcon({ tabId }: { tabId: string }) {
  const page = useBrowserPage(tabId);
  const held = useAgentHoldsAny([tabId]);
  const favicon = page?.favicon ?? null;
  const loading = page?.loading ?? false;
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const usable = !!favicon && favicon !== failed && favicon === loaded;
  const phase = loading ? (usable ? "loading-favicon" : "spinner-only") : "settled";
  if (held) {
    return (
      <span data-slot="browser-tab-icon" data-agent aria-hidden="true" className="browser-tab-icon">
        <svg viewBox="0 0 20 22">
          <path d="M2 1.5 L2 17.5 L6.4 13.6 L9.3 20 L12.2 18.7 L9.4 12.4 L15.4 12.2 Z" />
        </svg>
      </span>
    );
  }
  return (
    <span data-slot="browser-tab-icon" data-phase={phase} aria-hidden="true" aria-busy={loading} className="browser-tab-icon">
      <span className="browser-tab-favicon" data-visible={usable || !loading}>
        {favicon && favicon !== failed ? <img src={favicon} alt="" onLoad={() => setLoaded(favicon)} onError={() => setFailed(favicon)} /> : <Globe />}
      </span>
      {loading && <Spinner data-slot="favicon-spinner" className="browser-tab-spinner" />}
    </span>
  );
}
