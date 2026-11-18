import { type KeyboardEvent, type ReactNode, useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { CheckboxMark } from "../components/checkbox";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { Desktop, Folder, FolderOpen, FolderPlus, MagnifyingGlassSearch, Spinner } from "../icons";
import { Avatar } from "../landing/pr-parts";
import { BOX, BOX_INPUT, cloneUrl, folderFromUrl, folderProblem } from "../projects/clone";
import { newProjectId, useProjects } from "../projects/projects";
import type { FolderCheck, GitHub, GitHubRepo, Source } from "../projects/store";
import { BrandMark } from "../settings/plugins-marks";
import { errorText } from "./api";

/*
 * Where a project comes from, for onboarding's Projects step and Add project both: one file [D676]. A column of sources
 * (This Mac, each signed-in GitHub account, New project) and the chosen one's list beside it. Picks are kept across
 * sources, each source counts its own, and the caller's one button adds them all [D636, D668, D672].
 */

export const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
/** A home-relative path for display (`~/Development/app`), as the old app showed it. */
export const shortPath = (path: string) => path.replace(/^(\/Users|\/home)\/[^/]+(?=\/|$)/, "~");

/** "mac", "new", or a GitHub account as `@login` (`@` alone: gh's own, missing or signed out). */
export type Where = string;
const SHORTHAND = /^[\w.-]+\/[\w.-]+$/;
const ROW = cx(
  "flex h-10.5 w-full shrink-0 cursor-pointer items-center gap-3 rounded-surface px-3 text-start text-sm outline-none focus-visible:focus-ring",
  "hover:bg-fill-subtle data-highlighted:bg-fill-hover disabled:cursor-not-allowed",
);

/**
 * The field keeps the keyboard over its list [D636]: ↓ highlights the first row then the next, ↑ the one before (above the
 * first, none), Space or Enter ticks the highlighted one, ⌘↵ presses the button. A click ticks without taking focus.
 */
function useRows(count: number, toggle: (at: number) => void, submit: () => void) {
  const [at, setAt] = useState(-1);
  const id = useId();
  const here = Math.min(at, count - 1);
  useEffect(() => {
    if (here >= 0) document.getElementById(`${id}-${here}`)?.scrollIntoView({ block: "nearest" });
  }, [id, here]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") setAt(Math.min(here + 1, count - 1));
    else if (event.key === "ArrowUp") setAt(Math.max(here - 1, -1));
    else if (here >= 0 && event.key === "Enter" && event.metaKey) submit();
    else if (here >= 0 && (event.key === " " || event.key === "Enter")) toggle(here);
    else return;
    event.preventDefault();
  };
  return {
    // Highlighted, Enter is the list's; else the button's.
    field: { onKeyDown, "data-own-enter": here >= 0 || undefined, "aria-activedescendant": here >= 0 ? `${id}-${here}` : undefined },
    row: (index: number) => ({
      id: `${id}-${index}`,
      "data-highlighted": index === here || undefined,
      onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault(),
      onClick: () => toggle(index),
    }),
    reset: () => setAt(-1),
  };
}

const Note = ({ children }: { children: ReactNode }) => <p className="px-3 py-2 text-sm text-muted-foreground">{children}</p>;
const List = ({ children }: { children: ReactNode }) => <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1 pb-1">{children}</div>;
const Count = ({ n }: { n: number }) => (n ? <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-fg">{n}</span> : null);

function Side({ on, icon, label, count, disabled, onClick }: { on: boolean; icon: ReactNode; label: string; count: number; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-current={on || undefined}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "flex h-9 w-full shrink-0 cursor-pointer items-center gap-2 rounded-surface px-2.5 text-start text-sm outline-none hover:bg-fill-subtle focus-visible:focus-ring",
        "disabled:cursor-not-allowed svg:size-icon-sm svg:shrink-0 svg-uncoloured:text-muted-foreground",
        on && "bg-fill-hover font-medium",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Count n={count} />
    </button>
  );
}

/** A repository, ticked, with its owner; cloning shows on it. */
function RepoRow({ repo, on, current, busy, props }: { repo: GitHubRepo; on: boolean; current: boolean; busy: boolean; props: object }) {
  const [owner, name] = repo.name.split("/");
  return (
    <button type="button" role="checkbox" aria-checked={on} disabled={busy} {...props} className={ROW}>
      <CheckboxMark checked={on} />
      <Avatar login={owner ?? null} />
      <span className="min-w-0 truncate">
        <span className="text-muted-foreground">{owner} / </span>
        <span className="font-medium">{name}</span>
      </span>
      {current && <Spinner className="ms-auto size-icon-sm shrink-0 animate-spin" />}
    </button>
  );
}

/**
 * The sources and their lists, and what the button does. Both lists come from what Rust read while the steps before were
 * open, so they're there on arrival [D627]. A folder picked (or the one ⌘O opened on) is checked: a project already added
 * goes to `onExisting`, a folder in no repository is ticked and gets git, a missing one opens New on it. `finish` adds the
 * ticked folders, clones the ticked repositories (each with the account it's listed under [D625, D634]) and, while New is
 * open, creates the new one; then hands their ids to `onDone`.
 */
export function useProjectSources({ source, offline, start = "mac", initialPath = "", onExisting, onDone }: {
  source: Source;
  offline: boolean;
  start?: Where;
  initialPath?: string;
  onExisting?: (id: string) => void;
  onDone: (ids: string[]) => Promise<unknown> | void;
}) {
  const [where, setWhere] = useState<Where>(start);
  const [repo, setRepo] = useState("");
  const [typedOn, setTypedOn] = useState<string | undefined>(undefined);
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
  // Each repository picked, with the account it was ticked under; another account's tick moves it [D680].
  const [picks, setPicks] = useState<Record<string, string>>({});
  const repos = Object.keys(picks);
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
      return (setWhere("new"), setParent(short.slice(0, cut)), setName(short.slice(cut)));
    }
    if (check.kind !== "plain" && check.project_id) return onExisting?.(check.project_id);
    const path = check.kind === "repo" ? check.repo : check.path;
    setWhere("mac");
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

  const listed = github && "repos" in github ? github.repos : [];
  // Each account once, in gh's order; a list read with no account in gh's file is gh's own, `@`.
  const accounts = github && "repos" in github && listed.length ? [...new Set(listed.map((each) => `@${each.account ?? ""}`))] : github ? ["@"] : [];
  // What's typed is cloned too when it's a URL, or an `owner/name` no list holds.
  const typed = repo.trim();
  const url = /[:@]/.test(typed);
  const extra = typed && (url || (SHORTHAND.test(typed) && !listed.some((each) => each.name.toLowerCase().includes(typed.toLowerCase())))) && !repos.includes(typed) ? [typed] : [];
  const targets = [...repos, ...extra];
  const folders = chosen.filter((path) => !added.includes(path));
  const fresh = where === "new" ? name.trim() : "";
  const total = folders.length + targets.length + (fresh ? 1 : 0);
  const single = total !== 1 ? null : fresh ? { kind: "new" as const, name: fresh } : folders[0] ? { kind: "folder" as const, name: baseName(folders[0]) } : { kind: "clone" as const, name: folderFromUrl(targets[0] ?? "") };
  // Through gh when it can (a private repository, the account that sees it); else git itself clones its URL.
  const byName = (from: string) => SHORTHAND.test(from) && !(github && "gh" in github);

  const finish = async () => {
    setBusy("adding");
    setError(null);
    let failed: string | null = null;
    const ids: string[] = [];
    const add = (id: string, work: Promise<unknown>) => work.then(() => ids.push(id), (cause) => (failed = errorText(cause)));
    for (const path of folders) {
      const id = newProjectId();
      await add(id, source.add(id, path, plain.includes(path) ? "here" : undefined));
    }
    // Each its own id, kept, so one already cloned isn't again when pressed after another failed [D168].
    for (const each of targets) {
      const from = each.replace(/\.git$/, "");
      const id = cloned[each] ?? newProjectId();
      if (projects.some((project) => project.id === id)) {
        ids.push(id);
        continue;
      }
      setCloned((all) => ({ ...all, [each]: id }));
      setCurrent(each);
      // The account it's listed under clones it; a typed one, the account whose list it was typed in [D625, D634].
      const account = picks[each] || (each === typed ? typedOn?.slice(1) || undefined : undefined);
      await add(id, source.clone(id, byName(from) ? from : cloneUrl(each), `${parent}${folderFromUrl(each)}`, byName(from), account));
    }
    setCurrent(null);
    if (!fresh) {
      // Not on New: nothing to make.
    } else if (madeDone) {
      // Made already: only the finish is left.
      ids.push(made);
    } else if ((failed = folderProblem(fresh)) === null) {
      const id = made ?? newProjectId();
      setMade(id);
      await add(id, source.add(id, `${parent}${fresh}`, "new"));
    }
    if (failed) setError(failed);
    else await Promise.resolve(onDone(ids)).catch((cause: unknown) => setError(errorText(cause)));
    setBusy(null);
  };

  const adding = busy === "adding";
  const disabled = !online || (where === "new" && !fresh);
  const submit = () => !disabled && busy === null && void finish();
  const flip = (list: string[], item: string) => (list.includes(item) ? list.filter((each) => each !== item) : [...list, item]);
  const hint = adding && current ? `Cloning ${current}…` : where === "new" ? `In ${parent}` : targets.length ? `Clones go into ${parent}` : undefined;
  const go = (next: Where) => (setWhere(next), setError(null));
  const body = (
    <div className="flex min-h-0 flex-1 gap-4">
      <nav aria-label="Where the project comes from" className="flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-e border-divider pe-3">
        <Side on={where === "mac"} icon={<Desktop />} label="This Mac" count={folders.length} disabled={busy !== null} onClick={() => go("mac")} />
        <span className="flex items-center gap-1.5 px-2.5 pt-3 pb-1 text-xs font-medium text-muted-foreground">
          <BrandMark brand="github" className="size-icon-xs" />
          GitHub
        </span>
        {accounts.map((each) => {
          const login = each.slice(1);
          const count = repos.filter((name) => picks[name] === login).length + (typedOn === each ? extra.length : 0);
          return <Side key={each} on={where === each} icon={login ? <Avatar login={login} size="size-4" /> : <BrandMark brand="github" />} label={login || "GitHub"} count={count} disabled={busy !== null} onClick={() => go(each)} />;
        })}
        <span className="my-2 h-px shrink-0 bg-divider" />
        <Side on={where === "new"} icon={<FolderPlus />} label="New project" count={0} disabled={busy !== null} onClick={() => go("new")} />
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        {where === "new" ? (
          <NewProject name={name} onName={(next) => (setName(next), setError(null))} parent={parent} onParent={() => void pickParent()} busy={adding} />
        ) : where === "mac" ? (
          <ThisMac
            query={query}
            onQuery={setQuery}
            paths={paths}
            plain={plain}
            chosen={chosen}
            onChoose={(path) => setChosen((all) => flip(all, path))}
            onPick={() => void pick()}
            onSubmit={submit}
            picking={busy === "picking"}
            busy={adding || !online}
          />
        ) : (
          <Account
            github={github}
            repos={listed.filter((each) => `@${each.account ?? ""}` === where)}
            repo={repo}
            picked={repos.filter((name) => `@${picks[name]}` === where)}
            current={current}
            busy={adding}
            typed={extra.length > 0}
            onRepo={(next) => (setRepo(next), setTypedOn(where), setError(null))}
            onToggle={(next) => (setPicks(({ [next]: was, ...rest }) => (`@${was}` === where ? rest : { ...rest, [next]: where.slice(1) })), setError(null))}
            onSubmit={submit}
          />
        )}
        {!online && <p className="text-sm text-muted-foreground">Daemon not reachable · reconnecting…</p>}
        <ErrorLine error={error} />
      </div>
    </div>
  );
  return { body, total, single, hint, adding, cloning: current !== null, disabled, finish };
}

/** One account's repositories, filtered by what's typed; any repository's URL works too [D625]. */
function Account({ github, repos, repo, typed, picked, current, busy, onRepo, onToggle, onSubmit }: {
  github: GitHub | null;
  typed: boolean;
  repos: readonly GitHubRepo[];
  repo: string;
  picked: readonly string[];
  current: string | null;
  busy: boolean;
  onRepo: (repo: string) => void;
  onToggle: (name: string) => void;
  onSubmit: () => void;
}) {
  const url = /[:@]/.test(repo);
  const words = url ? "" : repo.trim().toLowerCase();
  const shown = repos.filter((each) => each.name.toLowerCase().includes(words));
  const rows = useRows(shown.length, (at) => shown[at] && onToggle(shown[at].name), onSubmit);
  return (
    <>
      <div className={BOX}>
        <BrandMark brand="github" />
        {!url && <span className="-me-2.5 font-mono text-xs text-muted-foreground">github.com/</span>}
        <input
          value={repo}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
          aria-label="Repository"
          {...rows.field}
          // A pasted GitHub link is its owner/name, so it clones with the account that sees it.
          onChange={(event) => (rows.reset(), onRepo(event.target.value.replace(/^\s*(https?:\/\/)?github\.com\//, "")))}
          className={BOX_INPUT}
        />
      </div>
      <List>
        {github && "gh" in github ? (
          <Note>
            {github.gh === "missing" ? "Install the GitHub CLI (gh) to see your repositories here." : "Connect GitHub to see your repositories here."} Any
            repository's URL works too.
          </Note>
        ) : github && shown.length === 0 ? (
          <Note>{repos.length ? (typed ? "Not in your list; it'll be cloned from its address." : "No repository matches.") : "No repositories on GitHub yet."}</Note>
        ) : (
          shown.map((each, index) => <RepoRow key={each.name} repo={each} on={picked.includes(each.name)} current={current === each.name && picked.includes(each.name)} busy={busy} props={rows.row(index)} />)
        )}
      </List>
    </>
  );
}

/** Folders on this computer: the agents' history to search, or any folder through the picker. */
function ThisMac({ query, onQuery, paths, plain, chosen, onChoose, onPick, onSubmit, picking, busy }: {
  query: string;
  onQuery: (query: string) => void;
  paths: readonly string[] | null;
  plain: readonly string[];
  chosen: readonly string[];
  onChoose: (path: string) => void;
  onPick: () => void;
  onSubmit: () => void;
  picking: boolean;
  busy: boolean;
}) {
  const words = query.trim().toLowerCase();
  const shown = (paths ?? []).filter((path) => path.toLowerCase().includes(words));
  const rows = useRows(shown.length, (at) => shown[at] && onChoose(shown[at]), onSubmit);
  return (
    <>
      <div className={cx(BOX, "pe-1.5")}>
        <MagnifyingGlassSearch />
        <input value={query} autoFocus spellCheck={false} autoComplete="off" disabled={busy} placeholder="Search folders…" aria-label="Search folders" {...rows.field} onChange={(event) => (rows.reset(), onQuery(event.target.value))} className={cx(BOX_INPUT, "font-sans text-sm")} />
        <TooltipIconButton tooltip="Choose a folder…" disabled={busy || picking} onClick={onPick}>
          {picking ? <Spinner className="animate-spin" /> : <FolderOpen />}
        </TooltipIconButton>
      </div>
      <List>
        {paths?.length === 0 ? (
          <Note>No projects in your agents' history yet. Choose any folder with the folder button.</Note>
        ) : paths && shown.length === 0 ? (
          <Note>No folder matches.</Note>
        ) : (
          shown.map((path, index) => (
            <button key={path} type="button" role="checkbox" aria-checked={chosen.includes(path)} disabled={busy} {...rows.row(index)} className={ROW}>
              <CheckboxMark checked={chosen.includes(path)} />
              <Folder className="size-icon-sm shrink-0 text-muted-foreground" />
              <span className="min-w-0 shrink-0 truncate font-medium">{baseName(path)}</span>
              {plain.includes(path) && <span className="shrink-0 rounded-capsule bg-warning-wash px-2 py-0.5 text-xs text-warning">No git yet · we'll start it</span>}
              <span title={path} className="ms-auto min-w-0 truncate font-mono text-xs text-muted-foreground">
                {shortPath(path)}
              </span>
            </button>
          ))
        )}
      </List>
    </>
  );
}

/** A new folder: where it goes (its picker) and its name; git starts in it. */
function NewProject({ name, onName, parent, onParent, busy }: { name: string; onName: (name: string) => void; parent: string; onParent: () => void; busy: boolean }) {
  const field = useRef<HTMLInputElement>(null);
  // The name is there to be typed over.
  useEffect(() => field.current?.select(), []);
  return (
    <>
      <p className="text-sm text-muted-foreground">An empty folder with git in it.</p>
      <div className={cx(BOX, "ps-1.5")}>
        <button type="button" disabled={busy} onClick={onParent} title="Choose where it goes" className="flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-capsule px-2 font-mono text-xs text-muted-foreground outline-none hover:bg-fill-hover hover:text-foreground focus-visible:focus-ring">
          <Folder />
          {parent}
        </button>
        <span aria-hidden className="h-5 w-px shrink-0 bg-divider" />
        <input ref={field} value={name} autoFocus spellCheck={false} autoComplete="off" maxLength={200} disabled={busy} aria-label="Name" placeholder="my-project" onChange={(event) => onName(event.target.value)} className={BOX_INPUT} />
      </div>
    </>
  );
}
