import { type ReactNode, useEffect, useState } from "react";

import { Button } from "../components/button";
import { ConfirmForm } from "../components/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { Radio, RadioGroup } from "../components/radio";
import { showToast } from "../components/toast";
import { ask, useDaemon } from "../daemon";
import { Branch, Chats, Folder, Spinner } from "../icons";
import { errorText, run, store } from "../onboarding/api";
import { shortPath } from "./add-project";
import { type Project, useProjects } from "./projects";

/*
 * Remove project… [D172, D179, D181], the old app's dialog: Rust's preview of what goes, one question per
 * branch with work that never landed, refused while a session works. Each session goes through 1v's
 * delete; the repository itself stays. Mounted inside ProjectSettingsHost (PROPOSED), so main.tsx is untouched.
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
};
type Look = { state: "looking" } | { state: "failed"; error: string } | { state: "ready"; preview: Preview };
/** form; removing (its reply due); watching (no reply coming: the connection dropped, or another run holds it); removed with kept branches. */
type Phase = { at: "form" } | { at: "removing" } | { at: "watching" } | { at: "removed"; repo: string; kept: string[] };
/** The gallery's frozen states. */
export type Given = { look: Look; phase?: Phase; error?: string };

const opened = store<string | null>(null);
/** Opens Remove project… from the project's menu [D171, D212]. */
export const openRemoveProject = (id: string) => opened.set(id);

export function RemoveProjectHost() {
  const id = opened.use();
  const live = useProjects()?.find((each) => each.id === id && !each.pending);
  // Kept once the record is gone, for the Removed screen.
  const [last, setLast] = useState<Project | null>(null);
  if (live && live !== last) setLast(live);
  const project = live ?? (last?.id === id ? last : null);
  const close = () => opened.set(null);
  return (
    <Dialog open={project !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent showCloseButton={false} frame="project-dialog max-w-project-dialog gap-5 p-6">
        {project && <RemoveFlow key={project.id} project={project} onClose={close} />}
      </DialogContent>
    </Dialog>
  );
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const MB = 1024 * 1024;
const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < MB ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 * MB ? `${(bytes / MB).toFixed(1)} MB` : `${(bytes / (1024 * MB)).toFixed(1)} GB`;

export function RemoveFlow({ project, onClose, given }: { project: Project; onClose: () => void; given?: Given }) {
  const [look, setLook] = useState<Look>(given?.look ?? { state: "looking" });
  const [phase, setPhase] = useState<Phase>(given?.phase ?? { at: "form" });
  const [error, setError] = useState<string | null>(given?.error ?? null);
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
    if (given || phase.at !== "form") return;
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
  }, [project.id, attempt, given, phase.at, sessionStates]);

  // No reply is coming: Rust's list, by id, says how it ended once the daemon is back [D30, D40].
  useEffect(() => {
    if (given || phase.at !== "watching" || !daemon || !projects) return;
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
      <Waiting title={`Remove “${project.name}”?`} spin onClose={onClose}>
        {daemon ? `Removing “${project.name}”…` : `Lost the connection while removing “${project.name}”. Checking again when it's back.`}
      </Waiting>
    );
  }
  if (look.state !== "ready") {
    return (
      <Waiting title={`Remove “${project.name}”?`} spin={look.state === "looking"} onClose={onClose}>
        {look.state === "looking" ? (
          `Looking at what “${project.name}” has…`
        ) : (
          <span className="flex items-center gap-2">
            <ErrorLine error={`Couldn't look at what it has: ${look.error}`} />
            <Button variant="ghost" size="sm" onClick={() => setAttempt(attempt + 1)}>
              Retry
            </Button>
          </span>
        )}
      </Waiting>
    );
  }

  const { preview } = look;
  const sessions = preview.sessions.length;
  const anything = sessions > 0 || preview.worktrees > 0 || preview.merged > 0;
  const working = preview.working.map((id) => `“${titleOf(id)}”`);
  const one = working.length === 1;
  const blocked = working.length ? `${working.join(", ")} ${one ? "is" : "are"} working. Stop ${one ? "it" : "them"} or let ${one ? "it" : "them"} finish first.` : null;
  return (
    <ConfirmForm
      title={`Remove “${project.name}”?`}
      description={`The repository at ${shortPath(project.folder)} stays exactly as it is.${anything ? " Only what Brigadier made for this project is deleted:" : ""}`}
      confirm={phase.at === "removing" ? "Removing…" : "Remove"}
      destructive
      busy={phase.at === "removing"}
      disabled={blocked !== null}
      onConfirm={confirm}
      onCancel={onClose}
    >
      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto">
        {anything && (
          <ul aria-label="What is deleted" className="flex flex-col divide-y divide-divider rounded-surface bg-fill-subtle">
            {sessions > 0 && <SummaryRow icon={<Chats />} label={plural(sessions, "session", "sessions")} detail="Can't be undone" />}
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
        {preview.worktrees > 0 && <p className="text-xs leading-4.25 text-muted-foreground">Uncommitted changes in a worktree are saved as a commit on its branch first.</p>}
        {preview.branches.map(({ id, branch }) => (
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
      </div>
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

/** Looking, or waiting on how a removal ended: its line and Cancel. */
function Waiting({ title, spin, children, onClose }: { title: string; spin: boolean; children: ReactNode; onClose: () => void }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription render={<div />}>{children}</DialogDescription>
      </DialogHeader>
      {spin && <Spinner className="size-icon-sm animate-spin motion-reduce:animate-none" />}
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
              <code tabIndex={0} className="overflow-x-auto text-xs leading-4.25 whitespace-nowrap text-muted-foreground outline-none select-text focus-visible:focus-ring">{`git -C ${repo} branch -D ${branch}`}</code>
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
