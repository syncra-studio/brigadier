import { useEffect, useState } from "react";

import { browserHistory, type BrowserVisit, byDay, HISTORY_PAGE, type HistoryFilter, removeHistory, siteOf } from "../browser/data";
import { openLink } from "../browser/links";
import { useDefaultProfile } from "../browser/profiles";
import { Button } from "../components/button";
import { EmptyState } from "../components/empty-state";
import { ErrorLine } from "../components/error-line";
import { DropdownMenuItem } from "../components/menu";
import { Select } from "../components/select";
import { ExternalLink, Filter, Globe, Trash } from "../icons";
import { errorText } from "../onboarding/api";
import { useNow } from "../session/shown";
import { SearchField } from "./archived-toolbar";
import { ProfilePicker } from "./browser-clear";
import { dataBack, DayGroup, formatTime, RowMenu } from "./browser-parts";
import { SettingsPage, SettingsSection } from "./parts";

const HEADINGS: Record<HistoryFilter, string> = {
  all: "All-time history",
  agent: "Pages agents gave you",
  other: "Pages you opened",
};

const EMPTY: Record<HistoryFilter, string> = {
  all: "Pages you visit in Brigadier's browser show here.",
  agent: "Pages opened from an agent's reply or a preview show here.",
  other: "Pages you open yourself, and history you import, show here.",
};

const FILTERS = [
  { value: "all", label: "All" },
  { value: "agent", label: "Agent" },
  { value: "other", label: "Other" },
] as const satisfies readonly { value: HistoryFilter; label: string }[];

/** One page in Browsing history: its title and site (opens it), the time, and a menu. */
function VisitRow({ visit, onRemove }: { visit: BrowserVisit; onRemove: () => void }) {
  const site = siteOf(visit.url);
  return (
    <li className="flex min-h-11 items-center gap-3 py-1.5">
      <Globe aria-hidden className="size-icon-md shrink-0 text-quiet-foreground" />
      <button type="button" title={visit.url} onClick={() => openLink(visit.url)} className="flex min-w-0 flex-1 items-baseline gap-2 text-start text-label">
        <span className="truncate">{visit.title || site}</span>
        {visit.title && <span className="shrink-0 text-xs text-quiet-foreground">{site}</span>}
      </button>
      <span className="shrink-0 text-xs text-quiet-foreground tabular-nums">{formatTime(visit.atMs)}</span>
      <RowMenu name={visit.title || site}>
        <DropdownMenuItem onClick={() => openLink(visit.url)}>
          <ExternalLink />
          Open
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={onRemove}>
          <Trash />
          Remove from history
        </DropdownMenuItem>
      </RowMenu>
    </li>
  );
}

/**
 * Settings › Browser › Browsing history: a search and a filter (All, Agent: pages in tabs an
 * agent's link or preview opened; Other: the rest) over the pages, by day, newest first.
 */
export function BrowserHistory({
  profile: opened,
  onClear,
  cleared = 0,
}: {
  profile?: string | undefined;
  /** Opens Clear browsing data on the profile shown. */
  onClear?: (profile: string) => void;
  /** Counts the clears since the page opened: each one reads the history again. */
  cleared?: number;
}) {
  const fallback = useDefaultProfile();
  const [profile, setProfile] = useState(opened ?? fallback.id);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [visits, setVisits] = useState<BrowserVisit[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(true, 60_000);

  useEffect(() => {
    let current = true;
    const timer = setTimeout(
      () => {
        browserHistory(profile, query, filter, null)
          .then((found) => {
            if (!current) return;
            setVisits(found);
            setMore(found.length === HISTORY_PAGE);
            setError(null);
          })
          .catch((cause: unknown) => current && setError(errorText(cause)));
      },
      query ? 150 : 0,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // `cleared` reads the history again after a clear.
  }, [profile, query, filter, cleared]);

  const loadMore = () => {
    const last = visits?.at(-1);
    if (!last) return;
    browserHistory(profile, query, filter, last)
      .then((found) => {
        setVisits((shown) => [...(shown ?? []), ...found]);
        setMore(found.length === HISTORY_PAGE);
      })
      .catch((cause: unknown) => setError(errorText(cause)));
  };

  const remove = (id: number) => {
    removeHistory(profile, [id])
      .then(() => setVisits((shown) => shown?.filter((visit) => visit.id !== id) ?? null))
      .catch((cause: unknown) => setError(errorText(cause)));
  };

  const days = byDay(visits ?? [], now);
  return (
    <SettingsPage title="Browsing history" back={dataBack(opened)}>
      <ProfilePicker value={profile} onChange={setProfile} />
      <div className="flex items-center gap-2">
        <SearchField label="Search browsing history" value={query} onChange={setQuery} />
        <Select label="Filter browsing history" value={filter} options={FILTERS} onChange={setFilter} icon={<Filter aria-hidden className="size-icon-sm shrink-0" />} className="w-32" />
      </div>
      <SettingsSection
        title={HEADINGS[filter]}
        actions={
          onClear && (
            <Button variant="soft" size="sm" onClick={() => onClear(profile)}>
              Clear browsing data
            </Button>
          )
        }
      >
        <ErrorLine error={error} />
        {visits && days.length === 0 && <EmptyState title={query ? "No pages match." : EMPTY[filter]} />}
        {days.map((day) => (
          <DayGroup key={day.key} label={day.label}>
            {day.items.map((visit) => (
              <VisitRow key={visit.id} visit={visit} onRemove={() => remove(visit.id)} />
            ))}
          </DayGroup>
        ))}
        {more && (
          <Button variant="soft" size="sm" className="self-center" onClick={loadMore}>
            Show more
          </Button>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
