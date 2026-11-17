import { useEffect, useState } from "react";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "../components/menu";
import { Segment, SegmentedRoot } from "../components/segmented";
import { SelectTrigger } from "../components/select";
import { Skeleton } from "../components/skeleton";
import { ask, type Row as SessionRow, useDaemon } from "../daemon";
import { ArrowRotateCw, Chat, Check } from "../icons";
import { openPr } from "../panel/open";
import type { Pr } from "../panel/types";
import { Counts } from "../review/hunks";
import { SearchField } from "../settings/archived-toolbar";
import { useSecond } from "../thread/words";
import { useHost } from "./host";
import { Avatar, StateIcon } from "./pr-parts";
import { ago, FRESH_MS } from "./pr-words";

/** The chips, each GitHub's search words [D609, D613]. */
const VIEWS = [
  { value: "all", label: "All", words: "" },
  { value: "authored", label: "Created by me", words: "author:@me" },
  { value: "review", label: "Review requested", words: "review-requested:@me" },
  { value: "assigned", label: "Assigned to me", words: "assignee:@me" },
] as const;
export type View = (typeof VIEWS)[number]["value"];
const LINKED = "Linked to session";
const STATES = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed / merged" },
] as const;

/** A found row: the list's, with its size [D613]. */
export type FoundPr = Pr & { additions?: number | null; deletions?: number | null };
/** What a found read is: `host <id> search`'s, kept per query, `next` its next page's cursor [D258, D613]. */
type Found = { query: string; okAt: number | null; error: string | null; prs: FoundPr[]; next?: string | null };

const CHIP = "h-6 shrink-0 cursor-pointer rounded-capsule px-2.5 text-label whitespace-nowrap text-faint-foreground hover:text-foreground focus-visible:focus-ring data-pressed:bg-fill-hover data-pressed:text-foreground";
const TRACK = "hidden shrink-0 items-center gap-0.5 rounded-capsule bg-fill-subtle p-0.5 @pr-bar:flex";

