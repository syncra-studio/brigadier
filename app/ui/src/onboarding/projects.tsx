import { useEffect, useEffectEvent, useState } from "react";

import { ErrorLine } from "../components/error-line";
import { Segmented } from "../components/segmented";
import { cloneUrl, folderFromUrl, folderProblem } from "../projects/clone";
import { newProjectId, useProjects } from "../projects/projects";
import { type FolderCheck, type GitHub, type Source } from "../projects/store";
import { errorText, setProfile } from "./api";
import { StepFooter, StepHeader } from "./parts";
import { baseName, CloneTab, FolderTab, NewTab, shortPath } from "./sources";

export type Tab = "clone" | "folder" | "new";
const TABS = [
  { value: "clone", label: "Clone" },
  { value: "folder", label: "Existing folder" },
  { value: "new", label: "New" },
] as const;
const SHORTHAND = /^[\w.-]+\/[\w.-]+$/;

/**
 * The three tabs, Clone / Existing folder / New in our kit, and what their button does: onboarding's Projects
 * step and Add project both [D45, D616, D627, D668]. Both lists come from what Rust read while the steps before were
 * open, so they're there on arrival; one still coming fills in place. Clone and Existing folder take several, ticked,
 * kept through filtering [D636]. A folder picked (or the one ⌘O opened on) is checked: a project already added goes to
 * `onExisting`, a folder in no repository is ticked and gets git, a missing one opens New on it. `finish` clones, adds or
 * creates them, then hands their ids to `onDone`.
 */
