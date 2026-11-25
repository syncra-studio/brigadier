import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { ConfirmForm } from "../components/confirm-dialog";
import { Dialog, DialogContent } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { DropdownMenuItem } from "../components/menu";
import { EmptyState } from "../components/empty-state";
import { NavList, NavSection } from "../components/nav";
import { Radio, RadioGroup } from "../components/radio";
import { showToast } from "../components/toast";
import { ask, useDaemon } from "../daemon";
import { Archive, Trash, Unarchive } from "../icons";
import { errorText, run, store } from "../onboarding/api";
import type { Project } from "../sidebar/words";
import { restore } from "../sidebar/actions";
import { ArchivedActions } from "../sidebar/flyout";
import { SessionRowItem } from "../sidebar/row";
import { useStored } from "../sidebar/sidebar";
import type { SessionRow } from "../sidebar/words";
import { type ArchiveCheck, hideDeleting, LostLine } from "./archive";

/*
 * The docked Archived section, below the list [D191, D198]: folded at first, shown once something is
 * archived. Its rows open read-only; their menu has Restore and Delete, as every live row's menu has Delete [D3101].
 */

const titleOf = (row: { title: string }) => row.title || "New session";

export function ArchivedSection({
  rows,
  projects,
  active,
  offline,
  onOpen,
  storeKey = "sidebar",
}: {
  rows: SessionRow[];
  projects: Project[];
  active: string | null;
  offline: boolean;
  onOpen: (id: string) => void;
  storeKey?: string;
}) {
  const [open, setOpen] = useStored(`${storeKey}.archived`, false);
  const projectOf = new Map(projects.map((project) => [project.id, project]));
  if (rows.length === 0) return null;
  return (
    <div className="flex max-h-2/5 min-h-0 shrink-0 flex-col px-2 pt-1 pb-2">
      <NavSection
        title="Archived"
        open={open}
        onOpenChange={setOpen}
        scrollList
        steadyChevron
        steadyActions
        actions={
          <ArchivedActions count={rows.length} />
        }
      >
        <NavList className="gap-1">
          {rows.map((row) => (
            <SessionRowItem
              key={row.id}
              row={row.lifecycle?.left ? { ...row, mark: "amber" } : row}
              project={row.project === null ? undefined : projectOf.get(row.project)}
              active={row.id === active}
              offline={offline}
              badged
              onOpen={onOpen}
              onRename={() => {}}
              menu={<ClosedMenuItems row={row} />}
            />
          ))}
        </NavList>
      </NavSection>
    </div>
  );
}

/** An archived row's menu, or one a delete left unfinished: what stayed, Restore, and Delete again [D35]. */
export function ClosedMenuItems({ row }: { row: SessionRow }) {
  const left = row.lifecycle?.left;
  return (
    <>
      {left && (
        <DropdownMenuItem disabled className="max-w-80 whitespace-normal">
          Couldn't delete everything: {left[0]}
        </DropdownMenuItem>
      )}
      {row.archived && (
        <DropdownMenuItem onClick={() => restore(row)}>
          <Unarchive />
          Restore
        </DropdownMenuItem>
      )}
      <DeleteMenuItem row={row} />
    </>
  );
}

const deleting = store<{ rows: Deleted[]; check: Check } | null>(null);
/** Opens delete's confirm once Rust's check is in, so it opens whole [D463]. */
const askDelete = (row: Deleted) => void readDelete([row]).then((check) => deleting.set({ rows: [row], check }));

export function DeleteMenuItem({ row }: { row: SessionRow }) {
  return (
    <DropdownMenuItem variant="destructive" onClick={() => askDelete(row)}>
      <Trash />
      Delete
    </DropdownMenuItem>
  );
}

/** Where delete's confirm shows, mounted once by the sidebar, for every row menu's Delete [D3101]. */
export function DeleteAsk() {
  const asking = deleting.use();
  return (
    <Dialog open={asking !== null} onOpenChange={(next) => !next && deleting.set(null)}>
      <DialogContent showCloseButton={false}>{asking && <DeleteForm key={asking.rows[0]!.id} rows={asking.rows} first={asking.check} onClose={() => deleting.set(null)} />}</DialogContent>
    </Dialog>
  );
}

