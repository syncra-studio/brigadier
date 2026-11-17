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
 * what Rust read while the steps before were open, so they're there on arrival; one still coming fills in place. Clone
 * and Existing folder take several, ticked, kept through filtering [D636]. The footer's button clones, adds or creates
 * them and finishes the setup; with none picked it finishes without.
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
  const [cloned, setCloned] = useState<Record<string, string>>({});
  const madeDone = made !== null && projects.some((project) => project.id === made);
  const [history, setHistory] = useState<{ found: string[]; parent: string } | null>(null);
  const found = history?.found ?? null;
  const parent = picked ?? history?.parent ?? "~/Development/";
  const [github, setGitHub] = useState<GitHub | null>(null);
  // A folder picked with the folder button, which the history leaves out.
  const [byHand, setByHand] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
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
      if (picked) (setByHand(picked), setChosen((all) => (all.includes(picked) ? all : [...all, picked])), setQuery(""));
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
  const byName = (from: string) => SHORTHAND.test(from) && !(github && "gh" in github);
  // The ticked repositories, else the one typed.
  const targets = repos.length ? repos : repo.trim() ? [repo.trim()] : [];
  const picks = tab === "clone" ? targets : tab === "folder" ? chosen : [];
  const folder = tab === "clone" ? folderFromUrl(targets[0] ?? "") : tab === "new" ? name.trim() : chosen[0] && baseName(chosen[0]);
  const finish = async () => {
    setBusy("adding");
    setError(null);
    let failed: string | null = null;
    const add = (work: Promise<unknown>) => work.catch((cause) => (failed = errorText(cause)));
    const id = made ?? newProjectId();
    if (tab === "folder") {
      for (const path of chosen.filter((path) => !added.includes(path))) await add(addProject(path));
    } else if (tab === "clone") {
      // Each its own id, kept, so one already cloned isn't again when pressed after another failed [D168].
      for (const typed of targets) {
        const from = typed.replace(/\.git$/, "");
        const id = cloned[typed] ?? newProjectId();
        if (projects.some((project) => project.id === id)) continue;
        setCloned((all) => ({ ...all, [typed]: id }));
        setCurrent(typed);
        // The account that sees it clones it [D625, D634].
        const account = github && "repos" in github ? github.repos.find((each) => each.name === from)?.account : undefined;
        await add(source.clone(id, byName(from) ? from : cloneUrl(typed), `${parent}${folderFromUrl(typed)}`, byName(from), account));
      }
      setCurrent(null);
    } else if (madeDone) {
      // Made already: only the finish is left.
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
      ? adding ? "Cloning…" : picks.length > 1 ? `Clone ${picks.length} repos` : folder ? `Let's work on ${folder}` : "Let's go"
      : tab === "new"
        ? adding ? "Creating…" : `Let's work on ${folder || "it"}`
        : adding ? "Adding…" : picks.length > 1 ? `Add ${picks.length} projects` : folder ? `Let's work on ${folder}` : "Continue without a project";
  const hint = tab === "clone" ? (picks.length > 1 ? `Into ${parent}` : picks.length ? `Into ${parent}${folder}` : "Enter a GitHub repo to continue") : tab === "new" ? `In ${parent}` : undefined;
  const disabled = !online || (tab !== "folder" && !folder);
  const submit = () => !disabled && busy === null && void finish();
  const flip = (list: string[], item: string) => (list.includes(item) ? list.filter((each) => each !== item) : [...list, item]);
  return (
    <div className="onboarding-step flex min-h-0 flex-1 flex-col">
      <StepHeader title="What should we work on?" description="Clone a project, pick a folder on this computer, or start a new one." />
      <div className="mt-10 flex min-h-0 flex-1 flex-col px-6 pb-6">
        <div className="mx-auto flex min-h-0 w-full max-w-onboarding flex-1 flex-col gap-4">
          <Segmented fill className="h-10.5 *:h-full" label="Where the project comes from" value={tab} options={TABS} disabled={busy !== null} onChange={(next) => (setTab(next), setError(null))} />
          {tab === "clone" ? (
            <CloneTab repo={repo} github={github} picked={repos} current={current} busy={adding} onRepo={(next) => (setRepo(next), setError(null))} onToggle={(next) => (setRepos((all) => flip(all, next)), setError(null))} onSubmit={submit} />
          ) : tab === "folder" ? (
            <FolderTab query={query} onQuery={setQuery} paths={paths} chosen={chosen} onChoose={(path) => setChosen((all) => flip(all, path))} onPick={() => void pick()} onSubmit={submit} picking={busy === "picking"} busy={adding || !online} />
          ) : (
            <NewTab name={name} onName={(next) => (setName(next), setError(null))} parent={parent} onParent={() => void pickParent()} busy={adding} />
          )}
          {!online && <p className="text-sm text-muted-foreground">Daemon not reachable · reconnecting…</p>}
          <ErrorLine error={error} />
        </div>
      </div>
      <StepFooter onBack={onBack} count={hint} primary={{ label, onClick: () => void finish(), disabled, busy: adding }} />
    </div>
  );
}
