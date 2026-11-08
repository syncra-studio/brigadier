import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { CheckboxMark } from "../components/checkbox";
import { cx } from "../components/cx";
import { useDaemon } from "../daemon";
import { ErrorLine } from "../components/error-line";
import { FolderOpen, Spinner } from "../icons";
import { errorText, pickRepo, run, setProfile, useProfile } from "./api";
import { PILL, RAISED_BUTTON, StepFooter, StepHeader } from "./parts";

const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
/** A home-relative path for display (`~/Development/app`), as the old app showed it. */
const shortPath = (path: string) => path.replace(/^(\/Users|\/home)\/[^/]+(?=\/|$)/, "~");

/**
 * The projects to start with [D45]: the repositories the agents' own history ran in, none ticked
 * to begin with, and any folder added with Add folder…, which must be in a git repository. Adding
 * them finishes the setup; with none ticked it finishes without projects. A picked folder joins
 * the cards ticked, as the old app had it, and is added with the rest at the finish.
 */
export function ProjectsStep({ onBack }: { onBack: () => void }) {
  const { daemon } = useDaemon();
  const added = useProfile().value?.projects ?? [];
  const [found, setFound] = useState<string[] | null>(null);
  // Folders picked with Add folder…, which the history count leaves out.
  const [byHand, setByHand] = useState<readonly string[]>([]);
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

  const history = (found ?? []).filter((path) => !added.includes(path));
  const addable = [...byHand.filter((path) => !added.includes(path)), ...history];
  const chosen = addable.filter((path) => selected.has(path));
  const allChosen = addable.length > 0 && chosen.length === addable.length;
  const toggle = (path: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  // A folder outside a repository is said right away.
  const addFolder = async () => {
    setError(null);
    setBusy("picking");
    try {
      const repo = await pickRepo();
      if (!repo || added.includes(repo)) return;
      if (!found?.includes(repo)) setByHand((list) => (list.includes(repo) ? list : [repo, ...list]));
      setSelected((current) => new Set(current).add(repo));
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
    if (failed.length) setError(`Some projects could not be added.\n${failed.join("\n")}`);
    // Not shown early: done leaves onboarding, and undoing that would restart it at the agents step.
    else await setProfile(["--done"], {}).catch((cause) => setError(errorText(cause)));
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
            <div className="flex items-center gap-2 px-1 text-label text-setup-hint">
              {history.length > 0 && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />}
              <span>Found in your history</span>
              {found && <span className="tabular-nums">{history.length}</span>}
            </div>
            <div className="ms-auto flex items-center gap-1">
              {addable.length > 0 && (
                // Words alone, as the old app drew them: hovered they brighten, with no pill behind them.
                <Button
                  variant={null}
                  size={null}
                  disabled={busy !== null}
                  onClick={() => setSelected(allChosen ? new Set() : new Set(addable))}
                  className={cx(PILL, "grid px-2.5 text-muted-foreground enabled:hover:text-foreground")}
                >
                  {/* Both labels hold the room, so the button never moves as it switches. */}
                  <span className="col-start-1 row-start-1">{allChosen ? "Select none" : "Select all"}</span>
                  <span aria-hidden className="invisible col-start-1 row-start-1">
                    Select none
                  </span>
                </Button>
              )}
              <Button variant={null} size={null} disabled={busy !== null || !online || !window.brigadier} onClick={() => void addFolder()} className={RAISED_BUTTON}>
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
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
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
                          "flex h-full w-full min-w-0 flex-col gap-1 rounded-settings border border-border bg-card p-4 text-start transition-colors cursor-pointer enabled:hover:bg-setup-card-hover disabled:cursor-not-allowed",
                          isAdded && "opacity-row-disabled",
                        )}
                      >
                        <span className="flex w-full min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">{baseName(path)}</span>
                          <CheckboxMark checked={on} />
                        </span>
                        <span title={path} className="w-full truncate font-mono text-xs text-setup-hint">
                          {shortPath(path)}
                        </span>
                        {isAdded && <span className="truncate pt-2.5 text-xs text-setup-hint">Already added</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <ErrorLine error={error} />
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