type Deleted = { id: string; title: string };
/** `running`, `lost`: as archive's, its workers' too [D1197, D3017]. `repo`: a folder chat's claim's, else "". */
export type Check =
  | { state: "checking" }
  | ({
      state: "done";
      /** With work that never landed, each kept unless asked [D181]. */
      branches: Ahead[];
      /** With such work too, but delete leaves them whatever is picked, and why [D703]. */
      kept: { repo: string; branch: string; why: "pr" | "shared" }[];
      /** Folders another session still works in, which stay [D1080]. */
      stays: { id: string; repo: string; by: string }[];
    } & ArchiveCheck)
  | { state: "failed"; error: string };
type Ahead = { id: string; title: string; repo: string; branch: string };

/** Rust's delete check, read before its confirm opens, so the confirm opens whole and never grows after [D463]. */
export const readDelete = (rows: Deleted[]): Promise<Check> =>
  run(["delete", ...rows.map((row) => row.id), "--check"]).then(
    (reply) => ({ state: "done", branches: reply.branches, kept: reply.kept, stays: reply.stays, running: reply.running, lost: reply.lost }),
    (cause) => ({ state: "failed", error: errorText(cause) }),
  );

/**
 * Delete's confirm, for one session or several [D35, D181]: a branch with work that never landed is named, kept
 * unless asked, a folder chat's by repo [D494]. Delete waits for Rust's check; Rust checks again as it runs. Each
 * row leaves at once and comes back if it fails.
 */
export function DeleteForm({ rows, first, onClose }: { rows: Deleted[]; first: Check; onClose: () => void }) {
  const [check, setCheck] = useState<Check>(first);
  const all = useDaemon().rows;
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  const [attempt, setAttempt] = useState(0);
  // Read again on Retry; the first read came with it.
  useEffect(() => {
    if (!attempt) return;
    let live = true;
    setCheck({ state: "checking" });
    void readDelete(rows).then((next) => live && setCheck(next));
    return () => {
      live = false;
    };
  }, [rows, attempt]);
  const one = rows.length === 1 ? rows[0]! : null;
  const many = `${rows.length} sessions`;
  const done = check.state === "done" ? check : null;
  const repos = Map.groupBy(done?.branches ?? [], (each) => each.repo);
  const confirm = () => {
    onClose();
    const chosen = [...repos.keys()].filter((repo) => dropped.has(repo));
    const perRepo = chosen.length > 0 && [...repos.keys()].some((repo) => repo);
    const choice = perRepo ? chosen.flatMap((repo) => ["--delete-in", repo]) : ["--branch", chosen.length ? "delete" : "keep"];
    for (const row of rows) {
      hideDeleting(row.id, true);
      ask({ op: "run", args: ["delete", row.id, ...choice] }, (reply) => {
        if (reply.ok) return;
        hideDeleting(row.id, false);
        const why = reply.left?.[0] ?? (reply.error === "disconnected" ? "Brigadier isn't running" : (reply.message ?? reply.error ?? "it failed"));
        showToast(`Couldn't delete “${titleOf(row)}”: ${why}`, { tone: "error" });
      });
    }
  };
  const called = (id: string) => [...rows, ...(all ?? [])].find((each) => each.id === id)?.title || "another session";
  const whose = (ids: string[]) => (one ? "" : `${ids.map((id) => `“${called(id)}”`).join(", ")}: `);
  return (
    <ConfirmForm
      title={one ? "Delete session?" : `Delete ${many}?`}
      description={`This permanently deletes ${one ? `“${titleOf(one)}”` : many}. This can't be undone.`}
      confirm={one ? "Delete session" : `Delete ${many}`}
      destructive
      disabled={!done}
      onConfirm={confirm}
      onCancel={onClose}
    >
      {check.state === "checking" && <p className="text-xs text-muted-foreground">{one ? "Checking its branch…" : "Checking their branches…"}</p>}
      {check.state === "failed" && (
        <div className="flex items-center gap-2">
          <ErrorLine error={`Couldn't check ${one ? "its branch" : "their branches"}: ${check.error}`} />
          <Button variant="ghost" size="sm" onClick={() => setAttempt(attempt + 1)}>
            Retry
          </Button>
        </div>
      )}
      {done && done.running.length > 0 && (
        <p className="text-xs text-muted-foreground">{one ? "Its agent is working and will be stopped." : `${done.running.map((id) => `“${called(id)}”`).join(", ")}: working, and will be stopped.`}</p>
      )}
      {done?.lost.map((each, at) => <LostLine key={at} lost={each} whose={whose(each.ids)} />)}
      {done?.stays.map(({ id, repo, by }) => (
        <p key={`${id} ${repo}`} className="text-xs text-muted-foreground">
          {whose([id])}Its {repo ? <>copy of <code className="font-mono text-foreground">{repo}</code></> : "folder"} stays: {called(by)} still works there.
        </p>
      ))}
      {done && done.kept.length > 0 && (
        <div className="flex flex-col gap-1 text-xs break-words text-muted-foreground">
          {[...new Map(done.kept.map((each) => [`${each.repo} ${each.branch}`, each]))].map(([key, { repo, branch, why }]) => (
            <p key={key}>
              <code className="font-mono text-foreground">{branch}</code>
              {repo && ` in ${repo}`} stays either way: {why === "pr" ? "it's a pull request's branch." : "another session uses it."}
            </p>
          ))}
        </div>
      )}
      {[...repos].map(([repo, branches]) => (
        <BranchChoice
          key={repo}
          repo={repo}
          branches={branches}
          own={one !== null && repo === "" && branches.length === 1 && branches[0]!.id === one.id}
          drop={dropped.has(repo)}
          setDrop={(drop) => setDropped((now) => new Set(drop ? [...now, repo] : [...now].filter((each) => each !== repo)))}
        />
      ))}
    </ConfirmForm>
  );
}

