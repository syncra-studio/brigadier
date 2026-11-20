import { type MouseEvent, useEffect, useRef, useState } from "react";

import { Button } from "../components/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../components/context-menu";
import { cx } from "../components/cx";
import { Dialog, DialogContent } from "../components/dialog";
import { EmptyState } from "../components/empty-state";
import { ErrorLine } from "../components/error-line";
import { SettingsCard } from "../components/settings-card";
import { Skeleton } from "../components/skeleton";
import { showToast } from "../components/toast";
import { ask, useDaemon } from "../daemon";
import { Branch, Chats, Folder, Trash, Unarchive } from "../icons";
import { errorText, run } from "../onboarding/api";
import { useArchiveSplit } from "../sessions/archive";
import { type Check, DeleteForm, readDelete } from "../sessions/archived";
import { DeleteManyForm } from "./archived-delete";
import { type ArchivedFilter, KindMenu, MoreMenu, ProjectMenu, SearchField } from "./archived-toolbar";
import { SettingsPage } from "./parts";

/** The Archived page's rows, for Settings search. */
export const ARCHIVED_ROWS = {
  archived: { label: "Archived sessions and chats", description: "Hidden from the sidebar; restore one to continue it" },
} as const;

/** One archived session as Rust's `archived` op gives it; the groups come filtered, sorted and grouped. */
type ArchivedRow = { id: string; title: string; project: string | null; archived: number; updated: number; created: number | null; backend: string };
type Group = { key: string; label: string; rows: ArchivedRow[] };
type Reply = { groups: Group[]; projects: { value: string; label: string }[]; narrowed: boolean; total: number };

/** How long typing settles before Rust is asked again. */
const TYPING_MS = 150;
const titleOf = (row: { title: string }) => row.title || "New session";
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const countOf = (group: Group) => {
  const noun = group.key === "chats" ? "chat" : "session";
  return `${group.rows.length} ${noun}${group.rows.length === 1 ? "" : "s"}`;
};

/**
 * Archived sessions and chats, the old app's page [D191, D2014]: a search and two menus (kind and order,
 * project) over the list, grouped by project, chats last; Rust does the filtering. Each row opens on its
 * title and has Unarchive and Delete. ⌘-click and Shift-click pick rows for Unarchive (N) and Delete (N)…;
 * Delete all… is in the toolbar's "…" menu.
 */
