import { type ReactNode, useEffect, useState } from "react";

import { Button } from "../components/button";
import { CheckboxRow } from "../components/checkbox-row";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { ConfirmForm } from "../components/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { Radio, RadioGroup } from "../components/radio";
import { named } from "../components/thread/rewind";
import { showToast } from "../components/toast";
import { ask, useDaemon } from "../daemon";
import { Branch, Chats, ChevronRightAlt, Folder, StickyNote, Spinner } from "../icons";
import { errorText, run, store } from "../onboarding/api";
import type { ArchiveCheck } from "../sessions/archive";
import { shortPath } from "./add-project";
import { type Project, useProjects } from "./projects";

/*
 * Remove project… [D172, D179, D181], the old app's dialog: Rust's preview of what goes, one question per
 * branch with work that never landed, refused while a session works. Each session goes through 1v's
 * delete; the repository itself stays. Mounted beside the sidebar in main.tsx, opened from Settings on the project page.
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
type Phase = { at: "form" } | { at: "removing" } | { at: "watching" } | { at: "removed"; repo: string; kept: string[] };

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
  void look.then((look) => opened.set({ id, look }));
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
  const [drops, setDrops] = useState<ReadonlySet<string>>(new Set());
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
    const drop = [...drops];
    ask({ op: "run", args: ["projects", "remove", project.id, ...(drop.length ? ["--drop", drop.join(",")] : [])] }, (reply) => {
      if (reply.ok) {
        const kept: string[] = reply.kept_branches ?? [];
        return kept.length ? setPhase({ at: "removed", repo: reply.repo, kept }) : done();
      }
      if (reply.error === "disconnected") return setPhase({ at: "watching" });
      setPhase({ at: "form" });
      setError(reply.left ? `Not everything went, so “${project.name}” stays: ${reply.left.join(" · ")}` : (reply.message ?? reply.error ?? "it failed"));
      setAttempt((n) => n + 1);
    });
  };

  if (phase.at === "removed") return <Removed name={project.name} repo={phase.repo} kept={phase.kept} onClose={onClose} />;
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
                detail={preview.branches.length ? "Already landed" : "Unmerged ones stay"}
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
        {preview && preview.branches.length > 1 && <ManyBranches branches={preview.branches} titleOf={titleOf} drops={drops} onDrops={setDrops} />}
        {preview?.branches.length === 1 && preview.branches.map(({ id, branch }) => (
          <div key={id} className="flex flex-col gap-2.5">
            <p className="text-xs text-muted-foreground">
              “{titleOf(id)}”: its branch <code className="font-mono text-foreground">{branch}</code> has work that never landed.
            </p>
            <RadioGroup
              value={drops.has(id) ? "delete" : "keep"}
              onValueChange={(value) => setDrops((last) => (value === "delete" ? new Set(last).add(id) : new Set([...last].filter((each) => each !== id))))}
              className="flex gap-4"
            >
              <label className="flex items-center gap-2 text-sm">
                <Radio value="keep" />
                Keep branch
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Radio value="delete" />
                Delete it too
              </label>
            </RadioGroup>
          </div>
        ))}
        <ErrorLine error={blocked} />
        <div role="alert">
          <ErrorLine error={error} />
        </div>
        </CollapsibleContent>
      </Collapsible>
    </ConfirmForm>
  );
}

/** Several branches with work that never landed: all kept unless reviewed, instead of one question each [D181]. */
function ManyBranches({ branches, titleOf, drops, onDrops }: { branches: Preview["branches"]; titleOf: (id: string) => string; drops: ReadonlySet<string>; onDrops: (next: ReadonlySet<string>) => void }) {
  const dropped = branches.filter(({ id }) => drops.has(id)).length;
  const toggle = (id: string, on: boolean) => {
    const next = new Set(drops);
    if (on) next.add(id);
    else next.delete(id);
    onDrops(next);
  };
  const all = dropped === branches.length;
  const fate = all ? "All of them will be deleted." : dropped > 0 ? `${dropped} will be deleted, the rest kept.` : "All of them are kept.";
  return (
    <Collapsible className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-xs text-muted-foreground">
          {/* Each on its own line, so a longer outcome can't wrap and move the rows below. */}
          <span className="block">{branches.length} branches have work that never landed.</span>
          <span className="block">{fate}</span>
        </p>
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="group shrink-0" />}>
          Review {branches.length} branches
          <ChevronRightAlt className="size-icon-xs! chevron-motion group-aria-expanded:rotate-90" />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="flex flex-col gap-2">
          <div className="border-b border-divider pb-2">
            <CheckboxRow label={`Delete all ${branches.length} branches too`} checked={all} indeterminate={dropped > 0 && !all} onCheckedChange={() => onDrops(new Set(all ? [] : branches.map(({ id }) => id)))} />
          </div>
          {branches.map(({ id, branch }) => (
            <CheckboxRow key={id} label={`Delete ${branch} too`} note={`“${titleOf(id)}”`} checked={drops.has(id)} onCheckedChange={(on) => toggle(id, on)} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
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

/** Removed, with the branches it kept and the command that deletes each, as the old app said it. */
export function Removed({ name, repo, kept, onClose }: { name: string; repo: string; kept: string[]; onClose: () => void }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>“{name}” was removed</DialogTitle>
        <DialogDescription>Its repository was not touched.</DialogDescription>
      </DialogHeader>
      <section aria-labelledby="removed-kept" className="flex min-h-0 min-w-0 flex-col gap-1.5 overflow-y-auto">
        <h3 id="removed-kept" className="text-label font-medium text-foreground">
          Branches kept with unmerged work
        </h3>
        <ul className="flex flex-col gap-2 text-sm">
          {kept.map((branch) => (
            <li key={branch} className="flex min-w-0 flex-col gap-0.5">
              <span className="leading-4.25">{branch}</span>
              <code className="text-xs leading-4.25 wrap-anywhere text-muted-foreground select-text">{`git -C ${repo} branch -D ${branch}`}</code>
            </li>
          ))}
        </ul>
      </section>
      <DialogFooter>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </>
  );
}
