import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { Input } from "../components/input";
import { showToast } from "../components/toast";
import { ArrowLeft, Check, Folder, FolderOpen, Link, Plus, Spinner } from "../icons";
import { errorText } from "../onboarding/api";
import { CloneView, NewRepoView, useAdd } from "./clone";
import { newProjectId } from "./projects";
import { useDaemon } from "../daemon";
import { closeAddProject, daemonSource, DEFAULT_PARENT, type FolderCheck, type Repo, showProject, type Source, useAddProject } from "./store";

/*
 * Add project, the old app's dialog [D165]: pick a git repository found on this Mac (or choose a
 * folder), clone one from a URL or from your GitHub repositories, or start a new one.
 */

/** The card's own width and layout: the views pad themselves. */
export const ADD_PROJECT_FRAME = "project-dialog max-w-add-project gap-0 p-0";

/** Mounted once; opened by `openAddProject` from anywhere. `offline` while the daemon is away. */
export function AddProjectDialog({ source, offline }: { source: Source; offline: boolean }) {
  const { open, path, opening } = useAddProject();
  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeAddProject()}>
      <DialogContent frame={ADD_PROJECT_FRAME}>{open && <AddProject key={opening} source={source} offline={offline} initialPath={path} />}</DialogContent>
    </Dialog>
  );
}

/** The app's Add project, on the daemon. */
export function AddProjectHost() {
  return <AddProjectDialog source={daemonSource} offline={useDaemon().daemon === null} />;
}

/** The view open, and for the gallery the state it starts in. */
export type View =
  | { kind: "pick" }
  | { kind: "clone"; url?: string; cloning?: boolean; error?: string }
  | { kind: "new"; parent: string; name: string; error?: string };

export function AddProject({
  source,
  offline,
  initialPath = "",
  start = { kind: "pick" },
}: {
  source: Source;
  offline: boolean;
  initialPath?: string;
  start?: View;
}) {
  const [view, setView] = useState<View>(start);
  // The repositories found, kept for the list's return from Clone or New repository.
  const found = useRef<Repo[] | null>(null);
  const back = () => setView({ kind: "pick" });
  switch (view.kind) {
    case "pick":
      return (
        <PickView
          source={source}
          offline={offline}
          initialPath={initialPath}
          found={found}
          onClone={() => setView({ kind: "clone" })}
          onNew={(parent = DEFAULT_PARENT, name = "") => setView({ kind: "new", parent, name })}
        />
      );
    case "clone":
      return <CloneView source={source} offline={offline} start={view} onBack={back} />;
    case "new":
      return <NewRepoView source={source} offline={offline} start={view} onBack={back} />;
  }
}

// ----- the parts the views share -----

/** A home-relative path for display (`~/Development/app`), as the old app showed it. */
export const shortPath = (path: string) => path.replace(/^(\/Users|\/home)\/[^/]+(?=\/|$)/, "~");

/** The folder a path ends in, and the folder it is in ("~/code/" and "app" for ~/code/app). */
function splitPath(path: string): { parent: string; name: string } {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/") + 1;
  return { parent: trimmed.slice(0, cut), name: trimmed.slice(cut) };
}