/** One repository's branches with work that never landed, its workers' too: one choice for all. */
function BranchChoice({ repo, branches, own, drop, setDrop }: { repo: string; branches: Ahead[]; own: boolean; drop: boolean; setDrop: (drop: boolean) => void }) {
  const lone = branches.length === 1;
  return (
    <div className="flex flex-col gap-2.5">
      {own ? (
        <p className="text-xs text-muted-foreground">
          Its branch <code className="font-mono text-foreground">{branches[0]!.branch}</code> has work that never landed.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {repo && <>In <code className="font-mono text-foreground">{repo}</code>, </>}
            {repo ? "t" : "T"}{lone ? "his branch has" : "hese branches have"} work that never landed:
          </p>
          <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
            {branches.map(({ id, branch, title }) => (
              <li key={id} className="truncate">
                <code className="font-mono text-foreground">{branch}</code> · {title || "New session"}
              </li>
            ))}
          </ul>
        </>
      )}
      <RadioGroup value={drop ? "delete" : "keep"} onValueChange={(value) => setDrop(value === "delete")} className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <Radio value="keep" />
          {lone ? "Keep branch" : "Keep branches"}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Radio value="delete" />
          {lone ? "Delete it too" : "Delete them too"}
        </label>
      </RadioGroup>
    </div>
  );
}

/**
 * An archived session in its thread's place (D487): what it is, and Restore, which brings back its worktree too
 * [D180]; restoring, then the thread itself once Rust's row says it's back, or why it couldn't.
 */
export function ArchivedPage({ row }: { row: SessionRow }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = busy || row.lifecycle?.op === "restore";
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6">
      <EmptyState
        variant="centered"
        icon={Archive}
        title="This conversation is archived"
        detail={pending ? "Restoring it and its worktree…" : "Restore it to read it and go on."}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          setBusy(true);
          setError(null);
          run(["restore", row.id]).then(
            () => setBusy(false),
            (cause) => {
              setBusy(false);
              setError(errorText(cause));
            },
          );
        }}
      >
        {pending ? "Restoring…" : "Restore"}
      </Button>
      <div role="alert">
        <ErrorLine error={error && `Couldn’t restore it: ${error}`} />
      </div>
    </div>
  );
}
