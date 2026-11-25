import { type ReactNode, useEffect, useState } from "react";

import { Button } from "../components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { ConfirmForm } from "../components/confirm-dialog";
import { CopyButton } from "../components/copy-button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { named } from "../components/thread/rewind";
import { showToast } from "../components/toast";
import { ask, useDaemon } from "../daemon";
import { Branch, Chats, ChevronRightAlt, Folder, StickyNote, Spinner } from "../icons";
import { errorText, run, store } from "../onboarding/api";
import type { ArchiveCheck } from "../sessions/archive";
import { shortPath } from "./add-project";
import { type Project, useProjects } from "./projects";

/*
 * Remove project… [D172, D179, D181]: Rust's preview of what goes, refused while a session works. Each
 * session goes through 1v's delete; branches with work that never landed are kept, then the summary offers
 * to delete them at once, with Undo. The repository itself stays. Mounted beside the sidebar in main.tsx, opened from the project's menu and settings.
 */

/** `projects remove <id> --check`'s answer (PROPOSED shape). */
export type Preview = {
  sessions: string[];
  working: string[];
  worktrees: number;
  bytes: number;
  merged: number;
  branches: { id: string; branch: string }[];
  removing?: boolean;
  /** Its notes, which go with it [D920]. */
  notes?: number;
  /** Per worktree it frees, the ignored files deleted for good, as archive's [D179, D1197]. */
  lost?: ArchiveCheck["lost"];
};
type Look = { state: "looking" } | { state: "failed"; error: string } | { state: "ready"; preview: Preview };
/** form; removing (its reply due); watching (no reply coming: the connection dropped, or another run holds it); removed with kept branches. */
type Phase = { at: "form" } | { at: "removing" } | { at: "watching" } | { at: "removed"; repo: string; kept: string[]; preview: Preview | null };

const opened = store<{ id: string; look: Look } | null>(null);
const read = (id: string): Promise<Look> =>
  run(["projects", "remove", id, "--check"]).then(
    (reply) => ({ state: "ready", preview: reply as Preview }),
    (cause) => ({ state: "failed", error: errorText(cause) }),
  );
let early: { id: string; look: Promise<Look> } | null = null;
/** Starts Rust's preview as the project's menu opens, so it's usually in by the click [D463]. */
export const readRemoval = (id: string) => void (early = { id, look: read(id) });
/** Opens Remove project… from the project's menu once the preview is read: it opens whole, never growing after [D171, D212, D463]. */
export const openRemoveProject = (id: string) => {
  const look = early?.id === id ? early.look : read(id);
  early = null;
  return look.then((look) => opened.set({ id, look }));
};

