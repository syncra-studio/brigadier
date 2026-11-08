// ⌘K: search over projects and sessions, the old app's palette with message text from Rust [D196, D197].
import { Autocomplete } from "@base-ui/react/autocomplete";
import { type ReactNode, useEffect, useState } from "react";

import { Badge } from "../components/badge";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { Kbd } from "../components/kbd";
import { MenuRow } from "../components/menu";
import { ask, useDaemon } from "../daemon";
import { Folder, MagnifyingGlassSmSearch, Terminal } from "../icons";
import { store, useProfile } from "../onboarding/api";
import { startProject } from "../onboarding/start";
import { showProject } from "../projects/store";
import { useShown } from "../sidebar/actions";
import { RowMark } from "../sidebar/row";
import { type Project, type SessionRow, statusWords } from "../sidebar/words";

/** A session whose messages hold every word: the best message's snippet, and where the words are in it (UTF-16). */
export type Hit = { id: string; snippet: string; at: [number, number][] };
/** Rust's search over message text, best first [D72]; rejects with the reason. */
export type TextSearch = (q: string) => Promise<Hit[]>;
/** `archived` comes with archive (1v); until then no row has it, and no tag shows [D197]. */
export type PaletteRow = SessionRow & { archived?: boolean };

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
  | { kind: "session"; id: string; row: PaletteRow; at?: [number, number][]; hit?: Hit };
type Group = { value: "Projects" | "Sessions"; items: Result[] };

const byLastSend = (a: { row: PaletteRow }, b: { row: PaletteRow }) => b.row.sent - a.row.sent;
const archivedLast = (a: { row: PaletteRow }, b: { row: PaletteRow }) => Number(Boolean(a.row.archived)) - Number(Boolean(b.row.archived));

/**
 * Empty: recent sessions, those needing you first. Typed: projects and sessions by title from memory at once, then
 * sessions by message text as Rust answers, each once; archived ones last [D196, D197].
 */
