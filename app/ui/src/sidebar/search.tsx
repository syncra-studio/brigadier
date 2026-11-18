// The sidebar's search [D33, D37]: typing lists projects, then sessions by title and by message text from Rust, in the
// sidebar's place, as ⌘K's palette did [D196, D197]. ⌘K focuses it, opening a strip or closed sidebar while it's used.
import { Autocomplete } from "@base-ui/react/autocomplete";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { Badge } from "../components/badge";
import { EmptyState } from "../components/empty-state";
import { ErrorLine } from "../components/error-line";
import { NavRow } from "../components/nav";
import { useSidebar } from "../components/sidebar";
import { ask } from "../daemon";
import { newSession } from "../home/start";
import { store } from "../onboarding/api";
import { showProject } from "../projects/store";
import { closeSettings, settingsPageOf } from "../settings/shell";
import { matches } from "../shortcuts";
import { useShown } from "./actions";
import { ProjectBadge, RowMark } from "./row";
import { type Project, type SessionRow, statusWords } from "./words";

/** A session whose messages hold every word: the best message's snippet, and where the words are in it (UTF-16). */
export type Hit = { id: string; snippet: string; at: [number, number][] };
/** Rust's search over message text, best first [D72]; rejects with the reason. */
export type TextSearch = (q: string) => Promise<Hit[]>;

export const searchText: TextSearch = (q) =>
  new Promise((resolve, reject) => ask({ op: "search", q }, (frame) => (frame.ok ? resolve(frame.hits) : reject(frame.error))));

const MAX = 50;
const SLOW_MS = 200;
const WORD = /[\p{L}\p{N}\p{M}]+/gu;
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Where each typed word starts a word of `text`, as the index matches message text (case and accents aside, word
 * starts only) [D72]; null when one doesn't.
 */
export function wordStarts(text: string, query: string): [number, number][] | null {
  const words = fold(query).match(WORD);
  if (!words) return null;
  const tokens = [...text.matchAll(WORD)];
  const at: [number, number][] = [];
  for (const word of words) {
    const token = tokens.find((each) => fold(each[0]).startsWith(word));
    if (!token) return null;
    let end = 1;
    while (fold(token[0].slice(0, end)).length < word.length) end++;
    at.push([token.index, token.index + end]);
  }
  return at;
}

/** `text` with the parts at `at` in semibold. */
function Marked({ text, at }: { text: string; at: [number, number][] }) {
  const parts: ReactNode[] = [];
  let from = 0;
  for (const [start, end] of at.toSorted((a, b) => a[0] - b[0])) {
    if (end <= from) continue;
    const begin = Math.max(start, from);
    parts.push(text.slice(from, begin), <span key={begin} className="font-semibold">{text.slice(begin, end)}</span>);
    from = end;
  }
  parts.push(text.slice(from));
  return parts;
}

type Result =
  | { kind: "project"; id: string; project: Project; at: [number, number][]; count: number }
  | { kind: "session"; id: string; row: SessionRow; at?: [number, number][]; hit?: Hit };
type Group = { value: "Projects" | "Sessions"; items: Result[] };

const byLastSend = (a: { row: SessionRow }, b: { row: SessionRow }) => b.row.sent - a.row.sent;
const archivedLast = (a: { row: SessionRow }, b: { row: SessionRow }) => Number(Boolean(a.row.archived)) - Number(Boolean(b.row.archived));

/**
 * Projects and sessions by title from memory at once, then sessions by message text as Rust answers, each once;
 * archived ones last [D196, D197].
 */
