import { useEffect, useState } from "react";

import { TooltipIconButton } from "../components/icon-button";
import { NavRow } from "../components/nav";
import { useDaemon } from "../daemon";
import { Globe, X } from "../icons";
import { run } from "../onboarding/api";
import { HOME } from "../shell/tab-store";
import { useHistory, useOriginFavicon, type Visit } from "./suggestions";

/** The New tab's browser parts (the old NewTabTools's): its session's Local servers, then Suggested sites [D508]. */

type SuggestedSite = { origin: string; url: string; title: string };

/** Four recently visited sites, one per origin, keeping the most recent page's title and URL. */
function suggestedSites(history: readonly Visit[], dismissed: readonly string[]): SuggestedSite[] {
  const seen = new Set(dismissed);
  const sites: SuggestedSite[] = [];
  for (const visit of history.toSorted((a, b) => b.atMs - a.atMs || b.id - a.id)) {
    let url: URL;
    try {
      url = new URL(visit.url);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || seen.has(url.origin)) continue;
    seen.add(url.origin);
    sites.push({ origin: url.origin, url: url.href, title: visit.title.trim() || url.host.replace(/^www\./, "") });
    if (sites.length === 4) break;
  }
  return sites;
}

/** The local servers the session's background jobs printed, while they answer (Rust's `jobs <id> servers`), read again as its jobs change. */
export function LocalServers({ owner, active, onOpen }: { owner: string; active: boolean; onOpen: (url: string) => void }) {
  const row = useDaemon().rows?.find((each) => each.id === owner);
  const jobs = (row?.background ?? []).map((job) => `${job.pid}.${job.start_us}`).join(" ");
  const [servers, setServers] = useState<string[]>([]);
  useEffect(() => {
    if (!active || owner === HOME || !jobs) return setServers([]);
    let live = true;
    run(["jobs", owner, "servers"]).then(
      (reply) => live && setServers(reply.servers as string[]),
      () => live && setServers([]),
    );
    return () => {
      live = false;
    };
  }, [owner, active, jobs]);
  if (servers.length === 0) return null;
  return (
    <section aria-label="Local servers" className="flex flex-col gap-2">
      <h2 className="font-medium">Local servers</h2>
      <ul className="flex flex-col">
        {servers.map((url) => (
          <li key={url}>
            <NavRow onClick={() => onOpen(url)} className="text-label text-foreground">
              <Globe className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{url.replace(/^https?:\/\//, "")}</span>
            </NavRow>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Recently visited sites to open again, each dismissable while the tab shows. */
export function SuggestedSites({ owner, active, onOpen }: { owner: string; active: boolean; onOpen: (url: string) => void }) {
  const history = useHistory(owner, active);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const sites = suggestedSites(history, dismissed);
  if (sites.length === 0) return null;
  return (
    <section aria-label="Suggested" className="flex flex-col gap-2">
      <h2 className="font-medium">Suggested</h2>
      <ul className="flex gap-3 overflow-x-auto">
        {sites.map((site) => (
          <li key={site.origin} className="group/site relative min-w-32 flex-1">
            <a
              href={site.url}
              aria-label={site.title}
              title={site.title}
              onClick={(event) => {
                event.preventDefault();
                onOpen(site.url);
              }}
              className="flex min-w-0 flex-col items-center gap-3 rounded-session-tab p-3 group-hover/site:bg-fill focus-visible:focus-ring"
            >
              <SiteIcon origin={site.origin} />
              <span className="w-full truncate text-center font-medium">{site.title}</span>
            </a>
            <TooltipIconButton
              tooltip={`Dismiss ${site.title}`}
              size="icon-xs"
              className="absolute end-0 top-0 rounded-capsule opacity-0 group-focus-within/site:opacity-100 group-hover/site:opacity-100 pointer-coarse:opacity-100"
              onClick={() => setDismissed((origins) => [...origins, site.origin])}
            >
              <X />
            </TooltipIconButton>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A site's favicon, from an open page of it, else a globe. */
function SiteIcon({ origin }: { origin: string }) {
  const favicon = useOriginFavicon(origin);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className="flex size-12 items-center justify-center text-muted-foreground">
      {favicon && favicon !== failed ? <img src={favicon} alt="" onError={() => setFailed(favicon)} className="size-8 object-contain" /> : <Globe aria-hidden className="size-8" />}
    </span>
  );
}