function results(rows: PaletteRow[], projects: Project[], query: string, hits: Hit[] | undefined): Group[] {
  if (!query.trim()) {
    const needs = (each: { row: PaletteRow }) => Number(each.row.mark === "needs");
    const recent = rows.map((row) => ({ kind: "session" as const, id: row.id, row }));
    return [{ value: "Sessions", items: recent.toSorted((a, b) => archivedLast(a, b) || needs(b) - needs(a) || byLastSend(a, b)).slice(0, MAX) }];
  }
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

const ROW = "group flex min-h-control-md cursor-pointer items-center gap-3 rounded-control px-2.5 text-sm outline-none select-none highlighted:bg-fill";
const NOTE = "px-2.5 py-1.5 text-sm text-muted-foreground";

/** A row's grey end; the highlighted row says Open ↵ instead. */
const end = (detail: ReactNode) => (
  <>
    <span className="flex items-center gap-2 group-data-highlighted:hidden">{detail}</span>
    <span className="hidden items-center gap-1.5 group-data-highlighted:flex">
      Open
      <Kbd>↵</Kbd>
    </span>
  </>
);

function ResultRow({ result, projects }: { result: Result; projects: Map<string, Project> }) {
  if (result.kind === "project") {
    const { project, at, count } = result;
    return <MenuRow icon={<Folder />} title={<Marked text={project.name} at={at} />} hint={end(`${count} ${count === 1 ? "session" : "sessions"}`)} />;
  }
  const { row, at, hit } = result;
  const words = statusWords(row);
  const detail = (
    <>
      {row.archived && <Badge variant="secondary">Archived</Badge>}
      {row.mark && <RowMark mark={row.mark} label={words ?? ""} />}
      {row.project !== null && projects.get(row.project)?.name}
    </>
  );
  const title = at ? <Marked text={row.title} at={at} /> : row.title;
  // A text match's snippet goes under its title, the end staying at the row's end like every other row's.
  const lines = hit && (
    <span className="flex flex-col py-1">
      <span className="truncate">{title}</span>
      <span className="truncate text-xs text-muted-foreground">
        <Marked text={hit.snippet} at={hit.at} />
      </span>
    </span>
  );
  return <MenuRow icon={<Terminal />} title={lines ?? title} hint={end(detail)} />;
}

export type PaletteProps = {
  /** undefined until the first list arrives. */
  rows: PaletteRow[] | undefined;
  projects: Project[];
  offline: boolean;
  search: TextSearch;
  onOpenSession: (id: string) => void;
  onOpenProject: (id: string) => void;
  /** Where it opens with something typed (the gallery's frozen states). */
  initialQuery?: string;
};

/** The palette's input, results and key hints: the old app's, with message text matches under their titles. */
export function PaletteBody({ rows, projects, offline, search, onOpenSession, onOpenProject, initialQuery = "" }: PaletteProps) {
  const [q, setQ] = useState(initialQuery);
  const query = q.trim();
  const text = useTextSearch(query, search, offline);
  const groups = rows ? results(rows, projects, q, text.hits) : [];
  const projectOf = new Map(projects.map((project) => [project.id, project]));
  const choose = (result: Result) => (result.kind === "project" ? onOpenProject(result.id) : onOpenSession(result.id));
  return (
    <Autocomplete.Root
      open
      inline
      items={groups}
      filter={null}
      value={q}
      // Only typing changes the query: picking a row doesn't type its title in as the palette closes.
      onValueChange={(value, details) => details.reason === "input-change" && setQ(value)}
      itemToStringValue={(result: Result) => result.id}
      autoHighlight="always"
      keepHighlight
    >
      <div className="flex h-13.5 items-center gap-3 border-b border-divider ps-4.5 pe-4">
        <MagnifyingGlassSmSearch className="size-icon-md shrink-0 text-muted-foreground" />
        <Autocomplete.Input
          aria-label="Search"
          placeholder="Search projects and sessions"
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <Kbd>esc</Kbd>
      </div>
      <div className="flex max-h-96 flex-col gap-1.5 overflow-y-auto px-2 pt-2 pb-2.5">
        {groups.length > 0 && (
          <Autocomplete.List className="flex flex-col gap-1.5">
            {(group: Group) => (
              <Autocomplete.Group key={group.value} items={group.items} className="flex flex-col gap-px">
                <Autocomplete.GroupLabel className="px-2.5 pt-2 pb-1.5 text-xs font-medium text-muted-foreground">{group.value}</Autocomplete.GroupLabel>
                <Autocomplete.Collection>
                  {(result: Result) => (
                    <Autocomplete.Item key={`${result.kind}:${result.id}`} value={result} onClick={() => choose(result)} className={ROW}>
                      <ResultRow result={result} projects={projectOf} />
                    </Autocomplete.Item>
                  )}
                </Autocomplete.Collection>
              </Autocomplete.Group>
            )}
          </Autocomplete.List>
        )}
        {rows === undefined ? (
          <p className={NOTE}>Loading sessions…</p>
        ) : query && offline ? (
          <p className={NOTE}>Searching titles only · reconnecting…</p>
        ) : text.slow ? (
          <p className={NOTE}>Searching…</p>
        ) : (
          groups.length === 0 &&
          (text.settled || !query) && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">{query ? `Nothing matches “${query}”.` : "Nothing here yet."}</p>
          )
        )}
        <ErrorLine error={text.error && `Couldn't search messages · ${text.error}`} className="px-2.5 py-1.5" />
      </div>
      <div className="flex h-10 items-center gap-4.5 border-t border-divider px-4.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          Navigate
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>↵</Kbd>
          Open
        </span>
      </div>
    </Autocomplete.Root>
  );
}

export const PALETTE_FRAME = "max-w-palette gap-0 p-0";
export const PALETTE_TOP = "top-42";

/** The palette as a dialog near the window's top; choosing a result closes it. */
export function SearchPalette({ open, onOpenChange, ...props }: PaletteProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const close = <T,>(then: (id: T) => void) => (id: T) => {
    onOpenChange(false);
    then(id);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} frame={PALETTE_FRAME} top={PALETTE_TOP}>
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">Find projects and sessions by title or by what was said in them.</DialogDescription>
        {open && <PaletteBody {...props} onOpenSession={close(props.onOpenSession)} onOpenProject={close(props.onOpenProject)} />}
      </DialogContent>
    </Dialog>
  );
}

const opened = store(false);
/** Opens the palette: ⌘K, or the sidebar's Search. */
export const openSearch = () => opened.set(true);

/**
 * The palette over every screen after onboarding, mounted once [D196]. A session opens its thread; a project opens
 * Home's form in it and shows it in the sidebar, as the old app did.
 */
export function GlobalSearch() {
  const { daemon, rows, projects } = useDaemon();
  const shown = useShown(rows);
  const open = opened.use();
  const onboarded = useProfile().value?.onboarded;
  useEffect(() => {
    if (!onboarded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "KeyK" || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      opened.set(true);
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [onboarded]);
  if (!onboarded) return null;
  return (
    <SearchPalette
      open={open}
      onOpenChange={opened.set}
      rows={shown}
      projects={projects ?? []}
      offline={!daemon}
      search={searchText}
      onOpenSession={(id) => (window.location.hash = `#thread/${encodeURIComponent(id)}`)}
      onOpenProject={(id) => {
        window.location.hash = "";
        startProject.set(id);
        showProject(id, false);
      }}
    />
  );
}
