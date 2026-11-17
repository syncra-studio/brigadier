import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { CheckboxMark } from "../components/checkbox";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { Segmented } from "../components/segmented";
import { FolderOpen, Spinner } from "../icons";
import { cloneUrl, folderFromUrl, folderProblem } from "../projects/clone";
import { addProject, newProjectId, useProjects } from "../projects/projects";
import { DEFAULT_PARENT, type Source } from "../projects/store";
import { errorText, pickRepo, setProfile } from "./api";
import { PILL, RAISED_BUTTON, StepFooter, StepHeader } from "./parts";
import { CloneTab, NewTab } from "./sources";

const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
/** A home-relative path for display (`~/Development/app`), as the old app showed it. */
const shortPath = (path: string) => path.replace(/^(\/Users|\/home)\/[^/]+(?=\/|$)/, "~");

type Tab = "local" | "clone" | "new";
const TABS = [
  { value: "local", label: "Local" },
  { value: "clone", label: "Clone" },
  { value: "new", label: "New" },
] as const;

/**
 * The projects to start with, Local / Clone / New in our kit [D45, D616]. Local: the repositories the agents'
 * own history ran in, none ticked to begin with, and any folder added with Add folder…, which must be in a git
 * repository; a picked folder joins the cards ticked, as the old app had it. Clone: one of your GitHub repositories
 * or a URL. New: a name, git started in it. The footer's button adds them and finishes the setup; with none ticked
 * on Local it finishes without projects.
 */
export function ProjectsStep({ source, offline, onBack, start = "local" }: { source: Source; offline: boolean; onBack: () => void; start?: Tab }) {
  const [tab, setTab] = useState<Tab>(start);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [parent, setParent] = useState(DEFAULT_PARENT);
  const projects = useProjects() ?? [];
  const added = projects.map((project) => project.folder);
  // A clone or new repository keeps its id until onboarding ends, so one whose reply was lost (or whose finish
  // failed) isn't made twice: once its project is there, pressing again only finishes [D168].
  const [made, setMade] = useState<string | null>(null);
  // Still cloning counts too: Home shows it until it settles.
  const madeDone = made !== null && projects.some((project) => project.id === made);
  const [found, setFound] = useState<string[] | null>(null);
  // Folders picked with Add folder…, which the history count leaves out.
  const [byHand, setByHand] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"adding" | "picking" | null>(null);
  const online = !offline;

  useEffect(() => {
    if (!online || found) return;
    let live = true;
    source.history().then(
      (list) => live && setFound(list),
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
  // The header counts every card shown, already-added ones too, as the old app's did [ProjectsStep.tsx:55].
  const cards = [...added, ...addable];
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

  const folder = tab === "clone" ? folderFromUrl(url) : name.trim();
  const finish = async () => {
    setBusy("adding");
    setError(null);
    const failed: string[] = [];
    const add = (what: string, work: Promise<unknown>) => work.catch((cause) => failed.push(`${what}: ${errorText(cause)}`));
    const id = made ?? newProjectId();
    if (tab === "local") for (const path of chosen) await add(baseName(path), addProject(path));
    else if (madeDone) {
      // Made already: only the finish is left.
    } else if (tab === "clone") {
      const github = /^[\w.-]+\/[\w.-]+$/.test(url.trim());
      setMade(id);
      await add(folder, source.clone(id, github ? url.trim() : cloneUrl(url), `${parent}${folder}`, github));
    } else {
      const problem = folderProblem(folder);
      if (problem) failed.push(problem);
      else {
        setMade(id);
        await add(folder, source.add(id, `${parent}${folder}`, "new"));
      }
    }
    if (failed.length) setError(tab === "local" ? `Some projects could not be added.\n${failed.join("\n")}` : failed.join("\n"));
    // Not shown early: done leaves onboarding, and undoing that would restart it at the agents step.
    else {
      // It ends on Home, never on a screen kept from an earlier run or opened under it (⌘,); set first, so that never draws.
      window.location.hash = "";
      await setProfile(["--done"], {}).catch((cause) => setError(errorText(cause)));
    }
    setBusy(null);
  };

  const count = chosen.length;
  const where = { source, parent, busy: busy !== null, onParent: setParent, onError: setError };
  return (
    <div className="onboarding-step flex min-h-0 flex-1 flex-col">
      <StepHeader title="Choose your projects" description="Pick folders on this computer, clone a repository, or start a new one." />
      <div className="mt-10 shrink-0 px-6">
        <div className="mx-auto w-full max-w-onboarding">
          <Segmented fill label="Where the project comes from" value={tab} options={TABS} disabled={busy !== null} onChange={(next) => (setTab(next), setError(null))} />
        </div>
      </div>
      {tab === "local" ? (
      <div className="mt-6 flex min-h-0 flex-1 flex-col gap-3">
        <div className="shrink-0 px-6">
          <div className="mx-auto flex w-full max-w-onboarding flex-wrap items-center gap-x-1 gap-y-2">
            <div className="flex items-center gap-2 px-1 text-label text-setup-hint">
              {cards.length > 0 && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />}
              <span>Found in your history</span>
              {found && <span className="tabular-nums">{cards.length}</span>}
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
                No repositories found in your history. Add a folder, or clone or start one above.
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
      ) : (
        <div className="mt-6 min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <div className="mx-auto flex w-full max-w-onboarding flex-col gap-3">
            {tab === "clone" ? (
              <CloneTab url={url} onUrl={(next) => (setUrl(next), setError(null))} {...where} />
            ) : (
              <NewTab name={name} onName={(next) => (setName(next), setError(null))} {...where} />
            )}
            {!online && <p className="text-sm text-muted-foreground">Daemon not reachable · reconnecting…</p>}
            <ErrorLine error={error} />
          </div>
        </div>
      )}
      <StepFooter
        onBack={onBack}
        count={tab !== "local" ? undefined : addable.length > 0 ? `${count} of ${addable.length} selected` : added.length > 0 ? `${added.length} already added` : undefined}
        primary={{
          label:
            tab === "clone"
              ? busy === "adding" ? "Cloning…" : `Clone ${folder || "and continue"}`
              : tab === "new"
                ? busy === "adding" ? "Creating…" : `Create ${folder || "and continue"}`
                : busy === "adding" ? "Adding…" : count === 0 ? (added.length ? "Finish" : "Continue without projects") : `Add ${count} ${count === 1 ? "project" : "projects"}`,
          onClick: () => void finish(),
          disabled: !online || (tab !== "local" && !folder),
          busy: busy === "adding",
        }}
      />
    </div>
  );
}
