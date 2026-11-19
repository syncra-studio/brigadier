// The sidebar's search [D846]: the field filters its projects and sessions by name as you type, and under them lists
// the sessions whose messages match, from ⌘K's palette's search [D196]; a message match opens its session found at it.
import { type KeyboardEvent, type ReactNode, useState } from "react";

import { EmptyState } from "../components/empty-state";
import { ErrorLine } from "../components/error-line";
import { NavList, NavRow, NavSection } from "../components/nav";
import { openProject } from "../projects/page";
import { type Hit, Marked, searchText, useTextSearch, wordStarts } from "../palette/palette";
import { findOnOpen } from "../thread/find";
import { ProjectBadge } from "./row";
import type { Project } from "../projects/projects";
import type { SessionRow } from "./words";

const NOTE = "px-2 py-1.5 text-sm text-muted-foreground";

/**
 * What the field holds and matched: `projects` and `sessions` (the sidebar's) by name, then the sessions in `all`,
 * archived ones too, whose messages match and whose title didn't.
 */
export function useSidebarSearch(projects: Project[], sessions: SessionRow[], all: SessionRow[], offline: boolean, onOpen: (id: string) => void) {
  const [q, setQ] = useState("");
  const query = q.trim();
  const text = useTextSearch(query, searchText, offline);
  const named = query ? projects.filter((project) => wordStarts(project.name, query)) : [];
  const titled = query ? sessions.filter((row) => wordStarts(row.title, query)) : [];
  const byId = new Map(all.map((row) => [row.id, row]));
  const said = query ? (text.hits ?? []).flatMap((hit) => (byId.has(hit.id) && !titled.some((row) => row.id === hit.id) ? [{ row: byId.get(hit.id)!, hit }] : [])) : [];
  // The thread's find bar opens on the first matched word, the way to the message itself.
  const openAt = (row: SessionRow, hit: Hit) => {
    const [start, end] = hit.at[0] ?? [0, 0];
    if (end > start) findOnOpen(row.id, hit.snippet.slice(start, end));
    onOpen(row.id);
  };
  // Enter opens the first match; Esc empties the field.
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && q) {
      event.preventDefault();
      setQ("");
    } else if (event.key === "Enter" && query) {
      event.preventDefault();
      if (named[0]) openProject(named[0].id);
      else if (titled[0]) onOpen(titled[0].id);
      else if (said[0]) openAt(said[0].row, said[0].hit);
    }
  };
  return { q, setQ, query, named, titled, said, text, openAt, onKeyDown };
}

export type SidebarSearch = ReturnType<typeof useSidebarSearch>;

/** The matches in the list's place: the sidebar's own rows (`project`, `session` draw them), then Messages. */
export function SearchResults({ search, projects, offline, project, session }: { search: SidebarSearch; projects: Project[]; offline: boolean; project: (each: Project) => ReactNode; session: (each: SessionRow) => ReactNode }) {
  const { named, titled, said, text, query } = search;
  return (
    <>
      {named.length > 0 && (
        <NavSection title="Projects">
          <NavList className="gap-1">{named.map(project)}</NavList>
        </NavSection>
      )}
      {titled.length > 0 && (
        <NavSection title="Sessions">
          <NavList className="gap-1">{titled.map(session)}</NavList>
        </NavSection>
      )}
      {said.length > 0 && (
        <NavSection title="Messages">
          <NavList className="gap-1">
            {said.map(({ row, hit }) => {
              const home = projects.find((each) => each.id === row.project);
              return (
                <li key={row.id}>
                  <NavRow className="py-1" onClick={() => search.openAt(row, hit)}>
                    <ProjectBadge id={home?.id} name={home?.name ?? null} tone={home && projects.indexOf(home)} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{row.title || "New session"}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        <Marked text={hit.snippet} at={hit.at} />
                      </span>
                    </span>
                  </NavRow>
                </li>
              );
            })}
          </NavList>
        </NavSection>
      )}
      {offline ? (
        <p className={NOTE}>Searching names only · reconnecting…</p>
      ) : text.slow ? (
        <p className={NOTE}>Searching…</p>
      ) : (
        named.length + titled.length + said.length === 0 && text.settled && <EmptyState title={`Nothing matches “${query}”.`} />
      )}
      <ErrorLine error={text.error && `Couldn't search messages · ${text.error}`} className="px-2 py-1.5" />
    </>
  );
}