export function RemoveProjectHost() {
  const asked = opened.use();
  const id = asked?.id ?? null;
  const live = useProjects()?.find((each) => each.id === id && !each.pending);
  // Kept once the record is gone, for the Removed screen.
  const [last, setLast] = useState<Project | null>(null);
  if (live && live !== last) setLast(live);
  const project = live ?? (last?.id === id ? last : null);
  const close = () => opened.set(null);
  return (
    <Dialog open={project !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent showCloseButton={false} frame="project-dialog max-w-project-dialog gap-5 p-6">
        {project && asked && <RemoveFlow key={project.id} project={project} first={asked.look} onClose={close} />}
      </DialogContent>
    </Dialog>
  );
}

export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const MB = 1024 * 1024;
const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < MB ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 * MB ? `${(bytes / MB).toFixed(1)} MB` : `${(bytes / (1024 * MB)).toFixed(1)} GB`;

export function RemoveFlow({ project, first, onClose }: { project: Project; first: Look; onClose: () => void }) {
  const [look, setLook] = useState<Look>(first);
  const [phase, setPhase] = useState<Phase>({ at: first.state === "ready" && first.preview.removing ? "watching" : "form" });
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { daemon, rows, projects } = useDaemon();
  const sessionStates = JSON.stringify(rows?.filter((row) => row.project === project.id).map((row) => [row.id, row.state, row.mark, row.archived, row.lifecycle]));
  const titleOf = (id: string) => rows?.find((row) => row.id === id)?.title || "New session";
  const done = () => {
    onClose();
    showToast(`Removed “${project.name}”`);
  };

  useEffect(() => {
    if (phase.at !== "form") return;
    let current = true;
    setLook((last) => last.state === "ready" ? last : { state: "looking" });
    run(["projects", "remove", project.id, "--check"]).then(
      (reply) => {
        if (!current) return;
        setLook({ state: "ready", preview: reply as Preview });
        if (reply.removing) setPhase({ at: "watching" });
      },
      (cause) => current && setLook({ state: "failed", error: errorText(cause) }),
    );
    return () => {
      current = false;
    };
  }, [project.id, attempt, phase.at, sessionStates]);

  // No reply is coming: Rust's list, by id, says how it ended once the daemon is back [D30, D40].
  useEffect(() => {
    if (phase.at !== "watching" || !daemon || !projects) return;
    const record = projects.find((each) => each.id === project.id);
    if (!record) return done();
    if (record.removing) return;
    setPhase({ at: "form" });
    setAttempt((n) => n + 1);
  }, [phase.at, daemon, projects]);

  const confirm = () => {
    setPhase({ at: "removing" });
    setError(null);
    const facts = look.state === "ready" ? look.preview : null;
    ask({ op: "run", args: ["projects", "remove", project.id] }, (reply) => {
      if (reply.ok) {
        const kept: string[] = reply.kept_branches ?? [];
        return kept.length ? setPhase({ at: "removed", repo: reply.repo, kept, preview: facts }) : done();
      }
      if (reply.error === "disconnected") return setPhase({ at: "watching" });
      setPhase({ at: "form" });
      setError(reply.left ? `Not everything went, so “${project.name}” stays: ${reply.left.join(" · ")}` : (reply.message ?? reply.error ?? "it failed"));
      setAttempt((n) => n + 1);
    });
  };

  if (phase.at === "removed") return <Removed name={project.name} repo={phase.repo} kept={phase.kept} preview={phase.preview} onClose={onClose} />;
  if (phase.at === "watching") {
    return (
      <Waiting title={`Remove “${project.name}”?`} onClose={onClose}>
        {daemon ? `Removing “${project.name}”…` : `Lost the connection while removing “${project.name}”. Checking again when it's back.`}
      </Waiting>
    );
  }
  // One view from the start: the facts open into it, and Remove waits for them [D391].
  const preview = look.state === "ready" ? look.preview : null;
  const sessions = preview?.sessions.length ?? 0;
  const notes = preview?.notes ?? 0;
  const anything = sessions > 0 || notes > 0 || (preview?.worktrees ?? 0) > 0 || (preview?.merged ?? 0) > 0;
  const working = (preview?.working ?? []).map((id) => `“${titleOf(id)}”`);
  const one = working.length === 1;
  const blocked = working.length ? `${working.join(", ")} ${one ? "is" : "are"} working. Stop ${one ? "it" : "them"} or let ${one ? "it" : "them"} finish first.` : null;
  return (
    <ConfirmForm
      title={`Remove “${project.name}”?`}
      description={`The repository at ${shortPath(project.folder)} stays exactly as it is.`}
      confirm={phase.at === "removing" ? "Removing…" : "Remove"}
      destructive
      busy={phase.at === "removing"}
      disabled={preview === null || blocked !== null}
      onConfirm={confirm}
      onCancel={onClose}
    >
      <Collapsible open={look.state !== "looking"} className="scroll-gutter -mx-6 min-h-0 overflow-y-auto ps-6 pe-3.5">
        <CollapsibleContent className="flex flex-col gap-5">
        {look.state === "failed" && (
          <span className="flex items-center gap-2">
            <ErrorLine error={`Couldn't look at what it has: ${look.error}`} />
            <Button variant="ghost" size="sm" onClick={() => setAttempt(attempt + 1)}>
              Retry
            </Button>
          </span>
        )}
        {anything && <p className="text-sm text-muted-foreground">Only what Brigadier made for this project is deleted:</p>}
        {preview && anything && (
          <ul aria-label="What is deleted" className="flex flex-col divide-y divide-divider rounded-surface bg-fill-subtle">
            {sessions > 0 && <SummaryRow icon={<Chats />} label={plural(sessions, "session", "sessions")} detail="Can't be undone" />}
            {notes > 0 && <SummaryRow icon={<StickyNote />} label={plural(notes, "note", "notes")} detail="With their chats" />}
            {preview.worktrees > 0 && <SummaryRow icon={<Folder />} label={plural(preview.worktrees, "worktree", "worktrees")} detail={formatBytes(preview.bytes)} />}
            {preview.merged > 0 && (
              <SummaryRow
                icon={<Branch />}
                label={plural(preview.merged, "merged branch", "merged branches")}
                detail="Already landed"
              />
            )}
          </ul>
        )}
        {preview && preview.worktrees > 0 && <p className="text-xs leading-4.25 text-muted-foreground">Uncommitted changes in a worktree are saved as a commit on its branch first.</p>}
        {preview?.lost?.map((each) =>
          each.files ? (
            <p key={each.ids.join()} className="text-xs break-words text-muted-foreground">
              {each.ids.map((id) => `“${titleOf(id)}”`).join(", ")} loses its ignored files for good: <span className="text-foreground">{named(each.files)}</span>.
            </p>
          ) : (
            <ErrorLine key={each.ids.join()} error={`${each.ids.map((id) => `“${titleOf(id)}”`).join(", ")}: its ignored files couldn't be listed: ${each.error}`} />
          ),
        )}
        {preview && preview.branches.length > 0 && (
          <p className="text-xs leading-4.25 text-muted-foreground">
            {plural(preview.branches.length, "branch has", "branches have")} work that never landed: kept, with it. You can delete them after.
          </p>
        )}
        <ErrorLine error={blocked} />
        <div role="alert">
          <ErrorLine error={error} />
        </div>
        </CollapsibleContent>
      </Collapsible>
    </ConfirmForm>
  );
}

/** One row of what goes: its icon, what it is, and a quiet note on the right. */
function SummaryRow({ icon, label, detail }: { icon: ReactNode; label: string; detail: string }) {
  return (
    <li className="flex h-11 items-center gap-3 px-3.5">
      <span className="flex shrink-0 text-muted-foreground svg:size-icon-md">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
      <span className="shrink-0 text-label text-muted-foreground">{detail}</span>
    </li>
  );
}

/** Waiting on how a removal ended: its line and Cancel. */
function Waiting({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription render={<div />}>{children}</DialogDescription>
      </DialogHeader>
      <Spinner className="size-icon-sm animate-spin motion-reduce:animate-none" />
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </DialogFooter>
    </>
  );
}

/** A path or name as one word for the shell. */
const shellWord = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/**
 * Kept branches by repository: a folder chat's come as `<repo> <branch>`, its repo under the project's folder
 * (branch names have no spaces, so the last one splits them); a session's are the project's own repo's.
 */
function byRepo(folder: string, kept: string[]): Map<string, string[]> {
  const repos = new Map<string, string[]>();
  for (const each of new Set(kept)) {
    const cut = each.lastIndexOf(" ");
    const repo = cut < 0 ? folder : `${folder}/${each.slice(0, cut)}`;
    repos.set(repo, [...(repos.get(repo) ?? []), each.slice(cut + 1)]);
  }
  return repos;
}

/** Removed with branches kept: what went, the kept ones by name, one command, and one action that deletes them all. */
export function Removed({ name, repo, kept, preview, onClose }: { name: string; repo: string; kept: string[]; preview: Preview | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repos = byRepo(repo, kept);
  const count = [...repos.values()].flat().length;
  const command = [...repos].map(([at, branches]) => `git -C ${shellWord(at)} branch -D ${branches.join(" ")}`).join(" && ");
  const sessions = preview?.sessions.length ?? 0;
  const notes = preview?.notes ?? 0;
  // A session's branch the preview counted as merged but that got work before Remove was kept instead.
  const expected = new Set(preview?.branches.map(({ branch }) => branch));
  const merged = Math.max(0, (preview?.merged ?? 0) - kept.filter((each) => !each.includes(" ") && !expected.has(each)).length);
  const drop = () => {
    setBusy(true);
    setError(null);
    Promise.all([...repos].map(([at, branches]) => run(["projects", "drop-branches", at, ...branches]).then((reply) => ({ at, gone: (reply.branches ?? {}) as Record<string, string>, failed: (reply.failed ?? []) as string[] })))).then(
      (each) => {
        // Closed first, so the toasts and their Undo sit above everything.
        onClose();
        const failed = each.flatMap(({ failed }) => failed);
        const count = each.reduce((sum, { gone }) => sum + Object.keys(gone).length, 0);
        if (count) {
          const undo = () =>
            Promise.all(each.map(({ at, gone }) => (Object.keys(gone).length ? run(["projects", "put-branches", at, ...Object.entries(gone).map(([branch, commit]) => `${branch}=${commit}`)]) : { failed: [] }))).then(
              (replies) => {
                const missed: string[] = replies.flatMap((reply) => reply.failed ?? []);
                if (missed.length) showToast(`Couldn't put back every branch: ${missed.join(" · ")}`, { tone: "error", stays: true });
                else showToast(`Put back ${plural(count, "branch", "branches")}`);
              },
              (cause) => showToast(`Couldn't put the branches back: ${errorText(cause)}`, { tone: "error", stays: true }),
            );
          showToast(`Deleted ${plural(count, "branch", "branches")}`, { actions: [{ label: "Undo", run: () => void undo() }] });
        }
        if (failed.length) showToast(`Kept ${plural(failed.length, "branch", "branches")}: ${failed.join(" · ")}`, { tone: "error", stays: true });
      },
      (cause) => {
        setError(errorText(cause));
        setBusy(false);
      },
    );
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>“{name}” was removed</DialogTitle>
        <DialogDescription>Its repository was not touched.</DialogDescription>
      </DialogHeader>
      {/* The card never scrolls, its body does: many branches never push the buttons out [D389]. */}
      <div className="scroll-gutter -mx-6 flex min-h-0 flex-col gap-5 overflow-y-auto ps-6 pe-3.5">
        <ul aria-label="What was removed" className="flex flex-col divide-y divide-divider rounded-surface bg-fill-subtle">
          {(sessions > 0 || notes > 0) && (
            <SummaryRow
              icon={<Chats />}
              label={[sessions > 0 && plural(sessions, "session", "sessions"), notes > 0 && plural(notes, "note", "notes")].filter(Boolean).join(", ")}
              detail="Deleted"
            />
          )}
          {(preview?.worktrees ?? 0) > 0 && <SummaryRow icon={<Folder />} label={plural(preview!.worktrees, "worktree", "worktrees")} detail={`${formatBytes(preview!.bytes)} freed`} />}
          {merged > 0 && <SummaryRow icon={<Branch />} label={plural(merged, "merged branch", "merged branches")} detail="Deleted" />}
          <li>
            <Collapsible>
              <CollapsibleTrigger className="group flex h-11 w-full cursor-pointer items-center gap-3 px-3.5 text-start focus-visible:focus-ring">
                <span className="flex shrink-0 text-muted-foreground svg:size-icon-md">
                  <Branch />
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground">{plural(count, "branch kept", "branches kept")}</span>
                <span className="shrink-0 text-label text-muted-foreground">Unmerged work</span>
                <ChevronRightAlt className="size-icon-xs! shrink-0 text-muted-foreground chevron-motion group-aria-expanded:rotate-90" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                {/* About four rows, then it scrolls. */}
                <ul aria-label="Kept branches" className="scroll-gutter flex max-h-25 flex-col gap-1 overflow-y-auto ps-10.5 pe-3.5 pb-3">
                  {[...repos].flatMap(([at, branches]) => branches.map((branch) => (at === repo ? branch : `${at.slice(repo.length + 1)}: ${branch}`))).map((branch) => (
                    <li key={branch} className="shrink-0 truncate font-mono text-xs leading-5 text-muted-foreground select-text">
                      {branch}
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          </li>
        </ul>
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">Or delete them yourself later:</p>
          <div className="flex min-w-0 items-center gap-1 rounded-control bg-fill-subtle ps-3 pe-1">
            <code className="min-w-0 flex-1 overflow-x-auto py-2 font-mono text-xs whitespace-nowrap text-muted-foreground select-text">{command}</code>
            <CopyButton text={command} tooltip="Copy command" size="icon-sm" variant="ghost" />
          </div>
        </div>
        <div role="alert">
          <ErrorLine error={error} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="soft-destructive" disabled={busy} onClick={drop}>
          {busy && <Spinner className="size-icon-xs animate-spin motion-reduce:animate-none" />}
          Delete {plural(count, "kept branch", "kept branches")}
        </Button>
        <Button disabled={busy} onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