/** The title and its line; with `onBack`, a back arrow before them. The kit's ✕ sits in the corner. */
export function Header({ title, line, onBack }: { title: string; line: string; onBack?: () => void }) {
  return (
    <div className={cx("flex shrink-0 gap-3.5 pt-6 pe-12 pb-5", onBack ? "ps-6" : "ps-7")}>
      {onBack && (
        <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={onBack}>
          <ArrowLeft />
        </Button>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{line}</DialogDescription>
      </div>
    </div>
  );
}

/** The bar along the bottom: `start` on the left, Cancel and the main button on the right. */
export function Footer({ start, children }: { start?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-divider pt-3.75 pe-6 pb-4 ps-5">
      <div className="flex min-w-0 flex-1 items-center gap-1">{start}</div>
      {children}
    </div>
  );
}

export function CancelButton({ label = "Cancel" }: { label?: string }) {
  return <DialogClose render={<Button variant="ghost" size="sm" />}>{label}</DialogClose>;
}

/** While the daemon is away, what's in flight stays in flight and says why it waits [D30]. */
export function OfflineLine({ offline }: { offline: boolean }) {
  return offline ? <p className="text-xs text-muted-foreground">Daemon not reachable · reconnecting…</p> : null;
}

// ----- Pick -----

function PickView({
  source,
  offline,
  initialPath,
  found,
  onClone,
  onNew,
}: {
  source: Source;
  offline: boolean;
  initialPath: string;
  found: RefObject<Repo[] | null>;
  onClone: () => void;
  onNew: (parent?: string, name?: string) => void;
}) {
  const [repos, setRepos] = useState<Repo[] | null>(found.current);
  // A folder chosen (or opened with ⌘O), first in the list.
  const [chosen, setChosen] = useState<Repo | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A folder git starts in.
  const adding = useAdd();
  const busy = adding.running !== null;

  // Asked again on reconnect, until it answers.
  useEffect(() => {
    if (found.current || offline) return;
    let live = true;
    source.find().then(
      (list) => {
        found.current = list;
        if (live) setRepos(list);
      },
      (cause: unknown) => {
        if (live && errorText(cause) !== "disconnected") {
          setRepos([]);
          setError(errorText(cause));
        }
      },
    );
    return () => {
      live = false;
    };
  }, [found, source, offline]);

  /** Puts a checked folder at the top of the list and picks it; a project shows itself. */
  const apply = (check: FolderCheck) => {
    setError(null);
    switch (check.kind) {
      case "repo":
        if (check.project_id) {
          closeAddProject();
          showProject(check.project_id);
          return;
        }
        setChosen({ path: check.repo, name: check.name, project_id: null });
        setSelected(check.repo);
        return;
      case "plain":
        setChosen({ path: check.path, name: check.name, project_id: null, plain: true });
        setSelected(check.path);
        return;
      case "missing": {
        const { parent, name } = splitPath(shortPath(check.path));
        onNew(parent, name);
        return;
      }
      case "invalid":
        setError(check.reason);
    }
  };
  const take = (path: string) => source.check(path).then(apply, (cause: unknown) => setError(errorText(cause)));

  // The folder the dialog opened on (one ⌘O found in no repository).
  const takeInitial = useEffectEvent(take);
  useEffect(() => {
    if (initialPath) void takeInitial(initialPath);
  }, [initialPath]);

  const rows = useMemo(() => {
    const all = [...(chosen ? [chosen] : []), ...(repos ?? []).filter((repo) => repo.path !== chosen?.path)];
    const words = query.trim().toLowerCase();
    if (!words) return all;
    return all.filter((row) => row.name.toLowerCase().includes(words) || shortPath(row.path).toLowerCase().includes(words));
  }, [chosen, repos, query]);
  const pickable = rows.filter((row) => !row.project_id);
  // The row picked, else the first that can be.
  const current = pickable.find((row) => row.path === selected) ?? pickable[0] ?? null;

  // A repository shows at once as pending in the sidebar [D30]; a plain folder waits here for git init.
  const add = (row: Repo | null = current) => {
    if (!row || busy) return;
    setError(null);
    if (row.plain) return void adding.start(row.path, (id) => source.add(id, row.path, "here"));
    const id = newProjectId();
    closeAddProject();
    showProject(id);
    // Failed, the pending row goes and a toast says why; a lost daemon leaves it pending [D30].
    source.add(id, row.path).catch((cause: unknown) => {
      if (errorText(cause) !== "disconnected") showToast(`Could not add ${row.name}: ${errorText(cause)}`, { tone: "error" });
    });
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      add();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (pickable.length === 0) return;
      const at = current ? pickable.indexOf(current) : -1;
      const next = event.key === "ArrowDown" ? Math.min(at + 1, pickable.length - 1) : Math.max(at - 1, 0);
      setSelected(pickable[next]!.path);
    }
  };

  const choose = () => {
    setError(null);
    source.pick().then((picked) => (picked ? take(picked) : undefined), (cause: unknown) => setError(errorText(cause)));
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <Header title="Add project" line="Pick a git repository for your sessions to work in." />
      <div className="flex shrink-0 items-center gap-2.5 px-7">
        <Input aria-label="Search repositories" placeholder="Search repositories" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} onKeyDown={onSearchKey} />
        <Button variant="outline" onClick={choose}>
          <FolderOpen />
          Choose folder…
        </Button>
      </div>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-4 pt-5.5 pb-4">
        <div className="flex shrink-0 items-center justify-between px-3 text-xs text-muted-foreground">
          <span>On this Mac</span>
          <span>Most recent first</span>
        </div>
        {/* While the scan runs the list holds its five rows' room. */}
        <div role="radiogroup" aria-label="On this Mac" className={cx("scroll-gutter -me-2.5 flex max-h-add-project-list flex-col gap-0.5 overflow-y-auto", repos === null && "min-h-add-project-list")}>
          {rows.map((row) => (
            <RepoRow key={row.path} row={row} chosen={row === current} onPick={() => setSelected(row.path)} onAdd={() => add(row)} />
          ))}
          {rows.length === 0 && (
            <p className="flex h-14.5 items-center px-3 text-sm text-muted-foreground">
              {repos === null
                ? offline
                  ? "Daemon not reachable · reconnecting…"
                  : "Looking for repositories…"
                : query.trim()
                  ? "No repository matches."
                  : "No git repositories found. Choose a folder, or clone or start one."}
            </p>
          )}
        </div>
        <ErrorLine error={error ?? adding.error} className="px-3" />
        <OfflineLine offline={offline && busy} />
      </div>
      <Footer
        start={
          <>
            <Button variant="ghost" size="sm" onClick={onClone}>
              <Link />
              Clone from URL
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onNew()}>
              <Plus />
              New repository
            </Button>
          </>
        }
      >
        <CancelButton />
        <Button size="sm" className="min-w-0 max-w-1/3" disabled={!current || busy} onClick={() => add()}>
          {busy && <Spinner className="animate-spin" />}
          <span className="truncate" title={current ? `Add ${current.name}` : undefined}>{current ? `Add ${current.name}` : "Add project"}</span>
        </Button>
      </Footer>
    </div>
  );
}