/** A narrow list's chips as one menu [D609]. */
function Menu({ label, value, choices, onPick }: { label: string; value: string; choices: readonly { value: string; label: string }[]; onPick: (value: string) => void }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        render={
          <SelectTrigger label={label} className="border-transparent bg-fill-subtle @pr-bar:hidden">
            {choices.find((c) => c.value === value)?.label}
          </SelectTrigger>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={value} onValueChange={onPick}>
          {choices.map((choice) => (
            <DropdownMenuRadioItem key={choice.value} value={choice.value} indicator={<Check className="size-icon-md" />}>
              {choice.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A row: state, title, number, who opened it; its size and when it last changed at its end; under it, the session it's linked to. */
function Row({ pr, now, at, linked, onOpen }: { pr: FoundPr; now: number; at: number | null; linked?: SessionRow; onOpen: () => void }) {
  const changed = pr.updatedAtMs ?? pr.createdAtMs;
  const toSession = () => linked && (window.location.hash = `#thread/${encodeURIComponent(linked.id)}`);
  return (
    <li className="border-b border-divider">
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onDoubleClick={toSession}
        onKeyDown={(event) => event.key === "Enter" && onOpen()}
        className="flex min-h-12 cursor-pointer items-start gap-3 rounded-control px-2 py-3 text-sm hover:bg-fill-subtle focus-visible:focus-ring"
      >
        <StateIcon state={pr.state === "open" && pr.draft ? "draft" : pr.state} className="h-5 items-center" />
        <span className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="flex min-w-0 items-center gap-3">
            <span title={pr.title} className="min-w-0 flex-1 truncate font-medium text-foreground">
              {pr.title}
            </span>
            <span className="flex h-5 max-w-1/2 min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span className="shrink-0">#{pr.number}</span>
              {pr.repo && <span className="truncate">{pr.repo.slice(pr.repo.indexOf("/") + 1)}</span>}
              {pr.author && <Avatar login={pr.author} at={at} />}
            </span>
          </span>
          {linked && (
            <span>
              <Button
                variant="secondary"
                size="sm"
                className="max-w-full rounded-capsule"
                onClick={(event) => {
                  event.stopPropagation();
                  toSession();
                }}
              >
                <Chat />
                <span className="truncate">{linked.title}</span>
              </Button>
            </span>
          )}
        </span>
        <span className="flex h-5 shrink-0 items-center gap-3 text-xs text-muted-foreground tabular-nums">
          {pr.additions != null && <Counts insertions={pr.additions} deletions={pr.deletions ?? 0} />}
          {changed && <span>{ago(changed, now).replace(" ago", "")}</span>}
        </span>
      </div>
    </li>
  );
}

const LOADING = (count: number) =>
  Array.from({ length: count }, (_, n) => (
    <li key={n} className="flex h-12 items-center gap-3 border-b border-divider px-2">
      <Skeleton className="size-4 rounded-full" />
      <Skeleton className="h-3 flex-1" />
      <Skeleton className="size-5 rounded-full" />
      <Skeleton className="h-3 w-8" />
    </li>
  ));

/**
 * The Pull requests tab as a list [D609, D613]: the search, the chips, Linked to session, Open or Closed / merged and
 * Refresh on one bar, folding into menus when narrow; then a row each, Load more at its end. A row opens its Pull request
 * tab; a double-click on one linked to a session opens that session. Each query paints its last read at once and reads
 * again when older than the watch's quickest pace [D207, D208].
 */
export function PrListView({
  found,
  now,
  view,
  linked,
  closed,
  text,
  busy,
  more,
  checked,
  sessions,
  onView,
  onLinked,
  onClosed,
  onText,
  onRefresh,
  onMore,
  onOpen,
}: {
  found: Found | null;
  now: number;
  view: View;
  linked: boolean;
  closed: boolean;
  text: string;
  busy: boolean;
  more: boolean;
  checked: string;
  sessions: SessionRow[];
  onView: (view: View) => void;
  onLinked: (linked: boolean) => void;
  onClosed: (closed: boolean) => void;
  onText: (text: string) => void;
  onRefresh?: () => void;
  onMore: () => void;
  onOpen: (pr: Pr) => void;
}) {
  const linkOf = (pr: FoundPr) => sessions.find((s) => s.prs?.prs.some((p) => p.url && p.url === pr.url));
  const prs = (found?.prs ?? []).filter((pr) => !linked || linkOf(pr));
  const state = closed ? "closed" : "open";
  return (
    <div data-slot="pr-list" className="@container flex min-h-0 flex-1 flex-col">
      <div className="flex min-w-0 items-center gap-3 px-6 py-4">
        <div className="flex max-w-60 min-w-24 flex-1">
          <SearchField label="Search pull requests…" value={text} onChange={onText} />
        </div>
        <div className="ms-auto flex min-w-0 items-center justify-end gap-2">
          <div className={TRACK}>
            <SegmentedRoot aria-label="Pull requests" value={[view]} onValueChange={([next]) => next && onView(next as View)} className="flex items-center gap-0.5">
              {VIEWS.map((v) => (
                <Segment key={v.value} value={v.value} className={CHIP}>
                  {v.label}
                </Segment>
              ))}
            </SegmentedRoot>
            <Segment pressed={linked} onPressedChange={onLinked} className={CHIP}>
              {LINKED}
            </Segment>
          </div>
          <Menu
            label="Views"
            value={linked ? "linked" : view}
            choices={[...VIEWS, { value: "linked", label: LINKED }]}
            onPick={(v) => {
              onLinked(v === "linked");
              if (v !== "linked") onView(v as View);
            }}
          />
          <SegmentedRoot aria-label="State" value={[state]} onValueChange={([next]) => next && onClosed(next === "closed")} className={TRACK}>
            {STATES.map((s) => (
              <Segment key={s.value} value={s.value} className={CHIP}>
                {s.label}
              </Segment>
            ))}
          </SegmentedRoot>
          <Menu label="State" value={state} choices={STATES} onPick={(s) => onClosed(s === "closed")} />
          <TooltipIconButton tooltip={`Refresh · ${checked}`} size="icon-sm" disabled={!onRefresh || busy} onClick={onRefresh}>
            <ArrowRotateCw className={cx(busy && "animate-spin motion-reduce:animate-none")} />
          </TooltipIconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!found?.okAt && found?.error && !busy ? (
          <div role="alert" className="flex flex-col items-center gap-3 p-8 text-center text-sm">
            <p>Couldn't load the pull requests.</p>
            <p className="break-words text-muted-foreground">{found.error.split("\n")[0]}</p>
            <Button onClick={onRefresh}>Retry</Button>
          </div>
        ) : !found?.okAt ? (
          <ul aria-label="Loading pull requests" className="px-5">
            {LOADING(5)}
          </ul>
        ) : (
          <>
            <ul aria-label="Pull requests" className="px-5">
              {prs.map((pr) => (
                <Row key={`${pr.repo ?? ""}#${pr.number}`} pr={pr} now={now} at={found.okAt} linked={linkOf(pr)} onOpen={() => onOpen(pr)} />
              ))}
              {more && busy && LOADING(2)}
            </ul>
            {!prs.length && !busy && <p className="p-8 text-center text-sm text-muted-foreground">No matching items. Try another filter or search.</p>}
            {found.error && (
              <p role="alert" className="px-5 py-3 text-sm text-muted-foreground">
                {found.error.split("\n")[0]}
              </p>
            )}
            {found.next && (
              <div className="p-4 text-center">
                <Button variant="ghost" size="sm" disabled={busy} onClick={onMore}>
                  {found.error ? "Retry" : "Load more"}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The search's words for a chip, a state and what's typed. */
const queryOf = (view: View, closed: boolean, text: string) => [`state:${closed ? "closed" : "open"}`, VIEWS.find((v) => v.value === view)!.words, text.trim()].filter(Boolean).join(" ");

/** The Pull requests tab: Rust's search of the session's repository, drawn in this layout [D258, D609, D613]. */
export function PrList({ owner }: { owner: string }) {
  const host = useHost(owner);
  const { daemon, rows } = useDaemon();
  const now = useSecond(true);
  const [view, setView] = useState<View>("all");
  const [linked, setLinked] = useState(false);
  const [closed, setClosed] = useState(false);
  const [text, setText] = useState("");
  // What's typed is asked a moment after the last key.
  const [typed, setTyped] = useState("");
  useEffect(() => {
    const wait = setTimeout(() => setTyped(text), 400);
    return () => clearTimeout(wait);
  }, [text]);
  const query = queryOf(view, closed, typed);
  // Every query's last read the tab holds: a switch back paints at once [D207].
  const [reads, setReads] = useState<Partial<Record<string, Found>>>({});
  const [reading, setReading] = useState<string[]>([]);
  const [paging, setPaging] = useState(false);
  const found = reads[query] ?? null;

  const put = (q: string, reply: { found?: Found[]; error?: string }) =>
    setReads((was) => ({ ...was, [q]: reply.found?.[0] ?? { query: q, okAt: null, prs: [], ...was[q], error: reply.error ?? "Couldn't search." } }));
  // A first page, the rows kept again from it [D207]; a failed one keeps the last read with why.
  const read = (q: string) => {
    setReading((was) => [...was, q]);
    ask({ op: "run", args: ["host", host, "search", q] }, (reply) => {
      setReading((was) => was.filter((r) => r !== q));
      put(q, reply);
    });
  };
  // The next page joins the rows; a failed one keeps them, with why and Retry.
  const more = () => {
    if (!found?.next) return;
    setPaging(true);
    ask({ op: "run", args: ["host", host, "search", query, "--after", found.next] }, (reply) => {
      setPaging(false);
      put(query, reply);
    });
  };

  const loaded = rows !== undefined;
  useEffect(() => {
    if (!daemon || !loaded || reading.includes(query)) return;
    const last = reads[query];
    if (last) {
      if (Date.now() - (last.okAt ?? 0) > FRESH_MS) read(query);
      return;
    }
    // Its last read at once, then a read when it's older than the watch's quickest pace.
    ask({ op: "run", args: ["host", host, "search", query, "--kept"] }, (reply) => {
      const kept: Found | null = reply.found?.[0] ?? null;
      if (kept) setReads((was) => ({ ...was, [query]: kept }));
      if (Date.now() - (kept?.okAt ?? 0) > FRESH_MS) read(query);
    });
  }, [daemon, host, loaded, query]);

  const busy = reading.includes(query) || paging;
  return (
    <PrListView
      found={found}
      now={now}
      view={view}
      linked={linked}
      closed={closed}
      text={text}
      busy={busy}
      more={paging}
      checked={!daemon ? "Reconnecting…" : found?.okAt ? `checked ${ago(found.okAt, now)}` : "not checked yet"}
      sessions={rows ?? []}
      onView={setView}
      onLinked={setLinked}
      onClosed={setClosed}
      onText={setText}
      onRefresh={daemon ? () => read(query) : undefined}
      onMore={more}
      onOpen={(pr) => openPr(owner, pr)}
    />
  );
}
