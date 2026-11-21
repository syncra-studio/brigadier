import { useEffect, useRef, useState } from "react";

import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/menu";
import { NavHeader, NavList, NavSection } from "../components/nav";
import { Skeleton } from "../components/skeleton";
import { ask, useDaemon } from "../daemon";
import { Check, MagnifyingGlassSearch, XCircleFilled } from "../icons";
import { SettingsSlider } from "../icons/sidebar";
import { useStored } from "../sidebar/sidebar";
import { PrNavRow } from "./nav-row";
import { openPrPage, pastedRef, pinned, type PrRow, recents } from "./route";

/*
 * The Pull Requests page's sidebar [D159 D160 D194]: its title and display options, "Search or paste a
 * PR link", then Pinned, the sections GitHub's searches fill (Recently merged off by default) and Recents. Each section folds;
 * an empty one says "No pull requests".
 */

const SECTIONS = [
  { id: "authored", title: "Authored by me", query: "is:open author:@me" },
  { id: "review", title: "Needs my review", query: "is:open user-review-requested:@me" },
  { id: "team", title: "Needs my team's review", query: "is:open review-requested:@me -user-review-requested:@me" },
  { id: "merged", title: "Recently merged", query: "is:merged involves:@me" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];
export type View = "compact" | "detailed";

type Found = { query: string; okAt: number | null; error: string | null; prs: PrRow[] } | null;
/** One read of every shown section: GitHub's rows by query, or why it failed. */
type Read = { found: Record<string, Found>; error?: string };

// A read younger than this isn't asked again when the window comes back.
const FRESH_MS = 60_000;

/** The sections' rows: the kept read at once, then GitHub's; again on focus once stale, and on `again`. */
export function useSections(queries: string[]): { read: Read | null; again: () => void } {
  const { daemon } = useDaemon();
  const [read, setRead] = useState<Read | null>(null);
  const at = useRef(0);
  const key = queries.join("\n");
  const land = (reply: Record<string, any>, keptOnly: boolean) =>
    setRead((now) => {
      if (!reply.ok) return keptOnly ? now : { found: now?.found ?? {}, error: String(reply.error) };
      const found = { ...(now?.found ?? {}) };
      (reply.found as Found[]).forEach((each, i) => (each || !keptOnly) && (found[queries[i]!] = each));
      return { found };
    });
  const again = () => {
    if (!queries.length) return;
    at.current = Date.now();
    ask({ op: "run", args: ["host", "@", "search", ...queries] }, (reply) => reply.error !== "disconnected" && land(reply, false));
  };
  useEffect(() => {
    if (!daemon || !queries.length) return;
    ask({ op: "run", args: ["host", "@", "search", ...queries, "--kept"] }, (reply) => land(reply, true));
    again();
    const focus = () => Date.now() - at.current > FRESH_MS && again();
    addEventListener("focus", focus);
    return () => removeEventListener("focus", focus);
  }, [daemon, key]);
  return { read, again };
}

export function PullRequestsNav({ current }: { current: string }) {
  const [view, setView] = useStored<View>("pullRequests.view", "detailed");
  const [shown, setShown] = useStored<SectionId[]>("pullRequests.sections", ["authored", "review", "team"]);
  const [folded, setFolded] = useStored<string[]>("pullRequests.folded", []);
  const sections = SECTIONS.filter((each) => shown.includes(each.id));
  const { read, again } = useSections(sections.map((each) => each.query));
  const pins = pinned.use();
  const recent = recents.use();
  const [query, setQuery] = useState("");
  const found = useSearch(query);
  const fold = (id: string) => (open: boolean) => setFolded(open ? folded.filter((each) => each !== id) : [...folded, id]);
  const list = (rows: PrRow[] | undefined, error?: string | null) =>
    rows === undefined ? (
      <div aria-label="Loading pull requests" className="flex flex-col gap-2 px-2 py-1">
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    ) : rows.length === 0 ? (
      <p className={cx("px-2 py-1 text-sm", error ? "text-destructive" : "text-faint-foreground")}>{error ?? "No pull requests"}</p>
    ) : (
      <NavList>
        {rows.map((row) => (
          <PrNavRow key={row.ref} row={row} view={view} current={row.ref === current} onChanged={again} />
        ))}
      </NavList>
    );
  const section = (id: string, title: string, rows: PrRow[] | undefined, error?: string | null) => (
    <NavSection key={id} title={title} open={!folded.includes(id)} onOpenChange={fold(id)}>
      {list(rows, error)}
    </NavSection>
  );
  return (
    <>
      <div className="shrink-0">
        <NavHeader
          title="Pull Requests"
          actions={
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger render={<TooltipIconButton look="head" tooltip="Display options"><SettingsSlider /></TooltipIconButton>} />
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel variant="heading">View</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={view} onValueChange={(next: View) => setView(next)}>
                  <DropdownMenuRadioItem value="compact" indicator={<Check className="size-icon-md" />}>Compact</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="detailed" indicator={<Check className="size-icon-md" />}>Detailed</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuLabel variant="heading">Sections</DropdownMenuLabel>
                {SECTIONS.map((each) => (
                  <DropdownMenuCheckboxItem
                    key={each.id}
                    closeOnClick={false}
                    checked={shown.includes(each.id)}
                    onCheckedChange={(on) => setShown(SECTIONS.map((s) => s.id).filter((id) => (id === each.id ? on : shown.includes(id))))}
                  >
                    {each.title}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
      </div>
      <div className="px-2 pb-2">
        <label className="flex h-nav-search min-w-0 items-center gap-2 rounded-capsule border border-fill-active bg-fill px-3 has-focus-visible:focus-ring">
          <MagnifyingGlassSearch aria-hidden className="size-icon-md shrink-0 text-quiet-foreground" />
          <input
            aria-label="Search or paste a PR link"
            placeholder="Search or paste a PR link"
            value={query}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 cursor-text bg-transparent text-sm outline-none placeholder:text-faint-foreground"
            onChange={(event) => {
              // A pasted link opens its PR at once [D160].
              const ref = pastedRef(event.target.value);
              if (ref) {
                setQuery("");
                openPrPage(ref);
              } else setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !query) return;
              event.stopPropagation();
              setQuery("");
            }}
          />
          {query && (
            <button type="button" aria-label="Clear search" className="flex shrink-0 cursor-pointer items-center rounded-capsule text-faint-foreground hover:text-foreground focus-visible:focus-ring" onClick={() => setQuery("")}>
              <XCircleFilled className="size-icon-sm" />
            </button>
          )}
        </label>
      </div>
      <div className="scroll-edge-fade edge-fade-sidebar scroll-gutter flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto ps-2 pt-1 pb-2">
        {query.trim() ? (
          found.error ? (
            <p className="px-2 py-1 text-sm text-destructive">Search failed. Try again</p>
          ) : found.rows?.length === 0 ? (
            <p className="px-2 py-1 text-sm text-faint-foreground">No pull requests found</p>
          ) : (
            list(found.rows)
          )
        ) : (
          <>
            {pins.length > 0 && section("pinned", "Pinned", pins)}
            {sections.map((each) => {
              const got = read?.found[each.query];
              return section(each.id, each.title, got?.prs ?? (read?.error ? [] : undefined), got?.error ?? (got ? null : read?.error));
            })}
            {recent.length > 0 && section("recents", "Recents", recent)}
          </>
        )}
      </div>
    </>
  );
}

/** What the search box found: `involves:@me` and the words, 400ms after the last key. */
function useSearch(query: string): { rows?: PrRow[]; error?: string } {
  const [found, setFound] = useState<{ query: string; rows?: PrRow[]; error?: string }>({ query: "" });
  useEffect(() => {
    const words = query.trim();
    if (!words) return;
    const wait = setTimeout(
      () =>
        ask({ op: "run", args: ["host", "@", "search", `involves:@me ${words}`] }, (reply) => {
          const one = reply.ok ? (reply.found as Found[])[0] : null;
          setFound({ query: words, ...(reply.ok && one && !one.error ? { rows: one.prs } : { error: String(reply.error ?? one?.error ?? "failed") }) });
        }),
      400,
    );
    return () => clearTimeout(wait);
  }, [query]);
  return found.query === query.trim() ? found : {};
}
