import { useEffect, useState } from "react";

import { ErrorLine } from "../components/error-line";
import { Segmented } from "../components/segmented";
import { cloneUrl, folderFromUrl, folderProblem } from "../projects/clone";
import { addProject, newProjectId, useProjects } from "../projects/projects";
import { type GitHub, type Source } from "../projects/store";
import { errorText, pickRepo, setProfile } from "./api";
import { StepFooter, StepHeader } from "./parts";
import { baseName, CloneTab, FolderTab, NewTab, shortPath } from "./sources";

type Tab = "clone" | "folder" | "new";
const TABS = [
  { value: "clone", label: "Clone" },
  { value: "folder", label: "Existing folder" },
  { value: "new", label: "New" },
] as const;
const SHORTHAND = /^[\w.-]+\/[\w.-]+$/;

/**
 * The project to start with, Clone / Existing folder / New in our kit [D45, D616, D627]. Both lists come from
 * what Rust read while the steps before were open, so they're there on arrival; one still coming fills in place. The
 * footer's button clones, adds or creates the one project and finishes the setup; with none picked it finishes without.
 */
export function ProjectsStep({ source, offline, onBack, start = "folder" }: { source: Source; offline: boolean; onBack: () => void; start?: Tab }) {
  const [tab, setTab] = useState<Tab>(start);
  const [repo, setRepo] = useState("");
  const [query, setQuery] = useState("");
  const [name, setName] = useState("my-project");
  // Where a clone or a new one goes: picked, else the folder most of your projects are in [D627].
  const [picked, setParent] = useState<string | null>(null);
  const projects = useProjects() ?? [];
  const added = projects.map((project) => project.folder);
  // A clone or new repository keeps its id until onboarding ends, so one whose reply was lost (or whose finish
  // failed) isn't made twice: once its project is there, pressing again only finishes [D168].
  const [made, setMade] = useState<string | null>(null);
  const madeDone = made !== null && projects.some((project) => project.id === made);
  const [history, setHistory] = useState<{ found: string[]; parent: string } | null>(null);
  const found = history?.found ?? null;
  const parent = picked ?? history?.parent ?? "~/Development/";
  const [github, setGitHub] = useState<GitHub | null>(null);
  // A folder picked with the folder button, which the history leaves out.
  const [byHand, setByHand] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"adding" | "picking" | null>(null);
  const online = !offline;

  useEffect(() => {
    if (!online) return;
    let live = true;
    const failed = (cause: unknown) => live && setError(errorText(cause));
    if (!history) source.history().then((read) => live && setHistory(read), (cause) => (failed(cause), live && setHistory({ found: [], parent: "~/Development/" })));
    if (!github) source.github().then((answer) => live && setGitHub(answer), failed);
    return () => {
      live = false;
    };
  }, [online, source]);

  const paths = found && [...(byHand && !found.includes(byHand) ? [byHand] : []), ...found].filter((path) => !added.includes(path));
  const pick = async () => {
    setError(null);
    setBusy("picking");
    try {
      const picked = await pickRepo();
      if (picked) (setByHand(picked), setChosen(picked), setQuery(""));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };
  const pickParent = () =>
    source.pick(parent).then(
      (picked) => picked && setParent(`${shortPath(picked).replace(/\/+$/, "")}/`),
      (cause: unknown) => setError(errorText(cause)),
    );

  // Through gh when it can (a private repository, the account that sees it); else git itself clones its URL.
  const byName = SHORTHAND.test(repo.trim()) && !(github && "gh" in github);
  const folder = tab === "clone" ? folderFromUrl(repo) : tab === "new" ? name.trim() : chosen && baseName(chosen);
  const finish = async () => {
    setBusy("adding");
    setError(null);
    let failed: string | null = null;
    const add = (work: Promise<unknown>) => work.catch((cause) => (failed = errorText(cause)));
    const id = made ?? newProjectId();
    if (tab === "folder") {
      if (chosen) await add(addProject(chosen));
    } else if (madeDone) {
      // Made already: only the finish is left.
    } else if (tab === "clone") {
      const from = repo.trim().replace(/\.git$/, "");
      // The account that sees it clones it [D625].
      const account = github && "repos" in github ? github.repos.find((each) => each.name === from)?.account : undefined;
      setMade(id);
      await add(source.clone(id, byName ? from : cloneUrl(repo), `${parent}${folder}`, byName, account));
    } else if ((failed = folderProblem(folder ?? "")) === null) {
      setMade(id);
      await add(source.add(id, `${parent}${folder}`, "new"));
    }
    if (failed) setError(failed);
    // Not shown early: done leaves onboarding, and undoing that would restart it at the agents step.
    else {
      // It ends on Home, never on a screen kept from an earlier run or opened under it (⌘,); set first, so that never draws.
      window.location.hash = "";
      await setProfile(["--done"], {}).catch((cause) => setError(errorText(cause)));
    }
    setBusy(null);
  };

  const adding = busy === "adding";
  const label =
    tab === "clone"
      ? adding ? "Cloning…" : "Let's go"
      : tab === "new"
        ? adding ? "Creating…" : `Let's work on ${folder || "it"}`
        : adding ? "Adding…" : folder ? `Let's work on ${folder}` : "Continue without a project";
  const hint = tab === "clone" ? (repo.trim() ? `Into ${parent}${folder}` : "Enter a GitHub repo to continue") : tab === "new" ? `In ${parent}` : undefined;
  return (
    <div className="onboarding-step flex min-h-0 flex-1 flex-col">
      <StepHeader title="What should we work on?" description="Clone a project, pick a folder on this computer, or start a new one." />
      <div className="mt-10 flex min-h-0 flex-1 flex-col px-6 pb-6">
        <div className="mx-auto flex min-h-0 w-full max-w-onboarding flex-1 flex-col gap-4">
          <Segmented fill label="Where the project comes from" value={tab} options={TABS} disabled={busy !== null} onChange={(next) => (setTab(next), setError(null))} />
          {tab === "clone" ? (
            <CloneTab repo={repo} github={github} busy={adding} onRepo={(next) => (setRepo(next), setError(null))} />
          ) : tab === "folder" ? (
            <FolderTab query={query} onQuery={setQuery} paths={paths} chosen={chosen} onChoose={(path) => setChosen(chosen === path ? null : path)} onPick={() => void pick()} picking={busy === "picking"} busy={adding || !online} />
          ) : (
            <NewTab name={name} onName={(next) => (setName(next), setError(null))} parent={parent} onParent={() => void pickParent()} busy={adding} />
          )}
          {!online && <p className="text-sm text-muted-foreground">Daemon not reachable · reconnecting…</p>}
          <ErrorLine error={error} />
        </div>
      </div>
      <StepFooter onBack={onBack} count={hint} primary={{ label, onClick: () => void finish(), disabled: !online || (tab !== "folder" && !folder), busy: adding }} />
    </div>
  );
}