/** A repository in the list: its folder tile, name, path, "Not a repository" or Added, and its radio. */
function RepoRow({ row, chosen, onPick, onAdd }: { row: Repo; chosen: boolean; onPick: () => void; onAdd: () => void }) {
  const added = row.project_id !== null;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={chosen}
      disabled={added}
      tabIndex={chosen ? 0 : -1}
      onClick={onPick}
      onDoubleClick={onAdd}
      className={cx(
        "flex h-14.5 w-full shrink-0 cursor-pointer items-center gap-3 rounded-surface border px-3 text-start outline-none focus-visible:focus-ring disabled:cursor-not-allowed",
        chosen ? "border-border bg-fill" : "border-transparent hover:bg-fill-subtle",
        added && "opacity-row-disabled",
      )}
    >
      <span className="flex size-8.5 shrink-0 items-center justify-center rounded-control bg-fill">
        <Folder className={cx("size-icon-md", chosen ? "text-foreground" : "text-muted-foreground")} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.75">
        <span className="truncate text-sm font-medium" title={row.name}>{row.name}</span>
        <span className="truncate font-mono text-xs text-muted-foreground" title={row.path}>{shortPath(row.path)}</span>
      </span>
      {added ? (
        <Badge variant="secondary">
          <Check />
          Added
        </Badge>
      ) : (
        row.plain && <span className="shrink-0 text-xs text-muted-foreground">Not a repository</span>
      )}
      <span aria-hidden className={cx("flex size-4.5 shrink-0 items-center justify-center rounded-capsule", chosen ? "bg-toggle-on text-foreground" : "border border-input")}>
        {chosen && <Check className="size-icon-xs" />}
      </span>
    </button>
  );
}