function results(rows: SessionRow[], projects: Project[], query: string, hits: Hit[] | undefined): Group[] {
  const named = projects
    .flatMap((project) => {
      const at = wordStarts(project.name, query);
      const count = rows.filter((row) => row.project === project.id && !row.archived).length;
      return at ? [{ kind: "project" as const, id: project.id, project, at, count }] : [];
    })
    .toSorted((a, b) => a.project.name.localeCompare(b.project.name));
  const titled = rows
    .flatMap((row) => {
      const at = wordStarts(row.title, query);
      return at ? [{ kind: "session" as const, id: row.id, row, at }] : [];
    })
    .toSorted(byLastSend);
  const shown = new Set(titled.map((each) => each.id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const texted = (hits ?? []).flatMap((hit) => {
    const row = byId.get(hit.id);
    return row && !shown.has(hit.id) ? [{ kind: "session" as const, id: hit.id, row, hit }] : [];
  });
  const groups: Group[] = [
    { value: "Projects", items: named.slice(0, MAX) },
    { value: "Sessions", items: [...titled, ...texted].toSorted(archivedLast).slice(0, MAX) },
  ];
  return groups.filter((group) => group.items.length > 0);
}

type Answer = { q: string; hits?: Hit[]; error?: string };

/**
 * The text search for `query`: the latest answer only, asked again when the daemon comes back. A slow answer
 * shows "Searching…" after SLOW_MS; a fast one swaps in place.
 */
function useTextSearch(query: string, search: TextSearch, offline: boolean) {
  const [answer, setAnswer] = useState<Answer>({ q: "" });
  const [slowFor, setSlowFor] = useState("");
  useEffect(() => {
    if (!query || offline) return;
    let current = true;
    const timer = setTimeout(() => current && setSlowFor(query), SLOW_MS);
    search(query).then(
      (hits) => current && setAnswer({ q: query, hits }),
      (error: unknown) => current && setAnswer({ q: query, error: String(error) }),
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, search, offline]);
  const answered = answer.q === query;
  const slow = !answered && slowFor === query;
  // Until the new answer, the last one stays rather than flash empty; once slow, "Searching…" says why.
  return { hits: slow ? undefined : answer.hits, error: answered ? answer.error : undefined, settled: answered || offline, slow: slow && !offline };
}

const NOTE = "px-2 py-1.5 text-sm text-muted-foreground";
// NavSection's title, for a group that doesn't fold.
const LABEL = "flex min-h-6 items-center ps-2 pb-1 text-sm font-medium text-faint-foreground opacity-nav-title";

// ⌘K or the strip's Search, waiting for the sidebar to take it: it may only mount once Settings has gone.
const asked = store(false);

/** Searches in the sidebar, leaving Settings for it first [D39]. */
export function askSearch(): void {
  if (settingsPageOf(window.location.hash) !== null) closeSettings();
  asked.set(true);
}

/** ⌘K, wherever the sidebar is (not in onboarding). Call once. */
export function listenToSearchKey(): void {
  addEventListener("keydown", (event) => {
    if (!matches(event, "search") || !document.querySelector('[data-slot="sidebar-wrapper"]')) return;
    event.preventDefault();
    askSearch();
  });
}

/** Focus to the composer now shown, once it has drawn, unless something else took it first. */
function focusComposer(frames = 30): void {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body && !active.matches("input")) return;
    const field = [...document.querySelectorAll<HTMLElement>('[data-slot="composer-field"] [contenteditable="true"]')].find((each) => each.checkVisibility() && !each.closest("[inert]"));
    if (field) field.focus();
    else if (frames > 0) focusComposer(frames - 1);
  });
}

export type SidebarSearch = ReturnType<typeof useSidebarSearch>;

/** The search's query and results, and what ⌘K opened, to put back on Esc or once a result opens. */
export function useSidebarSearch(rows: SessionRow[] | undefined, projects: Project[], offline: boolean, onOpen: (id: string) => void) {
  const [q, setQ] = useState("");
  const query = q.trim();
  // Every session the palette searched, archived ones too, whatever View leaves out.
  const all = useShown(rows);
  const text = useTextSearch(query, searchText, offline);
  const groups = all && query ? results(all, projects, query, text.hits) : [];
  // The peek mounts another field: resolve the visible one after the sidebar opens.
  const input = () => [...document.querySelectorAll<HTMLInputElement>('[data-slot="sidebar-search"]')].find((each) => each.checkVisibility() && !each.closest("[inert]"));
  const { open, setOpen } = useSidebar();
  // ⌘K opened the sidebar, and where focus was before it.
  const opened = useRef(false);
  const before = useRef<HTMLElement | null>(null);
  const pending = asked.use();
  // Before the ask below, which on a first draw (leaving Settings) opens what this would otherwise forget.
  useEffect(() => {
    if (!open) opened.current = false;
  }, [open]);
  useEffect(() => {
    if (!pending) return;
    asked.set(false);
    const active = document.activeElement;
    if (active !== input()) before.current = active instanceof HTMLElement && active !== document.body ? active : null;
    if (!open) {
      opened.current = true;
      setOpen(true);
    }
    requestAnimationFrame(() => input()?.select());
  }, [pending]);
  // The sidebar as it was: no query, closed again if ⌘K opened it, and focus back where it was when `restore`.
  const leave = (restore: boolean) => {
    setQ("");
    const back = before.current;
    before.current = null;
    input()?.blur();
    if (opened.current) {
      opened.current = false;
      setOpen(false);
    }
    if (restore && back?.isConnected) requestAnimationFrame(() => back.focus());
  };
  const choose = (result: Result) => {
    leave(false);
    // A project opens Home's form in it and shows it in the sidebar, as the old app did.
    if (result.kind === "project") {
      newSession(result.id);
      showProject(result.id, false);
    } else onOpen(result.id);
    focusComposer();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    // A query ⌘K didn't open the sidebar for clears and stays; otherwise all of it goes back.
    if (query && !opened.current) setQ("");
    else leave(true);
  };
  return { q, setQ, query, groups, text, rows: all, offline, onKeyDown, choose };
}

