import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { EmptyState } from "../components/empty-state";
import { Segmented } from "../components/segmented";
import { Select } from "../components/select";
import { Skeleton } from "../components/skeleton";
import { ask, useDaemon } from "../daemon";
import { MagnifyingGlassSearch, XCircleFilled } from "../icons";
import { Avatar, StateIcon } from "../landing/pr-parts";
import { useStored } from "../sidebar/sidebar";
import { useSections } from "./nav";
import { age } from "./nav-row";
import { openPrPage, pastedRef, type PrRow } from "./route";

/*
 * The Pull Requests page with no PR open [D241 D243]: Open / Merged / Closed, a
 * search that takes GitHub's qualifiers (label:bug), the Project and Account menus, then Review requested, Authored and
 * Others, each row its repo, head → base and a checks dot. A pick opens the PR as the sidebar does. The filters are kept.
 */

type State = "open" | "merged" | "closed";
type Filters = { state: State; words: string; project: string; account: string };
type Scopes = { accounts: string[]; projects: { id: string; name: string; repos: string[] }[] };

const ALL = "all";
const STATES: Record<State, string> = { open: "is:open", merged: "is:merged", closed: "is:closed is:unmerged" };
const SECTIONS = [
  { title: "Review requested", query: "review-requested:@me" },
  { title: "Authored", query: "author:@me" },
  { title: "Others", query: "involves:@me -author:@me -review-requested:@me" },
];
const CHECKS: Record<string, [string, string]> = {
  success: ["bg-success", "Checks passed"],
  failure: ["bg-destructive", "Checks failing"],
  error: ["bg-destructive", "Checks failing"],
  pending: ["bg-warning", "Checks running"],
  expected: ["bg-warning", "Checks running"],
};
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function PrInbox() {
  const [filters, setFilters] = useStored<Filters>("pullRequests.inbox", { state: "open", words: "", project: ALL, account: ALL });
  const set = (next: Partial<Filters>) => setFilters({ ...filters, ...next });
  const scopes = useScopes();
  const words = useSettled(filters.words.trim());
  // A kept pick that's gone (a project removed, an account signed out) reads as all.
  const project = scopes?.projects.find((each) => each.id === filters.project);
  const account = scopes && !scopes.accounts.includes(filters.account) ? ALL : filters.account;
  const repos = project ? project.repos.map((repo) => `repo:${repo}`).join(" ") : "";
  const scoped = !project || project.repos.length > 0;
  const queries = scopes && scoped ? SECTIONS.map((each) => [STATES[filters.state], each.query, repos, words].filter(Boolean).join(" ")) : [];
  const { read, again } = useSections(queries, account === ALL ? [] : ["--as", account]);
  // A PR that's in an earlier section isn't listed again (two accounts: authored by one, asked of the other).
  const seen = new Set<string>();
  const sections = SECTIONS.map((each, i) => {
    const got = read?.found[queries[i]!];
    const rows = got?.prs.filter((row) => !seen.has(row.ref) && seen.add(row.ref));
    return { ...each, rows, more: !!got?.next, error: got?.error ?? null };
  });
  const loading = !scopes || (scoped && !read?.error && sections.some((each) => !each.rows));
  // A failed refresh leaves the rows it had in place, as the sidebar does [D262].
  const failed = sections.every((each) => !each.rows?.length) ? (read?.error ?? (sections.every((each) => each.error) ? sections[0]!.error : null)) : null;
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      {/* The titlebar's row stays empty and drags the window, as on a PR and in Settings [D277]. */}
      <div className="app-drag -mt-tab-bar h-tab-bar shrink-0" />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-gutter">
        <div className="flex w-full flex-col gap-5 px-6 pt-8 pb-12">
          <header className="flex items-center gap-4">
            <h1 className="min-w-0 flex-1 text-page-title font-medium">Pull Requests</h1>
            <Segmented
              label="State"
              value={filters.state}
              onChange={(state) => set({ state })}
              options={[
                { value: "open", label: "Open" },
                { value: "merged", label: "Merged" },
                { value: "closed", label: "Closed" },
              ]}
            />
          </header>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex h-nav-search min-w-0 flex-1 basis-64 items-center gap-2 rounded-capsule border border-fill-active bg-fill px-3 has-focus-visible:focus-ring">
              <MagnifyingGlassSearch aria-hidden className="size-icon-md shrink-0 text-quiet-foreground" />
              <input
                aria-label="Search pull requests"
                placeholder="Search pull requests, or label:bug"
                value={filters.words}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                className="min-w-0 flex-1 cursor-text bg-transparent text-sm outline-none placeholder:text-faint-foreground"
                onChange={(event) => {
                  // A pasted link opens its PR at once, as the sidebar's search does [D160].
                  const ref = pastedRef(event.target.value);
                  if (ref) openPrPage(ref);
                  else set({ words: event.target.value });
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || !filters.words) return;
                  event.stopPropagation();
                  set({ words: "" });
                }}
              />
              {filters.words && (
                <button type="button" aria-label="Clear search" className="flex shrink-0 cursor-pointer items-center rounded-capsule text-faint-foreground hover:text-foreground focus-visible:focus-ring" onClick={() => set({ words: "" })}>
                  <XCircleFilled className="size-icon-sm" />
                </button>
              )}
            </label>
            <Select
              label="Project"
              value={project ? project.id : ALL}
              onChange={(id) => set({ project: id })}
              options={[
                { value: ALL, label: "All projects", shown: "Project: All" },
                ...(scopes?.projects ?? []).map((each) => ({
                  value: each.id,
                  label: each.name,
                  shown: `Project: ${each.name}`,
                  hint: each.repos.length ? each.repos.join(", ") : "No GitHub repository",
                })),
              ]}
            />
            <Select
              label="Account"
              value={account}
              onChange={(login) => set({ account: login })}
              icon={account === ALL ? undefined : <Avatar login={account} size="size-4" />}
              options={[{ value: ALL, label: "All accounts" }, ...(scopes?.accounts ?? []).map((login) => ({ value: login, label: login }))]}
            />
          </div>
          {!scoped ? (
            <EmptyState variant="centered" title="No GitHub repository" detail={`${project!.name} isn't on github.com`} className="py-16" />
          ) : failed ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <EmptyState variant="centered" title="Unable to load pull requests" detail={failed} />
              <Button variant="outline" size="sm" onClick={again}>
                Try again
              </Button>
            </div>
          ) : loading ? (
            <div aria-label="Loading pull requests" className="flex flex-col gap-5 pt-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex flex-col gap-2 px-3">
                  <Skeleton className="h-4 w-3/5" />
                  <Skeleton className="h-3 w-2/5" />
                </div>
              ))}
            </div>
          ) : sections.every((each) => !each.rows?.length) ? (
            <EmptyState variant="centered" title="No pull requests" detail={words || project || account !== ALL ? "None match these filters" : `You have no ${filters.state} pull requests`} className="py-16" />
          ) : (
            sections.map(
              (each) =>
                !!each.rows?.length && (
                  <section key={each.title} className="flex flex-col gap-1">
                    <h2 className="flex items-center gap-2 px-3 text-sm text-quiet-foreground">
                      {each.title}
                      <span className="text-faint-foreground">
                        {each.rows.length}
                        {each.more && "+"}
                      </span>
                    </h2>
                    {each.error && <p className="px-3 text-xs text-destructive">{each.error}</p>}
                    <ul className="flex flex-col">
                      {each.rows.map((row) => (
                        <InboxRow key={row.ref} row={row} />
                      ))}
                    </ul>
                  </section>
                ),
            )
          )}
        </div>
      </div>
    </main>
  );
}

