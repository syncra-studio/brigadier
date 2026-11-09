import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { ComposerPill } from "../components/composer/composer";
import { STILL } from "../components/composer/pickers";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { itemClasses, MenuRow } from "../components/menu";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { Branch, Check, Folder } from "../icons";
import { errorText, run } from "../onboarding/api";
import { PickerSearch, RAIL_PILL, type WorkIn } from "./pills";

/** What Rust read of a project's repository: `projects branches`. */
export type RepoInfo = { current: string | null; branches: string[]; worktrees: { path: string; branch: string | null }[] };
export type RepoState = { info?: RepoInfo; error?: string; loading: boolean; refresh: () => void };

/** The project's branches and worktrees, read again each time a picker opens. */
export function useRepo(project: string | undefined, on: boolean): RepoState {
  const [got, setGot] = useState<{ project: string; info?: RepoInfo; error?: string } | null>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (!project || !on) return;
    let live = true;
    run(["projects", "branches", project]).then(
      (reply) => live && setGot({ project, info: reply.repo as RepoInfo }),
      (cause) => live && setGot({ project, error: errorText(cause) }),
    );
    return () => {
      live = false;
    };
  }, [project, on, asked]);
  const mine = got?.project === project ? got : null;
  return { info: mine?.info, error: mine?.error, loading: !mine, refresh: () => setAsked((now) => now + 1) };
}

const folderName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

/**
 * The branch pill, as the old app's [D388, D392]. A new worktree's picks its base: a search (not focused on open), the
 * branches (checked-out first, ✓ on the pick) in a fixed-height list. An existing worktree's picks the folder to work
 * in, each with its branch. The local checkout's shows the branch the project's folder has checked out.
 */
export function BranchPicker({
  workIn,
  repo,
  name,
  base,
  worktree,
  onBase,
  onWorktree,
  held,
}: {
  workIn: WorkIn;
  repo: RepoState;
  /** The project's name. */
  name: string;
  /** The base picked here; null: the checked-out branch. */
  base: string | null;
  worktree: string | null;
  onBase: (branch: string) => void;
  onWorktree: (path: string) => void;
  held?: HTMLElement;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const list = useId();
  const popup = useRef<HTMLDivElement>(null);
  const { info, error, loading } = repo;
  const existing = workIn === "existing";
  const local = workIn === "local";
  const picked = existing ? worktree : (base ?? info?.current ?? null);
  const rows = !info
    ? []
    : existing
      ? info.worktrees.map(({ path, branch }) => ({ key: path, label: folderName(path), detail: branch ?? "No branch" })).toSorted((a, b) => a.label.localeCompare(b.label))
      : info.branches
          .map((each) => ({ key: each, label: each, detail: undefined }))
          .toSorted((a, b) => Number(b.key === info.current) - Number(a.key === info.current) || a.key.localeCompare(b.key));
  const needle = query.trim().toLowerCase();
  const matches = rows.filter((row) => `${row.label} ${row.detail ?? ""}`.toLowerCase().includes(needle));
  const highlighted = Math.min(at, matches.length - 1);
  const pick = (key: string) => {
    if (existing) onWorktree(key);
    else onBase(key);
    setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // From the menu itself or its search; a focused row's own Enter stays its own.
    if (event.target !== event.currentTarget && !(event.target instanceof HTMLInputElement)) return;
    if (matches.length === 0) return;
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step) {
      event.preventDefault();
      setAt((highlighted + step + matches.length) % matches.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(matches[highlighted]!.key);
    }
  };
  const label = local ? (info?.current ?? (loading ? "…" : "No branch")) : existing ? (picked ? folderName(picked) : "Pick a worktree") : (picked ?? (loading ? "…" : "Pick a branch"));
  const kind = existing ? "worktrees" : "branches";
  return (
    <Popover
      open={held ? true : open}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery("");
        setAt(0);
        if (next) repo.refresh();
      }}
    >
      <PopoverTrigger
        render={
          <ComposerPill
            aria-label={local ? `Branch: ${label}` : existing ? `Worktree: ${label}` : `Base branch: ${label}`}
            title={local ? "The branch your checkout has: the session works on it" : existing ? "Which worktree should this session work in?" : "What branch should this session start from?"}
            className={RAIL_PILL}
          />
        }
      >
        {existing ? <Folder /> : <Branch />}
        <span className="truncate">{label}</span>
      </PopoverTrigger>
      {local ? (
        <PopoverContent side="top" align="start" container={held} collisionAvoidance={held ? STILL : undefined} initialFocus={held ? false : undefined} className="w-72 max-w-full">
          <p className="px-2 py-1 text-sm text-muted-foreground">
            {info?.current ? `The session works in ${name} on ${info.current}, the branch it has checked out.` : `${name} isn't on a branch. Check one out to work there.`}
          </p>
        </PopoverContent>
      ) : (
        <PopoverContent ref={popup} side="top" align="start" container={held} collisionAvoidance={held ? STILL : undefined} initialFocus={held ? false : popup} onKeyDown={onKeyDown} className="w-80 max-w-full">
          <PickerSearch
            list={list}
            label={`Search ${name} ${kind}`}
            value={query}
            onChange={(next) => {
              setQuery(next);
              setAt(0);
            }}
          />
          <p className="px-2 py-1 text-sm text-muted-foreground">{existing ? "Worktrees" : "Local branches"}</p>
          <div id={list} role="listbox" aria-label={existing ? "Worktrees" : "Branches"} className="h-command-list overflow-y-auto">
            {error && <ErrorLine error={`${existing ? "Worktrees" : "Branches"} unavailable: ${error}`} className="px-2 py-1 text-xs" />}
            {!info && !error && <p className="px-2 py-1 text-sm text-muted-foreground">Reading the repository…</p>}
            {info && matches.length === 0 && <p className="px-2 py-1 text-sm text-muted-foreground">{existing ? "No other worktrees" : "No branches found"}</p>}
            {matches.map((row, index) => (
              <button
                key={row.key}
                type="button"
                role="option"
                aria-selected={row.key === picked}
                data-highlighted={index === highlighted || undefined}
                title={existing ? row.key : undefined}
                onPointerMove={() => setAt(index)}
                onClick={() => pick(row.key)}
                className={cx(itemClasses, "w-full text-start")}
              >
                <MenuRow twoLine={existing} icon={existing ? <Folder /> : <Branch />} title={row.label} detail={row.detail} hint={row.key === picked && <Check aria-hidden />} />
              </button>
            ))}
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
}
