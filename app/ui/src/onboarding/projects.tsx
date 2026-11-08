import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { CheckboxMark } from "../components/checkbox";
import { cx } from "../components/cx";
import { useDaemon } from "../daemon";
import { Spinner } from "../icons";
import { errorText, run, setProfile, useProfile } from "./api";
import { FolderOpen } from "./icons";
import { PILL_BUTTON, RAISED_BUTTON, StepFooter, StepHeader } from "./parts";

declare global {
  interface Window {
    /** The one thing main does for the page beyond supervising: the native folder picker (preload.ts). */
    brigadier?: { pickFolder(): Promise<string | null> };
  }
}

const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

/**
 * The projects to start with [D45]: the repositories the agents' own history ran in, none ticked
 * to begin with, and any folder added with Add folder…, which must be in a git repository. Adding
 * them finishes the setup; with none ticked it finishes without projects.
 */
export function ProjectsStep({ onBack }: { onBack: () => void }) {
  const { daemon } = useDaemon();
  const added = useProfile().value?.projects ?? [];
  const [found, setFound] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"adding" | "picking" | null>(null);
  const online = Boolean(daemon);

  useEffect(() => {
    if (!online || found) return;
    let live = true;
    run(["projects"]).then(
      (reply) => live && setFound(reply.found),
      (cause) => {
        if (!live) return;
        setFound([]);
        setError(errorText(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [online, found]);

  const addable = (found ?? []).filter((path) => !added.includes(path));
  const chosen = addable.filter((path) => selected.has(path));
  const allChosen = addable.length > 0 && chosen.length === addable.length;
  const toggle = (path: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  // A picked folder is added at once, so a folder outside a repository is said right away.
  const addFolder = async () => {
    setError(null);
    setBusy("picking");
    try {
      const picked = await window.brigadier?.pickFolder();
      if (picked) await setProfile(["--add", picked], {});
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const finish = async () => {
    setBusy("adding");
    setError(null);
    const failed: string[] = [];
    for (const path of chosen) {
      await setProfile(["--add", path], { projects: [...added, path] }).catch((cause) => failed.push(`${baseName(path)}: ${errorText(cause)}`));
    }
    if (failed.length === 0) await setProfile(["--done"], { onboarded: true }).catch((cause) => failed.push(errorText(cause)));
    if (failed.length) setError(`Some projects could not be added.\n${failed.join("\n")}`);
    setBusy(null);
  };

  const cards = [...added, ...addable];
  const count = chosen.length;
  return (
    <div className="onboarding-step flex min-h-0 flex-1 flex-col">
      <StepHeader title="Choose your projects" description="Pick the projects you want to work on." />
      <div className="mt-12 flex min-h-0 flex-1 flex-col gap-3">
        <div className="shrink-0 px-6">
          <div className="mx-auto flex w-full max-w-onboarding flex-wrap items-center gap-x-1 gap-y-2">
            <div className="flex items-center gap-2 px-1 text-label text-quiet-foreground">
              {addable.length > 0 && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />}
              <span>Found in your history</span>
              {found && <span className="tabular-nums">{addable.length}</span>}
            </div>
            <div className="ms-auto flex items-center gap-1">
              {addable.length > 0 && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setSelected(allChosen ? new Set() : new Set(addable))}
                  className={cx(PILL_BUTTON, "grid items-center px-2.5 font-medium text-muted-foreground transition-colors enabled:hover:text-foreground disabled:opacity-disabled")}
                >
                  {/* Both labels hold the room, so the button never moves as it switches. */}
                  <span className="col-start-1 row-start-1">{allChosen ? "Select none" : "Select all"}</span>
                  <span aria-hidden className="invisible col-start-1 row-start-1">
                    Select none
                  </span>
                </button>
              )}
              <Button size="sm" variant="outline" disabled={busy !== null || !online || !window.brigadier} onClick={() => void addFolder()} className={cx(RAISED_BUTTON, "gap-1.75")}>
                {busy === "picking" ? <Spinner className="size-3.25 animate-spin" /> : <FolderOpen className="size-3.25" />}
                Add folder…
              </Button>
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <div className="mx-auto flex w-full max-w-onboarding flex-col gap-3">
            {!online && <p className="text-sm text-muted-foreground">Daemon not reachable · reconnecting…</p>}
            {found === null ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-sm text-muted-foreground">
                <Spinner className="size-icon-md animate-spin" />
                Looking for projects in your history…
              </div>
            ) : cards.length === 0 ? (
              <p className="rounded-settings border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
                No repositories found in your history. Add a folder to start with one.
              </p>
            ) : (
              <ul className="onboarding-project-grid">
                {cards.map((path) => {
                  const isAdded = added.includes(path);
                  const on = isAdded || selected.has(path);
                  return (
                    <li key={path} className="min-w-0">
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        aria-label={baseName(path)}
                        disabled={busy !== null || isAdded}
                        onClick={() => toggle(path)}
                        className={cx(
                          "flex h-full w-full min-w-0 flex-col gap-1 rounded-settings border border-border bg-card p-4 text-start transition-colors enabled:hover:bg-fill-hover disabled:cursor-default",
                          isAdded && "opacity-disabled",
                        )}
                      >
                        <span className="flex w-full min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">{baseName(path)}</span>
                          <CheckboxMark checked={on} />
                        </span>
                        <span title={path} className="w-full truncate font-mono text-xs text-quiet-foreground">
                          {path}
                        </span>
                        {isAdded && <span className="pt-2.5 text-xs text-quiet-foreground">Added</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {error && (
              <p role="alert" className="text-xs whitespace-pre-wrap text-destructive">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
      <StepFooter
        onBack={onBack}
        count={`${count} of ${addable.length} selected`}
        primary={{
          label: busy === "adding" ? "Adding…" : count === 0 ? (added.length ? "Finish" : "Continue without projects") : `Add ${count} ${count === 1 ? "project" : "projects"}`,
          onClick: () => void finish(),
          disabled: !online,
          busy: busy === "adding",
        }}
      />
    </div>
  );
}