/** A PR in the inbox: its state, title, checks and size; under them its author, age, repo #n and head → base. */
function InboxRow({ row }: { row: PrRow }) {
  const repo = row.ref.split("#")[0]!.split("/").slice(1).join("/");
  const checks = row.checks ? CHECKS[row.checks] : undefined;
  return (
    <li>
      <button type="button" onClick={() => openPrPage(row)} className="flex w-full cursor-pointer gap-3 rounded-row px-3 py-2.5 text-start hover:bg-fill focus-visible:focus-ring">
        <StateIcon state={row.state === "open" && row.draft ? "draft" : row.state} className="pt-0.5" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{row.title}</span>
            {checks && <span role="img" aria-label={checks[1]} title={checks[1]} className={cx("size-1.5 shrink-0 rounded-full", checks[0])} />}
            {row.additions != null && (
              <span className="shrink-0 text-xs tabular-nums">
                <span className="text-success">+{compact.format(row.additions)}</span> <span className="text-destructive">−{compact.format(row.deletions ?? 0)}</span>
              </span>
            )}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap text-faint-foreground">
            <Avatar login={row.author ?? null} size="size-4" />
            <span>{row.author ?? "ghost"}</span>
            {row.createdAtMs && <span>· {age(row.createdAtMs)}</span>}
            <span>
              · {repo} #{row.number}
            </span>
            {row.head && (
              <span className="min-w-0 truncate font-mono">
                · {row.head} → {row.base}
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

/** The menus' choices, Rust's `host @ scopes`: gh's github.com logins and each project's repositories there. */
function useScopes(): Scopes | null {
  const { daemon } = useDaemon();
  // The last read at once, so a revisit doesn't wait on it to ask for its rows [D262].
  const [scopes, setScopes] = useStored<Scopes | null>("pullRequests.scopes", null);
  useEffect(() => {
    if (!daemon) return;
    ask({ op: "run", args: ["host", "@", "scopes"] }, (reply) =>
      // Unread, the menus offer All alone and the search still goes.
      setScopes(reply.ok ? { accounts: reply.accounts, projects: reply.projects } : (scopes ?? { accounts: [], projects: [] })),
    );
  }, [daemon]);
  return scopes;
}

/** `value` once it has held still for 400ms, as the sidebar's search waits. */
function useSettled(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const wait = setTimeout(() => setSettled(value), 400);
    return () => clearTimeout(wait);
  }, [value]);
  return settled;
}