export function useProjectSources({ source, offline, start = "folder", initialPath = "", onExisting, onDone }: {
  source: Source;
  offline: boolean;
  start?: Tab;
  initialPath?: string;
  onExisting?: (id: string) => void;
  onDone: (ids: string[]) => Promise<unknown> | void;
}) {
  const [tab, setTab] = useState<Tab>(start);
  const [repo, setRepo] = useState("");
  const [query, setQuery] = useState("");
  const [name, setName] = useState("my-project");
  // Where a clone or a new one goes: picked, else the folder most of your projects are in [D627].
  const [picked, setParent] = useState<string | null>(null);
  const projects = useProjects() ?? [];
  const added = projects.map((project) => project.folder);
  // A clone or new repository keeps its id until this ends, so one whose reply was lost (or whose finish
  // failed) isn't made twice: once its project is there, pressing again only finishes [D168].
  const [made, setMade] = useState<string | null>(null);
  const [cloned, setCloned] = useState<Record<string, string>>({});
  const madeDone = made !== null && projects.some((project) => project.id === made);
  const [history, setHistory] = useState<{ found: string[]; parent: string } | null>(null);
  const found = history?.found ?? null;
  const parent = picked ?? history?.parent ?? "~/Development/";
  const [github, setGitHub] = useState<GitHub | null>(null);
  // Folders picked with the folder button (or ⌘O's), which the history leaves out; the plain ones get git.
  const [byHand, setByHand] = useState<string[]>([]);
  const [plain, setPlain] = useState<string[]>([]);
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

  const paths = found && [...byHand.filter((path) => !found.includes(path)), ...found].filter((path) => !added.includes(path));
  const apply = (check: FolderCheck) => {
    if (check.kind === "invalid") return setError(check.reason);
    if (check.kind === "missing") {
      const short = shortPath(check.path).replace(/\/+$/, "");
      const cut = short.lastIndexOf("/") + 1;
      return (setTab("new"), setParent(short.slice(0, cut)), setName(short.slice(cut)));
    }
    if (check.kind !== "plain" && check.project_id) return onExisting?.(check.project_id);
    const path = check.kind === "repo" ? check.repo : check.path;
    setTab("folder");
    setByHand((all) => (all.includes(path) ? all : [path, ...all]));
    setChosen((all) => (all.includes(path) ? all : [...all, path]));
    if (check.kind === "plain") setPlain((all) => (all.includes(path) ? all : [...all, path]));
    setQuery("");
  };
  const take = useEffectEvent((path: string) => source.check(path).then(apply, (cause: unknown) => setError(errorText(cause))));
  useEffect(() => {
    if (initialPath && online) void take(initialPath);
  }, [initialPath, online]);
  const pick = async () => {
    setError(null);
    setBusy("picking");
    try {
      const path = await source.pick();
      if (path) apply(await source.check(path));
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
    const ids: string[] = [];
    const add = (id: string, work: Promise<unknown>) => work.then(() => ids.push(id), (cause) => (failed = errorText(cause)));
    if (tab === "folder") {
      for (const path of chosen.filter((path) => !added.includes(path))) {
        const id = newProjectId();
        await add(id, source.add(id, path, plain.includes(path) ? "here" : undefined));
      }
    } else if (tab === "clone") {
      // Each its own id, kept, so one already cloned isn't again when pressed after another failed [D168].
      for (const typed of targets) {
        const from = typed.replace(/\.git$/, "");
        const id = cloned[typed] ?? newProjectId();
        if (projects.some((project) => project.id === id)) {
          ids.push(id);
          continue;
        }
        setCloned((all) => ({ ...all, [typed]: id }));
        setCurrent(typed);
        // The account that sees it clones it [D625, D634].
        const account = github && "repos" in github ? github.repos.find((each) => each.name === from)?.account : undefined;
        await add(id, source.clone(id, byName(from) ? from : cloneUrl(typed), `${parent}${folderFromUrl(typed)}`, byName(from), account));
      }
      setCurrent(null);
    } else if (madeDone) {
      // Made already: only the finish is left.
      ids.push(made);
    } else if ((failed = folderProblem(folder ?? "")) === null) {
      const id = made ?? newProjectId();
      setMade(id);
      await add(id, source.add(id, `${parent}${folder}`, "new"));
    }
    if (failed) setError(failed);
    else await Promise.resolve(onDone(ids)).catch((cause: unknown) => setError(errorText(cause)));
    setBusy(null);
  };

  const adding = busy === "adding";
  const disabled = !online || (tab !== "folder" && !folder);
  const submit = () => !disabled && busy === null && void finish();
  const flip = (list: string[], item: string) => (list.includes(item) ? list.filter((each) => each !== item) : [...list, item]);
  const hint = tab === "clone" ? (picks.length > 1 ? `Into ${parent}` : picks.length ? `Into ${parent}${folder}` : "Enter a GitHub repo to continue") : tab === "new" ? `In ${parent}` : undefined;
  const gitless = chosen.filter((path) => plain.includes(path)).map(baseName);
  const body = (
    <>
      <Segmented fill className="h-10.5 *:h-full" label="Where the project comes from" value={tab} options={TABS} disabled={busy !== null} onChange={(next) => (setTab(next), setError(null))} />
      {tab === "clone" ? (
        <CloneTab repo={repo} github={github} picked={repos} current={current} busy={adding} onRepo={(next) => (setRepo(next), setError(null))} onToggle={(next) => (setRepos((all) => flip(all, next)), setError(null))} onSubmit={submit} />
      ) : tab === "folder" ? (
        <FolderTab query={query} onQuery={setQuery} paths={paths} chosen={chosen} onChoose={(path) => setChosen((all) => flip(all, path))} onPick={() => void pick()} onSubmit={submit} picking={busy === "picking"} busy={adding || !online} />
      ) : (
        <NewTab name={name} onName={(next) => (setName(next), setError(null))} parent={parent} onParent={() => void pickParent()} busy={adding} />
      )}
      {tab === "folder" && gitless.length > 0 && <p className="text-sm text-muted-foreground">{gitless.join(", ")}: not a git repository yet; adding starts git there.</p>}
      {!online && <p className="text-sm text-muted-foreground">Daemon not reachable · reconnecting…</p>}
      <ErrorLine error={error} />
    </>
  );
  return { body, tab, picks, folder, hint, adding, disabled, finish };
}

/** Onboarding's Projects step: the tabs, and a button that adds what's picked and finishes the setup; with none picked it finishes without. */
export function ProjectsStep({ source, offline, onBack, start = "folder" }: { source: Source; offline: boolean; onBack: () => void; start?: Tab }) {
  const { body, tab, picks, folder, hint, adding, disabled, finish } = useProjectSources({
    source,
    offline,
    start,
    // Not shown early: done leaves onboarding, and undoing that would restart it at the agents step.
    onDone: () => {
      // It ends on Home, never on a screen kept from an earlier run or opened under it (⌘,); set first, so that never draws.
      window.location.hash = "";
      return setProfile(["--done"], {});
    },
  });
  const label =
    tab === "clone"
      ? adding ? "Cloning…" : picks.length > 1 ? `Clone ${picks.length} repos` : folder ? `Let's work on ${folder}` : "Let's go"
      : tab === "new"
        ? adding ? "Creating…" : `Let's work on ${folder || "it"}`
        : adding ? "Adding…" : picks.length > 1 ? `Add ${picks.length} projects` : folder ? `Let's work on ${folder}` : "Continue without a project";
  return (
    <div className="onboarding-step flex min-h-0 flex-1 flex-col">
      <StepHeader title="What should we work on?" description="Clone a project, pick a folder on this computer, or start a new one." />
      <div className="mt-10 flex min-h-0 flex-1 flex-col px-6 pb-6">
        <div className="mx-auto flex min-h-0 w-full max-w-onboarding flex-1 flex-col gap-4">{body}</div>
      </div>
      <StepFooter onBack={onBack} count={hint} primary={{ label, onClick: () => void finish(), disabled, busy: adding }} />
    </div>
  );
}