/** Holds the field and the results, which sit apart in the sidebar, as one list the field's arrows move through. */
export function SearchRoot({ search, children }: { search: SidebarSearch; children: ReactNode }) {
  return (
    <Autocomplete.Root
      open
      inline
      items={search.groups}
      filter={null}
      value={search.q}
      // Only typing changes the query: opening a row doesn't type its title in.
      onValueChange={(value, details) => details.reason === "input-change" && search.setQ(value)}
      itemToStringValue={(result: Result) => result.id}
      autoHighlight="always"
      keepHighlight
    >
      {children}
    </Autocomplete.Root>
  );
}

export function SearchField({ search, label }: { search: SidebarSearch; label: string }) {
  return (
    <Autocomplete.Input
      data-slot="sidebar-search"
      aria-label="Search"
      title={label}
      placeholder="Search"
      onKeyDown={search.onKeyDown}
      className="min-w-0 flex-1 self-stretch bg-transparent text-label text-foreground outline-none placeholder:text-placeholder"
    />
  );
}

// How much of a snippet stays before its first match, so the match shows on the sidebar's one line.
const LEAD = 16;
/** The snippet from a word a little before its first match, with an ellipsis where it was cut. */
function around({ snippet, at }: Hit): { text: string; at: [number, number][] } {
  const first = Math.min(...at.map(([start]) => start));
  if (!(first > LEAD)) return { text: snippet, at };
  const from = snippet.lastIndexOf(" ", first - LEAD) + 1;
  if (from === 0) return { text: snippet, at };
  const shift = 1 - from;
  return { text: `…${snippet.slice(from)}`, at: at.map(([start, end]) => [start + shift, end + shift]) };
}

function ResultRow({ result, projects }: { result: Result; projects: Project[] }) {
  if (result.kind === "project") {
    const { project, at, count } = result;
    return (
      <>
        <ProjectBadge id={project.id} name={project.name} tone={projects.indexOf(project)} />
        <span className="min-w-0 flex-1 truncate">
          <Marked text={project.name} at={at} />
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{`${count} ${count === 1 ? "session" : "sessions"}`}</span>
      </>
    );
  }
  const { row, at, hit } = result;
  const project = projects.find((each) => each.id === row.project);
  const title = at ? <Marked text={row.title} at={at} /> : row.title;
  return (
    <>
      <ProjectBadge id={project?.id} name={project?.name ?? null} tone={project && projects.indexOf(project)} />
      {/* A text match's snippet goes under its title, cut around the match by Rust. */}
      <span className="flex min-w-0 flex-1 flex-col py-1">
        <span className="truncate">{title}</span>
        {hit && (
          <span className="truncate text-xs text-muted-foreground">
            <Marked {...around(hit)} />
          </span>
        )}
      </span>
      {!!row.archived && <Badge variant="secondary">Archived</Badge>}
      {row.mark && <RowMark mark={row.mark} label={statusWords(row) ?? ""} />}
    </>
  );
}

/** The results in the sidebar list's place, with why there are none yet. */
export function SearchResults({ search, projects }: { search: SidebarSearch; projects: Project[] }) {
  const { groups, text, query } = search;
  return (
    <>
      {groups.length > 0 && (
        <Autocomplete.List className="flex flex-col gap-4">
          {(group: Group) => (
            <Autocomplete.Group key={group.value} items={group.items} className="flex flex-col">
              <Autocomplete.GroupLabel className={LABEL}>{group.value}</Autocomplete.GroupLabel>
              <Autocomplete.Collection>
                {(result: Result) => (
                  <Autocomplete.Item key={`${result.kind}:${result.id}`} value={result} onClick={() => search.choose(result)} render={<NavRow />} className="highlighted:bg-fill">
                    <ResultRow result={result} projects={projects} />
                  </Autocomplete.Item>
                )}
              </Autocomplete.Collection>
            </Autocomplete.Group>
          )}
        </Autocomplete.List>
      )}
      {search.rows === undefined ? (
        <p className={NOTE}>Loading sessions…</p>
      ) : search.offline ? (
        <p className={NOTE}>Searching titles only · reconnecting…</p>
      ) : text.slow ? (
        <p className={NOTE}>Searching…</p>
      ) : (
        groups.length === 0 && text.settled && <EmptyState title={`Nothing matches “${query}”.`} />
      )}
      <ErrorLine error={text.error && `Couldn't search messages · ${text.error}`} className="px-2 py-1.5" />
    </>
  );
}