export function ArchivedPage() {
  const { daemon, rows, projects } = useDaemon();
  const online = Boolean(daemon);
  const [typed, setTyped] = useState("");
  const [filter, setFilter] = useState<ArchivedFilter>({ query: "", kind: "all", project: "all", order: "updated" });
  const [reply, setReply] = useState<Reply>();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [restoring, setRestoring] = useState<ReadonlySet<string>>(new Set());
  const [picked, setPicked] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const [asking, setAsking] = useState<{ rows: ArchivedRow[]; checks: Check[] } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setFilter((now) => (now.query === typed ? now : { ...now, query: typed })), TYPING_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  // Asked again whenever an archived session changes in Rust's rows; the last answer stays meanwhile.
  const changed = (rows ?? [])
    .filter((row) => row.archived || row.lifecycle)
    .map((row) => `${row.id} ${row.title} ${row.archived} ${row.lifecycle?.op} ${row.lifecycle?.left?.length}`)
    .join("\n");
  useEffect(() => {
    if (!online) return;
    let live = true;
    ask({ op: "archived", ...filter }, (frame) => {
      if (!live) return;
      if (!frame.ok) return frame.error !== "disconnected" && setError(frame.message ?? frame.error);
      const next = frame as unknown as Reply;
      setReply(next);
      setError(null);
      const there = new Set(next.groups.flatMap((group) => group.rows.map((row) => row.id)));
      setRestoring((now) => new Set([...now].filter((id) => there.has(id))));
    });
    return () => {
      live = false;
    };
  }, [online, filter, changed, attempt]);

  // A delete under way hides its row, as the sidebar does.
  const split = useArchiveSplit(rows);
  const showing = new Set([...(split.live ?? []), ...split.archived].map((row) => row.id));
  const byId = new Map((rows ?? []).map((row) => [row.id, row]));
  const groups = (reply?.groups ?? [])
    .map((group) => ({ ...group, rows: group.rows.filter((row) => !byId.has(row.id) || showing.has(row.id)) }))
    .filter((group) => group.rows.length > 0);
  const shown = groups.flatMap((group) => group.rows);
  const order = shown.map((row) => row.id);
  const pick = shown.filter((row) => picked.includes(row.id));
  const pending = (id: string) => restoring.has(id) || byId.get(id)?.lifecycle?.op === "restore";

  // A title's click opens it; with ⌘ it toggles the pick, with Shift it picks the range from the last one clicked.
  const onTitle = (id: string, event: MouseEvent) => {
    if (event.metaKey) {
      setPicked(pick.some((row) => row.id === id) ? picked.filter((each) => each !== id) : [...picked, id]);
      anchor.current = id;
    } else if (event.shiftKey) {
      const to = order.indexOf(id);
      const from = anchor.current && order.includes(anchor.current) ? order.indexOf(anchor.current) : to;
      setPicked(order.slice(Math.min(from, to), Math.max(from, to) + 1));
    } else {
      setPicked([]);
      anchor.current = id;
      window.location.hash = `#thread/${encodeURIComponent(id)}`;
    }
  };

  const unarchive = (targets: ArchivedRow[]) => {
    setPicked([]);
    setRestoring((now) => new Set([...now, ...targets.map((row) => row.id)]));
    for (const row of targets) {
      run(["restore", row.id]).catch((cause) => {
        setRestoring((now) => new Set([...now].filter((id) => id !== row.id)));
        const why = errorText(cause);
        showToast(`Couldn't bring back “${titleOf(row)}”: ${why === "disconnected" ? "Brigadier isn't running" : why}`, { tone: "error" });
      });
    }
  };
  // Delete stays off for a folder chat, archived or not [D3102].
  const folders = new Set(projects?.filter((each) => each.kind === "folder").map((each) => each.id));
  const deletable = (targets: ArchivedRow[]) => targets.filter((row) => !folders.has(row.project ?? ""));
  const askDelete = (all: ArchivedRow[]) => {
    const targets = deletable(all);
    if (targets.length === 0) return;
    setPicked([]);
    // Each check read first: the confirm opens whole [D463]. A later click's answer replaces it, keyed, so no choice carries over.
    void Promise.all(targets.map((row) => readDelete(row.id))).then((checks) => setAsking({ rows: targets, checks }));
  };
  const one = asking?.rows.length === 1 ? byId.get(asking.rows[0]!.id) : undefined;
  const project = reply?.projects.some((choice) => choice.value === filter.project) ? filter.project : "all";
  const retry = () => setAttempt(attempt + 1);

  return (
    <SettingsPage title="Archived">
      <div className={cx("flex flex-col", !online && "opacity-disabled")}>
        {!reply ? (
          error ? (
            <SettingsCard>
              <div className="px-4 py-3">
                <ErrorLine error={`Couldn't load the archived sessions: ${error}`} actions={<RetryButton onClick={retry} />} />
              </div>
            </SettingsCard>
          ) : (
            <SettingsCard>
              {[0, 1, 2].map((n) => (
                <div key={n} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton className="size-icon-md" />
                  <Skeleton className="h-4 flex-1" />
                </div>
              ))}
            </SettingsCard>
          )
        ) : (
          <>
            {/* The toolbar stays in view over the list; the groups follow it. */}
            {reply.total > 0 && (
              <div className="sticky top-0 z-10 -mt-5 flex flex-col gap-3 bg-background pt-5 pb-2">
                <div className="flex items-center gap-2">
                  <SearchField label="Search archived chats" value={typed} onChange={setTyped} />
                  <KindMenu filter={filter} onChange={(next) => setFilter((now) => ({ ...now, ...next }))} />
                  <ProjectMenu value={project} choices={reply.projects} onChange={(next) => setFilter((now) => ({ ...now, project: next }))} />
                  <MoreMenu count={deletable(shown).length} narrowed={reply.narrowed} onDeleteAll={() => askDelete(shown)} />
                </div>
                {pick.length > 0 && (
                  <div role="toolbar" aria-label="Picked chats" className="flex items-center gap-2">
                    <span className="flex-1 text-label text-quiet-foreground">{pick.length} picked</span>
                    <Button variant="soft" size="sm" onClick={() => setPicked([])}>
                      Clear
                    </Button>
                    <Button variant="soft" size="sm" disabled={!online} onClick={() => unarchive(pick)}>
                      Unarchive ({pick.length})
                    </Button>
                    {deletable(pick).length > 0 && (
                      <Button variant="soft-destructive" size="sm" disabled={!online} onClick={() => askDelete(pick)}>
                        Delete ({deletable(pick).length})…
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
            {error && <ErrorLine error={`Couldn't load the archived sessions: ${error}`} actions={<RetryButton onClick={retry} />} />}

            {shown.length === 0 && <EmptyState variant="centered" title={reply.total === 0 ? "No archived sessions or chats" : "No archived chats match"} />}

            <div className="flex flex-col gap-10 pt-5">
              {groups.map((group) => (
                <section key={group.key} aria-label={group.label} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-4 pb-1.5">
                    <h2 className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
                      {group.key === "chats" ? <Chats aria-hidden className="size-icon-md shrink-0" /> : <Folder aria-hidden className="size-icon-md shrink-0" />}
                      <span className="truncate">{group.label}</span>
                    </h2>
                    <span className="shrink-0 text-label text-quiet-foreground">{countOf(group)}</span>
                  </div>
                  <SettingsCard>
                    {group.rows.map((row) => {
                      const selected = pick.some((each) => each.id === row.id);
                      return (
                        <ArchivedRowItem
                          key={row.id}
                          row={row}
                          picked={selected}
                          // A right-click acts on every picked row when it is one of them.
                          targets={selected ? pick : [row]}
                          deletes={deletable(selected ? pick : [row]).length}
                          pending={pending(row.id)}
                          offline={!online}
                          onTitle={onTitle}
                          onMenu={() => !selected && setPicked([])}
                          onUnarchive={unarchive}
                          onDelete={askDelete}
                        />
                      );
                    })}
                  </SettingsCard>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
      <Dialog open={asking !== null} onOpenChange={(next) => !next && setAsking(null)}>
        <DialogContent showCloseButton={false}>
          {one ? <DeleteForm key={one.id} row={one} first={asking!.checks[0]!} onClose={() => setAsking(null)} /> : asking && asking.rows.length > 0 && <DeleteManyForm key={asking.rows.map((row) => row.id).join()} rows={asking.rows} first={asking.checks} onClose={() => setAsking(null)} />}
        </DialogContent>
      </Dialog>
    </SettingsPage>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="link-blue" size="inline" onClick={onClick}>
      Try again
    </Button>
  );
}

/** One archived session: what it is, its title (which opens it) and date, its two actions. */
function ArchivedRowItem({
  row,
  picked,
  targets,
  deletes,
  pending,
  offline,
  onTitle,
  onMenu,
  onUnarchive,
  onDelete,
}: {
  row: ArchivedRow;
  picked: boolean;
  targets: ArchivedRow[];
  /** How many of `targets` can be deleted: a folder chat can't [D3102]. */
  deletes: number;
  pending: boolean;
  offline: boolean;
  onTitle: (id: string, event: MouseEvent) => void;
  onMenu: () => void;
  onUnarchive: (rows: ArchivedRow[]) => void;
  onDelete: (rows: ArchivedRow[]) => void;
}) {
  const Icon = row.project !== null ? Branch : Chats;
  const off = pending || offline;
  return (
    <ContextMenu onOpenChange={(open) => open && onMenu()}>
      <ContextMenuTrigger
        render={<div data-slot="archived-row" data-picked={picked || undefined} className={cx("flex items-center gap-6 px-4 py-3 data-picked:bg-picked-row", pending && "opacity-disabled")} />}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Icon aria-label={row.project !== null ? "Session" : "Chat"} className="size-icon-md shrink-0 text-quiet-foreground" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <button
              type="button"
              className="max-w-full cursor-pointer truncate rounded-control text-start text-label font-medium text-link hover:underline focus-visible:focus-ring"
              onClick={(event) => onTitle(row.id, event)}
            >
              {titleOf(row)}
            </button>
            <span className="text-xs text-quiet-foreground">{pending ? "Restoring it and its worktree…" : dateTime.format(row.updated)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="soft" size="sm" disabled={off} onClick={() => onUnarchive([row])}>
            {pending ? "Restoring…" : "Unarchive"}
          </Button>
          {deletes > 0 && (
            <Button variant="soft-destructive" size="sm" disabled={off} aria-label={`Delete “${titleOf(row)}”…`} onClick={() => onDelete([row])}>
              Delete
            </Button>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={off} onClick={() => onUnarchive(targets)}>
          <Unarchive />
          {targets.length > 1 ? `Unarchive (${targets.length})` : "Unarchive"}
        </ContextMenuItem>
        {deletes > 0 && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" disabled={off} onClick={() => onDelete(targets)}>
              <Trash />
              {deletes > 1 ? `Delete (${deletes})…` : "Delete…"}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
